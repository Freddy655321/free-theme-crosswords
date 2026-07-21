import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCspCrossword11ForEndpoint,
  isCsp11Enabled,
  shouldUseCspDiagnosticOnly,
} from "@/app/lib/buildCspCrossword11";
import { requestCspConstraintTopUpAnswers11 } from "@/app/lib/crosswordCspConstraintTopUp11";
import { requestCspLengthTopUpAnswers11 } from "@/app/lib/crosswordCspTopUp11";
import { buildCspCandidateReservoir11, cspRequiredLengthsFromPatterns11 } from "@/app/lib/buildCspCandidateReservoir11";
import {
  buildHybridCspCandidateReservoir11,
  loadLocalSupportCandidates11,
} from "@/app/lib/buildHybridCspCandidateReservoir11";
import { CROSSWORD_PATTERNS_11 } from "@/app/lib/crosswordPatterns11";
import type {
  Cell,
  Crossword,
  DerivedEntry,
  Direction,
  Entry,
  Placement,
  RawAnswerBank,
  RawClueBank,
  WordCandidate,
} from "@/app/lib/crosswordTypes";
import {
  ASCII_A_TO_Z,
  inBounds,
  isBlock,
  makeSeededRng,
  normalizeAnswer,
  safeJson,
  shuffleInPlace,
} from "@/app/lib/crosswordUtils";

export const runtime = "nodejs";

type GenerateCrosswordOpenAIClient = OpenAI;
type GenerateCrosswordOpenAIOptions = ConstructorParameters<typeof OpenAI>[0];
type GenerateCrosswordSupabaseSmokeClient = {
  from(table: string): {
    select(columns: string): {
      limit(count: number): Promise<unknown>;
    };
  };
};
type GenerateCrosswordTestOverrides = {
  createOpenAIClient?: (opts: GenerateCrosswordOpenAIOptions) => GenerateCrosswordOpenAIClient;
  getSupabaseSmokeClient?: () => GenerateCrosswordSupabaseSmokeClient;
  timeBudgetMs?: number;
};

declare global {
  var __generateCrosswordTestOverrides: GenerateCrosswordTestOverrides | undefined;
}

function createGenerateCrosswordOpenAIClient(opts: GenerateCrosswordOpenAIOptions): GenerateCrosswordOpenAIClient {
  return globalThis.__generateCrosswordTestOverrides?.createOpenAIClient?.(opts) ?? new OpenAI(opts);
}

function getGenerateCrosswordSupabaseSmokeClient(): GenerateCrosswordSupabaseSmokeClient {
  return (
    globalThis.__generateCrosswordTestOverrides?.getSupabaseSmokeClient?.() ??
    (supabaseAdmin as unknown as GenerateCrosswordSupabaseSmokeClient)
  );
}

// -------------------- Utils --------------------

function configureOpenAITlsForLocalDev() {
  if (process.env.NODE_ENV === "production") return;
  if (process.env.OPENAI_ALLOW_INSECURE_TLS === "0") return;
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return;

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn(
    "[generate-crossword] Local OpenAI TLS verification disabled. Use NODE_EXTRA_CA_CERTS for a safer local setup."
  );
}

configureOpenAITlsForLocalDev();

function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const cause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  const causeCode =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";

  return causeCode ? `${error.name}: ${error.message} (${causeCode})` : `${error.name}: ${error.message}`;
}

function salvageAnswerStringsFromJson(text: string): string[] {
  const keyIndex = text.search(/"answers"\s*:/);
  if (keyIndex < 0) return [];

  const start = text.indexOf("[", keyIndex);
  if (start < 0) return [];

  const out: string[] = [];
  let i = start + 1;
  while (i < text.length) {
    const quote = text.indexOf('"', i);
    if (quote < 0) break;

    let j = quote + 1;
    let value = "";
    let escaped = false;
    while (j < text.length) {
      const ch = text[j];
      if (escaped) {
        value += ch;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        break;
      } else {
        value += ch;
      }
      j++;
    }

    if (j >= text.length) break;
    if (value && value !== "answers" && value !== "notes") out.push(value);
    i = j + 1;
  }

  return out;
}

function crosswordDensityFromGrid(grid: string[][]): number {
  const n = grid.length;
  let letters = 0;
  const total = n * n;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!isBlock(grid[r][c])) letters++;
    }
  }
  return total > 0 ? letters / total : 0;
}

function checkedCellStats(grid: string[][], minLen: number) {
  const n = grid.length;

  const runLenAcrossAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c)) return 0;
    if (isBlock(grid[r][c])) return 0;

    let start = c;
    while (start - 1 >= 0 && !isBlock(grid[r][start - 1])) start--;

    let end = c;
    while (end + 1 < n && !isBlock(grid[r][end + 1])) end++;

    return end - start + 1;
  };

  const runLenDownAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c)) return 0;
    if (isBlock(grid[r][c])) return 0;

    let start = r;
    while (start - 1 >= 0 && !isBlock(grid[start - 1][c])) start--;

    let end = r;
    while (end + 1 < n && !isBlock(grid[end + 1][c])) end++;

    return end - start + 1;
  };

  let total = 0;
  let checked = 0;

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (isBlock(grid[r][c])) continue;
      total++;

      const acrossLen = runLenAcrossAt(r, c);
      const downLen = runLenDownAt(r, c);
      if (acrossLen >= minLen && downLen >= minLen) checked++;
    }
  }

  return {
    total,
    checked,
    ratio: total > 0 ? checked / total : 0,
  };
}

function crossedEntryStats(grid: string[][], entries: Omit<Entry, "clue">[], minLen: number) {
  const n = grid.length;

  const runLenAcrossAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c) || isBlock(grid[r][c])) return 0;
    let start = c;
    while (start - 1 >= 0 && !isBlock(grid[r][start - 1])) start--;
    let end = c;
    while (end + 1 < n && !isBlock(grid[r][end + 1])) end++;
    return end - start + 1;
  };

  const runLenDownAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c) || isBlock(grid[r][c])) return 0;
    let start = r;
    while (start - 1 >= 0 && !isBlock(grid[start - 1][c])) start--;
    let end = r;
    while (end + 1 < n && !isBlock(grid[end + 1][c])) end++;
    return end - start + 1;
  };

  const crossed = entries.filter((entry) => {
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      if (runLenAcrossAt(r, c) >= minLen && runLenDownAt(r, c) >= minLen) return true;
    }
    return false;
  }).length;

  return {
    total: entries.length,
    crossed,
    ratio: entries.length > 0 ? crossed / entries.length : 0,
  };
}

function entryCrossingStats(
  grid: string[][],
  entries: Omit<Entry, "clue">[],
  minLen: number
) {
  const n = grid.length;

  const runLenAcrossAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c) || isBlock(grid[r][c])) return 0;
    let start = c;
    while (start - 1 >= 0 && !isBlock(grid[r][start - 1])) start--;
    let end = c;
    while (end + 1 < n && !isBlock(grid[r][end + 1])) end++;
    return end - start + 1;
  };

  const runLenDownAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c) || isBlock(grid[r][c])) return 0;
    let start = r;
    while (start - 1 >= 0 && !isBlock(grid[start - 1][c])) start--;
    let end = r;
    while (end + 1 < n && !isBlock(grid[end + 1][c])) end++;
    return end - start + 1;
  };

  const counts = entries.map((entry) => {
    let checkedCells = 0;
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      if (runLenAcrossAt(r, c) >= minLen && runLenDownAt(r, c) >= minLen) checkedCells++;
    }
    return {
      answer: entry.answer,
      checkedCells,
    };
  });

  return {
    minCheckedCells: counts.length > 0 ? Math.min(...counts.map((entry) => entry.checkedCells)) : 0,
    weakEntries: counts.filter((entry) => entry.checkedCells < minCrossingsPerEntryForPublish(n)),
    counts,
  };
}

function minCrossingsPerEntryForPublish(size: number): number {
  if (size <= 11) return 2;
  return 2;
}

function sanitizeUncheckedGrid(grid: string[][], minLen: number): string[][] {
  let blocked: Cell[][] = grid.map((row) => row.map((cell) => (cell === "#" ? "#" : cell)));
  blocked = pruneDanglingRuns(blocked, minLen);
  blocked = keepLargestConnectedComponent(blocked);
  blocked = keepLargestConnectedComponent(blocked);

  return blocked.map((row) =>
    row.map((cell) => {
      if (cell === "#") return "#";
      return typeof cell === "string" && cell.length === 1 ? cell.toUpperCase() : "#";
    })
  );
}

function blockShortRunsOnly(grid: string[][], minLen: number): string[][] {
  const n = grid.length;
  const out = grid.map((row) => row.slice());
  let changed = true;

  while (changed) {
    changed = false;
    const toBlock = new Set<string>();

    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        while (c < n && isBlock(out[r]?.[c] ?? "#")) c++;
        const start = c;
        while (c < n && !isBlock(out[r]?.[c] ?? "#")) c++;
        const len = c - start;
        if (len > 1 && len < minLen) {
          for (let cc = start; cc < c; cc++) toBlock.add(`${r},${cc}`);
        }
      }
    }

    for (let c = 0; c < n; c++) {
      let r = 0;
      while (r < n) {
        while (r < n && isBlock(out[r]?.[c] ?? "#")) r++;
        const start = r;
        while (r < n && !isBlock(out[r]?.[c] ?? "#")) r++;
        const len = r - start;
        if (len > 1 && len < minLen) {
          for (let rr = start; rr < r; rr++) toBlock.add(`${rr},${c}`);
        }
      }
    }

    for (const key of toBlock) {
      const [rRaw, cRaw] = key.split(",");
      const r = Number(rRaw);
      const c = Number(cRaw);
      if (out[r]?.[c] && out[r][c] !== "#") {
        out[r][c] = "#";
        changed = true;
      }
    }
  }

  return out;
}

function shortRunCellKeys(grid: string[][], minLen: number): Set<string> {
  const n = grid.length;
  const keys = new Set<string>();

  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      while (c < n && isBlock(grid[r]?.[c] ?? "#")) c++;
      const start = c;
      while (c < n && !isBlock(grid[r]?.[c] ?? "#")) c++;
      const len = c - start;
      if (len > 1 && len < minLen) {
        for (let cc = start; cc < c; cc++) keys.add(`${r},${cc}`);
      }
    }
  }

  for (let c = 0; c < n; c++) {
    let r = 0;
    while (r < n) {
      while (r < n && isBlock(grid[r]?.[c] ?? "#")) r++;
      const start = r;
      while (r < n && !isBlock(grid[r]?.[c] ?? "#")) r++;
      const len = r - start;
      if (len > 1 && len < minLen) {
        for (let rr = start; rr < r; rr++) keys.add(`${rr},${c}`);
      }
    }
  }

  return keys;
}

function minEntriesForSize(size: number): number {
  if (size <= 9) return 10;
  if (size <= 11) return 15;
  return 20; // 13x13
}

function minPublishEntriesForSize(size: number): number {
  if (size <= 9) return 10;
  if (size <= 11) return 15;
  return 18;
}

function desiredPublishEntriesForSize(size: number): number {
  if (size <= 9) return 12;
  if (size <= 11) return 16;
  return 22;
}

function minCrossedEntriesForPublish(size: number): number {
  return minPublishEntriesForSize(size);
}

function minThematicEntriesForPublish(size: number, entryCount: number): number {
  if (size <= 9) return 7;
  if (size <= 11) return Math.max(8, entryCount - maxGenericContextEntriesForPublish(size, entryCount));
  return 12;
}

function minCoreThematicEntriesForPublish(size: number, entryCount: number): number {
  if (size <= 9) return 6;
  if (size <= 11) {
    if (entryCount > 20) return Math.max(10, Math.ceil(entryCount * 0.4));
    return 8;
  }
  return 10;
}

function maxGenericContextEntriesForPublish(size: number, entryCount: number): number {
  if (size <= 9) return 4;
  if (size <= 11) {
    if (entryCount > 20) return Math.max(5, entryCount - minCoreThematicEntriesForPublish(size, entryCount));
    return Math.min(7, Math.max(2, Math.floor(entryCount / 2)));
  }
  return 8;
}

function minEntryLenForSize(size: number): number {
  if (size <= 11) return 3;
  return 4;
}

function hasShortLetterRuns(grid: string[][], minLen: number): boolean {
  const n = grid.length;

  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      while (c < n && isBlock(grid[r]?.[c] ?? "#")) c++;
      const start = c;
      while (c < n && !isBlock(grid[r]?.[c] ?? "#")) c++;
      const len = c - start;
      if (len > 1 && len < minLen) return true;
    }
  }

  for (let c = 0; c < n; c++) {
    let r = 0;
    while (r < n) {
      while (r < n && isBlock(grid[r]?.[c] ?? "#")) r++;
      const start = r;
      while (r < n && !isBlock(grid[r]?.[c] ?? "#")) r++;
      const len = r - start;
      if (len > 1 && len < minLen) return true;
    }
  }

  return false;
}

function shouldRejectBestPartialForStrict11(size: number): boolean {
  return size === 11;
}

function isGenericThematicClue(clue: string): boolean {
  const lower = clue.toLowerCase().trim();
  if (lower === "pista temática." || lower === "pista tematica.") return true;
  if (lower === "thematic entry." || lower === "thematic entry") return true;
  if (lower.startsWith("thematic entry related to")) return true;
  if (lower.startsWith("term related to")) return true;
  if (lower.startsWith("término relacionado con")) return true;
  if (lower.includes("related to the theme")) return true;
  if (lower.includes("relacionado con el tema")) return true;
  if (lower.startsWith("palabra relacionada con")) return true;
  if (/^regi[oó]n relacionada con\b/.test(lower)) return true;
  if (/^referencia (local )?asociada con\b/.test(lower)) return true;
  if (/^local reference associated with\b/.test(lower)) return true;
  if (/^concrete reference associated with\b/.test(lower)) return true;
  return false;
}

function isBadClue(clue: string): boolean {
  const c = clue.trim();
  if (c.length < 3) return true;
  if (isGenericThematicClue(c)) return true;
  if (clueLooksWeakGeneratedFallback(c, "es") || clueLooksWeakGeneratedFallback(c, "en")) return true;
  if (/common crossword fill/i.test(c) || /crossword fill/i.test(c) || /common word/i.test(c)) return true;
  if (/^common (male|female|given|first) name\b/i.test(c)) return true;
  if (/^nombre (masculino|femenino|comun|común)\b/i.test(c)) return true;
  if (/^pista temática/i.test(c)) return true;
  if (/^pista pendiente/i.test(c)) return true;
  return false;
}

function clueLooksTooGenericForThematic(clue: string, language: "es" | "en"): boolean {
  const c = clue
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  if (language === "es") {
    return (
      /^porcion de tierra rodeada de agua/.test(c) ||
      /^territorio rodeado de agua\.?$/.test(c) ||
      /^persona que orienta en un recorrido\.?$/.test(c) ||
      /^persona que orienta en excursiones\.?$/.test(c) ||
      /^representacion grafica de (un area|una zona)\.?$/.test(c) ||
      /^extension de terreno al aire libre\.?$/.test(c) ||
      /^conjunto de plantas de una region\.?$/.test(c) ||
      /^conjunto de plantas en un area\.?$/.test(c) ||
      /^conjunto de animales en un area\.?$/.test(c) ||
      /^recorrido turistico por un lugar\.?$/.test(c) ||
      /^precipitacion en forma de cristales blancos\.?$/.test(c) ||
      /^cuerpo de agua dulce\.?$/.test(c) ||
      /^cuerpo de agua dulce en la region\.?$/.test(c) ||
      /^cuerpo de agua grande y profundo\.?$/.test(c) ||
      /^cuerpo de agua dulce rodeado de tierra\.?$/.test(c) ||
      /^cuerpo de agua cercano a/.test(c) ||
      /^cuerpo de agua dulce en la montana\.?$/.test(c) ||
      /^lago pequeno cerca de/.test(c) ||
      /^terreno rodeado de agua\.?$/.test(c) ||
      /^limite entre tierra y mar\.?$/.test(c) ||
      /^limite entre mar y tierra\.?$/.test(c) ||
      /^limite entre tierra y agua\.?$/.test(c) ||
      /^orilla entre tierra y agua\.?$/.test(c) ||
      /^camino para (viajar|vehiculos)\.?$/.test(c) ||
      /^camino para el transito\.?$/.test(c) ||
      /^camino o via de transito\.?$/.test(c) ||
      /^camino o via para viajar\.?$/.test(c) ||
      /^camino para viajar o transportar\.?$/.test(c) ||
      /^tipo de hospedaje frecuente\.?$/.test(c) ||
      /^opcion economica de hospedaje\.?$/.test(c) ||
      /^desplazamiento de un lugar a otro\.?$/.test(c) ||
      /^excursion organizada a un lugar\.?$/.test(c) ||
      /^excursion guiada por un lugar\.?$/.test(c) ||
      /^embarcacion ligera y estrecha\.?$/.test(c) ||
      /^actividad de atrapar peces\.?$/.test(c) ||
      /^persona que atrapa peces\.?$/.test(c) ||
      /^persona que inicia un camino nuevo\.?$/.test(c) ||
      /^infusion tradicional argentina\.?$/.test(c) ||
      /^tecnica de coccion a la parrilla\.?$/.test(c) ||
      /^atraccion turistica con tobogan alpino\.?$/.test(c) ||
      /^atractivo principal en temporada invernal\.?$/.test(c) ||
      /^lugares populares en verano\.?$/.test(c) ||
      /^material solido de la corteza terrestre\.?$/.test(c) ||
      /^arbol con agujas y conos\.?$/.test(c) ||
      /^aves acuaticas de patas cortas\.?$/.test(c) ||
      /^ave comun en la zona\.?$/.test(c) ||
      /^anfibio que habita en la region\.?$/.test(c) ||
      /^perspectiva panoramica\.?$/.test(c) ||
      /^perspectiva visual de un paisaje\.?$/.test(c) ||
      /^satelite natural de la tierra\.?$/.test(c) ||
      /^termino que describe algo tranquilo\.?$/.test(c) ||
      /^punto de conexion o interseccion\.?$/.test(c) ||
      /^capa externa del cuerpo\.?$/.test(c) ||
      /^peces migratorios de agua dulce\.?$/.test(c) ||
      /^herramienta para excavar/.test(c) ||
      /^superficie de un lugar\.?$/.test(c) ||
      /^embarcacion para navegar en rios\.?$/.test(c) ||
      /^ciudad chilena cercana,? ruta turistica\.?$/.test(c) ||
      /^nombre de un lugar o persona\.?$/.test(c) ||
      /^nombre de una calle o lugar\.?$/.test(c) ||
      /^baja temperatura\.?$/.test(c) ||
      /^acumulacion de arena\.?$/.test(c) ||
      /^filamento delgado/.test(c)
    );
  }

  return (
    /^land surrounded by water/.test(c) ||
    /^person who guides a route\.?$/.test(c) ||
    /^graphic representation of (an area|a place)\.?$/.test(c) ||
    /^plant life of a region\.?$/.test(c) ||
    /^organized route for visitors\.?$/.test(c) ||
    /^body of fresh water in the region\.?$/.test(c) ||
    /^thin flexible thread/.test(c)
  );
}

function clueLooksWeakGeneratedFallback(clue: string, language: "es" | "en"): boolean {
  const c = clue
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  if (language === "es") {
    return (
      /^respuesta tematica especifica y verificable\b/.test(c) ||
      /^respuesta tematica especifica\b/.test(c) ||
      /^definicion breve\.?$/.test(c) ||
      /^nombre propio asociado con\b/.test(c) ||
      /^sitio natural relacionado con\b/.test(c) ||
      /^lugar asociado con\b/.test(c) ||
      /^referencia concreta asociada con\b/.test(c) ||
      /^referencia local documentada en fuentes sobre\b/.test(c) ||
      /^referencia asociada con\b/.test(c)
    );
  }

  return (
    /^specific,?\s+verifiable\s+themed?\s+answer\b/.test(c) ||
    /^specific verifiable thematic answer\b/.test(c) ||
    /^specific thematic answer\b/.test(c) ||
    /^thematic fact linked to\b/.test(c) ||
    /^element associated with\b/.test(c) ||
    /^a term related to\b/.test(c) ||
    /^[a-z0-9 ]+-related term\b/.test(c) ||
    /^named thematic item from\b/.test(c) ||
    /^supporting term for\b/.test(c) ||
    /^related to [a-z0-9 ]+\.?$/.test(c) ||
    /^brief definition\.?$/.test(c) ||
    /^proper name associated with\b/.test(c) ||
    /^natural site related to\b/.test(c) ||
    /^place associated with\b/.test(c) ||
    /^concrete reference associated with\b/.test(c) ||
    /^documented local reference in sources about\b/.test(c) ||
    /^reference associated with\b/.test(c)
  );
}

function clueMakesUnstableTemporalClaim(clue: string, language: "es" | "en"): boolean {
  const c = clue
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (language === "es") {
    return /\b(actual|actualmente|hoy|reciente|ultimo|ultima|ex(?:\s|-)?|antiguo|anterior|desde)\b/.test(c);
  }

  return /\b(current|currently|today|recent|latest|former|ex(?:\s|-)?|previous|since|as of|now)\b/.test(c);
}

function clueMislabelsPartialPersonAnswer(answer: string, clue: string, language: "es" | "en"): boolean {
  const a = normalizeAnswer(answer);
  if (a.length < 3 || a.length > 9) return false;

  const c = clue
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const role =
    language === "es"
      ? /\b(guitarrista|baterista|bajista|vocalista|cantante|fundador|integrante|miembro|actor|actriz|director|autor|escritor|productor|jugador|entrenador)\b/.test(c)
      : /\b(guitarist|drummer|bassist|vocalist|singer|frontman|founder|member|actor|actress|director|author|writer|producer|player|coach)\b/.test(c);
  if (!role) return false;

  const markedAsPartial =
    language === "es"
      ? /\b(nombre|apellido|seudonimo|alias|apodo|primer nombre|segundo nombre|nombre completo normalizado)\b/.test(c)
      : /\b(first name|given name|last name|surname|stage name|alias|nickname|forename|full normalized name)\b/.test(c);

  return !markedAsPartial;
}

function clueMislabelsKnownPartialTitle(theme: string, answer: string, clue: string): boolean {
  const t = normalizeAnswer(theme);
  const a = normalizeAnswer(answer);
  if (t !== "MEGADETH") return false;

  const partialTitleWords = new Set([
    "SOULS",
    "TORNADO",
    "SWEATING",
    "COUNTDOWN",
    "CRYPTIC",
    "KILLING",
    "POLARIS",
  ]);
  if (!partialTitleWords.has(a)) return false;

  const c = clue
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (!/\b(song|track|album|title|titulo|cancion)\b/.test(c)) return false;
  return !/\b(word|part|first|last|opening|final|palabra|parte|primera|ultima)\b/.test(c);
}

function noteLooksWeakThematicContext(note: string, language: "es" | "en"): boolean {
  const c = note
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  if (clueLooksWeakGeneratedFallback(note, language)) return true;
  return (
    /^respuesta candidata del banco tematico\b/.test(c) ||
    /^candidate themed answer from\b/.test(c) ||
    /^tema principal\b/.test(c) ||
    /^main theme\b/.test(c) ||
    /^contexto tematico para\b/.test(c) ||
    /^theme context for\b/.test(c)
  );
}

function clueLanguageLooksValid(clue: string, language: "es" | "en"): boolean {
  const c = clue.toLowerCase();
  if (language === "es") {
    return !/\b(the|of|for|from|near|known|popular|hiking|mountain|skiing|lake|river|word|entry|coastal|areas|explore|museum|showcasing|history|fishing|pastime|historical|figure|summer|snow|snow-covered|peaks|visitors|specific|region|company|based|high-tech|tech)\b/.test(c);
  }

  return !/\b(el|la|los|las|de|del|para|cerca|conocido|popular|cerro|lago|rio|río)\b/.test(c);
}

function publishQualityIssue(
  entries: Entry[],
  thematicSet: Set<string>,
  language: "es" | "en",
  minEntries: number,
  theme = ""
): string | null {
  if (entries.length < minEntries) return "too-few-entries";

  const answers = new Set(entries.map((entry) => entry.answer));
  for (const answer of answers) {
    if (answer.length > 3 && answer.endsWith("S") && answers.has(answer.slice(0, -1))) {
      return `duplicate-variant:${answer.slice(0, -1)}/${answer}`;
    }
  }

  for (const entry of entries) {
    if (!answerLanguageLooksValidForPuzzle(entry.answer, language)) return `wrong-language-answer:${entry.answer}`;
    if (isLikelyBadAnswer(entry.answer) && !ALWAYS_ALLOW_ANSWERS.has(entry.answer)) return `bad-answer:${entry.answer}`;
    if (MODEL_FRAGMENT_ANSWERS.has(entry.answer)) return `fragment:${entry.answer}`;
    if (BANNED_ANSWERS.has(entry.answer) && !CONTEXTUAL_GENERIC_ANSWERS.has(entry.answer)) return `fragment:${entry.answer}`;
    if (isPlaceholderClue(entry.clue, language) || isBadClue(entry.clue)) return `bad-clue:${entry.answer}`;
    if (clueMakesUnstableTemporalClaim(entry.clue, language)) return `temporal-clue:${entry.answer}`;
    if (clueMislabelsPartialPersonAnswer(entry.answer, entry.clue, language)) {
      return `partial-name-clue:${entry.answer}`;
    }
    if (clueMislabelsKnownPartialTitle(theme, entry.answer, entry.clue)) {
      return `partial-title-clue:${entry.answer}`;
    }
    const needsContextualClue =
      thematicSet.has(entry.answer) || CONTEXTUAL_SUPPORT_ANSWERS.has(entry.answer);
    if (needsContextualClue && clueLooksTooGenericForThematic(entry.clue, language)) {
      return `generic-thematic-clue:${entry.answer}`;
    }
    if (entry.answer !== "TOBOGAN" && /tobog[aá]n alpino/i.test(entry.clue)) return `bad-clue:${entry.answer}`;
    if (!clueLanguageLooksValid(entry.clue, language)) return `wrong-language-clue:${entry.answer}`;
    if (clueMentionsAnswer(entry.clue, entry.answer)) return `answer-in-clue:${entry.answer}`;
    if (!thematicSet.has(entry.answer) && LOW_VALUE_CONTEXTLESS_ANSWERS.has(entry.answer)) {
      return `unsupported-generic:${entry.answer}`;
    }
    if (
      LOW_VALUE_CONTEXTLESS_ANSWERS.has(entry.answer) &&
      (clueLooksTooGenericForThematic(entry.clue, language) ||
        clueLooksWeakGeneratedFallback(entry.clue, language))
    ) {
      return `unsupported-generic:${entry.answer}`;
    }
  }

  const weakGeneratedFallbackCount = entries.filter((entry) =>
    clueLooksWeakGeneratedFallback(entry.clue, language)
  ).length;
  if (weakGeneratedFallbackCount > 0) return `weak-generated-clue:${weakGeneratedFallbackCount}`;

  const thematicCount = entries.filter((entry) => thematicSet.has(entry.answer)).length;
  const nonThematicCount = entries.length - thematicCount;

  if (entries.length < minEntriesForSize(11) && nonThematicCount > 6) {
    return `too-many-nonthematic:${nonThematicCount}`;
  }

  const unsupportedGeneric = entries.find((entry) => {
    if (thematicSet.has(entry.answer)) return false;
    return BANNED_ANSWERS.has(entry.answer) && !CONTEXTUAL_GENERIC_ANSWERS.has(entry.answer);
  });
  if (unsupportedGeneric) return `unsupported-generic:${unsupportedGeneric.answer}`;

  return null;
}

function pruneMaskedDuplicateAnswers(entries: Entry[]): Entry[] {
  const answers = new Set(entries.map((entry) => entry.answer));
  return entries.filter((entry) => {
    const answer = entry.answer;
    if (answer.length > 3 && answer.endsWith("S") && answers.has(answer.slice(0, -1))) {
      return false;
    }
    return true;
  });
}

function pruneForbiddenPublishAnswersIfPossible(entries: Entry[], minEntries: number): Entry[] {
  const pruned = entries.filter((entry) => !isForbiddenPublishAnswer(entry.answer));
  return pruned.length >= minEntries ? pruned : entries;
}

function pruneMaskedDuplicateCandidates(candidates: WordCandidate[]): WordCandidate[] {
  const answers = new Set(candidates.map((candidate) => candidate.answer));
  return candidates.filter((candidate) => {
    const answer = candidate.answer;
    if (answer.length > 3 && answer.endsWith("S") && answers.has(answer.slice(0, -1))) {
      return false;
    }
    return true;
  });
}

function isForbiddenPublishAnswer(answer: string): boolean {
  const a = normalizeAnswer(answer);
  if (MODEL_FRAGMENT_ANSWERS.has(a)) return true;
  if (BANNED_ANSWERS.has(a) && !CONTEXTUAL_GENERIC_ANSWERS.has(a)) return true;
  if (LOW_VALUE_CONTEXTLESS_ANSWERS.has(a)) return true;
  if (isLikelyBadAnswer(a) && !ALWAYS_ALLOW_ANSWERS.has(a)) return true;
  return false;
}

function isKnownIncompleteTitleForTheme(theme: string, answer: string): boolean {
  const t = normalizeAnswer(theme);
  const a = normalizeAnswer(answer);
  if (t === "MEGADETH") {
    return (
      a === "HOLYWAR" ||
      a === "HOLY" ||
      a === "WARS" ||
      a === "SOFARSO" ||
      a === "SOFARSOOD" ||
      a === "SOFARSOGOOD" ||
      a === "PEACESELLER" ||
      a === "YOUTH" ||
      a === "SKULLS" ||
      a === "DROOGS" ||
      a === "DROOGIE"
    );
  }
  return false;
}

function answerLanguageLooksValidForPuzzle(answer: string, language: "es" | "en"): boolean {
  const a = normalizeAnswer(answer);
  if (!a) return false;
  if (language === "es" && SPANISH_WRONG_LANGUAGE_ANSWERS.has(a)) return false;
  if (language === "es" && /(?:RIVER|HUT|LAKE|TRAIL|LODGE|SKIRESORT|SNOWPARK)$/.test(a)) return false;
  return true;
}

function blockForbiddenAnswerRuns(grid: string[][], minLen: number): string[][] {
  let out = grid.map((row) => row.slice());
  const badEntries = deriveEntriesFromGrid(out, minLen).filter((entry) =>
    isForbiddenPublishAnswer(entry.answer)
  );

  if (badEntries.length === 0) return out;

  for (const entry of badEntries) {
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      if (inBounds(out.length, r, c)) out[r][c] = "#";
    }
  }

  out = pruneDanglingRuns(out, minLen);
  out = keepLargestConnectedComponent(out);
  return out;
}

function fallbackClueForPublishRepair(
  theme: string,
  answer: string,
  language: "es" | "en",
  thematic: boolean,
  note?: string
): string | null {
  const valid = (clue: string | null) =>
    clue &&
    !isPlaceholderClue(clue, language) &&
    !isBadClue(clue) &&
    !clueLooksTooGenericForThematic(clue, language) &&
    clueLanguageLooksValid(clue, language) &&
    !clueLooksWeakGeneratedFallback(clue, language) &&
    !clueMakesUnstableTemporalClaim(clue, language) &&
    !clueMislabelsPartialPersonAnswer(answer, clue, language) &&
    !clueMislabelsKnownPartialTitle(theme, answer, clue) &&
    !clueMentionsAnswer(clue, answer);

  const fromNote = note ? clueFromThemeNote(theme, note, language) : null;
  if (valid(fromNote)) return fromNote;

  const specific = thematic ? specificThematicFallbackClue(theme, answer, language) : null;
  if (valid(specific)) return specific;

  const a = normalizeAnswer(answer);
  const placeContextEs: Record<string, string> = {
    ALBERGUE: `Alojamiento economico para viajeros que visitan ${theme}`,
    AVENTURA: `Actividad al aire libre asociada con el turismo de ${theme}`,
    BOSQUE: `Ambiente natural frecuente en la zona de ${theme}`,
    CAMPING: `Forma de alojamiento al aire libre usada por visitantes de ${theme}`,
    CANOA: `Embarcacion usada en actividades acuaticas asociadas con ${theme}`,
    CASCADA: `Caida de agua que puede formar parte de excursiones en la zona de ${theme}`,
    CERRO: `Elevacion natural caracteristica del paisaje de ${theme}`,
    CAMINO: `Via usada para recorrer o visitar la zona de ${theme}`,
    COLONIA: `Poblado o sector asociado con la historia local de ${theme}`,
    COSTA: `Orilla de los cuerpos de agua de la region de ${theme}`,
    EXCURSION: `Salida organizada para recorrer atractivos de ${theme}`,
    FAUNA: `Animales propios o asociados al entorno natural de ${theme}`,
    FESTIVAL: `Evento cultural que puede atraer visitantes a ${theme}`,
    FLORA: `Vegetacion asociada al entorno natural de ${theme}`,
    FRIO: `Baja temperatura asociada al clima de ${theme}`,
    GUIA: `Persona que orienta recorridos turisticos en ${theme}`,
    AGUA: `Elemento natural presente en lagos, rios u otros paisajes de ${theme}`,
    HOSTERIA: `Tipo de alojamiento turistico frecuente en ${theme}`,
    HOSTEL: `Alojamiento economico para viajeros que visitan ${theme}`,
    HOTEL: `Alojamiento para visitantes de ${theme}`,
    ISLA: `Tierra rodeada de agua que puede visitarse en excursiones desde ${theme}`,
    KAYAK: `Embarcacion usada para actividades acuaticas en la zona de ${theme}`,
    LAGO: `Cuerpo de agua frecuente en la region de ${theme}`,
    LAGOS: `Cuerpos de agua frecuentes en la region de ${theme}`,
    MAPA: `Representacion grafica util para recorrer ${theme}`,
    MIRADOR: `Punto elevado para apreciar el paisaje de ${theme}`,
    MUSEO: `Lugar cultural visitable en ${theme}`,
    NATURALEZA: `Entorno natural asociado con el paisaje de ${theme}`,
    NIEVE: `Elemento invernal asociado al paisaje de ${theme}`,
    NORTE: `Referencia geografica usada para ubicar la zona de ${theme}`,
    PAISAJE: `Vista natural destacada en ${theme}`,
    PARQUE: `Area natural o protegida asociada con ${theme}`,
    PASEO: `Recorrido breve para visitantes de ${theme}`,
    PATOS: `Aves acuaticas observables en ambientes de agua de la zona de ${theme}`,
    PESCA: `Actividad recreativa practicada en aguas de la zona de ${theme}`,
    PESCADOR: `Persona asociada a la pesca recreativa en aguas de la zona de ${theme}`,
    SALMONES: `Peces asociados a la pesca en aguas de la zona de ${theme}`,
    PLAYA: `Orilla junto al agua usada para descanso o paseo en ${theme}`,
    PUERTO: `Punto de salida o llegada de embarcaciones en la zona de ${theme}`,
    RANCHO: `Vivienda rural que puede asociarse al paisaje de ${theme}`,
    RANCHOS: `Construcciones rurales que pueden asociarse al paisaje de ${theme}`,
    REFUGIO: `Lugar de descanso o resguardo en travesias cercanas a ${theme}`,
    RIO: `Corriente natural de agua asociada al entorno de ${theme}`,
    RUTA: `Camino usado para recorrer la zona de ${theme}`,
    RUTAS: `Caminos usados para recorrer la zona de ${theme}`,
    SENDERO: `Camino senalizado para caminatas en la zona de ${theme}`,
    SUR: `Referencia geografica usada para ubicar la zona de ${theme}`,
    TOUR: `Recorrido organizado para visitantes de ${theme}`,
    TURISMO: `Actividad clave para quienes visitan ${theme}`,
    VALLE: `Depresion entre montanas o zona baja asociable al paisaje de ${theme}`,
    VERANO: `Temporada posible para recorrer atractivos de ${theme}`,
    VIAJE: `Traslado o recorrido para conocer ${theme}`,
    VILLA: `Localidad o sector residencial asociado con la zona de ${theme}`,
    VISTA: `Panorama observable desde puntos destacados de ${theme}`,
  };
  const placeContextEn: Record<string, string> = {
    ADVENTURE: `Outdoor activity associated with travel around ${theme}`,
    CAMPING: `Outdoor lodging used by visitors to ${theme}`,
    CASCADE: `Waterfall that can be part of excursions around ${theme}`,
    COAST: `Edge of bodies of water in the ${theme} area`,
    FAUNA: `Animals associated with the natural setting of ${theme}`,
    FLORA: `Plant life associated with the natural setting of ${theme}`,
    FOREST: `Natural wooded setting associated with ${theme}`,
    GUIDE: `Person who leads visitors around ${theme}`,
    HOSTEL: `Budget lodging for travelers visiting ${theme}`,
    HOTEL: `Lodging for visitors to ${theme}`,
    HILL: `Natural elevation in the landscape of ${theme}`,
    ISLAND: `Land surrounded by water that can be visited near ${theme}`,
    KAYAK: `Small boat used for water activities near ${theme}`,
    LAKE: `Body of water associated with the ${theme} area`,
    LAKES: `Bodies of water associated with the ${theme} area`,
    LOOKOUT: `Elevated point for viewing the landscape of ${theme}`,
    MAP: `Graphic aid for exploring ${theme}`,
    MUSEUM: `Cultural place visitors may see in ${theme}`,
    PARK: `Natural or protected area associated with ${theme}`,
    PORT: `Point where boats depart or arrive near ${theme}`,
    RIVER: `Natural stream associated with the setting of ${theme}`,
    REFUGE: `Shelter used during trips around ${theme}`,
    ROUTE: `Road or path used to explore ${theme}`,
    SNOW: `Winter element associated with the landscape of ${theme}`,
    TOURISM: `Travel activity centered on visiting ${theme}`,
    TOUR: `Organized route for visitors to ${theme}`,
    TRAIL: `Marked walking path around ${theme}`,
    VIEW: `Scene seen from a notable point in ${theme}`,
  };
  const contextualCommon = thematic
    ? language === "es"
      ? placeContextEs[a]
      : placeContextEn[a]
    : null;
  if (valid(contextualCommon)) return contextualCommon;

  const commonEs: Record<string, string> = {
    ANDES: "Cordillera que recorre el oeste sudamericano",
    AIRE: "Elemento natural asociado con espacios abiertos",
    AVENTURA: "Tipo de actividad al aire libre con cierto riesgo",
    BIRRA: "Forma coloquial de llamar a una bebida de cebada",
    BOSQUE: "Area natural cubierta de arboles",
    CAMPING: "Actividad de dormir al aire libre",
    CASCADA: "Caida natural de agua",
    CERRO: "Elevacion natural del terreno",
    CAMINO: "Via usada para trasladarse o recorrer una zona",
    CERVEZA: "Bebida fermentada de cebada y lupulo",
    DIAS: "Jornadas que puede durar una visita o viaje",
    COSTA: "Orilla entre tierra y agua",
    EXCURSION: "Salida organizada para visitar un lugar",
    FAUNA: "Conjunto de animales de una region",
    FESTIVAL: "Evento cultural o turistico con actividades",
    FLORA: "Vegetacion propia de una region",
    GUIA: "Persona o recurso que orienta un recorrido",
    AGUA: "Elemento natural presente en lagos y rios",
    HOSTERIA: "Tipo de alojamiento turistico",
    HIDRO: "Prefijo asociado con el agua",
    ALBERGUE: "Alojamiento economico para viajeros",
    HOSTEL: "Alojamiento economico para viajeros",
    HOTEL: "Alojamiento para visitantes",
    ISLA: "Terreno rodeado de agua",
    KAYAK: "Embarcacion pequena usada con remo",
    LAGO: "Gran cuerpo natural de agua",
    LAGOS: "Cuerpos naturales de agua",
    MAPA: "Representacion grafica de una zona",
    MIRADOR: "Lugar elevado desde donde se aprecia una vista",
    MUSEO: "Lugar de exhibicion cultural",
    NATURALEZA: "Conjunto de elementos naturales de un lugar",
    NIEVE: "Precipitacion blanca propia del invierno",
    NORTE: "Punto cardinal opuesto al sur",
    PAISAJE: "Vista natural apreciada por su belleza",
    PARQUE: "Espacio natural o protegido para visitar",
    PASEO: "Recorrido breve realizado por placer",
    PESCA: "Actividad con cana, red o anzuelo",
    PLAYA: "Orilla junto al agua usada para descanso o paseo",
    PUERTO: "Lugar de salida y llegada de embarcaciones",
    RANCHOS: "Construcciones rurales tradicionales",
    REFUGIO: "Lugar de descanso o resguardo en una travesia",
    RIO: "Corriente natural de agua",
    RUTA: "Camino usado para recorrer una zona",
    RUTAS: "Caminos usados para recorrer una zona",
    SENDERO: "Camino senalizado para caminar",
    SUR: "Punto cardinal opuesto al norte",
    TOUR: "Recorrido organizado para visitantes",
    TURISMO: "Actividad de viajar para conocer lugares",
    VALLE: "Terreno bajo entre montanas o alturas",
    VERANO: "Estacion calida del ano",
    VIAJE: "Traslado o recorrido para conocer un lugar",
    VISTA: "Panorama observado desde un punto",
    ZONA: "Area o sector de un territorio",
  };
  const commonEn: Record<string, string> = {
    ADVENTURE: "Outdoor activity with some risk",
    AIR: "Natural element associated with open spaces",
    CAMPING: "Sleeping outdoors as a recreational activity",
    CASCADE: "Natural fall of water",
    COAST: "Edge between land and water",
    FAUNA: "Animals of a region",
    FLORA: "Plant life of a region",
    FOREST: "Area covered with trees",
    GUIDE: "Person or resource that leads a visit",
    HOSTEL: "Budget lodging for travelers",
    HOTEL: "Lodging for visitors",
    HYDRO: "Prefix associated with water",
    HILL: "Natural elevation of land",
    ISLAND: "Land surrounded by water",
    KAYAK: "Small boat moved with a paddle",
    LAKE: "Large natural body of water",
    LAKES: "Natural bodies of water",
    LOOKOUT: "Elevated place for taking in a view",
    MAP: "Graphic representation of an area",
    MUSEUM: "Place for cultural exhibits",
    PARK: "Natural or protected area to visit",
    PORT: "Place where boats depart or arrive",
    RIVER: "Natural stream of water",
    REFUGE: "Shelter used during a journey",
    ROUTE: "Road or path used to travel through an area",
    SNOW: "White winter precipitation",
    TOURISM: "Travel activity focused on visiting places",
    TOUR: "Organized route for visitors",
    TRAIL: "Marked path for walking",
    VIEW: "Scene seen from a point",
    AREA: "Part or sector of a place",
  };
  const common = language === "es" ? commonEs[a] : commonEn[a];
  if (valid(common)) return common;

  const musicTheme =
    /MEGADETH|METALLICA|BEATLES|BAND|MUSIC|ROCK|METAL|JAZZ|PUNK/.test(normalizeAnswer(theme));
  if (musicTheme) {
    const musicEn: Record<string, string> = {
      ALBUM: `Recorded release associated with ${theme}`,
      ARENA: `Large venue where ${theme} could perform`,
      AMP: `Amplifier used for loud ${theme} guitar tones`,
      AXE: `Slang term for an electric guitar`,
      BAND: `Performing group form used by ${theme}`,
      BASS: `Low-pitched instrument part in ${theme}'s music`,
      BEAT: `Rhythmic pulse under ${theme}'s music`,
      CABLE: `Stage gear used for amplified ${theme} performances`,
      CAB: `Speaker cabinet used with a guitar amp`,
      CHORD: `Group of notes used in heavy guitar music`,
      CYMBAL: `Metal percussion disk in a drum kit`,
      DRUMS: `Percussion instrument set used in ${theme}'s music`,
      FANS: `Audience following associated with ${theme}`,
      FAN: `Follower of ${theme}`,
      FRET: `Raised strip on a guitar neck`,
      GIG: `Live music job or concert date`,
      GAIN: `Amplifier control for heavier guitar distortion`,
      HOOK: `Memorable musical phrase in a song`,
      JAM: `Informal playing session by musicians`,
      KICK: `Bass drum sound in rock music`,
      LABEL: `Company or imprint that releases music`,
      LIVE: `Performed before an audience rather than in studio`,
      LOGO: `Visual mark used on band merchandise`,
      LYRIC: `Line or words from a song`,
      MELODY: `Tune carried by a song or vocal line`,
      MERCH: `Band merchandise sold around concerts`,
      METAL: `Heavy music genre associated with ${theme}`,
      MIC: `Microphone used for vocals onstage`,
      MOSH: `Concert-floor movement associated with metal shows`,
      LOUD: `High-volume sound associated with ${theme} concerts`,
      MUSIC: `Art form performed by ${theme}`,
      PEDAL: `Guitar effect control used onstage`,
      PICK: `Small plectrum used to play guitar`,
      PIT: `Moshing area at a metal concert`,
      POSTER: `Band image or tour art displayed by fans`,
      RECORD: `Recorded music release by or around ${theme}`,
      RIFF: `Repeated guitar phrase common in metal music`,
      RIG: `Musician's setup of instruments and gear`,
      ROCK: `Amplified music style tied to metal bands`,
      ROLL: `Word paired with rock in music culture`,
      ROADIE: `Crew member who helps a band on tour`,
      ROCKER: `Rock musician or fan`,
      SCREAM: `Aggressive vocal sound used in heavy music`,
      SET: `Group of songs played in a concert`,
      SHOW: `Live performance event for ${theme}`,
      SHRED: `Fast lead-guitar playing style`,
      SNARE: `Sharp-sounding drum in a kit`,
      SOLO: `Featured instrumental passage in a rock song`,
      SONG: `Individual piece performed by ${theme}`,
      STAGE: `Performance platform for a band`,
      STUDIO: `Place where music is recorded`,
      TEMPO: `Speed of a piece of music`,
      THRASH: `Fast heavy-metal style associated with Megadeth`,
      TICKET: `Concert admission item`,
      TRACK: `Individual song on an album`,
      TUNER: `Device used to tune a guitar or bass`,
      TOUR: `Series of concerts in different cities`,
      VERSE: `Section of a song between repeated choruses`,
      VOCALS: `Sung part of a band's music`,
    };
    const musicEs: Record<string, string> = {
      ALBUM: `Disco grabado asociado con ${theme}`,
      ARENA: `Recinto grande donde podria tocar ${theme}`,
      AMP: `Amplificador usado para guitarras fuertes`,
      AXE: `Jerga inglesa para guitarra electrica`,
      BAND: `Formato de grupo musical de ${theme}`,
      BASS: `Parte grave de la musica de ${theme}`,
      BEAT: `Pulso ritmico bajo la musica de ${theme}`,
      CABLE: `Elemento de escenario usado en shows amplificados`,
      CAB: `Caja de parlantes usada con amplificador`,
      CHORD: `Conjunto de notas usado en musica de guitarras`,
      CYMBAL: `Platillo metalico de una bateria`,
      DRUMS: `Bateria usada en la musica de ${theme}`,
      FANS: `Publico seguidor asociado con ${theme}`,
      FAN: `Seguidor de ${theme}`,
      FRET: `Traste del mastil de una guitarra`,
      GIG: `Fecha de concierto o show musical`,
      GAIN: `Control de amplificador para distorsion pesada`,
      HOOK: `Frase musical memorable de una cancion`,
      JAM: `Sesion informal de musicos tocando`,
      KICK: `Golpe grave del bombo en rock`,
      LABEL: `Compania o sello que publica musica`,
      LIVE: `Tocado frente al publico, no en estudio`,
      LOGO: `Marca visual usada en material de una banda`,
      LYRIC: `Linea o letra de una cancion`,
      MELODY: `Melodia llevada por una cancion`,
      MERCH: `Mercaderia vendida alrededor de recitales`,
      METAL: `Genero pesado asociado con ${theme}`,
      MIC: `Microfono usado para voces en vivo`,
      MOSH: `Movimiento del publico en recitales de metal`,
      LOUD: `Sonido de alto volumen asociado con conciertos de ${theme}`,
      MUSIC: `Arte sonoro interpretado por ${theme}`,
      PEDAL: `Control de efecto usado por guitarristas`,
      PICK: `Pua pequena usada para tocar guitarra`,
      PIT: `Zona de pogo en un recital de metal`,
      POSTER: `Afiche de una banda o gira musical`,
      RECORD: `Grabacion musical vinculada con ${theme}`,
      RIFF: `Frase repetida de guitarra comun en el metal`,
      RIG: `Equipo completo de instrumentos y amplis`,
      ROCK: `Estilo amplificado ligado a bandas de metal`,
      ROLL: `Palabra emparejada con rock en la cultura musical`,
      ROADIE: `Tecnico que ayuda a una banda en gira`,
      ROCKER: `Musico o fan del rock`,
      SCREAM: `Voz agresiva usada en musica pesada`,
      SET: `Grupo de canciones tocadas en un concierto`,
      SHOW: `Presentacion en vivo de ${theme}`,
      SHRED: `Estilo de guitarra solista muy veloz`,
      SNARE: `Tambor agudo de una bateria`,
      SOLO: `Pasaje instrumental destacado en una cancion`,
      SONG: `Pieza individual interpretada por ${theme}`,
      STAGE: `Plataforma donde toca una banda`,
      STUDIO: `Lugar donde se graba musica`,
      TEMPO: `Velocidad de una pieza musical`,
      THRASH: `Estilo veloz de heavy metal asociado con Megadeth`,
      TICKET: `Entrada para un concierto`,
      TRACK: `Cancion individual dentro de un album`,
      TUNER: `Dispositivo para afinar guitarra o bajo`,
      TOUR: `Serie de conciertos en distintas ciudades`,
      VERSE: `Seccion de una cancion entre estribillos`,
      VOCALS: `Parte cantada de la musica de una banda`,
    };
    const musicClue = language === "es" ? musicEs[a] : musicEn[a];
    if (valid(musicClue)) return musicClue;
  }

  if (language === "es") {
    if (a.startsWith("LAGO")) return valid(`Lago asociado con ${theme}`) ? `Lago asociado con ${theme}` : null;
    if (a.startsWith("CERRO")) return valid(`Cerro asociado con ${theme}`) ? `Cerro asociado con ${theme}` : null;
    if (a.startsWith("RIO")) return valid(`Rio asociado con ${theme}`) ? `Rio asociado con ${theme}` : null;
    if (a.startsWith("ISLA")) return valid(`Isla asociada con ${theme}`) ? `Isla asociada con ${theme}` : null;
    if (a.startsWith("PUERTO")) return valid(`Puerto asociado con ${theme}`) ? `Puerto asociado con ${theme}` : null;
    if (thematic) {
      const properName = `Referencia local documentada en fuentes sobre ${theme}`;
      return valid(properName) ? properName : null;
    }
    return null;
  }

  if (a.startsWith("LAKE")) return `Lake associated with ${theme}`;
  if (a.startsWith("MOUNT")) return `Mountain associated with ${theme}`;
  if (a.startsWith("RIVER")) return `River associated with ${theme}`;
  if (a.startsWith("ISLAND")) return `Island associated with ${theme}`;
  if (thematic) {
    const properName = `Documented local reference in sources about ${theme}`;
    return valid(properName) ? properName : null;
  }
  return null;
}

function repairPublishClues(
  entries: Entry[],
  opts: {
    theme: string;
    language: "es" | "en";
    thematicSet: Set<string>;
    notesByAnswer: Map<string, string>;
  }
): Entry[] {
  return entries.map((entry) => {
    const thematic = opts.thematicSet.has(entry.answer);
    const needsContextualClue = thematic || CONTEXTUAL_SUPPORT_ANSWERS.has(entry.answer);
    const contextualFallback = fallbackClueForPublishRepair(
      opts.theme,
      entry.answer,
      opts.language,
      needsContextualClue,
      opts.notesByAnswer.get(entry.answer)
    );
    const bad =
      isPlaceholderClue(entry.clue, opts.language) ||
      isBadClue(entry.clue) ||
      (needsContextualClue && clueLooksTooGenericForThematic(entry.clue, opts.language)) ||
      clueLooksWeakGeneratedFallback(entry.clue, opts.language) ||
      clueMakesUnstableTemporalClaim(entry.clue, opts.language) ||
      clueMislabelsPartialPersonAnswer(entry.answer, entry.clue, opts.language) ||
      clueMislabelsKnownPartialTitle(opts.theme, entry.answer, entry.clue) ||
      !clueLanguageLooksValid(entry.clue, opts.language) ||
      clueLooksOffTheme(opts.theme, entry.clue) ||
      clueMentionsAnswer(entry.clue, entry.answer) ||
      (entry.answer !== "TOBOGAN" && /tobog[aá]n alpino/i.test(entry.clue)) ||
      (entry.answer === "PLAYA" && /\bmar\b/i.test(entry.clue));

    if (!bad) return entry;

    return contextualFallback ? { ...entry, clue: contextualFallback } : entry;
  });
}

function clueMentionsAnswer(clue: string, answer: string): boolean {
  const lowerClue = clue.toLowerCase();
  const lowerAns = answer.toLowerCase();
  if (lowerAns.length <= 3) return false;
  return lowerClue.includes(lowerAns);
}

function clueLooksOffTheme(theme: string, clue: string): boolean {
  const t = normalizeAnswer(theme);
  const c = clue
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const themeLooksMusical =
    /beatles|rolling|stones|metallica|megadeth|abba|band|banda|music|musica|rock|jazz|punk/.test(
      t.toLowerCase()
    );

  if (!themeLooksMusical && /\b(megadeth|metallica|beatles|banda|grupo|rock|musica|musical|musico|cancion|album|mascota)\b/.test(c)) {
    return true;
  }

  return false;
}

function hasReasonableVowelRatio(answer: string): boolean {
  const a = normalizeAnswer(answer);
  if (!a) return false;

  // Only letters count for vowel ratio; digits are neutral.
  const lettersOnly = a.replace(/[^A-Z]/g, "");
  if (!lettersOnly) return false;

  const vowels = (lettersOnly.match(/[AEIOU]/g) || []).length;
  const ratio = vowels / lettersOnly.length;

  if (lettersOnly.length >= 8 && ratio < 0.15) return false;
  if (lettersOnly.length >= 6 && ratio < 0.1) return false;
  if (ratio > 0.8) return false;
  return true;
}

function hasNoWeirdRepeats(answer: string): boolean {
  const a = normalizeAnswer(answer);
  if (a.length <= 3) return true;
  if (/(.)\1\1/.test(a)) return false;
  if (/^(..)\1\1+/.test(a)) return false;
  if (!/^[A-Z0-9]{3,}$/.test(a)) return false;
  return true;
}

function isLikelyBadAnswer(answer: string): boolean {
  const a = normalizeAnswer(answer);
  if (!a) return true;
  if (!ASCII_A_TO_Z.test(a)) return true;
  if (a.length < 3) return true;
  if (MODEL_FRAGMENT_ANSWERS.has(a)) return true;
  if (LOW_VALUE_CONTEXTLESS_ANSWERS.has(a)) return true;
  if (/(?:DE|DEL|OF|THE)$/.test(a) && a.length >= 5) return true;
  if (/^(?:LAGO|RIO|ISLA|CERRO|MONTE|PUERTO|VILLA|COLONIA)[A-Z]{1,4}$/.test(a)) return true;
  if (!hasReasonableVowelRatio(a)) return true;
  if (!hasNoWeirdRepeats(a)) return true;
  if (a.length >= 8 && /(CENT|CENTR|DEPORT|RESORT|PARK|MAPU|HUA|SAM|PALAS)$/.test(a)) return true;
  if (a.length >= 8 && /^(NATURAL|CIVIC|CARDENAL|NOMBRE|PESCA|SKI).{2,}$/.test(a)) return true;
  if (/^LAGO(ARGENT|GUAT|HERMOSO|LIMPIO|LOMA|MORO|PALAS|SILVINA|SOL|SUR|TRANC|VIED)/.test(a)) return true;

  const bannedSubs = ["AAAA", "EEE", "III", "OOO", "UUU", "QW", "ZX", "JQ", "VQ"];
  for (const b of bannedSubs) {
    if (a.includes(b)) return true;
  }

  // Three-letter entries are valid crossword answers. Reject only consonant-only
  // tokens here; thematic validation handles abbreviations, fragments, and codes.
  if (a.length === 3 && /^[A-Z]{3}$/.test(a) && !/[AEIOUY]/.test(a)) return true;

  if (a.length <= 4) {
  const bannedShort = new Set([
    "SFO",
    "LAX",
    "SONO",
    "PALO",
    "MEND",
    "NAVEG",
    "SAC",
    "RIV",
    "OC",
    "SD",
    "LA",
      "SDEL",
      "SLO",
      "ARG",
  ]);

  if (bannedShort.has(a)) return true;
}
  return false;
}

const WINE_DOMAIN_ANSWERS = new Set([
  "BRUT",
  "CATA",
  "CAVA",
  "CEPA",
  "CEPAS",
  "MALBEC",
  "MERLOT",
  "NOIR",
  "PINOT",
  "RACIMO",
  "TANINO",
  "TANINOS",
  "TERROIR",
  "UVA",
  "UVAS",
  "VID",
  "VINO",
  "VINOS",
]);

const FOOD_DOMAIN_ANSWERS = new Set([
  "ASADO",
  "CENA",
  "COMIDA",
  "DULCE",
  "FRUTA",
  "MILANESA",
  "PASTEL",
  "PLATO",
  "QUESO",
  "TORTA",
]);

const BARILOCHE_OFF_THEME_ANSWERS = new Set([
  "BAGRE",
  "PUCON",
  "TROUT",
  "VUELO",
]);

function isDomainContextSupported(theme: string, note: string | undefined, domain: "wine" | "food"): boolean {
  const text = `${theme} ${note ?? ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (domain === "wine") {
    return /\b(vino|vinos|wine|winery|bodega|bodegas|uva|uvas|grape|grapes|viñedo|vinedo|vineyard|vitivinic|enolog|cepa|cepas|malbec|merlot|pinot|cabernet|noir)\b/.test(
      text
    );
  }

  return /\b(comida|food|cocina|cuisine|gastronom|restaurant|restaurante|plato|dish|receta|recipe|culinari|asado|curanto|chocolate|fondue)\b/.test(
    text
  );
}

function isUnsupportedDomainAnswerForTheme(theme: string, answer: string, note?: string): boolean {
  const a = normalizeAnswer(answer);
  if (!a) return true;
  const themeNorm = normalizeAnswer(theme);

  if (themeNorm === "BARILOCHE" && BARILOCHE_OFF_THEME_ANSWERS.has(a)) return true;

  if (WINE_DOMAIN_ANSWERS.has(a) && !isDomainContextSupported(theme, note, "wine")) return true;
  if (FOOD_DOMAIN_ANSWERS.has(a) && !isDomainContextSupported(theme, note, "food")) return true;

  return false;
}

function isPublishableAnswerForTheme(opts: {
  theme: string;
  answer: string;
  language: "es" | "en";
  size: number;
  note?: string;
  allowContextualGeneric?: boolean;
}): boolean {
  const { theme, answer, language, size, note, allowContextualGeneric = false } = opts;
  const a = normalizeAnswer(answer);
  if (!a) return false;
  if (a === normalizeAnswer(theme)) return false;
  if (isKnownIncompleteTitleForTheme(theme, a)) return false;
  if (!ASCII_A_TO_Z.test(a)) return false;
  if (!answerLanguageLooksValidForPuzzle(a, language)) return false;
  if (a.length < minEntryLenForSize(size) || a.length > size) return false;
  if (isLikelyBadAnswer(a) && !ALWAYS_ALLOW_ANSWERS.has(a)) return false;
  if (size <= 11 && isRiskyGeneratedGeographicCompound(theme, a)) return false;
  if (isUnsupportedDomainAnswerForTheme(theme, a, note)) return false;
  if (!allowContextualGeneric && LOW_VALUE_CONTEXTLESS_ANSWERS.has(a)) return false;

  return true;
}

// -------------------- Theme anchors / overrides --------------------

const ALWAYS_ALLOW_ANSWERS = new Set<string>([]); // theme-agnostic
const ENABLE_LEGACY_TOPIC_SUPPORT = false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getThemeAnchors(_theme: string): string[] {
  return [];
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getThemeClueOverrides(_theme: string): Record<string, { es: string; en: string }> {
  return {};
}

// -------------------- Derive entries from grid --------------------

function deriveEntriesFromGrid(grid: string[][], minLen = 3): DerivedEntry[] {
  const n = grid.length;
  const entries: DerivedEntry[] = [];
  let num = 1;

  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      const cell = grid[r]?.[c] ?? "#";
      const prev = grid[r]?.[c - 1] ?? "#";
      if (!isBlock(cell) && (c === 0 || isBlock(prev))) {
        let end = c;
        let ans = "";
        while (end < n && !isBlock(grid[r]?.[end] ?? "#")) {
          ans += grid[r]?.[end] ?? "#";
          end++;
        }
        const norm = normalizeAnswer(ans);
        if (norm.length >= minLen && ASCII_A_TO_Z.test(norm)) {
          entries.push({ number: num++, row: r, col: c, direction: "across", answer: norm });
        }
        c = end + 1;
        continue;
      }
      c++;
    }
  }

  for (let c = 0; c < n; c++) {
    let r = 0;
    while (r < n) {
      const cell = grid[r]?.[c] ?? "#";
      const prev = grid[r - 1]?.[c] ?? "#";
      if (!isBlock(cell) && (r === 0 || isBlock(prev))) {
        let end = r;
        let ans = "";
        while (end < n && !isBlock(grid[end]?.[c] ?? "#")) {
          ans += grid[end]?.[c] ?? "#";
          end++;
        }
        const norm = normalizeAnswer(ans);
        if (norm.length >= minLen && ASCII_A_TO_Z.test(norm)) {
          entries.push({ number: num++, row: r, col: c, direction: "down", answer: norm });
        }
        r = end + 1;
        continue;
      }
      r++;
    }
  }

  return entries;
}

function isAcceptable(grid: string[][], derived: Omit<Entry, "clue">[], themeSet?: Set<string>): boolean {
  const n = grid.length;
  if (n !== 9 && n !== 11 && n !== 13) return false;


  const minLen = minEntryLenForSize(n);

  const density = crosswordDensityFromGrid(grid);
  if (hasShortLetterRuns(grid, minLen)) return false;
  if (n === 11 && density < 0.4) return false;
  if (n !== 11 && density < 0.32) return false;

  const minEntries = n === 11 ? minPublishEntriesForSize(n) : minEntriesForSize(n);
  if (derived.length < minEntries) return false;

  const across = derived.filter((e) => e.direction === "across").length;
  const down = derived.length - across;
  if (across === 0 || down === 0) return false;
  if (n === 11 && (across < 6 || down < 6)) return false;

  const shortCount = derived.filter((e) => e.answer.length < minLen).length;
  if (shortCount > 0) return false;

  const genericAnyCount = derived.reduce(
    (acc, e) => acc + (isOverGenericThemeWord(e.answer) ? 1 : 0),
    0
  );
  if (n === 11 && genericAnyCount > 7) return false;

  const checkedStats = checkedCellStats(grid, minLen);
  const crossedStats = crossedEntryStats(grid, derived, minLen);
  const entryCrossings = entryCrossingStats(grid, derived, minLen);
  if (n === 11 && crossedStats.crossed < minEntries) return false;
  if (n === 11 && entryCrossings.weakEntries.length > 0) return false;
  if (n === 11 && checkedStats.ratio < 0.2) return false;

  // Theme density gate: avoid puzzles that are mostly generic fill.
  if (themeSet) {
    const minTheme = n === 11 ? minThematicEntriesForPublish(n, derived.length) : n >= 13 ? 12 : n >= 9 ? 7 : 5;
    const themedCount = derived.reduce((acc, e) => acc + (themeSet.has(e.answer) ? 1 : 0), 0);
    if (themedCount < minTheme) return false;

    const genericNonThemedCount = derived.reduce(
      (acc, e) => acc + (!themeSet.has(e.answer) && isOverGenericThemeWord(e.answer) ? 1 : 0),
      0
    );
    if (n === 11 && genericNonThemedCount > 4) return false;
    if (n !== 11 && genericNonThemedCount > 0) return false;
  }

  return true;
}

// -------------------- Freeform (Option B) constructor --------------------

function makeEmptyWorkingGrid(n: number): Cell[][] {
  return Array.from({ length: n }, () => Array.from({ length: n }, () => "" as Cell));
}

function getCell(grid: Cell[][], r: number, c: number): Cell {
  return grid[r]?.[c] ?? "#";
}

function setCell(grid: Cell[][], r: number, c: number, v: Cell) {
  grid[r][c] = v;
}

/**
 * IMPORTANT:
 * Prevents "touching" words (adjacent letters without a crossing) which creates merged gibberish
 * entries after paintBlocks(). This is the main fix for the "FANBA / ACKET / GIFANATICI" issue.
 */
function canPlaceWord(
  grid: Cell[][],
  word: string,
  row: number,
  col: number,
  dir: Direction
): {
  ok: boolean;
  crossings: number;
  reason?:
    | "out_of_bounds"
    | "blocked_cell"
    | "letter_conflict"
    | "side_touch_up"
    | "side_touch_down"
    | "side_touch_left"
    | "side_touch_right"
    | "before_cell_occupied"
    | "after_cell_occupied";
} {
  const n = grid.length;
  let crossings = 0;

  for (let i = 0; i < word.length; i++) {
    const r = dir === "across" ? row : row + i;
    const c = dir === "across" ? col + i : col;

    if (!inBounds(n, r, c)) {
      return { ok: false, crossings: 0, reason: "out_of_bounds" };
    }

    const cur = getCell(grid, r, c);
    const ch = word[i];

    if (cur === "#") {
      return { ok: false, crossings: 0, reason: "blocked_cell" };
    }

    if (cur !== "" && cur !== ch) {
      return { ok: false, crossings: 0, reason: "letter_conflict" };
    }

    if (cur === ch) {
      crossings++;
      continue;
    }

    if (dir === "across") {
      const up = inBounds(n, r - 1, c) ? getCell(grid, r - 1, c) : "#";
      const down = inBounds(n, r + 1, c) ? getCell(grid, r + 1, c) : "#";

      if (up !== "" && up !== "#") {
        return { ok: false, crossings: 0, reason: "side_touch_up" };
      }

      if (down !== "" && down !== "#") {
        return { ok: false, crossings: 0, reason: "side_touch_down" };
      }
    } else {
      const left = inBounds(n, r, c - 1) ? getCell(grid, r, c - 1) : "#";
      const right = inBounds(n, r, c + 1) ? getCell(grid, r, c + 1) : "#";

      if (left !== "" && left !== "#") {
        return { ok: false, crossings: 0, reason: "side_touch_left" };
      }

      if (right !== "" && right !== "#") {
        return { ok: false, crossings: 0, reason: "side_touch_right" };
      }
    }
  }

  const beforeR = dir === "across" ? row : row - 1;
  const beforeC = dir === "across" ? col - 1 : col;
  const afterR = dir === "across" ? row : row + word.length;
  const afterC = dir === "across" ? col + word.length : col;

  if (inBounds(n, beforeR, beforeC)) {
    const b = getCell(grid, beforeR, beforeC);
    if (b !== "" && b !== "#") {
      return { ok: false, crossings: 0, reason: "before_cell_occupied" };
    }
  }

  if (inBounds(n, afterR, afterC)) {
    const a = getCell(grid, afterR, afterC);
    if (a !== "" && a !== "#") {
      return { ok: false, crossings: 0, reason: "after_cell_occupied" };
    }
  }

  return { ok: true, crossings };
}

function placeWord(
  grid: Cell[][],
  word: string,
  row: number,
  col: number,
  dir: Direction
): Array<{ r: number; c: number; prev: Cell }> | null {
  const n = grid.length;
  const changes: Array<{ r: number; c: number; prev: Cell }> = [];

  // Ensure placement is legal (including anti-touch) before committing.
  const pre = canPlaceWord(grid, word, row, col, dir);
  if (!pre.ok) return null;

  for (let i = 0; i < word.length; i++) {
    const r = dir === "across" ? row : row + i;
    const c = dir === "across" ? col + i : col;
    if (!inBounds(n, r, c)) return null;

    const prev = getCell(grid, r, c);
    if (prev === "#") return null;

    const ch = word[i];
    if (prev !== "" && prev !== ch) return null;

    if (prev !== ch) {
      changes.push({ r, c, prev });
      setCell(grid, r, c, ch);
    }
  }

  const painted = gridToStrings(paintBlocks(grid) as (string | null)[][]);
  if (hasShortLetterRuns(painted, minEntryLenForSize(n))) {
    for (let i = changes.length - 1; i >= 0; i--) {
      const change = changes[i];
      setCell(grid, change.r, change.c, change.prev);
    }
    return null;
  }

  if (deriveEntriesFromGrid(painted, minEntryLenForSize(n)).some((entry) => isForbiddenPublishAnswer(entry.answer))) {
    for (let i = changes.length - 1; i >= 0; i--) {
      const change = changes[i];
      setCell(grid, change.r, change.c, change.prev);
    }
    return null;
  }

  return changes;
}

function paintBlocks(grid: Cell[][]): Cell[][] {
  const n = grid.length;
  const out: Cell[][] = [];
  for (let r = 0; r < n; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < n; c++) {
      row.push(grid[r][c] === "" ? "#" : grid[r][c]);
    }
    out.push(row);
  }
  return out;
}

/**
 * IMPORTANT:
 * The previous version aggressively deleted any short runs in either direction.
 * That can wipe the whole grid when you only have a long ACROSS seed but no DOWN
 * words yet (each letter is a 1-letter DOWN run).
 *
 * New behavior:
 * - Only turn a cell into "#" if it belongs to short runs in BOTH directions.
 *   (i.e., it is not part of a valid-length entry in either axis)
 */
function enforceMinWordLen(blocked: Cell[][], minLen: number): Cell[][] {
  const n = blocked.length;
  const grid = blocked.map((row) => row.slice());

  const runLenAcrossAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c)) return 0;
    if (grid[r][c] === "#") return 0;

    let cc = c;
    while (cc - 1 >= 0 && grid[r][cc - 1] !== "#") cc--;
    const start = cc;

    while (cc + 1 < n && grid[r][cc + 1] !== "#") cc++;
    const end = cc;

    return end - start + 1;
  };

  const runLenDownAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c)) return 0;
    if (grid[r][c] === "#") return 0;

    let rr = r;
    while (rr - 1 >= 0 && grid[rr - 1][c] !== "#") rr--;
    const start = rr;

    while (rr + 1 < n && grid[rr + 1][c] !== "#") rr++;
    const end = rr;

    return end - start + 1;
  };

  const toKill: Array<{ r: number; c: number }> = [];

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r][c] === "#") continue;

      const la = runLenAcrossAt(r, c);
      const ld = runLenDownAt(r, c);

      // Kill only if the cell is not part of any "valid-length" run
      if (la < minLen && ld < minLen) toKill.push({ r, c });
    }
  }

  for (const cell of toKill) grid[cell.r][cell.c] = "#";
  return grid;
}

function pruneDanglingRuns(blocked: Cell[][], minLen: number): Cell[][] {
  const n = blocked.length;
  const grid = blocked.map((row) => row.slice());

  const runLenAcrossAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c)) return 0;
    if (grid[r][c] === "#") return 0;

    let start = c;
    while (start - 1 >= 0 && grid[r][start - 1] !== "#") start--;

    let end = c;
    while (end + 1 < n && grid[r][end + 1] !== "#") end++;

    return end - start + 1;
  };

  const runLenDownAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c)) return 0;
    if (grid[r][c] === "#") return 0;

    let start = r;
    while (start - 1 >= 0 && grid[start - 1][c] !== "#") start--;

    let end = r;
    while (end + 1 < n && grid[end + 1][c] !== "#") end++;

    return end - start + 1;
  };

  let changed = true;

  while (changed) {
    changed = false;
    const toKill: Array<{ r: number; c: number }> = [];

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (grid[r][c] === "#") continue;

        const la = runLenAcrossAt(r, c);
        const ld = runLenDownAt(r, c);

        if ((la > 1 && la < minLen) || (ld > 1 && ld < minLen)) {
          toKill.push({ r, c });
        }
      }
    }

    if (toKill.length > 0) {
      changed = true;
      for (const cell of toKill) grid[cell.r][cell.c] = "#";
    }
  }

  return grid;
}

function keepLargestConnectedComponent(blocked: Cell[][]): Cell[][] {
  const n = blocked.length;
  const seen = Array.from({ length: n }, () => Array.from({ length: n }, () => false));
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  const components: Array<Array<{ r: number; c: number }>> = [];

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (seen[r][c]) continue;
      if (blocked[r][c] === "#") continue;

      const comp: Array<{ r: number; c: number }> = [];
      const stack = [{ r, c }];
      seen[r][c] = true;

      while (stack.length) {
        const cur = stack.pop()!;
        comp.push(cur);
        for (const [dr, dc] of dirs) {
          const rr = cur.r + dr;
          const cc = cur.c + dc;
          if (!inBounds(n, rr, cc)) continue;
          if (seen[rr][cc]) continue;
          if (blocked[rr][cc] === "#") continue;
          seen[rr][cc] = true;
          stack.push({ r: rr, c: cc });
        }
      }

      components.push(comp);
    }
  }

  if (components.length <= 1) return blocked;

  components.sort((a, b) => b.length - a.length);
  const keep = new Set(components[0].map((p) => `${p.r},${p.c}`));

  const out = blocked.map((row) => row.slice());
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (out[r][c] === "#") continue;
      if (!keep.has(`${r},${c}`)) out[r][c] = "#";
    }
  }
  return out;
}

// -------------------- Filler pool (local, deterministic) --------------------
// These are common crossword-friendly fills (3–5 letters). They are NOT theme-linked.
// Keep them ASCII A–Z only. No plurals explosion; moderate list is enough.

const FILLER_WORDS: string[] = [
  // 3 letters
  "ACE","ACT","ADO","AGE","AID","AIM","AIR","ALE","ALL","ALP","AMI","AMP","AND","ANT","ANY","APE","APT","ARC","ARE","ARK","ARM","ART","ASH","ASK","ATE","AUK","AWE","AWL","AXE",
  "BAD","BAG","BAN","BAR","BAT","BAY","BEE","BEG","BET","BID","BIG","BIN","BIS","BIT","BOW","BOX","BOY","BRA","BUN","BUS","BUT","BUY",
  "CAB","CAN","CAP","CAR","CAT","COT","COW","COY","CRY","CUE","CUP","CUT",
  "DAY","DEE","DEN","DID","DIG","DIM","DIN","DIP","DOG","DON","DOT","DRY","DUE",
  "EAR","EAT","EEL","EGG","ELM","EMU","END","ERA","ERR","EVE","EWE","EYE",
  "FAD","FAN","FAR","FAT","FAX","FED","FEE","FEW","FIG","FIN","FIT","FIX","FLU","FOE","FOR","FUN",
  "GAS","GEL","GEM","GET","GIG","GIN","GOD","GUM","GUN","GUT","GUY",
  "HAD","HAS","HAT","HAY","HEM","HER","HID","HIM","HIP","HIT","HOG","HOP","HOT","HUB","HUE","HUG","HUT",
  "ICE","ILL","IMP","INK","INN","ION","ITS",
  "JAB","JAM","JAR","JET","JIG","JOB","JOG","JOT","JOY","JUT",
  "KEY","KID","KIN","KIT",
  "LAP","LAW","LAX","LAY","LED","LEG","LET","LID","LIE","LIP","LIT","LOG","LOT","LOW",
  "MAD","MAN","MAP","MAT","MAY","MEN","MET","MID","MIX","MOB","MOM","MOO","MOP","MUD",
  "NAG","NAP","NAY","NET","NEW","NOD","NOR","NOT","NOW","NUN",
  "OAK","OAR","ODD","ODE","OFF","OIL","OLD","ONE","OPT","ORB","ORE","OUR","OUT","OWE","OWN",
  "PAD","PAL","PAN","PAR","PAW","PAY","PEA","PEG","PEN","PER","PET","PIE","PIG","PIN","PIT","PLY","POD","POP","POT","PRO","PRY",
  "RAG","RAM","RAN","RAP","RAT","RAW","RAY","RED","REP","RIB","RID","RIG","RIM","RIP","ROB","ROD","ROE","ROT","RUE","RUG","RUN",
  "SAD","SAG","SAP","SAT","SAW","SAY","SEA","SEE","SET","SEW","SHE","SHY","SIN","SIP","SIR","SIT","SIX","SKY","SOD","SON","SOP","SOT","SOY","SUN",
  "TAP","TAR","TEA","TEN","THE","TIC","TIE","TIN","TIP","TOE","TON","TOO","TOP","TOY","TRY","TUB","TUG","TWO",
  "URN","USE",
  "VAN","VAT","VET",
  "WAR","WAS","WAX","WAY","WEB","WET","WHO","WHY","WIN","WIT","WON",
  "YAK","YAM","YAP","YAW","YEA","YES","YET","YOU",
  "ZAP","ZED","ZEE",
  // 4 letters
  "ABLE","ACID","ACRE","AFAR","AIDE","ALLY","ALSO","AMEN","AMID","ANTE","APEX","ARCH","AREA","ARID","ARMS","ATOM","AUNT","AUTO","AVER",
  "BACK","BAKE","BALD","BAND","BANK","BARN","BATH","BEAD","BEAM","BEAN","BEAR","BEAT","BEEF","BEEN","BELL","BELT","BEND","BENT","BEST","BETA","BIDE","BIKE","BILL","BIND","BIRD","BITE","BLAH","BLOW","BLUE","BOAT","BOLD","BONE","BOOK","BOOM","BOOT","BORN","BOSS","BOTH","BOWL","BRAG","BRAN","BRED","BREW",
  "CAGE","CAKE","CALL","CALM","CAME","CAMP","CANE","CARD","CARE","CART","CASE","CASH","CAVE","CELL","CHAT","CHEF","CHIP","CHOP","CITE","CITY","CLAD","CLAY","CLIP","CLOUD","CLUE","COAL","COAT","CODE","COIN","COLD","COME","COOK","COOL","COPE","COPY","CORE","CORN","COST","CREW","CROP",
  "DARE","DARK","DATA","DATE","DAWN","DEAL","DEAR","DEBT","DECK","DEEP","DENT","DICE","DIED","DIET","DIME","DINE","DISH","DIVE","DONE","DOOM","DOOR","DOWN","DRAW","DREW","DROP","DUAL","DUCK",
  "EACH","EARN","EASE","EAST","ECHO","EDIT","ELEV","ELSE","EMIT","ENDS","ENVY","EPIC","EVEN","EVER","EXIT",
  "FACT","FADE","FAIL","FAIR","FALL","FAME","FARM","FAST","FATE","FEAR","FEED","FEEL","FELL","FELT","FILE","FILL","FIND","FINE","FIRE","FIRM","FISH","FIVE","FLAG","FLEE","FLEW","FLIP","FLOW","FOAM","FOOD","FOOL","FOOT","FORE","FORK","FORM","FORT","FOUR","FREE","FROG","FROM","FUEL","FULL",
  "GAIN","GAME","GATE","GEAR","GELD","GIFT","GIRL","GIVE","GLAD","GLOW","GOAL","GOES","GOLD","GONE","GOOD","GOWN","GRAB","GRAY","GREW","GRIN","GROW",
  "HAIR","HALF","HALL","HAND","HANG","HARD","HARM","HATE","HAVE","HEAD","HEAL","HEAR","HEAT","HELD","HELP","HERE","HERO","HIDE","HIGH","HILL","HINT","HOLD","HOME","HOPE","HOST","HOUR","HUSH",
  "IDEA","IDLE","IDOL","INCH","INTO","IRON","ITEM",
  "JAZZ","JOIN","JOKE","JUMP","JURY","JUST",
  "KEEP","KERN","KIND","KITE","KNEE",
  "LACK","LADY","LAID","LAKE","LAND","LANE","LAST","LATE","LAWN","LEAD","LEFT","LEND","LENS","LESS","LIFE","LIFT","LIKE","LINE","LINK","LIST","LIVE","LOAD","LOAN","LOCK","LOGO","LONG","LOOK","LOOP","LOSE","LOSS","LOST","LOUD","LOVE","LUCK",
  "MADE","MAIL","MAIN","MAKE","MALE","MANY","MARK","MASS","MATE","MEAL","MEAN","MEET","MENU","MERE","MESH","MILD","MILE","MILK","MIND","MINT","MISS","MOOD","MOON","MORE","MOST","MOVE","MUCH","MUSE",
  "NAME","NAVY","NEAR","NEED","NEST","NEXT","NICE","NINE","NONE","NOSE","NOTE","NOUN","NOVA",
  "OATH","OBEY","ODDS","ONCE","ONLY","OPEN","ORAL","OVER",
  "PACK","PAGE","PAID","PAIN","PAIR","PALM","PARK","PART","PASS","PAST","PATH","PEAK","PICK","PINK","PIPE","PLAN","PLAY","PLOT","PLUS","POEM","POET","POLL","POOL","POOR","PORT","POST","PULL","PURE",
  "RACE","RAIL","RAIN","RARE","RATE","READ","REAL","RELY","RENT","REST","RICH","RIDE","RING","RISE","RISK","ROAD","ROCK","ROLE","ROLL","ROOF","ROOM","ROOT","ROSE","RULE","RUST",
  "SAFE","SAID","SAME","SAND","SAVE","SEAL","SEAT","SEED","SEEK","SEEM","SEEN","SELF","SELL","SEND","SENT","SHED","SHIP","SHOE","SHOP","SHOT","SHOW","SHUT","SICK","SIDE","SIGN","SILK","SING","SITE","SIZE","SKIN","SLAM","SLOW","SOFT","SOLD","SOLO","SOME","SONG","SOON","SOUL","STAR","STAY","STEP","STOP","SUCH","SURE",
  "TAKE","TALE","TALK","TALL","TANK","TASK","TEAM","TELL","TEND","TENT","TERM","TEST","TEXT","THEN","THEY","THIN","THIS","TIDE","TILE","TIME","TINY","TOLD","TONE","TOOL","TORE","TOUR","TOWN","TREE","TRIP","TRUE","TUNE","TURN",
  "UNDO","UNIT","UPON","URGE","USER",
  "VAST","VERY","VIEW","VINE","VOTE",
  "WAIT","WAKE","WALK","WALL","WANT","WARM","WASH","WAVE","WEAR","WEEK","WELL","WENT","WEST","WHAT","WHEN","WHOM","WIDE","WIFE","WILD","WILL","WIND","WINE","WING","WISE","WISH","WITH","WOLF","WOOD","WORD","WORK","WORN",
  "YARN","YELL","YEST","YOUN",
  "ZERO","ZONE",
  // 5 letters (just a small helpful set)
  "ABOUT","ABOVE","ACORN","ADORE","AFTER","AGAIN","ALARM","ALBUM","ALERT","ALIEN","ALIVE","ALONE","ANGEL","APPLE","APRIL","ARENA",
  "BASIC","BATCH","BEACH","BEGAN","BEGIN","BEGUN","BELOW","BLANK","BLEED","BLEND","BLINK","BRAVE","BREAD","BREAK","BRICK","BRIEF","BRING","BROAD",
  "CABLE","CAMEL","CANAL","CANDY","CARRY","CATCH","CAUSE","CHAIN","CHAIR","CHEAP","CHECK","CHEST","CHIEF","CHILD","CHOIR","CIVIL","CLEAN","CLEAR","CLIMB","CLOCK","CLOSE","COAST","COMET","CORAL","COULD","COUNT",
  "DAILY","DANCE","DEALT","DEPTH","DOZEN","DREAM",
  "EARLY","EARTH","EIGHT","ELITE","EMPTY","ENJOY","ENTRY","EQUAL","ERROR","EVENT",
  "FAITH","FALSE","FARMS","FIFTY","FIGHT","FINAL","FIRST","FLOOR","FOCUS","FORCE","FRESH","FRONT",
  "GIANT","GIVEN","GLASS","GLOVE","GOING","GRACE","GRAND","GREAT","GREEN","GROUP",
  "HAPPY","HEART","HONEY","HORSE","HOUSE","HUMAN",
  "IDEAL","IMAGE","ISSUE",
  "KNOWN",
  "LARGE","LATER","LAUGH","LEARN","LEVEL","LIGHT","LIMIT","LOCAL","LOGIC","LOWER",
  "MAJOR","MATCH","MAYBE","METAL","MIGHT","MINOR","MONEY","MONTH","MOTOR","MUSIC",
  "NERVE","NEVER","NIGHT","NORTH",
  "OCEAN","OFTEN","ORDER","OTHER",
  "PARTY","PEACE","PHONE","PIANO","PLAIN","PLANT","POINT","POWER","PRESS","PRICE","PRIDE","PRIME","PROOF","PROUD",
  "QUIET",
  "RADIO","RAISE","RANGE","REACH","READY","RIGHT","RIVER","ROUND","ROUTE","RUGBY",
  "SCALE","SCENE","SCOPE","SCORE","SENSE","SERVE","SEVEN","SHARE","SHIFT","SHINE","SHIRT","SHORT","SIGHT","SINCE","SIXTH","SLEEP","SMALL","SMART","SMILE","SOLID","SOUND","SOUTH","SPEED","SPEND","SPLIT","SPORT","STAGE","START","STEEL","STILL","STOCK","STONE","STORE","STORY","STYLE","SUGAR",
  "TABLE","TAKEN","TEACH","THANK","THEIR","THERE","THESE","THICK","THING","THINK","THIRD","THOSE","THREE","THROW","TIGHT","TIMES","TODAY","TOTAL","TOUGH","TRAIN","TRUST","TRUTH",
  "UNDER","UNION","UNTIL","UPPER","USUAL",
  "VALUE","VIDEO","VISIT",
  "WATER","WHILE","WHITE","WHOLE","WORLD","WORTH","WOULD","WRITE",
  "YOUTH",
  // 6 letters
  "ACTION","ARTIST","BATTLE","BRIDGE","CAMERA","CIRCLE","DANGER","ENERGY","FAMILY","FOREST",
  "FRIEND","GUITAR","HAMMER","ISLAND","LETTER","MARKET","MEMORY","MOTION","NATURE","OBJECT",
  "ORANGE","PLANET","PLAYER","POETRY","RECORD","SIGNAL","SILVER","SPIRIT","STREET","SUMMER",
  "SYSTEM","TRAVEL","WINTER",
  // 7 letters
  "ANCIENT","BALANCE","CAPTAIN","CENTRAL","CHAPTER","CONCERT","CRYSTAL","CULTURE","DIAMOND","FREEDOM",
  "GALLERY","HISTORY","JOURNEY","KINGDOM","MACHINE","MESSAGE","MORNING","MUSICAL","MYSTERY","NATURAL",
  "PICTURE","RAINBOW","SCIENCE","SILENCE","SOLDIER","SPECIAL","THUNDER","VILLAGE","WEATHER",
  // 8 letters
  "BUILDING","CHILDREN","COMPLETE","COMPUTER","CROSSING","DISCOVER","DISTANCE","FESTIVAL","MOUNTAIN",
  "PAINTING","QUESTION","REMEMBER","SENTENCE","SHOULDER","STANDARD","STRENGTH","SUNSHINE","TREASURE",
  "UNIVERSE",
  // 9-11 letters
  "ADVENTURE","COMMUNITY","EDUCATION","KNOWLEDGE","LANDSCAPE","MOVEMENT","PRESIDENT","SOMETHING",
  "BACKGROUND","BASKETBALL","DIFFERENCE","EARTHQUAKE","EVERYTHING","FRIENDSHIP","GOVERNMENT",
  "LIGHTHOUSE","NEWSPAPER","POPULATION","RESTAURANT","SCIENTIFIC","TECHNOLOGY","TELEVISION",
  "CELEBRATION","ENVIRONMENT","GENERATION","IMAGINATION","INFORMATION","PERFORMANCE","POSSIBILITY"
];

const SPANISH_FILLER_WORDS: string[] = [
  "AIRE", "ALMA", "ALTO", "AMOR", "ARTE", "AZUL", "BAJO", "BASE", "BESO", "BOCA",
  "CADA", "CAMA", "CARA", "CASA", "CASO", "CENA", "CINE", "CITA", "CLUB", "COLA",
  "DATO", "DEDO", "DIA", "DIAS", "DUNA", "EDAD", "EJE", "EJES", "ESTE", "FARO",
  "FILA", "FINO", "FLOR", "FOTO", "GALA", "GATO", "GIRO", "GOTA", "GRIS", "HILO",
  "HORA", "IDEA", "ISLA", "LADO", "LAGO", "LATA", "LIGA", "LIMA", "LONA", "LUNA",
  "MANO", "MAR", "MASA", "MESA", "META", "MODO", "MONO", "NAVE", "NODO", "NOTA",
  "ONDA", "ORO", "PALA", "PALO", "PATA", "PENA", "PESO", "PICO", "PIEL", "PISO",
  "RAMA", "RANA", "RATO", "RED", "REDES", "RETO", "RIMA", "RIO", "RIOS", "ROCA",
  "ROJO", "ROSA", "RUTA", "SALA", "SAL", "SEDA", "SEDE", "SEIS", "SILLA", "SOGA",
  "SOL", "SOPA", "SUR", "TAPA", "TARDE", "TASA", "TELA", "TEMA", "TONO", "TORRE",
  "TREN", "UNO", "USO", "VALLE", "VASO", "VELA", "VIDA", "VINO", "ZONA",
  "ABIERTO", "ALTURA", "AMBIENTE", "ANTIGUO", "BARRIO", "BELLEZA", "BOSQUE",
  "CAMINO", "CAMINOS", "CENTRO", "CIUDAD", "CLASICO", "COMARCA", "CULTURA",
  "DESTINO", "ENTORNO", "ESTACION", "FAMILIA", "FUENTE", "HISTORIA", "JARDIN",
  "LAGUNA", "LUGARES", "MIRADOR", "MONTANA", "NATURAL", "PARAJE",
  "PARQUE", "PAISAJE", "PASEOS", "PUEBLO", "PUENTE", "PUERTO", "REGION",
  "RESERVA", "REFUGIO", "SENDERO", "TURISMO", "VECINO", "VIAJERO"
];

const COMMON_ENGLISH_DICTIONARY_WORDS = (() => {
  try {
    return Array.from(
      new Set(
        readFileSync(join(process.cwd(), "data", "common-words-en.txt"), "utf8")
          .split(/\r?\n/)
          .map((word) => normalizeAnswer(word))
          .filter(
            (word) =>
              word.length >= 3 &&
              word.length <= 11 &&
              ASCII_A_TO_Z.test(word)
          )
      )
    ).slice(0, 5000);
  } catch (error: unknown) {
    console.warn("[generate-crossword] common English dictionary unavailable", {
      msg: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
})();

function loadFrequencyDictionary(filename: string): string[] {
  try {
    return Array.from(
      new Set(
        readFileSync(join(process.cwd(), "data", filename), "utf8")
          .split(/\r?\n/)
          .map((line) => normalizeAnswer(line.trim().split(/\s+/)[0] ?? ""))
          .filter(
            (word) =>
              word.length >= 3 &&
              word.length <= 11 &&
              ASCII_A_TO_Z.test(word)
          )
      )
    ).slice(0, 30_000);
  } catch (error: unknown) {
    console.warn("[generate-crossword] frequency dictionary unavailable", {
      filename,
      msg: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

const FREQUENCY_ENGLISH_DICTIONARY_WORDS = loadFrequencyDictionary(
  "frequency-en-50k.txt"
);
const FREQUENCY_SPANISH_DICTIONARY_WORDS = loadFrequencyDictionary(
  "frequency-es-50k.txt"
);

const WEAK_CONTEXT_DICTIONARY_WORDS = new Set([
  "ARE", "ASK", "BEEN", "DID", "DOES", "DONE", "FINE", "GET", "GOT", "HAS",
  "HAVE", "KENYA", "LIE", "ONE", "SEE", "TOO", "WAS", "WERE", "YET",
  "ABOUT", "AFTER", "AGAIN", "BEFORE", "COULD", "EVERY", "OTHER", "THEIR",
  "THERE", "THESE", "THOSE", "WOULD",
]);

async function rankSemanticSupportWords(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
}): Promise<string[]> {
  const { client, theme, language, size } = opts;
  const source = Array.from(
    new Set(
      (language === "es" ? SPANISH_FILLER_WORDS : FILLER_WORDS)
        .map((word) => normalizeAnswer(word))
        .filter(
          (word) =>
            word.length >= 3 &&
            word.length <= Math.min(size, 8) &&
            ASCII_A_TO_Z.test(word) &&
            !WEAK_CONTEXT_DICTIONARY_WORDS.has(word)
        )
    )
  ).slice(0, 1500);
  if (source.length === 0) return [];

  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: [
      language === "es"
        ? `Vocabulario concretamente relacionado con el tema: ${theme}`
        : `Vocabulary concretely related to the theme: ${theme}`,
      ...source.map((word) => word.toLowerCase()),
    ],
  });
  const themeVector = response.data[0]?.embedding;
  if (!themeVector) return [];

  const norm = (vector: number[]) =>
    Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  const themeNorm = norm(themeVector);
  return source
    .map((word, index) => {
      const vector = response.data[index + 1]?.embedding ?? [];
      const dot = vector.reduce(
        (sum, value, vectorIndex) =>
          sum + value * (themeVector[vectorIndex] ?? 0),
        0
      );
      return { word, score: dot / (themeNorm * norm(vector)) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 500)
    .map((item) => item.word);
}

const TARGET_ANSWERS = 70;
const ANSWERBANK_MODEL = process.env.OPENAI_ANSWERBANK_MODEL ?? "gpt-4.1-mini";
const CLUE_MODEL = process.env.OPENAI_CLUE_MODEL ?? "gpt-4o-mini";
const ANSWERBANK_SEARCH_MODEL = process.env.OPENAI_ANSWERBANK_SEARCH_MODEL ?? "gpt-4.1";
const COMPACT_ANSWERBANK_MODEL = process.env.OPENAI_COMPACT_ANSWERBANK_MODEL ?? ANSWERBANK_MODEL;

// Palabras ultra genéricas / stopwords que NO queremos como respuestas.
const BANNED_ANSWERS = new Set([
  "IN", "ON", "AT", "OF", "TO", "FOR", "AND", "OR", "THE", "A", "AN",
  "AIRE", "AMEA", "CADA", "CASO", "COLA", "COSA", "DATO", "DIAS", "FLORE", "IDEA", "MENOR", "MODO", "PAISA", "ROJO", "SEIS", "SOGA", "TAPA", "TEMA", "TRILHA", "USO", "UNO", "VIVIR",
  "WIND", "WAVE", "WARM", "WILD", "WISH", "NICE", "MILD", "PICK", "RIDE", "SLOW", "TIDE", "YARN", "ZING", "JACKET", "PLUCK",
  "MEUP", "BROWNIE", "AVENT", "MONT", "NEVE", "FEST", "CULT", "AFAR",
  "CASC", "CUMB", "CICL", "AIDE", "ARMS", "ATOM", "NATUR", "CARNI", "CULTU", "MERKADO",
  "CAMPAR",
  "FRES", "VERD", "VALL", "SEND", "VIVI",
  "OTT", "TEDRA", "NAVEG", "PATRICIO",
]);

const MODEL_FRAGMENT_ANSWERS = new Set([
  "AMEA", "NATUR", "CARNI", "CULTU", "AVENT", "MONT", "NEVE", "CASC", "CUMB", "CICL",
  "TURIS", "PAISA", "PATAG", "ANDIN", "CHOCOL", "ARTES", "PANOR", "FOTOG", "FAMIL", "SENDER", "MERKADO",
  "ADIE", "ENTRAL", "GAR", "NTRAL", "NZA", "FRES", "HUITR", "SILV", "VERD", "VALL", "SEND", "SDEL", "VIVI", "OTT", "TEDRA", "NAVEG", "MELI", "TRANC", "MASC", "COSTAN",
  "ADRIFTING", "AEROLIB", "ALECE", "ALMOND", "ALPINIS", "ARAUCA", "ARENDEX", "ARGENT", "ARMIR12", "ARTESAN", "ATOMICA", "ATOMICENTRE", "BURILOCHE", "CAMP", "CAMPAN", "CAMINOSIETE", "CANACOLIHUE", "CENICIE", "CERROCAMP", "CERVEC", "CERVECER", "CICLIS", "CICLISM", "CIRCUIT", "CIUDADB", "CIVICCENTRE", "CIVICENTRE", "COIHUEDEM", "CORDER", "COSTANER", "CULTUR", "CULI", "ELLAOELAO", "ESQUIMOSKI", "FUERADE", "GASTRON", "GOLFLLAO", "GRADTRIP", "GUAT", "HHOTEL", "HORIZON", "HOTLLUOLLAO", "HOTELOGLI", "IPVAP", "LAGOBLANCO", "LAGOARGENT", "LAGOGUAT", "LAGOHERMOSO", "LAGOLIMPIO", "LAGOLOMA", "LAGOMORO", "LAGOSILVINA", "LAGOSOL", "LAGOSUR", "LAGOTRANC", "LAGOTRANCAS", "LAGOVIED", "LAGOVIEDMA", "LERALI", "LERPUMILIO", "LLOALLOO", "LOLIMPE", "LTACUL", "LUMI", "MASARDI", "MIBUS", "NATELHUAPI", "NATURA", "NATURALAP", "NATURALE", "NIE", "NUEVACHEL", "NUEVORUED", "OSEQUIPO", "PASEONUEVO", "PASSEOS", "PATABOS", "PATAGON", "PATRIMON", "PDAO", "PELUCHECOY", "PILTRAF", "POYAS", "PUEYL", "RAIDGAUL", "RAPA", "RUTHMER", "SENDERIS", "STUDENTTOUR", "SWISSTYLED", "TELSILLA", "TURONADOR", "VIED", "VERGEO", "VILLALTACUL", "VURILOCHE",
]);

const CONTEXTUAL_GENERIC_ANSWERS = new Set(["HIDRO"]);
const LOW_VALUE_CONTEXTLESS_ANSWERS = new Set([
  "AIRE",
  "ALMENDRO",
  "ASADO",
  "BAYO",
  "CAMPOS",
  "CAMPO",
  "CITA",
  "CLUB",
  "CINE",
  "CIRUELA",
  "COLA",
  "CUATRO",
  "DECLARACION",
  "DEDO",
  "DATO",
  "DIAS",
  "DOLARES",
  "DUNA",
  "EDAD",
  "ESCOBA",
  "EJES",
  "ESTE",
  "FARO",
  "FILA",
  "FINO",
  "FLOR",
  "FOTO",
  "GALA",
  "GATO",
  "GOTA",
  "GOLF",
  "GRIS",
  "HERMOSO",
  "HIKING",
  "HORA",
  "LADO",
  "LATA",
  "HILO",
  "GIRO",
  "LIGA",
  "LIMA",
  "LIMPIO",
  "LONA",
  "LUNA",
  "MANO",
  "MASA",
  "META",
  "MONO",
  "MONTI",
  "MIRLO",
  "NIVEL",
  "NODO",
  "NUBE",
  "MESA",
  "ONDA",
  "OLAS",
  "PATRON",
  "FESTI",
  "NAVE",
  "NOTA",
  "PATA",
  "PALA",
  "PIEL",
  "PIONERA",
  "PENA",
  "PESO",
  "PINO",
  "PISO",
  "RIMA",
  "ROSA",
  "RATO",
  "RANA",
  "RETO",
  "ROCA",
  "SALA",
  "SEDA",
  "SEDE",
  "SOPA",
  "TELA",
  "SKIING",
  "TORTA",
  "VIEJO",
  "ZONA",
]);

const CONTEXTUAL_SUPPORT_ANSWERS = new Set([
  "ALBERGUE",
  "AVENTURA",
  "BOSQUE",
  "CAMPING",
  "CANOA",
  "CERRO",
  "CAMINO",
  "COAST",
  "COSTA",
  "FAUNA",
  "FLORA",
  "FOREST",
  "FRIO",
  "GUIA",
  "GUIDE",
  "AGUA",
  "HOSTERIA",
  "HOTEL",
  "HOSTEL",
  "ISLA",
  "ISLAND",
  "KAYAK",
  "LAGO",
  "LAKE",
  "MAP",
  "MAPA",
  "MIRADOR",
  "MUSEO",
  "MUSEUM",
  "NATURALEZA",
  "NIEVE",
  "NORTE",
  "PARK",
  "PARQUE",
  "PASEO",
  "PATOS",
  "PESCA",
  "PESCADOR",
  "SALMONES",
  "PLAYA",
  "PUERTO",
  "RANCHO",
  "RANCHOS",
  "REFUGIO",
  "RIO",
  "RIVER",
  "ROUTE",
  "RUTA",
  "RUTAS",
  "SENDERO",
  "SUR",
  "TOUR",
  "TRAIL",
  "TURISMO",
  "VALLE",
  "VERANO",
  "VIAJE",
  "VIEW",
  "VISTA",
]);

const SPANISH_WRONG_LANGUAGE_ANSWERS = new Set([
  "ADVENTURE",
  "BIRCH",
  "BROOKTROUT",
  "CATHEDRAL",
  "CIVICCENTRE",
  "GLACIER",
  "RAILWAY",
  "SEVENLAKES",
  "SKIHUT",
  "SKIRESORT",
  "SNOWFALL",
  "SNOWBOARD",
  "SNOWPARK",
  "STEPPE",
  "TOURISM",
  "WINDSURF",
  "ZIPLINE",
  "GUIDE",
  "HUT",
  "FREYHUT",
  "LIMAYRIVER",
  "RIVER",
  "TRAIL",
  "VALDIVIAN",
  "BLAU",
]);

const OVER_GENERIC_THEME_WORDS = new Set([
  "BAYOU","BEACH","BEACHES","BLOOM","CAMP","CAMPS","CAMPSITE","CAMPY","CITIES","CITY",
  "CAMPUS","CANYON","CANYONS","COAST","COASTAL","CLOUD","CLOUDS","CREEK","DESERT","DESERTS",
  "COVE","COVES","DREAM","DUNE","DUNES","FARM","FARMS","FIELD","FIELDS","FISH","FOLK","FRESH","GARDEN","GARDENS","GOLDEN","GRASS","GROVE","HARBOR","HARBORS",
  "HILL","HILLS","HONEY","ISLAND","ISLANDS","JOURNAL","LAKE","LAKES","MEADOW","MEADOWS",
  "MOUNTAIN","MOUNTAINS","NATURE","OCEAN","PARK","PARKS","PATIO","PEACE","RANCH","RANCHES",
  "RIVER","RIVERS","ROCKY","SAND","SANDAL","SANDY","SHORE","SHORES","SKYLINE","SLOPE","SLOPES","SUNNY","SUNSET",
  "SANDS","SKIES","TACOS","TIDAL","TRAIL","TRAILS","TREE","TREES","VALLEY","WATER","WATERS","WILD","WINDY","WINE",
  "WOOD","WOODS"
]);

function isOverGenericThemeWord(answer: string): boolean {
  const a = normalizeAnswer(answer);
  if (!a) return true;
  if (OVER_GENERIC_THEME_WORDS.has(a)) return true;

  if (a.length <= 4) return false;

  if (/^(SUN|SEA|SKY|BAY|PARK|HILL|LAKE|RIVER|TREE|COAST|SHORE|WOOD|CLOUD|DESERT|MEADOW|GARDEN|CANYON|ISLAND|DUNE|COVE|FISH|FOLK)/.test(a)) return true;
  if (/(VILLE|WOODS|SHORE|SHORES|TRAIL|TRAILS|PARKS|HILLS|WATER|WATERS|GARDEN|GARDENS|DESERT|DESERTS|CANYON|CANYONS|CLOUD|CLOUDS|MEADOW|MEADOWS|ISLAND|ISLANDS|DUNE|DUNES|COVE|COVES)$/.test(a)) return true;

  return false;
}

function isThemeCoreWord(theme: string, answer: string): boolean {
  const t = normalizeAnswer(theme);
  const a = normalizeAnswer(answer);
  if (!t || !a) return false;

  if (a === t) return true;

  const anchors = getThemeAnchors(theme).map((x) => normalizeAnswer(x)).filter(Boolean);
  if (anchors.includes(a)) return true;

  if (t.length >= 4 && (a.includes(t) || t.includes(a))) return true;

  return false;
}

function isRiskyGeneratedGeographicCompound(theme: string, answer: string): boolean {
  const a = normalizeAnswer(answer);
  if (!a || isThemeCoreWord(theme, a)) return false;

  const prefixes = [
    "CERRO",
    "LAGO",
    "LAKE",
    "RIO",
    "RIVER",
    "ISLA",
    "ISLAND",
    "PUERTO",
    "PORT",
    "VILLA",
    "COLONIA",
    "PARQUE",
    "PARK",
    "MONTE",
    "MOUNT",
  ];

  return prefixes.some((prefix) => a.startsWith(prefix) && a.length >= prefix.length + 3);
}

function isOverGenericThemeWordForTheme(theme: string, answer: string): boolean {
  if (isThemeCoreWord(theme, answer)) return false;

  const t = normalizeAnswer(theme);
  const a = normalizeAnswer(answer);

  if (t === "VINO" || t === "WINE") {
    const tooLooseForWine = new Set([
      "CUBO","HIELO","JUGO","RICO","PICO","TROPA","CIEGA","MALTA","VISTA","BODEG",
      "TAPAS","SABOR","PICOS","FIESTA","RACIM","HOGAR","MESA","BARRA","BEBER","FRUTA",
      "BANDA","CIELO","FLORES","BEBE","SABE","TINO","SUIZO","TERRA","CANTO",
      "CENA","TROZO","ACEITE","TANIN"
    ]);
    if (tooLooseForWine.has(a)) return true;
  }

  if (t === "ARGENTINA") {
    const tooLooseForArgentina = new Set([
      "BANDA","GUITARRA","VINO","SABOR","RITMO","RUMBA","LAGO","FLORE","SUELO","RAPID",
      "VIVIR","RANGO","DANZA","RIVAS","LUCES","COSTA","COSTAS","COSTUM","NATURA","SUENO","FRESCO","CARNES",
      "LIMON","QUESO","PAPAS","TORTA","SUENOS","TRADIC","RITMOS","CULTA"
    ]);
    if (tooLooseForArgentina.has(a)) return true;
  }

  if (t === "MENDOZA") {
    const tooLooseForMendoza = new Set([
      "FRESCO","RICO","TERRA","RIEGO","FLORES","VINOS","BLANCO","TINTA",
      "RUTAS","CIELO","HOGAR","VERDE","TROPA","FRUTA","SUENO",
      "RANGO","SABOR","CUEVA","CULTI","SUELO","CIEGA","ARGENTO","DULCE",
      "LAGO","VIDA","FLOR","COSTA","CARNE","CARNI"
    ]);
    if (tooLooseForMendoza.has(a)) return true;
  }

  if (t === "BARILOCHE") {
    const tooLooseForBariloche = new Set([
      "VINO","VINOS","UVA","UVAS","VID","CEPA","CEPAS","MOSTO","CAVA","BRUT",
      "CATA","TANINO","TANINOS","BODEGA","BODEGAS","MALBEC","MERLOT","CABERNET",
      "TEMPRANILLO","VINICOLA","RACIMO","RAPIDO","RAPID","TINTA","BLANCO",
      "NORTON","PULENTA","MAIPU","UCO","TUNUYAN","SANRAFAEL","GODOYCRUZ",
      "GUAYMALLEN","USPALLATA","ACONCAGUA","RICO","FRESCO","SABOR","TERRA",
      "HESS","CIELO","ALMA","AMOR","TURBO","LUCES","CAMPER","BOCA","BESO",
      "CASA","CARA","CAMA","CIMA","CUEVA","PICO","VERDE","MONTE","FAUNA",
      "NAVEG","CERROPIEDRA","CENA","AZUL","ALTO","BAJO","BASE","ARTE","RAMA"
    ]);
    if (tooLooseForBariloche.has(a)) return true;
  }

  if (t === "JAPON" || t === "JAPAN") {
    const tooLooseForJapan = new Set([
      "LETRA","PAISA","AGUA","MUNDO","FLOR","LUNA","PAPEL","BANDA","FUEGO","CAMA",
      "SUENO","BOLSA","NIEVE","FIESTA","SOLAR","RUTA","COSTA","CULTA","MUNDO",
      "PAISA","AGUA","LAGO","TAIKO"
    ]);
    if (tooLooseForJapan.has(a)) return true;
  }

  if (t === "MEGADETH") {
    const tooLooseForMegadeth = new Set([
      "ESCENA","ALBUM","LETRA","CONCIER","TEMA","RITMO","MUSICA","RUIDO","ESTILO",
      "FANATIC","CANTAR","BANDA","FUEGO","CAMA","PAPEL","LUNA","FLOR","MUNDO",
      "AGUA","PAISA","SOLAR","FIESTA","BOLSA","NIEVE","RUTA","COSTA","CULTA",
      "LUCES","SUENO","DOLOR","RAPAZ","FUSION","TEMA","RUIDO","ACUSTIC","ACOUSTIC",
      "VIBRA","VIBRANTE","PULSO","NIVEL","DANZA","FESTIVAL","VIRTUAL","SONAR",
      "VIVO","ELECTRO","ESCENA","CONCIERTO"
    ]);
    if (tooLooseForMegadeth.has(a)) return true;
  }

  if (t === "METALLICA") {
    const tooLooseForMetallica = new Set([
      "ALBUM","LETRA","MUSICA","RITMO","BANDA","CANTAR","ESTILO","RUIDO","FANATIC",
      "ESCENA","CONCIERTO","VIBRA","VIBRANTE","PULSO","NIVEL","DANZA","FESTIVAL",
      "VIRTUAL","SONAR","VIVO","ELECTRO","LUCES","SUENO","DOLOR","RAPAZ","FUSION",
      "AGUA","PAISA","SOLAR","FIESTA","BOLSA","NIEVE","RUTA","COSTA","CULTA",
      "FUEGO","CAMA","PAPEL","LUNA","FLOR","MUNDO","ACUSTIC","ACOUSTIC"
    ]);
    if (tooLooseForMetallica.has(a)) return true;
  }

  return isOverGenericThemeWord(answer);
}

function sanitizeAnswerList(raw: unknown, maxLen: number, language?: "es" | "en") {
  const out: string[] = [];
  const seen = new Set<string>();

  if (!Array.isArray(raw)) return out;

  for (const item of raw) {
    const a = normalizeAnswer(String(item ?? ""));
    if (!a) continue;

    // A–Z0-9 only
    if (!ASCII_A_TO_Z.test(a)) continue;

    // length 3..maxLen
    if (a.length < 3 || a.length > maxLen) continue;

    // ban obvious junk
    if (BANNED_ANSWERS.has(a)) continue;
    if (language && !answerLanguageLooksValidForPuzzle(a, language)) continue;
    if (isLikelyBadAnswer(a) && !ALWAYS_ALLOW_ANSWERS.has(a)) continue;

    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }

  // Remove entries that are exact prefixes of a longer entry also present.
  // Example: MAL vs MALIBU, FRES vs FRESNO, SIL vs SILICON.
  const filtered = out.filter((a) => {
    return !out.some((b) => b !== a && b.length > a.length && b.startsWith(a));
  });

  return filtered;
}

type CspBankAuditRejectedSample = {
  answer: string;
  reason: string;
};

type CspBankAuditReport = {
  theme: string;
  language: "es" | "en";
  size: number;
  initialRawCount: number;
  initialSanitizedCount: number;
  validatedCount: number;
  candidatePoolCount: number;
  cspCandidateCount: number;
  distributions: Record<string, Record<string, number>>;
  rejectedByStage: Record<string, Record<string, number>>;
  rejectedSamplesByStage: Record<string, CspBankAuditRejectedSample[]>;
  samplesByStage: Record<string, string[]>;
  cspMissingLengths: Record<string, number>;
  cspRequestedTopUpByLength: Record<string, number>;
  cspTopUpRawByLength: Record<string, number>;
  cspTopUpAcceptedByLength: Record<string, number>;
  cspTopUpRejectedByLength: Record<string, number>;
  cspAdapterRejectedByReason: Record<string, number>;
  cspDomainDiagnostics: unknown[];
};

function createCspBankAuditReport(theme: string, language: "es" | "en", size: number): CspBankAuditReport {
  return {
    theme,
    language,
    size,
    initialRawCount: 0,
    initialSanitizedCount: 0,
    validatedCount: 0,
    candidatePoolCount: 0,
    cspCandidateCount: 0,
    distributions: {},
    rejectedByStage: {},
    rejectedSamplesByStage: {},
    samplesByStage: {},
    cspMissingLengths: {},
    cspRequestedTopUpByLength: {},
    cspTopUpRawByLength: {},
    cspTopUpAcceptedByLength: {},
    cspTopUpRejectedByLength: {},
    cspAdapterRejectedByReason: {},
    cspDomainDiagnostics: [],
  };
}

function cspBankAuditDistribution(values: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of values) {
    const answer = normalizeAnswer(raw);
    if (!answer) continue;
    out[String(answer.length)] = (out[String(answer.length)] ?? 0) + 1;
  }
  return out;
}

function cspBankAuditCandidateDistribution(values: Iterable<{ answer: string }>): Record<string, number> {
  return cspBankAuditDistribution(Array.from(values, (value) => value.answer));
}

function cspBankAuditSample(values: Iterable<string>, limit = 20): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const answer = normalizeAnswer(raw);
    if (!answer || seen.has(answer)) continue;
    seen.add(answer);
    out.push(answer);
    if (out.length >= limit) break;
  }
  return out;
}

function cspBankAuditLog(label: string, payload: Record<string, unknown>) {
  console.warn(`[csp-bank-audit] ${label} ${JSON.stringify(payload)}`);
}

function cspDiagnosticLog(label: string, payload: Record<string, unknown>) {
  console.warn(`[csp-diagnostic] ${label} ${JSON.stringify(payload)}`);
}

function cspHybridDiagnosticLog(label: string, payload: Record<string, unknown>) {
  console.warn(`[csp-hybrid-diagnostic] ${label} ${JSON.stringify(payload)}`);
}

function cspSearchProfileLog(payload: Record<string, unknown>) {
  console.warn(`[csp-search-profile] ${JSON.stringify(payload)}`);
}

function cspSearchCausalityLog(payload: Record<string, unknown>) {
  console.warn(`[csp-search-causality] ${JSON.stringify(payload)}`);
}

function cspWipeoutCausalityLog(payload: Record<string, unknown>) {
  console.warn(`[csp-wipeout-causality] ${JSON.stringify(payload)}`);
}

function cspBranchingDiagnosticLog(payload: Record<string, unknown>) {
  console.warn(`[csp-branching-diagnostic] ${JSON.stringify(payload)}`);
}

function cspValueOrderingDiagnosticLog(payload: Record<string, unknown>) {
  console.warn(`[csp-value-ordering-diagnostic] ${JSON.stringify(payload)}`);
}

function cspBankAuditSetDistribution(report: CspBankAuditReport, stage: string, values: Iterable<string>) {
  const sampleSource = Array.from(values);
  report.distributions[stage] = cspBankAuditDistribution(sampleSource);
  report.samplesByStage[stage] = cspBankAuditSample(sampleSource);
  cspBankAuditLog(stage, {
    count: sampleSource.length,
    byLength: report.distributions[stage],
    sample: report.samplesByStage[stage],
  });
}

function cspBankAuditAddRejected(
  report: CspBankAuditReport,
  stage: string,
  reason: string,
  answer: string
) {
  const stageReasons = report.rejectedByStage[stage] ?? {};
  stageReasons[reason] = (stageReasons[reason] ?? 0) + 1;
  report.rejectedByStage[stage] = stageReasons;
  const samples = report.rejectedSamplesByStage[stage] ?? [];
  if (samples.length < 20) samples.push({ answer: normalizeAnswer(answer), reason });
  report.rejectedSamplesByStage[stage] = samples;
}

function cspBankAuditMergeCounts(target: Record<string, number>, source: Record<string | number, number>) {
  for (const [key, value] of Object.entries(source)) {
    target[String(key)] = (target[String(key)] ?? 0) + value;
  }
}

function cspBankAuditAnalyzeSanitize(
  raw: unknown,
  sanitized: string[],
  opts: { theme: string; maxLen: number; language: "es" | "en"; report: CspBankAuditReport }
) {
  if (!Array.isArray(raw)) {
    cspBankAuditAddRejected(opts.report, "sanitize", "other", "");
    return;
  }

  const accepted = new Set(sanitized.map(normalizeAnswer).filter(Boolean));
  const firstPass: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const answer = normalizeAnswer(String(item ?? ""));
    let reason: string | null = null;
    if (!answer) reason = "empty";
    else if (!ASCII_A_TO_Z.test(answer)) reason = "invalid-characters";
    else if (answer.length < 3) reason = "too-short";
    else if (answer.length > opts.maxLen) reason = "too-long";
    else if (BANNED_ANSWERS.has(answer)) reason = "banned-answer";
    else if (!answerLanguageLooksValidForPuzzle(answer, opts.language)) reason = "likely-bad-answer";
    else if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) reason = "likely-bad-answer";
    else if (seen.has(answer)) reason = "duplicate-after-normalization";

    if (reason) {
      cspBankAuditAddRejected(opts.report, "sanitize", reason, answer);
      continue;
    }

    seen.add(answer);
    firstPass.push(answer);
  }

  for (const answer of firstPass) {
    if (!accepted.has(answer)) cspBankAuditAddRejected(opts.report, "sanitize", "prefix-of-longer-answer", answer);
  }

  const themeNorm = normalizeAnswer(opts.theme);
  if (themeNorm && firstPass.includes(themeNorm) && !sanitized.includes(themeNorm)) {
    cspBankAuditAddRejected(opts.report, "post-sanitize-theme-filter", "exact-theme", themeNorm);
  }
}

function cspBankAuditRejectedBySet(
  report: CspBankAuditReport,
  stage: string,
  input: string[],
  kept: string[],
  reason: string
) {
  const keptSet = new Set(kept.map(normalizeAnswer).filter(Boolean));
  for (const answer of input.map(normalizeAnswer).filter(Boolean)) {
    if (!keptSet.has(answer)) cspBankAuditAddRejected(report, stage, reason, answer);
  }
}

function expandGeographicCompoundAnswers(answers: string[], maxLen: number): string[] {
  const prefixes = [
    "CERRO",
    "LAGO",
    "RIO",
    "ISLA",
    "PUERTO",
    "VILLA",
    "COLONIA",
    "RUTA",
    "PARQUE",
    "MONTE",
  ];
  const out: string[] = [];

  for (const answer of answers) {
    const a = normalizeAnswer(answer);
    if (!a) continue;

    for (const prefix of prefixes) {
      if (!a.startsWith(prefix)) continue;
      if (MODEL_FRAGMENT_ANSWERS.has(a)) continue;
      const suffix = a.slice(prefix.length);
      if (suffix.length < 3 || suffix.length > maxLen) continue;
      if (!ASCII_A_TO_Z.test(suffix)) continue;
      if (BANNED_ANSWERS.has(suffix)) continue;
      if (isLikelyBadAnswer(suffix) && !ALWAYS_ALLOW_ANSWERS.has(suffix)) continue;
      if (prefix.length >= 3 && prefix.length <= maxLen && !BANNED_ANSWERS.has(prefix)) out.push(prefix);
      out.push(suffix);
    }
  }

  return Array.from(new Set(out));
}

function rebuildGridFromAllowedEntries(
  grid: string[][],
  allowedAnswers: Set<string>,
  minLen: number
): { grid: string[][]; derived: Omit<Entry, "clue">[] } | null {
  const derived = deriveEntriesFromGrid(grid, minLen).filter((e) => allowedAnswers.has(e.answer));
  if (derived.length === 0) return null;

  const size = grid.length;
  const scratch = makeEmptyWorkingGrid(size);

  for (const entry of derived) {
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      const ch = entry.answer[i];
      const cur = scratch[r][c];
      if (cur !== "" && cur !== ch) return null;
      scratch[r][c] = ch;
    }
  }

  let blocked = paintBlocks(scratch);
  blocked = enforceMinWordLen(blocked, minLen);
  blocked = pruneDanglingRuns(blocked, minLen);
  blocked = keepLargestConnectedComponent(blocked);
  blocked = keepLargestConnectedComponent(blocked);

  const final = gridToStrings(blocked as (string | null)[][]);
  const finalDerived = deriveEntriesFromGrid(final, minLen);

  if (finalDerived.length === 0) return null;
  if (finalDerived.some((e) => !allowedAnswers.has(e.answer))) return null;

  return { grid: final, derived: finalDerived };
}

function rebuildGridFromEntries(
  size: number,
  entries: Omit<Entry, "clue">[],
  minLen: number
): { grid: string[][]; derived: Omit<Entry, "clue">[] } | null {
  if (entries.length === 0) return null;

  const scratch = makeEmptyWorkingGrid(size);

  for (const entry of entries) {
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      if (!inBounds(size, r, c)) return null;
      const cur = scratch[r][c];
      const ch = entry.answer[i];
      if (cur !== "" && cur !== ch) return null;
      scratch[r][c] = ch;
    }
  }

  let blocked = paintBlocks(scratch);
  blocked = enforceMinWordLen(blocked, minLen);
  blocked = pruneDanglingRuns(blocked, minLen);
  blocked = keepLargestConnectedComponent(blocked);
  blocked = keepLargestConnectedComponent(blocked);

  const final = gridToStrings(blocked as (string | null)[][]);
  const finalDerived = deriveEntriesFromGrid(final, minLen);
  const expectedKeys = new Set(entries.map((e) => `${e.direction}:${e.row}:${e.col}:${e.answer}`));
  const finalKeys = new Set(finalDerived.map((e) => `${e.direction}:${e.row}:${e.col}:${e.answer}`));

  for (const key of finalKeys) {
    if (!expectedKeys.has(key)) return null;
  }

  return { grid: final, derived: finalDerived };
}

function rebuildGridFromEntriesAllowingAllowedDerived(
  size: number,
  entries: Omit<Entry, "clue">[],
  minLen: number,
  allowedAnswers: Set<string>
): { grid: string[][]; derived: Omit<Entry, "clue">[] } | null {
  if (entries.length === 0) return null;

  const scratch = makeEmptyWorkingGrid(size);

  for (const entry of entries) {
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      if (!inBounds(size, r, c)) return null;
      const cur = scratch[r][c];
      const ch = entry.answer[i];
      if (cur !== "" && cur !== ch) return null;
      scratch[r][c] = ch;
    }
  }

  let blocked = paintBlocks(scratch);
  blocked = enforceMinWordLen(blocked, minLen);
  blocked = pruneDanglingRuns(blocked, minLen);
  blocked = keepLargestConnectedComponent(blocked);
  blocked = keepLargestConnectedComponent(blocked);

  const final = gridToStrings(blocked as (string | null)[][]);
  const finalDerived = deriveEntriesFromGrid(final, minLen);

  if (finalDerived.length === 0) return null;
  if (finalDerived.some((entry) => !allowedAnswers.has(entry.answer))) return null;

  return { grid: final, derived: finalDerived };
}

function pruneWeakEntriesPreservingCrosses(
  grid: string[][],
  minLen: number,
  minEntries: number
): { grid: string[][]; derived: Omit<Entry, "clue">[] } | null {
  let working = grid.map((row) => row.slice());

  for (let pass = 0; pass < 8; pass++) {
    const derived = deriveEntriesFromGrid(working, minLen);
    if (derived.length < minEntries) return null;
    const stats = entryCrossingStats(working, derived, minLen);
    const checkedCellsForEntry = (entry: Omit<Entry, "clue">) => {
      let checked = 0;
      for (let i = 0; i < entry.answer.length; i++) {
        const r = entry.direction === "down" ? entry.row + i : entry.row;
        const c = entry.direction === "across" ? entry.col + i : entry.col;
        const across = derived.some(
          (other) =>
            other.direction === "across" &&
            other.row === r &&
            c >= other.col &&
            c < other.col + other.answer.length
        );
        const down = derived.some(
          (other) =>
            other.direction === "down" &&
            other.col === c &&
            r >= other.row &&
            r < other.row + other.answer.length
        );
        if (across && down) checked++;
      }
      return checked;
    };
    const seenAnswers = new Set<string>();
    const duplicateEntries = derived.filter((entry) => {
      if (seenAnswers.has(entry.answer)) return true;
      seenAnswers.add(entry.answer);
      return false;
    });
    const weakEntries = derived.filter(
      (entry) => checkedCellsForEntry(entry) < minCrossingsPerEntryForPublish(grid.length)
    );
    const targets = Array.from(new Set([...weakEntries, ...duplicateEntries]));
    if (targets.length === 0 && stats.weakEntries.length === 0) {
      return { grid: working, derived };
    }

    let best:
      | {
          grid: string[][];
          derived: Omit<Entry, "clue">[];
          weakCount: number;
        }
      | null = null;

    for (const weakEntry of targets) {
      const next = working.map((row) => row.slice());
      for (let i = 0; i < weakEntry.answer.length; i++) {
        const r = weakEntry.direction === "down" ? weakEntry.row + i : weakEntry.row;
        const c = weakEntry.direction === "across" ? weakEntry.col + i : weakEntry.col;
        const sharedByOther = derived.some((entry) => {
          if (entry === weakEntry) return false;
          for (let j = 0; j < entry.answer.length; j++) {
            const otherR = entry.direction === "down" ? entry.row + j : entry.row;
            const otherC = entry.direction === "across" ? entry.col + j : entry.col;
            if (otherR === r && otherC === c) return true;
          }
          return false;
        });
        if (!sharedByOther) next[r][c] = "#";
      }

      const cleaned = blockShortRunsOnly(next, minLen);
      if (hasShortLetterRuns(cleaned, minLen)) continue;
      const nextDerived = deriveEntriesFromGrid(cleaned, minLen);
      if (nextDerived.length < minEntries) continue;
      const nextStats = entryCrossingStats(cleaned, nextDerived, minLen);
      const nextDuplicateCount =
        nextDerived.length - new Set(nextDerived.map((entry) => entry.answer)).size;
      const currentDuplicateCount =
        derived.length - new Set(derived.map((entry) => entry.answer)).size;
      const currentProblemCount = stats.weakEntries.length + currentDuplicateCount;
      const nextProblemCount = nextStats.weakEntries.length + nextDuplicateCount;
      if (nextProblemCount >= currentProblemCount) continue;

      if (
        !best ||
        nextProblemCount < best.weakCount ||
        (nextProblemCount === best.weakCount &&
          nextDerived.length > best.derived.length)
      ) {
        best = {
          grid: cleaned,
          derived: nextDerived,
          weakCount: nextProblemCount,
        };
      }
    }

    if (!best) return null;
    working = best.grid;
  }

  const derived = deriveEntriesFromGrid(working, minLen);
  if (derived.length < minEntries) return null;
  if (entryCrossingStats(working, derived, minLen).weakEntries.length > 0) return null;
  return { grid: working, derived };
}

function specificThematicFallbackClue(theme: string, answer: string, language: "es" | "en"): string | null {
  const a = normalizeAnswer(answer);
  const t = theme.trim().toLowerCase();
  const themeNorm = normalizeAnswer(theme);

  if (!ENABLE_LEGACY_TOPIC_SUPPORT && themeNorm !== "BARILOCHE" && themeNorm !== "MEGADETH" && themeNorm !== "METALLICA") {
    return null;
  }

  if (language === "en" && t === "california") {
    const exact: Record<string, string> = {
      BERKELEY: "Bay Area city known for its major university",
      BURLINGAME: "Bay Area city near San Francisco International Airport",
      CARMEL: "Scenic California town on the Monterey Peninsula",
      FRESNO: "Central California city in the San Joaquin Valley",
      GOLD: "Metal tied to California's 1849 gold rush",
      HUMBOLDT: "Northern California county associated with giant redwoods",
      IRVINE: "Master-planned city in Orange County, California",
      LONGBEACH: "Southern California port city on the Pacific coast",
      LOSANGELES: "Largest city in California",
      MALIBU: "Famous beach city in California known for surf culture",
      MENDOCINO: "Northern California region known for coastline and wine",
      MERCED: "Central California city in the San Joaquin Valley",
      MODESTO: "Central California city in the San Joaquin Valley",
      MONTEREY: "California coastal city known for its historic bay",
      NAPA: "Famous wine-producing region in California",
      OAKLAND: "Bay Area city east of San Francisco",
      OJAI: "California town known for its valley setting",
      ORANGE: "County in Southern California",
      PALOALTO: "Silicon Valley city in the San Francisco Bay Area",
      REDDING: "Northern California city near the Sacramento River",
      REDWOOD: "Tree strongly associated with Northern California",
      RIVERSIDE: "Southern California city in the Inland Empire",
      SACRAMENTO: "Capital city of California",
      SANDIEGO: "Major city in Southern California near the Mexican border",
      SANJOSE: "Large Silicon Valley city in Northern California",
      SANTAANA: "Orange County city in Southern California",
      SANTACLARA: "Silicon Valley city and county name in California",
      SANTACRUZ: "California coastal city and county on Monterey Bay",
      SANTAROSA: "Sonoma County city in Northern California",
      SEQUOIA: "National park and giant tree name associated with California",
      SILICON: "Word strongly associated with Silicon Valley",
      SONOMA: "Another prominent wine region in California",
      VENTURA: "California coastal city and county name",
      VISTA: "City in San Diego County, California",
      YOSEMITE: "National park in California known for granite cliffs",
    };

    return exact[a] ?? null;
  }

  if ((language === "en" && t === "argentina") || (language === "es" && t === "argentina")) {
    const exactEn: Record<string, string> = {
      ALFAJOR: "Sweet sandwich cookie popular in Argentina",
      ASADO: "Argentine barbecue tradition centered on grilled meat",
      BARILOCHE: "Patagonian city in Argentina known for lakes and chocolate",
      BIFE: "Spanish word often used for a steak cut in Argentina",
      CABA: "Abbreviation widely used for Buenos Aires city proper",
      EVITAPERON: "First Lady of Argentina often referred to as Evita",
      LITORAL: "Argentine region around the Parana and Uruguay rivers",
      MALBEC: "Red grape variety strongly associated with Argentina",
      MATE: "Traditional herbal drink shared from a gourd",
      MILANESA: "Breaded meat cutlet popular across Argentina",
      PAMPAS: "Vast grassland region strongly associated with Argentina",
      PROVOLETA: "Grilled provoleta cheese served at an Argentine asado",
      TIGRE: "Buenos Aires area town known for its delta waterways",
      VIEDMA: "Capital city of Rio Negro province in Argentina",
      BUENOSAIRES: "Capital city of Argentina",
      CORDOBA: "Major city and province in central Argentina",
      ROSARIO: "Major city in Santa Fe province, Argentina",
      MENDOZA: "Argentine province famous for wine production",
      IGUAZU: "Falls on the border of Argentina and Brazil",
      PATAGONIA: "Southern region shared by Argentina and Chile",
      TANGO: "Music and dance style strongly associated with Argentina",
    };

    const exactEs: Record<string, string> = {
      ALFAJOR: "Dulce relleno muy popular en Argentina",
      ASADO: "Parrillada tradicional muy asociada con Argentina",
      BARILOCHE: "Ciudad patagonica argentina famosa por lagos y montanas",
      BIFE: "Corte de carne muy usado en la cocina argentina",
      CABA: "Sigla muy usada para la Ciudad Autonoma de Buenos Aires",
      EVITAPERON: "Primera dama argentina conocida popularmente como Evita",
      LITORAL: "Region argentina asociada a los rios Parana y Uruguay",
      MALBEC: "Variedad de uva tinta muy asociada con Argentina",
      MATE: "Infusion tradicional compartida en ronda",
      MILANESA: "Filete empanado muy popular en Argentina",
      PAMPAS: "Gran llanura muy asociada con Argentina",
      PROVOLETA: "Queso a la parrilla tipico del asado argentino",
      TIGRE: "Localidad bonaerense muy asociada con el delta del Parana",
      VIEDMA: "Capital de la provincia argentina de Rio Negro",
      BUENOSAIRES: "Capital de Argentina",
      CORDOBA: "Importante ciudad y provincia del centro argentino",
      ROSARIO: "Importante ciudad argentina de la provincia de Santa Fe",
      MENDOZA: "Provincia argentina muy asociada con el vino",
      IGUAZU: "Cataratas en la frontera entre Argentina y Brasil",
      PATAGONIA: "Region del sur compartida por Argentina y Chile",
      TANGO: "Genero musical y baile muy asociado con Argentina",
    };

    return language === "en" ? (exactEn[a] ?? null) : (exactEs[a] ?? null);
  }

  if ((language === "en" && t === "bariloche") || (language === "es" && t === "bariloche")) {
    const exactEn: Record<string, string> = {
      ANDES: "Mountain range beside Bariloche",
      ARRAYANES: "National park near Bariloche known for myrtle trees",
      AVELLANO: "Tree name seen in Patagonian-Andean flora references",
      BUSTILLO: "Avenue running along Nahuel Huapi in Bariloche",
      CAMPANARIO: "Viewpoint hill near Bariloche",
      CATEDRAL: "Major ski area near Bariloche",
      CERVEZA: "Craft drink strongly associated with Bariloche",
      CHOCOLATE: "Sweet specialty sold throughout Bariloche",
      CIVICO: "Bariloche square: Centro ___",
      COLONIA: "First word of the Swiss-style village nearby",
      CURANTO: "Traditional dish associated with Colonia Suiza",
      ESQUI: "Winter sport practiced at Cerro Catedral",
      FREY: "Mountain refuge and area near Bariloche",
      GUTIERREZ: "Lake south of Bariloche",
      HUAPI: "Second word of Bariloche's main lake",
      LAGO: "Body of water central to Bariloche's landscape",
      LAGOMORENO: "Lake west of Bariloche",
      LAGOS: "Bariloche is famous for these bodies of water",
      LIMAY: "River that begins at Nahuel Huapi",
      LLAOLLAO: "Iconic hotel and area near Bariloche",
      LOPEZ: "Hill and refuge name near Bariloche",
      MASCARDI: "Lake in Nahuel Huapi National Park",
      MELIPAL: "Bariloche neighborhood and beach name",
      MORENO: "Lake west of Bariloche",
      NAHUEL: "First word in Bariloche's main lake",
      NIEVE: "Winter feature at Bariloche ski areas",
      NIRE: "Native Patagonian tree found around Bariloche",
      OTTO: "Hill reached by cable car in Bariloche",
      PATAGONIA: "Southern region where Bariloche is located",
      PIONEROS: "Early settlers remembered in Bariloche place names",
      RASTREO: "Tracking activity used on Bariloche trails and outings",
      RIONEGRO: "Argentine province containing Bariloche",
      RUTA: "Roadway term for trips around Bariloche",
      RUTA40: "Iconic Argentine highway used to reach Bariloche",
      RUTAS: "Roads used to tour the Bariloche area",
      SUIZA: "Second word of the historic village nearby",
      TRONADOR: "Extinct volcano near Bariloche",
    };

    const exactEs: Record<string, string> = {
      ANDES: "Cordillera junto a Bariloche",
      ARRAYANES: "Parque nacional cercano famoso por sus arboles",
      AVELLANO: "Arbol mencionado en referencias de flora andino-patagonica",
      BUSTILLO: "Avenida que bordea el Nahuel Huapi",
      CAMPANARIO: "Cerro mirador cercano a Bariloche",
      CATEDRAL: "Centro de esqui emblematico de Bariloche",
      CERVEZA: "Bebida artesanal muy asociada con Bariloche",
      CHICO: "Segunda palabra de Circuito Chico",
      CHOCOLATE: "Dulce tipico de Bariloche",
      CIVICO: "Centro ___, postal clasica de Bariloche",
      COLONIA: "Primera palabra del poblado suizo cercano",
      CURANTO: "Comida tradicional de Colonia Suiza",
      ESQUI: "Deporte invernal practicado en Cerro Catedral",
      FREY: "Topografo suizo-argentino ligado al Nahuel Huapi",
      GUTIERREZ: "Lago al sur de Bariloche",
      HUAPI: "Segunda palabra del lago principal de Bariloche",
      LAGO: "Cuerpo de agua clave del paisaje barilochense",
      LAGOMORENO: "Lago al oeste de Bariloche",
      LAGOS: "Bariloche es famosa por estos cuerpos de agua",
      LIMAY: "Rio que nace en el Nahuel Huapi",
      LLAOLLAO: "Hotel y zona iconica de Bariloche",
      LOPEZ: "Cerro y refugio cercano a Bariloche",
      MASCARDI: "Lago del Parque Nacional Nahuel Huapi",
      MELIPAL: "Barrio y playa de Bariloche",
      MORENO: "Lago al oeste de Bariloche",
      NAHUEL: "Primera palabra del lago principal de Bariloche",
      NIEVE: "Elemento invernal de los cerros barilochenses",
      NIRE: "Arbol nativo patagonico presente en la zona",
      OTTO: "Cerro con teleferico en Bariloche",
      PATAGONIA: "Region argentina donde esta Bariloche",
      PIONEROS: "Primeros pobladores recordados en la historia local",
      RASTREO: "Seguimiento de huellas en senderos y salidas de montana",
      RIONEGRO: "Provincia argentina donde esta Bariloche",
      RUTA: "Camino usado para recorrer la zona de Bariloche",
      RUTA40: "Ruta nacional emblematica para llegar a Bariloche",
      RUTAS: "Caminos usados para recorrer la zona",
      SUIZA: "Segunda palabra del poblado historico cercano",
      TRONADOR: "Volcan extinto cercano a Bariloche",
    };

    return language === "en" ? (exactEn[a] ?? null) : (exactEs[a] ?? null);
  }

  if ((language === "en" && t === "wine") || (language === "es" && t === "vino")) {
    const exactEn: Record<string, string> = {
      ALBARINO: "White grape variety popular in Spain",
      BLANCOS: "Spanish term for white wines",
      BODEGA: "Spanish winery or wine cellar",
      BODEGAS: "Spanish wineries or wine cellars",
      BRUT: "Dry sparkling-wine style with very little sugar",
      CABERNET: "Grape name seen in wines like Cabernet Sauvignon",
      CAVA: "Spanish sparkling wine made by the traditional method",
      CATA: "Spanish word for a wine tasting",
      COPA: "Stemmed glass commonly used to serve wine",
      FRESCO: "Tasting descriptor for a lively, crisp wine",
      GARNACHA: "Spanish name for the Grenache grape",
      JEREZ: "Spanish wine style and region known for sherry",
      MALBEC: "Red grape variety strongly associated with Argentina",
      RACIMO: "Cluster of grapes on the vine",
      SALUD: "Spanish toast often said before drinking wine",
      SANGRIA: "Wine punch commonly served chilled in Spain",
      TREBBIANO: "Italian white grape variety used in many wines",
      SANGIOVESE: "Italian red grape variety used in many Tuscan wines",
      SUELO: "Part of the terroir that influences the vine",
      TANNAT: "Red grape variety associated with Uruguay",
      TANNICO: "Italian word meaning tannic",
      TEMPRANILLO: "Spanish red grape variety used in wines like Rioja",
      TINTA: "Spanish word for a red-wine grape",
      VINO: "Spanish word for wine",
      VINOS: "Spanish word for wines",
      VINICULTOR: "Spanish term for a winegrower or winemaker",
      VINICOLA: "Related to wine production",
      VITIS: "Botanical genus of grapevines",
      DULCE: "Spanish descriptor for a sweet wine",
      NERO: "Italian word often seen in grape names",
      SIRAH: "Alternative spelling of the Syrah grape",
    };

    const exactEs: Record<string, string> = {
      ALBARINO: "Variedad de uva blanca muy usada en España",
      BLANCOS: "Nombre que reciben los vinos blancos",
      BODEGA: "Lugar donde se produce o guarda vino",
      BODEGAS: "Lugares donde se produce o guarda vino",
      CATA: "Degustación técnica de vino",
      GARNACHA: "Variedad de uva tinta muy extendida en España",
      TANNAT: "Variedad de uva tinta asociada con Uruguay",
      TANNICO: "Término italiano para algo con taninos marcados",
      TINTA: "Palabra usada para una uva o vino rojo",
      VINO: "Bebida obtenida de la fermentación de la uva",
      VINICOLA: "Relacionado con la producción de vino",
      VITIS: "Género botánico de la vid",
      DULCE: "Descriptor para un vino con azúcar perceptible",
      NERO: "Palabra italiana presente en nombres de uvas",
      SIRAH: "Variante gráfica del nombre de la uva Syrah",
    };

    const enrichedExactEs: Record<string, string> = {
      ...exactEs,
      BRUT: "Estilo de espumoso muy seco y con poco azucar",
      CABERNET: "Nombre de uva presente en vinos como Cabernet Sauvignon",
      CAVA: "Espumoso espanol elaborado por metodo tradicional",
      COPA: "Vaso con pie usado para servir vino",
      FRESCO: "Descriptor de cata para un vino vivo y ligero",
      MALBEC: "Variedad de uva tinta muy asociada con Argentina",
      JEREZ: "Vino y zona espanola conocidos por el sherry",
      RACIMO: "Conjunto de uvas que cuelga de la vid",
      SALUD: "Brindis habitual antes de beber vino",
      SANGRIA: "Bebida de vino con fruta muy popular en Espana",
      TREBBIANO: "Variedad italiana de uva blanca usada en muchos vinos",
      SANGIOVESE: "Variedad de uva tinta muy usada en vinos de la Toscana",
      SUELO: "Parte del terruno que influye en la vid",
      TEMPRANILLO: "Variedad de uva tinta muy usada en vinos de Rioja",
      VINOS: "Plural de la bebida fermentada hecha con uvas",
      VINICULTOR: "Persona dedicada al cultivo de la vid o al vino",
    };

    return language === "en" ? (exactEn[a] ?? null) : (enrichedExactEs[a] ?? null);
  }

  if ((language === "en" && t === "mendoza") || (language === "es" && t === "mendoza")) {
    const exactEn: Record<string, string> = {
      BRUT: "Dry sparkling wine style",
      CAVA: "Spanish sparkling wine made by traditional method",
      CATA: "Wine tasting term",
      MENDOZA: "Argentine province famous for wine production",
      MALBEC: "Red grape variety strongly associated with Mendoza",
      MERLOT: "Red grape variety used in Mendoza wines",
      CABERNET: "Grape name often seen in Mendoza wine labels",
      ROBLE: "Oak wood used in wine aging",
      BARRIL: "Container used to store or age wine",
      UVAS: "Fruit used to make wine",
      MOSTO: "Fresh grape juice before fermentation",
      BLANCOS: "Wines made from white grapes",
      TINTOS: "Wines made from red grapes",
      ROSADOS: "Wines with a pink hue",
      CEPAS: "Vine plants grown for grapes",
      VINO: "Alcoholic drink made from fermented grapes",
      ZONA: "Wine-producing area or region",
      CUPAGE: "Blend or coupage term used in winemaking",
      TERROIR: "Wine term about soil, climate, and place",
      TEMPRANILLO: "Spanish grape variety also found in Mendoza wines",
      VINICOLA: "Related to wine production",
      NORTON: "Mendoza winery name seen on Argentine wine labels",
      PULENTA: "Mendoza wine label associated with premium Argentine wines",
      ACONCAGUA: "Highest mountain in the Americas, located in Mendoza province",
      ANDES: "Mountain range running along western Mendoza",
      GUAYMALLEN: "Department of Greater Mendoza in western Argentina",
      GODOYCRUZ: "City and department within Greater Mendoza",
      LUJAN: "Mendoza department known for vineyards and wineries",
      MAIPU: "Mendoza department famous for wineries",
      POTRERILLOS: "Mountain and reservoir area near Mendoza city",
      RACIMO: "Cluster of grapes on the vine",
      SANRAFAEL: "Important city in southern Mendoza province",
      DULCE: "Descriptor for a wine with perceptible sweetness",
      TINTA: "Spanish word used for a red-wine grape",
      TUNUYAN: "Town and department in the Uco Valley of Mendoza",
      UCO: "Valley region of Mendoza known for vineyards",
      USPALLATA: "Mendoza mountain town on the route to the Andes",
      BODEGA: "Winery or wine cellar",
      BODEGAS: "Wineries or wine cellars",
      VINOS: "Spanish word for wines",
      BLANCO: "Spanish term for a white wine style",
    };

    const exactEs: Record<string, string> = {
      BRUT: "Tipo de vino espumoso seco",
      CAVA: "Vino espumoso espanol elaborado por metodo tradicional",
      CATA: "Termino de degustacion de vino",
      MENDOZA: "Provincia argentina famosa por su produccion de vino",
      MALBEC: "Variedad de uva tinta muy asociada con Mendoza",
      MERLOT: "Variedad de uva tinta presente en vinos mendocinos",
      CABERNET: "Nombre de uva presente en muchos vinos mendocinos",
      ROBLE: "Madera usada para anejamiento o crianza del vino",
      BARRIL: "Recipiente usado para almacenar o criar vino",
      UVAS: "Frutos utilizados para hacer vino",
      MOSTO: "Jugo de uva antes de fermentar",
      BLANCOS: "Vinos elaborados con uvas blancas",
      TINTOS: "Vinos elaborados con uvas tintas",
      ROSADOS: "Tipo de vino con color rosa",
      CEPAS: "Plantas de vid para vino",
      VINO: "Bebida alcoholica de uvas fermentadas",
      ZONA: "Region vitivinicola de Mendoza",
      CUPAGE: "Mezcla de variedades usada en enologia",
      TERROIR: "Concepto vitivinicola sobre suelo, clima y origen",
      TEMPRANILLO: "Variedad de uva tinta usada tambien en vinos mendocinos",
      VINICOLA: "Relacionado con la produccion de vino",
      NORTON: "Nombre de una bodega muy conocida de Mendoza",
      PULENTA: "Nombre de una etiqueta o bodega asociada con Mendoza",
      ACONCAGUA: "Cerro mas alto de America, ubicado en Mendoza",
      ANDES: "Cordillera que recorre el oeste de Mendoza",
      GUAYMALLEN: "Departamento del Gran Mendoza en el oeste argentino",
      GODOYCRUZ: "Ciudad y departamento del Gran Mendoza",
      LUJAN: "Departamento mendocino conocido por vinedos y bodegas",
      MAIPU: "Departamento mendocino famoso por sus bodegas",
      POTRERILLOS: "Zona de montana y embalse cerca de la capital mendocina",
      RACIMO: "Conjunto de uvas que cuelga de la vid",
      SANRAFAEL: "Importante ciudad del sur de la provincia de Mendoza",
      DULCE: "Descriptor para un vino con azucar perceptible",
      TINTA: "Palabra usada para una uva o vino rojo",
      TUNUYAN: "Localidad y departamento del Valle de Uco en Mendoza",
      UCO: "Valle mendocino muy asociado con vinedos y bodegas",
      USPALLATA: "Pueblo mendocino camino a la cordillera de los Andes",
      BODEGA: "Lugar donde se produce o guarda vino",
      BODEGAS: "Lugares donde se produce o guarda vino",
      VINOS: "Plural de la bebida fermentada hecha con uvas",
      BLANCO: "Termino usado para vinos blancos",
    };

    return language === "en" ? (exactEn[a] ?? null) : (exactEs[a] ?? null);
  }

  if ((language === "en" && t === "megadeth") || (language === "es" && t === "megadeth")) {
    const exactEn: Record<string, string> = {
      MUSTAINE: "Surname of Dave, Megadeth founder and frontman",
      ELLEFSON: "David ___, original bassist of Megadeth",
      RATTLEHEAD: "Mascot character associated with Megadeth",
      HOLYWARS: "Megadeth song title using the plural word 'Wars'",
      LUCRETIA: "One-word Megadeth song title from Rust in Peace",
      WAKEUPDEAD: "Megadeth song title written as three words",
      MARYJANE: "Megadeth song title using a woman's name",
      MECHANIX: "Early Megadeth song title with an unusual spelling",
      FIVEMAGICS: "Megadeth song title using the number five",
      HOOKINMOUTH: "Megadeth song title ending with 'Mouth'",
      CONJURING: "Megadeth song title beginning with 'The'",
      RECKONING: "Final word in the Megadeth title 'Day of ___'",
      SOULS: "Final word in the Megadeth title 'Tornado of ___'",
      TORNADO: "First word in the Megadeth title '___ of Souls'",
      SWEATING: "First word in the Megadeth title '___ Bullets'",
      KILLING: "First word in the Megadeth title '___ Is My Business...'",
      POLARIS: "Final word in the Megadeth title 'Rust in Peace... ___'",
      RUSTINPEACE: "Classic 1990 Megadeth album title",
      PEACESELLS: "Megadeth album title beginning with 'Peace'",
      YOUTHANASIA: "1994 Megadeth album title",
      DYSTOPIA: "2016 Megadeth album title",
      FRIEDMAN: "Surname of Marty, guitarist on major Megadeth albums",
      MARTY: "First name of guitarist ___ Friedman in Megadeth",
      RATTLE: "Part of mascot name Vic ___head",
      SELLS: "Second word in the Megadeth album title 'Peace ___...'",
      MENZA: "Surname of Nick, drummer on major Megadeth albums",
      NICKMENZA: "Full normalized name of a drummer on major Megadeth albums",
      NICK: "First name of drummer Menza from Megadeth",
      POLAND: "Surname of Chris, guitarist on early Megadeth recordings",
      DROVER: "Surname of Shawn, drummer associated with Megadeth",
      DAVE: "First name of Megadeth founder Mustaine",
      VIC: "First name of mascot ___ Rattlehead",
      LOUREIRO: "Surname of Kiko, guitarist associated with Megadeth",
      BRODERICK: "Surname of Chris, guitarist associated with Megadeth",
      KIKO: "First name of guitarist Loureiro from Megadeth",
      RISK: "1999 Megadeth album title",
      ENDGAME: "2009 Megadeth album title",
      THIRTEEN: "Megadeth studio album title",
      COUNTDOWN: "First word of the Megadeth album title ending in 'to Extinction'",
      CRYPTIC: "First word of the Megadeth album '___ Writings'",
    };

    const exactEs: Record<string, string> = {
      MUSTAINE: "Apellido de Dave, fundador y lider de Megadeth",
      ELLEFSON: "Apellido de David, bajista original de Megadeth",
      RATTLEHEAD: "Mascota o personaje asociado con Megadeth",
      HOLYWARS: "Titulo de cancion de Megadeth con la palabra plural 'Wars'",
      LUCRETIA: "Titulo de una cancion de Megadeth en Rust in Peace",
      WAKEUPDEAD: "Titulo de cancion de Megadeth escrito como tres palabras",
      MARYJANE: "Titulo de cancion de Megadeth con nombre femenino",
      MECHANIX: "Titulo temprano de Megadeth con grafia inusual",
      FIVEMAGICS: "Titulo de cancion de Megadeth con el numero cinco",
      HOOKINMOUTH: "Titulo de cancion de Megadeth que termina con 'Mouth'",
      CONJURING: "Titulo de cancion de Megadeth que empieza con 'The'",
      RECKONING: "Ultima palabra del titulo de Megadeth 'Day of ___'",
      SOULS: "Ultima palabra del titulo de Megadeth 'Tornado of ___'",
      TORNADO: "Primera palabra del titulo de Megadeth '___ of Souls'",
      SWEATING: "Primera palabra del titulo de Megadeth '___ Bullets'",
      KILLING: "Primera palabra del titulo de Megadeth '___ Is My Business...'",
      POLARIS: "Ultima palabra del titulo de Megadeth 'Rust in Peace... ___'",
      RUSTINPEACE: "Album clasico de Megadeth editado en 1990",
      PEACESELLS: "Album de Megadeth cuyo titulo comienza con 'Peace'",
      YOUTHANASIA: "Album de Megadeth publicado en 1994",
      DYSTOPIA: "Album de Megadeth publicado en 2016",
      FRIEDMAN: "Apellido de Marty, guitarrista asociado con discos de Megadeth",
      MARTY: "Nombre de pila del guitarrista Friedman en Megadeth",
      RATTLE: "Parte del nombre de la mascota Vic ___head",
      SELLS: "Segunda palabra del album de Megadeth 'Peace ___...'",
      MENZA: "Apellido de Nick, baterista asociado con discos de Megadeth",
      NICKMENZA: "Nombre completo normalizado de un baterista asociado con discos de Megadeth",
      NICK: "Nombre de pila del baterista Menza de Megadeth",
      POLAND: "Apellido de Chris, guitarrista asociado con grabaciones tempranas de Megadeth",
      DROVER: "Apellido de Shawn, baterista asociado con Megadeth",
      DAVE: "Nombre de pila de Mustaine, fundador de Megadeth",
      VIC: "Nombre de la mascota ___ Rattlehead",
      LOUREIRO: "Apellido de Kiko, guitarrista asociado con Megadeth",
      BRODERICK: "Apellido de Chris, guitarrista asociado con Megadeth",
      KIKO: "Nombre del guitarrista Loureiro en Megadeth",
      RISK: "Titulo de un album de Megadeth de 1999",
      ENDGAME: "Album de Megadeth publicado en 2009",
      THIRTEEN: "Titulo de album de estudio de Megadeth",
      COUNTDOWN: "Primera palabra del album de Megadeth '___ to Extinction'",
      CRYPTIC: "Primera palabra del album de Megadeth '___ Writings'",
    };

    return language === "en" ? (exactEn[a] ?? null) : (exactEs[a] ?? null);
  }

  if ((language === "en" && t === "metallica") || (language === "es" && t === "metallica")) {
    const exactEn: Record<string, string> = {
      HETFIELD: "Surname of James, Metallica cofounder and vocalist",
      ULRICH: "Surname of Lars, Metallica cofounder and drummer",
      HAMMETT: "Surname of Kirk, longtime Metallica guitarist",
      TRUJILLO: "Surname of Robert, bassist of Metallica since 2003",
      BURTON: "Surname of Cliff, early bassist of Metallica",
      JASON: "First name of Newsted, former Metallica bassist",
      NEWSTED: "Surname of Jason, former bassist of Metallica",
      LARS: "First name of Metallica drummer Ulrich",
      JAMES: "First name of Metallica singer Hetfield",
      KIRK: "First name of Metallica guitarist Hammett",
      ROBERT: "First name of Metallica bassist Trujillo",
      CLIFF: "First name of early Metallica bassist Burton",
      PUPPETS: "Second word in Metallica's album 'Master of ___'",
      SANDMAN: "Second word in Metallica's song 'Enter ___'",
      LIGHTNING: "Second word in the Metallica album 'Ride the ___'",
      JUSTICE: "Word after '...And' in a Metallica album title",
      BLACK: "Informal name of Metallica's self-titled 1991 album",
      BATTERY: "Opening track of Metallica's album 'Master of Puppets'",
      ORION: "Instrumental track on 'Master of Puppets'",
      ONE: "Metallica song from the album '...And Justice for All'",
      FUEL: "Metallica single with the line 'Gimme ___, gimme fire'",
      CREEPING: "First word of Metallica's song '___ Death'",
      DEATH: "Second word of Metallica's song 'Creeping ___'",
      UNFORGIVEN: "Metallica song title beginning with 'The'",
      KILLEMALL: "Debut studio album by Metallica",
      LOAD: "Metallica studio album released in 1996",
      RELOAD: "Metallica studio album released after 'Load'",
      STANGER: "Metallica album whose title begins with 'St.'",
      HARDWIRED: "Metallica album title beginning '___... to Self-Destruct'",
      DESTRUCT: "Final word of Metallica's album 'Hardwired... to Self-___'",
      AJFA: "Short form often used for '...And Justice for All'",
    };

    const exactEs: Record<string, string> = {
      HETFIELD: "Apellido de James, fundador y vocalista de Metallica",
      ULRICH: "Apellido de Lars, fundador y baterista de Metallica",
      HAMMETT: "Apellido de Kirk, guitarrista historico de Metallica",
      TRUJILLO: "Apellido de Robert, bajista de Metallica desde 2003",
      BURTON: "Apellido de Cliff, bajista clasico de los primeros anos de Metallica",
      JASON: "Nombre de pila de Newsted, exbajista de Metallica",
      NEWSTED: "Apellido de Jason, exbajista de Metallica",
      LARS: "Nombre de pila del baterista Ulrich en Metallica",
      JAMES: "Nombre de pila de Hetfield, cantante de Metallica",
      KIRK: "Nombre del guitarrista Hammett en Metallica",
      ROBERT: "Nombre de pila del bajista Trujillo en Metallica",
      CLIFF: "Nombre del bajista Burton en los primeros discos de Metallica",
      PUPPETS: "Segunda palabra del album de Metallica 'Master of ___'",
      SANDMAN: "Segunda palabra de la cancion 'Enter ___' de Metallica",
      LIGHTNING: "Segunda palabra del album 'Ride the ___' de Metallica",
      JUSTICE: "Palabra que sigue a '...And' en un album de Metallica",
      BLACK: "Nombre informal del disco homonimo de Metallica de 1991",
      BATTERY: "Tema que abre el album 'Master of Puppets'",
      ORION: "Tema instrumental del album 'Master of Puppets'",
      ONE: "Cancion de Metallica del album '...And Justice for All'",
      FUEL: "Sencillo de Metallica con el estribillo 'Gimme ___'",
      CREEPING: "Primera palabra de la cancion '___ Death' de Metallica",
      DEATH: "Segunda palabra de la cancion 'Creeping ___' de Metallica",
      UNFORGIVEN: "Cancion de Metallica cuyo titulo empieza con 'The'",
      KILLEMALL: "Album debut de estudio de Metallica",
      LOAD: "Album de Metallica publicado en 1996",
      RELOAD: "Album de Metallica publicado despues de 'Load'",
      STANGER: "Album de Metallica cuyo titulo empieza con 'St.'",
      HARDWIRED: "Album de Metallica titulado '___... to Self-Destruct'",
      DESTRUCT: "Ultima palabra del album 'Hardwired... to Self-___'",
      AJFA: "Sigla muy usada para '...And Justice for All'",
    };

    return language === "en" ? (exactEn[a] ?? null) : (exactEs[a] ?? null);
  }

  if ((language === "en" && t === "japan") || (language === "es" && t === "japon")) {
    const exactEn: Record<string, string> = {
      ANIME: "Japanese animation style popular worldwide",
      BONSAI: "Miniature tree art strongly associated with Japan",
      CABUKI: "Traditional Japanese theater style",
      FUGU: "Pufferfish delicacy served in Japan",
      GEISHA: "Traditional Japanese entertainer trained in arts and etiquette",
      HAIKU: "Short poetic form associated with Japan",
      JAPAN: "Island nation in East Asia",
      KABUKI: "Traditional Japanese theater style",
      KAWA: "Japanese word often translated as river",
      KIMONO: "Traditional Japanese robe",
      KITSUNE: "Fox figure from Japanese folklore",
      KONBU: "Edible kelp used in Japanese cuisine",
      KYOTO: "Historic Japanese city associated with temples and shrines",
      MISO: "Fermented soybean paste used in Japanese cooking",
      NIKKO: "Japanese city known for historic shrines and temples",
      NINJA: "Figure from Japanese martial tradition and folklore",
      NORI: "Edible seaweed often used with sushi",
      OSAKA: "Major Japanese city known for food culture",
      RAMEN: "Japanese noodle soup dish",
      RICE: "Staple grain central to Japanese cuisine",
      SAKE: "Traditional Japanese rice drink",
      SAMURAI: "Warrior class strongly associated with Japanese history",
      SHINTO: "Native religious tradition of Japan",
      SHOGUN: "Military ruler title in premodern Japan",
      SUMO: "Wrestling sport strongly associated with Japan",
      SUSHI: "Japanese dish of vinegared rice with varied toppings",
      TEMPURA: "Japanese dish of battered and fried seafood or vegetables",
      TOKYO: "Capital city of Japan",
      UDON: "Thick Japanese wheat noodle",
      YAKITORI: "Japanese skewered grilled chicken dish",
      YOKAI: "Supernatural being from Japanese folklore",
    };

    const exactEs: Record<string, string> = {
      ANIME: "Animacion japonesa popular en todo el mundo",
      BONSAI: "Arte japones de cultivar arboles en miniatura",
      CABUKI: "Forma tradicional de teatro japones",
      FUGU: "Pez globo servido como delicadeza en Japon",
      GEISHA: "Artista tradicional japonesa formada en musica y etiqueta",
      HAIKU: "Breve forma poetica asociada con Japon",
      JAPON: "Pais insular del este de Asia",
      KABUKI: "Forma tradicional de teatro japones",
      KAWA: "Palabra japonesa que suele traducirse como rio",
      KIMONO: "Vestimenta tradicional de Japon",
      KITSUNE: "Figura de zorro en el folclore japones",
      KONBU: "Alga comestible muy usada en la cocina japonesa",
      KYOTO: "Ciudad historica japonesa asociada a templos y santuarios",
      MISO: "Pasta fermentada de soja muy usada en Japon",
      NIKKO: "Ciudad japonesa conocida por sus santuarios y templos",
      NINJA: "Figura de la tradicion marcial y el folclore japones",
      NORI: "Alga comestible usada con frecuencia en sushi",
      OSAKA: "Importante ciudad japonesa conocida por su cultura gastronomica",
      RAMEN: "Sopa japonesa de fideos",
      RICE: "Grano basico de la cocina japonesa",
      SAKE: "Bebida japonesa elaborada a partir de arroz",
      SAMURAI: "Clase guerrera asociada con la historia de Japon",
      SHINTO: "Tradicion religiosa originaria de Japon",
      SHOGUN: "Titulo del gobernante militar en el Japon premoderno",
      SUMO: "Deporte de lucha fuertemente asociado con Japon",
      SUSHI: "Plato japones de arroz avinagrado con acompanamientos",
      TEMPURA: "Plato japones de fritura ligera",
      TOKYO: "Capital de Japon",
      UDON: "Fideo grueso de trigo muy usado en Japon",
      YAKITORI: "Brocheta japonesa de pollo a la parrilla",
      YOKAI: "Ser sobrenatural del folclore japones",
      TOKIO: "Capital de Japon",
      TAIKO: "Tambor tradicional japones usado en festivales y espectaculos",
    };

    return language === "en" ? (exactEn[a] ?? null) : (exactEs[a] ?? null);
  }

  return null;
}

function clueFromThemeNote(theme: string, note: string, language: "es" | "en"): string | null {
  const t = theme.trim();
  const themeNorm = normalizeAnswer(theme);
  const lower = note.toLowerCase();

  if (themeNorm === "VINO" || themeNorm === "WINE") {
    if (language === "en") {
      if (/\b(grape|varietal|variety)\b/.test(lower)) return `${t} grape variety`;
      if (/\bwhite wine|white wines\b/.test(lower)) return `${t} term for white wines`;
      if (/\bred wine|red wines\b/.test(lower)) return `${t} term for red wines`;
      if (/\bwinery|cellar|bodega\b/.test(lower)) return `${t} winery or cellar term`;
      if (/\btasting\b/.test(lower)) return `${t} tasting term`;
      if (/\btannic|tannin\b/.test(lower)) return `${t} tasting descriptor`;
      if (/\bbotanical|genus|grapevine\b/.test(lower)) return `${t} botanical term`;
      if (/\bsweet\b/.test(lower)) return `${t} sweetness descriptor`;
    } else {
      if (/\b(grape|varietal|variety|uva)\b/.test(lower)) return `Variedad de uva relacionada con el vino`;
      if (/\bwhite wine|white wines|vino blanco|vinos blancos\b/.test(lower)) return `Término para vinos blancos`;
      if (/\bred wine|red wines|vino tinto|vinos tintos\b/.test(lower)) return `Término para vinos tintos`;
      if (/\bwinery|cellar|bodega\b/.test(lower)) return `Lugar donde se produce o guarda vino`;
      if (/\btasting|cata\b/.test(lower)) return `Término de degustación de vino`;
      if (/\btannic|tannin|tanino\b/.test(lower)) return `Descriptor de cata relacionado con taninos`;
      if (/\bbotanical|genus|grapevine|vid\b/.test(lower)) return `Término botánico relacionado con la vid`;
      if (/\bsweet|dulce\b/.test(lower)) return `Descriptor de dulzor en el vino`;
    }
  }

  if (themeNorm === "ARGENTINA") {
    if (language === "en") {
      if (/\b(city|province|capital)\b/.test(lower)) return `Argentine city or province`;
      if (/\b(region)\b/.test(lower)) return `Argentine region`;
      if (/\b(wine|grape|vineyard)\b/.test(lower)) return `Argentine wine-related term`;
      if (/\b(dish|food|meat|cheese|barbecue|bbq)\b/.test(lower)) return `Argentine dish or food term`;
      if (/\b(drink|infusion|herbal)\b/.test(lower)) return `Argentine drink or infusion`;
      if (/\b(dance|music|genre)\b/.test(lower)) return `Argentine music or dance term`;
      if (/\b(dessert|pastry|cookie|sweet)\b/.test(lower)) return `Argentine sweet or dessert`;
      if (/\b(president|first lady|political figure|leader)\b/.test(lower)) return `Argentine historical figure`;
      if (/\b(falls|waterfall)\b/.test(lower)) return `Argentine natural landmark`;
    } else {
      if (/\b(city|province|capital|ciudad|provincia|capital)\b/.test(lower)) return `Ciudad o provincia de Argentina`;
      if (/\b(region|regi[oó]n)\b/.test(lower)) return `Region de Argentina`;
      if (/\b(wine|grape|vineyard|vino|uva|vinedo|viñedo)\b/.test(lower)) return `Termino argentino relacionado con el vino`;
      if (/\b(dish|food|meat|cheese|barbecue|bbq|plato|comida|carne|queso|parrilla|asado)\b/.test(lower)) return `Plato o comida tipica de Argentina`;
      if (/\b(drink|infusion|herbal|bebida|infusi[oó]n|mate)\b/.test(lower)) return `Bebida o infusion asociada con Argentina`;
      if (/\b(dance|music|genre|baile|musica|m[uú]sica|g[eé]nero)\b/.test(lower)) return `Genero musical o baile asociado con Argentina`;
      if (/\b(dessert|pastry|cookie|sweet|postre|dulce|galleta|alfajor)\b/.test(lower)) return `Dulce o postre tipico de Argentina`;
      if (/\b(president|first lady|political figure|leader|presidenta|figura politica|figura pol[iÃ­]tica|lider|l[iÃ­]der)\b/.test(lower)) return `Figura historica o politica asociada con Argentina`;
      if (/\b(falls|waterfall|cataratas)\b/.test(lower)) return `Paisaje natural asociado con Argentina`;
    }
  }

  if (themeNorm === "JAPON" || themeNorm === "JAPAN") {
    if (language === "en") {
      if (/\b(city|capital|prefecture|temple|shrine)\b/.test(lower)) return `Japanese place or landmark`;
      if (/\b(food|dish|noodle|rice|seaweed|fish|soup|paste|drink)\b/.test(lower)) return `Japanese food or drink term`;
      if (/\b(folklore|myth|spirit|fox|supernatural)\b/.test(lower)) return `Figure from Japanese folklore`;
      if (/\b(theater|poetry|robe|animation|wrestling|warrior|martial)\b/.test(lower)) return `Japanese culture term`;
      if (/\b(religion|religious|shrine)\b/.test(lower)) return `Japanese religious tradition or site`;
    } else {
      if (/\b(city|capital|prefecture|temple|shrine|ciudad|capital|templo|santuario)\b/.test(lower)) {
        return `Lugar o sitio destacado de Japon`;
      }
      if (/\b(food|dish|noodle|rice|seaweed|fish|soup|paste|drink|comida|plato|fideo|arroz|alga|pez|sopa|pasta|bebida)\b/.test(lower)) {
        return `Termino de la cocina japonesa`;
      }
      if (/\b(folklore|myth|spirit|fox|supernatural|folclore|mito|espiritu|zorro|sobrenatural)\b/.test(lower)) {
        return `Figura del folclore japones`;
      }
      if (/\b(theater|poetry|robe|animation|wrestling|warrior|martial|teatro|poesia|vestimenta|animacion|lucha|guerrero|marcial)\b/.test(lower)) {
        return `Termino cultural asociado con Japon`;
      }
      if (/\b(religion|religious|shrine|religion|religioso|santuario)\b/.test(lower)) {
        return `Tradicion religiosa o sitio sagrado de Japon`;
      }
    }
  }

  if (language === "en") {
    if (/\b(grape|varietal|variety)\b/.test(lower)) return `Wine grape variety`;
    if (/\bwhite wine|white wines\b/.test(lower)) return `Term for white wines`;
    if (/\bred wine|red wines\b/.test(lower)) return `Term for red wines`;
    if (/\bwinery|cellar|bodega\b/.test(lower)) return `Wine cellar or winery term`;
    if (/\btasting\b/.test(lower)) return `Wine tasting term`;
    if (/\btannic|tannin\b/.test(lower)) return `Wine tasting descriptor`;
    if (/\bbotanical|genus|grapevine\b/.test(lower)) return `Botanical term related to grapevines`;
    if (/\bsweet\b/.test(lower)) return `Sweetness descriptor in wine`;
    if (/\bblend|coupage|assemblage\b/.test(lower)) return `Wine blend term`;
    if (/\bterroir|soil|climate\b/.test(lower) && /\bwine|vineyard|vine\b/.test(lower)) return `Wine term about soil and climate`;
  } else {
    if (/\b(grape|varietal|variety|uva)\b/.test(lower)) return `Variedad de uva relacionada con el vino`;
    if (/\bwhite wine|white wines|vino blanco|vinos blancos\b/.test(lower)) return `Termino para vinos blancos`;
    if (/\bred wine|red wines|vino tinto|vinos tintos\b/.test(lower)) return `Termino para vinos tintos`;
    if (/\bwinery|cellar|bodega\b/.test(lower)) return `Lugar donde se produce o guarda vino`;
    if (/\btasting|cata\b/.test(lower)) return `Termino de degustacion de vino`;
    if (/\btannic|tannin|tanino\b/.test(lower)) return `Descriptor de cata relacionado con taninos`;
    if (/\bbotanical|genus|grapevine|vid\b/.test(lower)) return `Termino botanico relacionado con la vid`;
    if (/\bsweet|dulce\b/.test(lower)) return `Descriptor de dulzor en el vino`;
    if (/\bblend|coupage|assemblage|cupage\b/.test(lower)) return `Mezcla de variedades usada en el vino`;
    if (/\bterroir|terruno|terruño|soil|climate|clima|suelo\b/.test(lower) && /\bwine|vineyard|vine|vino|vinedo|viñedo|vid\b/.test(lower)) {
      return `Concepto vitivinicola sobre suelo y clima`;
    }
  }

  if (language === "en") {
    if (/\b(song|track|single)\b/.test(lower)) return `${t} song title`;
    if (/\balbum\b/.test(lower)) return `${t} album title`;
    if (/\b(guitarist|guitar player)\b/.test(lower)) return `${t} guitarist`;
    if (/\bdrummer\b/.test(lower)) return `${t} drummer`;
    if (/\bbassist\b/.test(lower)) return `${t} bassist`;
    if (/\bvocalist|singer|frontman\b/.test(lower)) return `${t} vocalist`;
    if (/\bmember\b/.test(lower)) return `${t} band member`;
    if (/\bmascot|character\b/.test(lower)) return `${t} mascot`;
    if (/\bcity\b/.test(lower)) return `${t} city`;
    if (/\bcounty\b/.test(lower)) return `${t} county`;
    if (/\bregion\b/.test(lower)) return `${t} region`;
    if (/\bwine\b/.test(lower)) return `${t} wine-related term`;
    if (/\bpark\b/.test(lower)) return `${t} park or landmark`;
    if (/\btree\b/.test(lower)) return `${t} natural landmark`;
    if (/\bband\b/.test(lower)) return `${t}-related term`;
  } else {
    if (/\b(song|track|single)\b/.test(lower)) return `Canción de ${t}`;
    if (/\balbum\b/.test(lower)) return `Álbum de ${t}`;
    if (/\b(guitarist|guitar player)\b/.test(lower)) return `Guitarrista de ${t}`;
    if (/\bdrummer\b/.test(lower)) return `Baterista de ${t}`;
    if (/\bbassist\b/.test(lower)) return `Bajista de ${t}`;
    if (/\bvocalist|singer|frontman\b/.test(lower)) return `Vocalista de ${t}`;
    if (/\bmember\b/.test(lower)) return `Integrante de ${t}`;
    if (/\bmascot|character\b/.test(lower)) return `Mascota o personaje de ${t}`;
    if (/\bcity\b/.test(lower)) return `Ciudad relacionada con ${t}`;
    if (/\bcounty\b/.test(lower)) return `Condado relacionado con ${t}`;
    if (/\bregion\b/.test(lower)) return `Región relacionada con ${t}`;
    if (/\bwine\b/.test(lower)) return `Término relacionado con ${t}`;
    if (/\bpark\b/.test(lower)) return `Parque o sitio relacionado con ${t}`;
    if (/\btree\b/.test(lower)) return `Sitio natural relacionado con ${t}`;
    if (/\bband\b/.test(lower)) return `Término relacionado con ${t}`;
  }

  return null;
}

function hasStrongThematicClueSupport(opts: {
  theme: string;
  answer: string;
  language: "es" | "en";
  note?: string;
  clue?: string;
}): boolean {
  const { theme, answer, language, note, clue } = opts;
  const hinted = buildThematicClueRequestHint(theme, answer, language, note);
  if (hinted) return true;
  if (
    clue &&
    !isPlaceholderClue(clue, language) &&
    !isBadClue(clue) &&
    note &&
    note.trim().length >= 8 &&
    !noteLooksWeakThematicContext(note, language)
  ) {
    return true;
  }
  return false;
}

function isCoreThematicCandidate(opts: {
  candidate: WordCandidate;
  trustedThematicSet: Set<string>;
  theme: string;
  language: "es" | "en";
  notesByAnswer: Map<string, string>;
  clueByAnswer?: Map<string, string>;
}) {
  const { candidate, trustedThematicSet, theme, language, notesByAnswer, clueByAnswer } = opts;
  const answer = candidate.answer;

  if (candidate.source === "filler" || candidate.source === "support") return false;
  if (!candidate.thematic && !trustedThematicSet.has(answer)) return false;
  if (CONTEXTUAL_SUPPORT_ANSWERS.has(answer)) return false;
  if (LOW_VALUE_CONTEXTLESS_ANSWERS.has(answer)) return false;
  if (isOverGenericThemeWordForTheme(theme, answer)) return false;

  return hasStrongThematicClueSupport({
    theme,
    answer,
    language,
    note: notesByAnswer.get(answer),
    clue: clueByAnswer?.get(answer),
  });
}

function buildCoreThematicSetFromPool(opts: {
  pool: WordCandidate[];
  trustedThematicSet: Set<string>;
  theme: string;
  language: "es" | "en";
  notesByAnswer: Map<string, string>;
  clueByAnswer?: Map<string, string>;
}) {
  return new Set(
    opts.pool
      .filter((candidate) =>
        isCoreThematicCandidate({
          candidate,
          trustedThematicSet: opts.trustedThematicSet,
          theme: opts.theme,
          language: opts.language,
          notesByAnswer: opts.notesByAnswer,
          clueByAnswer: opts.clueByAnswer,
        })
      )
      .map((candidate) => candidate.answer)
  );
}

function buildPublishThematicSetFromPool(opts: {
  pool: WordCandidate[];
  trustedThematicSet: Set<string>;
  theme: string;
  language: "es" | "en";
  notesByAnswer: Map<string, string>;
  clueByAnswer?: Map<string, string>;
}) {
  const thematicSet = buildCoreThematicSetFromPool(opts);

  for (const candidate of opts.pool) {
    if (candidate.source === "filler") continue;
    if (isOverGenericThemeWordForTheme(opts.theme, candidate.answer)) continue;
    if (LOW_VALUE_CONTEXTLESS_ANSWERS.has(candidate.answer)) continue;

    const contextual =
      candidate.source === "support" || CONTEXTUAL_SUPPORT_ANSWERS.has(candidate.answer);
    if (!contextual) continue;

    if (
      hasStrongThematicClueSupport({
        theme: opts.theme,
        answer: candidate.answer,
        language: opts.language,
        note: opts.notesByAnswer.get(candidate.answer),
        clue: opts.clueByAnswer?.get(candidate.answer),
      }) ||
      fallbackClueForPublishRepair(
        opts.theme,
        candidate.answer,
        opts.language,
        true,
        opts.notesByAnswer.get(candidate.answer)
      )
    ) {
      thematicSet.add(candidate.answer);
    }
  }

  return thematicSet;
}

function isPlaceholderClue(clue: string, language: "es" | "en"): boolean {
  const c = clue.trim().toLowerCase();
  if (!c) return true;

  if (language === "en") {
    if (c === "brief definition.") return true;
    if (/^short definition/.test(c)) return true;
    if (/^common word/.test(c)) return true;
    if (/^themed entry/.test(c)) return true;
    if (/^theme context for /.test(c)) return true;
    if (/^word \(\d+ letters\)/.test(c)) return true;
    if (c === "place associated with california") return true;
    if (c === "california-related entry") return true;
    if (/^california entry/.test(c)) return true;
  } else {
    if (c === "definición breve." || c === "definicion breve.") return true;
    if (/^contexto tem[aá]tico para /.test(c)) return true;
    if (/^entrada com[uÃº]n de crucigrama/.test(c)) return true;
    if (/^sobre .+\(\d+ letras\)$/.test(c)) return true;
    if (/^palabra\b/.test(c)) return true;
    if (/^sobre [^,.;:!?]+$/.test(c)) return true;
    if (/^entrada tematica\b/.test(c) || /^entrada temática\b/.test(c)) return true;
  }

  return false;
}

function sanitizeModelClueText(clue: string, language: "es" | "en"): string {
  let cleaned = clue.replace(/\s+/g, " ").trim();
  if (language === "es") {
    cleaned = cleaned.replace(/^contexto tem[aá]tico para [^:]+:\s*/i, "").trim();
  } else {
    cleaned = cleaned.replace(/^theme context for [^:]+:\s*/i, "").trim();
  }
  return cleaned;
}

async function validateThematicAnswers(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
  answers: string[];
  attempt: number;
}) {
  const { client, theme, language, size, answers, attempt } = opts;

  if (!answers.length) return [];

  const languageLabel = language === "es" ? "Spanish" : "English";
  const prompt = `
You will OUTPUT ONLY JSON with this schema:
{ "keep": string[] }

Task:
From the provided ANSWERS list, KEEP ONLY entries that are REAL and SPECIFICALLY tied to the THEME.
For a place/geography theme, also KEEP complete real terms that are strongly characteristic of that place's landscape, tourism, food, flora/fauna, climate, landmarks, routes, or local culture.
If an entry is only a generic dictionary word with no clear thematic connection, DO NOT keep it.

Hard rules:
- Keep ONLY uppercase A-Z and digits (no spaces, no hyphens).
- Length must be 3..${size}.
- No duplicates.
- Reject generic/abstract words unless they are a well-known, specific, real themed identifier.
- KEEP an ordinary domain word when it has a direct, concrete, factual relationship to the theme and can receive
  a clue that explicitly states that relationship. Examples include an instrument used by a band, a technique used
  in a craft, an animal characteristic of a habitat, or an activity strongly practiced at a place.
- Do not keep a contextual word merely because it belongs to the same broad category; the relationship must be
  specific enough to state in the clue without vague phrases such as "associated with" or "related to".
- Reject the exact THEME itself; the user's theme text must not become a grid answer.
- For music, film, book, game, sports, brand, person, and franchise themes, keep exact standalone titles,
  surnames, stage names, product names, character names, album/song/work titles, roles, teams, places,
  or other real identifiers even when the word also has a generic dictionary meaning.
- Keep first names, surnames, stage names, character given names, and short public identifiers when they are
  commonly used to identify a major person/entity in the requested theme. Do not reject DAVE, MARTY, KIKO,
  NICK-style entries merely because they are part of a full name, if that name is genuinely prominent for the theme.
- Keep short complete themed entries when they are genuinely associated with the theme.
- For place themes, KEEP complete associated terms such as local landmarks, geographic features, activities, foods, flora/fauna, routes, weather terms, and nearby places when they truly fit the requested place.
- For place themes, KEEP real characteristic category-like terms only when they are strongly associated with the requested place, not merely because they are common dictionary words.
- Prefer famous/relevant local names over obscure or doubtful names.
- Prefer widely verifiable, high-salience entries. Reject obscure, one-off, doubtful, or low-source-quality names when a normal solver would not recognize the connection.
- Keep an entry only if it can receive a concrete clue without unstable words like current/former/latest and without vague wording like "associated with".
- Reject chopped stems and truncated fragments such as NATUR, CARNI, CULTU, CASC, CUMB, CICL, MONT, NEVE, AVENT.
- Reject fabricated or doubtful geographic compounds such as LAGOSOL, LAGOBLANCO, LAGOHERMOSO, LAGOLIMPIO, LAGOSILVINA, LAGOTRANCAS, LAGOVIEDMA, CERROVERDE, or CERROAZUL unless the exact full name is a reputable, notable match for the requested THEME.
- Reject merely generic dictionary words such as BASE, ALMA, AZUL, ARTE, CAMA, CARNES, MUSEO unless the clue would be specifically about the theme.
- Reject entries that are primarily associated with a different place, state, country, band, person, franchise, or topic than the requested THEME.
- Reject near-misses, lookalikes, or superficially related entries that are not truly specific to the requested THEME.
- Reject tokens that are usually only one part of a longer name, title, place, person, or phrase, unless that token is clearly and commonly used as a standalone entry or identifier in the theme.
- Reject incomplete title variants when the complete title token fits in ${size} cells; for example, do not keep a singular/plural near-miss if the real work title uses the other form.
- Reject entries whose only possible clue would be vague, such as "related to the theme", "associated with the theme", or "thematic fact".
- For geography themes, keep only places, landmarks, regions, products, or terms that are genuinely associated with that geography.
- For geography themes, reject overly broad natural-category words like MOUNTAIN, VALLEY, COAST, PALM, or similar generic feature words unless they are clearly the full standalone name of a specific themed place or entity.
THEME: ${theme}
LANGUAGE: ${languageLabel}

ANSWERS:
${answers.join(", ")}

Return JSON only.
`;

  const completion = await client.chat.completions.create({
    model: ANSWERBANK_SEARCH_MODEL,
    temperature: 0,
    max_tokens: 1400,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No extra text." },
      { role: "user", content: prompt },
    ],
  });

  const text = completion.choices?.[0]?.message?.content ?? "";
  console.warn("[generate-crossword] validate raw", {
    attempt,
    rawText_len: text.length,
    rawText_head: text.slice(0, 200),
    rawText_tail: text.slice(-150),
  });

  const parsed = safeJson<{ keep?: string[] }>(text);
  const cleaned = sanitizeAnswerList(parsed?.keep, size, language);
  return cleaned;
}

async function topUpAnswers(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
  existing: string[];
  need: number;
  attempt: number;
}) {
  const { client, theme, language, size, existing, need, attempt } = opts;

  const languageLabel = language === "es" ? "Spanish" : "English";

  const prompt = `
You will OUTPUT ONLY JSON: {"answers":[...]}.

Generate EXACTLY ${need} NEW crossword answers that are STRONGLY AND DIRECTLY RELATED to the THEME.

CRITICAL THEME RULES:
- Every answer must be a real, specific themed entry.
- Length MUST be 3..${size}. Do NOT output anything longer than ${size}.
- Prefer a SINGLE token that is a complete, standalone, crossword-ready entry.
- Prefer 3..8 letter answers when they are real exact themed terms; they cross much better in an 11x11.
- For an 11x11, at least 70% of this response MUST be length 3..6, and every such short answer must still be a real exact themed term.
- Include short exact names, surnames, places, routes, landmarks, foods, activities, animals, plants, songs, albums, characters, or other domain-specific terms when they are genuinely tied to the theme.
- At least 70% of the answers should be exact named/theme-specific entries, not broad category words.
- For place themes, cover varied categories: landmarks, activities, food, climate, flora, fauna, routes, nearby towns, tourism, and culture.
- For place themes, avoid repeated fabricated template entries with the same prefix. Do not make lists like CERROAZUL, CERROVERDE, CERROGRIS unless each one is a real, notable themed place.
- For place themes, no more than 5 answers in this top-up may start with LAGO or CERRO combined.
- For place themes, prioritize short real thematic category entries of length 3-8 over more LAGO/CERRO proper names.
- For place themes, include short real thematic terms when true and distinctive: local foods, animals, plants, activities, weather, and famous names.
- Use only complete official names or complete standalone words. Never output a partial phrase.
- For titles of songs, albums, books, films, games, episodes, products, or works, output the exact normalized title token when it fits. Do not drop a final S or alter singular/plural.
- Do NOT output abbreviations, initials, airport codes, postal codes, nicknames, clipped forms, fragments, prefixes, suffixes, or shortened pieces of longer names.
- Do NOT output answers ending in function words or prepositions such as DE, DEL, OF, THE.
- Do NOT invent concatenations. A compound answer must be the normalized form of a real complete name, not a prefix plus a guessed suffix.
- Do NOT output partial place names or truncated versions of a better full answer.
- If a complete themed term is longer than ${size}, skip it. Never shorten it.
- AVOID generic fill words (e.g., DREAM, HARD, PEACE, CHAOS, CLOUD, SILENT, COAT, INK, OFF, NOR, FEE, RUE, AZUL, ALMA, BASE, CAFE, VIAJE, LUGAR, TORRE, MUSEO, ARTE, etc.).
- Reject chopped stems such as NATUR, CARNI, CULTU, CASC, CUMB, CICL, MONT, NEVE, AVENT.
- DO NOT output theme-adjacent but generic words created by adding suffixes/prefixes (RUSTY, RUSTED, FROSTY, SILVERY, etc.).
- No duplicates.
- Must NOT include any of these existing answers:
${existing.join(", ")}

FORMAT / VALIDITY (hard):
- Output tokens MUST ALREADY be normalized: ONLY A-Z and digits (NO spaces, NO hyphens, NO accents).

Theme: ${theme}
Language: ${languageLabel}

All answers must be UNIQUE (no repeats).
Return JSON only. No extra keys. No notes.
`;

  const completion = await client.chat.completions.create({
    model: size === 11 ? ANSWERBANK_SEARCH_MODEL : ANSWERBANK_MODEL,
    temperature: 0.2,
    max_tokens: Math.min(3200, 800 + need * 40),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No extra text." },
      { role: "user", content: prompt },
    ],
  });

  const text = completion.choices?.[0]?.message?.content ?? "";
  console.warn("[generate-crossword] answerbank topup raw", {
    attempt,
    need,
    rawText_len: text.length,
    rawText_head: text.slice(0, 200),
    rawText_tail: text.slice(-150),
  });

  const parsed = safeJson<RawAnswerBank>(text);
  const salvaged = !parsed || !Array.isArray(parsed.answers) ? salvageAnswerStringsFromJson(text) : [];
  const cleaned = sanitizeAnswerList(
    parsed && Array.isArray(parsed.answers) ? parsed.answers : salvaged,
    size,
    language
  );
  return cleaned;
}

async function topUpAnswersRobust(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
  existing: string[];
  need: number;
  attempt: number;
}) {
  const { need } = opts;

  // The model can get truncated when asked for too many tokens/answers at once.
  // We therefore top-up in smaller chunks and progressively reduce the chunk size
  // if parsing/sanitization yields nothing.
  const out: string[] = [];
  const seen = new Set<string>(opts.existing.map((a) => normalizeAnswer(a)));

  let chunk = Math.min(opts.size === 11 ? 18 : 24, need);
  const maxTries = opts.size === 11 ? 4 : 4;
  for (let tries = 0; tries < maxTries && out.length < need; tries++) {
    const want = Math.min(chunk, need - out.length);

    const more = await topUpAnswers({ ...opts, existing: Array.from(seen), need: want });

    if (more.length === 0) {
      // Backoff: ask for fewer answers next time to avoid truncation.
      chunk = Math.max(5, Math.floor(chunk / 2));
      continue;
    }

    for (const a of more) {
      const norm = normalizeAnswer(a);
      if (!norm) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
      if (out.length >= need) break;
    }
  }

  return out;
}

async function generateLengthBalancedThematicAnswers(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
  existing: string[];
  desiredByLength: Map<number, number>;
  attempt: number;
}) {
  const { client, theme, language, size, existing, desiredByLength, attempt } = opts;
  const requested = Array.from(desiredByLength.entries())
    .filter(([len, count]) => len >= 3 && len <= size && count > 0)
    .sort(([a], [b]) => a - b);
  if (requested.length === 0) return [];

  const languageLabel = language === "es" ? "Spanish" : "English";
  const responses = await Promise.all(
    requested.map(async ([len, requestedCount]) => {
      const count = Math.min(requestedCount, 10);
      const prompt = `
Return ONLY JSON: {"answers":[...]}.

Generate EXACTLY ${count} NEW, crossword-ready answers that are strongly and directly tied to THEME.
EVERY answer MUST contain exactly ${len} normalized characters. Count them before returning JSON.

Hard rules:
- Count normalized characters, not display characters. Every answer must already contain ONLY uppercase A-Z and digits.
- Every answer must be a real, complete, standalone themed identifier or term.
- Good entries include exact surnames, first names commonly used for a themed person, stage names, characters,
  places, products, works, songs, albums, objects, technical terms, foods, species, events, or other specific domain terms.
- A word with an ordinary dictionary meaning is allowed only when it is also a concrete named or unmistakable reference in THEME.
- No abbreviations, initials, codes, fragments, clipped names, shortened titles, invented compounds, or altered singular/plural forms.
- Do not include the theme itself.
- Do not include generic words whose clue would merely be a dictionary definition.
- Every answer must support a concrete clue that explicitly connects it to THEME.
- No duplicates and none of these existing answers:
${existing.join(", ")}

THEME: ${theme}
LANGUAGE: ${languageLabel}
`;

      const completion = await client.chat.completions.create({
        model: ANSWERBANK_SEARCH_MODEL,
        temperature: 0.1,
        max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Return ONLY valid JSON. Every answer must have exactly ${len} characters.`,
          },
          { role: "user", content: prompt },
        ],
      });
      return {
        len,
        text: completion.choices?.[0]?.message?.content ?? "",
      };
    })
  );

  const existingSet = new Set(existing.map((answer) => normalizeAnswer(answer)).filter(Boolean));
  const accepted: string[] = [];

  for (const response of responses) {
    const parsed = safeJson<RawAnswerBank>(response.text);
    const salvaged = !parsed || !Array.isArray(parsed.answers)
      ? salvageAnswerStringsFromJson(response.text)
      : [];
    const cleaned = sanitizeAnswerList(
      parsed && Array.isArray(parsed.answers) ? parsed.answers : salvaged,
      size,
      language
    );
    const limit = Math.min(desiredByLength.get(response.len) ?? 0, 10);
    let added = 0;
    for (const answer of cleaned) {
      if (answer.length !== response.len || existingSet.has(answer)) continue;
      accepted.push(answer);
      existingSet.add(answer);
      added++;
      if (added >= limit) break;
    }
  }

  console.warn("[generate-crossword] length-balanced topup raw", {
    attempt,
    requested: Object.fromEntries(requested),
    received: Object.fromEntries(
      accepted.reduce((counts, answer) => {
        counts.set(answer.length, (counts.get(answer.length) ?? 0) + 1);
        return counts;
      }, new Map<number, number>())
    ),
    responses: responses.map((response) => ({
      len: response.len,
      rawText_len: response.text.length,
      rawText_head: response.text.slice(0, 100),
    })),
  });

  return accepted;
}

async function generateSupportWords(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
  existing: string[];
  attempt: number;
}) {
  const { client, theme, language, size, existing, attempt } = opts;
  const languageLabel = language === "es" ? "Spanish" : "English";
  const prompt = `
You will OUTPUT ONLY JSON: {"answers":[...]}.

Task:
Generate up to 80 SUPPORT words for a themed crossword.

These are NOT required to be unique themed entities.
Instead, they should be SAFE, REAL, common, crossword-friendly words that are:
- genuinely connected to the THEME's world, context, imagery, domain, or vocabulary
- useful as support fill around stronger thematic entries
- standalone dictionary words or very common domain terms
- easy to connect explicitly to the theme in a clue
- concrete enough that a solver would accept the clue as thematic, not a plain dictionary definition

Hard rules:
- Use ONLY uppercase A-Z and digits.
- Length MUST be 3..${Math.min(size, 8)}.
- No duplicates.
- No abbreviations, airport codes, clipped forms, fragments, or junk.
- Avoid ultra-generic stopwords.
- Avoid obscure trivia and doubtful references.
- Include a balanced spread of 3-, 4-, 5-, 6-, 7-, and 8-letter words.
- Prefer words that can be clued through the theme, not unrelated dictionary fill.
- For music themes, include concrete domain vocabulary such as instrument, performance, release, studio, lyric, tour, genre, and sound terms when true.
- For place themes, include concrete local landscape, travel, food, climate, activity, culture, flora/fauna, route, and landmark-category words when true.
- For sports, games, films, books, brands, people, science, history, and hobbies, choose equivalent concrete domain vocabulary.
- Reject words whose only honest clue would be "thing related to THEME".
- Must NOT include any of these existing answers:
${existing.join(", ")}

Theme: ${theme}
Language: ${languageLabel}

Return JSON only.
`;

  const completion = await client.chat.completions.create({
    model: ANSWERBANK_SEARCH_MODEL,
    temperature: 0.2,
    max_tokens: 2200,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No extra text." },
      { role: "user", content: prompt },
    ],
  });

  const text = completion.choices?.[0]?.message?.content ?? "";
  console.warn("[generate-crossword] support raw", {
    attempt,
    rawText_len: text.length,
    rawText_head: text.slice(0, 160),
    rawText_tail: text.slice(-120),
  });

  const parsed = safeJson<RawAnswerBank>(text);
  return sanitizeAnswerList(parsed?.answers, Math.min(size, 8), language).filter((a) => a.length >= 3);
}

function inferLocalSupportWords(
  theme: string,
  size: number,
  notesByAnswer: Map<string, string>
): Array<{ answer: string; thematic: boolean }> {
  const themeNorm = normalizeAnswer(theme);
  const noteBlob = Array.from(notesByAnswer.values())
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

  const looksWineRelated =
    themeNorm === "VINO" ||
    themeNorm === "WINE" ||
    themeNorm === "MENDOZA";

  const looksJapanRelated =
    themeNorm === "JAPON" ||
    themeNorm === "JAPAN";
  const looksMusicRelated =
    /MUSIC|MUSICA|ROCK|METAL|JAZZ|PUNK|BAND|BANDA|SONG|CANCION|ALBUM|GUITAR|GUITARRA|MEGADETH|METALLICA|BEATLES/.test(
      themeNorm
    ) ||
    /MUSIC|MUSICA|ROCK|METAL|JAZZ|PUNK|BAND|BANDA|SONG|CANCION|ALBUM|GUITAR|GUITARRA|MEGADETH|METALLICA|BEATLES|MUSTAINE|ELLEFSON|RATTLEHEAD|FRIEDMAN|MENZA|KIKO|LOUREIRO|BRODERICK/.test(
      noteBlob
    );

  if (themeNorm === "BARILOCHE") {
    const curated = [
      "NAHUEL",
      "HUAPI",
      "LLAOLLAO",
      "CATEDRAL",
      "CAMPANARIO",
      "TRONADOR",
      "MORENO",
      "GUTIERREZ",
      "MASCARDI",
      "ARRAYANES",
      "CHOCOLATE",
      "PATAGONIA",
      "RIONEGRO",
      "ANDES",
      "LAGOS",
      "NIEVE",
      "ESQUI",
      "OTTO",
      "BUSTILLO",
      "CIVICO",
      "CERVEZA",
      "CURANTO",
      "COLONIA",
      "SUIZA",
      "LIMAY",
    ];

    const seen = new Set<string>();
    const out: Array<{ answer: string; thematic: boolean }> = [];
    for (const raw of curated) {
      const answer = normalizeAnswer(raw);
      if (!answer) continue;
      if (answer.length < 3 || answer.length > size) continue;
      if (!ASCII_A_TO_Z.test(answer)) continue;
      if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
      if (seen.has(answer)) continue;
      seen.add(answer);
      out.push({ answer, thematic: true });
    }
    return out;
  }

  if (looksJapanRelated) {
    const curated = [
      "ANIME",
      "SUSHI",
      "UDON",
      "RAMEN",
      "MISO",
      "NORI",
      "SAKE",
      "SUMO",
      "KABUKI",
      "KIMONO",
      "SAMURAI",
      "SHINTO",
      "SHOGUN",
      "TOKYO",
      "TOKIO",
      "KYOTO",
      "OSAKA",
      "NIKKO",
      "FUGU",
      "KONBU",
      "KITSUNE",
      "YOKAI",
      "YAKITORI",
      "BONSAI",
      "HAIKU",
      "TAIKO",
      "GEISHA",
      "NINJA",
      "KAWA",
    ];

    const seen = new Set<string>();
    const out: Array<{ answer: string; thematic: boolean }> = [];
    for (const raw of curated) {
      const answer = normalizeAnswer(raw);
      if (!answer) continue;
      if (answer.length < 3 || answer.length > size) continue;
      if (!ASCII_A_TO_Z.test(answer)) continue;
      if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
      if (seen.has(answer)) continue;
      seen.add(answer);
      out.push({ answer, thematic: true });
    }
    return out;
  }

  const looksMegadethRelated =
    themeNorm === "MEGADETH" ||
    /MEGADETH|MUSTAINE|ELLEFSON|RATTLEHEAD|RUSTINPEACE|PEACESELLS|YOUTHANASIA|DYSTOPIA|FRIEDMAN|MENZA|KIKO|LOUREIRO|BRODERICK/.test(
      noteBlob
    );

  if (looksMegadethRelated) {
    const curated = [
      "MUSTAINE",
      "ELLEFSON",
      "RATTLEHEAD",
      "RUSTINPEACE",
      "PEACESELLS",
      "YOUTHANASIA",
      "DYSTOPIA",
      "FRIEDMAN",
      "MARTY",
      "MENZA",
      "DAVE",
      "VIC",
      "LOUREIRO",
      "BRODERICK",
      "KIKO",
      "ENDGAME",
      "THIRTEEN",
      "COUNTDOWN",
      "CRYPTIC",
      "RATTLE",
      "SELLS",
      "ALBUM",
      "AMP",
      "ARENA",
      "AXE",
      "BAND",
      "BASS",
      "BEAT",
      "CAB",
      "CABLE",
      "CHORD",
      "CHORUS",
      "CYMBAL",
      "DRUMS",
      "FAN",
      "FANS",
      "FRET",
      "GAIN",
      "GIG",
      "GUITAR",
      "HOOK",
      "JAM",
      "KICK",
      "LABEL",
      "LIVE",
      "LOGO",
      "LYRIC",
      "MELODY",
      "MERCH",
      "METAL",
      "MIC",
      "MOSH",
      "PEDAL",
      "PICK",
      "PIT",
      "RECORD",
      "REVERB",
      "RIFF",
      "RIG",
      "ROCK",
      "ROLL",
      "ROADIE",
      "ROCKER",
      "SCREAM",
      "SET",
      "SHRED",
      "SNARE",
      "SOLO",
      "SONG",
      "SOUND",
      "STAGE",
      "STUDIO",
      "TEMPO",
      "THRASH",
      "TICKET",
      "TRACK",
      "TUNER",
      "TOUR",
      "VERSE",
      "VOCALS",
    ];

    const seen = new Set<string>();
    const out: Array<{ answer: string; thematic: boolean }> = [];
    for (const raw of curated) {
      const answer = normalizeAnswer(raw);
      if (!answer) continue;
      if (answer.length < 3 || answer.length > size) continue;
      if (!ASCII_A_TO_Z.test(answer)) continue;
      if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
      if (seen.has(answer)) continue;
      seen.add(answer);
      out.push({ answer, thematic: true });
    }
    return out;
  }

  if (looksMusicRelated) {
    const curated = [
      "ALBUM",
      "AMP",
      "ARENA",
      "AXE",
      "BAND",
      "BASS",
      "BEAT",
      "CAB",
      "CABLE",
      "CHORD",
      "CHORUS",
      "CYMBAL",
      "DRUMS",
      "FAN",
      "FANS",
      "FRET",
      "GAIN",
      "GIG",
      "GUITAR",
      "HOOK",
      "JAM",
      "KICK",
      "LABEL",
      "LIVE",
      "LOGO",
      "LYRIC",
      "MELODY",
      "MERCH",
      "METAL",
      "MIC",
      "MOSH",
      "PEDAL",
      "PICK",
      "PIT",
      "RECORD",
      "REVERB",
      "RIFF",
      "RIG",
      "ROCK",
      "ROLL",
      "ROADIE",
      "ROCKER",
      "SCREAM",
      "SET",
      "SHRED",
      "SNARE",
      "SOLO",
      "SONG",
      "SOUND",
      "STAGE",
      "STUDIO",
      "TEMPO",
      "THRASH",
      "TICKET",
      "TRACK",
      "TUNER",
      "TOUR",
      "VERSE",
      "VOCALS",
    ];

    const seen = new Set<string>();
    const out: Array<{ answer: string; thematic: boolean }> = [];
    for (const raw of curated) {
      const answer = normalizeAnswer(raw);
      if (!answer) continue;
      if (answer.length < 3 || answer.length > size) continue;
      if (!ASCII_A_TO_Z.test(answer)) continue;
      if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
      if (seen.has(answer)) continue;
      seen.add(answer);
      out.push({ answer, thematic: true });
    }
    return out;
  }

  const looksMetallicaRelated =
    themeNorm === "METALLICA" ||
    /METALLICA|HETFIELD|ULRICH|HAMMETT|TRUJILLO|BURTON|NEWSTED|KILLEMALL|PUPPETS|SANDMAN|LIGHTNING|JUSTICE|BATTERY|ORION|UNFORGIVEN|HARDWIRED|STANGER|RELOAD|LOAD/.test(
      noteBlob
    );

  if (looksMetallicaRelated) {
    const curated = [
      "HETFIELD",
      "ULRICH",
      "HAMMETT",
      "TRUJILLO",
      "BURTON",
      "NEWSTED",
      "JASON",
      "LARS",
      "JAMES",
      "KIRK",
      "ROBERT",
      "CLIFF",
      "PUPPETS",
      "SANDMAN",
      "LIGHTNING",
      "JUSTICE",
      "BLACK",
      "BATTERY",
      "ORION",
      "ONE",
      "FUEL",
      "CREEPING",
      "DEATH",
      "UNFORGIVEN",
      "KILLEMALL",
      "LOAD",
      "RELOAD",
      "STANGER",
      "HARDWIRED",
      "DESTRUCT",
      "AJFA",
    ];

    const seen = new Set<string>();
    const out: Array<{ answer: string; thematic: boolean }> = [];
    for (const raw of curated) {
      const answer = normalizeAnswer(raw);
      if (!answer) continue;
      if (answer.length < 3 || answer.length > size) continue;
      if (!ASCII_A_TO_Z.test(answer)) continue;
      if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
      if (seen.has(answer)) continue;
      seen.add(answer);
      out.push({ answer, thematic: true });
    }
    return out;
  }

  if (!looksWineRelated) return [];

  const curated = [
    "UVA",
    "UVAS",
    "VID",
    "CEPA",
    "CEPAS",
    "MOSTO",
    "ROBLE",
    "CORCHO",
    "BARRICA",
    "BARRIL",
    "RESERVA",
    "CRIANZA",
    "TANINO",
    "TANINOS",
    "BLEND",
    "TINTO",
    "TINTOS",
    "BLANCO",
    "BLANCOS",
    "ROSADO",
    "ROSADOS",
    "BODEGA",
    "BODEGAS",
    "MERLOT",
    "MALBEC",
    "CABERNET",
    "TEMPRANILLO",
    "CATA",
    "VINICOLA",
    "VINO",
    "VINOS",
    "CAVA",
    "BRUT",
    "RACIMO",
    "TERROIR",
    "CUPAGE",
    "NORTON",
    "PULENTA",
    "MAIPU",
  ];

  if (themeNorm === "MENDOZA") {
    curated.push(
      "ACONCAGUA",
      "ANDES",
      "GUAYMALLEN",
      "GODOYCRUZ",
      "LUJAN",
      "POTRERILLOS",
      "SANRAFAEL",
      "TUNUYAN",
      "UCO",
      "USPALLATA"
    );
  }

  const seen = new Set<string>();
  const out: Array<{ answer: string; thematic: boolean }> = [];

  for (const raw of curated) {
    const answer = normalizeAnswer(raw);
    if (!answer) continue;
    if (answer.length < 3 || answer.length > size) continue;
    if (!ASCII_A_TO_Z.test(answer)) continue;
    if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
    if (seen.has(answer)) continue;
    seen.add(answer);
    out.push({ answer, thematic: true });
  }

  return out;
}

function gridToStrings(grid: (string | null)[][]): string[][] {
  return grid.map((row) =>
    row.map((cell) => {
      if (typeof cell === "string" && cell.length === 1) {
        if (/[a-z]/.test(cell)) return cell.toUpperCase();
        if (/[A-Z0-9]/.test(cell)) return cell;
      }
      return "#";
    })
  );
}

function buildCandidatePoolFromAnswers(
  theme: string,
  raw: RawAnswerBank | null,
  size: number,
  thematicKeep: Set<string>,
  supportWords: string[] = [],
  localSupportWords: Array<{ answer: string; thematic: boolean }> = [],
  language: "es" | "en" = "en"
): WordCandidate[] {
  const themeNorm = normalizeAnswer(theme);
  const rawNotesByAnswer = new Map<string, string>();
  for (const item of raw?.notes ?? []) {
    const answer = normalizeAnswer(item.answer);
    if (answer && item.note) rawNotesByAnswer.set(answer, item.note);
  }

  const anchors = getThemeAnchors(theme)
    .map((a) => normalizeAnswer(a))
    .filter(Boolean)
    .filter((a) => a !== themeNorm); // NO permitir el tema como respuesta

  const map = new Map<string, WordCandidate>();

  // 1) Anchors (theme-linked, strongest)
  for (const a of anchors) {
    if (a.length <= size && a.length >= 3 && ASCII_A_TO_Z.test(a)) {
      map.set(a, { answer: a, thematic: true, source: "anchor" });
    }
  }

  // 2) Model answers (THEMATIC) — con cap para que no exploten
  const MODEL_CAP = Math.max(120, size * size); // 11 => 121 aprox
  let modelAdded = 0;

  if (raw?.answers && Array.isArray(raw.answers)) {
    for (const ansRaw of raw.answers) {
      if (modelAdded >= MODEL_CAP) break;

      const ans = normalizeAnswer(ansRaw);
      if (!ans) continue;
      if (ans === themeNorm) continue;
      if (
        !isPublishableAnswerForTheme({
          theme,
          answer: ans,
          language,
          size,
          note: rawNotesByAnswer.get(ans),
          allowContextualGeneric: true,
        })
      ) {
        continue;
      }
      // Only allow model answers that passed thematic validation.
      // If it's not in thematicKeep, we drop it completely (prevents SWEETLEAF, etc.)
      if (!thematicKeep.has(ans)) continue;

      if (!map.has(ans)) {
        map.set(ans, { answer: ans, thematic: true, source: "model" });
        modelAdded++;
      }
    }
  }

  // 2b) Curated local support words (strong domain-adjacent vocabulary)
  for (const item of localSupportWords) {
    const ans = normalizeAnswer(item.answer);
    if (!ans) continue;
    if (ans === themeNorm) continue;
    if (
      !isPublishableAnswerForTheme({
        theme,
        answer: ans,
        language,
        size: Math.min(size, 11),
        note: rawNotesByAnswer.get(ans),
        allowContextualGeneric: item.thematic,
      })
    ) {
      continue;
    }

    const prev = map.get(ans);
    if (!prev) {
      map.set(ans, {
        answer: ans,
        thematic: item.thematic,
        source: item.thematic ? "model" : "support",
      });
      continue;
    }

    if (item.thematic && !prev.thematic) {
      map.set(ans, { ...prev, thematic: true, source: "model" });
    }
  }

  const rawAnswerBlob = Array.isArray(raw?.answers) ? raw.answers.join(" ").toUpperCase() : "";
  const looksGeographic =
    /LAGO|LAKE|CERRO|HILL|MOUNT|MONTE|RIO|RIVER|ISLA|ISLAND|PUERTO|PORT|PLAYA|BEACH|RUTA|ROUTE|PARQUE|PARK|CIUDAD|CITY|VALLE|VALLEY|COSTA|COAST/.test(
      rawAnswerBlob
    );
  const contextualSupport =
    looksGeographic && language === "es"
      ? ["RUTA", "CAMINO", "PASEO", "COSTA", "CERRO", "LAGO", "LAGOS", "MUSEO", "PESCA", "KAYAK", "NIEVE", "FRIO", "FLORA", "FAUNA", "NATURALEZA", "SENDERO", "MIRADOR", "REFUGIO", "CAMPING", "VISTA", "GUIA", "MAPA", "TOUR", "TURISMO", "HOTEL", "HOSTEL", "HOSTERIA", "ALBERGUE", "PLAYA", "BOSQUE", "RIO", "AGUA", "SUR", "NORTE", "ISLA", "PUERTO", "PARQUE", "VALLE", "VIAJE", "RANCHO", "RANCHOS"]
      : looksGeographic
      ? ["ROUTE", "COAST", "MUSEUM", "KAYAK", "SNOW", "FLORA", "FAUNA", "TRAIL", "LOOKOUT", "REFUGE", "CAMPING", "VIEW", "GUIDE", "MAP", "TOUR", "AREA", "HOTEL", "HOSTEL", "BEACH", "FOREST", "RIVER", "ISLAND", "PORT", "PARK"]
      : [];

  for (const rawSupport of contextualSupport) {
    const ans = normalizeAnswer(rawSupport);
    if (!ans) continue;
    if (ans === themeNorm) continue;
    if (
      !isPublishableAnswerForTheme({
        theme,
        answer: ans,
        language,
        size: Math.min(size, 11),
        allowContextualGeneric: true,
      })
    ) {
      continue;
    }
    if (map.has(ans)) continue;
    map.set(ans, { answer: ans, thematic: false, source: "support" });
  }

  // 2b) Model support words (domain-adjacent but not necessarily pure thematics)
  for (const ansRaw of supportWords) {
    const ans = normalizeAnswer(ansRaw);
    if (!ans) continue;
    if (ans === themeNorm) continue;
    if (
      !isPublishableAnswerForTheme({
        theme,
        answer: ans,
        language,
        size: Math.min(size, 8),
        note: rawNotesByAnswer.get(ans),
        allowContextualGeneric: true,
      })
    ) {
      continue;
    }
    if (ans.length < 3) continue;
    if (isOverGenericThemeWordForTheme(theme, ans) && !thematicKeep.has(ans)) continue;

    if (!map.has(ans)) {
      const thematic = thematicKeep.has(ans);
      map.set(ans, {
        answer: ans,
        thematic,
        source: thematic ? "model" : "support",
      });
    }
  }

  // 3) Local fillers (NOT thematic) — CAP MUY AGRESIVO
  const fillerCap = size === 11 ? 180 : Math.max(64, size * 5);
  let fillerAdded = 0;
  const fillerAddedByLength = new Map<number, number>();

  const baseFillerWords = language === "es" ? SPANISH_FILLER_WORDS : FILLER_WORDS;
  const fillerWordsForSize =
    size === 11
      ? baseFillerWords.slice().sort((a, b) => {
          const rank = (word: string) => {
            const len = normalizeAnswer(word).length;
            if (len >= 4 && len <= 6) return 0;
            if (len === 7 || len === 3) return 1;
            return 2;
          };

          const rankDiff = rank(a) - rank(b);
          if (rankDiff !== 0) return rankDiff;
          return normalizeAnswer(a).length - normalizeAnswer(b).length;
        })
      : baseFillerWords;

  for (const w of fillerWordsForSize) {
    if (fillerAdded >= fillerCap) break;

    const ans = normalizeAnswer(w);
    if (!ans) continue;
    if (size === 11 && (fillerAddedByLength.get(ans.length) ?? 0) >= 36) continue;
    if (ans === themeNorm) continue;
    if (
      !isPublishableAnswerForTheme({
        theme,
        answer: ans,
        language,
        size,
        allowContextualGeneric: false,
      })
    ) {
      continue;
    }
    if (anchors.includes(ans)) continue;
    if (size === 11 && isOverGenericThemeWordForTheme(theme, ans)) continue;

    if (!map.has(ans)) {
      map.set(ans, { answer: ans, thematic: false, source: "filler" });
      fillerAdded++;
      fillerAddedByLength.set(ans.length, (fillerAddedByLength.get(ans.length) ?? 0) + 1);
    }
  }

  return pruneMaskedDuplicateCandidates(Array.from(map.values()));
}

type PatternSlot = {
  row: number;
  col: number;
  direction: Direction;
  len: number;
  cells: Array<{ r: number; c: number }>;
};

const PATTERN_11X11S: string[][] = [
  [
    "##.....####",
    "#....#....#",
    ".....#.....",
    "....#....##",
    "#....#.....",
    "...........",
    ".....#....#",
    "##....#....",
    ".....#.....",
    "#....#....#",
    "####.....##",
  ],
  [
    "###....####",
    "#....#....#",
    ".....#.....",
    "....#.....#",
    "...#.......",
    "...........",
    ".......#...",
    "#.....#....",
    ".....#.....",
    "#....#....#",
    "####....###",
  ],
  [
    "####.....##",
    "#....#....#",
    "#.....#....",
    ".....#.....",
    "....#....##",
    "...........",
    "##....#....",
    ".....#.....",
    "....#.....#",
    "#....#....#",
    "##.....####",
  ],
  [
    "##....#....",
    "#....#....#",
    ".....#.....",
    "....#....##",
    "....#.....#",
    "...........",
    "#.....#....",
    "##....#....",
    ".....#.....",
    "#....#....#",
    "....#....##",
  ],
];

function extractPatternSlots(pattern: string[]): PatternSlot[] {
  const n = pattern.length;
  const slots: PatternSlot[] = [];
  const minSlotLen = n === 11 ? 3 : 4;

  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      while (c < n && pattern[r][c] === "#") c++;
      const start = c;
      while (c < n && pattern[r][c] !== "#") c++;
      const len = c - start;
      if (len >= minSlotLen) {
        slots.push({
          row: r,
          col: start,
          direction: "across",
          len,
          cells: Array.from({ length: len }, (_, i) => ({ r, c: start + i })),
        });
      }
    }
  }

  for (let c = 0; c < n; c++) {
    let r = 0;
    while (r < n) {
      while (r < n && pattern[r][c] === "#") r++;
      const start = r;
      while (r < n && pattern[r][c] !== "#") r++;
      const len = r - start;
      if (len >= minSlotLen) {
        slots.push({
          row: start,
          col: c,
          direction: "down",
          len,
          cells: Array.from({ length: len }, (_, i) => ({ r: start + i, c })),
        });
      }
    }
  }

  return slots;
}

function constructPatternCrossword11(opts: {
  theme: string;
  size: number;
  candidates: WordCandidate[];
  seed: number;
  deadlineMs?: number;
}): { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null {
  const { theme, size, candidates, seed, deadlineMs } = opts;
  if (size !== 11) return null;

  const nowOk = () => !deadlineMs || Date.now() <= deadlineMs;
  const spanishFillerCount = candidates.filter((candidate) =>
    SPANISH_FILLER_WORDS.includes(candidate.answer)
  ).length;
  const englishFillerCount = candidates.filter((candidate) =>
    FILLER_WORDS.includes(candidate.answer)
  ).length;
  const frequencyDictionary =
    spanishFillerCount > englishFillerCount
      ? FREQUENCY_SPANISH_DICTIONARY_WORDS
      : FREQUENCY_ENGLISH_DICTIONARY_WORDS;
  const dictionaryCandidates: WordCandidate[] = Array.from(
    new Set([
      ...(spanishFillerCount > englishFillerCount
        ? []
        : COMMON_ENGLISH_DICTIONARY_WORDS),
      ...frequencyDictionary,
    ])
  ).map(
    (answer) => ({
      answer,
      thematic: false,
      source: "filler" as const,
    })
  ).filter((candidate) =>
    (candidate.answer.length > 3 || FILLER_WORDS.includes(candidate.answer)) &&
    !WEAK_CONTEXT_DICTIONARY_WORDS.has(candidate.answer)
  );
  const candidatesByAnswer = new Map<string, WordCandidate>();
  for (const candidate of [...candidates, ...dictionaryCandidates]) {
    if (!candidatesByAnswer.has(candidate.answer)) {
      candidatesByAnswer.set(candidate.answer, candidate);
    }
  }
  const usable = Array.from(candidatesByAnswer.values())
    .filter((c) => size === 11 || c.source !== "filler")
    .filter((c) => c.answer.length >= 3 && c.answer.length <= 11)
    .filter((c) => ASCII_A_TO_Z.test(c.answer))
    .filter(
      (c) =>
        c.source !== "filler" ||
        !isLikelyBadAnswer(c.answer) ||
        ALWAYS_ALLOW_ANSWERS.has(c.answer)
    )
    .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer));

  const totalByLen = new Map<number, WordCandidate[]>();
  const thematicByLen = new Map<number, WordCandidate[]>();

  for (const cand of usable) {
    const bucket = totalByLen.get(cand.answer.length) ?? [];
    bucket.push(cand);
    totalByLen.set(cand.answer.length, bucket);

    if (cand.thematic) {
      const tBucket = thematicByLen.get(cand.answer.length) ?? [];
      tBucket.push(cand);
      thematicByLen.set(cand.answer.length, tBucket);
    }
  }

  const scorePattern = (pattern: string[]) => {
    const slots = extractPatternSlots(pattern);
    const needByLen = new Map<number, number>();

    for (const slot of slots) {
      needByLen.set(slot.len, (needByLen.get(slot.len) ?? 0) + 1);
    }

    let shortages = 0;
    let supportNeed = 0;
    let shortCount = 0;
    let longCount = 0;

    for (const [len, need] of needByLen) {
      const total = totalByLen.get(len)?.length ?? 0;
      const thematic = thematicByLen.get(len)?.length ?? 0;
      if (total < need) shortages += need - total;
      if (thematic < need) supportNeed += Math.max(0, Math.min(need, total) - thematic);
      if (len <= 4) shortCount += need;
      if (len >= 9) longCount += need;
    }

    return {
      slots,
      score: shortages * 10000 + supportNeed * 250 + shortCount * 55 + longCount * 25 + slots.length * 2,
      shortages,
    };
  };

  const preferredPatterns = [
    PATTERN_11X11S[0],
    ...PATTERN_11X11S.filter((_, index) => index !== 0),
  ];
  const rankedPatterns = preferredPatterns
    .map((pattern) => ({ pattern, ...scorePattern(pattern) }))
    .filter((item) => item.shortages === 0)
    .sort((a, b) => {
      const aPreferred = a.pattern === PATTERN_11X11S[0] ? 0 : 1;
      const bPreferred = b.pattern === PATTERN_11X11S[0] ? 0 : 1;
      return aPreferred - bPreferred || a.score - b.score;
    });

  if (rankedPatterns.length === 0) return null;

  for (const ranked of rankedPatterns) {
    if (!nowOk()) break;

    const { pattern, slots } = ranked;
    let bestForPattern:
      | {
          grid: string[][];
          usedAnswers: string[];
          thematicCount: number;
          patternVariant: number;
        }
      | null = null;
    const slotIntersections = slots.map((slot, idx) => {
      let count = 0;
      for (let j = 0; j < slots.length; j++) {
        if (j === idx) continue;
        if (slots[j].direction === slot.direction) continue;
        if (slot.cells.some((cell) => slots[j].cells.some((other) => other.r === cell.r && other.c === cell.c))) {
          count++;
        }
      }
      return count;
    });

    const patternAttempts = 14;
    for (let variant = 0; variant < patternAttempts; variant++) {
      if (!nowOk()) break;

      const rng = makeSeededRng((seed + ranked.score * 17 + variant * 104729) >>> 0);
      const baseGrid = pattern.map((row) => row.split("").map((ch) => (ch === "#" ? "#" : "")));

      const candidatePoolByLen = new Map<number, WordCandidate[]>();
      const candidateIndex = new Map<string, WordCandidate[]>();
      for (const [len, items] of totalByLen) {
        const ordered = items
          .slice()
          .sort((a, b) => {
            if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
            const aSource = a.source === "anchor" ? 3 : a.source === "model" ? 2 : 1;
            const bSource = b.source === "anchor" ? 3 : b.source === "model" ? 2 : 1;
            if (aSource !== bSource) return bSource - aSource;
            return a.answer.localeCompare(b.answer);
          });
        shuffleInPlace(ordered, rng);
        ordered.sort((a, b) => {
          if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
          const aSource = a.source === "anchor" ? 3 : a.source === "model" ? 2 : 1;
          const bSource = b.source === "anchor" ? 3 : b.source === "model" ? 2 : 1;
          if (aSource !== bSource) return bSource - aSource;
          return 0;
        });
        candidatePoolByLen.set(len, ordered);
        for (const candidate of ordered) {
          for (let position = 0; position < candidate.answer.length; position++) {
            const key = `${len}:${position}:${candidate.answer[position]}`;
            const indexed = candidateIndex.get(key) ?? [];
            indexed.push(candidate);
            candidateIndex.set(key, indexed);
          }
        }
      }

      const search = (
        grid: Cell[][],
        assignments: Array<string | null>,
        used: Set<string>,
        thematicCount: number
      ): { grid: Cell[][]; assignments: Array<string | null> } | null => {
        if (!nowOk()) return null;
        searchStates++;
        if (searchStates > 2_000_000) return null;

        let bestSlotIndex = -1;
        let bestWords: WordCandidate[] = [];

        for (let i = 0; i < slots.length; i++) {
          if (assignments[i]) continue;

          const slot = slots[i];
          const poolForLen = candidatePoolByLen.get(slot.len) ?? [];
          const constrainedPools = slot.cells
            .map((cell, position) => {
              const current = grid[cell.r][cell.c];
              return current === ""
                ? null
                : candidateIndex.get(`${slot.len}:${position}:${current}`) ?? [];
            })
            .filter((pool): pool is WordCandidate[] => pool !== null);
          const basePool =
            constrainedPools.length > 0
              ? constrainedPools.slice().sort((a, b) => a.length - b.length)[0]
              : poolForLen;
          const viable = basePool.filter((cand) => {
            if (used.has(cand.answer)) return false;

            for (let j = 0; j < slot.cells.length; j++) {
              const cell = slot.cells[j];
              const cur = grid[cell.r][cell.c];
              if (cur !== "" && cur !== cand.answer[j]) return false;
            }
            return true;
          });

          if (viable.length === 0) return null;

          viable.sort((a, b) => {
            if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
            const aSource = a.source === "anchor" ? 3 : a.source === "model" ? 2 : 1;
            const bSource = b.source === "anchor" ? 3 : b.source === "model" ? 2 : 1;
            if (aSource !== bSource) return bSource - aSource;
            return 0;
          });

          if (
            bestSlotIndex === -1 ||
            viable.length < bestWords.length ||
            (viable.length === bestWords.length && slotIntersections[i] > slotIntersections[bestSlotIndex])
          ) {
            bestSlotIndex = i;
            bestWords = viable;
          }
        }

        if (bestSlotIndex === -1) {
          return { grid, assignments };
        }

        const slot = slots[bestSlotIndex];
        const thematicChoices = bestWords.filter((candidate) => candidate.thematic).slice(0, 40);
        const fillerChoices = bestWords.filter((candidate) => !candidate.thematic).slice(0, 240);
        const candidatesToTry = [...thematicChoices, ...fillerChoices];

        for (const cand of candidatesToTry) {
          const nextGrid = grid.map((row) => row.slice());
          for (let j = 0; j < slot.cells.length; j++) {
            const cell = slot.cells[j];
            nextGrid[cell.r][cell.c] = cand.answer[j];
          }

          const nextAssignments = assignments.slice();
          nextAssignments[bestSlotIndex] = cand.answer;
          const nextUsed = new Set(used);
          nextUsed.add(cand.answer);

          const solved = search(
            nextGrid,
            nextAssignments,
            nextUsed,
            thematicCount + (cand.thematic ? 1 : 0)
          );
          if (solved) return solved;
        }

        return null;
      };

      let searchStates = 0;
      const solved = search(
        baseGrid as Cell[][],
        Array(slots.length).fill(null),
        new Set<string>(),
        0
      );

      if (!solved) continue;

      const finalGrid = solved.grid.map((row) =>
        row.map((cell) => {
          if (cell === "#") return "#";
          return typeof cell === "string" && cell.length === 1 ? cell : "#";
        })
      );
      const derived = deriveEntriesFromGrid(finalGrid, minEntryLenForSize(size));

      if (derived.length !== slots.length) continue;
      if (derived.length < minPublishEntriesForSize(size)) continue;

      const assignedAnswers = solved.assignments.filter((a): a is string => Boolean(a));
      const thematicCount = assignedAnswers.filter((answer) =>
        usable.find((candidate) => candidate.answer === answer)?.thematic
      ).length;
      console.warn("[pattern-11x11] solved", {
        slots: slots.length,
        thematic: thematicCount,
        lengths: Object.fromEntries(
          assignedAnswers.reduce((counts, answer) => {
            counts.set(answer.length, (counts.get(answer.length) ?? 0) + 1);
            return counts;
          }, new Map<number, number>())
        ),
      });
      if (!bestForPattern || thematicCount > bestForPattern.thematicCount) {
        bestForPattern = {
          grid: finalGrid,
          usedAnswers: assignedAnswers,
          thematicCount,
          patternVariant: variant,
        };
      }
    }
    if (bestForPattern) {
      return {
        grid: bestForPattern.grid,
        usedAnswers: bestForPattern.usedAnswers,
        meta: {
          builder: "pattern-11x11",
          slotCount: slots.length,
          patternRows: pattern,
          patternVariant: bestForPattern.patternVariant,
          thematicCount: bestForPattern.thematicCount,
        },
      };
    }
  }

  console.warn("[pattern-11x11] no fill", {
    candidates: usable.length,
    patterns: rankedPatterns.length,
    byLength: Object.fromEntries(
      Array.from(totalByLen.entries()).map(([length, words]) => [length, words.length])
    ),
  });
  return null;
}

function constructCompactPatternCrossword11(opts: {
  theme: string;
  size: number;
  candidates: WordCandidate[];
  seed: number;
  deadlineMs?: number;
}): { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null {
  const { theme, size, candidates, seed, deadlineMs } = opts;
  if (size !== 11) return null;

  const minLen = minEntryLenForSize(size);
  const nowOk = () => !deadlineMs || Date.now() <= deadlineMs;
  const usable = candidates
    .filter((c) => c.answer.length >= minLen && c.answer.length <= size)
    .filter((c) => ASCII_A_TO_Z.test(c.answer))
    .filter((c) => !isForbiddenPublishAnswer(c.answer))
    .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer));

  if (usable.length < minPublishEntriesForSize(size)) return null;

  const totalByLen = new Map<number, WordCandidate[]>();
  const thematicByLen = new Map<number, WordCandidate[]>();
  for (const cand of usable) {
    const total = totalByLen.get(cand.answer.length) ?? [];
    total.push(cand);
    totalByLen.set(cand.answer.length, total);
    if (cand.thematic) {
      const thematic = thematicByLen.get(cand.answer.length) ?? [];
      thematic.push(cand);
      thematicByLen.set(cand.answer.length, thematic);
    }
  }

  console.warn("[compact-pattern-11] start", {
    candidates: usable.length,
    thematic: usable.filter((candidate) => candidate.thematic).length,
    lenCount: Object.fromEntries(
      Array.from(totalByLen.entries()).map(([len, items]) => [len, items.length])
    ),
    minEntries: minPublishEntriesForSize(size),
    minCrossings: minCrossingsPerEntryForPublish(size),
  });

  const sourceRank = (candidate: WordCandidate) =>
    candidate.source === "anchor" ? 4 : candidate.source === "model" ? 3 : candidate.source === "support" ? -2 : 1;

  const wordRank = (candidate: WordCandidate) =>
    (candidate.thematic ? 40000 : 0) + sourceRank(candidate) * 1000 + Math.min(candidate.answer.length, 11);

  for (const [len, items] of totalByLen) {
    totalByLen.set(
      len,
      items.slice().sort((a, b) => wordRank(b) - wordRank(a) || a.answer.localeCompare(b.answer))
    );
  }

  const slotCrossCount = (slots: PatternSlot[], slotIndex: number, selected: Set<number>) => {
    const slot = slots[slotIndex];
    let count = 0;
    for (const otherIndex of selected) {
      if (otherIndex === slotIndex) continue;
      const other = slots[otherIndex];
      if (!other || other.direction === slot.direction) continue;
      if (slot.cells.some((cell) => other.cells.some((otherCell) => otherCell.r === cell.r && otherCell.c === cell.c))) {
        count++;
      }
    }
    return count;
  };

  const slotDegree = (slots: PatternSlot[], slotIndex: number) => {
    const all = new Set(slots.map((_, i) => i).filter((i) => i !== slotIndex));
    return slotCrossCount(slots, slotIndex, all);
  };

  const buildMaskPattern = (slots: PatternSlot[], selected: Set<number>) => {
    const mask = Array.from({ length: size }, () => Array(size).fill("#"));
    for (const idx of selected) {
      for (const cell of slots[idx].cells) mask[cell.r][cell.c] = ".";
    }
    return mask.map((row) => row.join(""));
  };

  const candidatePoolForSlots = (slots: PatternSlot[], rng: () => number) => {
    const byLen = new Map<number, WordCandidate[]>();
    for (const slot of slots) {
      if (byLen.has(slot.len)) continue;
      const ordered = (totalByLen.get(slot.len) ?? []).slice();
      shuffleInPlace(ordered, rng);
      ordered.sort((a, b) => wordRank(b) - wordRank(a) || a.answer.localeCompare(b.answer));
      byLen.set(slot.len, ordered);
    }
    return byLen;
  };

  const solveSlots = (
    slots: PatternSlot[],
    patternRows: string[],
    candidateByLen: Map<number, WordCandidate[]>
  ): { grid: string[][]; assignments: Array<string | null> } | null => {
    const baseGrid = patternRows.map((row) => row.split("").map((ch) => (ch === "#" ? "#" : ""))) as Cell[][];
    const slotIntersections = slots.map((slot, idx) => {
      const selected = new Set(slots.map((_, i) => i).filter((i) => i !== idx));
      return slotCrossCount(slots, idx, selected);
    });

    const search = (
      grid: Cell[][],
      assignments: Array<string | null>,
      used: Set<string>,
      states: { count: number }
    ): { grid: Cell[][]; assignments: Array<string | null> } | null => {
      if (!nowOk()) return null;
      states.count++;
      if (states.count > 900000) return null;

      let bestSlotIndex = -1;
      let bestWords: WordCandidate[] = [];

      for (let i = 0; i < slots.length; i++) {
        if (assignments[i]) continue;
        const slot = slots[i];
        const viable = (candidateByLen.get(slot.len) ?? []).filter((cand) => {
          if (used.has(cand.answer)) return false;
          for (let j = 0; j < slot.cells.length; j++) {
            const cell = slot.cells[j];
            const cur = grid[cell.r][cell.c];
            if (cur !== "" && cur !== cand.answer[j]) return false;
          }
          return true;
        });

        if (viable.length === 0) return null;
        if (
          bestSlotIndex === -1 ||
          viable.length < bestWords.length ||
          (viable.length === bestWords.length && slotIntersections[i] > slotIntersections[bestSlotIndex])
        ) {
          bestSlotIndex = i;
          bestWords = viable;
        }
      }

      if (bestSlotIndex === -1) {
        return {
          grid: grid.map((row) => row.map((cell) => (cell === "#" ? "#" : String(cell)))) as string[][],
          assignments,
        };
      }

      const slot = slots[bestSlotIndex];
        for (const cand of bestWords.slice(0, 260)) {
        const nextGrid = grid.map((row) => row.slice());
        for (let j = 0; j < slot.cells.length; j++) {
          const cell = slot.cells[j];
          nextGrid[cell.r][cell.c] = cand.answer[j];
        }
        const nextAssignments = assignments.slice();
        nextAssignments[bestSlotIndex] = cand.answer;
        const nextUsed = new Set(used);
        nextUsed.add(cand.answer);
        const solved = search(nextGrid, nextAssignments, nextUsed, states);
        if (solved) return solved;
      }

      return null;
    };

    return search(baseGrid, Array(slots.length).fill(null), new Set<string>(), { count: 0 });
  };

  const slotFitScore = (slot: PatternSlot) => {
    const total = totalByLen.get(slot.len)?.length ?? 0;
    const thematic = thematicByLen.get(slot.len)?.length ?? 0;
    const lengthFit =
      slot.len >= 4 && slot.len <= 7
        ? 6000
        : slot.len === 8
        ? 3200
        : slot.len === 3
        ? 1500
        : -4500;
    return lengthFit + Math.min(thematic, 14) * 260 + Math.min(total, 28) * 80;
  };

  const targetCounts = [15, 16, 17, 18];
  let masksWithEnoughSlots = 0;
  let masksWithCrossings = 0;
  let masksWithLengthSupply = 0;
  let solvedAttempts = 0;
  let firstLengthCompatibleMask: { rows: string[]; lengths: Record<number, number> } | null = null;
  for (const targetSlotCount of targetCounts) {
    for (let patternIdx = 0; patternIdx < PATTERN_11X11S.length; patternIdx++) {
      if (!nowOk()) return null;
      const pattern = PATTERN_11X11S[patternIdx];
      const fullSlots = extractPatternSlots(pattern);
      const availableSlotIndexes = fullSlots
        .map((slot, idx) => ({ slot, idx }))
        .filter(({ slot }) => (totalByLen.get(slot.len)?.length ?? 0) > 0)
        .map(({ idx }) => idx);

      if (availableSlotIndexes.length < targetSlotCount) continue;

      for (let variant = 0; variant < 360; variant++) {
        if (!nowOk()) return null;
        const rng = makeSeededRng((seed + targetSlotCount * 1009 + patternIdx * 104729 + variant * 2654435761) >>> 0);
        const selected = new Set<number>();
        const orderedSeeds = availableSlotIndexes
          .slice()
          .sort((a, b) => slotFitScore(fullSlots[b]) - slotFitScore(fullSlots[a]) || slotDegree(fullSlots, b) - slotDegree(fullSlots, a));
        shuffleInPlace(orderedSeeds, rng);
        orderedSeeds.sort((a, b) => slotFitScore(fullSlots[b]) - slotFitScore(fullSlots[a]) || slotDegree(fullSlots, b) - slotDegree(fullSlots, a));
        selected.add(orderedSeeds[0]);

        while (selected.size < targetSlotCount) {
          const choices = availableSlotIndexes.filter((idx) => !selected.has(idx));
          if (choices.length === 0) break;
          const ranked = choices
            .map((idx) => {
              const crosses = slotCrossCount(fullSlots, idx, selected);
              const thematic = thematicByLen.get(fullSlots[idx].len)?.length ?? 0;
              const total = totalByLen.get(fullSlots[idx].len)?.length ?? 0;
              return {
                idx,
                score:
                  crosses * 10000 +
                  slotFitScore(fullSlots[idx]) +
                  Math.min(thematic, 12) * 250 +
                  Math.min(total, 20) * 60 +
                  slotDegree(fullSlots, idx) * 120 +
                  rng(),
              };
            })
            .sort((a, b) => b.score - a.score);
          selected.add(ranked[0].idx);
        }

        for (let repair = 0; repair < 6; repair++) {
          const weak = Array.from(selected).filter(
            (idx) => slotCrossCount(fullSlots, idx, selected) < minCrossingsPerEntryForPublish(size)
          );
          if (weak.length === 0) break;
          const additions = availableSlotIndexes
            .filter((idx) => !selected.has(idx))
            .map((idx) => ({
              idx,
              score:
                weak.filter((weakIdx) => {
                  const probe = new Set(selected);
                  probe.add(idx);
                  return slotCrossCount(fullSlots, weakIdx, probe) > slotCrossCount(fullSlots, weakIdx, selected);
                }).length *
                  10000 +
                slotCrossCount(fullSlots, idx, selected) * 1000 +
                (thematicByLen.get(fullSlots[idx].len)?.length ?? 0) * 50,
            }))
            .sort((a, b) => b.score - a.score);
          if (additions.length === 0 || additions[0].score <= 0 || selected.size >= 18) break;
          selected.add(additions[0].idx);
        }

        if (selected.size < targetSlotCount || selected.size > 18) continue;
        masksWithEnoughSlots++;
        if (
          Array.from(selected).some(
            (idx) => slotCrossCount(fullSlots, idx, selected) < minCrossingsPerEntryForPublish(size)
          )
        ) {
          continue;
        }
        masksWithCrossings++;

        const maskPattern = buildMaskPattern(fullSlots, selected);
        if (hasShortLetterRuns(maskPattern.map((row) => row.split("")), minLen)) continue;
        const compactSlots = extractPatternSlots(maskPattern);
        if (compactSlots.length < minPublishEntriesForSize(size) || compactSlots.length > 18) continue;
        const allCompactSlotsCrossed = compactSlots.every((_, idx) => {
          const others = new Set(compactSlots.map((__, i) => i).filter((i) => i !== idx));
          return slotCrossCount(compactSlots, idx, others) >= minCrossingsPerEntryForPublish(size);
        });
        if (!allCompactSlotsCrossed) continue;

        const candidateByLen = candidatePoolForSlots(compactSlots, rng);
        if (compactSlots.some((slot) => (candidateByLen.get(slot.len)?.length ?? 0) === 0)) continue;
        const needByLen = new Map<number, number>();
        for (const slot of compactSlots) {
          needByLen.set(slot.len, (needByLen.get(slot.len) ?? 0) + 1);
        }
        if (
          Array.from(needByLen).some(
            ([len, need]) => (candidateByLen.get(len)?.length ?? 0) < need
          )
        ) {
          continue;
        }
        masksWithLengthSupply++;
        if (!firstLengthCompatibleMask) {
          firstLengthCompatibleMask = {
            rows: maskPattern,
            lengths: Object.fromEntries(needByLen),
          };
          console.warn("[compact-pattern-11] first length-compatible mask", firstLengthCompatibleMask);
        }

        const solved = solveSlots(compactSlots, maskPattern, candidateByLen);
        if (!solved) continue;
        solvedAttempts++;

        const finalGrid = solved.grid.map((row) =>
          row.map((cell) => (cell === "#" ? "#" : typeof cell === "string" && cell.length === 1 ? cell : "#"))
        );
        const derived = deriveEntriesFromGrid(finalGrid, minLen);
        if (derived.length < minPublishEntriesForSize(size) || derived.length > 18) continue;
        if (hasShortLetterRuns(finalGrid, minLen)) continue;
        const crossings = entryCrossingStats(finalGrid, derived, minLen);
        if (crossings.weakEntries.length > 0) continue;

        const assignedAnswers = solved.assignments.filter((answer): answer is string => Boolean(answer));
        return {
          grid: finalGrid,
          usedAnswers: assignedAnswers,
          meta: {
            builder: "compact-pattern-11x11",
            slotCount: compactSlots.length,
            targetSlotCount,
            patternVariant: variant,
            patternRows: maskPattern,
            minEntryCheckedCells: crossings.minCheckedCells,
          },
        };
      }
    }
  }

  console.warn("[compact-pattern-11] exhausted", {
    candidates: usable.length,
    lenCount: Object.fromEntries(
      Array.from(totalByLen.entries()).map(([len, items]) => [len, items.length])
    ),
    masksWithEnoughSlots,
    masksWithCrossings,
    masksWithLengthSupply,
    solvedAttempts,
    firstLengthCompatibleMask,
  });
  return null;
}

function constructBeamCrossword11(opts: {
  theme: string;
  size: number;
  candidates: WordCandidate[];
  seed: number;
  deadlineMs?: number;
}): { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null {
  const { theme, size, seed, deadlineMs } = opts;
  if (size !== 11) return null;

  const minLen = minEntryLenForSize(size);
  const nowOk = () => !deadlineMs || Date.now() <= deadlineMs;
  const rng = makeSeededRng(seed);
  const sourceRank = (candidate: WordCandidate) =>
    candidate.source === "anchor" ? 4 : candidate.source === "model" ? 3 : candidate.source === "support" ? -2 : 1;
  const wordRank = (candidate: WordCandidate) => {
    const len = candidate.answer.length;
    const lengthScore = len >= 4 && len <= 8 ? 80 - Math.abs(6 - len) * 6 : 40 - Math.abs(7 - len);
    return (candidate.thematic ? 40000 : 0) + sourceRank(candidate) * 800 + lengthScore;
  };

  const candidates = Array.from(
    new Map(
      opts.candidates
        .filter((c) => c.answer.length >= minLen && c.answer.length <= size)
        .filter((c) => ASCII_A_TO_Z.test(c.answer))
        .filter((c) => !isForbiddenPublishAnswer(c.answer))
        .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer))
        .sort((a, b) => wordRank(b) - wordRank(a) || a.answer.localeCompare(b.answer))
        .map((c) => [c.answer, c] as const)
    ).values()
  ).slice(0, 130);

  const themeSet = new Set(candidates.filter((c) => c.thematic).map((c) => c.answer));
  const allowedSet = new Set(candidates.map((c) => c.answer));
  if (themeSet.size < minCoreThematicEntriesForPublish(size, minPublishEntriesForSize(size))) {
    console.warn("[beam-11x11] skip: not enough thematic candidates", {
      candidates: candidates.length,
      thematic: themeSet.size,
    });
    return null;
  }

  type BeamState = {
    grid: Cell[][];
    placed: Placement[];
    used: Set<string>;
    score: number;
  };

  const cellsForPlacement = (placement: Placement) =>
    Array.from({ length: placement.word.length }, (_, i) => ({
      r: placement.dir === "across" ? placement.row : placement.row + i,
      c: placement.dir === "across" ? placement.col + i : placement.col,
    }));

  const overlapsSameDirection = (placement: Placement, placed: Placement[]) => {
    const cells = new Set(cellsForPlacement(placement).map((cell) => `${cell.r},${cell.c}`));
    return placed.some((existing) => {
      if (existing.dir !== placement.dir) return false;
      return cellsForPlacement(existing).some((cell) => cells.has(`${cell.r},${cell.c}`));
    });
  };

  const cloneGrid = (grid: Cell[][]) => grid.map((row) => row.slice()) as Cell[][];

  const finalFromState = (state: BeamState) => {
    const finalGrid = gridToStrings(paintBlocks(state.grid) as (string | null)[][]);
    const derived = deriveEntriesFromGrid(finalGrid, minLen);
    return { finalGrid, derived };
  };

  const finalScore = (state: BeamState) => {
    const { finalGrid, derived } = finalFromState(state);
    const invalidEntries = derived.filter(
      (entry) => !allowedSet.has(entry.answer) || isForbiddenPublishAnswer(entry.answer)
    ).length;
    const shortRunPenalty = hasShortLetterRuns(finalGrid, minLen) ? 50000 : 0;

    const crossings = entryCrossingStats(finalGrid, derived, minLen);
    const themed = derived.filter((entry) => themeSet.has(entry.answer)).length;
    const across = derived.filter((entry) => entry.direction === "across").length;
    const down = derived.length - across;
    const density = crosswordDensityFromGrid(finalGrid);
    const weakPenalty =
      crossings.weakEntries.length *
      (derived.length >= minPublishEntriesForSize(size) ? 100000 : 1800);

    return (
      derived.length * 14500 +
      state.placed.length * 4200 +
      Math.min(themed, derived.length) * 18000 +
      Math.min(across, down) * 4500 +
      density * 8000 +
      crossings.minCheckedCells * 3000 -
      weakPenalty -
      invalidEntries * 35000 -
      shortRunPenalty
    );
  };

  const buildSeedStates = () => {
    const seedWords = candidates
      .filter((c) => c.thematic)
      .filter((c) => c.answer.length >= 5 && c.answer.length <= 9)
      .slice(0, 24);
    const states: BeamState[] = [];

    for (const candidate of seedWords) {
      for (const dir of ["across", "down"] as Direction[]) {
        const row = dir === "across" ? Math.floor(size / 2) : Math.floor((size - candidate.answer.length) / 2);
        const col = dir === "across" ? Math.floor((size - candidate.answer.length) / 2) : Math.floor(size / 2);
        const grid = makeEmptyWorkingGrid(size);
        const wrote = placeWord(grid, candidate.answer, row, col, dir);
        if (!wrote) continue;
        states.push({
          grid,
          placed: [{ word: candidate.answer, row, col, dir }],
          used: new Set([candidate.answer]),
          score: wordRank(candidate),
        });
      }
    }

    shuffleInPlace(states, rng);
    return states.slice(0, 22);
  };

  const candidatePlacements = (state: BeamState) => {
    const out: Array<{ candidate: WordCandidate; placement: Placement; crossings: number; score: number }> = [];

    for (const candidate of candidates) {
      if (state.used.has(candidate.answer)) continue;
      for (const existing of state.placed) {
        const dir: Direction = existing.dir === "across" ? "down" : "across";
        for (let existingIndex = 0; existingIndex < existing.word.length; existingIndex++) {
          const ch = existing.word[existingIndex];
          const crossR = existing.dir === "across" ? existing.row : existing.row + existingIndex;
          const crossC = existing.dir === "across" ? existing.col + existingIndex : existing.col;
          for (let candidateIndex = 0; candidateIndex < candidate.answer.length; candidateIndex++) {
            if (candidate.answer[candidateIndex] !== ch) continue;
            const row = dir === "across" ? crossR : crossR - candidateIndex;
            const col = dir === "across" ? crossC - candidateIndex : crossC;
            const placement = { word: candidate.answer, row, col, dir };
            if (overlapsSameDirection(placement, state.placed)) continue;
            const check = canPlaceWord(state.grid, candidate.answer, row, col, dir);
            if (!check.ok || check.crossings < 1) continue;

            const mid = (size - 1) / 2;
            const centerR = dir === "down" ? row + (candidate.answer.length - 1) / 2 : row;
            const centerC = dir === "across" ? col + (candidate.answer.length - 1) / 2 : col;
            const centerPenalty = Math.abs(centerR - mid) + Math.abs(centerC - mid);
            const score =
              wordRank(candidate) +
              check.crossings * 5200 +
              (candidate.answer.length >= 4 && candidate.answer.length <= 8 ? 1700 : 0) -
              centerPenalty * 90;
            out.push({ candidate, placement, crossings: check.crossings, score });
          }
        }
      }
    }

    out.sort((a, b) => b.score - a.score || b.crossings - a.crossings);
    return out.slice(0, 420);
  };

  let beam = buildSeedStates();
  console.warn("[beam-11x11] start", {
    candidates: candidates.length,
    thematic: themeSet.size,
    seeds: beam.length,
  });
  let best: BeamState | null = null;
  let bestScore = -Infinity;
  let expanded = 0;
  const beamWidth = 260;
  const maxExpanded = 12000;

  for (let depth = 1; depth < 20 && beam.length > 0 && nowOk(); depth++) {
    const next: BeamState[] = [];

    for (const state of beam) {
      if (!nowOk() || expanded >= maxExpanded) break;
      expanded++;

      const score = finalScore(state);
      if (score > bestScore) {
        bestScore = score;
        best = state;
      }

      for (const option of candidatePlacements(state)) {
        const nextGrid = cloneGrid(state.grid);
        const wrote = placeWord(nextGrid, option.candidate.answer, option.placement.row, option.placement.col, option.placement.dir);
        if (!wrote) continue;
        const nextUsed = new Set(state.used);
        nextUsed.add(option.candidate.answer);
        next.push({
          grid: nextGrid,
          placed: state.placed.concat(option.placement),
          used: nextUsed,
          score: state.score + option.score,
        });
      }
    }

    next.sort((a, b) => {
      const finalDiff = finalScore(b) - finalScore(a);
      if (finalDiff !== 0) return finalDiff;
      return b.score - a.score;
    });
    beam = next.slice(0, beamWidth);
  }

  const finalists = best ? [best, ...beam] : beam;
  finalists.sort((a, b) => finalScore(b) - finalScore(a));

  for (const state of finalists.slice(0, 90)) {
    const { finalGrid, derived } = finalFromState(state);
    if (derived.some((entry) => !allowedSet.has(entry.answer))) continue;
    if (derived.some((entry) => isForbiddenPublishAnswer(entry.answer))) continue;
    if (!isAcceptable(finalGrid, derived, themeSet)) continue;
    const crossings = entryCrossingStats(finalGrid, derived, minLen);
    const usedAnswers = derived.map((entry) => entry.answer);
    return {
      grid: finalGrid,
      usedAnswers,
      meta: {
        builder: "beam-11x11",
        placedWords: state.placed.length,
        expanded,
        minEntryCheckedCells: crossings.minCheckedCells,
      },
    };
  }

  if (best) {
    const { finalGrid, derived } = finalFromState(best);
    const crossings = entryCrossingStats(finalGrid, derived, minLen);
    console.warn("[beam-11x11] no acceptable finalist", {
      expanded,
      finalists: finalists.length,
      bestEntries: derived.length,
      bestThematic: derived.filter((entry) => themeSet.has(entry.answer)).length,
      bestWeakEntries: crossings.weakEntries.length,
      bestDensity: crosswordDensityFromGrid(finalGrid),
      bestAnswers: derived.map((entry) => entry.answer),
    });
  } else {
    console.warn("[beam-11x11] no states expanded", { expanded });
  }

  return null;
}

function constructStrictCrossword11(opts: {
  theme: string;
  size: number;
  candidates: WordCandidate[];
  seed: number;
  deadlineMs?: number;
}): { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null {
  const { theme, size, candidates, seed, deadlineMs } = opts;
  if (size !== 11) return null;

  const cleanCandidates = candidates.filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer));
  const thematicCore = cleanCandidates.filter((c) => c.thematic);
  const limitedShortSupport = cleanCandidates
    .filter(
      (c) =>
        !c.thematic &&
        c.source === "support" &&
        c.answer.length >= minEntryLenForSize(size) + 1 &&
        c.answer.length <= 7
    )
    .slice(0, Math.max(3, Math.floor(thematicCore.length / 4)));
  const thematicCoreWithLimitedSupport = [...thematicCore, ...limitedShortSupport];
  const thematicPlusSupport = cleanCandidates.filter(
    (c) => c.thematic || c.source === "support" || c.source === "anchor" || c.source === "model"
  );

  const candidatePools = [
    thematicCore,
    thematicCoreWithLimitedSupport,
    thematicPlusSupport,
    cleanCandidates,
  ].filter((pool, idx, arr) => pool.length > 0 && arr.findIndex((other) => other === pool) === idx);

  const preferredPatternDeadlineMs = deadlineMs
    ? Math.min(deadlineMs, Date.now() + 20_000)
    : Date.now() + 20_000;
  const preferredPattern = constructPatternCrossword11({
    theme,
    size,
    candidates: cleanCandidates,
    seed: (seed ^ 0x243f6a88) >>> 0,
    deadlineMs: preferredPatternDeadlineMs,
  });
  if (preferredPattern) return preferredPattern;

  const seedVariants = 4;
  const childDeadline = (sliceMs: number) => {
    const localDeadline = Date.now() + sliceMs;
    return deadlineMs ? Math.min(deadlineMs, localDeadline) : localDeadline;
  };
  const hasTimeFor = (sliceMs: number) => !deadlineMs || Date.now() < deadlineMs - sliceMs;

  for (let poolIdx = 0; poolIdx < candidatePools.length; poolIdx++) {
    const pool = candidatePools[poolIdx];
    for (let variant = 0; variant < seedVariants; variant++) {
      if (!hasTimeFor(500)) return null;
      const variantSeed = (seed + variant * 2654435761 + poolIdx * 104729) >>> 0;
      const compactDeadlineMs = childDeadline(4_500);
      const compactBuilt =
        Date.now() < compactDeadlineMs - 100
          ? constructCompactPatternCrossword11({
              theme,
              size,
              candidates: pool,
              seed: variantSeed,
              deadlineMs: compactDeadlineMs,
            })
          : null;

      const beamDeadlineMs = childDeadline(4_500);
      const beamBuilt =
        !compactBuilt && variant === 0 && Date.now() < beamDeadlineMs - 100
          ? constructBeamCrossword11({
              theme,
              size,
              candidates: pool,
              seed: variantSeed,
              deadlineMs: beamDeadlineMs,
            })
          : null;

      const patternDeadlineMs = childDeadline(3_000);
      const patternBuilt =
        !compactBuilt && !beamBuilt && Date.now() < patternDeadlineMs - 100
          ? constructPatternCrossword11({
              theme,
              size,
              candidates: pool,
              seed: variantSeed,
              deadlineMs: patternDeadlineMs,
            })
          : null;

      const greedyDeadlineMs = childDeadline(3_500);
      const greedyBuilt =
        !compactBuilt && !beamBuilt && !patternBuilt && Date.now() < greedyDeadlineMs - 100
          ? constructGreedyCheckedCrossword11({
              theme,
              size,
              candidates: pool,
              seed: variantSeed,
              deadlineMs: greedyDeadlineMs,
            })
          : null;

      const built =
        compactBuilt ?? beamBuilt ?? patternBuilt ?? greedyBuilt;
      if (!built) continue;
      const builtDerived = deriveEntriesFromGrid(built.grid, minEntryLenForSize(size));
      if (builtDerived.length < minPublishEntriesForSize(size)) continue;

      return {
        ...built,
        meta: {
          ...built.meta,
          builder: "pattern-11x11-strict",
          strictPoolVariant: poolIdx,
          strictSeedVariant: variant,
        },
      };
    }
  }

  return null;
}

function constructGreedyCheckedCrossword11(opts: {
  theme: string;
  size: number;
  candidates: WordCandidate[];
  seed: number;
  deadlineMs?: number;
}): { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null {
  const { theme, size, seed, deadlineMs } = opts;
  if (size !== 11) return null;

  const minLen = minEntryLenForSize(size);
  const allowed = new Set(
    opts.candidates
      .filter((candidate) => candidate.source !== "filler")
      .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
      .filter((candidate) => candidate.answer.length >= minLen && candidate.answer.length <= size)
      .filter((candidate) => ASCII_A_TO_Z.test(candidate.answer))
      .filter((candidate) => !isForbiddenPublishAnswer(candidate.answer))
      .map((candidate) => candidate.answer)
  );
  const byAnswer = new Map(opts.candidates.map((candidate) => [candidate.answer, candidate]));
  const words = Array.from(allowed).sort((a, b) => {
    const ca = byAnswer.get(a);
    const cb = byAnswer.get(b);
    const themeDelta = Number(Boolean(cb?.thematic)) - Number(Boolean(ca?.thematic));
    if (themeDelta !== 0) return themeDelta;
    return b.length - a.length;
  });

  if (words.length < minPublishEntriesForSize(size)) return null;

  type Placed = { answer: string; row: number; col: number; direction: Direction };
  type Placement = Placed & { score: number; crossings: number };

  const directions: Direction[] = ["across", "down"];
  const nowOk = (reserveMs = 0) => !deadlineMs || Date.now() < deadlineMs - reserveMs;

  const buildFinalGrid = (grid: (string | null)[][]): string[][] =>
    grid.map((row) => row.map((cell) => cell ?? "#"));

  const canPlace = (
    grid: (string | null)[][],
    answer: string,
    row: number,
    col: number,
    direction: Direction,
    requireCrossing: boolean
  ): { ok: boolean; crossings: number; crossedAnswers: Set<string> } => {
    const dr = direction === "down" ? 1 : 0;
    const dc = direction === "across" ? 1 : 0;
    const beforeR = row - dr;
    const beforeC = col - dc;
    const afterR = row + dr * answer.length;
    const afterC = col + dc * answer.length;

    if (!inBounds(size, row, col)) return { ok: false, crossings: 0, crossedAnswers: new Set() };
    if (!inBounds(size, row + dr * (answer.length - 1), col + dc * (answer.length - 1))) {
      return { ok: false, crossings: 0, crossedAnswers: new Set() };
    }
    if (inBounds(size, beforeR, beforeC) && grid[beforeR][beforeC]) {
      return { ok: false, crossings: 0, crossedAnswers: new Set() };
    }
    if (inBounds(size, afterR, afterC) && grid[afterR][afterC]) {
      return { ok: false, crossings: 0, crossedAnswers: new Set() };
    }

    let crossings = 0;
    const crossedAnswers = new Set<string>();

    for (let i = 0; i < answer.length; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      const existing = grid[r][c];
      const ch = answer[i];

      if (existing && existing !== ch) return { ok: false, crossings: 0, crossedAnswers };

      if (existing === ch) {
        crossings++;
        continue;
      }

      const side1R = r + (direction === "across" ? -1 : 0);
      const side1C = c + (direction === "down" ? -1 : 0);
      const side2R = r + (direction === "across" ? 1 : 0);
      const side2C = c + (direction === "down" ? 1 : 0);
      if (inBounds(size, side1R, side1C) && grid[side1R][side1C]) {
        return { ok: false, crossings: 0, crossedAnswers };
      }
      if (inBounds(size, side2R, side2C) && grid[side2R][side2C]) {
        return { ok: false, crossings: 0, crossedAnswers };
      }
    }

    if (requireCrossing && crossings === 0) return { ok: false, crossings: 0, crossedAnswers };
    return { ok: true, crossings, crossedAnswers };
  };

  const place = (grid: (string | null)[][], placed: Placed[], placement: Placed) => {
    const dr = placement.direction === "down" ? 1 : 0;
    const dc = placement.direction === "across" ? 1 : 0;
    for (let i = 0; i < placement.answer.length; i++) {
      grid[placement.row + dr * i][placement.col + dc * i] = placement.answer[i];
    }
    placed.push(placement);
  };

  let best:
    | {
        grid: string[][];
        derived: DerivedEntry[];
        score: number;
        usedAnswers: string[];
        weakEntries: number;
      }
    | null = null;

  const seedAttempts = Math.min(18, words.length);
  for (let attempt = 0; attempt < seedAttempts && nowOk(250); attempt++) {
    const rng = makeSeededRng((seed ^ Math.imul(attempt + 1, 0x9e3779b9)) >>> 0);
    const grid: (string | null)[][] = Array.from({ length: size }, () => Array<string | null>(size).fill(null));
    const placed: Placed[] = [];
    const used = new Set<string>();
    const starts = words.slice(0, Math.min(24, words.length));
    shuffleInPlace(starts, rng);
    const first = starts[0];
    if (!first) continue;

    const firstDirection: Direction = attempt % 2 === 0 ? "across" : "down";
    const firstRow = firstDirection === "across" ? Math.floor(size / 2) : Math.floor((size - first.length) / 2);
    const firstCol = firstDirection === "across" ? Math.floor((size - first.length) / 2) : Math.floor(size / 2);
    place(grid, placed, { answer: first, row: firstRow, col: firstCol, direction: firstDirection });
    used.add(first);

    for (let step = 0; step < 80 && placed.length < desiredPublishEntriesForSize(size) && nowOk(100); step++) {
      const placements: Placement[] = [];
      const ordered = words.filter((word) => !used.has(word));
      shuffleInPlace(ordered, rng);

      for (const answer of ordered.slice(0, 70)) {
        for (let r = 0; r < size; r++) {
          for (let c = 0; c < size; c++) {
            if (!grid[r][c]) continue;
            for (let i = 0; i < answer.length; i++) {
              if (answer[i] !== grid[r][c]) continue;
              for (const direction of directions) {
                const row = direction === "down" ? r - i : r;
                const col = direction === "across" ? c - i : c;
                const result = canPlace(grid, answer, row, col, direction, true);
                if (!result.ok) continue;
                const candidate = byAnswer.get(answer);
                const score =
                  result.crossings * 2400 +
                  (candidate?.thematic ? 900 : 0) +
                  Math.min(answer.length, 8) * 120 +
                  rng() * 50;
                placements.push({ answer, row, col, direction, score, crossings: result.crossings });
              }
            }
          }
        }
      }

      if (placements.length === 0) break;
      placements.sort((a, b) => b.score - a.score);
      const chosen = placements[Math.floor(rng() * Math.min(8, placements.length))];
      const confirm = canPlace(grid, chosen.answer, chosen.row, chosen.col, chosen.direction, true);
      if (!confirm.ok) continue;
      place(grid, placed, chosen);
      used.add(chosen.answer);
    }

    const finalGrid = buildFinalGrid(grid);
    const derived = deriveEntriesFromGrid(finalGrid, minLen);
    if (derived.some((entry) => !allowed.has(entry.answer))) continue;
    if (hasShortLetterRuns(finalGrid, minLen)) continue;
    const entryCrossings = entryCrossingStats(finalGrid, derived, minLen);
    const checked = checkedCellStats(finalGrid, minLen);
    const thematicEntries = derived.filter((entry) => byAnswer.get(entry.answer)?.thematic).length;
    const weakEntries = entryCrossings.weakEntries.length;
    const score =
      derived.length * 7000 +
      thematicEntries * 1300 +
      checked.ratio * 4000 -
      weakEntries * 25000;

    if (!best || score > best.score) {
      best = {
        grid: finalGrid,
        derived,
        score,
        usedAnswers: derived.map((entry) => entry.answer),
        weakEntries,
      };
    }

    if (derived.length >= minPublishEntriesForSize(size) && weakEntries === 0) {
      return {
        grid: finalGrid,
        usedAnswers: derived.map((entry) => entry.answer),
        meta: {
          builder: "greedy-checked-11",
          attempts: attempt + 1,
          checkedRatio: checked.ratio,
          minEntryCheckedCells: entryCrossings.minCheckedCells,
        },
      };
    }
  }

  if (best) {
    console.warn("[greedy-checked-11] no acceptable finalist", {
      bestEntries: best.derived.length,
      bestWeakEntries: best.weakEntries,
      bestAnswers: best.usedAnswers,
    });
  }

  return null;
}

function constructFreeformCrossword(opts: {
  size: number;
  candidates: WordCandidate[];
  seed: number;
  deadlineMs?: number;
  maxPlacedWords?: number;
  maxBuilds?: number;
}): { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null {
  const { size, candidates, seed } = opts;
  console.warn("[freeform] ENTER constructFreeformCrossword", { size, seed, candidates: candidates.length });

  const deadline = opts.deadlineMs;
  const nowOk = () => !deadline || Date.now() <= deadline;

  const minLen = minEntryLenForSize(size);

  const rawWords = candidates
    .filter((c) => c.answer.length >= minLen && c.answer.length <= size && ASCII_A_TO_Z.test(c.answer))
    .sort((a, b) => {
      if (size === 11) {
        const score = (candidate: WordCandidate) => {
          const len = candidate.answer.length;
          const lengthBand =
            len >= 5 && len <= 7 ? 500 :
            len === 4 || len === 8 ? 380 :
            len === 9 ? 180 :
            len >= 10 ? 60 :
            0;
          const sourceBonus =
            candidate.source === "model" || candidate.source === "anchor" ? 90 :
            candidate.source === "support" ? 20 :
            0;
          return (candidate.thematic ? 1000 : 0) + sourceBonus + lengthBand;
        };
        const diff = score(b) - score(a);
        if (diff !== 0) return diff;
        return a.answer.length - b.answer.length;
      }
      if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
      return b.answer.length - a.answer.length;
    })
    .map((c) => c.answer);

  if (rawWords.length === 0) return null;

  const uniq = Array.from(new Set(rawWords));

  const byLen = new Map<number, string[]>();
  for (const w of uniq) {
    const L = w.length;
    const arr = byLen.get(L) ?? [];
    arr.push(w);
    byLen.set(L, arr);
  }
 const lengthPriority = (L: number) => {
  if (size === 11) {
    if (L >= 5 && L <= 7) return 300 + L;
    if (L === 4 || L === 8) return 200 + L;
    return 100 + L;
  }

  return L;
};

const lengths = Array.from(byLen.keys()).sort(
  (a, b) => lengthPriority(b) - lengthPriority(a)
);

  const maxPlaced = opts.maxPlacedWords ?? (size === 9 ? 48 : size === 11 ? 140 : 132);

  const targetDensity = size === 9 ? 0.60 : size === 11 ? 0.68 : 0.56;
  const maxBuilds = opts.maxBuilds ?? (size === 9 ? 10 : size === 11 ? 24 : 18);
  const rounds = size === 9 ? 4 : size === 11 ? 28 : 6;

  type BuildResult = { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> };

  const buildOnce = (localSeed: number): BuildResult | null => {
    const rng = makeSeededRng(localSeed);

    const words: string[] = [];
    for (const L of lengths) {
      const bucket = (byLen.get(L) ?? []).slice();
      shuffleInPlace(bucket, rng);
      words.push(...bucket);
    }
    if (words.length === 0) return null;
    const allBuildAnswerSet = new Set(words);

    const grid = makeEmptyWorkingGrid(size);
    const placed: Placement[] = [];
    const nonFillerWords = new Set(
      candidates.filter((c) => c.source !== "filler").map((c) => c.answer)
    );
    const startRow = Math.floor(size / 2);

    // Seed: try a handful of candidate seed words and both orientations.
    let seedWord: string | null = null;
    let seedDir: Direction = "across";
    let seedCol = 0;

const seedMinLen = size === 9 ? 5 : size === 11 ? 6 : 7;
const seedMaxLen = size === 9 ? 7 : size === 11 ? 8 : 9;

const buildLetterFreq = (pool: string[]) => {
  const freq = new Map<string, number>();
  for (const w of pool) {
    const uniqLetters = new Set(w.split(""));
    for (const ch of uniqLetters) {
      freq.set(ch, (freq.get(ch) ?? 0) + 1);
    }
  }
  return freq;
};

const letterFreq = buildLetterFreq(words);

const seedCrossabilityScore = (w: string) => {
  let score = 0;
  const uniqLetters = new Set(w.split(""));

  for (const ch of uniqLetters) {
    score += letterFreq.get(ch) ?? 0;
  }

  let pairLinks = 0;
  for (const other of words) {
    if (other === w) continue;
    let shared = 0;
    const otherSet = new Set(other.split(""));
    for (const ch of uniqLetters) {
      if (otherSet.has(ch)) shared++;
    }
    if (shared >= 2) pairLinks += 1;
    else if (shared >= 1) pairLinks += 0.35;
  }

  const lengthBonus =
    w.length >= seedMinLen && w.length <= seedMaxLen ? 40 : 0;

  const midLenBonus =
    w.length >= 5 && w.length <= 8 ? 18 : 0;

  const thematicSeedBonus = nonFillerWords.has(w) ? 100000 : 0;
  return thematicSeedBonus + score + pairLinks * 18 + lengthBonus + midLenBonus;
};

const preferredSeedWords = words
  .filter((w) => w.length >= Math.max(minLen, 4) && w.length <= size)
  .slice()
  .sort((a, b) => seedCrossabilityScore(b) - seedCrossabilityScore(a));

const seedCandidates = preferredSeedWords.slice(0, Math.min(size === 11 ? 18 : 12, preferredSeedWords.length));

const estimateSeedFollowups = (
  w: string,
  row: number,
  col: number,
  dir: Direction
) => {
  const scratch = makeEmptyWorkingGrid(size);
  const placedSeed = placeWord(scratch, w, row, col, dir);
  if (!placedSeed) return -1;

  const letters: Array<{ r: number; c: number; ch: string }> = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const v = scratch[r][c];
      if (v !== "" && v !== "#") letters.push({ r, c, ch: v as string });
    }
  }

  let possible = 0;

  for (const other of words) {
    if (other === w) continue;
    if (other.length < Math.max(minLen, 4) || other.length > size) continue;

    let foundForThisWord = false;

    for (let i = 0; i < other.length && !foundForThisWord; i++) {
      const ch = other[i];

      for (const cell of letters) {
        if (cell.ch !== ch) continue;

        const rowA = cell.r;
        const colA = cell.c - i;
        const checkA = canPlaceWord(scratch, other, rowA, colA, "across");
        if (checkA.ok && checkA.crossings >= 1) {
          possible++;
          foundForThisWord = true;
          break;
        }

        const rowD = cell.r - i;
        const colD = cell.c;
        const checkD = canPlaceWord(scratch, other, rowD, colD, "down");
        if (checkD.ok && checkD.crossings >= 1) {
          possible++;
          foundForThisWord = true;
          break;
        }
      }
    }
  }

  return possible;
};

type SeedOption = {
  word: string;
  row: number;
  col: number;
  dir: Direction;
  viability: number;
};

const seedOptions: SeedOption[] = [];

for (const w of seedCandidates) {
  const colAcross = Math.max(0, Math.floor((size - w.length) / 2));
  const rowAcross = startRow;

  const canA = canPlaceWord(grid, w, rowAcross, colAcross, "across");
  if (canA.ok) {
    const viabilityA = estimateSeedFollowups(w, rowAcross, colAcross, "across");
    if (viabilityA >= 0) {
      seedOptions.push({
        word: w,
        row: rowAcross,
        col: colAcross,
        dir: "across",
        viability: viabilityA * 100 + seedCrossabilityScore(w),
      });
    }
  }

  if (w.length <= size) {
    const rowDown = Math.max(0, Math.floor((size - w.length) / 2));
    const colDown = Math.floor(size / 2);
    const canD = canPlaceWord(grid, w, rowDown, colDown, "down");
    if (canD.ok) {
      const viabilityD = estimateSeedFollowups(w, rowDown, colDown, "down");
      if (viabilityD >= 0) {
        seedOptions.push({
          word: w,
          row: rowDown,
          col: colDown,
          dir: "down",
          viability: viabilityD * 100 + seedCrossabilityScore(w),
        });
      }
    }
  }
}

seedOptions.sort((a, b) => b.viability - a.viability);

const topSeedOptions = seedOptions.slice(0, Math.min(size === 11 ? 8 : 6, seedOptions.length));
shuffleInPlace(topSeedOptions, rng);

let seedRow = 0;

for (const s of topSeedOptions) {
  const placedSeed = placeWord(grid, s.word, s.row, s.col, s.dir);
  if (!placedSeed) continue;

  seedWord = s.word;
  seedDir = s.dir;
  seedRow = s.row;
  seedCol = s.col;
  break;
}

if (!seedWord) {
  console.warn("[freeform] seed failed", {
    size,
    tried: words.slice(0, Math.min(12, words.length)),
  });
  return null;
}

placed.push({
  word: seedWord,
  row: seedRow,
  col: seedCol,
  dir: seedDir,
});

    const used = new Set<string>([seedWord]);

const countLetters = (g: Cell[][]) =>
  g.reduce(
    (acc, row) => acc + row.filter((x) => typeof x === "string" && x !== "" && x !== "#").length,
    0
  );

console.warn("[freeform] after seed placement", {
  seedWord,
  letters: countLetters(grid)
});

    const filled = () => {
      const out: Array<{ r: number; c: number; ch: string }> = [];
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const v = grid[r][c];
          if (v !== "" && v !== "#") out.push({ r, c, ch: v as string });
        }
      }
      return out;
    };

    const rejectReasonCounts = new Map<string, number>();

    const tryWriteWordLoose = (
      target: Cell[][],
      word: string,
      row: number,
      col: number,
      dir: Direction
    ) => {
      let changed = false;

      for (let i = 0; i < word.length; i++) {
        const rr = dir === "down" ? row + i : row;
        const cc = dir === "across" ? col + i : col;

        if (!inBounds(size, rr, cc)) return { ok: false as const, crossings: 0, newCells: 0 };

        const cur = target[rr][cc];
        const ch = word[i];

        if (cur === "#") return { ok: false as const, crossings: 0, newCells: 0 };
        if (cur !== "" && cur !== ch) return { ok: false as const, crossings: 0, newCells: 0 };
      }

      let crossings = 0;
      let newCells = 0;

      for (let i = 0; i < word.length; i++) {
        const rr = dir === "down" ? row + i : row;
        const cc = dir === "across" ? col + i : col;
        const cur = target[rr][cc];
        const ch = word[i];

        if (cur === ch) crossings++;
        if (cur === "") {
          target[rr][cc] = ch;
          changed = true;
          newCells++;
        }
      }

      if (!changed) return { ok: false as const, crossings, newCells };
      return { ok: true as const, crossings, newCells };
    };

    const projectGridOutcome = (scratch: Cell[][]) => {
      let blocked = paintBlocks(scratch);
      blocked = enforceMinWordLen(blocked, minEntryLenForSize(size));

      const blockedBeforePrune = blocked.map((row) => row.slice());
      const prunedBlocked = pruneDanglingRuns(blocked, minEntryLenForSize(size));
      const derivedBeforePrune = deriveEntriesFromGrid(
        gridToStrings(blockedBeforePrune as (string | null)[][]),
        minEntryLenForSize(size)
      );
      const derivedAfterPrune = deriveEntriesFromGrid(
        gridToStrings(prunedBlocked as (string | null)[][]),
        minEntryLenForSize(size)
      );

      blocked =
        size === 11 ||
        derivedAfterPrune.length >= Math.max(4, Math.floor(derivedBeforePrune.length * 0.6))
          ? prunedBlocked
          : blockedBeforePrune;

      blocked = keepLargestConnectedComponent(blocked);
      blocked = keepLargestConnectedComponent(blocked);

      const final: string[][] = [];
      for (let r = 0; r < size; r++) {
        const outRow: string[] = [];
        for (let c = 0; c < size; c++) {
          const v = blocked[r][c];
          if (v === "#") {
            outRow.push("#");
            continue;
          }
          if (typeof v === "string" && v.length === 1) {
            if (/[A-Z]/.test(v)) {
              outRow.push(v);
              continue;
            }
            if (/[a-z]/.test(v)) {
              outRow.push(v.toUpperCase());
              continue;
            }
            if (/[0-9]/.test(v)) {
              outRow.push(v);
              continue;
            }
          }
          outRow.push("#");
        }
        final.push(outRow);
      }

      const derived = deriveEntriesFromGrid(final, minEntryLenForSize(size));
      const checked = checkedCellStats(final, minEntryLenForSize(size));
      const density = crosswordDensityFromGrid(final);
      const nonFillerUsed = derived.filter((e) => nonFillerWords.has(e.answer)).length;

      return {
        final,
        derived,
        checkedRatio: checked.ratio,
        density,
        nonFillerUsed,
      };
    };

    const evaluateLoosePlacement = (
      word: string,
      row: number,
      col: number,
      dir: Direction
    ) => {
      const scratch = grid.map((r) => r.slice()) as Cell[][];
      const wrote = tryWriteWordLoose(scratch, word, row, col, dir);
      if (!wrote.ok) return null;

      const projected = projectGridOutcome(scratch);
      const allowedAnswers = allBuildAnswerSet;

      if (
        size === 11 &&
        (hasShortLetterRuns(projected.final, minEntryLenForSize(size)) ||
          projected.derived.some((e) => !allowedAnswers.has(e.answer)) ||
          !projected.derived.some((e) => e.answer === word))
      ) {
        const rawGrid = gridToStrings(scratch);
        const rawDerived = deriveEntriesFromGrid(rawGrid, minEntryLenForSize(size));
        if (
          hasShortLetterRuns(rawGrid, minEntryLenForSize(size)) ||
          rawDerived.some((e) => !allowedAnswers.has(e.answer)) ||
          !rawDerived.some((e) => e.answer === word)
        ) {
          return null;
        }

        const rawChecked = checkedCellStats(rawGrid, minEntryLenForSize(size));
        const rawDensity = crosswordDensityFromGrid(rawGrid);
        const rawNonFillerUsed = rawDerived.filter((e) => nonFillerWords.has(e.answer)).length;
        return {
          final: rawGrid,
          derived: rawDerived,
          checkedRatio: rawChecked.ratio,
          density: rawDensity,
          nonFillerUsed: rawNonFillerUsed,
          score:
            rawDerived.length * 520 +
            rawChecked.ratio * 1800 +
            rawDensity * 120 +
            rawNonFillerUsed * 1000 +
            wrote.crossings * 80 +
            wrote.newCells * 18,
          crossings: wrote.crossings,
          newCells: wrote.newCells,
          scratch,
        };
      }

      if (hasShortLetterRuns(projected.final, minEntryLenForSize(size))) return null;
      if (projected.derived.some((e) => !allowedAnswers.has(e.answer))) return null;
      if (!projected.derived.some((e) => e.answer === word)) return null;

      const score =
        projected.derived.length * 600 +
        projected.checkedRatio * 2200 +
        projected.density * 180 +
        projected.nonFillerUsed * 1200 +
        wrote.crossings * 80 +
        wrote.newCells * 18;

      return {
        ...projected,
        score,
        crossings: wrote.crossings,
        newCells: wrote.newCells,
        scratch,
      };
    };

     const placementScore = (
      p: { row: number; col: number; dir: Direction; crossings: number },
      wlen: number
    ) => {

      const mid = (size - 1) / 2;
      const rCenter = p.row + (p.dir === "down" ? (wlen - 1) / 2 : 0);
      const cCenter = p.col + (p.dir === "across" ? (wlen - 1) / 2 : 0);
      const dist = Math.abs(rCenter - mid) + Math.abs(cCenter - mid);

      const touchesTop = p.row <= 0;
      const touchesLeft = p.col <= 0;
      const touchesBottom = p.dir === "down" ? p.row + wlen - 1 >= size - 1 : p.row >= size - 1;
      const touchesRight = p.dir === "across" ? p.col + wlen - 1 >= size - 1 : p.col >= size - 1;
      const borderTouches =
        (touchesTop ? 1 : 0) +
        (touchesLeft ? 1 : 0) +
        (touchesBottom ? 1 : 0) +
        (touchesRight ? 1 : 0);

      let newCells = 0;
      let sideOpenings = 0;
      let doubleSideOpenings = 0;

      for (let i = 0; i < wlen; i++) {
        const rr = p.dir === "down" ? p.row + i : p.row;
        const cc = p.dir === "across" ? p.col + i : p.col;
        const current = grid[rr][cc];
        const isNewCell = current === "";

        if (isNewCell) {
          newCells += 1;

          if (p.dir === "across") {
            const upOpen = rr > 0 && grid[rr - 1][cc] === "";
            const downOpen = rr < size - 1 && grid[rr + 1][cc] === "";
            if (upOpen) sideOpenings += 1;
            if (downOpen) sideOpenings += 1;
            if (upOpen && downOpen) doubleSideOpenings += 1;
          } else {
            const leftOpen = cc > 0 && grid[rr][cc - 1] === "";
            const rightOpen = cc < size - 1 && grid[rr][cc + 1] === "";
            if (leftOpen) sideOpenings += 1;
            if (rightOpen) sideOpenings += 1;
            if (leftOpen && rightOpen) doubleSideOpenings += 1;
          }
        }
      }

      const edgePenalty = borderTouches * (placed.length < 10 ? 18 : 8);
      const distancePenalty = dist * 2.25;
      const crossingScore = p.crossings * 120;
      const freshCellScore = newCells * 22;
      const openingScore = sideOpenings * 7 + doubleSideOpenings * 10;
      const lengthBonus =
        wlen >= 5 && wlen <= 8 ? 18 : wlen === 4 ? 8 : wlen >= 9 ? 6 : 0;

      return (
        crossingScore +
        freshCellScore +
        openingScore +
        lengthBonus -
        distancePenalty -
        edgePenalty
      );
    };

          const collectPlacements = (word: string, minCrossesWanted: number) => {
      const letters = filled();

      type Cand = {
        row: number;
        col: number;
        dir: Direction;
        crossings: number;
        score: number;
      };

      const placements: Cand[] = [];

      for (let i = 0; i < word.length; i++) {
        const ch = word[i];

        for (const cell of letters) {
          if (cell.ch !== ch) continue;

          const rowA = cell.r;
          const colA = cell.c - i;
          const checkA = canPlaceWord(grid, word, rowA, colA, "across");

          if (checkA.ok && checkA.crossings >= minCrossesWanted) {
            const base = {
              row: rowA,
              col: colA,
              dir: "across" as Direction,
              crossings: checkA.crossings,
            };
            placements.push({ ...base, score: placementScore(base, word.length) });
          } else if (!checkA.ok && checkA.reason) {
            rejectReasonCounts.set(
              checkA.reason,
              (rejectReasonCounts.get(checkA.reason) ?? 0) + 1
            );
          }

          const rowD = cell.r - i;
          const colD = cell.c;
          const checkD = canPlaceWord(grid, word, rowD, colD, "down");

          if (checkD.ok && checkD.crossings >= minCrossesWanted) {
            const base = {
              row: rowD,
              col: colD,
              dir: "down" as Direction,
              crossings: checkD.crossings,
            };
            placements.push({ ...base, score: placementScore(base, word.length) });
          } else if (!checkD.ok && checkD.reason) {
            rejectReasonCounts.set(
              checkD.reason,
              (rejectReasonCounts.get(checkD.reason) ?? 0) + 1
            );
          }
        }
      }

      const seen = new Set<string>();
      const unique = placements.filter((p) => {
        const key = `${p.row}:${p.col}:${p.dir}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      unique.sort((a, b) => b.score - a.score);
      return unique;
    };

    const collectPlacementsLoose = (word: string, minCrossesWanted: number) => {
      type Cand = {
        row: number;
        col: number;
        dir: Direction;
        crossings: number;
        score: number;
      };

      const out: Cand[] = [];

      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
          for (const dir of ["across", "down"] as const) {
            const scratch = grid.map((r) => r.slice()) as Cell[][];
            const wrote = tryWriteWordLoose(scratch, word, row, col, dir);
            if (!wrote.ok) continue;
            if (wrote.crossings < minCrossesWanted) continue;

            let sideOpenings = 0;
            for (let i = 0; i < word.length; i++) {
              const rr = dir === "down" ? row + i : row;
              const cc = dir === "across" ? col + i : col;
              if (grid[rr][cc] !== "") continue;

              if (dir === "across") {
                if (rr > 0 && grid[rr - 1][cc] === "") sideOpenings++;
                if (rr < size - 1 && grid[rr + 1][cc] === "") sideOpenings++;
              } else {
                if (cc > 0 && grid[rr][cc - 1] === "") sideOpenings++;
                if (cc < size - 1 && grid[rr][cc + 1] === "") sideOpenings++;
              }
            }

            const centerBias =
              Math.abs(row - Math.floor(size / 2)) + Math.abs(col - Math.floor(size / 2));

            out.push({
              row,
              col,
              dir,
              crossings: wrote.crossings,
              score:
                wrote.crossings * 110 +
                wrote.newCells * 16 +
                sideOpenings * 7 +
                (size - centerBias) * 4 +
                (word.length >= 5 && word.length <= 8 ? 24 : 0),
            });
          }
        }
      }

      const seen = new Set<string>();
      const unique = out.filter((p) => {
        const key = `${p.row}:${p.col}:${p.dir}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      unique.sort((a, b) => b.score - a.score);
      return unique;
    };

const commitPlacementChecked = (
  word: string,
  row: number,
  col: number,
  dir: Direction
): boolean => {
  const evalResult = evaluateLoosePlacement(word, row, col, dir);
  if (!evalResult) return false;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      grid[r][c] = evalResult.scratch[r][c];
    }
  }

  return true;
};

const tryPlaceOne = (word: string): boolean => {
  if (size === 11 && !nonFillerWords.has(word) && word.length <= 3) {
    return false;
  }

  const minCrossesWanted =
    size === 11
      ? placed.length < 11
        ? 1
        : 2
      : placed.length < 3
      ? 1
      : 2;

  let placements = collectPlacements(word, minCrossesWanted);

  if (placements.length === 0 && minCrossesWanted > 1 && size !== 11) {
    placements = collectPlacements(word, 1);
  }

  if (placements.length === 0 && (size !== 11 || minCrossesWanted <= 1)) {
    placements = collectPlacementsLoose(word, Math.max(1, minCrossesWanted - 1));
  }

  if (placements.length === 0) return false;

  const candidatesToTry = placements.slice(0, Math.min(size === 11 ? 24 : 14, placements.length));

  const evaluatedCandidates = candidatesToTry
    .map((p) => {
      const evalResult = evaluateLoosePlacement(word, p.row, p.col, p.dir);
      if (!evalResult) return null;
      return { placement: p, evalResult };
    })
    .filter((item): item is { placement: typeof placements[number]; evalResult: NonNullable<ReturnType<typeof evaluateLoosePlacement>> } => Boolean(item))
    .sort((a, b) => b.evalResult.score - a.evalResult.score);

  for (const { placement: p, evalResult } of evaluatedCandidates) {
    if (!nowOk()) return false;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        grid[r][c] = evalResult.scratch[r][c];
      }
    }
    placed.push({ word, row: p.row, col: p.col, dir: p.dir });
    used.add(word);
    return true;
  }

  return false;
};

const buildSecondAnchorOrder = () => {
  const candidatesForSecondAnchor = words
    .filter((w) => w !== seedWord && !used.has(w))
    .filter((w) => {
      if (size !== 11) return true;
      return w.length >= 4 && w.length <= 8;
    });

  return candidatesForSecondAnchor
    .slice()
    .sort((a, b) => {
      const aTheme = nonFillerWords.has(a) ? 1 : 0;
      const bTheme = nonFillerWords.has(b) ? 1 : 0;
      if (aTheme !== bTheme) return bTheme - aTheme;

      const rank = (w: string) => {
        if (w.length >= 5 && w.length <= 7) return 500;
        if (w.length === 8) return 420;
        if (w.length === 4) return 300;
        if (w.length === 9) return 180;
        if (w.length >= 10) return 60;
        return 0;
      };

      return rank(b) - rank(a) || a.length - b.length;
    });
};

const tryPlaceSecondAnchor = (): boolean => {
  let best:
    | {
        word: string;
        row: number;
        col: number;
        dir: Direction;
        score: number;
      }
    | null = null;

  for (const word of buildSecondAnchorOrder()) {
    const placements = collectPlacements(word, 1);
    if (placements.length === 0) continue;

    for (const p of placements.slice(0, Math.min(18, placements.length))) {
      const viability = estimateSeedFollowups(word, p.row, p.col, p.dir);
      if (viability < 2) continue;

      let newCells = 0;
      for (let i = 0; i < word.length; i++) {
        const rr = p.dir === "down" ? p.row + i : p.row;
        const cc = p.dir === "across" ? p.col + i : p.col;
        if (grid[rr][cc] === "") newCells++;
      }

      const thematicBonus = nonFillerWords.has(word) ? 60 : 0;
      const lengthBonus =
        word.length >= 5 && word.length <= 8 ? 40 :
        word.length === 4 ? 20 :
        word.length === 9 ? 14 :
        -10;

      const finalScore =
        p.score +
        thematicBonus +
        lengthBonus +
        viability * 120 +
        newCells * 18;

      if (!best || finalScore > best.score) {
        best = {
          word,
          row: p.row,
          col: p.col,
          dir: p.dir,
          score: finalScore,
        };
      }
    }
  }

if (!best) return false;

const committed = commitPlacementChecked(best.word, best.row, best.col, best.dir);
if (!committed) return false;

placed.push({
  word: best.word,
  row: best.row,
  col: best.col,
  dir: best.dir,
});
used.add(best.word);

  console.warn("[freeform] second anchor placed", {
    word: best.word,
    row: best.row,
    col: best.col,
    dir: best.dir,
    letters: countLetters(grid),
  });

  return true;
};

const extraAnchors = size === 11 ? 2 : 1;

for (let k = 0; k < extraAnchors; k++) {
  if (!nowOk()) break;
  if (placed.length >= maxPlaced) break;

  const added = tryPlaceSecondAnchor();
  if (!added) break;
}

const rest = words.filter((w) => w !== seedWord);

const buildGlobalOrder = () => {
  const remaining = rest.filter((w) => !used.has(w));

  return remaining
    .slice()
    .sort((a, b) => {
      const aTheme = nonFillerWords.has(a) ? 1 : 0;
      const bTheme = nonFillerWords.has(b) ? 1 : 0;
      if (aTheme !== bTheme) return bTheme - aTheme;

      const rank = (w: string) => {
        if (placed.length < 6) {
          if (w.length >= 5 && w.length <= 7) return 500;
          if (w.length === 8) return 380;
          if (w.length === 4) return 260;
          if (w.length === 9) return 180;
          return 80;
        }

        if (w.length >= 4 && w.length <= 6) return 520;
        if (w.length === 7) return 360;
        if (w.length === 8) return 200;
        if (w.length >= 9) return 80;
        return 0;
      };

      return rank(b) - rank(a) || a.length - b.length;
    });
};

const placeBestNextWord = (): boolean => {
  const order = buildGlobalOrder();

  for (const word of order) {
    if (!nowOk()) return false;
    if (used.has(word)) continue;
    if (placed.length >= maxPlaced) return false;

    const placedOne = tryPlaceOne(word);
    if (placedOne) return true;
  }

  return false;
};

const maxMainIterations = size === 11 ? 120 : size === 9 ? 22 : 48;

for (let iter = 0; iter < maxMainIterations; iter++) {
  if (!nowOk()) break;
  if (placed.length >= maxPlaced) break;

  const placedOne = placeBestNextWord();
  if (!placedOne) break;
}

const tryFillSlots = () => {
  let totalAdded = 0;
  let fillIterations = 0;
  let wordsScanned = 0;
  let placementsSeen = 0;
  let placementsTried = 0;

  let zeroSharedLettersCount = 0;
  let zeroPlacementsCount = 0;
  let placeFailuresCount = 0;
  let successCount = 0;

  const zeroSharedSamples: Array<Record<string, unknown>> = [];
  const zeroPlacementSamples: Array<Record<string, unknown>> = [];
  const placeFailureSamples: Array<Record<string, unknown>> = [];
  const successSamples: Array<Record<string, unknown>> = [];

  const remainingWords = () =>
    rest.filter((w) => !used.has(w) && w.length >= (size === 11 ? 4 : minEntryLenForSize(size)));

  const buildWaveOrder = (
    words: string[],
    wave: "long-first" | "medium-first" | "short-first"
  ) => {
    const thematic: string[] = [];
    const filler: string[] = [];

    for (const w of words) {
      if (nonFillerWords.has(w)) thematic.push(w);
      else filler.push(w);
    }

    const rank = (w: string) => {
      if (size !== 11) {
        return 100 + (20 - w.length);
      }

      if (wave === "long-first") {
        if (w.length >= 6 && w.length <= 8) return 500 + (20 - w.length);
        if (w.length === 9) return 420;
        if (w.length === 5) return 320;
        if (w.length === 4) return 220;
        if (w.length >= 10) return 180;
        return 100;
      }

      if (wave === "medium-first") {
        if (w.length >= 5 && w.length <= 7) return 520 + (20 - w.length);
        if (w.length === 8) return 420;
        if (w.length === 4) return 340;
        if (w.length === 9) return 220;
        if (w.length >= 10) return 120;
        return 100;
      }

      if (w.length === 4) return 560;
      if (w.length === 5) return 520;
      if (w.length === 6) return 430;
      if (w.length === 7) return 320;
      if (w.length === 8) return 180;
      return 100;
    };

    thematic.sort((a, b) => rank(b) - rank(a) || b.length - a.length);
    filler.sort((a, b) => rank(b) - rank(a) || b.length - a.length);

    return [...thematic, ...filler];
  };

  const waves: Array<"long-first" | "medium-first" | "short-first"> =
    size === 11
      ? ["long-first", "medium-first", "short-first", "medium-first", "short-first"]
      : ["medium-first", "short-first"];

  const passes = size === 11 ? 10 : size === 9 ? 5 : 7;

  const getGridLetters = () => {
    const letters = new Set<string>();
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const v = grid[r][c];
        if (typeof v === "string" && v !== "" && v !== "#") {
          letters.add(v);
        }
      }
    }
    return letters;
  };

  const countSharedLettersWithGrid = (word: string) => {
    const gridLetters = getGridLetters();
    const uniqLetters = new Set(word.split(""));
    let shared = 0;
    for (const ch of uniqLetters) {
      if (gridLetters.has(ch)) shared++;
    }
    return {
      shared,
      gridLetters: Array.from(gridLetters).sort().join(""),
      wordLetters: Array.from(uniqLetters).sort().join(""),
    };
  };

const collectPlacementsForFill = (word: string, minCrossesWanted: number) => {
  type Cand = {
    row: number;
    col: number;
    dir: Direction;
    crossings: number;
    score: number;
  };

  const out: Cand[] = [];

  const tryCandidate = (row: number, col: number, dir: Direction) => {
    let crossings = 0;
    let newCells = 0;

    for (let i = 0; i < word.length; i++) {
      const rr = dir === "down" ? row + i : row;
      const cc = dir === "across" ? col + i : col;

      if (!inBounds(size, rr, cc)) return;

      const cur = grid[rr][cc];
      const ch = word[i];

      if (cur === "#") return;
      if (cur !== "" && cur !== ch) return;

      if (cur === ch) crossings += 1;
      if (cur === "") newCells += 1;
    }

    if (crossings < minCrossesWanted) return;
    if (newCells === 0) return;

    const centerBias =
      Math.abs(row - Math.floor(size / 2)) + Math.abs(col - Math.floor(size / 2));

    let sideOpenings = 0;
    for (let i = 0; i < word.length; i++) {
      const rr = dir === "down" ? row + i : row;
      const cc = dir === "across" ? col + i : col;
      if (grid[rr][cc] !== "") continue;

      if (dir === "across") {
        if (rr > 0 && grid[rr - 1][cc] === "") sideOpenings++;
        if (rr < size - 1 && grid[rr + 1][cc] === "") sideOpenings++;
      } else {
        if (cc > 0 && grid[rr][cc - 1] === "") sideOpenings++;
        if (cc < size - 1 && grid[rr][cc + 1] === "") sideOpenings++;
      }
    }

    const score =
      crossings * 120 +
      newCells * 18 +
      sideOpenings * 8 +
      (size - centerBias) * 4 +
      (word.length >= 5 && word.length <= 8 ? 20 : 0);

    out.push({ row, col, dir, crossings, score });
  };

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      tryCandidate(r, c, "across");
      tryCandidate(r, c, "down");
    }
  }

  const seen = new Set<string>();
  const unique = out.filter((p) => {
    const key = `${p.row}:${p.col}:${p.dir}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => b.score - a.score);
  return unique;
};

  for (let pass = 0; pass < passes; pass++) {
    if (!nowOk()) break;
    if (placed.length >= maxPlaced) break;

    fillIterations++;

    let addedThisPass = 0;

    for (const wave of waves) {
      if (!nowOk()) break;
      if (placed.length >= maxPlaced) break;

      const words = buildWaveOrder(remainingWords(), wave);

      for (const w of words) {
        if (!nowOk()) break;
        if (used.has(w)) continue;
        if (placed.length >= maxPlaced) break;

        wordsScanned++;

        const isThematic = nonFillerWords.has(w);

        const minCrossesWanted = size === 11 && placed.length >= 14 ? 2 : 1;

        const sharedInfo = countSharedLettersWithGrid(w);

        if (sharedInfo.shared === 0) {
          zeroSharedLettersCount++;
          if (zeroSharedSamples.length < 12) {
            zeroSharedSamples.push({
              pass,
              wave,
              word: w,
              len: w.length,
              thematic: isThematic,
              minCrossesWanted,
              sharedLetters: 0,
              wordLetters: sharedInfo.wordLetters,
              gridLetters: sharedInfo.gridLetters,
              placedSoFar: placed.length,
            });
          }
        }

        let placements =
          size === 11
            ? collectPlacements(w, minCrossesWanted)
            : collectPlacementsForFill(w, minCrossesWanted);
        let usedRelaxedCrossRule = false;

        if (placements.length === 0 && minCrossesWanted > 1 && size !== 11) {
          placements = collectPlacementsForFill(w, 1);
          usedRelaxedCrossRule = true;
        }

        if (placements.length === 0 && size === 11) {
          placements = collectPlacementsForFill(w, minCrossesWanted);
        }

        if (placements.length === 0 && (size !== 11 || minCrossesWanted <= 1)) {
          placements = collectPlacementsLoose(w, 1);
        }

        placementsSeen += placements.length;

        if (placements.length === 0) {
          zeroPlacementsCount++;
          if (zeroPlacementSamples.length < 16) {
            zeroPlacementSamples.push({
              pass,
              wave,
              word: w,
              len: w.length,
              thematic: isThematic,
              minCrossesWanted,
              usedRelaxedCrossRule,
              sharedLetters: sharedInfo.shared,
              wordLetters: sharedInfo.wordLetters,
              gridLetters: sharedInfo.gridLetters,
              placedSoFar: placed.length,
            });
          }
          continue;
        }

        const candidatesToTry = placements.slice(
          0,
          Math.min(
            wave === "short-first" ? 32 : wave === "medium-first" ? 28 : 24,
            placements.length
          )
        );

        let placedThisWord = false;

        const scoredCandidates = candidatesToTry
          .map((p) => {
            const evalResult = evaluateLoosePlacement(w, p.row, p.col, p.dir);
            if (!evalResult) return null;
            return { placement: p, evalResult };
          })
          .filter(
            (
              item
            ): item is {
              placement: typeof candidatesToTry[number];
              evalResult: NonNullable<ReturnType<typeof evaluateLoosePlacement>>;
            } => Boolean(item)
          )
          .sort((a, b) => b.evalResult.score - a.evalResult.score);

        const evaluatedCandidates =
          scoredCandidates.length > 0
            ? scoredCandidates
            : size === 11
            ? candidatesToTry.map((placement) => ({ placement, evalResult: null }))
            : [];

        for (const { placement: p, evalResult } of evaluatedCandidates) {
          if (!nowOk()) break;

          const scratch =
            evalResult?.scratch ??
            (() => {
              const candidateGrid = grid.map((row) => row.slice()) as Cell[][];
              const wrote = tryWriteWordLoose(candidateGrid, w, p.row, p.col, p.dir);
              return wrote.ok ? candidateGrid : null;
            })();

          if (!scratch) continue;
          if (size === 11 && !evalResult) {
            const rawGrid = gridToStrings(scratch);
            const rawDerived = deriveEntriesFromGrid(rawGrid, minEntryLenForSize(size));
            const allowedAnswers = allBuildAnswerSet;
            if (
              rawDerived.some((entry) => !allowedAnswers.has(entry.answer)) ||
              !rawDerived.some((entry) => entry.answer === w)
            ) {
              continue;
            }
          }

          placementsTried++;

          for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
              grid[r][c] = scratch[r][c];
            }
          }

          placed.push({ word: w, row: p.row, col: p.col, dir: p.dir });
          used.add(w);
          addedThisPass++;
          totalAdded++;
          placedThisWord = true;
          successCount++;

          if (successSamples.length < 12) {
            successSamples.push({
              pass,
              wave,
              word: w,
              len: w.length,
              thematic: isThematic,
              row: p.row,
              col: p.col,
              dir: p.dir,
              crossings: p.crossings,
              score: p.score,
              placedSoFar: placed.length,
            });
          }

          break;
        }

        if (!placedThisWord && placements.length > 0) {
          placeFailuresCount += placements.length;
        }

        if (!placedThisWord && placements.length > 0 && placeFailureSamples.length < 12) {
          placeFailureSamples.push({
            pass,
            wave,
            word: w,
            len: w.length,
            thematic: isThematic,
            note: "had placements but none could be committed",
          });
        }
      }
    }

    console.warn("[freeform] fill pass summary", {
      pass,
      addedThisPass,
      placedSoFar: placed.length,
      wordsScannedSoFar: wordsScanned,
      placementsSeenSoFar: placementsSeen,
      placementsTriedSoFar: placementsTried,
    });

    if (addedThisPass === 0) break;
  }

  console.warn("[freeform] fill phase", {
    fillIterations,
    wordsScanned,
    placementsSeen,
    placementsTried,
    placedInFillPhase: totalAdded,
    rejectReasons: Object.fromEntries(
      Array.from(rejectReasonCounts.entries()).sort((a, b) => b[1] - a[1])
    ),
    zeroSharedLettersCount,
    zeroPlacementsCount,
    placeFailuresCount,
    successCount,
    zeroSharedSamples,
    zeroPlacementSamples,
    placeFailureSamples,
    successSamples
  });

  return totalAdded;
};

const repairAndDensify11 = () => {
  if (size !== 11) return 0;

  let added = 0;
  const maxRepairPasses = 60;

  const remainingRepairWords = () =>
    rest
      .filter((w) => !used.has(w) && w.length >= 3)
      .sort((a, b) => {
        const aTheme = nonFillerWords.has(a) ? 1 : 0;
        const bTheme = nonFillerWords.has(b) ? 1 : 0;
        if (aTheme !== bTheme) return bTheme - aTheme;

        const rank = (w: string) => {
          if (w.length >= 5 && w.length <= 7) return 600;
          if (w.length === 4) return 520;
          if (w.length === 8) return 420;
          if (w.length === 9) return 220;
          return 120;
        };

        return rank(b) - rank(a) || a.length - b.length;
      });

  for (let pass = 0; pass < maxRepairPasses; pass++) {
    if (!nowOk()) break;
    if (placed.length >= maxPlaced) break;

    const projected = projectGridOutcome(grid);
    const currentStats = entryCrossingStats(
      projected.final,
      projected.derived,
      minEntryLenForSize(size)
    );
    const currentWeakAnswers = new Set(currentStats.weakEntries.map((entry) => entry.answer));
    const weakCellKeys = new Set<string>();

    for (const entry of projected.derived) {
      if (!currentWeakAnswers.has(entry.answer)) continue;
      for (let i = 0; i < entry.answer.length; i++) {
        const r = entry.direction === "down" ? entry.row + i : entry.row;
        const c = entry.direction === "across" ? entry.col + i : entry.col;
        weakCellKeys.add(`${r},${c}`);
      }
    }

    let best:
      | {
          word: string;
          row: number;
          col: number;
          dir: Direction;
          score: number;
          evalResult: NonNullable<ReturnType<typeof evaluateLoosePlacement>>;
          afterWeakCount: number;
          afterEntries: number;
          entryGain: number;
          weakReduction: number;
          weakCrosses: number;
        }
      | null = null;

    for (const word of remainingRepairWords().slice(0, 240)) {
      if (!nowOk()) break;

      const placements = [
        ...collectPlacements(word, 1),
        ...collectPlacementsLoose(word, 1),
      ];
      const seenPlacements = new Set<string>();
      const uniquePlacements = placements.filter((p) => {
        const key = `${p.row}:${p.col}:${p.dir}`;
        if (seenPlacements.has(key)) return false;
        seenPlacements.add(key);
        return true;
      });

      for (const p of uniquePlacements.slice(0, 96)) {
        if (!nowOk()) break;

        let weakCrosses = 0;
        for (let i = 0; i < word.length; i++) {
          const r = p.dir === "down" ? p.row + i : p.row;
          const c = p.dir === "across" ? p.col + i : p.col;
          if (!inBounds(size, r, c)) continue;
          if (grid[r][c] === word[i] && weakCellKeys.has(`${r},${c}`)) weakCrosses++;
        }

        const evalResult = evaluateLoosePlacement(word, p.row, p.col, p.dir);
        if (!evalResult) continue;

        const afterStats = entryCrossingStats(
          evalResult.final,
          evalResult.derived,
          minEntryLenForSize(size)
        );
        const entryGain = evalResult.derived.length - projected.derived.length;
        const weakReduction = currentStats.weakEntries.length - afterStats.weakEntries.length;

        if (currentStats.weakEntries.length > 0) {
          if (weakReduction < -1) continue;
          if (weakReduction === 0 && weakCrosses === 0 && entryGain <= 0) continue;
        } else {
          if (afterStats.weakEntries.length > 0) continue;
          if (entryGain <= 0) continue;
        }

        if (evalResult.derived.length < Math.max(4, projected.derived.length - 1)) continue;

        const score =
          weakReduction * 420000 +
          weakCrosses * 120000 +
          entryGain * 50000 +
          evalResult.derived.length * 7000 +
          evalResult.checkedRatio * 5000 +
          evalResult.nonFillerUsed * 3500 +
          (nonFillerWords.has(word) ? 12000 : 0) +
          p.crossings * 3500 -
          afterStats.weakEntries.length * 35000;

        if (!best || score > best.score) {
          best = {
            word,
            row: p.row,
            col: p.col,
            dir: p.dir,
            score,
            evalResult,
            afterWeakCount: afterStats.weakEntries.length,
            afterEntries: evalResult.derived.length,
            entryGain,
            weakReduction,
            weakCrosses,
          };
        }
      }
    }

    if (!best) break;

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        grid[r][c] = best.evalResult.scratch[r][c];
      }
    }

    placed.push({ word: best.word, row: best.row, col: best.col, dir: best.dir });
    used.add(best.word);
    added++;

    console.warn("[freeform] repair/densify placed", {
      pass,
      word: best.word,
      row: best.row,
      col: best.col,
      dir: best.dir,
      afterEntries: best.afterEntries,
      entryGain: best.entryGain,
      weakReduction: best.weakReduction,
      weakCrosses: best.weakCrosses,
      afterWeakCount: best.afterWeakCount,
    });
  }

  return added;
};

    const fillSlotsAdded = tryFillSlots();
const repairDensifyAdded = repairAndDensify11();
const placedAfterFillSlots = placed.length;

    let blocked = paintBlocks(grid);
    blocked = enforceMinWordLen(blocked, minEntryLenForSize(size));

    const blockedBeforePrune = blocked.map((row) => row.slice());
    const prunedBlocked = pruneDanglingRuns(blocked, minEntryLenForSize(size));
    const derivedBeforePrune = deriveEntriesFromGrid(
      gridToStrings(blockedBeforePrune as (string | null)[][]),
      minEntryLenForSize(size)
    );
    const derivedAfterPrune = deriveEntriesFromGrid(
      gridToStrings(prunedBlocked as (string | null)[][]),
      minEntryLenForSize(size)
    );

    if (
      size === 11 &&
      derivedAfterPrune.length < Math.max(4, derivedBeforePrune.length - 2)
    ) {
      console.warn("[freeform] reject prune-damaged 11x11", {
        before: derivedBeforePrune.length,
        after: derivedAfterPrune.length,
      });
      return null;
    }

    blocked =
      size === 11 ||
      derivedAfterPrune.length >= Math.max(4, Math.floor(derivedBeforePrune.length * 0.6))
        ? prunedBlocked
        : blockedBeforePrune;

    blocked = keepLargestConnectedComponent(blocked);
    blocked = keepLargestConnectedComponent(blocked);

    const final: string[][] = [];

    for (let r = 0; r < size; r++) {
      const row: string[] = [];

      for (let c = 0; c < size; c++) {
        const v = blocked[r][c];

        if (v === "#") {
          row.push("#");
          continue;
        }

        if (typeof v === "string" && v.length === 1) {
          if (/[A-Z]/.test(v)) {
            row.push(v);
            continue;
          }

          if (/[a-z]/.test(v)) {
            row.push(v.toUpperCase());
            continue;
          }

          if (/[0-9]/.test(v)) {
            row.push(v);
            continue;
          }
        }

        row.push("#");
      }

      final.push(row);
    }

const derivedBeforeBlocking = deriveEntriesFromGrid(gridToStrings(grid), minEntryLenForSize(size));
const derived = deriveEntriesFromGrid(final, minEntryLenForSize(size));

if (size === 11 && hasShortLetterRuns(final, minEntryLenForSize(size))) {
  console.warn("[freeform] reject final short runs 11x11", {
    derived: derived.length,
  });
  return null;
}

const allowedAnswersFinal = new Set(candidates.map((c) => c.answer));
const invalidDerived = derived.filter((e) => !allowedAnswersFinal.has(e.answer));

if (invalidDerived.length > 0) {
  console.warn("[freeform] reject invalid derived entries", {
    invalidDerived: invalidDerived.map((e) => ({
      answer: e.answer,
      row: e.row,
      col: e.col,
      len: e.answer.length,
    })),
  });
  return null;
}

const nonFillerSet = new Set(
  candidates.filter((c) => c.source !== "filler").map((c) => c.answer)
);
const nonFillerUsed = derived.filter((e) => nonFillerSet.has(e.answer)).length;
const nonFillerRatio = derived.length ? nonFillerUsed / derived.length : 0;
const checkedStats = checkedCellStats(final, minEntryLenForSize(size));

const usedAnswers = Array.from(new Set(derived.map((e) => e.answer)));

console.warn("[freeform] build summary", {
  placedAfterFillSlots,
  fillSlotsAdded,
  repairDensifyAdded,
  placedFinal: placed.length,
  derivedBeforeBlocking: derivedBeforeBlocking.length,
  derivedAfterBlocking: derived.length,
  usedAnswersFinal: usedAnswers.length,
  densityFinal: crosswordDensityFromGrid(final),
  checkedRatio: checkedStats.ratio,
});

       return {
      grid: final,
      usedAnswers,
      meta: {
        algorithm: "freeform-crossing-then-blocks",
        candidatesCount: candidates.length,
        placedWordsAttempted: placed.length,
        usedAnswers: usedAnswers.length,
        entryCount: derived.length,
        density: crosswordDensityFromGrid(final),
        checkedRatio: checkedStats.ratio,
        buildSeed: localSeed,
        rounds,
        nonFillerRatio,
        repairDensifyAdded,
      },
    };
  };

  let best: BuildResult | null = null;
  let bestScore = -Infinity;

  for (let i = 0; i < maxBuilds; i++) {
    if (deadline && Date.now() > deadline) break;

    const localSeed = (seed ^ ((i + 1) * 0x9e3779b9)) >>> 0;
    const res = buildOnce(localSeed);

    if (!res) {
      console.warn("[freeform] buildOnce returned null", {
        i,
        localSeed,
        size,
        candidates: candidates.length,
        uniq: uniq.length,
      });
      continue;
    }

    const d = (res.meta.density as number) ?? crosswordDensityFromGrid(res.grid);
    const usedCount = res.usedAnswers.length;
    const entryCount = Number(res.meta.entryCount ?? 0);
    const checkedRatio = Number(res.meta.checkedRatio ?? 0);
    const derivedForScore = deriveEntriesFromGrid(res.grid, minEntryLenForSize(size));
    const weakEntryCount = entryCrossingStats(
      res.grid,
      derivedForScore,
      minEntryLenForSize(size)
    ).weakEntries.length;

    // Prioridad real:
    // 1) más entradas derivadas
    // 2) más celdas correctamente cruzadas
    // 3) más respuestas usadas
    // 4) mejor densidad
    const nonFillerRatio = Number(res.meta.nonFillerRatio ?? 0);
    const hasPublishableEntryCount = entryCount >= minPublishEntriesForSize(size);
    const hasPreferredEntryCount = entryCount >= desiredPublishEntriesForSize(size);
    const structurallyClean =
      weakEntryCount === 0 &&
      !hasShortLetterRuns(res.grid, minEntryLenForSize(size)) &&
      checkedRatio >= (size === 11 ? 0.18 : 0.12);
    const score =
      (hasPreferredEntryCount ? 3_000_000 : 0) +
      (hasPublishableEntryCount ? 1_500_000 : 0) +
      (hasPublishableEntryCount && structurallyClean ? 1_500_000 : 0) +
      entryCount * 22000 +
      Math.min(entryCount, desiredPublishEntriesForSize(size)) * 5000 +
      Math.max(0, entryCount - minPublishEntriesForSize(size)) * 8000 +
      checkedRatio * 7000 +
      usedCount * 1500 +
      d * 500 +
      nonFillerRatio * 9000 -
      weakEntryCount * (hasPublishableEntryCount ? 90000 : size === 11 ? 45000 : 12000);

    if (score > bestScore) {
      bestScore = score;
      best = res;
    }

    if (
      entryCount >= (size === 11 ? minPublishEntriesForSize(size) : size === 9 ? 8 : 16) &&
      checkedRatio >= (size === 11 ? 0.18 : 0.6) &&
      weakEntryCount === 0 &&
      usedCount >= (size === 11 ? minPublishEntriesForSize(size) : size === 9 ? 7 : 14) &&
      d >= targetDensity * (size === 11 ? 0.78 : 0.9)
    ) {
      return res;
    }
  }

  return best;
}

function densifyCleanGrid11(opts: {
  theme: string;
  grid: string[][];
  candidates: WordCandidate[];
  targetEntries: number;
  seed: number;
  deadlineMs?: number;
  pruneWeakEntries?: boolean;
}): { grid: string[][]; derived: DerivedEntry[]; added: string[]; meta: Record<string, unknown> } | null {
  const { theme, candidates, targetEntries, seed, deadlineMs } = opts;
  const size = 11;
  const minLen = minEntryLenForSize(size);
  const localDeadlineMs =
    deadlineMs && deadlineMs > Date.now() + 500 ? deadlineMs : Date.now() + 5_000;
  const nowOk = () => Date.now() <= localDeadlineMs;

  let grid = opts.grid.map((row) => row.slice());
  let derived = deriveEntriesFromGrid(grid, minLen);
  const initialEntryCount = derived.length;

  const pruneWeakEntriesForRepair = () => {
    const stats = entryCrossingStats(grid, derived, minLen);
    if (stats.weakEntries.length === 0) return false;
    if (derived.length - stats.weakEntries.length < Math.max(8, targetEntries - 5)) return false;

    const weakAnswers = new Set(stats.weakEntries.map((entry) => entry.answer));
    const nonWeakCellKeys = new Set<string>();
    for (const entry of derived) {
      if (weakAnswers.has(entry.answer)) continue;
      for (let i = 0; i < entry.answer.length; i++) {
        const rr = entry.direction === "down" ? entry.row + i : entry.row;
        const cc = entry.direction === "across" ? entry.col + i : entry.col;
        nonWeakCellKeys.add(`${rr}:${cc}`);
      }
    }

    const next = grid.map((row) => row.slice());
    for (const entry of derived) {
      if (!weakAnswers.has(entry.answer)) continue;
      for (let i = 0; i < entry.answer.length; i++) {
        const rr = entry.direction === "down" ? entry.row + i : entry.row;
        const cc = entry.direction === "across" ? entry.col + i : entry.col;
        if (!nonWeakCellKeys.has(`${rr}:${cc}`)) next[rr][cc] = "#";
      }
    }

    const cleaned = blockShortRunsOnly(next, minLen);
    const cleanedDerived = deriveEntriesFromGrid(cleaned, minLen);
    if (cleanedDerived.length < Math.max(8, targetEntries - 5)) return false;
    if (hasShortLetterRuns(cleaned, minLen)) return false;

    grid = cleaned;
    derived = cleanedDerived;
    console.warn("[densify-11] pruned weak entries before repair", {
      removed: Array.from(weakAnswers),
      fromEntries: initialEntryCount,
      toEntries: derived.length,
    });
    return true;
  };

  const prunedWeakForRepair = opts.pruneWeakEntries === false ? false : pruneWeakEntriesForRepair();

  const allowedAnswers = new Set<string>([
    ...candidates
      .filter((candidate) => candidate.source !== "filler")
      .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
      .filter((candidate) => candidate.answer.length >= minLen && candidate.answer.length <= size)
      .filter((candidate) => ASCII_A_TO_Z.test(candidate.answer))
      .filter((candidate) => !isForbiddenPublishAnswer(candidate.answer))
      .map((candidate) => candidate.answer),
    ...derived.map((entry) => entry.answer).filter((answer) => !isForbiddenPublishAnswer(answer)),
  ]);

  const thematicAnswers = new Set(
    candidates
      .filter((candidate) => candidate.source !== "filler")
      .filter((candidate) => candidate.thematic)
      .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
      .map((candidate) => candidate.answer)
  );

  const rng = makeSeededRng(seed);
  const orderedWords = Array.from(allowedAnswers)
    .filter((answer) => !derived.some((entry) => entry.answer === answer))
    .sort((a, b) => {
      const aTheme = thematicAnswers.has(a) ? 1 : 0;
      const bTheme = thematicAnswers.has(b) ? 1 : 0;
      if (aTheme !== bTheme) return bTheme - aTheme;
      const aLenFit = a.length >= 4 && a.length <= 7 ? 1 : 0;
      const bLenFit = b.length >= 4 && b.length <= 7 ? 1 : 0;
      if (aLenFit !== bLenFit) return bLenFit - aLenFit;
      return a.length - b.length || a.localeCompare(b);
    });
  shuffleInPlace(orderedWords, rng);
  orderedWords.sort((a, b) => {
    const aTheme = thematicAnswers.has(a) ? 1 : 0;
    const bTheme = thematicAnswers.has(b) ? 1 : 0;
    if (aTheme !== bTheme) return bTheme - aTheme;
    const aLenFit = a.length >= 4 && a.length <= 7 ? 1 : 0;
    const bLenFit = b.length >= 4 && b.length <= 7 ? 1 : 0;
    if (aLenFit !== bLenFit) return bLenFit - aLenFit;
    return a.length - b.length || a.localeCompare(b);
  });

  const added: string[] = [];

  const weakCellKeysFor = (entries: DerivedEntry[], weakAnswers: Set<string>) => {
    const keys = new Set<string>();
    for (const entry of entries) {
      if (!weakAnswers.has(entry.answer)) continue;
      for (let i = 0; i < entry.answer.length; i++) {
        const rr = entry.direction === "down" ? entry.row + i : entry.row;
        const cc = entry.direction === "across" ? entry.col + i : entry.col;
        keys.add(`${rr},${cc}`);
      }
    }
    return keys;
  };

  let currentWeakStats = entryCrossingStats(grid, derived, minLen);
  let currentWeakEntryCount = currentWeakStats.weakEntries.length;
  if (derived.length >= targetEntries && currentWeakEntryCount === 0) return null;

  const countExistingCrossings = (
    source: string[][],
    word: string,
    row: number,
    col: number,
    dir: Direction,
    weakCellKeys: Set<string>
  ) => {
    let crossings = 0;
    let weakCrossings = 0;
    let newCells = 0;

    for (let i = 0; i < word.length; i++) {
      const rr = dir === "down" ? row + i : row;
      const cc = dir === "across" ? col + i : col;
      if (!inBounds(size, rr, cc)) return null;

      const cur = source[rr][cc];
      const ch = word[i];
      if (cur !== "#" && cur !== ch) return null;
      if (cur === ch) {
        crossings++;
        if (weakCellKeys.has(`${rr},${cc}`)) weakCrossings++;
      }
      if (cur === "#") newCells++;
    }

    if (crossings < 1 || newCells < 1) return null;
    return { crossings, weakCrossings, newCells };
  };

  const evaluateInsertion = (word: string, row: number, col: number, dir: Direction) => {
    const currentWeakAnswers = new Set(currentWeakStats.weakEntries.map((entry) => entry.answer));
    const weakCellKeys = weakCellKeysFor(derived, currentWeakAnswers);
    const placement = countExistingCrossings(grid, word, row, col, dir, weakCellKeys);
    if (!placement) return null;
    const stagedRepair =
      currentWeakEntryCount > 0 &&
      placement.crossings === 1 &&
      placement.weakCrossings > 0;
    if (placement.crossings < minCrossingsPerEntryForPublish(size) && !stagedRepair) return null;

    const nextGrid = grid.map((r) => r.slice());
    for (let i = 0; i < word.length; i++) {
      const rr = dir === "down" ? row + i : row;
      const cc = dir === "across" ? col + i : col;
      nextGrid[rr][cc] = word[i];
    }

    const normalizedNextGrid = hasShortLetterRuns(nextGrid, minLen)
      ? blockShortRunsOnly(nextGrid, minLen)
      : nextGrid;
    const nextDerived = deriveEntriesFromGrid(normalizedNextGrid, minLen);
    if (!nextDerived.some((entry) => entry.answer === word)) return null;
    if (nextDerived.some((entry) => !allowedAnswers.has(entry.answer))) return null;
    if (nextDerived.some((entry) => isForbiddenPublishAnswer(entry.answer))) return null;
    const nextWeakStats = entryCrossingStats(normalizedNextGrid, nextDerived, minLen);
    const nextWeakEntryCount = nextWeakStats.weakEntries.length;
    const allowTemporaryWeakRepairStep =
      opts.pruneWeakEntries === false && placement.weakCrossings > 0;
    if (nextWeakEntryCount > currentWeakEntryCount + (allowTemporaryWeakRepairStep ? 1 : 0)) {
      return null;
    }
    if (
      nextDerived.length <= derived.length &&
      nextWeakEntryCount >= currentWeakEntryCount &&
      !(allowTemporaryWeakRepairStep && nextWeakEntryCount <= currentWeakEntryCount)
    ) {
      return null;
    }

    const checked = checkedCellStats(normalizedNextGrid, minLen);
    const thematicCount = nextDerived.filter((entry) => thematicAnswers.has(entry.answer)).length;
    const score =
      (currentWeakEntryCount - nextWeakEntryCount) * 8000 +
      (nextDerived.length - derived.length) * 5000 +
      thematicCount * 900 +
      placement.weakCrossings * 3500 +
      placement.crossings * 350 +
      placement.newCells * 30 +
      checked.ratio * 700;

    return {
      grid: normalizedNextGrid,
      derived: nextDerived,
      score,
      weakEntryCount: nextWeakEntryCount,
      weakStats: nextWeakStats,
      crossings: placement.crossings,
      newCells: placement.newCells,
    };
  };

  for (
    let round = 0;
    round < 12 && nowOk() && (derived.length < targetEntries || currentWeakEntryCount > 0);
    round++
  ) {
    let best:
      | {
          word: string;
          grid: string[][];
          derived: DerivedEntry[];
          score: number;
          weakEntryCount: number;
          weakStats: ReturnType<typeof entryCrossingStats>;
        }
      | null = null;

    for (const word of orderedWords) {
      if (!nowOk()) break;
      if (added.includes(word) || derived.some((entry) => entry.answer === word)) continue;

      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
          for (const dir of ["across", "down"] as const) {
            const candidate = evaluateInsertion(word, row, col, dir);
            if (!candidate) continue;
            if (!best || candidate.score > best.score) {
              best = {
                word,
                grid: candidate.grid,
                derived: candidate.derived,
                score: candidate.score,
                weakEntryCount: candidate.weakEntryCount,
                weakStats: candidate.weakStats,
              };
            }
          }
        }
      }
    }

    if (!best) break;
    grid = best.grid;
    derived = best.derived;
    currentWeakEntryCount = best.weakEntryCount;
    currentWeakStats = best.weakStats;
    added.push(best.word);
  }

  if (added.length === 0 && !prunedWeakForRepair) return null;

  console.warn("[densify-11] completed", {
    fromEntries: deriveEntriesFromGrid(opts.grid, minLen).length,
    toEntries: derived.length,
    targetEntries,
    added,
    weakEntries: currentWeakEntryCount,
    candidates: allowedAnswers.size,
    deadlineMs: localDeadlineMs - Date.now(),
  });

  return {
    grid,
    derived,
    added,
    meta: {
      densifier: "clean-grid-11",
      densifierAdded: added,
      densifierEntries: derived.length,
    },
  };
}

async function generatePatternMatchedRepairWords(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  grid: string[][];
  entries: DerivedEntry[];
  existingAnswers: string[];
}) {
  const { client, theme, language, grid, entries, existingAnswers } = opts;
  const size = 11;
  const weakStats = entryCrossingStats(grid, entries, minEntryLenForSize(size));
  const weakAnswers = new Set(weakStats.weakEntries.map((entry) => entry.answer));
  const weakCells = new Set<string>();
  const cellEntries = new Map<string, Array<{ answer: string; direction: Direction }>>();
  for (const entry of entries) {
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      const key = `${r},${c}`;
      const owners = cellEntries.get(key) ?? [];
      owners.push({ answer: entry.answer, direction: entry.direction });
      cellEntries.set(key, owners);
      if (weakAnswers.has(entry.answer)) weakCells.add(key);
    }
  }

  const patternScores = new Map<string, number>();
  for (const direction of ["across", "down"] as const) {
    for (let len = 3; len <= 8; len++) {
      const maxRow = direction === "down" ? size - len : size - 1;
      const maxCol = direction === "across" ? size - len : size - 1;
      for (let row = 0; row <= maxRow; row++) {
        for (let col = 0; col <= maxCol; col++) {
          let fixed = 0;
          let open = 0;
          let weakCrossings = 0;
          let pattern = "";
          let overlapsSameDirection = false;
          const crossedAnswers = new Set<string>();
          for (let i = 0; i < len; i++) {
            const r = direction === "down" ? row + i : row;
            const c = direction === "across" ? col + i : col;
            const cell = grid[r][c];
            if (cell === "#") {
              pattern += "?";
              open++;
            } else {
              pattern += cell;
              fixed++;
              const key = `${r},${c}`;
              const owners = cellEntries.get(key) ?? [];
              if (owners.some((owner) => owner.direction === direction)) {
                overlapsSameDirection = true;
                break;
              }
              for (const owner of owners) crossedAnswers.add(owner.answer);
              if (weakCells.has(key)) weakCrossings++;
            }
          }
          if (
            overlapsSameDirection ||
            fixed < 2 ||
            open < 1 ||
            weakCrossings < 1 ||
            crossedAnswers.size < 2
          ) {
            continue;
          }
          const score = weakCrossings * 1000 + fixed * 100 - open;
          patternScores.set(pattern, Math.max(patternScores.get(pattern) ?? 0, score));
        }
      }
    }
  }

  const patterns = Array.from(patternScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 32)
    .map(([pattern]) => pattern);
  if (patterns.length === 0) return [];

  const prompt = `
Return ONLY JSON:
{"matches":[{"pattern":"?U?T?","answers":["..."]}]}

For every PATTERN, propose up to 8 real crossword answers that match it exactly.
"?" means any single uppercase A-Z letter; fixed letters must stay in the same positions.

Rules:
- Answers must be complete, correctly spelled words or names.
- Prefer specific entries from THEME.
- Context words are allowed only when a concrete clue can explicitly connect them to THEME.
- No abbreviations, codes, fragments, clipped names, invented compounds, or altered titles.
- Do not return an answer already present in EXISTING.
- Return no answer that fails its exact pattern.

THEME: ${theme}
LANGUAGE: ${language === "es" ? "Spanish" : "English"}
PATTERNS: ${patterns.join(", ")}
EXISTING: ${existingAnswers.join(", ")}
`;
  const completion = await client.chat.completions.create({
    model: ANSWERBANK_SEARCH_MODEL,
    temperature: 0.1,
    max_tokens: 2600,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. Match every character pattern exactly." },
      { role: "user", content: prompt },
    ],
  });
  const parsed = safeJson<{
    matches?: Array<{ pattern?: unknown; answers?: unknown }>;
  }>(completion.choices?.[0]?.message?.content ?? "");
  if (!parsed?.matches || !Array.isArray(parsed.matches)) return [];

  const existingSet = new Set(existingAnswers);
  const results = new Map<string, WordCandidate>();
  for (const match of parsed.matches) {
    const pattern = typeof match.pattern === "string" ? match.pattern.trim().toUpperCase() : "";
    if (!patterns.includes(pattern) || !Array.isArray(match.answers)) continue;
    const regex = new RegExp(`^${pattern.replace(/\?/g, "[A-Z]")}$`);
    for (const rawAnswer of match.answers) {
      const answer = normalizeAnswer(typeof rawAnswer === "string" ? rawAnswer : "");
      if (!regex.test(answer) || existingSet.has(answer)) continue;
      if (isForbiddenPublishAnswer(answer)) continue;
      if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
      results.set(answer, { answer, thematic: true, source: "support" });
    }
  }

  console.warn("[pattern-repair-11] generated", {
    patterns: patterns.length,
    answers: results.size,
    sample: Array.from(results.keys()).slice(0, 20),
  });
  return Array.from(results.values());
}

// -------------------- OpenAI prompts (answers -> clues) --------------------

const ANSWERBANK_PROMPT = `
You are generating a THEMATIC crossword answer bank.

Return ONLY a JSON object with this exact schema:

{
  "answers": string[],
  "notes": [{ "answer": string, "note": string }]
}

Rules:

- Generate EXACTLY ${TARGET_ANSWERS} answers in the first response.
- If the theme has many names, titles, places, works, people, terms, or related entities, use that breadth to reach ${TARGET_ANSWERS}.
- "answers" must be uppercase A-Z (and digits if needed).
- Every answer MUST be strongly tied to the THEME.
- Every answer MUST be a standalone crossword-ready entry.
- Every answer MUST fit in the requested grid size.
- Avoid generic filler words unless unavoidable.
- DO NOT include definitions.
- DO NOT include commentary.
- JSON only.
- Include one short note for EVERY answer. Each note must be at most 10 words.
- Each note must explain the factual connection to the theme.
- If you cannot write a factual theme note for an answer, do not include that answer.
- Notes should be factual and based on widely reputable general knowledge sources such as encyclopedias,
  official tourism pages, museum/venue pages, or other reliable references. Do not invent local facts.

CRITICAL ENTRY QUALITY RULES:
- Each answer must be a real, complete, self-contained term that a crossword solver could reasonably expect.
- Do NOT output abbreviations, airport codes, postal codes, acronyms, initials, nicknames, or shorthand forms unless they are universally recognized standalone entries.
- Do NOT output fragments, clipped forms, prefixes, suffixes, chopped place names, partial names, or shortened pieces of a longer word or phrase.
- Do NOT output partial city names, partial region names, or truncated versions of proper nouns.
- Do NOT output a substring of a better full answer.
- If the complete term is longer than the current grid, skip it. Never return a shortened fake form.
- Reject stems and chopped words such as NATUR, CARNI, CULTU, CASC, CUMB, CICL, MONT, NEVE, AVENT.
- Prefer complete nouns, place names, demonyms, landmarks, titles, products, dishes, animals, concepts, etc.
- If an answer would normally contain spaces or punctuation, normalize it into a full crossword entry only if the full term is still clearly recognizable and complete.
- Bad examples: SFO, LAX, SONO, PALO, MEND, SACRAM, SD, LA, OC.
- Good examples: SONOMA, PALOALTO, MENDOCINO, SACRAMENTO, SANDIEGO, LOSANGELES.

DIVERSITY RULES:
- Prefer complete theme-specific answers over short generic answers.
- For 11x11, use complete entries of length 3-11 only. At least 55 answers should be 3-8 letters when the theme has enough good short entries.
- Include a mix of lengths, but never invent stems or generic filler just to create short answers.
- For places, prioritize landmarks, lakes, mountains, neighborhoods, routes, foods, flora/fauna, local culture, activities, and tourism terms that are specifically associated with the place.
- For geographic names with generic prefixes, prefer the distinctive standalone part when it is commonly used and fits better: MORENO instead of LAGOMORENO, OTTO instead of CERROOTTO, CATEDRAL instead of CERROCATEDRAL.
- Do not fabricate template-like names such as CERROAZUL or LAGOFONTANA unless they are real and important to the requested theme.
- Do not fabricate or keep doubtful geographic compounds such as LAGOSOL, LAGOBLANCO, LAGOHERMOSO, LAGOLIMPIO, LAGOSILVINA, LAGOTRANCAS, LAGOVIEDMA, CERROVERDE, or CERROAZUL unless the exact full name is a reputable, notable match for the requested theme.
- For place themes, DO NOT over-list entries with the same prefix. Avoid returning many LAGO... or CERRO... answers. Cover many categories: landmarks, activities, food, climate, flora, fauna, routes, nearby places, tourism, culture.
- For place themes, at least half of the answers should NOT start with generic geographic prefixes like LAGO, CERRO, RIO, ISLA, PUERTO, VILLA, COLONIA, PARQUE, MONTE.
- For place themes, no more than 8 total answers may start with LAGO or CERRO combined.
- For place themes, include at least 25 short entries of length 3-8 from varied real categories when true for the place: weather, outdoor sports, food/drink, flora, fauna, landscape nouns, local culture, tourism activities, and distinctive nearby names.
- For place themes, include complete short thematic terms that are broadly but strongly characteristic of the place when they are true: local foods, animals, plants, activities, weather terms, landmarks, and famous local names.
- Prefer famous/relevant names over obscure or doubtful names.
- For artists, bands, books, films, historical events, or brands, prioritize names, works, characters, places, members, concepts, objects, and terms that are specifically associated with the theme.
- Avoid generic words like COLOR, BLUE, TRAVEL, SOUL, HOME, BASE, ART, MARKET, TOWER, COFFEE unless they are the actual complete name of a theme-specific entity.
- Avoid returning too many entries that are nearly the same pattern or same root.
- Do NOT include clues or explanations outside JSON.
- Return compact one-line JSON. Do not pretty-print.

THEME: \${theme}
LANGUAGE: \${languageLabel}

`;

function buildAnswerbankRequest(theme: string, language: "es" | "en", size: number) {
  const languageLabel = language === "es" ? "Spanish" : "English";
  const anchors = getThemeAnchors(theme).map((a) => normalizeAnswer(a)).filter(Boolean).slice(0, 40);

  return `
THEME: ${theme}
LANGUAGE: ${languageLabel}
SIZE: ${size}

Answer count:
- Generate EXACTLY ${TARGET_ANSWERS} answers.
- Return answers plus matching notes for every answer. Do not include clues in this response.

Length:
- Prefer many complete theme-specific terms that fit within ${size} letters, because those can be placed in this grid.
- Do NOT include answers longer than ${size}; they cannot be placed in this grid.
- Output tokens MUST be normalized: ONLY A-Z and digits (NO spaces/hyphens).
- Never truncate longer thematic terms. If an important term is longer than ${size}, skip it instead of inventing fragments.
- Bad truncated examples: NATUR, CARNI, CULTU, CASC, CUMB, CICL, MONT, NEVE, AVENT.
- Bad fabricated geographic examples: LAGOSOL, LAGOBLANCO, LAGOHERMOSO, LAGOLIMPIO, LAGOSILVINA, LAGOTRANCAS, LAGOVIEDMA, CERROVERDE, CERROAZUL.
- Bad generic examples for a place theme: AZUL, ALMA, BASE, CAFE, VIAJE, LUGAR, TORRE, MUSEO, ARTE unless they are part of a specific proper name.

Known thematic anchor ideas you may include (optional):
${anchors.join(", ") || "(none)"}
`;
}

const CLUEBANK_PROMPT = `
You are a crossword editor.

Return ONLY a JSON object with this schema:
{
  "clues": [
    { "answer": string, "clue": string }
  ]
}

INPUT FORMAT:
You will receive a JSON array named ITEMS where each item is:
{ "answer": string, "thematic": boolean }

Hard rules:
- Output JSON ONLY. No markdown. No commentary.
- Each "answer" MUST match an input item "answer" EXACTLY (UPPERCASE A–Z and digits if present).
- Each "clue" must be in the requested LANGUAGE and must read like a real crossword clue.
- Keep each clue SHORT (max 55 characters).
- Do NOT include the answer text (or obvious substrings) in the clue.
- Do NOT use placeholder text like "Thematic entry" or "Definition".

CRITICAL FACTUALITY RULE:
- Never invent song titles, track lists, album contents, dates, or specific claims.
- If you are not 100% sure about a specific fact, write a safer, non-specific clue.

THEME POLICY (depends on thematic flag):
- If thematic=true: the clue MUST mention the theme (directly or by clear band/album/mascot context),
  but must stay FACTUAL. If unsure, use safe clues like "Megadeth album title" / "Megadeth mascot" /
  "Megadeth-related term" rather than a specific (possibly false) claim.
- If thematic=true for a place theme, prefer a factual local clue: lake, hill, neighborhood, route, activity,
  food, flora/fauna, province, region, or landmark associated with the place. Do NOT use a generic dictionary
  clue when the answer was selected as thematic.
- If thematic=false: the clue MUST be a normal general crossword clue (definition/synonym),
  and MUST NOT claim it is a song/album/member/etc. Do NOT mention album names or “track from…”.

Now produce one clue per input item.

THEME: \${theme}
LANGUAGE: \${languageLabel}
ITEMS:
\${itemsJson}
`;

// -------------------- Clue plumbing --------------------

type AnswerbankTextResult = {
  text: string;
  model: string;
  finishReason?: string;
  usedWebSearch: boolean;
  trustedAnswers?: string[];
  coreAnswers?: string[];
  contextAnswers?: string[];
};

function extractResponseOutputText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const direct = "output_text" in response ? (response as { output_text?: unknown }).output_text : undefined;
  if (typeof direct === "string" && direct.trim()) return direct;

  const output = "output" in response ? (response as { output?: unknown }).output : undefined;
  if (!Array.isArray(output)) return "";

  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = "content" in item ? (item as { content?: unknown }).content : undefined;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = "text" in part ? (part as { text?: unknown }).text : undefined;
      if (typeof text === "string") chunks.push(text);
    }
  }

  return chunks.join("\n").trim();
}

async function requestAnswerbankText(opts: {
  client: OpenAI;
  prompt: string;
}): Promise<AnswerbankTextResult> {
  const { client, prompt } = opts;
  const allowWebSearch = process.env.OPENAI_ENABLE_WEB_SEARCH === "1";

  if (allowWebSearch) {
    try {
      const responsesClient = client as OpenAI & {
        responses?: {
          create(args: Record<string, unknown>): Promise<unknown>;
        };
      };

      if (responsesClient.responses?.create) {
        const response = await responsesClient.responses.create({
          model: ANSWERBANK_SEARCH_MODEL,
          tools: [
            {
              type: "web_search",
              search_context_size: "low",
              filters: {
                allowed_domains: [
                  "wikipedia.org",
                  "britannica.com",
                ],
              },
            },
          ],
          tool_choice: "required",
          input: `${prompt}

Use web search on reputable sources to ground the answer list. Prioritize encyclopedia, official tourism,
official government, museum, venue, or similarly reputable sources. Return ONLY the requested JSON.`,
        });

        const text = extractResponseOutputText(response);
        if (text) {
          const parsed = safeJson<{ answers?: unknown }>(text);
          if (parsed && Array.isArray(parsed.answers)) {
            return {
              text,
              model: ANSWERBANK_SEARCH_MODEL,
              usedWebSearch: true,
            };
          }
          console.warn("[generate-crossword] answerbank web search returned non-json; falling back to chat", {
            chars: text.length,
          });
        }
      }
    } catch (error: unknown) {
      console.warn("[generate-crossword] answerbank web search failed; falling back to chat", {
        name: error instanceof Error ? error.name : "unknown",
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const completion = await client.chat.completions.create({
    model: ANSWERBANK_MODEL,
    temperature: 0.2,
    max_tokens: 6000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No extra text." },
      { role: "user", content: prompt },
    ],
  });

  return {
    text: completion.choices?.[0]?.message?.content ?? "",
    model: completion.model,
    finishReason: completion.choices?.[0]?.finish_reason ?? undefined,
    usedWebSearch: false,
  };
}

async function requestCompactAnswerbankText(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
  target?: number;
  maxTokens?: number;
}): Promise<AnswerbankTextResult> {
  const { client, theme, language, size } = opts;
  const languageLabel = language === "es" ? "Spanish" : "English";
  const compactTarget = opts.target ?? (size === 11 ? 70 : 65);
  const compactMaxTokens = opts.maxTokens ?? (size === 11 ? 4200 : 4200);
  const prompt = `
Return ONLY compact JSON:
{"answers":["..."],"notes":[{"answer":"...","note":"..."}]}

Generate EXACTLY ${compactTarget} crossword answers for this theme.

THEME: ${theme}
LANGUAGE: ${languageLabel}
GRID SIZE: ${size}x${size}

Rules:
- Answers must be uppercase A-Z/digits only.
- Length must be 3..${size}.
- Every answer must be a complete standalone term, never a fragment.
- Prefer real named entities and specific theme terms.
- Add generic context words only when very characteristic of the theme.
- For 11x11, prioritize crossword-buildable thematic entries: at least ${Math.max(48, Math.floor(compactTarget * 0.68))} answers should be 4..7 letters when the theme has enough real names, terms, components, places, works, people, or objects.
- For 11x11, include a balanced spread: many 4-, 5-, 6-, and 7-letter answers; only a few 9..11-letter anchors.
- For 11x11, avoid returning mostly long names. Long entries are useful anchors, but short real entries make the crossword possible.
- For multiword names, a complete distinctive component is allowed when it can be clued through the full name.
- For place themes, mix landmarks, neighborhoods, lakes, hills, routes, foods, flora/fauna, activities, and regional names.
- Avoid generic words unless strongly characteristic of the theme.
- Avoid empty crossword filler such as CADA, CASO, IDEA, COLA, ALMA, BASE, DATO, DEDO, USO.
- Include one short factual note for every answer, 3..8 words.
- If you cannot write a factual theme note, skip the answer.
- Do not concatenate descriptors with names unless the whole phrase is an official/common name.
- Do not abbreviate by truncating a longer word.
- Do not include clues, markdown, or extra keys.
- Return one-line JSON only.
`;

  const allowWebSearch = process.env.OPENAI_ENABLE_WEB_SEARCH === "1";
  if (allowWebSearch) {
    try {
      const responsesClient = client as OpenAI & {
        responses?: {
          create(args: Record<string, unknown>): Promise<unknown>;
        };
      };

      if (responsesClient.responses?.create) {
        const response = await responsesClient.responses.create({
          model: ANSWERBANK_SEARCH_MODEL,
          tools: [
            {
              type: "web_search",
              search_context_size: "low",
              filters: {
                allowed_domains: ["wikipedia.org", "britannica.com"],
              },
            },
          ],
          tool_choice: "required",
          input: `${prompt}

Use web search only to ground the answer list. Prefer the theme's main encyclopedia page and directly related reputable pages.
Return ONLY the compact JSON schema requested above.`,
        });

        const text = extractResponseOutputText(response);
        const parsed = safeJson<RawAnswerBank>(text);
        if (parsed && Array.isArray(parsed.answers) && Array.isArray(parsed.notes)) {
          return {
            text,
            model: ANSWERBANK_SEARCH_MODEL,
            usedWebSearch: true,
          };
        }
      }
    } catch (error: unknown) {
      console.warn("[generate-crossword] compact answerbank web search failed; falling back to chat", {
        name: error instanceof Error ? error.name : "unknown",
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const completion = await client.chat.completions.create({
    model: COMPACT_ANSWERBANK_MODEL,
    temperature: 0.1,
    max_tokens: compactMaxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid compact JSON. No extra text." },
      { role: "user", content: prompt },
    ],
  });

  return {
    text: completion.choices?.[0]?.message?.content ?? "",
    model: completion.model,
    finishReason: completion.choices?.[0]?.finish_reason ?? undefined,
    usedWebSearch: false,
  };
}

async function requestLengthBucketedAnswerbankText(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
}): Promise<AnswerbankTextResult> {
  const { client, theme, language, size } = opts;
  const languageLabel = language === "es" ? "Spanish" : "English";
  // Exact-length quotas force the model to invent or distort terms when a
  // theme does not naturally contain enough answers of a given length.
  // Structural filler comes from the local dictionary instead.
  const requestedBuckets: Array<{ len: number; count: number }> = [];
  const localContextWords = language === "es" ? SPANISH_FILLER_WORDS : FILLER_WORDS;

  const corePromise = client.chat.completions.create({
    model: ANSWERBANK_SEARCH_MODEL,
    temperature: 0.15,
    max_tokens: 5200,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "crossword_thematic_core",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["entries"],
          properties: {
            entries: {
              type: "array",
              minItems: 20,
              maxItems: 70,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["answer", "canonical", "relation", "kind"],
                properties: {
                  answer: { type: "string", pattern: "^[A-Z0-9]{3,11}$" },
                  canonical: { type: "string", minLength: 2, maxLength: 100 },
                  relation: { type: "string", minLength: 8, maxLength: 140 },
                  kind: {
                    type: "string",
                    enum: ["exact", "name_part", "title_segment"],
                  },
                },
              },
            },
          },
        },
      },
    },
    messages: [
      {
        role: "system",
        content:
          "Return exact structured data. Preserve official spellings and never manufacture a word to satisfy a length.",
      },
      {
        role: "user",
        content: `
Generate between 40 and 70 candidate CORE crossword entries for THEME.

THEME: ${theme}
LANGUAGE: ${languageLabel}

These are candidates, so natural accuracy matters more than covering every length:
- Use only real, correctly spelled people, surnames, first names, places, works, characters, products, events, objects, roles, or technical terms specifically tied to THEME.
- Answers must naturally normalize to 3..11 uppercase A-Z/digits.
- Never use the exact theme text.
- Never clip, pad, respell, singularize, pluralize, abbreviate, or concatenate anything to fit.
- For exact and title_segment, normalizing CANONICAL must equal ANSWER.
- For name_part, ANSWER must be one complete token in the person's full CANONICAL name.
- A title segment must be a complete word or established standalone segment, not an arbitrary substring.
- RELATION must identify the concrete connection to THEME and be suitable for writing a factual clue.
- Prefer a broad natural distribution, especially accurate 4..8 letter entries, but do not force any length.
- Use the theme's full breadth: people, works, titles, characters, places, objects, events, and terminology.
- Stop as soon as you run out of exact, defensible identifiers. Never invent entries to reach 40.
- If a correct normalized identifier is longer than 11 characters, omit it. Never truncate it.
- Include legitimate deeper-cut identifiers only when their spelling and relationship are certain.

Forbidden examples: COUNTDOWNX, HANGAR18XX, PEACESELLSB, altered names, incomplete words.
`,
      },
    ],
  });

  const [coreCompletion, responses] = await Promise.all([
    corePromise,
    Promise.all(requestedBuckets.map(async ({ len, count }) => {
      const allowedContextWords = Array.from(
        new Set(
          localContextWords
            .map((word) => normalizeAnswer(word))
            .filter((word) => word.length === len && ASCII_A_TO_Z.test(word))
        )
      ).slice(0, 180);
      const prompt = `
Generate exactly ${count} different crossword entries of exactly ${len} normalized characters for THEME.

THEME: ${theme}
LANGUAGE: ${languageLabel}

The set must be useful for building a dense 11x11 crossword:
- Prefer entries with common crossing letters and varied letter positions.
- Use an exact thematic identifier only when its correct spelling naturally has exactly ${len} characters.
- Otherwise choose a real context word from ALLOWED_CONTEXT_WORDS and explain its concrete relationship to the theme.
- It is always better to use an allowed context word than to alter, clip, pad, singularize, pluralize, or invent a thematic term.
- First names and surnames are allowed when the note identifies the full person.
- A title segment is allowed only when CANONICAL contains exactly that complete segment, without truncation.
- Never include the exact theme text.
- No abbreviations, initials, codes, fragments, chopped words, invented compounds, altered singular/plural forms, or shortened titles.
- Every answer must contain exactly ${len} characters and only uppercase A-Z or digits.
- CANONICAL must be the correctly spelled complete word, title segment, or full person's name.
- For exact, title_segment, and context entries, normalizing CANONICAL must equal ANSWER exactly.
- For name_part entries, ANSWER must be one complete first name or surname in CANONICAL.
- RELATION must be concrete and factual, not a dictionary definition or vague phrase such as "related to the theme".

Critical examples:
- Never turn a title such as COUNTDOWN into COUNTDOWNX, or HANGAR18 into HANGAR18XX.
- Never change a person's name merely to reach the requested length.
- For kind=context, ANSWER must be copied exactly from ALLOWED_CONTEXT_WORDS.

ALLOWED_CONTEXT_WORDS:
${allowedContextWords.join(", ")}
`;

      const completion = await client.chat.completions.create({
        model: ANSWERBANK_SEARCH_MODEL,
        temperature: 0.2,
        max_tokens: Math.max(2200, count * 110),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: `crossword_entries_len_${len}`,
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["entries"],
              properties: {
                entries: {
                  type: "array",
                  minItems: count,
                  maxItems: count,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["answer", "canonical", "relation", "kind"],
                    properties: {
                      answer: {
                        type: "string",
                        pattern: `^[A-Z0-9]{${len}}$`,
                      },
                      canonical: {
                        type: "string",
                        minLength: 2,
                        maxLength: 100,
                      },
                      relation: {
                        type: "string",
                        minLength: 8,
                        maxLength: 120,
                      },
                      kind: {
                        type: "string",
                        enum: ["exact", "name_part", "title_segment", "context"],
                      },
                    },
                  },
                },
              },
            },
          },
        },
        messages: [
          {
            role: "system",
            content:
              "Return the exact structured output. Count every answer character and obey the requested length.",
          },
          { role: "user", content: prompt },
        ],
      });

      const text = completion.choices?.[0]?.message?.content ?? "";
      const parsed = safeJson<{
        entries?: Array<{
          answer?: string;
          canonical?: string;
          relation?: string;
          kind?: "exact" | "name_part" | "title_segment" | "context";
        }>;
      }>(text);
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      return {
        len,
        entries: entries
          .map((entry) => {
            const answer = normalizeAnswer(entry.answer ?? "");
            const canonical = (entry.canonical ?? "").trim();
            const canonicalNormalized = normalizeAnswer(canonical);
            const canonicalParts = canonical
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .toUpperCase()
              .split(/[^A-Z0-9]+/)
              .map((part) => normalizeAnswer(part))
              .filter(Boolean);
            const kind = entry.kind ?? "context";
            const canonicalMatches =
              kind === "name_part"
                ? canonicalParts.includes(answer)
                : canonicalNormalized === answer;
            const contextAllowed =
              kind !== "context" || allowedContextWords.includes(answer);
            return {
              answer,
              note: (entry.relation ?? "").trim(),
              kind,
              canonicalMatches,
              contextAllowed,
            };
          })
          .filter(
            (entry) =>
              entry.answer.length === len &&
              new RegExp(`^[A-Z0-9]{${len}}$`).test(entry.answer) &&
              entry.note.length >= 8 &&
              entry.canonicalMatches &&
              entry.contextAllowed
          ),
        model: completion.model,
      };
    })),
  ]);

  const answers: string[] = [];
  const notes: Array<{ answer: string; note: string }> = [];
  const coreAnswers: string[] = [];
  const contextAnswers: string[] = [];
  const seen = new Set<string>([normalizeAnswer(theme)]);
  const coreParsed = safeJson<{
    entries?: Array<{
      answer?: string;
      canonical?: string;
      relation?: string;
      kind?: "exact" | "name_part" | "title_segment";
    }>;
  }>(coreCompletion.choices?.[0]?.message?.content ?? "");
  for (const entry of coreParsed?.entries ?? []) {
    const answer = normalizeAnswer(entry.answer ?? "");
    const canonical = (entry.canonical ?? "").trim();
    const canonicalNormalized = normalizeAnswer(canonical);
    const canonicalParts = canonical
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .map((part) => normalizeAnswer(part))
      .filter(Boolean);
    const relation = (entry.relation ?? "").trim();
    const canonicalMatches =
      entry.kind === "name_part"
        ? canonicalParts.includes(answer)
        : canonicalNormalized === answer;
    if (
      answer.length < 3 ||
      answer.length > size ||
      !ASCII_A_TO_Z.test(answer) ||
      relation.length < 8 ||
      !canonicalMatches ||
      seen.has(answer)
    ) {
      continue;
    }
    seen.add(answer);
    answers.push(answer);
    notes.push({ answer, note: relation });
    coreAnswers.push(answer);
  }
  for (const response of responses) {
    for (const entry of response.entries) {
      if (seen.has(entry.answer)) continue;
      seen.add(entry.answer);
      answers.push(entry.answer);
      notes.push({ answer: entry.answer, note: entry.note });
      if (entry.kind === "context") contextAnswers.push(entry.answer);
      else coreAnswers.push(entry.answer);
    }
  }

  console.warn("[generate-crossword] structured length buckets", {
    requested: Object.fromEntries(requestedBuckets.map((bucket) => [bucket.len, bucket.count])),
    received: Object.fromEntries(
      answers.reduce((counts, answer) => {
        counts.set(answer.length, (counts.get(answer.length) ?? 0) + 1);
        return counts;
      }, new Map<number, number>())
    ),
    total: answers.length,
    core: coreAnswers.length,
    context: contextAnswers.length,
  });

  return {
    text: JSON.stringify({ answers, notes }),
    model: coreCompletion.model ?? responses[0]?.model ?? ANSWERBANK_SEARCH_MODEL,
    finishReason: "structured-length-buckets",
    usedWebSearch: false,
    trustedAnswers: answers,
    coreAnswers,
    contextAnswers,
  };
}

async function requestValidatedLayoutProposal(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
  pool: WordCandidate[];
  themeSet: Set<string>;
}): Promise<{ grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null> {
  const { client, theme, language, size, pool, themeSet } = opts;
  if (size !== 11) return null;

  const minLen = minEntryLenForSize(size);
  const thematicCandidates = pool
    .filter((candidate) => candidate.source !== "filler")
    .filter((candidate) => candidate.answer.length >= minLen && candidate.answer.length <= size)
    .filter((candidate) => ASCII_A_TO_Z.test(candidate.answer))
    .filter((candidate) => !isForbiddenPublishAnswer(candidate.answer))
    .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
    .sort((a, b) => {
      if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
      const aTheme = themeSet.has(a.answer) ? 1 : 0;
      const bTheme = themeSet.has(b.answer) ? 1 : 0;
      if (aTheme !== bTheme) return bTheme - aTheme;
      return a.answer.length - b.answer.length || a.answer.localeCompare(b.answer);
    });
  const fillerCandidates = pool
    .filter((candidate) => candidate.source === "filler")
    .filter((candidate) => candidate.answer.length >= minLen && candidate.answer.length <= 8)
    .filter((candidate) => ASCII_A_TO_Z.test(candidate.answer))
    .filter((candidate) => !isForbiddenPublishAnswer(candidate.answer))
    .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer));
  const dictionaryFillerCandidates: WordCandidate[] = Array.from(
    new Set([
      ...(language === "en" ? COMMON_ENGLISH_DICTIONARY_WORDS : []),
      ...(language === "en" ? FREQUENCY_ENGLISH_DICTIONARY_WORDS : FREQUENCY_SPANISH_DICTIONARY_WORDS),
    ])
  )
    .filter((answer) => answer.length >= minLen && answer.length <= 8)
    .filter((answer) => ASCII_A_TO_Z.test(answer))
    .filter((answer) => !isForbiddenPublishAnswer(answer))
    .filter((answer) => !WEAK_CONTEXT_DICTIONARY_WORDS.has(answer))
    .map((answer) => ({ answer, thematic: false, source: "filler" as const }));
  const allFillerCandidates = [...fillerCandidates, ...dictionaryFillerCandidates];
  const balancedFillerCandidates = [3, 4, 5, 6, 7, 8].flatMap((len) =>
    allFillerCandidates.filter((candidate) => candidate.answer.length === len).slice(0, 80)
  );
  const allowedCandidates = [...thematicCandidates, ...balancedFillerCandidates];

  const allowedAnswers = Array.from(new Set(allowedCandidates.map((candidate) => candidate.answer))).slice(0, 260);
  const thematicAnswers = Array.from(
    new Set(thematicCandidates.map((candidate) => candidate.answer))
  );
  if (allowedAnswers.length < minPublishEntriesForSize(size)) return null;

  const fixedPattern = [
    "#####....##",
    "####.....##",
    "####.....##",
    "###......##",
    "###......##",
    "#........##",
    "#........##",
    "#......####",
    "#....######",
    "###########",
    "###########",
  ];
  const fixedSlots = extractPatternSlots(fixedPattern);
  const byLength = new Map<number, string[]>();
  for (const answer of allowedAnswers) {
    const list = byLength.get(answer.length) ?? [];
    list.push(answer);
    byLength.set(answer.length, list);
  }
  const hasFixedSupply = fixedSlots.every((slot) => (byLength.get(slot.len)?.length ?? 0) >= 2);

  if (hasFixedSupply) {
    type LocalFixedFill = {
      grid: string[][];
      usedAnswers: string[];
      thematicEntries: number;
      score: number;
    };

    const localFilled = ((): LocalFixedFill | null => {
      const candidatesByLen = new Map<number, string[]>();
      for (const candidate of allowedCandidates) {
        if (candidate.answer.length < minLen || candidate.answer.length > size) continue;
        const list = candidatesByLen.get(candidate.answer.length) ?? [];
        if (!list.includes(candidate.answer)) list.push(candidate.answer);
        candidatesByLen.set(candidate.answer.length, list);
      }
      for (const [len, list] of candidatesByLen) {
        list.sort((a, b) => {
          const at = themeSet.has(a) ? 1 : 0;
          const bt = themeSet.has(b) ? 1 : 0;
          if (at !== bt) return bt - at;
          return a.localeCompare(b);
        });
        candidatesByLen.set(len, list.slice(0, 90));
      }

      let nodes = 0;
      let best: LocalFixedFill | null = null;
      const startGrid = fixedPattern.map((row) => row.split(""));
      const used = new Set<string>();
      const filled = new Set<number>();

      const optionListForSlot = (slotIndex: number, grid: string[][]) => {
        const slot = fixedSlots[slotIndex];
        const source = candidatesByLen.get(slot.len) ?? [];
        const options: string[] = [];
        for (const answer of source) {
          if (used.has(answer)) continue;
          let ok = true;
          for (let i = 0; i < slot.cells.length; i++) {
            const { r, c } = slot.cells[i];
            const current = grid[r][c];
            if (current !== "." && current !== answer[i]) {
              ok = false;
              break;
            }
          }
          if (ok) options.push(answer);
          if (options.length >= 36) break;
        }
        return options;
      };

      const search = (grid: string[][]) => {
        nodes++;
        if (nodes > 180_000) return;

        if (filled.size === fixedSlots.length) {
          const derived = deriveEntriesFromGrid(grid, minLen);
          const thematicEntries = derived.filter((entry) => themeSet.has(entry.answer)).length;
          const crossings = entryCrossingStats(grid, derived, minLen);
          if (
            derived.length === fixedSlots.length &&
            thematicEntries >= 10 &&
            crossings.weakEntries.length === 0 &&
            isAcceptable(grid, derived, themeSet)
          ) {
            const score = thematicEntries * 1000 + derived.length * 10;
            if (!best || score > best.score) {
              best = {
                grid: grid.map((row) => row.slice()),
                usedAnswers: derived.map((entry) => entry.answer),
                thematicEntries,
                score,
              };
            }
          }
          return;
        }

        let nextSlotIndex = -1;
        let nextOptions: string[] = [];
        for (let i = 0; i < fixedSlots.length; i++) {
          if (filled.has(i)) continue;
          const options = optionListForSlot(i, grid);
          if (options.length === 0) return;
          if (nextSlotIndex < 0 || options.length < nextOptions.length) {
            nextSlotIndex = i;
            nextOptions = options;
          }
        }
        if (nextSlotIndex < 0) return;

        const slot = fixedSlots[nextSlotIndex];
        nextOptions.sort((a, b) => {
          const at = themeSet.has(a) ? 1 : 0;
          const bt = themeSet.has(b) ? 1 : 0;
          if (at !== bt) return bt - at;
          return a.localeCompare(b);
        });

        filled.add(nextSlotIndex);
        for (const answer of nextOptions) {
          const changed: Array<{ r: number; c: number }> = [];
          let ok = true;
          for (let i = 0; i < slot.cells.length; i++) {
            const { r, c } = slot.cells[i];
            const current = grid[r][c];
            if (current !== "." && current !== answer[i]) {
              ok = false;
              break;
            }
            if (current === ".") {
              grid[r][c] = answer[i];
              changed.push({ r, c });
            }
          }
          if (ok) {
            used.add(answer);
            search(grid);
            used.delete(answer);
          }
          for (const { r, c } of changed) grid[r][c] = ".";
          if (best && best.thematicEntries === fixedSlots.length) break;
        }
        filled.delete(nextSlotIndex);
      };

      search(startGrid);
      const result = best as LocalFixedFill | null;
      if (result) {
        console.warn("[model-layout-11] fixed pattern local solved", {
          nodes,
          thematicEntries: result.thematicEntries,
          answers: result.usedAnswers,
        });
      } else {
        console.warn("[model-layout-11] fixed pattern local no fill", { nodes });
      }
      return result;
    })();

    if (localFilled) {
      const crossings = entryCrossingStats(localFilled.grid, deriveEntriesFromGrid(localFilled.grid, minLen), minLen);
      return {
        grid: localFilled.grid,
        usedAnswers: localFilled.usedAnswers,
        meta: {
          builder: "fixed-pattern-local-fill-11",
          acceptedEntries: localFilled.usedAnswers.length,
          thematicEntries: localFilled.thematicEntries,
          minEntryCheckedCells: crossings.minCheckedCells,
        },
      };
    }

    const slotLines = fixedSlots
      .map((slot, index) => {
        const options = (byLength.get(slot.len) ?? []).slice(0, 36).join(", ");
        return `${index + 1}. ${slot.direction.toUpperCase()} row=${slot.row} col=${slot.col} len=${slot.len}; allowed=${options}`;
      })
      .join("\n");

    try {
      const completion = await client.chat.completions.create({
        model: ANSWERBANK_SEARCH_MODEL,
        temperature: 0.1,
        max_tokens: 2600,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "fixed_pattern_fill_11",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["fills"],
              properties: {
                fills: {
                  type: "array",
                  minItems: 17,
                  maxItems: 17,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["slot", "answer"],
                    properties: {
                      slot: { type: "integer", minimum: 1, maximum: 17 },
                      answer: { type: "string", pattern: "^[A-Z0-9]{3,11}$" },
                    },
                  },
                },
              },
            },
          },
        },
        messages: [
          { role: "system", content: "Return ONLY valid JSON. Choose only listed allowed answers." },
          {
            role: "user",
            content: `
Fill this exact 11x11 crossword pattern for THEME: ${theme}
LANGUAGE: ${language === "es" ? "Spanish" : "English"}

Pattern:
${fixedPattern.join("\n")}

Slots and allowed answers:
${slotLines}

Rules:
- Return exactly 17 fills, one per slot number.
- Each answer must be copied exactly from that slot's allowed list.
- Do not use an answer twice.
- Crossing letters must match. Check every crossing before returning.
- Prefer answers from THEMATIC_ANSWERS; use filler only when necessary to satisfy crossings.
- Use at least 10 answers from THEMATIC_ANSWERS.

THEMATIC_ANSWERS:
${thematicAnswers.join(", ")}
`,
          },
        ],
      });

      const parsed = safeJson<{ fills?: Array<{ slot?: number; answer?: string }> }>(
        completion.choices?.[0]?.message?.content ?? ""
      );
      const fills = parsed?.fills;
      if (Array.isArray(fills)) {
        const grid = fixedPattern.map((row) => row.split(""));
        const used = new Set<string>();
        const seenSlots = new Set<number>();
        let conflict: string | null = null;
        for (const fill of fills) {
          const slotNumber = Number(fill.slot);
          const slot = fixedSlots[slotNumber - 1];
          const answer = normalizeAnswer(fill.answer ?? "");
          const allowedForSlot = new Set(byLength.get(slot?.len ?? -1) ?? []);
          if (!slot || seenSlots.has(slotNumber) || used.has(answer) || !allowedForSlot.has(answer)) {
            conflict = `bad-fill:${slotNumber}:${answer}`;
            break;
          }
          seenSlots.add(slotNumber);
          used.add(answer);
          for (let i = 0; i < slot.cells.length; i++) {
            const { r, c } = slot.cells[i];
            const current = grid[r][c];
            const next = answer[i];
            if (current !== "." && current !== next) {
              conflict = `cross-conflict:${slotNumber}:${answer}`;
              break;
            }
            grid[r][c] = next;
          }
          if (conflict) break;
        }

        if (!conflict && seenSlots.size === fixedSlots.length) {
          const candidateDerived = deriveEntriesFromGrid(grid, minLen);
          const thematicEntryCount = candidateDerived.filter((entry) =>
            themeSet.has(entry.answer)
          ).length;
          const crossings = entryCrossingStats(grid, candidateDerived, minLen);
          if (
            isAcceptable(grid, candidateDerived, themeSet) &&
            thematicEntryCount >= 10 &&
            crossings.weakEntries.length === 0
          ) {
            return {
              grid,
              usedAnswers: Array.from(used),
              meta: {
                builder: "fixed-pattern-model-fill-11",
                acceptedEntries: candidateDerived.length,
                thematicEntries: thematicEntryCount,
                minEntryCheckedCells: crossings.minCheckedCells,
              },
            };
          }
          console.warn("[model-layout-11] fixed pattern reject", {
            reason: "not-acceptable",
            entries: candidateDerived.length,
            thematicEntries: thematicEntryCount,
            weakEntries: crossings.weakEntries,
            answers: candidateDerived.map((entry) => entry.answer),
          });
        } else {
          console.warn("[model-layout-11] fixed pattern reject", {
            reason: "fill-conflict",
            conflict,
            seenSlots: seenSlots.size,
            fills,
          });
        }
      }
    } catch (error: unknown) {
      console.warn("[model-layout-11] fixed pattern failed", { msg: errorSummary(error) });
    }
  }

  const prompt = `
Return ONLY JSON:
{"layouts":[{"entries":[{"answer":"...","row":0,"col":0,"direction":"across"}]}]}

Build up to TWO different compact 11x11 crossword layout candidates using ONLY answers from ALLOWED_ANSWERS.

Rules:
- Each layout must use 15 to 17 entries. Prefer 16 when it fits cleanly.
- At least 10 entries in each layout must come from THEMATIC_ANSWERS.
- Use at least 6 across and at least 6 down entries.
- Every entry must cross at least TWO other entries.
- No answer may be used twice.
- Do not invent answers. Do not alter spelling.
- Coordinates are zero-based integers from 0 to 10.
- direction must be exactly "across" or "down".
- Entries must fit inside the 11x11 grid.
- Overlapping cells must have the same letter. Self-check every crossing before returning.
- Do not create adjacent unintended words: after placing the entries, every across/down run of 3+ letters must be one of the listed entries.
- Prefer a single compact interlocked cluster near the center, not isolated mini-puzzles.
- Prefer 4-8 letter answers because they are easier to cross densely in 11x11.
- Prefer the first, most thematic answers when possible, but every used answer must physically fit and cross at least twice.
- Black squares are implicit: only list placed answers.

THEME: ${theme}
LANGUAGE: ${language === "es" ? "Spanish" : "English"}
THEMATIC_ANSWERS:
${thematicAnswers.join(", ")}

ALLOWED_ANSWERS:
${allowedAnswers.join(", ")}
`;

  const completion = await client.chat.completions.create({
    model: ANSWERBANK_SEARCH_MODEL,
    temperature: 0.1,
    max_tokens: 2600,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No extra text." },
      { role: "user", content: prompt },
    ],
  });

  const text = completion.choices?.[0]?.message?.content ?? "";
  const parsed = safeJson<{
    layouts?: Array<{
      entries?: Array<{
        answer?: unknown;
        row?: unknown;
        col?: unknown;
        direction?: unknown;
      }>;
    }>;
    entries?: Array<{
      answer?: unknown;
      row?: unknown;
      col?: unknown;
      direction?: unknown;
    }>;
  }>(text);
  if (!parsed) {
    console.warn("[model-layout-11] reject", { reason: "json-parse", textHead: text.slice(0, 240) });
    return null;
  }

  const rawLayouts =
    Array.isArray(parsed.layouts) && parsed.layouts.length > 0
      ? parsed.layouts
      : Array.isArray(parsed.entries)
      ? [{ entries: parsed.entries }]
      : [];
  if (rawLayouts.length === 0) {
    console.warn("[model-layout-11] reject", { reason: "no-layouts", textHead: text.slice(0, 240) });
    return null;
  }

  const allowedSet = new Set(allowedAnswers);
  for (let layoutIndex = 0; layoutIndex < rawLayouts.length; layoutIndex++) {
    const entries = rawLayouts[layoutIndex].entries;
    if (!Array.isArray(entries)) {
      console.warn("[model-layout-11] reject", { layoutIndex, reason: "entries-not-array" });
      continue;
    }

    const seen = new Set<string>();
    const proposed: DerivedEntry[] = [];
    for (const item of entries) {
      const answer = normalizeAnswer(typeof item.answer === "string" ? item.answer : "");
      const rowValue =
        typeof item.row === "number"
          ? item.row
          : typeof item.row === "string" && item.row.trim() !== ""
          ? Number(item.row)
          : NaN;
      const colValue =
        typeof item.col === "number"
          ? item.col
          : typeof item.col === "string" && item.col.trim() !== ""
          ? Number(item.col)
          : NaN;
      const rawDirection = typeof item.direction === "string" ? item.direction.toLowerCase().trim() : "";
      const direction =
        rawDirection === "across" || rawDirection === "horizontal"
          ? "across"
          : rawDirection === "down" || rawDirection === "vertical"
          ? "down"
          : null;
      const row = Number.isInteger(rowValue) ? rowValue : -1;
      const col = Number.isInteger(colValue) ? colValue : -1;
      if (!answer || !direction) continue;
      if (!allowedSet.has(answer)) continue;
      if (seen.has(answer)) continue;
      if (answer.length < minLen || answer.length > size) continue;
      if (!inBounds(size, row, col)) continue;
      seen.add(answer);
      proposed.push({
        number: proposed.length + 1,
        row,
        col,
        direction,
        answer,
      });
    }

    const minLayoutEntriesToRepair = Math.max(minLen, minPublishEntriesForSize(size) - 1);
    if (proposed.length < minLayoutEntriesToRepair) {
      console.warn("[model-layout-11] reject", {
        layoutIndex,
        reason: "proposed-count",
        proposed: proposed.length,
      });
      continue;
    }
    const rebuilt =
      rebuildGridFromEntries(size, proposed, minLen) ??
      rebuildGridFromEntriesAllowingAllowedDerived(size, proposed, minLen, allowedSet);
    if (!rebuilt) {
      console.warn("[model-layout-11] reject", {
        layoutIndex,
        reason: "rebuild-failed",
        proposed: proposed.length,
        answers: proposed.map((entry) => entry.answer),
      });
      continue;
    }

    let candidateGrid = rebuilt.grid;
    let candidateDerived = rebuilt.derived;
    if (candidateDerived.length < minPublishEntriesForSize(size)) {
      const augmented = augmentNoShortGridWithCandidates(
        candidateGrid,
        allowedCandidates,
        minLen,
        minPublishEntriesForSize(size)
      );
      if (augmented) {
        candidateGrid = augmented.grid;
        candidateDerived = augmented.derived;
      }
    }

    if (!isAcceptable(candidateGrid, candidateDerived, themeSet)) {
      const crossings = entryCrossingStats(candidateGrid, candidateDerived, minLen);
      console.warn("[model-layout-11] reject", {
        layoutIndex,
        reason: "not-acceptable",
        proposed: proposed.length,
        derived: candidateDerived.length,
        thematicEntries: candidateDerived.filter((entry) => themeSet.has(entry.answer)).length,
        weakEntries: crossings.weakEntries,
        checkedRatio: checkedCellStats(candidateGrid, minLen).ratio,
        density: crosswordDensityFromGrid(candidateGrid),
        answers: candidateDerived.map((entry) => entry.answer),
      });
      continue;
    }
    const thematicEntryCount = candidateDerived.filter((entry) =>
      themeSet.has(entry.answer)
    ).length;
    if (thematicEntryCount < 10) continue;
    const crossings = entryCrossingStats(candidateGrid, candidateDerived, minLen);
    if (crossings.weakEntries.length > 0) continue;

    return {
      grid: candidateGrid,
      usedAnswers: Array.from(new Set(candidateDerived.map((entry) => entry.answer))),
      meta: {
        builder: "validated-model-layout-11",
        layoutIndex,
        proposedEntries: proposed.length,
        acceptedEntries: candidateDerived.length,
        thematicEntries: thematicEntryCount,
        minEntryCheckedCells: crossings.minCheckedCells,
      },
    };
  }

  return null;
}

async function requestDirectPlayableCrossword11(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  attempt: number;
}): Promise<Crossword | null> {
  const { client, theme, language, attempt } = opts;
  const size = 11;
  const minLen = minEntryLenForSize(size);
  const normalizedTheme = normalizeAnswer(theme);
  const pattern = [
    "###########",
    "#####....##",
    "#####....##",
    "###......##",
    "#........##",
    "........###",
    "........###",
    ".......####",
    ".......####",
    "###########",
    "###########",
  ];
  const slots = extractPatternSlots(pattern)
    .map(
      (slot, index) =>
        `${index + 1}. ${slot.direction.toUpperCase()} row=${slot.row} col=${slot.col} len=${slot.len}`
    )
    .join("\n");

  for (let tryIndex = 0; tryIndex < 2; tryIndex++) {
    const completion = await client.chat.completions.create({
      model: ANSWERBANK_SEARCH_MODEL,
      temperature: tryIndex === 0 ? 0.15 : 0.3,
      max_tokens: 5200,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "playable_crossword_11",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["fills"],
            properties: {
              fills: {
                type: "array",
                minItems: 17,
                maxItems: 17,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["slot", "answer", "clue", "relation"],
                  properties: {
                    slot: { type: "integer", minimum: 1, maximum: 17 },
                    answer: { type: "string", pattern: "^[A-Z0-9]{3,11}$" },
                    clue: { type: "string", minLength: 8, maxLength: 160 },
                    relation: { type: "string", minLength: 8, maxLength: 180 },
                  },
                },
              },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "Return exact JSON only. Fill the supplied crossword pattern; do not change its black squares.",
        },
        {
          role: "user",
          content:
            language === "es"
              ? `Rellena este patron de crucigrama tematico 11x11 sobre: ${theme}

Reglas obligatorias:
- Usa EXACTAMENTE este patron. # debe quedar #; cada . debe convertirse en una letra A-Z:
${pattern.join("\n")}
- Estos son los slots que debes rellenar; respeta largo, fila, columna y direccion:
${slots}
- Devuelve una lista fills con exactamente 17 objetos, uno por cada slot numerado.
- Cada answer debe tener exactamente el largo indicado para su slot.
- Las letras en los cruces deben coincidir entre slots. Verifica todos los cruces antes de responder.
- Todas las secuencias horizontales y verticales del patron ya son entradas; no agregues ni quites entradas.
- Cada entrada del patron cruza al menos dos celdas con entradas de la otra direccion.
- La respuesta exacta del tema (${normalizedTheme}) nunca puede aparecer como entrada.
- Cada respuesta debe ser real y defendible para el tema: persona, apellido, obra, lugar, termino tecnico, objeto, personaje, evento o palabra de dominio con relacion concreta.
- No uses palabras genericas si la pista no puede explicar una relacion concreta con ${theme}.
- No inventes, no recortes, no rellenes letras, no alteres plurales, no uses fragmentos.
- Las pistas deben ser concretas, no vagas, y no deben mencionar literalmente la respuesta.
- Evita afirmaciones temporales inestables como actual, ex, ultimo, hoy o desde.
- Si no hay suficientes respuestas tematicas exactas para todos los slots, usa palabras de dominio concretas del tema antes que relleno generico.

Devuelve solo fills. Cada fill debe traer slot, answer, clue y relation.`
              : `Fill this 11x11 themed crossword pattern about: ${theme}

Mandatory rules:
- Use EXACTLY this pattern. # must remain #; every . must become an A-Z letter:
${pattern.join("\n")}
- These are the slots to fill; respect length, row, column, and direction:
${slots}
- Return a fills list with exactly 17 objects, one for each numbered slot.
- Each answer must have exactly the length required by its slot.
- Crossing letters must match between slots. Check every crossing before answering.
- Every across/down run in the pattern is an entry; do not add or remove entries.
- Every entry in the pattern crosses at least two cells with entries in the other direction.
- The exact theme answer (${normalizedTheme}) must never appear as an entry.
- Every answer must be real and defensible for the theme: person, surname, work, place, technical term, object, character, event, or domain word with a concrete relation.
- Do not use generic words unless the clue states a concrete relationship to ${theme}.
- Do not invent, truncate, pad, respell, change plurals, or use fragments.
- Clues must be concrete, not vague, and must not literally mention the answer.
- Avoid unstable temporal claims such as current, former, latest, today, or since.
- If exact thematic identifiers are not enough for every slot, use concrete theme-domain words before generic filler.

Return only fills. Each fill must include slot, answer, clue, and relation.`,
        },
      ],
    });

    const parsed = safeJson<{
      fills?: Array<{ slot?: number; answer?: string; clue?: string; relation?: string }>;
    }>(completion.choices?.[0]?.message?.content ?? "");
    const fills = parsed?.fills;
    if (!Array.isArray(fills)) {
      console.warn("[direct-11] reject", { attempt, tryIndex, reason: "parse" });
      continue;
    }

    const slotByNumber = new Map(extractPatternSlots(pattern).map((slot, index) => [index + 1, slot] as const));
    const grid = pattern.map((row) => row.split(""));
    if (hasShortLetterRuns(grid, minLen)) {
      console.warn("[direct-11] reject", { attempt, tryIndex, reason: "bad-pattern-short-runs" });
      continue;
    }

    const modelByAnswer = new Map<string, { clue: string; relation: string }>();
    const seenSlots = new Set<number>();
    let fillConflict: string | null = null;
    for (const item of fills) {
      const slotNumber = Number(item.slot);
      const slot = slotByNumber.get(slotNumber);
      const answer = normalizeAnswer(item.answer ?? "");
      const clue = sanitizeModelClueText(String(item.clue ?? ""), language);
      const relation = String(item.relation ?? "").trim();
      if (!slot || seenSlots.has(slotNumber)) {
        fillConflict = `bad-slot:${slotNumber}`;
        break;
      }
      if (!answer || answer.length !== slot.len || !clue || !relation) {
        fillConflict = `bad-answer:${slotNumber}:${answer}`;
        break;
      }
      seenSlots.add(slotNumber);
      for (let i = 0; i < slot.cells.length; i++) {
        const { r, c } = slot.cells[i];
        const current = grid[r][c];
        const next = answer[i];
        if (current !== "." && current !== next) {
          fillConflict = `cross-conflict:${slotNumber}:${answer}`;
          break;
        }
        grid[r][c] = next;
      }
      if (fillConflict) break;
      if (!modelByAnswer.has(answer)) modelByAnswer.set(answer, { clue, relation });
    }
    if (fillConflict || seenSlots.size !== slotByNumber.size) {
      console.warn("[direct-11] reject", {
        attempt,
        tryIndex,
        reason: "fill-conflict",
        fillConflict,
        seenSlots: seenSlots.size,
        expectedSlots: slotByNumber.size,
        fills: fills.map((fill) => ({ slot: fill.slot, answer: fill.answer })),
      });
      continue;
    }
    const derived = deriveEntriesFromGrid(grid, minLen);
    const derivedAnswers = derived.map((entry) => entry.answer);
    const uniqueDerivedAnswers = new Set(derivedAnswers);
    const missingMetadata = derivedAnswers.filter((answer) => !modelByAnswer.has(answer));
    const extraMetadata = Array.from(modelByAnswer.keys()).filter((answer) => !uniqueDerivedAnswers.has(answer));

    if (
      derived.length < minPublishEntriesForSize(size) ||
      derived.length > 19 ||
      uniqueDerivedAnswers.size !== derived.length ||
      missingMetadata.length > 0 ||
      extraMetadata.length > 0 ||
      derivedAnswers.includes(normalizedTheme)
    ) {
      console.warn("[direct-11] reject", {
        attempt,
        tryIndex,
        reason: "entry-mismatch",
        derived: derived.length,
        missingMetadata,
        extraMetadata,
        answers: derivedAnswers,
      });
      continue;
    }

    const crossing = entryCrossingStats(grid, derived, minLen);
    const checked = checkedCellStats(grid, minLen);
    if (crossing.weakEntries.length > 0 || checked.ratio < 0.25 || crosswordDensityFromGrid(grid) < 0.4) {
      console.warn("[direct-11] reject", {
        attempt,
        tryIndex,
        reason: "weak-structure",
        weakEntries: crossing.weakEntries,
        checkedRatio: checked.ratio,
        density: crosswordDensityFromGrid(grid),
      });
      continue;
    }

    const validated = await validateThematicAnswers({
      client,
      theme,
      language,
      size,
      answers: derivedAnswers,
      attempt,
    });
    const thematicSet = new Set(validated);
    if (thematicSet.size < Math.max(10, Math.ceil(derived.length * 0.7))) {
      console.warn("[direct-11] reject", {
        attempt,
        tryIndex,
        reason: "weak-theme",
        thematic: thematicSet.size,
        entries: derived.length,
        rejected: derivedAnswers.filter((answer) => !thematicSet.has(answer)),
      });
      continue;
    }

    const notesByAnswer = new Map<string, string>();
    const directClues = new Map<string, string>();
    for (const answer of derivedAnswers) {
      const metadata = modelByAnswer.get(answer);
      if (!metadata) continue;
      notesByAnswer.set(answer, metadata.relation);
      if (
        !isBadClue(metadata.clue) &&
        !clueMentionsAnswer(metadata.clue, answer) &&
        !clueMakesUnstableTemporalClaim(metadata.clue, language) &&
        !clueMislabelsPartialPersonAnswer(answer, metadata.clue, language) &&
        !clueMislabelsKnownPartialTitle(theme, answer, metadata.clue)
      ) {
        directClues.set(answer, metadata.clue);
      }
    }

    const clueItems: ClueRequestItem[] = derivedAnswers.map((answer) => {
      const note = notesByAnswer.get(answer);
      return {
        answer,
        thematic: thematicSet.has(answer),
        note,
        hint: thematicSet.has(answer)
          ? buildThematicClueRequestHint(theme, answer, language, note) ?? undefined
          : undefined,
      };
    });
    const modelClues = await requestModelClues({ client, theme, language, items: clueItems });
    for (const [answer, clue] of modelClues.entries()) directClues.set(answer, clue);
    reinforceThematicClues(theme, language, derivedAnswers, directClues, notesByAnswer, thematicSet);

    const entries = repairPublishClues(applyCluesAndOverrides(theme, language, derived, directClues), {
      theme,
      language,
      thematicSet,
      notesByAnswer,
    });
    const qualityIssue = publishQualityIssue(
      entries,
      thematicSet,
      language,
      minPublishEntriesForSize(size),
      theme
    );
    if (qualityIssue) {
      console.warn("[direct-11] reject", {
        attempt,
        tryIndex,
        reason: "quality",
        qualityIssue,
        answers: entries.map((entry) => ({ answer: entry.answer, clue: entry.clue })),
      });
      continue;
    }

    return {
      theme,
      language,
      size,
      grid,
      entries,
      meta: {
        source: "direct-validated-model-11",
        attempt,
        tryIndex,
        coreThematicEntries: thematicSet.size,
        genericContextEntries: entries.length - thematicSet.size,
        checkedRatio: checked.ratio,
        minEntryCheckedCells: crossing.minCheckedCells,
      },
    };
  }

  return null;
}

async function requestValidatedPatternAssignment11(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
  pool: WordCandidate[];
  themeSet: Set<string>;
}): Promise<{ grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null> {
  const { client, theme, language, size, pool, themeSet } = opts;
  if (size !== 11) return null;

  const allowedCandidates = Array.from(
    new Map(
      pool
        .filter((candidate) => candidate.source !== "filler")
        .filter(
          (candidate) =>
            themeSet.has(candidate.answer) ||
            candidate.thematic ||
            candidate.source === "support"
        )
        .filter((candidate) => !isForbiddenPublishAnswer(candidate.answer))
        .filter(
          (candidate) =>
            themeSet.has(candidate.answer) ||
            !isOverGenericThemeWordForTheme(theme, candidate.answer)
        )
        .map((candidate) => [candidate.answer, candidate] as const)
    ).values()
  );
  const byLength = new Map<number, string[]>();
  for (const candidate of allowedCandidates) {
    const bucket = byLength.get(candidate.answer.length) ?? [];
    bucket.push(candidate.answer);
    byLength.set(candidate.answer.length, bucket);
  }

  const viablePatterns = PATTERN_11X11S
    .map((pattern, patternIndex) => {
      const slots = extractPatternSlots(pattern);
      const needByLength = slots.reduce((counts, slot) => {
        counts.set(slot.len, (counts.get(slot.len) ?? 0) + 1);
        return counts;
      }, new Map<number, number>());
      const hasSupply = Array.from(needByLength).every(
        ([len, needed]) => (byLength.get(len)?.length ?? 0) >= needed
      );
      return { pattern, patternIndex, slots, needByLength, hasSupply };
    })
    .filter(
      (item) =>
        item.hasSupply &&
        item.slots.length >= minPublishEntriesForSize(size) &&
        item.slots.length <= desiredPublishEntriesForSize(size)
    )
    .slice(0, 3);

  if (viablePatterns.length === 0) return null;

  const requiredLengths = new Set(
    viablePatterns.flatMap((item) => item.slots.map((slot) => slot.len))
  );
  const candidateText = Array.from(requiredLengths)
    .sort((a, b) => a - b)
    .map((len) => `${len}: ${(byLength.get(len) ?? []).join(", ")}`)
    .join("\n");
  const patternText = viablePatterns
    .map((item) => {
      const slots = item.slots
        .map(
          (slot, slotIndex) =>
            `${slotIndex}: ${slot.direction}, row ${slot.row}, col ${slot.col}, length ${slot.len}`
        )
        .join("\n");
      return `PATTERN ${item.patternIndex}\n${item.pattern.join("\n")}\nSLOTS IN REQUIRED ANSWER ORDER:\n${slots}`;
    })
    .join("\n\n");

  const prompt = `
Return ONLY JSON:
{"fills":[{"patternIndex":number,"answers":["ANSWER_FOR_SLOT_0","ANSWER_FOR_SLOT_1"]}]}

Fill one of the supplied 11x11 crossword patterns using ONLY CANDIDATES.
The answers array must follow the exact slot order printed for that pattern.

Hard rules:
- Fill every slot. Use each answer at most once.
- Every answer must have exactly the slot length.
- At every across/down intersection, both answers must have the same letter.
- Do not invent, alter, shorten, or concatenate answers.
- Return up to five different complete fills if possible.
- Check every crossing before returning JSON.

THEME: ${theme}
LANGUAGE: ${language === "es" ? "Spanish" : "English"}

CANDIDATES GROUPED BY EXACT LENGTH:
${candidateText}

${patternText}
`;

  const completion = await client.chat.completions.create({
    model: ANSWERBANK_SEARCH_MODEL,
    temperature: 0.1,
    max_tokens: 3600,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Solve the constrained crossword exactly. Return ONLY valid JSON.",
      },
      { role: "user", content: prompt },
    ],
  });
  const text = completion.choices?.[0]?.message?.content ?? "";
  const parsed = safeJson<{
    fills?: Array<{ patternIndex?: unknown; answers?: unknown }>;
  }>(text);
  if (!parsed?.fills || !Array.isArray(parsed.fills)) {
    console.warn("[pattern-assignment-11] reject", {
      reason: "json-parse",
      textHead: text.slice(0, 240),
    });
    return null;
  }

  const allowedSet = new Set(allowedCandidates.map((candidate) => candidate.answer));
  for (let fillIndex = 0; fillIndex < parsed.fills.length; fillIndex++) {
    const fill = parsed.fills[fillIndex];
    const patternIndex =
      typeof fill.patternIndex === "number" && Number.isInteger(fill.patternIndex)
        ? fill.patternIndex
        : -1;
    const selectedPattern = viablePatterns.find((item) => item.patternIndex === patternIndex);
    if (!selectedPattern || !Array.isArray(fill.answers)) continue;

    const answers = fill.answers.map((answer) =>
      normalizeAnswer(typeof answer === "string" ? answer : "")
    );
    if (answers.length !== selectedPattern.slots.length) continue;
    if (new Set(answers).size !== answers.length) continue;
    if (
      answers.some(
        (answer, slotIndex) =>
          !allowedSet.has(answer) || answer.length !== selectedPattern.slots[slotIndex].len
      )
    ) {
      continue;
    }
    const coreAnswerCount = answers.filter((answer) => themeSet.has(answer)).length;
    if (coreAnswerCount < 10 || answers.length - coreAnswerCount > 5) continue;

    const grid: string[][] = selectedPattern.pattern.map((row) =>
      row.split("").map((cell) => (cell === "#" ? "#" : ""))
    );
    let conflict = false;
    for (let slotIndex = 0; slotIndex < selectedPattern.slots.length && !conflict; slotIndex++) {
      const slot = selectedPattern.slots[slotIndex];
      const answer = answers[slotIndex];
      for (let letterIndex = 0; letterIndex < slot.cells.length; letterIndex++) {
        const cell = slot.cells[letterIndex];
        const existing = grid[cell.r][cell.c];
        const letter = answer[letterIndex];
        if (existing !== "" && existing !== letter) {
          conflict = true;
          break;
        }
        grid[cell.r][cell.c] = letter;
      }
    }
    if (conflict) continue;

    const finalGrid = grid.map((row) => row.map((cell) => (cell === "" ? "#" : cell)));
    const derived = deriveEntriesFromGrid(finalGrid, minEntryLenForSize(size));
    const crossings = entryCrossingStats(finalGrid, derived, minEntryLenForSize(size));
    if (derived.length !== selectedPattern.slots.length) continue;
    if (crossings.weakEntries.length > 0) continue;
    if (derived.some((entry) => !allowedSet.has(entry.answer))) continue;

    console.warn("[pattern-assignment-11] accepted", {
      fillIndex,
      patternIndex,
      entries: derived.length,
      coreAnswerCount,
      contextualAnswerCount: answers.length - coreAnswerCount,
      minEntryCheckedCells: crossings.minCheckedCells,
    });
    return {
      grid: finalGrid,
      usedAnswers: answers,
      meta: {
        builder: "model-pattern-assignment-11x11",
        patternIndex,
        patternRows: selectedPattern.pattern,
        coreAnswerCount,
        contextualAnswerCount: answers.length - coreAnswerCount,
        minEntryCheckedCells: crossings.minCheckedCells,
      },
    };
  }

  console.warn("[pattern-assignment-11] reject", {
    reason: "no-valid-fill",
    fills: parsed.fills.length,
    viablePatterns: viablePatterns.map((item) => item.patternIndex),
    textHead: text.slice(0, 240),
  });
  return null;
}

async function requestGeneratedPatternGrid11(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
  attempt: number;
}): Promise<{
  grid: string[][];
  usedAnswers: string[];
  thematicAnswers: string[];
  notes: Map<string, string>;
  meta: Record<string, unknown>;
} | null> {
  const { client, theme, language, size, attempt } = opts;
  if (size !== 11) return null;

  const patternIndex = 0;
  const pattern = PATTERN_11X11S[patternIndex];
  const slots = extractPatternSlots(pattern);
  const rowProperties = Object.fromEntries(
    pattern.map((row, index) => [
      `r${index}`,
      {
        type: "string",
        pattern: `^${Array.from(row)
          .map((cell) => (cell === "#" ? "#" : "[A-Z]"))
          .join("")}$`,
      },
    ])
  );
  const prompt = `
Return the exact structured object containing one completed grid.

Create one fully filled themed crossword using the exact 11x11 PATTERN below.

PATTERN:
${pattern.join("\n")}

Rules:
- Keep every # exactly where it is.
- Replace every . with one uppercase A-Z letter.
- Every horizontal or vertical run of 3+ letters must be a real, complete crossword answer.
- The finished pattern has exactly ${slots.length} entries. All ${slots.length} must be different.
- At least 10 entries must be specific named terms, people, works, places, objects, or identifiers from THEME.
- Up to 5 entries may be ordinary context words only when they have a direct factual relationship to THEME.
- Do not use the exact theme text as an answer.
- No abbreviations, initials, codes, fragments, clipped names, altered titles, invented spellings, or nonsense.
- Check every across and down answer after filling the rows.

THEME: ${theme}
LANGUAGE: ${language === "es" ? "Spanish" : "English"}
`;

  const completion = await client.chat.completions.create({
    model: ANSWERBANK_SEARCH_MODEL,
    temperature: 0.2,
    max_tokens: 5200,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "fixed_crossword_grid_11",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["rows"],
          properties: {
            rows: {
              type: "object",
              additionalProperties: false,
              required: pattern.map((_, index) => `r${index}`),
              properties: rowProperties,
            },
          },
        },
      },
    },
    messages: [
      {
        role: "system",
        content: "Build exact crossword grids. Return ONLY valid JSON and self-check every row and crossing.",
      },
      { role: "user", content: prompt },
    ],
  });
  const text = completion.choices?.[0]?.message?.content ?? "";
  const parsed = safeJson<{
    rows?: Record<string, unknown>;
    grids?: Array<{
      rows?: unknown;
      notes?: Array<{ answer?: unknown; note?: unknown }>;
    }>;
  }>(text);
  const parsedRows =
    parsed?.rows && typeof parsed.rows === "object"
      ? pattern.map((_, index) => parsed.rows?.[`r${index}`])
      : null;
  const parsedGrids =
    parsedRows && parsedRows.length === size
      ? [{ rows: parsedRows, notes: [] }]
      : parsed?.grids;
  if (!parsedGrids || !Array.isArray(parsedGrids)) {
    console.warn("[generated-pattern-grid-11] reject", {
      reason: "json-parse",
      textHead: text.slice(0, 240),
    });
    return null;
  }

  const candidates: Array<{
    grid: string[][];
    answers: string[];
    notes: Map<string, string>;
    gridIndex: number;
  }> = [];
  const allAnswers = new Set<string>();
  const normalizedTheme = normalizeAnswer(theme);

  for (let gridIndex = 0; gridIndex < parsedGrids.length; gridIndex++) {
    const rawGrid = parsedGrids[gridIndex];
    if (!Array.isArray(rawGrid.rows) || rawGrid.rows.length !== size) continue;
    const rows = rawGrid.rows.map((row) =>
      typeof row === "string" ? row.trim().toUpperCase() : ""
    );
    if (rows.some((row) => row.length !== size || !/^[#A-Z]+$/.test(row))) continue;
    const shapeMatches = rows.every((row, r) =>
      Array.from(row).every((cell, c) =>
        pattern[r][c] === "#" ? cell === "#" : cell !== "#"
      )
    );
    if (!shapeMatches) continue;

    const grid = rows.map((row) => row.split(""));
    const derived = deriveEntriesFromGrid(grid, minEntryLenForSize(size));
    if (derived.length !== slots.length) continue;
    const answers = derived.map((entry) => entry.answer);
    if (new Set(answers).size !== answers.length) continue;
    if (answers.includes(normalizedTheme)) continue;
    if (
      answers.some(
        (answer) =>
          isForbiddenPublishAnswer(answer) ||
          (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer))
      )
    ) {
      continue;
    }
    const crossings = entryCrossingStats(grid, derived, minEntryLenForSize(size));
    if (crossings.weakEntries.length > 0) continue;

    const notes = new Map<string, string>();
    for (const item of rawGrid.notes ?? []) {
      const answer = normalizeAnswer(typeof item.answer === "string" ? item.answer : "");
      const note = typeof item.note === "string" ? item.note.trim() : "";
      if (!answers.includes(answer) || note.length < 8 || noteLooksWeakThematicContext(note, language)) {
        continue;
      }
      notes.set(answer, note);
    }
    for (const answer of answers) allAnswers.add(answer);
    candidates.push({ grid, answers, notes, gridIndex });
  }

  if (candidates.length === 0) {
    console.warn("[generated-pattern-grid-11] reject", {
      reason: "no-structurally-valid-grid",
      returned: parsedGrids.length,
      textHead: text.slice(0, 240),
    });
    return null;
  }

  const validated = await validateThematicAnswers({
    client,
    theme,
    language,
    size,
    answers: Array.from(allAnswers),
    attempt,
  });
  const validatedSet = new Set(validated);

  for (const candidate of candidates) {
    const localDictionary = new Set(
      (language === "es" ? SPANISH_FILLER_WORDS : FILLER_WORDS).map((answer) =>
        normalizeAnswer(answer)
      )
    );
    const supportedAnswers = candidate.answers.filter((answer) => {
      if (validatedSet.has(answer)) return true;
      if (localDictionary.has(answer)) return true;
      return hasStrongThematicClueSupport({
        theme,
        answer,
        language,
        note: candidate.notes.get(answer),
      });
    });
    const validatedCount = candidate.answers.filter((answer) => validatedSet.has(answer)).length;
    if (validatedCount < 8 || supportedAnswers.length !== candidate.answers.length) continue;

    console.warn("[generated-pattern-grid-11] accepted", {
      gridIndex: candidate.gridIndex,
      entries: candidate.answers.length,
      validatedCount,
      contextualCount: candidate.answers.length - validatedCount,
    });
    return {
      grid: candidate.grid,
      usedAnswers: candidate.answers,
      thematicAnswers: supportedAnswers,
      notes: candidate.notes,
      meta: {
        builder: "generated-fixed-pattern-11x11",
        patternIndex,
        patternRows: pattern,
        validatedThematicEntries: validatedCount,
        contextualEntries: candidate.answers.length - validatedCount,
      },
    };
  }

  console.warn("[generated-pattern-grid-11] reject", {
    reason: "thematic-validation",
    structurallyValid: candidates.length,
    validated: validated.length,
  });
  return null;
}

async function requestValidatedGridProposal(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
  pool: WordCandidate[];
  themeSet: Set<string>;
}): Promise<{ grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null> {
  const { client, theme, language, size, pool, themeSet } = opts;
  if (size !== 11) return null;

  const minLen = minEntryLenForSize(size);
  const allowedCandidates = pool
    .filter((candidate) => candidate.source !== "filler")
    .filter((candidate) => candidate.answer.length >= minLen && candidate.answer.length <= size)
    .filter((candidate) => ASCII_A_TO_Z.test(candidate.answer))
    .filter((candidate) => !isForbiddenPublishAnswer(candidate.answer))
    .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
    .sort((a, b) => {
      if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
      const aTheme = themeSet.has(a.answer) ? 1 : 0;
      const bTheme = themeSet.has(b.answer) ? 1 : 0;
      if (aTheme !== bTheme) return bTheme - aTheme;
      const aLenScore = a.answer.length >= 4 && a.answer.length <= 8 ? 0 : 1;
      const bLenScore = b.answer.length >= 4 && b.answer.length <= 8 ? 0 : 1;
      return aLenScore - bLenScore || a.answer.length - b.answer.length || a.answer.localeCompare(b.answer);
    });

  const allowedAnswers = Array.from(new Set(allowedCandidates.map((candidate) => candidate.answer))).slice(0, 90);
  if (allowedAnswers.length < minPublishEntriesForSize(size)) return null;

  const prompt = `
Return ONLY JSON:
{"grids":[{"rows":["###########","###########","###########","###########","###########","###########","###########","###########","###########","###########","###########"]}]}

Build THREE candidate 11x11 crossword grids.

Hard rules:
- Each grid has exactly 11 rows and each row has exactly 11 characters.
- Use only uppercase A-Z, digits, and #.
- Every across/down entry of length 3 or more MUST be one exact answer from ALLOWED_ANSWERS.
- Use 15 to 17 total entries. Prefer 16 when it fits cleanly.
- Use at least 6 across and at least 6 down entries.
- Every entry must have at least TWO checked cells.
- No answer may appear twice, including singular/plural variants.
- Do not invent answers or alter spelling.
- Do not create any 2-letter across or down runs.
- Prefer a compact interlocked cluster near the center.
- Prefer the first, most thematic answers.

THEME: ${theme}
LANGUAGE: ${language === "es" ? "Spanish" : "English"}
ALLOWED_ANSWERS:
${allowedAnswers.join(", ")}
`;

  const completion = await client.chat.completions.create({
    model: ANSWERBANK_SEARCH_MODEL,
    temperature: 0.1,
    max_tokens: 5200,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No extra text." },
      { role: "user", content: prompt },
    ],
  });

  const text = completion.choices?.[0]?.message?.content ?? "";
  const parsed = safeJson<{
    grids?: Array<{
      rows?: unknown;
    }>;
    rows?: unknown;
  }>(text);
  if (!parsed) return null;

  const rawGrids =
    Array.isArray(parsed.grids) && parsed.grids.length > 0
      ? parsed.grids
      : Array.isArray(parsed.rows)
      ? [{ rows: parsed.rows }]
      : [];
  const allowedSet = new Set(allowedAnswers);

  for (let gridIndex = 0; gridIndex < rawGrids.length; gridIndex++) {
    const rows = rawGrids[gridIndex].rows;
    if (!Array.isArray(rows)) {
      console.warn("[model-grid-11] reject", { gridIndex, reason: "rows-not-array" });
      continue;
    }
    if (rows.length !== size) {
      console.warn("[model-grid-11] reject", { gridIndex, reason: "wrong-row-count", rows: rows.length });
      continue;
    }

    let grid = rows.map((row) => {
      if (typeof row !== "string") return [];
      const cleaned = row
        .toUpperCase()
        .replace(/^\s*\d+\s*[:.)-]?\s*/, "")
        .replace(/[.\-_*·]/g, "#")
        .replace(/[^A-Z0-9#]/g, "");
      const exact =
        cleaned.length === size
          ? cleaned
          : cleaned.length > size
          ? cleaned.slice(0, size)
          : cleaned.length >= size - 2
          ? cleaned.padEnd(size, "#")
          : cleaned.match(/[A-Z0-9#]{11}/)?.[0] ?? "";
      return exact.split("").map((cell) => (/^[A-Z0-9]$/.test(cell) ? cell : "#"));
    });

    if (grid.some((row) => row.length !== size)) {
      console.warn("[model-grid-11] reject", { gridIndex, reason: "wrong-row-length", rows });
      continue;
    }
    if (hasShortLetterRuns(grid, minLen)) {
      const cleanedGrid = blockShortRunsOnly(grid, minLen);
      if (hasShortLetterRuns(cleanedGrid, minLen)) {
        console.warn("[model-grid-11] reject", { gridIndex, reason: "short-runs", rows });
        continue;
      }
      console.warn("[model-grid-11] repaired", { gridIndex, reason: "short-runs" });
      grid = cleanedGrid;
    }

    const derived = deriveEntriesFromGrid(grid, minLen);
    if (derived.length < minPublishEntriesForSize(size) || derived.length > 17) {
      console.warn("[model-grid-11] reject", {
        gridIndex,
        reason: "entry-count",
        entries: derived.length,
        answers: derived.map((entry) => entry.answer),
      });
      continue;
    }
    const outOfBank = derived.filter((entry) => !allowedSet.has(entry.answer));
    if (outOfBank.length > 0) {
      console.warn("[model-grid-11] reject", {
        gridIndex,
        reason: "out-of-bank",
        entries: derived.length,
        outOfBank: outOfBank.map((entry) => entry.answer),
      });
      continue;
    }
    if (!isAcceptable(grid, derived, themeSet)) {
      const crossings = entryCrossingStats(grid, derived, minLen);
      console.warn("[model-grid-11] reject", {
        gridIndex,
        reason: "not-acceptable",
        entries: derived.length,
        thematicEntries: derived.filter((entry) => themeSet.has(entry.answer)).length,
        across: derived.filter((entry) => entry.direction === "across").length,
        down: derived.filter((entry) => entry.direction === "down").length,
        weakEntries: crossings.weakEntries,
        checkedRatio: checkedCellStats(grid, minLen).ratio,
        density: crosswordDensityFromGrid(grid),
        answers: derived.map((entry) => entry.answer),
      });
      continue;
    }

    const crossings = entryCrossingStats(grid, derived, minLen);
    if (crossings.weakEntries.length > 0) continue;

    return {
      grid,
      usedAnswers: derived.map((entry) => entry.answer),
      meta: {
        builder: "validated-model-grid-11",
        gridIndex,
        acceptedEntries: derived.length,
        minEntryCheckedCells: crossings.minCheckedCells,
      },
    };
  }

  return null;
}

function buildThematicClueRequestHint(
  theme: string,
  answer: string,
  language: "es" | "en",
  note?: string | null
): string | null {
  const specific = specificThematicFallbackClue(theme, answer, language);
  if (specific) return specific;

  if (note && !noteLooksWeakThematicContext(note, language)) {
    const fromNote = clueFromThemeNote(theme, note, language);
    if (fromNote) return fromNote;

    const cleaned = note.replace(/\s+/g, " ").trim();
    if (cleaned.length >= 12) {
      return language === "es"
        ? `Contexto temático para ${theme}: ${cleaned}`
        : `Theme context for ${theme}: ${cleaned}`;
    }
  }

  return null;
}

type ClueRequestItem = {
  answer: string;
  thematic: boolean;
  hint?: string;
  note?: string;
};

async function requestModelClues(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  items: ClueRequestItem[];
}): Promise<Map<string, string>> {
  const { client, theme, language, items } = opts;
  const clueByAnswer = new Map<string, string>();
  const itemsJson = JSON.stringify(items);

  const cluebankRequest =
    CLUEBANK_PROMPT
      .replace("${theme}", theme)
      .replace("${languageLabel}", language === "es" ? "Spanish" : "English")
      .replace("${itemsJson}", itemsJson) +
    "\n\n" +
    (language === "es"
      ? [
          "REGLAS CRITICAS (OBLIGATORIAS):",
          "- El TEMA elegido es obligatorio y debe influir en TODAS las pistas de los items con thematic:true.",
          "- Si un item incluye un campo hint, ese hint marca la lectura tematica correcta y NO debes degradarla a una lectura generica.",
          "- Si un item incluye un campo note, tomalo como contexto tematico adicional para elegir la pista correcta.",
          "- Si una respuesta admite una lectura generica y otra vinculada al tema, elige SIEMPRE la lectura vinculada al tema.",
          "- NUNCA uses pistas como 'relleno de crucigrama', 'palabra comun' o equivalentes.",
          "- No uses afirmaciones temporales inestables como 'actual', 'ex', 'ultimo', 'hoy' o 'desde' salvo que el hint lo diga.",
          "- Para nombres, apellidos, seudonimos o titulos breves, la pista debe decir explicitamente 'nombre', 'apellido', 'seudonimo' o equivalente.",
          "- Genera pistas para EXACTAMENTE estas respuestas ya colocadas en la grilla.",
          "- NO inventes respuestas nuevas ni hechos especificos dudosos.",
          "- NO uses comodines vacios como 'Palabra' o 'Sobre ...'.",
          "- Si la categoria tematica es clara y segura, usa una pista concreta de esa categoria.",
          "- Si no estas 100% seguro, usa una pista neutra pero descriptiva del dominio del tema.",
          "- Devuelve SOLO JSON valido con { clues: [{ answer, clue }] }.",
        ].join("\n")
      : [
          "CRITICAL RULES (MANDATORY):",
          "- The chosen THEME is mandatory and must shape every clue for items marked thematic:true.",
          "- If an item includes a hint field, that hint defines the correct thematic reading and you must NOT degrade it to a generic meaning.",
          "- If an item includes a note field, treat it as extra thematic context for choosing the right clue.",
          "- If an answer admits both a generic meaning and a theme-specific meaning, ALWAYS choose the theme-specific interpretation.",
          "- NEVER use clues like 'common crossword fill', 'common word', or equivalents.",
          "- Do not use unstable temporal claims like 'current', 'former', 'latest', 'today', or 'since' unless the hint explicitly says so.",
          "- For first names, surnames, stage names, or short titles, the clue must explicitly say 'first name', 'surname', 'stage name', or equivalent.",
          "- Generate clues for EXACTLY these answers already placed in the grid.",
          "- Do NOT invent new answers or doubtful specific facts.",
          "- Do NOT use empty placeholders like 'Word' or 'Related to ...'.",
          "- If the thematic category is clear and safe, use a concrete clue from that category.",
          `- Every thematic clue must include the literal theme name: ${theme}.`,
          "- A generic dictionary definition is invalid. Describe a concrete role the answer can play inside the theme.",
          `- Example: for PEN with theme ${theme}, write 'Tool used when drafting ${theme} lyrics', not 'Writing instrument'.`,
          `- Example: for STAGE with theme ${theme}, write 'Place where ${theme} performs', not 'Raised platform'.`,
          "- If no honest concrete thematic role exists, do not disguise the definition as a thematic clue.",
          "- Return ONLY valid JSON with { clues: [{ answer, clue }] }.",
        ].join("\n"));

  const completionClues = await client.chat.completions.create({
    model: ANSWERBANK_SEARCH_MODEL,
    temperature: 0,
    max_tokens: 1600,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No extra text." },
      { role: "user", content: cluebankRequest },
    ],
  });

  const rawCluesText = completionClues.choices?.[0]?.message?.content ?? "";
  const parsedClues = safeJson<RawClueBank>(rawCluesText);

  const looksFactualOrRisky = (clue: string) => {
    const c = clue.toLowerCase();
    return /\b(current|former|latest|today|since)\b/i.test(c);
  };

  if (parsedClues?.clues && Array.isArray(parsedClues.clues)) {
    for (const item of parsedClues.clues) {
      const a = normalizeAnswer(item.answer ?? "");
      const clue = sanitizeModelClueText((item.clue ?? "").toString().trim(), language);
      if (!a || !clue) continue;
      if (!ASCII_A_TO_Z.test(a)) continue;
      if (isBadClue(clue)) continue;
      if (clueMentionsAnswer(clue, a)) continue;
      if (clueMakesUnstableTemporalClaim(clue, language)) continue;
      if (clueMislabelsPartialPersonAnswer(a, clue, language)) continue;
      if (clueMislabelsKnownPartialTitle(theme, a, clue)) continue;
      if (looksFactualOrRisky(clue)) continue;
      if (clueLooksOffTheme(theme, clue)) continue;
      clueByAnswer.set(a, clue);
    }
  }

  const missingItems = items.filter((item) => {
    const a = normalizeAnswer(item.answer);
    return a && !clueByAnswer.has(a);
  });

  if (missingItems.length > 0) {
    const retryPrompt =
      `Return ONLY JSON with { "clues": [{ "answer": string, "clue": string }] }.\n\n` +
      `THEME: ${theme}\nLANGUAGE: ${language === "es" ? "Spanish" : "English"}\n` +
      `Generate concrete, theme-specific crossword clues for exactly these already-placed answers:\n` +
      `${JSON.stringify(missingItems)}\n\n` +
      (language === "es"
        ? [
            "Reglas obligatorias:",
            "- No uses pistas genericas, comodines ni frases como 'relacionado con el tema'.",
            "- No uses 'relleno de crucigrama', 'palabra comun' ni equivalentes.",
            "- No uses afirmaciones temporales inestables como 'actual', 'ex', 'ultimo', 'hoy' o 'desde'.",
            "- Para nombres, apellidos, seudonimos y titulos breves, di explicitamente si es nombre, apellido o seudonimo.",
            "- No menciones la respuesta literal en su propia pista.",
            "- Si no sabes el dato exacto, da una pista descriptiva del dominio tematico, no una definicion de diccionario.",
          ].join("\n")
        : [
            "Mandatory rules:",
            "- Do not use generic placeholders or phrases like 'related to the theme'.",
            "- Do not use 'common crossword fill', 'common word', or equivalents.",
            "- Do not use unstable temporal claims like 'current', 'former', 'latest', 'today', or 'since'.",
            "- For first names, surnames, stage names, and short titles, explicitly say first name, surname, or stage name.",
            "- Do not mention the answer itself in its clue.",
            "- If the exact fact is uncertain, give a domain-specific clue, not a dictionary definition.",
          ].join("\n"));

    try {
      const retry = await client.chat.completions.create({
        model: CLUE_MODEL,
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return ONLY valid JSON. No extra text." },
          { role: "user", content: retryPrompt },
        ],
      });
      const retryParsed = safeJson<RawClueBank>(retry.choices?.[0]?.message?.content ?? "");
      if (retryParsed?.clues && Array.isArray(retryParsed.clues)) {
        for (const item of retryParsed.clues) {
          const a = normalizeAnswer(item.answer ?? "");
          const clue = sanitizeModelClueText((item.clue ?? "").toString().trim(), language);
          if (!a || !clue || !ASCII_A_TO_Z.test(a)) continue;
          if (isBadClue(clue)) continue;
          if (clueMentionsAnswer(clue, a)) continue;
          if (clueMakesUnstableTemporalClaim(clue, language)) continue;
          if (clueMislabelsPartialPersonAnswer(a, clue, language)) continue;
          if (clueMislabelsKnownPartialTitle(theme, a, clue)) continue;
          if (looksFactualOrRisky(clue)) continue;
          if (clueLooksOffTheme(theme, clue)) continue;
          clueByAnswer.set(a, clue);
        }
      }
    } catch (error: unknown) {
      console.warn("[generate-crossword] clue retry failed", {
        name: error instanceof Error ? error.name : "unknown",
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return clueByAnswer;
}

async function tryOpeningDeterministic11(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  candidates: WordCandidate[];
  notesByAnswer: Map<string, string>;
  thematicSet: Set<string>;
  coreThematicSet: Set<string>;
  seed: number;
  targetEntries: number;
  deadlineMs: number;
  source: string;
  attempt: number;
  previousEntries?: number;
  fallbackScore?: number;
  extraMeta?: Record<string, unknown>;
}): Promise<Crossword | null> {
  const {
    client,
    theme,
    language,
    candidates,
    notesByAnswer,
    thematicSet,
    coreThematicSet,
    seed,
    targetEntries,
    deadlineMs,
    source,
    attempt,
    previousEntries,
    fallbackScore,
    extraMeta,
  } = opts;

  const opening = constructOpeningCrossword11({
    theme,
    candidates,
    seed,
    targetEntries,
    deadlineMs,
  });
  if (!opening) return null;

  const uniqueAnswers = Array.from(new Set(opening.derived.map((entry) => entry.answer)));
  const clueItems: ClueRequestItem[] = uniqueAnswers.map((answer) => {
    const note = notesByAnswer.get(answer);
    const thematic = thematicSet.has(answer);
    const hint = buildThematicClueRequestHint(theme, answer, language, note) ?? undefined;
    return {
      answer,
      thematic,
      note,
      hint: thematic ? hint : undefined,
    };
  });

  const clueByAnswer = new Map<string, string>();
  try {
    const modelClues = await requestModelClues({
      client,
      theme,
      language,
      items: clueItems,
    });
    for (const [answer, clue] of modelClues.entries()) {
      clueByAnswer.set(answer, clue);
    }
  } catch (e: unknown) {
    console.warn("[generate-crossword] opening clue request failed", {
      attempt,
      source,
      name: e instanceof Error ? e.name : "unknown",
      msg: e instanceof Error ? e.message : String(e),
    });
  }

  reinforceThematicClues(theme, language, uniqueAnswers, clueByAnswer, notesByAnswer, thematicSet);

  const openingEntries = pruneForbiddenPublishAnswersIfPossible(
    pruneMaskedDuplicateAnswers(
      repairPublishClues(applyCluesAndOverrides(theme, language, opening.derived, clueByAnswer), {
        theme,
        language,
        thematicSet,
        notesByAnswer,
      })
    ).filter((entry) =>
      isPublishableAnswerForTheme({
        theme,
        answer: entry.answer,
        language,
        size: 11,
        note: notesByAnswer.get(entry.answer),
        allowContextualGeneric: thematicSet.has(entry.answer),
      })
    ),
    targetEntries
  );

  const minLen = minEntryLenForSize(11);
  const openingQualityIssue = publishQualityIssue(openingEntries, thematicSet, language, targetEntries);
  const openingCrossed = crossedEntryStats(opening.grid, openingEntries, minLen);
  const openingEntryCrossings = entryCrossingStats(opening.grid, openingEntries, minLen);
  const openingChecked = checkedCellStats(opening.grid, minLen);
  const openingDensity = crosswordDensityFromGrid(opening.grid);
  const openingThemeEntries = openingEntries.filter((entry) => thematicSet.has(entry.answer)).length;
  const openingCoreThematicEntries = openingEntries.filter((entry) =>
    coreThematicSet.has(entry.answer)
  ).length;
  const openingGenericContextEntries = openingEntries.filter(
    (entry) => thematicSet.has(entry.answer) && !coreThematicSet.has(entry.answer)
  ).length;
  const openingMinThemeEntries = minThematicEntriesForPublish(11, openingEntries.length);
  const openingMinCoreEntries = minCoreThematicEntriesForPublish(11, openingEntries.length);
  const openingMaxGenericEntries = maxGenericContextEntriesForPublish(11, openingEntries.length);
  const openingPlaceholderCount = openingEntries.filter((entry) =>
    isPlaceholderClue(entry.clue, language)
  ).length;
  const hasShortRuns = hasShortLetterRuns(opening.grid, minLen);

  if (
    openingEntries.length < targetEntries ||
    openingCrossed.crossed < openingEntries.length ||
    openingEntryCrossings.weakEntries.length > 0 ||
    openingDensity < 0.4 ||
    openingChecked.ratio < 0.25 ||
    openingThemeEntries < openingMinThemeEntries ||
    openingCoreThematicEntries < openingMinCoreEntries ||
    openingGenericContextEntries > openingMaxGenericEntries ||
    openingPlaceholderCount > 0 ||
    hasShortRuns ||
    openingQualityIssue
  ) {
    console.warn("[generate-crossword] opening deterministic rejected", {
      source,
      attempt,
      entries: openingEntries.length,
      answers: openingEntries.map((entry) => entry.answer),
      qualityIssue: openingQualityIssue,
      crossed: openingCrossed.crossed,
      weakEntries: openingEntryCrossings.weakEntries,
      density: openingDensity,
      checkedRatio: openingChecked.ratio,
      thematicEntries: openingThemeEntries,
      minThematicEntries: openingMinThemeEntries,
      coreThematicEntries: openingCoreThematicEntries,
      minCoreThematicEntries: openingMinCoreEntries,
      genericContextEntries: openingGenericContextEntries,
      maxGenericContextEntries: openingMaxGenericEntries,
      placeholderCount: openingPlaceholderCount,
      hasShortRuns,
      ...opening.meta,
    });
    return null;
  }

  console.warn("[generate-crossword] FALLBACK -> opening deterministic 11x11", {
    source,
    attempt,
    previousEntries,
    entries: openingEntries.length,
    thematicEntries: openingThemeEntries,
    coreThematicEntries: openingCoreThematicEntries,
    genericContextEntries: openingGenericContextEntries,
    density: openingDensity,
    checkedRatio: openingChecked.ratio,
    ...opening.meta,
  });

  return {
    theme,
    language,
    size: 11,
    grid: opening.grid,
    entries: openingEntries,
    meta: {
      source,
      attempt,
      fallbackScore,
      previousEntries,
      crossedEntries: openingCrossed.crossed,
      checkedRatio: openingChecked.ratio,
      thematicEntries: openingThemeEntries,
      minThematicEntries: openingMinThemeEntries,
      coreThematicEntries: openingCoreThematicEntries,
      minCoreThematicEntries: openingMinCoreEntries,
      genericContextEntries: openingGenericContextEntries,
      density: openingDensity,
      maxGenericContextEntries: openingMaxGenericEntries,
      minCrossingsPerEntry: minCrossingsPerEntryForPublish(11),
      minEntryCheckedCells: openingEntryCrossings.minCheckedCells,
      ...opening.meta,
      ...extraMeta,
    },
  };
}

function getPreferredThematicClue(
  theme: string,
  answer: string,
  language: "es" | "en",
  note?: string | null,
  fallback?: string | null
): string | null {
  const hinted = buildThematicClueRequestHint(theme, answer, language, note);
  if (hinted && !isBadClue(hinted) && !clueMentionsAnswer(hinted, answer)) return hinted;

  if (fallback && !isBadClue(fallback) && !clueMentionsAnswer(fallback, answer) && !clueLooksOffTheme(theme, fallback)) return fallback;
  return null;
}

function reinforceThematicClues(
  theme: string,
  language: "es" | "en",
  answers: Iterable<string>,
  clueByAnswer: Map<string, string>,
  notesByAnswer: Map<string, string>,
  thematicSet: Set<string>
) {
  for (const answer of answers) {
    if (!thematicSet.has(answer)) continue;
    const preferred = getPreferredThematicClue(
      theme,
      answer,
      language,
      notesByAnswer.get(answer),
      clueByAnswer.get(answer)
    );
    if (preferred) clueByAnswer.set(answer, preferred);
  }
}

function applyCluesAndOverrides(
  theme: string,
  language: "es" | "en",
  derived: Omit<Entry, "clue">[],
  clueByAnswer: Map<string, string>
): Entry[] {
  const overrides = getThemeClueOverrides(theme);

  return derived.map((e) => {
    const ov = overrides[e.answer];
    const specific = specificThematicFallbackClue(theme, e.answer, language);
    let clue = ov ? (language === "es" ? ov.es : ov.en) : (specific ?? clueByAnswer.get(e.answer) ?? "");
    clue = sanitizeModelClueText(clue, language);

    if (!clue) clue = language === "es" ? "Definición breve." : "Brief definition.";

    if (isBadClue(clue) || clueMentionsAnswer(clue, e.answer)) {
      const ov2 = overrides[e.answer];
      clue = ov2 ? (language === "es" ? ov2.es : ov2.en) : (specific ?? clue);
      clue = sanitizeModelClueText(clue, language);
      if (isBadClue(clue) || clueMentionsAnswer(clue, e.answer)) {
        clue = language === "es" ? "Definición breve." : "Brief definition.";
      }
    }

    if (isPlaceholderClue(clue, language)) {
      if (specific) clue = specific;
    }

    return { ...e, clue };
  });
}

async function buildThemeFirstRescueCrossword(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
  pool: WordCandidate[];
  notesByAnswer: Map<string, string>;
  trustedThematicSet: Set<string>;
  seedBase: number;
}): Promise<Crossword | null> {
  const { client, theme, language, size, pool, notesByAnswer, trustedThematicSet, seedBase } = opts;
  if (size !== 11) return null;

  const minLen = minEntryLenForSize(size);
  const minEntries = minPublishEntriesForSize(size);
  const rescueByAnswer = new Map<string, WordCandidate>();

  for (const candidate of pool) {
    if (!trustedThematicSet.has(candidate.answer)) continue;
    if (candidate.source === "filler") continue;
    if (candidate.answer.length < minLen || candidate.answer.length > size) continue;
    if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
    rescueByAnswer.set(candidate.answer, {
      ...candidate,
      thematic: true,
      source: candidate.source === "support" ? "model" : candidate.source,
    });
  }

  if (rescueByAnswer.size < minEntries) {
    for (const candidate of pool) {
      if (rescueByAnswer.size >= minEntries + 12) break;
      if (candidate.source === "filler") continue;
      if (candidate.answer.length < minLen || candidate.answer.length > size) continue;
      if (rescueByAnswer.has(candidate.answer)) continue;
      if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
      if (
        !hasStrongThematicClueSupport({
          theme,
          answer: candidate.answer,
          language,
          note: notesByAnswer.get(candidate.answer),
        })
      ) {
        continue;
      }
      rescueByAnswer.set(candidate.answer, { ...candidate, thematic: true });
    }
  }

  if (rescueByAnswer.size < minEntries + 8) {
    for (const candidate of pool) {
      if (rescueByAnswer.size >= minEntries + 16) break;
      if (candidate.source === "filler") continue;
      if (candidate.answer.length < minLen || candidate.answer.length > size) continue;
      if (rescueByAnswer.has(candidate.answer)) continue;
      if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
      rescueByAnswer.set(candidate.answer, { ...candidate, thematic: true });
    }
  }

  const rescuePool = Array.from(rescueByAnswer.values()).sort((a, b) => {
    if (a.answer.length !== b.answer.length) return b.answer.length - a.answer.length;
    return a.answer.localeCompare(b.answer);
  });

  if (rescuePool.length < minEntries) return null;

  let best:
    | {
        grid: string[][];
        derived: DerivedEntry[];
        score: number;
        thematicEntries: number;
        crossedEntries: number;
        minEntryCheckedCells: number;
        weakEntryCount: number;
        checkedRatio: number;
      }
    | null = null;

  const rescueDeadlineMs = Date.now() + 9000;
  const allowedAnswers = new Set(rescuePool.map((c) => c.answer));

  for (let variant = 0; variant < 12 && Date.now() < rescueDeadlineMs - 500; variant++) {
    const variantSeed = (seedBase ^ (variant * 0x9e3779b9)) >>> 0;
    const built =
      constructCompactPatternCrossword11({
        theme,
        size,
        seed: variantSeed,
        candidates: rescuePool,
        deadlineMs: rescueDeadlineMs,
      }) ??
      constructPatternCrossword11({
        theme,
        size,
        seed: variantSeed,
        candidates: rescuePool,
        deadlineMs: rescueDeadlineMs,
      }) ??
      (variant === 0
        ? constructBeamCrossword11({
            theme,
            size,
            seed: variantSeed,
            candidates: rescuePool,
            deadlineMs: rescueDeadlineMs,
          })
        : null);
    if (!built) continue;

    const cleaned = rebuildGridFromAllowedEntries(built.grid, allowedAnswers, minLen);
    const grid = cleaned?.grid ?? built.grid;
    const derived = cleaned?.derived ?? deriveEntriesFromGrid(grid, minLen);
    if (derived.some((entry) => !allowedAnswers.has(entry.answer))) continue;

    const checked = checkedCellStats(grid, minLen);
    const crossed = crossedEntryStats(grid, derived, minLen);
    const entryCrossings = entryCrossingStats(grid, derived, minLen);
    const thematicEntries = derived.filter((entry) => allowedAnswers.has(entry.answer)).length;
    const score =
      thematicEntries * 12000 +
      crossed.crossed * 5000 +
      derived.length * 3000 +
      checked.ratio * 2000 +
      crosswordDensityFromGrid(grid) * 1000 -
      entryCrossings.weakEntries.length * 90000;

    if (!best || score > best.score) {
      best = {
        grid,
        derived,
        score,
        thematicEntries,
        crossedEntries: crossed.crossed,
        minEntryCheckedCells: entryCrossings.minCheckedCells,
        weakEntryCount: entryCrossings.weakEntries.length,
        checkedRatio: checked.ratio,
      };
    }
  }

  if (
    !best ||
    best.derived.length < minEntries ||
    best.crossedEntries < minEntries ||
    best.weakEntryCount > 0 ||
    best.thematicEntries < 10 ||
    best.checkedRatio < 0.25
  ) {
    return null;
  }

  const uniqueAnswers = Array.from(new Set(best.derived.map((entry) => entry.answer)));
  const rescueThematicSet = new Set(uniqueAnswers.filter((answer) => allowedAnswers.has(answer)));
  const clueItems: ClueRequestItem[] = uniqueAnswers.map((answer) => {
    const note = notesByAnswer.get(answer);
    return {
      answer,
      thematic: rescueThematicSet.has(answer),
      note,
      hint: rescueThematicSet.has(answer)
        ? buildThematicClueRequestHint(theme, answer, language, note) ?? undefined
        : undefined,
    };
  });

  const clueByAnswer = new Map<string, string>();
  try {
    const modelClues = await requestModelClues({
      client,
      theme,
      language,
      items: clueItems,
    });
    for (const [answer, clue] of modelClues.entries()) clueByAnswer.set(answer, clue);
  } catch (error: unknown) {
    console.warn("[generate-crossword] theme-first rescue clues failed", {
      name: error instanceof Error ? error.name : "unknown",
      msg: error instanceof Error ? error.message : String(error),
    });
  }

  for (const answer of uniqueAnswers) {
    if (clueByAnswer.has(answer)) continue;
    const note = notesByAnswer.get(answer);
    const fromNote = note ? clueFromThemeNote(theme, note, language) : null;
    const specific = specificThematicFallbackClue(theme, answer, language);
    clueByAnswer.set(
      answer,
      fromNote ??
        specific ??
        (language === "es"
          ? `Referencia concreta asociada con ${theme}`
          : `Concrete reference associated with ${theme}`)
    );
  }

  reinforceThematicClues(theme, language, uniqueAnswers, clueByAnswer, notesByAnswer, rescueThematicSet);

  const entries = applyCluesAndOverrides(theme, language, best.derived, clueByAnswer);
  const placeholderCount = entries.filter((entry) => isPlaceholderClue(entry.clue, language)).length;
  const blandText = language === "es" ? "DefiniciÃ³n breve." : "Brief definition.";
  const bland = entries.filter((entry) => entry.clue === blandText).length;

  if (placeholderCount > 0 || bland > 0 || entries.length < minEntries) return null;

  return {
    theme,
    language,
    size,
    grid: best.grid,
    entries,
    meta: {
      source: "theme-first-rescue-11",
      poolCount: pool.length,
      rescuePoolCount: rescuePool.length,
      thematicEntries: best.thematicEntries,
      crossedEntries: best.crossedEntries,
      minCrossingsPerEntry: minCrossingsPerEntryForPublish(size),
      minEntryCheckedCells: best.minEntryCheckedCells,
      checkedRatio: best.checkedRatio,
      clueCount: clueByAnswer.size,
    },
  };
}

function rebuildPlayableCrossword(
  theme: string,
  size: number,
  entries: Entry[],
  language: "es" | "en",
  allowedAnswers: Set<string>
): { grid: string[][]; entries: Entry[] } | null {
  const playableEntries = entries.filter((e) => {
    if (!allowedAnswers.has(e.answer)) return false;
    if (isOverGenericThemeWordForTheme(theme, e.answer)) return false;
    if (isPlaceholderClue(e.clue, language)) return false;
    return true;
  });

  if (playableEntries.length === 0) return null;

  const minLen = minEntryLenForSize(size);
  const tryExactRebuild = (selected: Entry[]): { grid: string[][]; entries: Entry[] } | null => {
    const rebuilt = rebuildGridFromEntries(
      size,
      selected.map((entry) => ({
        number: entry.number,
        row: entry.row,
        col: entry.col,
        direction: entry.direction,
        answer: entry.answer,
      })),
      minLen
    );

    if (!rebuilt?.derived || rebuilt.derived.length === 0) return null;

    const rebuiltKeyMap = new Map(
      selected.map((entry) => [
        `${entry.direction}:${entry.row}:${entry.col}:${entry.answer}`,
        entry,
      ])
    );

    const finalEntries: Entry[] = [];
    for (const derived of rebuilt.derived) {
      const key = `${derived.direction}:${derived.row}:${derived.col}:${derived.answer}`;
      const original = rebuiltKeyMap.get(key);
      if (!original) return null;
      finalEntries.push(original);
    }

    return { grid: rebuilt.grid, entries: finalEntries };
  };

  const scoreEntry = (entry: Entry) => {
    let score = 0;
    if (!isPlaceholderClue(entry.clue, language)) score += 100;
    if (specificThematicFallbackClue(theme, entry.answer, language)) score += 40;
    score += Math.min(entry.answer.length, 12);
    return score;
  };

  const sortedPlayable = [...playableEntries].sort((a, b) => scoreEntry(b) - scoreEntry(a));
  const direct = tryExactRebuild(sortedPlayable);
  if (direct) return direct;

  let working = [...sortedPlayable];
  while (working.length >= 4) {
    let improved = false;
    for (let i = working.length - 1; i >= 0; i -= 1) {
      const candidate = working.filter((_, idx) => idx !== i);
      if (candidate.length < 4) continue;
      const rebuilt = tryExactRebuild(candidate);
      if (rebuilt) return rebuilt;
    }

    working = working.slice(0, -1);
    const rebuilt = working.length >= 4 ? tryExactRebuild(working) : null;
    if (rebuilt) return rebuilt;
    improved = true;
    if (!improved) break;
  }

  return null;
}

function rebuildExactPublishableCrossword(
  theme: string,
  size: number,
  entries: Entry[],
  language: "es" | "en",
  allowedAnswers: Set<string>,
  minEntries = 3
): { grid: string[][]; entries: Entry[] } | null {
  const selected = entries.filter((e) => {
    if (!allowedAnswers.has(e.answer)) return false;
    if (isOverGenericThemeWordForTheme(theme, e.answer)) return false;
    if (isPlaceholderClue(e.clue, language)) return false;
    return true;
  });

  if (selected.length < minEntries) return null;

  const scoreEntry = (entry: Entry) => {
    let score = 0;
    if (!isPlaceholderClue(entry.clue, language)) score += 100;
    if (specificThematicFallbackClue(theme, entry.answer, language)) score += 40;
    score += Math.min(entry.answer.length, 12);
    return score;
  };

  const sorted = [...selected].sort((a, b) => scoreEntry(b) - scoreEntry(a));
  const tryExact = (candidate: Entry[]): { grid: string[][]; entries: Entry[] } | null => {
    const rebuilt = rebuildGridFromEntries(
      size,
      candidate.map((entry) => ({
        number: entry.number,
        row: entry.row,
        col: entry.col,
        direction: entry.direction,
        answer: entry.answer,
      })),
      minEntryLenForSize(size)
    );
    if (!rebuilt?.derived || rebuilt.derived.length < minEntries) return null;

    const originalMap = new Map(
      candidate.map((entry) => [
        `${entry.direction}:${entry.row}:${entry.col}:${entry.answer}`,
        entry,
      ])
    );

    const finalEntries: Entry[] = [];
    for (const derived of rebuilt.derived) {
      const key = `${derived.direction}:${derived.row}:${derived.col}:${derived.answer}`;
      const original = originalMap.get(key);
      if (!original) return null;
      finalEntries.push(original);
    }

    return { grid: rebuilt.grid, entries: finalEntries };
  };

  const direct = tryExact(sorted);
  if (direct) return direct;

  let working = [...sorted];
  while (working.length >= minEntries) {
    for (let i = working.length - 1; i >= 0; i -= 1) {
      const candidate = working.filter((_, idx) => idx !== i);
      if (candidate.length < minEntries) continue;
      const rebuilt = tryExact(candidate);
      if (rebuilt) return rebuilt;
    }
    working = working.slice(0, -1);
    if (working.length >= minEntries) {
      const rebuilt = tryExact(working);
      if (rebuilt) return rebuilt;
    }
  }

  return null;
}

function rebuildExactFullyCheckedPublishableCrossword(
  theme: string,
  size: number,
  entries: Entry[],
  language: "es" | "en",
  allowedAnswers: Set<string>,
  minEntries = 3
): { grid: string[][]; entries: Entry[] } | null {
  const selected = entries.filter((e) => {
    if (!allowedAnswers.has(e.answer)) return false;
    if (isOverGenericThemeWordForTheme(theme, e.answer)) return false;
    if (isPlaceholderClue(e.clue, language)) return false;
    return true;
  });

  if (selected.length < minEntries) return null;

  const scoreEntry = (entry: Entry) => {
    let score = 0;
    if (!isPlaceholderClue(entry.clue, language)) score += 100;
    if (specificThematicFallbackClue(theme, entry.answer, language)) score += 40;
    score += Math.min(entry.answer.length, 12);
    return score;
  };

  const minLen = minEntryLenForSize(size);
  const sorted = [...selected].sort((a, b) => scoreEntry(b) - scoreEntry(a));

  const tryExactChecked = (candidate: Entry[]): { grid: string[][]; entries: Entry[] } | null => {
    const rebuilt = rebuildGridFromEntries(
      size,
      candidate.map((entry) => ({
        number: entry.number,
        row: entry.row,
        col: entry.col,
        direction: entry.direction,
        answer: entry.answer,
      })),
      minLen
    );
    if (!rebuilt?.derived || rebuilt.derived.length < minEntries) return null;

    const checked = checkedCellStats(rebuilt.grid, minLen);
    if (checked.total === 0 || checked.checked !== checked.total) return null;

    const originalMap = new Map(
      candidate.map((entry) => [
        `${entry.direction}:${entry.row}:${entry.col}:${entry.answer}`,
        entry,
      ])
    );

    const finalEntries: Entry[] = [];
    for (const derived of rebuilt.derived) {
      const key = `${derived.direction}:${derived.row}:${derived.col}:${derived.answer}`;
      const original = originalMap.get(key);
      if (!original) return null;
      finalEntries.push(original);
    }

    return { grid: rebuilt.grid, entries: finalEntries };
  };

  const direct = tryExactChecked(sorted);
  if (direct) return direct;

  let working = [...sorted];
  while (working.length >= minEntries) {
    for (let i = working.length - 1; i >= 0; i -= 1) {
      const candidate = working.filter((_, idx) => idx !== i);
      if (candidate.length < minEntries) continue;
      const rebuilt = tryExactChecked(candidate);
      if (rebuilt) return rebuilt;
    }
    working = working.slice(0, -1);
    if (working.length >= minEntries) {
      const rebuilt = tryExactChecked(working);
      if (rebuilt) return rebuilt;
    }
  }

  return null;
}

function rebuildFullyCheckedPublishableCrossword(
  theme: string,
  size: number,
  grid: string[][],
  language: "es" | "en",
  allowedAnswers: Set<string>,
  clueByAnswer: Map<string, string>,
  minEntries = 4
): { grid: string[][]; entries: Entry[] } | null {
  const minLen = minEntryLenForSize(size);
  const rebuilt = rebuildGridFromAllowedEntries(grid, allowedAnswers, minLen);
  if (!rebuilt?.derived || rebuilt.derived.length < minEntries) return null;

  const checked = checkedCellStats(rebuilt.grid, minLen);
  if (checked.total === 0 || checked.checked !== checked.total) return null;

  const entries = applyCluesAndOverrides(theme, language, rebuilt.derived, clueByAnswer);
  if (entries.some((e) => isPlaceholderClue(e.clue, language))) return null;

  return { grid: rebuilt.grid, entries };
}

function rebuildSanitizedFullyCheckedPublishableCrossword(
  theme: string,
  size: number,
  grid: string[][],
  language: "es" | "en",
  allowedAnswers: Set<string>,
  clueByAnswer: Map<string, string>,
  minEntries: number
): { grid: string[][]; entries: Entry[] } | null {
  const minLen = minEntryLenForSize(size);
  const sanitized = sanitizeUncheckedGrid(grid, minLen);
  const sanitizedDerived = deriveEntriesFromGrid(sanitized, minLen);
  if (sanitizedDerived.length < minEntries) return null;

  return rebuildFullyCheckedPublishableCrossword(
    theme,
    size,
    sanitized,
    language,
    allowedAnswers,
    clueByAnswer,
    minEntries
  );
}

function rebuildNoShortRunPublishableCrossword(
  theme: string,
  size: number,
  entries: Entry[],
  language: "es" | "en",
  thematicSet: Set<string>,
  minEntries: number,
  minThematicEntries: number
): { grid: string[][]; entries: Entry[] } | null {
  const minLen = minEntryLenForSize(size);
  const usable = entries.filter((entry) => {
    if (isPlaceholderClue(entry.clue, language)) return false;
    if (isLikelyBadAnswer(entry.answer) && !ALWAYS_ALLOW_ANSWERS.has(entry.answer)) return false;
    return true;
  });

  if (usable.length < minEntries) return null;

  const scoreEntry = (entry: Entry) => {
    let score = 0;
    if (thematicSet.has(entry.answer)) score += 1000;
    if (specificThematicFallbackClue(theme, entry.answer, language)) score += 250;
    if (!isOverGenericThemeWordForTheme(theme, entry.answer)) score += 120;
    score += Math.min(entry.answer.length, 12);
    return score;
  };

  const sorted = [...usable].sort((a, b) => scoreEntry(b) - scoreEntry(a));
  const seen = new Set<string>();
  const maxStates = 12000;
  let states = 0;

  const tryCandidate = (candidate: Entry[]): { grid: string[][]; entries: Entry[] } | null => {
    const rebuilt = rebuildGridFromEntries(
      size,
      candidate.map((entry) => ({
        number: entry.number,
        row: entry.row,
        col: entry.col,
        direction: entry.direction,
        answer: entry.answer,
      })),
      minLen
    );
    if (!rebuilt) return null;
    if (rebuilt.derived.length < minEntries) return null;
    if (hasShortLetterRuns(rebuilt.grid, minLen)) return null;

    const originalByKey = new Map(
      candidate.map((entry) => [
        `${entry.direction}:${entry.row}:${entry.col}:${entry.answer}`,
        entry,
      ])
    );

    const rebuiltEntries: Entry[] = [];
    for (const derived of rebuilt.derived) {
      const key = `${derived.direction}:${derived.row}:${derived.col}:${derived.answer}`;
      const original = originalByKey.get(key);
      if (!original) return null;
      rebuiltEntries.push(original);
    }

    const checked = checkedCellStats(rebuilt.grid, minLen);
    const crossed = crossedEntryStats(rebuilt.grid, rebuiltEntries, minLen);
    const thematicCount = rebuiltEntries.filter((entry) => thematicSet.has(entry.answer)).length;
    if (crossed.crossed < minEntries) return null;
    if (checked.ratio < 0.25) return null;
    if (thematicCount < minThematicEntries) return null;

    return { grid: rebuilt.grid, entries: rebuiltEntries };
  };

  const search = (candidate: Entry[], startDropIndex: number): { grid: string[][]; entries: Entry[] } | null => {
    states++;
    if (states > maxStates) return null;
    if (candidate.length < minEntries) return null;

    const key = candidate
      .map((entry) => `${entry.direction}:${entry.row}:${entry.col}:${entry.answer}`)
      .join("|");
    if (seen.has(key)) return null;
    seen.add(key);

    const direct = tryCandidate(candidate);
    if (direct) return direct;

    const rebuiltForDrops = rebuildGridFromEntries(
      size,
      candidate.map((entry) => ({
        number: entry.number,
        row: entry.row,
        col: entry.col,
        direction: entry.direction,
        answer: entry.answer,
      })),
      minLen
    );
    const shortCells = rebuiltForDrops ? shortRunCellKeys(rebuiltForDrops.grid, minLen) : new Set<string>();
    const entryTouchesShortRun = (entry: Entry) => {
      for (let i = 0; i < entry.answer.length; i++) {
        const r = entry.direction === "down" ? entry.row + i : entry.row;
        const c = entry.direction === "across" ? entry.col + i : entry.col;
        if (shortCells.has(`${r},${c}`)) return true;
      }
      return false;
    };
    const dropOrder = candidate
      .map((entry, idx) => ({ entry, idx }))
      .sort((a, b) => {
        const aTouches = entryTouchesShortRun(a.entry) ? 1 : 0;
        const bTouches = entryTouchesShortRun(b.entry) ? 1 : 0;
        if (aTouches !== bTouches) return bTouches - aTouches;
        return scoreEntry(a.entry) - scoreEntry(b.entry);
      })
      .map((item) => item.idx);

    const minDropIndex = Math.max(0, startDropIndex);
    for (const i of dropOrder) {
      if (i < minDropIndex) continue;
      const next = candidate.filter((_, idx) => idx !== i);
      const result = search(next, 0);
      if (result) return result;
    }

    return null;
  };

  return search(sorted, 0);
}

function augmentNoShortGridWithCandidates(
  grid: string[][],
  candidates: WordCandidate[],
  minLen: number,
  targetEntries: number,
  minimumReturnEntries = targetEntries
): { grid: string[][]; derived: DerivedEntry[] } | null {
  const size = grid.length;
  const candidateAnswers = Array.from(
    new Set(
      candidates
        .map((candidate) => candidate.answer)
        .filter(
          (answer) =>
            answer.length >= minLen &&
            answer.length <= size &&
            ASCII_A_TO_Z.test(answer) &&
            !isForbiddenPublishAnswer(answer)
        )
    )
  );
  if (candidateAnswers.length === 0) return null;
  const candidateByAnswer = new Map(candidates.map((candidate) => [candidate.answer, candidate]));

  const allowedAnswers = new Set([
    ...deriveEntriesFromGrid(grid, minLen).map((entry) => entry.answer),
    ...candidateAnswers,
  ]);

  let working = grid.map((row) => row.map((cell) => (cell === "#" ? "" : cell))) as Cell[][];
  let bestFinal: { grid: string[][]; derived: DerivedEntry[] } | null = null;

  for (let step = 0; step < 12; step++) {
    const currentFinal = gridToStrings(paintBlocks(working) as (string | null)[][]);
    const currentDerived = deriveEntriesFromGrid(currentFinal, minLen);
    const currentWeakCount = entryCrossingStats(currentFinal, currentDerived, minLen).weakEntries.length;
    if (
      !hasShortLetterRuns(currentFinal, minLen) &&
      currentDerived.length >= minimumReturnEntries &&
      !currentDerived.some((entry) => isForbiddenPublishAnswer(entry.answer)) &&
      currentWeakCount === 0
    ) {
      bestFinal = { grid: currentFinal, derived: currentDerived };
      if (currentDerived.length >= targetEntries) break;
    }

    const used = new Set(currentDerived.map((entry) => entry.answer));
    let best:
      | {
          scratch: Cell[][];
          final: string[][];
          derived: DerivedEntry[];
          score: number;
        }
      | null = null;

    for (const answer of candidateAnswers) {
      if (used.has(answer)) continue;
      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
          for (const dir of ["across", "down"] as const) {
            const scratch = working.map((r) => r.slice()) as Cell[][];
            const placed = placeWord(scratch, answer, row, col, dir);
            if (!placed) continue;

            const final = gridToStrings(paintBlocks(scratch) as (string | null)[][]);
            if (hasShortLetterRuns(final, minLen)) continue;

            const derived = deriveEntriesFromGrid(final, minLen);
            if (derived.length <= currentDerived.length) continue;
            if (derived.some((entry) => !allowedAnswers.has(entry.answer))) continue;
            if (derived.some((entry) => isForbiddenPublishAnswer(entry.answer))) continue;
            if (!derived.some((entry) => entry.answer === answer)) continue;
            const nextWeakCount = entryCrossingStats(final, derived, minLen).weakEntries.length;
            if (derived.length >= targetEntries && nextWeakCount > 0) continue;
            if (derived.length < targetEntries && nextWeakCount > currentWeakCount) continue;

            const crossed = crossedEntryStats(final, derived, minLen);
            const checked = checkedCellStats(final, minLen);
            const candidate = candidateByAnswer.get(answer);
            const score =
              derived.length * 10000 +
              crossed.crossed * 1200 +
              Math.max(0, currentWeakCount - nextWeakCount) * 7000 -
              nextWeakCount * 2500 +
              checked.ratio * 800 +
              answer.length * 25 +
              (candidate?.thematic ? 12000 : 0) +
              (candidate?.source === "model" || candidate?.source === "anchor" ? 3000 : 0) -
              (candidate?.source === "support" ? 4500 : 0) -
              derived.filter((entry) => isForbiddenPublishAnswer(entry.answer)).length * 100000;

            if (!best || score > best.score) {
              best = { scratch, final, derived, score };
            }
          }
        }
      }
    }

    if (!best) break;
    working = best.scratch;
    if (best.derived.length >= (bestFinal?.derived.length ?? 0)) {
      bestFinal = { grid: best.final, derived: best.derived };
    }
  }

  if (!bestFinal) return null;
  if (bestFinal.derived.length < minimumReturnEntries) return null;
  if (hasShortLetterRuns(bestFinal.grid, minLen)) return null;
  if (entryCrossingStats(bestFinal.grid, bestFinal.derived, minLen).weakEntries.length > 0) return null;
  return bestFinal;
}

function extendGridWithCrossedPair11(opts: {
  grid: string[][];
  candidates: WordCandidate[];
  targetEntries: number;
  seed: number;
}): { grid: string[][]; derived: DerivedEntry[]; addedAnswers: string[] } | null {
  const size = 11;
  const minLen = minEntryLenForSize(size);
  const currentDerived = deriveEntriesFromGrid(opts.grid, minLen);
  if (currentDerived.length >= opts.targetEntries) return null;
  const currentWeakCount = entryCrossingStats(opts.grid, currentDerived, minLen).weakEntries.length;

  const currentAnswers = new Set(currentDerived.map((entry) => entry.answer));
  const candidateByAnswer = new Map<string, WordCandidate>();
  for (const candidate of opts.candidates) {
    const answer = candidate.answer;
    if (answer.length < minLen || answer.length > size) continue;
    if (!ASCII_A_TO_Z.test(answer)) continue;
    if (currentAnswers.has(answer)) continue;
    if (isForbiddenPublishAnswer(answer)) continue;
    const prev = candidateByAnswer.get(answer);
    if (
      !prev ||
      (candidate.thematic && !prev.thematic) ||
      (candidate.source === "model" && prev.source !== "model")
    ) {
      candidateByAnswer.set(answer, candidate);
    }
  }

  const allowedAnswers = new Set([...currentAnswers, ...candidateByAnswer.keys()]);
  const rng = makeSeededRng(opts.seed);
  const remaining = Array.from(candidateByAnswer.keys()).sort((a, b) => {
    const ca = candidateByAnswer.get(a);
    const cb = candidateByAnswer.get(b);
    const aTheme = ca?.thematic ? 1 : 0;
    const bTheme = cb?.thematic ? 1 : 0;
    if (aTheme !== bTheme) return bTheme - aTheme;
    const aSource =
      ca?.source === "model" || ca?.source === "anchor" ? 2 : ca?.source === "support" ? 1 : 0;
    const bSource =
      cb?.source === "model" || cb?.source === "anchor" ? 2 : cb?.source === "support" ? 1 : 0;
    if (aSource !== bSource) return bSource - aSource;
    return Math.abs(6 - a.length) - Math.abs(6 - b.length) || a.localeCompare(b);
  });
  shuffleInPlace(remaining, rng);

  let best:
    | {
        grid: string[][];
        derived: DerivedEntry[];
        addedAnswers: string[];
        score: number;
      }
    | null = null;

  const maxWords = Math.min(remaining.length, 48);
  for (let aiw = 0; aiw < maxWords; aiw++) {
    const acrossWord = remaining[aiw];
    for (let diw = 0; diw < maxWords; diw++) {
      const downWord = remaining[diw];
      if (acrossWord === downWord) continue;
      for (let ai = 0; ai < acrossWord.length; ai++) {
        for (let di = 0; di < downWord.length; di++) {
          if (acrossWord[ai] !== downWord[di]) continue;
          for (let crossR = 0; crossR < size; crossR++) {
            for (let crossC = 0; crossC < size; crossC++) {
              const acrossRow = crossR;
              const acrossCol = crossC - ai;
              const downRow = crossR - di;
              const downCol = crossC;
              if (acrossCol < 0 || downRow < 0) continue;
              if (acrossCol + acrossWord.length > size || downRow + downWord.length > size) continue;

              const next = opts.grid.map((row) => row.slice());
              let ok = true;
              let newCells = 0;
              let existingTouches = 0;

              for (let i = 0; i < acrossWord.length && ok; i++) {
                const r = acrossRow;
                const c = acrossCol + i;
                const cur = next[r][c];
                const ch = acrossWord[i];
                if (cur !== "#" && cur !== ch) {
                  ok = false;
                  break;
                }
                if (cur === "#") newCells++;
                else existingTouches++;
                next[r][c] = ch;
              }

              for (let i = 0; i < downWord.length && ok; i++) {
                const r = downRow + i;
                const c = downCol;
                const cur = next[r][c];
                const ch = downWord[i];
                if (cur !== "#" && cur !== ch) {
                  ok = false;
                  break;
                }
                if (cur === "#") newCells++;
                else existingTouches++;
                next[r][c] = ch;
              }

              if (!ok || newCells < 2) continue;

              const normalizedNext = hasShortLetterRuns(next, minLen)
                ? blockShortRunsOnly(next, minLen)
                : next;
              const nextDerived = deriveEntriesFromGrid(normalizedNext, minLen);
              if (nextDerived.length <= currentDerived.length) continue;
              if (!nextDerived.some((entry) => entry.answer === acrossWord)) continue;
              if (!nextDerived.some((entry) => entry.answer === downWord)) continue;
              if (nextDerived.some((entry) => !allowedAnswers.has(entry.answer))) continue;
              if (nextDerived.some((entry) => isForbiddenPublishAnswer(entry.answer))) continue;

              const entryCrossings = entryCrossingStats(normalizedNext, nextDerived, minLen);
              const weakCount = entryCrossings.weakEntries.length;
              if (nextDerived.length >= opts.targetEntries && weakCount > 0) continue;
              if (nextDerived.length < opts.targetEntries && weakCount > currentWeakCount) continue;

              const crossed = crossedEntryStats(normalizedNext, nextDerived, minLen);
              const checked = checkedCellStats(normalizedNext, minLen);
              const themeScore =
                (candidateByAnswer.get(acrossWord)?.thematic ? 1 : 0) +
                (candidateByAnswer.get(downWord)?.thematic ? 1 : 0);
              const weakImprovement = Math.max(0, currentWeakCount - weakCount);
              const score =
                nextDerived.length * 30000 +
                crossed.crossed * 3000 +
                themeScore * 12000 +
                weakImprovement * 18000 -
                weakCount * 12000 +
                checked.ratio * 4000 +
                existingTouches * 500 -
                (Math.abs(crossR - 5) + Math.abs(crossC - 5)) * 50;

              if (!best || score > best.score) {
                best = {
                  grid: normalizedNext,
                  derived: nextDerived,
                  addedAnswers: [acrossWord, downWord],
                  score,
                };
              }
            }
          }
        }
      }
    }
  }

  if (!best) return null;
  const bestWeakCount = entryCrossingStats(best.grid, best.derived, minLen).weakEntries.length;
  if (best.derived.length <= currentDerived.length) return null;
  if (best.derived.length < opts.targetEntries && bestWeakCount > currentWeakCount) return null;
  return best;
}

function constructOpeningCrossword11(opts: {
  theme: string;
  candidates: WordCandidate[];
  seed: number;
  targetEntries: number;
  deadlineMs?: number;
}): { grid: string[][]; derived: DerivedEntry[]; usedAnswers: string[]; meta: Record<string, unknown> } | null {
  const size = 11;
  const minLen = minEntryLenForSize(size);
  const localDeadlineMs =
    opts.deadlineMs && opts.deadlineMs > Date.now() + 500 ? opts.deadlineMs : Date.now() + 18_000;
  const nowOk = () => Date.now() <= localDeadlineMs;
  const rng = makeSeededRng(opts.seed);

  const candidateByAnswer = new Map<string, WordCandidate>();
  for (const candidate of opts.candidates) {
    const answer = candidate.answer;
    if (candidate.source === "filler") continue;
    if (answer.length < minLen || answer.length > size) continue;
    if (!ASCII_A_TO_Z.test(answer)) continue;
    if (isForbiddenPublishAnswer(answer)) continue;
    if (isOverGenericThemeWordForTheme(opts.theme, answer) && !candidate.thematic) continue;
    const prev = candidateByAnswer.get(answer);
    if (!prev || (candidate.thematic && !prev.thematic)) candidateByAnswer.set(answer, candidate);
  }

  const answers = Array.from(candidateByAnswer.keys());
  if (answers.length < opts.targetEntries) return null;

  const thematicAnswers = new Set(
    Array.from(candidateByAnswer.values())
      .filter((candidate) => candidate.thematic && candidate.source !== "support")
      .map((candidate) => candidate.answer)
  );

  const orderedSeeds = answers
    .slice()
    .sort((a, b) => {
      const aTheme = thematicAnswers.has(a) ? 1 : 0;
      const bTheme = thematicAnswers.has(b) ? 1 : 0;
      if (aTheme !== bTheme) return bTheme - aTheme;
      const aFit = a.length >= 5 && a.length <= 8 ? 1 : 0;
      const bFit = b.length >= 5 && b.length <= 8 ? 1 : 0;
      if (aFit !== bFit) return bFit - aFit;
      return Math.abs(7 - a.length) - Math.abs(7 - b.length);
    })
    .slice(0, Math.min(28, answers.length));
  shuffleInPlace(orderedSeeds, rng);

  const writeWord = (grid: string[][], word: string, row: number, col: number, dir: Direction) => {
    let crossings = 0;
    let newCells = 0;
    for (let i = 0; i < word.length; i++) {
      const r = dir === "down" ? row + i : row;
      const c = dir === "across" ? col + i : col;
      if (!inBounds(size, r, c)) return null;
      const cur = grid[r][c];
      const ch = word[i];
      if (cur !== "#" && cur !== ch) return null;
      if (cur === ch) crossings++;
      if (cur === "#") newCells++;
    }
    if (crossings < 1 || newCells < 1) return null;

    const next = grid.map((r) => r.slice());
    for (let i = 0; i < word.length; i++) {
      const r = dir === "down" ? row + i : row;
      const c = dir === "across" ? col + i : col;
      next[r][c] = word[i];
    }
    return { grid: next, crossings, newCells };
  };

  const allowedAnswers = new Set(answers);

  const tryBuild = (seedWord: string, seedDir: Direction, seedOffset: number) => {
    let grid = Array.from({ length: size }, () => Array.from({ length: size }, () => "#"));
    const seedRow = seedDir === "across" ? Math.floor(size / 2) + seedOffset : Math.floor((size - seedWord.length) / 2);
    const seedCol = seedDir === "across" ? Math.floor((size - seedWord.length) / 2) : Math.floor(size / 2) + seedOffset;
    if (seedRow < 0 || seedCol < 0 || seedRow >= size || seedCol >= size) return null;
    for (let i = 0; i < seedWord.length; i++) {
      const r = seedDir === "down" ? seedRow + i : seedRow;
      const c = seedDir === "across" ? seedCol + i : seedCol;
      if (!inBounds(size, r, c)) return null;
      grid[r][c] = seedWord[i];
    }

    let derived = deriveEntriesFromGrid(grid, minLen);
    const used = new Set<string>([seedWord]);

    for (let round = 0; round < 26 && nowOk() && derived.length < opts.targetEntries; round++) {
      let best:
        | {
            word: string;
            grid: string[][];
            derived: DerivedEntry[];
            score: number;
          }
        | null = null;

      const currentAnswers = new Set(derived.map((entry) => entry.answer));
      const wordOrder = answers
        .filter((answer) => !used.has(answer) && !currentAnswers.has(answer))
        .sort((a, b) => {
          const aTheme = thematicAnswers.has(a) ? 1 : 0;
          const bTheme = thematicAnswers.has(b) ? 1 : 0;
          if (aTheme !== bTheme) return bTheme - aTheme;
          const aFit = a.length >= 4 && a.length <= 7 ? 1 : 0;
          const bFit = b.length >= 4 && b.length <= 7 ? 1 : 0;
          if (aFit !== bFit) return bFit - aFit;
          return a.length - b.length || a.localeCompare(b);
        });

      for (const word of wordOrder) {
        if (!nowOk()) break;
        for (let row = 0; row < size; row++) {
          for (let col = 0; col < size; col++) {
            for (const dir of ["across", "down"] as const) {
              const written = writeWord(grid, word, row, col, dir);
              if (!written) continue;
              if (hasShortLetterRuns(written.grid, minLen)) continue;
              const nextDerived = deriveEntriesFromGrid(written.grid, minLen);
              if (nextDerived.length <= derived.length) continue;
              if (!nextDerived.some((entry) => entry.answer === word)) continue;
              if (nextDerived.some((entry) => !allowedAnswers.has(entry.answer))) continue;
              if (nextDerived.some((entry) => isForbiddenPublishAnswer(entry.answer))) continue;

              const crossed = crossedEntryStats(written.grid, nextDerived, minLen);
              const entryCrossings = entryCrossingStats(written.grid, nextDerived, minLen);
              if (
                nextDerived.length >= opts.targetEntries - 1 &&
                entryCrossings.weakEntries.length > 0
              ) {
                continue;
              }
              const checked = checkedCellStats(written.grid, minLen);
              const across = nextDerived.filter((entry) => entry.direction === "across").length;
              const down = nextDerived.length - across;
              const themeCount = nextDerived.filter((entry) => thematicAnswers.has(entry.answer)).length;
              const score =
                nextDerived.length * 20000 +
                themeCount * 6500 +
                crossed.crossed * 1800 +
                checked.ratio * 4500 +
                Math.min(across, down) * 1800 +
                written.crossings * 700 -
                entryCrossings.weakEntries.length * 50000 +
                Math.abs(across - down) * -700 +
                written.newCells * 18;

              if (!best || score > best.score) {
                best = { word, grid: written.grid, derived: nextDerived, score };
              }
            }
          }
        }
      }

      if (!best) break;
      grid = best.grid;
      derived = best.derived;
      used.add(best.word);
    }

    for (let pairRound = 0; pairRound < 4 && nowOk() && derived.length < opts.targetEntries; pairRound++) {
      let bestPair:
        | {
            words: [string, string];
            grid: string[][];
            derived: DerivedEntry[];
            score: number;
          }
        | null = null;
      const currentAnswers = new Set(derived.map((entry) => entry.answer));
      const remaining = answers.filter((answer) => !used.has(answer) && !currentAnswers.has(answer));

      for (const acrossWord of remaining) {
        for (const downWord of remaining) {
          if (acrossWord === downWord) continue;
          for (let ai = 0; ai < acrossWord.length; ai++) {
            for (let di = 0; di < downWord.length; di++) {
              if (acrossWord[ai] !== downWord[di]) continue;
              for (let crossR = 0; crossR < size; crossR++) {
                for (let crossC = 0; crossC < size; crossC++) {
                  const acrossRow = crossR;
                  const acrossCol = crossC - ai;
                  const downRow = crossR - di;
                  const downCol = crossC;
                  if (acrossCol < 0 || downRow < 0) continue;
                  if (acrossCol + acrossWord.length > size || downRow + downWord.length > size) continue;

                  const next = grid.map((r) => r.slice());
                  let ok = true;
                  let newAcrossCells = 0;
                  let newDownCells = 0;

                  for (let i = 0; i < acrossWord.length && ok; i++) {
                    const r = acrossRow;
                    const c = acrossCol + i;
                    const cur = next[r][c];
                    const ch = acrossWord[i];
                    if (cur !== "#" && cur !== ch) {
                      ok = false;
                      break;
                    }
                    if (cur === "#") newAcrossCells++;
                    next[r][c] = ch;
                  }

                  for (let i = 0; i < downWord.length && ok; i++) {
                    const r = downRow + i;
                    const c = downCol;
                    const cur = next[r][c];
                    const ch = downWord[i];
                    if (cur !== "#" && cur !== ch) {
                      ok = false;
                      break;
                    }
                    if (cur === "#") newDownCells++;
                    next[r][c] = ch;
                  }

                  if (!ok || newAcrossCells < 1 || newDownCells < 1) continue;
                  if (hasShortLetterRuns(next, minLen)) continue;

                  const nextDerived = deriveEntriesFromGrid(next, minLen);
                  if (nextDerived.length <= derived.length) continue;
                  if (!nextDerived.some((entry) => entry.answer === acrossWord)) continue;
                  if (!nextDerived.some((entry) => entry.answer === downWord)) continue;
                  if (nextDerived.some((entry) => !allowedAnswers.has(entry.answer))) continue;
                  if (nextDerived.some((entry) => isForbiddenPublishAnswer(entry.answer))) continue;

                  const entryCrossings = entryCrossingStats(next, nextDerived, minLen);
                  if (
                    nextDerived.length >= opts.targetEntries &&
                    entryCrossings.weakEntries.length > 0
                  ) {
                    continue;
                  }
                  const checked = checkedCellStats(next, minLen);
                  const themeCount = nextDerived.filter((entry) => thematicAnswers.has(entry.answer)).length;
                  const score =
                    nextDerived.length * 25000 +
                    themeCount * 8000 +
                    checked.ratio * 5000 +
                    (thematicAnswers.has(acrossWord) ? 2000 : 0) +
                    (thematicAnswers.has(downWord) ? 2000 : 0) -
                    entryCrossings.weakEntries.length * 90000 -
                    (Math.abs(crossR - 5) + Math.abs(crossC - 5)) * 80;

                  if (!bestPair || score > bestPair.score) {
                    bestPair = {
                      words: [acrossWord, downWord],
                      grid: next,
                      derived: nextDerived,
                      score,
                    };
                  }
                }
              }
            }
          }
        }
      }

      if (!bestPair) break;
      grid = bestPair.grid;
      derived = bestPair.derived;
      used.add(bestPair.words[0]);
      used.add(bestPair.words[1]);
    }

    const entryCrossings = entryCrossingStats(grid, derived, minLen);
    const crossed = crossedEntryStats(grid, derived, minLen);
    const checked = checkedCellStats(grid, minLen);
    const density = crosswordDensityFromGrid(grid);
    const across = derived.filter((entry) => entry.direction === "across").length;
    const down = derived.length - across;
    const themeCount = derived.filter((entry) => thematicAnswers.has(entry.answer)).length;
    const score =
      derived.length * 30000 +
      themeCount * 9000 +
      crossed.crossed * 2200 +
      checked.ratio * 5000 +
      density * 18000 +
      Math.min(across, down) * 2500 -
      entryCrossings.weakEntries.length * 100000 -
      Math.abs(across - down) * 900;

    return { grid, derived, usedAnswers: Array.from(used), score };
  };

  let best:
    | {
        grid: string[][];
        derived: DerivedEntry[];
        usedAnswers: string[];
        score: number;
      }
    | null = null;

  for (const seedWord of orderedSeeds) {
    if (!nowOk()) break;
    for (const dir of ["across", "down"] as const) {
      for (const offset of [0, -1, 1]) {
        const built = tryBuild(seedWord, dir, offset);
        if (!built) continue;
        if (!best || built.score > best.score) best = built;
        if (
          built.derived.length >= opts.targetEntries &&
          crossedEntryStats(built.grid, built.derived, minLen).crossed >= built.derived.length &&
          entryCrossingStats(built.grid, built.derived, minLen).weakEntries.length === 0 &&
          crosswordDensityFromGrid(built.grid) >= 0.4 &&
          !hasShortLetterRuns(built.grid, minLen)
        ) {
          return {
            grid: built.grid,
            derived: built.derived,
            usedAnswers: Array.from(new Set(built.derived.map((entry) => entry.answer))),
            meta: {
              builder: "opening-crossword-11",
              openingSeed: seedWord,
              openingEntries: built.derived.length,
              density: crosswordDensityFromGrid(built.grid),
              openingTargetEntries: opts.targetEntries,
              openingThemeEntries: built.derived.filter((entry) => thematicAnswers.has(entry.answer)).length,
            },
          };
        }
      }
    }
  }

  if (!best || best.derived.length < opts.targetEntries) return null;
  if (crosswordDensityFromGrid(best.grid) < 0.4) return null;
  if (hasShortLetterRuns(best.grid, minLen)) return null;
  if (best.derived.some((entry) => !allowedAnswers.has(entry.answer))) return null;
  if (entryCrossingStats(best.grid, best.derived, minLen).weakEntries.length > 0) return null;

  return {
    grid: best.grid,
    derived: best.derived,
    usedAnswers: Array.from(new Set(best.derived.map((entry) => entry.answer))),
    meta: {
      builder: "opening-crossword-11",
      openingEntries: best.derived.length,
      density: crosswordDensityFromGrid(best.grid),
      openingTargetEntries: opts.targetEntries,
      openingThemeEntries: best.derived.filter((entry) => thematicAnswers.has(entry.answer)).length,
    },
  };
}

// -------------------- Demo fallback --------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getDemoCrossword(size: number, theme: string, language: "es" | "en") {
  const localSupportWords = inferLocalSupportWords(theme, size, new Map());
  if (localSupportWords.length > 0) {
    const candidates: WordCandidate[] = localSupportWords.map((item) => ({
      answer: normalizeAnswer(item.answer),
      thematic: item.thematic,
      source: item.thematic ? "model" : "support",
    }));
    const seed = (normalizeAnswer(theme).length * 2654435761 + size * 1013904223) >>> 0;
    const built =
      size === 11
        ? constructStrictCrossword11({
            theme,
            size,
            candidates,
            seed,
          }) ??
          constructFreeformCrossword({
            size,
            seed,
            candidates,
          })
        : constructFreeformCrossword({
            size,
            seed,
            candidates,
          });

    if (built) {
      const derived = deriveEntriesFromGrid(built.grid, minEntryLenForSize(size));
      if (derived.length > 0) {
        return {
          grid: built.grid,
          theme,
          language,
          entries: applyCluesAndOverrides(theme, language, derived, new Map()),
        };
      }
    }
  }

  if (size === 11) {
    const grid = [
      "###########",
      "#ROCK#BAND#",
      "###########",
      "#NOTE#KEYS#",
      "###########",
      "#DRUM#SOLO#",
      "###########",
      "#SONG#HARP#",
      "###########",
      "#JAZZ#PUNK#",
      "###########",
    ].map((row) => row.split(""));

    const entries: Entry[] = [
      { number: 1, row: 1, col: 1, direction: "across", answer: "ROCK", clue: language === "es" ? "Género musical." : "Music genre." },
      { number: 2, row: 1, col: 6, direction: "across", answer: "BAND", clue: language === "es" ? "Grupo de músicos." : "Group of musicians." },
      { number: 3, row: 3, col: 1, direction: "across", answer: "NOTE", clue: language === "es" ? "Símbolo musical." : "Musical symbol." },
      { number: 4, row: 3, col: 6, direction: "across", answer: "KEYS", clue: language === "es" ? "Teclas de piano." : "Piano keys." },
      { number: 5, row: 5, col: 1, direction: "across", answer: "DRUM", clue: language === "es" ? "Instrumento de percusión." : "Percussion instrument." },
      { number: 6, row: 5, col: 6, direction: "across", answer: "SOLO", clue: language === "es" ? "Actuación individual." : "Single musical performance." },
      { number: 7, row: 7, col: 1, direction: "across", answer: "SONG", clue: language === "es" ? "Composición musical." : "Musical composition." },
      { number: 8, row: 7, col: 6, direction: "across", answer: "HARP", clue: language === "es" ? "Instrumento de cuerdas." : "Stringed instrument." },
      { number: 9, row: 9, col: 1, direction: "across", answer: "JAZZ", clue: language === "es" ? "Género musical con swing." : "Music genre with swing." },
      { number: 10, row: 9, col: 6, direction: "across", answer: "PUNK", clue: language === "es" ? "Estilo musical irreverente." : "Edgy music style." },
    ];

    return { grid, entries, theme, language };
  }

  if (size === 9) {
    const grid = [
      "#########",
      "#ROCK#BAND",
      "#########",
      "#NOTE#KEYS",
      "#########",
      "#DRUM#SOLO",
      "#########",
      "#JAZZ#PUNK",
      "#########",
    ].map((row) => row.split(""));

    const entries: Entry[] = [
      { number: 1, row: 1, col: 1, direction: "across", answer: "ROCK", clue: language === "es" ? "Género musical." : "Music genre." },
      { number: 2, row: 1, col: 6, direction: "across", answer: "BAND", clue: language === "es" ? "Grupo de músicos." : "Group of musicians." },
      { number: 3, row: 3, col: 1, direction: "across", answer: "NOTE", clue: language === "es" ? "Símbolo musical." : "Musical symbol." },
      { number: 4, row: 3, col: 6, direction: "across", answer: "KEYS", clue: language === "es" ? "Teclas de piano." : "Piano keys." },
      { number: 5, row: 5, col: 1, direction: "across", answer: "DRUM", clue: language === "es" ? "Instrumento de percusión." : "Percussion instrument." },
      { number: 6, row: 5, col: 6, direction: "across", answer: "SOLO", clue: language === "es" ? "Actuación individual." : "Single musical performance." },
      { number: 7, row: 7, col: 1, direction: "across", answer: "JAZZ", clue: language === "es" ? "Género musical con swing." : "Music genre with swing." },
      { number: 8, row: 7, col: 6, direction: "across", answer: "PUNK", clue: language === "es" ? "Estilo musical irreverente." : "Edgy music style." },
    ];

    return { grid, entries, theme, language };
  }

  return null;
}

// -------------------- Handler --------------------

export async function POST(req: NextRequest) {
  try {
    await getGenerateCrosswordSupabaseSmokeClient().from("crosswords").select("id").limit(1);
  } catch (e) {
    console.warn("[generate-crossword] supabase check failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const body = (await req.json().catch(() => ({}))) as {
    theme?: string;
    language?: "es" | "en" | string;
    size?: unknown;
  };

  const theme = (body.theme || "Argentina").toString();
  const language: "es" | "en" = body.language === "en" ? "en" : "es";
  const n: number = 11;

  configureOpenAITlsForLocalDev();

  const apiKey = process.env.OPENAI_API_KEY;
  const client = apiKey
    ? createGenerateCrosswordOpenAIClient({ apiKey, timeout: n === 11 ? 45_000 : 10_000, maxRetries: 0 })
    : null;

  const TIME_BUDGET_MS = n === 11 ? 240_000 : 22_000;
  const t0 = Date.now();
  const deadlineMs = t0 + (globalThis.__generateCrosswordTestOverrides?.timeBudgetMs ?? TIME_BUDGET_MS);
  const csp11Enabled = n === 11 && isCsp11Enabled();
  const csp11DiagnosticOnly = shouldUseCspDiagnosticOnly({
    cspEnabled: csp11Enabled,
    diagnosticOnly: process.env.CROSSWORD_CSP_11_DIAGNOSTIC_ONLY,
  });
  const csp11DiagnosticBudgetMs = Math.max(
    1_000,
    Number(process.env.CROSSWORD_CSP_11_DIAGNOSTIC_BUDGET_MS) || 45_000
  );
  const csp11HybridDiagnostic =
    csp11DiagnosticOnly && process.env.CROSSWORD_CSP_11_HYBRID_DIAGNOSTIC === "true";
  let csp11Attempted = false;
  let lastCspAttemptMeta: Record<string, unknown> | null = null;

  console.warn("[generate-crossword] env check", {
    hasApiKey: Boolean(apiKey),
    apiKeyLen: apiKey?.length ?? 0,
    hasClient: Boolean(client),
    theme,
    language,
    size: n,
  });
  console.warn("[generate-crossword] csp11 config", {
    enabled: csp11Enabled,
    diagnosticOnly: csp11DiagnosticOnly,
    hybridDiagnostic: csp11HybridDiagnostic,
    theme,
    language,
    candidateCount: 0,
    deadlineRemainingMs: deadlineMs - Date.now(),
  });

  const makeGenerationErrorResponse = (meta: Record<string, unknown>, status = 503) => {
    const responseMeta = {
      ...meta,
      ...(lastCspAttemptMeta && { cspAttempt: lastCspAttemptMeta }),
    };
    console.warn("[generate-crossword] GENERATION FAILED", responseMeta);
    return NextResponse.json(
      {
        error: "No se pudo generar un crucigrama jugable con la calidad requerida.",
        theme,
        language,
        size: n,
        meta: responseMeta,
      },
      { status }
    );
  };

  const publishCrosswordResponse = (out: Crossword) => {
    if (n !== 11) return NextResponse.json(out, { status: 200 });

    const minLen = minEntryLenForSize(n);
    const minEntriesForGate = minPublishEntriesForSize(n);
    const finalEntryCrossings = entryCrossingStats(out.grid, out.entries, minLen);
    const finalCrossed = crossedEntryStats(out.grid, out.entries, minLen);
    const finalChecked = checkedCellStats(out.grid, minLen);
    const finalThematicSet = new Set(out.entries.map((entry) => entry.answer));
    const finalQualityIssue = publishQualityIssue(
      out.entries,
      finalThematicSet,
      language,
      minEntriesForGate,
      theme
    );
    const tolerableNearQualityIssue = false;
    const metaCore =
      typeof out.meta?.coreThematicEntries === "number"
        ? out.meta.coreThematicEntries
        : undefined;
    const metaGeneric =
      typeof out.meta?.genericContextEntries === "number"
        ? out.meta.genericContextEntries
        : undefined;
    const inferredCore = out.entries.filter(
      (entry) =>
        !LOW_VALUE_CONTEXTLESS_ANSWERS.has(entry.answer) &&
        !BANNED_ANSWERS.has(entry.answer)
    ).length;
    const finalCoreThematicEntries = Math.max(metaCore ?? 0, inferredCore);
    const finalGenericContextEntries = Math.min(
      metaGeneric ?? out.entries.length - inferredCore,
      Math.max(0, out.entries.length - finalCoreThematicEntries)
    );
    const minCoreEntries = minCoreThematicEntriesForPublish(n, out.entries.length);
    const maxGenericEntries = maxGenericContextEntriesForPublish(n, out.entries.length);
    const minCheckedRatioForPublish = 0.2;
    const minDensityForPublish = 0.4;
    const finalDensity = crosswordDensityFromGrid(out.grid);
    const finalHasShortRuns = hasShortLetterRuns(out.grid, minLen);
    const hasEnoughCrossing =
      finalCrossed.crossed >= out.entries.length &&
      finalEntryCrossings.weakEntries.length === 0;
    const finalUnsupported = out.entries.filter(
      (entry) =>
        !isPublishableAnswerForTheme({
          theme,
          answer: entry.answer,
          language,
          size: n,
          allowContextualGeneric: finalThematicSet.has(entry.answer),
        })
    );

    if (finalHasShortRuns) {
      const allowedAnswers = new Set(out.entries.map((entry) => entry.answer));
      const clueByAnswer = new Map(out.entries.map((entry) => [entry.answer, entry.clue] as const));
      const cleanedGrid = blockShortRunsOnly(out.grid, minLen);
      const rebuilt = rebuildGridFromAllowedEntries(cleanedGrid, allowedAnswers, minLen);
      if (rebuilt && !hasShortLetterRuns(rebuilt.grid, minLen)) {
        const repairedEntries = repairPublishClues(
          rebuilt.derived.map((entry) => ({
            ...entry,
            clue: clueByAnswer.get(entry.answer) ?? "",
          })),
          {
            theme,
            language,
            thematicSet: finalThematicSet,
            notesByAnswer: new Map(),
          }
        );
        if (repairedEntries.length >= minEntriesForGate) {
          return publishCrosswordResponse({
            ...out,
            grid: rebuilt.grid,
            entries: repairedEntries,
            meta: {
              ...out.meta,
              source: `${out.meta?.source ?? "unknown"}-short-runs-repaired`,
              repairedShortRuns: true,
              preRepairEntries: out.entries.length,
            },
          });
        }
      }
    }

    if (finalEntryCrossings.weakEntries.length > 0) {
      const weakAnswers = new Set(finalEntryCrossings.weakEntries.map((entry) => entry.answer));
      const prunedEntries = out.entries.filter((entry) => !weakAnswers.has(entry.answer));
      if (prunedEntries.length >= minEntriesForGate) {
        const rebuilt = rebuildGridFromEntries(n, prunedEntries, minLen);
        if (rebuilt && !hasShortLetterRuns(rebuilt.grid, minLen)) {
          const clueByAnswer = new Map(out.entries.map((entry) => [entry.answer, entry.clue] as const));
          const repairedEntries = repairPublishClues(
            rebuilt.derived.map((entry) => ({
              ...entry,
              clue: clueByAnswer.get(entry.answer) ?? "",
            })),
            {
              theme,
              language,
              thematicSet: finalThematicSet,
              notesByAnswer: new Map(),
            }
          );
          console.warn("[generate-crossword] publish pruning weak entries", {
            removed: Array.from(weakAnswers),
            before: out.entries.length,
            after: repairedEntries.length,
          });
          return publishCrosswordResponse({
            ...out,
            grid: rebuilt.grid,
            entries: repairedEntries,
            meta: {
              ...out.meta,
              source: `${out.meta?.source ?? "unknown"}-weak-pruned`,
              prunedWeakEntries: Array.from(weakAnswers),
            },
          });
        }
      }
    }

    if (
      out.entries.length < minEntriesForGate ||
      !hasEnoughCrossing ||
      finalDensity < minDensityForPublish ||
      finalChecked.ratio < minCheckedRatioForPublish ||
      finalCoreThematicEntries < minCoreEntries ||
      finalGenericContextEntries > maxGenericEntries ||
      finalHasShortRuns ||
      finalUnsupported.length > 0 ||
      (finalQualityIssue && !tolerableNearQualityIssue)
    ) {
      return makeGenerationErrorResponse(
        {
          source: "publish-gate",
          originalSource: out.meta?.source,
          reason:
            finalQualityIssue ??
            (out.entries.length < minEntriesForGate
              ? "La grilla final no alcanzo el minimo de entradas publicables."
              : finalCoreThematicEntries < minCoreEntries
              ? "La grilla final no alcanzo suficientes entradas tematicas reales."
              : finalGenericContextEntries > maxGenericEntries
              ? "La grilla final contiene demasiadas entradas genericas adyacentes."
              : finalDensity < minDensityForPublish
              ? "La grilla final tiene una densidad demasiado baja."
              : finalHasShortRuns
              ? "La grilla final contenia secuencias demasiado cortas."
              : "La grilla final no alcanzo el minimo de cruces por entrada."),
          finalEntries: out.entries.length,
          finalDensity,
          minDensityForPublish,
          finalCrossedEntries: finalCrossed.crossed,
          finalCheckedRatio: finalChecked.ratio,
          minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
          weakCrossingEntries: finalEntryCrossings.weakEntries,
          finalCoreThematicEntries,
          minCoreThematicEntries: minCoreEntries,
          finalGenericContextEntries,
          maxGenericContextEntries: maxGenericEntries,
          finalUnsupportedAnswers: finalUnsupported.map((entry) => entry.answer),
          finalHasShortRuns,
          finalQualityIssue,
          finalAnswers: out.entries.map((entry) => entry.answer),
        },
        422
      );
    }

    return NextResponse.json(out, { status: 200 });
  };

  if (!client) {
    return makeGenerationErrorResponse(
      { source: "generation-error", reason: "OPENAI_API_KEY no configurada." },
      503
    );
  }

  if (n === 11 && process.env.ENABLE_DIRECT_MODEL_11 === "1") {
    try {
      const direct = await requestDirectPlayableCrossword11({
        client,
        theme,
        language,
        attempt: 0,
      });

      if (direct) {
        console.warn("[generate-crossword] publishing direct validated 11x11", {
          entries: direct.entries.length,
          source: direct.meta?.source,
        });
        return publishCrosswordResponse(direct);
      }
    } catch (error: unknown) {
      console.warn("[generate-crossword] direct validated 11x11 failed; continuing legacy pipeline", {
        msg: errorSummary(error),
      });
    }
  }

  if (n === 11 && process.env.OPENAI_FIXED_PATTERN_GRID === "1") {
    try {
      const generatedFixedGrid = await requestGeneratedPatternGrid11({
        client,
        theme,
        language,
        size: n,
        attempt: 0,
      });

      if (generatedFixedGrid) {
        const derived = deriveEntriesFromGrid(
          generatedFixedGrid.grid,
          minEntryLenForSize(n)
        );
        const thematicSet = new Set(generatedFixedGrid.thematicAnswers);
        const clueItems: ClueRequestItem[] = derived.map((entry) => {
          const note = generatedFixedGrid.notes.get(entry.answer);
          return {
            answer: entry.answer,
            thematic: thematicSet.has(entry.answer),
            note,
            hint:
              buildThematicClueRequestHint(
                theme,
                entry.answer,
                language,
                note
              ) ?? undefined,
          };
        });
        const clueByAnswer = await requestModelClues({
          client,
          theme,
          language,
          items: clueItems,
        });
        reinforceThematicClues(
          theme,
          language,
          derived.map((entry) => entry.answer),
          clueByAnswer,
          generatedFixedGrid.notes,
          thematicSet
        );
        const entries = repairPublishClues(
          applyCluesAndOverrides(theme, language, derived, clueByAnswer),
          {
            theme,
            language,
            thematicSet,
            notesByAnswer: generatedFixedGrid.notes,
          }
        );

        console.warn("[generate-crossword] publishing fast fixed-pattern result", {
          entries: entries.length,
          builder: generatedFixedGrid.meta.builder,
        });
        return publishCrosswordResponse({
          theme,
          language,
          size: n,
          grid: generatedFixedGrid.grid,
          entries,
          meta: {
            source: "fast-generated-fixed-pattern-11",
            coreThematicEntries: generatedFixedGrid.thematicAnswers.length,
            genericContextEntries:
              entries.length - generatedFixedGrid.thematicAnswers.length,
            ...generatedFixedGrid.meta,
          },
        });
      }
    } catch (error: unknown) {
      console.warn("[generate-crossword] fast fixed-pattern path failed", {
        msg: errorSummary(error),
      });
    }
  }

  const MAX_ATTEMPTS = n === 11 ? 2 : 1;
  const allowModelRescueFor11 = n === 11 && process.env.OPENAI_11X11_MODEL_RESCUE !== "0";
  let bestPartial:
    | {
        built: { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> };
        derived: DerivedEntry[];
        pool: WordCandidate[];
        notesByAnswer: Map<string, string>;
        trustedThematicSet: Set<string>;
        attempt: number;
        fallbackScore: number;
      }
    | null = null;
  let lastAttemptPool: WordCandidate[] = [];
  let lastModelError: string | null = null;
  let lastAnswerbankIssue: string | null = null;
  let lastBuildIssue: Record<string, unknown> | null = null;
  let lastAnswerStats: Record<string, unknown> | null = null;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (Date.now() > deadlineMs) break;
      console.warn("[generate-crossword] attempt start", { attempt, MAX_ATTEMPTS });

      // Phase 1: answers-only
      const answerbankRequest = `${ANSWERBANK_PROMPT}\n${buildAnswerbankRequest(theme, language, n)}`;

      let answerbankTextResult: AnswerbankTextResult | null = null;
      try {
        answerbankTextResult =
          n === 11
            ? await requestLengthBucketedAnswerbankText({
                client,
                theme,
                language,
                size: n,
              })
            : await requestAnswerbankText({
                client,
                prompt: answerbankRequest,
              });
      } catch (e: unknown) {
        lastModelError = errorSummary(e);
        console.warn("[generate-crossword] model1 failed", {
          attempt,
          error: lastModelError,
        });
        try {
          answerbankTextResult =
            n === 11
              ? await requestLengthBucketedAnswerbankText({
                  client,
                  theme,
                  language,
                  size: n,
                })
              : await requestCompactAnswerbankText({
                  client,
                  theme,
                  language,
                  size: n,
                });
          console.warn("[generate-crossword] answerbank fallback succeeded", {
            attempt,
            model: answerbankTextResult.model,
            finishReason: answerbankTextResult.finishReason,
          });
        } catch (fallbackError: unknown) {
          lastModelError = `${lastModelError}; compact fallback: ${errorSummary(fallbackError)}`;
          console.warn("[generate-crossword] compact answerbank fallback failed", {
            attempt,
            error: lastModelError,
          });
          if (n === 11 && Date.now() < deadlineMs - 10_000) {
            try {
              const emergencyAnswers = await topUpAnswersRobust({
                client,
                theme,
                language,
                size: n,
                existing: [],
                need: 64,
                attempt,
              });
              if (emergencyAnswers.length >= minPublishEntriesForSize(n)) {
                const emergencyNotes = emergencyAnswers.map((answer) => ({
                  answer,
                  note:
                    language === "es"
                      ? `Respuesta candidata del banco tematico sobre ${theme}.`
                      : `Candidate themed answer from the ${theme} answer bank.`,
                }));
                answerbankTextResult = {
                  text: JSON.stringify({ answers: emergencyAnswers, notes: emergencyNotes }),
                  model: ANSWERBANK_MODEL,
                  finishReason: "emergency-answer-only",
                  usedWebSearch: false,
                };
                console.warn("[generate-crossword] emergency answer-only bank succeeded", {
                  attempt,
                  answers: emergencyAnswers.length,
                });
              } else {
                continue;
              }
            } catch (emergencyError: unknown) {
              lastModelError = `${lastModelError}; answer-only emergency: ${errorSummary(emergencyError)}`;
              continue;
            }
          } else {
            continue;
          }
        }
      }

      const rawAnswersText = answerbankTextResult.text;
      console.warn("[generate-crossword] answerbank raw", {
        attempt,
        model: answerbankTextResult.model,
        finish_reason: answerbankTextResult.finishReason,
        usedWebSearch: answerbankTextResult.usedWebSearch,
        rawText_len: rawAnswersText.length,
        rawText_head: rawAnswersText.slice(0, 250),
        rawText_tail: rawAnswersText.slice(-200),
      });

      const parsedAnswers = safeJson<RawAnswerBank>(rawAnswersText);
      const salvagedAnswers =
        !parsedAnswers || !Array.isArray(parsedAnswers.answers)
          ? salvageAnswerStringsFromJson(rawAnswersText)
          : [];
      const usableParsedAnswers: RawAnswerBank | null =
        parsedAnswers && Array.isArray(parsedAnswers.answers)
          ? parsedAnswers
          : salvagedAnswers.length > 0
          ? { answers: salvagedAnswers }
          : null;

      if (!usableParsedAnswers || !Array.isArray(usableParsedAnswers.answers)) {
        lastAnswerbankIssue = `answerbank parse failed; chars=${rawAnswersText.length}; finish=${answerbankTextResult.finishReason ?? "unknown"}`;
        console.warn("[generate-crossword] skip: answerbank parse failed", { attempt });
        continue;
      }

      const cspBankAuditReport = createCspBankAuditReport(theme, language, n);
      cspBankAuditReport.initialRawCount = usableParsedAnswers.answers.length;
      cspBankAuditSetDistribution(
        cspBankAuditReport,
        "raw-openai-answers",
        usableParsedAnswers.answers.map((answer) => String(answer ?? ""))
      );

      type NoteItem = { answer?: unknown; note?: unknown };

      const notesByAnswer = new Map<string, string>();

      const rawNotes = (usableParsedAnswers as unknown as { notes?: unknown }).notes;

      const notesArr: NoteItem[] = Array.isArray(rawNotes) ? (rawNotes as NoteItem[]) : [];

      for (const n0 of notesArr) {
        const a = typeof n0.answer === "string" ? normalizeAnswer(n0.answer) : "";
        const note = typeof n0.note === "string" ? n0.note.trim() : "";
        if (a && note && !noteLooksWeakThematicContext(note, language)) notesByAnswer.set(a, note);
      }

      const rawNormalizedAnswers = Array.isArray(usableParsedAnswers.answers)
        ? usableParsedAnswers.answers.map((answer) => normalizeAnswer(String(answer ?? ""))).filter(Boolean)
        : [];
      cspBankAuditSetDistribution(cspBankAuditReport, "after-normalizeAnswer", rawNormalizedAnswers);
      const geographicCompoundPrefixes = [
        "CERRO",
        "LAGO",
        "RIO",
        "ISLA",
        "PUERTO",
        "VILLA",
        "COLONIA",
        "RUTA",
        "PARQUE",
        "MONTE",
      ];
      for (const answer of rawNormalizedAnswers) {
        const note = notesByAnswer.get(answer);
        if (!note) continue;
        for (const prefix of geographicCompoundPrefixes) {
          if (!answer.startsWith(prefix)) continue;
          const suffix = answer.slice(prefix.length);
          if (suffix.length >= minEntryLenForSize(n) && suffix.length <= n && !notesByAnswer.has(suffix)) {
            notesByAnswer.set(suffix, note);
          }
          if (prefix.length >= minEntryLenForSize(n) && prefix.length <= n && !notesByAnswer.has(prefix)) {
            notesByAnswer.set(prefix, note);
          }
        }
      }

      // sanitize + dedupe + filter
      const cleanAnswers = sanitizeAnswerList(usableParsedAnswers.answers, n, language);
      const normalizedThemeAnswer = normalizeAnswer(theme);
      for (let i = cleanAnswers.length - 1; i >= 0; i--) {
        if (cleanAnswers[i] === normalizedThemeAnswer) cleanAnswers.splice(i, 1);
      }
      cspBankAuditReport.initialSanitizedCount = cleanAnswers.length;
      cspBankAuditAnalyzeSanitize(usableParsedAnswers.answers, cleanAnswers, {
        theme,
        maxLen: n,
        language,
        report: cspBankAuditReport,
      });
      cspBankAuditSetDistribution(cspBankAuditReport, "after-sanitizeAnswerList", cleanAnswers);
      notesByAnswer.delete(normalizedThemeAnswer);
      for (const expanded of expandGeographicCompoundAnswers(rawNormalizedAnswers, n)) {
        if (!answerLanguageLooksValidForPuzzle(expanded, language)) continue;
        if (isLikelyBadAnswer(expanded) && !ALWAYS_ALLOW_ANSWERS.has(expanded)) continue;
        if (!cleanAnswers.includes(expanded)) cleanAnswers.push(expanded);
      }

      const topUpTarget =
        n === 11
          ? Math.max(cleanAnswers.length, 90)
          : TARGET_ANSWERS;
      const topUpRounds =
        n === 11
          ? 0
          : cleanAnswers.length < 40
            ? 1
            : 0;
      for (let t = 0; t < topUpRounds && cleanAnswers.length < topUpTarget; t++) {
        const need = Math.min(n === 11 ? 45 : 18, topUpTarget - cleanAnswers.length);
        const more =
          n === 11
            ? await topUpAnswers({
                client,
                theme,
                language,
                size: n,
                existing: cleanAnswers,
                need,
                attempt,
              })
            : await topUpAnswersRobust({
                client,
                theme,
                language,
                size: n,
                existing: cleanAnswers,
                need,
                attempt,
              });

        for (const a of more) {
          if (cleanAnswers.length >= topUpTarget) break;
          if (!cleanAnswers.includes(a)) {
            cleanAnswers.push(a);
          }
        }
      }

      for (const expanded of expandGeographicCompoundAnswers(cleanAnswers, n)) {
        if (!cleanAnswers.includes(expanded)) cleanAnswers.push(expanded);
      }
      cspBankAuditSetDistribution(cspBankAuditReport, "after-general-topups", cleanAnswers);

      // Minimum clean answers required
const minClean = n === 9 ? 16 : n === 11 ? minPublishEntriesForSize(n) : 26;

      // Validate even 11x11 banks: publishing hallucinated "theme" words is worse
      // than spending one bounded anti-hallucination pass.
      let validated: string[];
      const structuredTrustedSet = new Set(answerbankTextResult.trustedAnswers ?? []);
      if (n === 11) {
        try {
          cspBankAuditSetDistribution(cspBankAuditReport, "sent-to-validateThematicAnswers", cleanAnswers);
          const modelValidated = await validateThematicAnswers({
            client,
            theme,
            language,
            size: n,
            answers: cleanAnswers,
            attempt,
          });
          cspBankAuditRejectedBySet(
            cspBankAuditReport,
            "validateThematicAnswers",
            cleanAnswers,
            modelValidated,
            "failed-thematic-validation"
          );
          validated = modelValidated.filter((answer) =>
            isPublishableAnswerForTheme({
              theme,
              answer,
              language,
              size: n,
              note: notesByAnswer.get(answer),
              allowContextualGeneric: false,
            })
          );
          cspBankAuditRejectedBySet(
            cspBankAuditReport,
            "post-thematic-publishable-filter",
            modelValidated,
            validated,
            "likely-bad-answer"
          );
        } catch (error: unknown) {
          console.warn("[generate-crossword] validate failed; falling back to local theme filter", {
            attempt,
            name: error instanceof Error ? error.name : "unknown",
            msg: error instanceof Error ? error.message : String(error),
          });
          validated = cleanAnswers.filter((answer) => {
            if (
              !isPublishableAnswerForTheme({
                theme,
                answer,
                language,
                size: n,
                note: notesByAnswer.get(answer),
                allowContextualGeneric: false,
              })
            ) {
              return false;
            }
            if (isForbiddenPublishAnswer(answer)) return false;
            if (isOverGenericThemeWordForTheme(theme, answer)) return false;
            const note = notesByAnswer.get(answer);
            const usefulNote = Boolean(
              note && note.trim().length >= 8 && !noteLooksWeakThematicContext(note, language)
            );
            return usefulNote || isThemeCoreWord(theme, answer);
          });
          cspBankAuditRejectedBySet(
            cspBankAuditReport,
            "validateThematicAnswers",
            cleanAnswers,
            validated,
            "other"
          );
        }
      } else {
        try {
          cspBankAuditSetDistribution(cspBankAuditReport, "sent-to-validateThematicAnswers", cleanAnswers);
          validated = await validateThematicAnswers({
            client,
            theme,
            language,
            size: n,
            answers: cleanAnswers,
            attempt,
          });
          cspBankAuditRejectedBySet(
            cspBankAuditReport,
            "validateThematicAnswers",
            cleanAnswers,
            validated,
            "failed-thematic-validation"
          );
        } catch (error: unknown) {
          console.warn("[generate-crossword] validate failed; falling back to local theme filter", {
            attempt,
            name: error instanceof Error ? error.name : "unknown",
            msg: error instanceof Error ? error.message : String(error),
          });
          validated = cleanAnswers.filter((answer) => {
            if (isForbiddenPublishAnswer(answer)) return false;
            if (isOverGenericThemeWordForTheme(theme, answer)) return false;
            const note = notesByAnswer.get(answer);
            const usefulNote = Boolean(
              note && note.trim().length >= 8 && !noteLooksWeakThematicContext(note, language)
            );
            return usefulNote || isThemeCoreWord(theme, answer);
          });
          cspBankAuditRejectedBySet(
            cspBankAuditReport,
            "validateThematicAnswers",
            cleanAnswers,
            validated,
            "other"
          );
        }
      }
      cspBankAuditSetDistribution(cspBankAuditReport, "accepted-by-validateThematicAnswers", validated);
      cspBankAuditReport.validatedCount = validated.length;

      if (
        n === 11 &&
        answerbankTextResult.finishReason !== "structured-length-buckets" &&
        cleanAnswers.length < 70 &&
        Date.now() < deadlineMs - 20_000
      ) {
        const targetByLength = new Map<number, number>([
          [3, 4],
          [4, 10],
          [5, 12],
          [6, 10],
          [7, 12],
          [8, 10],
        ]);
        const validatedCountByLength = validated.reduce((counts, answer) => {
          counts.set(answer.length, (counts.get(answer.length) ?? 0) + 1);
          return counts;
        }, new Map<number, number>());
        const desiredByLength = new Map<number, number>();
        for (const [len, target] of targetByLength) {
          const deficit = Math.max(0, target - (validatedCountByLength.get(len) ?? 0));
          if (deficit > 0) desiredByLength.set(len, Math.min(deficit + 3, 14));
        }

        if (desiredByLength.size > 0) {
          try {
            const balancedAnswers = await generateLengthBalancedThematicAnswers({
              client,
              theme,
              language,
              size: n,
              existing: cleanAnswers,
              desiredByLength,
              attempt,
            });
            const balancedValidated =
              balancedAnswers.length > 0
                ? await validateThematicAnswers({
                    client,
                    theme,
                    language,
                    size: n,
                    answers: balancedAnswers,
                    attempt,
                  })
                : [];
            const publishableBalanced = balancedValidated.filter((answer) =>
              isPublishableAnswerForTheme({
                theme,
                answer,
                language,
                size: n,
                note: notesByAnswer.get(answer),
                allowContextualGeneric: false,
              })
            );

            for (const answer of balancedAnswers) {
              if (!cleanAnswers.includes(answer)) cleanAnswers.push(answer);
            }
            validated = Array.from(new Set([...validated, ...publishableBalanced]));
            cspBankAuditSetDistribution(cspBankAuditReport, "length-balanced-topup-raw", balancedAnswers);
            cspBankAuditRejectedBySet(
              cspBankAuditReport,
              "length-balanced-topup-validation",
              balancedAnswers,
              publishableBalanced,
              "failed-thematic-validation"
            );
            cspBankAuditSetDistribution(cspBankAuditReport, "after-length-balanced-topup", validated);

            console.warn("[generate-crossword] length-balanced topup validated", {
              attempt,
              generated: balancedAnswers.length,
              kept: publishableBalanced.length,
              validatedByLength: Object.fromEntries(
                validated.reduce((counts, answer) => {
                  counts.set(answer.length, (counts.get(answer.length) ?? 0) + 1);
                  return counts;
                }, new Map<number, number>())
              ),
            });
          } catch (error: unknown) {
            console.warn("[generate-crossword] length-balanced topup failed", {
              attempt,
              name: error instanceof Error ? error.name : "unknown",
              msg: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      const validationTarget = n === 11 ? 60 : 36;
      const validationTopUpRounds = n === 11 ? 0 : 1;
      for (
        let validationRound = 0;
        validationRound < validationTopUpRounds &&
        validated.length < validationTarget &&
        Date.now() < deadlineMs - 25_000;
        validationRound++
      ) {
        const extraNeed = Math.min(n === 11 ? 40 : 48, validationTarget - validated.length);
        const extraAnswers = await topUpAnswersRobust({
          client,
          theme,
          language,
          size: n,
          existing: cleanAnswers,
          need: extraNeed,
          attempt,
        });

        const appended: string[] = [];
        for (const answer of extraAnswers) {
          if (validated.includes(answer)) continue;
          if (!cleanAnswers.includes(answer)) cleanAnswers.push(answer);
          appended.push(answer);
        }

        if (appended.length > 0) {
          const extraValidated = await validateThematicAnswers({
            client,
            theme,
            language,
            size: n,
            answers: appended,
            attempt,
          });
          validated = Array.from(new Set([...validated, ...extraValidated])).filter((answer) =>
            isPublishableAnswerForTheme({
              theme,
              answer,
              language,
              size: n,
              note: notesByAnswer.get(answer),
              allowContextualGeneric: false,
            })
          );
          console.warn("[generate-crossword] validate: post-validation topup", {
            attempt,
            validationRound,
            appended: appended.length,
            extraValidated: extraValidated.length,
            validated: validated.length,
          });
        }
        if (appended.length === 0) break;
      }

      cspBankAuditSetDistribution(cspBankAuditReport, "after-all-general-and-validation-topups", validated);

const thematicKeepSet = new Set(
  validated
    .map((a) => normalizeAnswer(a))
    .filter(Boolean)
);
      if (n === 11) {
        for (const answer of answerbankTextResult.contextAnswers ?? []) {
          const note = notesByAnswer.get(answer);
          if (
            structuredTrustedSet.has(answer) &&
            note &&
            note.length >= 8 &&
            !noteLooksWeakThematicContext(note, language)
          ) {
            thematicKeepSet.add(answer);
          }
        }
      }
      for (const expanded of expandGeographicCompoundAnswers(Array.from(thematicKeepSet), n)) {
        thematicKeepSet.add(expanded);
        if (!cleanAnswers.includes(expanded)) cleanAnswers.push(expanded);
      }
      lastAnswerStats = {
        cleanCount: cleanAnswers.length,
        cleanSample: cleanAnswers.slice(0, 30),
        validatedCount: validated.length,
        validatedSample: validated.slice(0, 30),
        thematicKeepCount: thematicKeepSet.size,
        thematicKeepSample: Array.from(thematicKeepSet).slice(0, 30),
      };

      const MIN_KEEP_TO_APPLY = Math.max(12, Math.floor(minClean * 0.5)); // 26 => 13

      if (validated.length >= MIN_KEEP_TO_APPLY) {
        const next: string[] = [];
        const seen = new Set<string>();

        for (const a of validated) {
          if (seen.has(a)) continue;
          seen.add(a);
          next.push(a);
        }

        // For 11x11, do not re-add unvalidated model answers: they are the
        // source of hallucinated "thematic" entries.
        if (n !== 11 && next.length < minClean) {
          for (const a of cleanAnswers) {
            if (next.length >= minClean) break;
            if (seen.has(a)) continue;
            seen.add(a);
            next.push(a);
          }
        }

        if (n !== 11) {
          // keep extra variety up to TARGET_ANSWERS
          for (const a of cleanAnswers) {
            if (next.length >= TARGET_ANSWERS) break;
            if (seen.has(a)) continue;
            seen.add(a);
            next.push(a);
          }
        }

        cleanAnswers.length = 0;
        for (const a of next) cleanAnswers.push(a);

        console.warn("[generate-crossword] validate: applied", {
          attempt,
          keep: validated.length,
          finalCount: cleanAnswers.length,
          minClean,
          minKeepToApply: MIN_KEEP_TO_APPLY,
        });
      } else {
        console.warn("[generate-crossword] validate: keep too small, skipping prune", {
          attempt,
          keep: validated.length,
          minKeepToApply: MIN_KEEP_TO_APPLY,
          cleanBefore: cleanAnswers.length,
        });
      }

      if (cleanAnswers.length < minClean) {
        lastAnswerbankIssue = `not enough clean answers after sanitize/topup; clean=${cleanAnswers.length}; min=${minClean}`;
        console.warn("[generate-crossword] skip: not enough clean answers after sanitize/topup", {
          attempt,
          cleanCount: cleanAnswers.length,
          minClean,
        });
        continue;
      }

      const normalizedAnswerBank: RawAnswerBank = { answers: cleanAnswers };
      let supportWords: string[] =
        n === 11
          ? (answerbankTextResult.contextAnswers ?? []).filter((answer) =>
              structuredTrustedSet.has(answer)
            )
          : [];

      if (Date.now() < deadlineMs - (n === 11 ? 35_000 : 2_500)) {
        try {
          supportWords = (await generateSupportWords({
            client,
            theme,
            language,
            size: n,
            existing: cleanAnswers,
            attempt,
          })).filter(
            (a) =>
              !isLikelyBadAnswer(a) &&
              !isForbiddenPublishAnswer(a)
          );
        } catch (e: unknown) {
          console.warn("[generate-crossword] support generation failed", {
            attempt,
            name: e instanceof Error ? e.name : "unknown",
            msg: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (n === 11 && supportWords.length > 0) {
        for (const answer of supportWords) {
          if (isForbiddenPublishAnswer(answer)) continue;
          if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
          if (!answerLanguageLooksValidForPuzzle(answer, language)) continue;
          if (!notesByAnswer.has(answer)) {
            notesByAnswer.set(
              answer,
              language === "es"
                ? `Vocabulario concreto del dominio tematico de ${theme}.`
                : `Concrete domain vocabulary for the theme ${theme}.`
            );
          }
          thematicKeepSet.add(answer);
        }
        console.warn("[generate-crossword] contextual support admitted", {
          attempt,
          count: supportWords.length,
          sample: supportWords.slice(0, 30),
        });
      }

      if (n === 11 && supportWords.length > 0) {
        try {
          const validatedSupportWords = (
            await validateThematicAnswers({
              client,
              theme,
              language,
              size: n,
              answers: supportWords.slice(0, 60),
              attempt,
            })
          ).filter((answer) =>
            isPublishableAnswerForTheme({
              theme,
              answer,
              language,
              size: n,
              note: notesByAnswer.get(answer),
              allowContextualGeneric: true,
            })
          );
          for (const answer of validatedSupportWords) {
            thematicKeepSet.add(answer);
          }
          console.warn("[generate-crossword] validated contextual support", {
            attempt,
            requested: Math.min(supportWords.length, 60),
            kept: validatedSupportWords.length,
            byLength: Object.fromEntries(
              validatedSupportWords.reduce((counts, answer) => {
                counts.set(answer.length, (counts.get(answer.length) ?? 0) + 1);
                return counts;
              }, new Map<number, number>())
            ),
          });
        } catch (error: unknown) {
          console.warn("[generate-crossword] contextual support validation failed", {
            attempt,
            msg: errorSummary(error),
          });
        }
      }

    const localSupportWords = inferLocalSupportWords(theme, n, notesByAnswer);
    if (
      n === 11 &&
      process.env.ENABLE_SEMANTIC_SUPPORT_11 === "1" &&
      Date.now() < deadlineMs - 25_000
    ) {
      try {
        const semanticSupport = await rankSemanticSupportWords({
          client,
          theme,
          language,
          size: n,
        });
        for (const answer of semanticSupport) {
          localSupportWords.push({ answer, thematic: false });
        }
        console.warn("[generate-crossword] semantic support ranked", {
          count: semanticSupport.length,
          sample: semanticSupport.slice(0, 30),
        });
      } catch (error: unknown) {
        console.warn("[generate-crossword] semantic support failed", {
          msg: errorSummary(error),
        });
      }
    }

    const broadModelThematicSet = new Set<string>(
      cleanAnswers
        .map((a) => normalizeAnswer(a))
        .filter(Boolean)
        .filter((a) => !isOverGenericThemeWordForTheme(theme, a))
        .filter((a) => {
          const languageFiller = language === "es" ? SPANISH_FILLER_WORDS : FILLER_WORDS;
          return thematicKeepSet.has(a) || !languageFiller.includes(a);
        })
    );
    const themeSetForAttempt =
      n === 11
        ? new Set<string>(thematicKeepSet)
        : new Set<string>([
            ...broadModelThematicSet,
            ...thematicKeepSet,
          ]);
    const publishThemeSet =
      thematicKeepSet.size >= 10 ? thematicKeepSet : themeSetForAttempt;
    const placementThemeSet = themeSetForAttempt;

    const rawPool = buildCandidatePoolFromAnswers(
      theme,
      normalizedAnswerBank,
      n,
      placementThemeSet,
      supportWords,
      localSupportWords,
      language
    );
    cspBankAuditReport.candidatePoolCount = rawPool.length;
    cspBankAuditSetDistribution(
      cspBankAuditReport,
      "pool-produced-by-buildCandidatePoolFromAnswers",
      rawPool.map((candidate) => candidate.answer)
    );
    cspBankAuditReport.distributions.rawPoolDistribution =
      cspBankAuditCandidateDistribution(rawPool);

    const cspRequiredLengths = cspRequiredLengthsFromPatterns11(CROSSWORD_PATTERNS_11);
    const cspCandidateReservoir = buildCspCandidateReservoir11({
      candidates: rawPool,
      thematicKeep: thematicKeepSet,
      theme,
      requiredLengths: cspRequiredLengths,
    });
    const hybridCspCandidateReservoir = csp11HybridDiagnostic
      ? buildHybridCspCandidateReservoir11({
          thematicCandidates: cspCandidateReservoir.candidates.map((candidate) => ({
            answer: candidate.answer,
            thematic: true,
            source: candidate.source,
            kind: "thematic",
          })),
          supportCandidates: loadLocalSupportCandidates11({
            language,
            requiredLengths: cspRequiredLengths,
          }),
          theme,
          requiredLengths: cspRequiredLengths,
        })
      : null;
    cspBankAuditReport.distributions.cspReservoirDistribution = Object.fromEntries(
      Object.entries(cspCandidateReservoir.distributionByLength).map(([key, value]) => [String(key), value])
    );
    cspBankAuditLog("csp-reservoir", {
      total: cspCandidateReservoir.candidates.length,
      distributionByLength: cspCandidateReservoir.distributionByLength,
      excludedCount: cspCandidateReservoir.excluded.length,
      excludedByReason: cspCandidateReservoir.excluded.reduce<Record<string, number>>((acc, item) => {
        acc[item.reason] = (acc[item.reason] ?? 0) + 1;
        return acc;
      }, {}),
      acceptedSample: cspCandidateReservoir.candidates.slice(0, 20).map((candidate) => candidate.answer),
      rejectedSample: cspCandidateReservoir.excluded.slice(0, 20),
    });
    if (hybridCspCandidateReservoir) {
      cspHybridDiagnosticLog("reservoir-ready", {
        theme,
        language,
        attempt,
        total: hybridCspCandidateReservoir.candidates.length,
        thematicCountsByLength: hybridCspCandidateReservoir.thematicCountsByLength,
        supportCountsByLength: hybridCspCandidateReservoir.supportCountsByLength,
        totalCountsByLength: hybridCspCandidateReservoir.totalCountsByLength,
      });
    }

    const placementCoreThemeSet =
      n === 11 ? new Set(placementThemeSet) : placementThemeSet;
    const placementPool =
      n === 11
        ? rawPool.map((candidate) =>
            candidate.thematic && !placementCoreThemeSet.has(candidate.answer)
              ? {
                  ...candidate,
                  thematic: false,
                  source: candidate.source === "model" ? "support" : candidate.source,
                }
              : candidate
          )
        : rawPool;
    cspBankAuditSetDistribution(
      cspBankAuditReport,
      "pool-after-placement-thematic-remap",
      placementPool.map((candidate) => candidate.answer)
    );

    const byPriority = [...placementPool].sort((a, b) => {
      const at = placementCoreThemeSet.has(a.answer) ? 1 : 0;
      const bt = placementCoreThemeSet.has(b.answer) ? 1 : 0;
      if (at !== bt) return bt - at;
      return b.answer.length - a.answer.length;
    });

    const pickPoolForSize = (items: typeof rawPool) => {
      if (n !== 11) return items;

      const thematic = items.filter((x) => placementCoreThemeSet.has(x.answer));

      const takeByLen = (
        source: typeof rawPool,
        minLen: number,
        maxLen: number,
        limit: number,
        used: Set<string>
      ) => {
        const picked: typeof rawPool = [];
        for (const item of source) {
          const len = item.answer.length;
          if (len < minLen || len > maxLen) continue;
          if (used.has(item.answer)) continue;
          picked.push(item);
          used.add(item.answer);
          if (picked.length >= limit) break;
        }
        return picked;
      };

      const used = new Set<string>();
      const next: typeof rawPool = [];

      const thematicSorted = [...thematic].sort((a, b) => b.answer.length - a.answer.length);
      next.push(...takeByLen(thematicSorted, 8, 11, 8, used));
      next.push(...takeByLen(thematicSorted, 6, 7, 12, used));
      next.push(...takeByLen(thematicSorted, 4, 5, 10, used));
      next.push(...takeByLen(thematicSorted, minEntryLenForSize(n), 3, 8, used));

      for (const item of thematicSorted) {
        if (used.has(item.answer)) continue;
        next.push(item);
        used.add(item.answer);
        if (next.length >= 96) break;
      }

      return next;
    };

    const basePool = pickPoolForSize(byPriority);
    cspBankAuditSetDistribution(
      cspBankAuditReport,
      "pool-after-pickPoolForSize",
      basePool.map((candidate) => candidate.answer)
    );
    cspBankAuditRejectedBySet(
      cspBankAuditReport,
      "pickPoolForSize",
      placementPool.map((candidate) => candidate.answer),
      basePool.map((candidate) => candidate.answer),
      "cap-or-pool-truncation"
    );

const pool =
  n === 11
    ? (() => {
        const thematic = basePool
          .filter((c) => placementCoreThemeSet.has(c.answer) && c.answer.length >= minEntryLenForSize(n))
          .slice()
          .sort((a, b) => {
            const band = (len: number) => {
              if (len >= 5 && len <= 7) return 500;
              if (len === 8) return 380;
              if (len === 4) return 340;
              if (len === 3) return 260;
              if (len === 9) return 180;
              if (len === 10) return 80;
              return 0;
            };

            const diff = band(b.answer.length) - band(a.answer.length);
            if (diff !== 0) return diff;

            return b.answer.length - a.answer.length;
          });

        const support = basePool
          .filter(
            (c) =>
              !placementCoreThemeSet.has(c.answer) &&
              c.source === "support" &&
              c.answer.length >= 4 &&
              c.answer.length <= 7 &&
              !isForbiddenPublishAnswer(c.answer)
          )
          .slice()
          .sort((a, b) => {
            const band = (len: number) => {
              if (len === 5) return 520;
              if (len === 4) return 500;
              if (len === 6) return 460;
              if (len === 7) return 360;
              return 0;
            };

            const diff = band(b.answer.length) - band(a.answer.length);
            if (diff !== 0) return diff;

            return a.answer.length - b.answer.length;
          });

        const out: typeof basePool = [];
        const used = new Set<string>();

        const pushUnique = (items: typeof basePool, limit: number) => {
          for (const item of items) {
            if (used.has(item.answer)) continue;
            out.push(item);
            used.add(item.answer);
            if (limit > 0 && out.length >= limit) break;
          }
        };

        pushUnique(thematic.filter((c) => c.answer.length >= 5 && c.answer.length <= 8), 38);
        pushUnique(thematic.filter((c) => c.answer.length === 4 || c.answer.length === 9), 56);
        pushUnique(thematic.filter((c) => c.answer.length === 3), 64);
        pushUnique(thematic.filter((c) => c.answer.length >= 10), 66);
        const supportLimit = out.length + Math.max(8, Math.floor(Math.max(1, thematic.length) / 2));
        pushUnique(support.filter((c) => c.answer.length >= 4 && c.answer.length <= 7), supportLimit);
        pushUnique(basePool.filter((c) => placementCoreThemeSet.has(c.answer) && c.answer.length >= 4), 84);
        pushUnique(
          basePool.filter(
            (c) =>
              c.source !== "filler" &&
              placementCoreThemeSet.has(c.answer) &&
              c.answer.length >= 4 &&
              !isOverGenericThemeWordForTheme(theme, c.answer)
          ),
          84
        );
        return out.slice(0, 180);
      })()
    : rawPool;
if (n === 11) {
  cspBankAuditRejectedBySet(
    cspBankAuditReport,
    "final-pool-selection",
    basePool.map((candidate) => candidate.answer),
    pool.map((candidate) => candidate.answer),
    "cap-or-pool-truncation"
  );
}
cspBankAuditSetDistribution(
  cspBankAuditReport,
  "pool-after-final-selection",
  pool.map((candidate) => candidate.answer)
);
cspBankAuditReport.distributions.legacyPoolDistribution =
  cspBankAuditCandidateDistribution(pool);

console.warn("[generate-crossword] ok: pool", {
  attempt,
  pool: pool.length,
  lenCount: Object.fromEntries(
    pool.reduce((acc, c) => {
      acc.set(c.answer.length, (acc.get(c.answer.length) ?? 0) + 1);
      return acc;
    }, new Map<number, number>())
  ),
      });
      lastAttemptPool = pool;
      const seed = (theme.length * 2654435761 + n * 1013 + attempt * 9176) >>> 0;
      let cspBuilt: { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null = null;
      const cspTopUpCandidates: WordCandidate[] = [];
      if (
        csp11Enabled &&
        !csp11Attempted &&
        Date.now() < deadlineMs - 12_000
      ) {
        csp11Attempted = true;
        const cspStartedAt = Date.now();
        console.warn("[generate-crossword] csp11 config", {
          enabled: true,
          diagnosticOnly: csp11DiagnosticOnly,
          theme,
          language,
          candidateCount: cspCandidateReservoir.candidates.length,
          deadlineRemainingMs: deadlineMs - Date.now(),
        });
        cspDiagnosticLog("start", {
          theme,
          language,
          attempt,
          elapsedMs: Date.now() - t0,
          reservoirCount: cspCandidateReservoir.candidates.length,
          diagnosticOnly: csp11DiagnosticOnly,
          totalBudgetMs: csp11DiagnosticOnly ? csp11DiagnosticBudgetMs : Math.min(24_000, deadlineMs - Date.now()),
        });
        cspBankAuditSetDistribution(
          cspBankAuditReport,
          "candidates-sent-to-csp-adapter",
          cspCandidateReservoir.candidates.map((candidate) => candidate.answer)
        );
        const cspAttemptDeadlineMs = csp11DiagnosticOnly
          ? Math.min(deadlineMs - 1_000, Date.now() + csp11DiagnosticBudgetMs)
          : Math.min(deadlineMs - 12_000, Date.now() + 24_000);
        const cspResult = await buildCspCrossword11ForEndpoint({
          theme,
          language,
          candidates: cspCandidateReservoir.candidates.map((candidate) => ({
            answer: candidate.answer,
            thematic: candidate.thematic,
            source: candidate.source,
          })),
          seed,
          deadlineMs: cspAttemptDeadlineMs,
          hybrid: hybridCspCandidateReservoir
            ? {
                enabled: true,
                candidates: hybridCspCandidateReservoir.candidates,
                minThematicEntries: 8,
                targetThematicEntries: 10,
                thematicCountsByLength: hybridCspCandidateReservoir.thematicCountsByLength,
                supportCountsByLength: hybridCspCandidateReservoir.supportCountsByLength,
              }
            : undefined,
          diagnosticLog: (event) => {
            cspDiagnosticLog(event.stage, {
              theme,
              language,
              attempt,
              ...event.data,
            });
            if (event.stage.startsWith("hybrid-")) {
              cspHybridDiagnosticLog(event.stage.replace(/^hybrid-/, ""), {
                theme,
                language,
                attempt,
                ...event.data,
              });
            }
            if (event.stage === "search-profile") {
              cspSearchProfileLog({
                theme,
                language,
                attempt,
                ...event.data,
              });
              const profile = event.data.profile as
                | {
                    searchCausality?: {
                      summary?: unknown;
                      depthProfile?: unknown;
                      slotRankings?: unknown;
                      earlyDecisionRankings?: unknown;
                      candidateRankings?: unknown;
                      wipeoutRankings?: unknown;
                      branchingDiagnostics?: unknown;
                      valueOrderingDiagnostics?: unknown;
                      instrumentation?: unknown;
                    };
                  }
                | undefined;
              const searchCausality = profile?.searchCausality;
              if (searchCausality) {
                cspSearchCausalityLog({
                  theme,
                  language,
                  attempt,
                  phase: event.data.phase,
                  summary: searchCausality.summary,
                  depthProfile: searchCausality.depthProfile,
                  slotRankings: searchCausality.slotRankings,
                  earlyDecisionRankings: searchCausality.earlyDecisionRankings,
                  candidateRankings: searchCausality.candidateRankings,
                  instrumentation: searchCausality.instrumentation,
                });
                cspWipeoutCausalityLog({
                  theme,
                  language,
                  attempt,
                  phase: event.data.phase,
                  wipeoutRankings: searchCausality.wipeoutRankings,
                });
                cspBranchingDiagnosticLog({
                  theme,
                  language,
                  attempt,
                  phase: event.data.phase,
                  branchingDiagnostics: searchCausality.branchingDiagnostics,
                });
                cspValueOrderingDiagnosticLog({
                  theme,
                  language,
                  attempt,
                  phase: event.data.phase,
                  valueOrderingDiagnostics: searchCausality.valueOrderingDiagnostics,
                });
              }
            }
          },
          audit: (event) => {
            cspBankAuditLog(`csp-${event.stage}`, event.data);
            if (event.stage === "adapted-candidates") {
              const stats = event.data.stats as
                | {
                    totalByLength?: Record<string | number, number>;
                    rejectedByReason?: Record<string, number>;
                  }
                | undefined;
              if (stats?.totalByLength) {
                cspBankAuditReport.distributions["csp-adapter-output"] = Object.fromEntries(
                  Object.entries(stats.totalByLength).map(([key, value]) => [String(key), value])
                );
              }
              if (stats?.rejectedByReason) {
                cspBankAuditReport.cspAdapterRejectedByReason = {
                  ...cspBankAuditReport.cspAdapterRejectedByReason,
                  ...stats.rejectedByReason,
                };
              }
              cspBankAuditReport.cspCandidateCount =
                typeof event.data.cspCandidateCount === "number"
                  ? event.data.cspCandidateCount
                  : cspBankAuditReport.cspCandidateCount;
            }
            if (event.stage === "solve-diagnostics") {
              const requested = event.data.requestedTopUpByLength as Record<string | number, number> | undefined;
              if (requested) {
                cspBankAuditReport.cspRequestedTopUpByLength = Object.fromEntries(
                  Object.entries(requested).map(([key, value]) => [String(key), value])
                );
              }
              const attempts = Array.isArray(event.data.attempts) ? event.data.attempts : [];
              cspBankAuditReport.cspDomainDiagnostics = attempts;
              const firstMissing = attempts.find(
                (item): item is { missingByLength: Record<string | number, number> } =>
                  typeof item === "object" &&
                  item !== null &&
                  Object.keys((item as { missingByLength?: Record<string | number, number> }).missingByLength ?? {}).length > 0
              );
              if (firstMissing) {
                cspBankAuditReport.cspMissingLengths = Object.fromEntries(
                  Object.entries(firstMissing.missingByLength).map(([key, value]) => [String(key), value])
                );
              } else {
                cspBankAuditReport.cspMissingLengths = {};
              }
            }
            if (event.stage === "topup-returned") {
              const returnedByLength = event.data.returnedByLength as Record<string | number, number> | undefined;
              if (returnedByLength) {
                const afterCspTopUp = cspBankAuditReport.distributions["after-csp-topup"] ?? {};
                cspBankAuditMergeCounts(afterCspTopUp, returnedByLength);
                cspBankAuditReport.distributions["after-csp-topup"] = afterCspTopUp;
              }
            }
          },
          topUpByLength:
            client && Date.now() < deadlineMs - 28_000
              ? async ({ requestedByLength, existingAnswers, attempt: cspTopUpAttempt }) => {
                  let rawCspTopUpText = "";
                  const topUp = await requestCspLengthTopUpAnswers11({
                    theme,
                    language,
                    existingAnswers,
                    requestedByLength,
                    attempt: cspTopUpAttempt,
                    completeJson: async (prompt) => {
                      const completion = await client.chat.completions.create({
                        model: ANSWERBANK_SEARCH_MODEL,
                        temperature: 0.1,
                        max_tokens: 1400,
                        response_format: { type: "json_object" },
                        messages: [
                          { role: "system", content: "Return ONLY valid JSON. No extra text." },
                          { role: "user", content: prompt },
                        ],
                      });
                      rawCspTopUpText = completion.choices?.[0]?.message?.content ?? "";
                      return rawCspTopUpText;
                    },
                  });
                  cspBankAuditMergeCounts(
                    cspBankAuditReport.cspTopUpRawByLength,
                    cspBankAuditDistribution(topUp.candidates.map((candidate) => candidate.answer))
                  );
                  cspBankAuditMergeCounts(cspBankAuditReport.cspTopUpRejectedByLength, {});
                  cspBankAuditLog("csp-topup-raw", {
                    attempt: cspTopUpAttempt,
                    requestedByLength,
                    rawTextLength: rawCspTopUpText.length,
                    parsedCount: topUp.candidates.length,
                    parsedByLength: cspBankAuditDistribution(topUp.candidates.map((candidate) => candidate.answer)),
                    rejectedByReason: topUp.rejectedByReason,
                    sample: topUp.candidates.slice(0, 20).map((candidate) => candidate.answer),
                  });
                  const validated = await validateThematicAnswers({
                    client,
                    theme,
                    language,
                    size: n,
                    answers: topUp.candidates.map((candidate) => candidate.answer),
                    attempt: cspTopUpAttempt,
                  });
                  const validatedSet = new Set(validated);
                  const acceptedTopUps = topUp.candidates
                    .filter((candidate) => validatedSet.has(candidate.answer))
                    .map((candidate): WordCandidate => ({
                      answer: candidate.answer,
                      thematic: true,
                      source: "model",
                    }));
                  cspBankAuditMergeCounts(
                    cspBankAuditReport.cspTopUpAcceptedByLength,
                    cspBankAuditCandidateDistribution(acceptedTopUps)
                  );
                  cspBankAuditRejectedBySet(
                    cspBankAuditReport,
                    "csp-topup-validation",
                    topUp.candidates.map((candidate) => candidate.answer),
                    acceptedTopUps.map((candidate) => candidate.answer),
                    "failed-thematic-validation"
                  );
                  cspBankAuditMergeCounts(
                    cspBankAuditReport.cspTopUpRejectedByLength,
                    cspBankAuditDistribution(
                      topUp.candidates
                        .filter((candidate) => !validatedSet.has(candidate.answer))
                        .map((candidate) => candidate.answer)
                    )
                  );
                  cspBankAuditLog("csp-topup-accepted", {
                    attempt: cspTopUpAttempt,
                    acceptedCount: acceptedTopUps.length,
                    acceptedByLength: cspBankAuditCandidateDistribution(acceptedTopUps),
                    rejectedByReason: cspBankAuditReport.rejectedByStage["csp-topup-validation"] ?? {},
                    sample: acceptedTopUps.slice(0, 20).map((candidate) => candidate.answer),
                  });
                  for (const candidate of acceptedTopUps) {
                    cspTopUpCandidates.push(candidate);
                    thematicKeepSet.add(candidate.answer);
                    publishThemeSet.add(candidate.answer);
                    placementThemeSet.add(candidate.answer);
                  }
                  return acceptedTopUps;
                }
              : undefined,
          topUpByConstraints:
            client && Date.now() < deadlineMs - 28_000
              ? async ({ requests, existingAnswers, attempt: cspTopUpAttempt }) => {
                  let rawCspTopUpText = "";
                  const topUp = await requestCspConstraintTopUpAnswers11({
                    theme,
                    language,
                    excludedAnswers: existingAnswers,
                    requests,
                    attempt: cspTopUpAttempt,
                    completeJson: async (prompt) => {
                      const completion = await client.chat.completions.create({
                        model: ANSWERBANK_SEARCH_MODEL,
                        temperature: 0.1,
                        max_tokens: 1600,
                        response_format: { type: "json_object" },
                        messages: [
                          { role: "system", content: "Return ONLY valid JSON. No extra text." },
                          { role: "user", content: prompt },
                        ],
                      });
                      rawCspTopUpText = completion.choices?.[0]?.message?.content ?? "";
                      return rawCspTopUpText;
                    },
                  });
                  cspBankAuditMergeCounts(
                    cspBankAuditReport.cspTopUpRawByLength,
                    cspBankAuditDistribution(topUp.candidates.map((candidate) => candidate.answer))
                  );
                  cspBankAuditLog("csp-constraint-topup-raw", {
                    attempt: cspTopUpAttempt,
                    requests,
                    rawTextLength: rawCspTopUpText.length,
                    parsedCount: topUp.candidates.length,
                    parsedByLength: cspBankAuditDistribution(topUp.candidates.map((candidate) => candidate.answer)),
                    rejectedByReason: topUp.rejectedByReason,
                    acceptedByRequestId: topUp.acceptedByRequestId,
                    sample: topUp.candidates.slice(0, 20).map((candidate) => candidate.answer),
                  });
                  const validated = await validateThematicAnswers({
                    client,
                    theme,
                    language,
                    size: n,
                    answers: topUp.candidates.map((candidate) => candidate.answer),
                    attempt: cspTopUpAttempt,
                  });
                  const validatedSet = new Set(validated);
                  const acceptedTopUps = topUp.candidates
                    .filter((candidate) => validatedSet.has(candidate.answer))
                    .map((candidate): WordCandidate => ({
                      answer: candidate.answer,
                      thematic: true,
                      source: "model",
                    }));
                  cspBankAuditMergeCounts(
                    cspBankAuditReport.cspTopUpAcceptedByLength,
                    cspBankAuditCandidateDistribution(acceptedTopUps)
                  );
                  cspBankAuditRejectedBySet(
                    cspBankAuditReport,
                    "csp-constraint-topup-validation",
                    topUp.candidates.map((candidate) => candidate.answer),
                    acceptedTopUps.map((candidate) => candidate.answer),
                    "failed-thematic-validation"
                  );
                  cspBankAuditMergeCounts(
                    cspBankAuditReport.cspTopUpRejectedByLength,
                    cspBankAuditDistribution(
                      topUp.candidates
                        .filter((candidate) => !validatedSet.has(candidate.answer))
                        .map((candidate) => candidate.answer)
                    )
                  );
                  cspBankAuditLog("csp-constraint-topup-accepted", {
                    attempt: cspTopUpAttempt,
                    acceptedCount: acceptedTopUps.length,
                    acceptedByLength: cspBankAuditCandidateDistribution(acceptedTopUps),
                    rejectedByReason: cspBankAuditReport.rejectedByStage["csp-constraint-topup-validation"] ?? {},
                    sample: acceptedTopUps.slice(0, 20).map((candidate) => candidate.answer),
                  });
                  for (const candidate of acceptedTopUps) {
                    cspTopUpCandidates.push(candidate);
                    thematicKeepSet.add(candidate.answer);
                    publishThemeSet.add(candidate.answer);
                    placementThemeSet.add(candidate.answer);
                  }
                  return acceptedTopUps;
                }
              : undefined,
        });
        lastCspAttemptMeta = cspResult.ok
          ? cspResult.meta
          : {
              attempted: true,
              reason: cspResult.reason,
              elapsedMs: Date.now() - cspStartedAt,
              ...cspResult.meta,
            };
        if (cspResult.ok) {
          for (const answer of cspResult.usedAnswers) {
            const sourceCandidate = [...cspCandidateReservoir.candidates, ...cspTopUpCandidates].find(
              (candidate) => candidate.answer === answer
            );
            if (sourceCandidate?.thematic) {
              thematicKeepSet.add(answer);
              publishThemeSet.add(answer);
              placementThemeSet.add(answer);
            }
          }
          cspBuilt = {
            grid: cspResult.grid,
            usedAnswers: cspResult.usedAnswers,
            meta: {
              ...cspResult.meta,
              cspAttempt: lastCspAttemptMeta,
            },
          };
          console.warn("[generate-crossword] csp11 accepted", {
            patternId: cspResult.patternId,
            entries: cspResult.usedAnswers.length,
            nodesVisited: cspResult.meta.nodesVisited,
            backtracks: cspResult.meta.backtracks,
            cspElapsedMs: cspResult.meta.cspElapsedMs,
          });
        } else {
          console.warn("[generate-crossword] csp11 failed; falling back to legacy", {
            reason: cspResult.reason,
            elapsedMs: Date.now() - cspStartedAt,
            meta: cspResult.meta,
          });
          cspDiagnosticLog("failed", {
            theme,
            language,
            attempt,
            elapsedMs: Date.now() - cspStartedAt,
            failureReason: cspResult.reason,
            diagnosticOnly: csp11DiagnosticOnly,
          });
          if (csp11DiagnosticOnly) {
            const diagnostic =
              typeof cspResult.meta.diagnostic === "object" && cspResult.meta.diagnostic !== null
                ? (cspResult.meta.diagnostic as Record<string, unknown>)
                : {};
            const afterCspTopUpDistribution = cspBankAuditDistribution(
              [...cspCandidateReservoir.candidates, ...cspTopUpCandidates].map((candidate) => candidate.answer)
            );
            return NextResponse.json(
              {
                error: "csp-diagnostic-failed",
                theme,
                language,
                size: n,
                diagnostic: {
                  failureReason: cspResult.reason,
                  reservoirCountsByLength: cspCandidateReservoir.distributionByLength,
                  postTopUpReservoirCountsByLength:
                    diagnostic.postTopUpReservoirCountsByLength ?? afterCspTopUpDistribution,
                  patternAttempts: cspResult.meta.patternDiagnostics ?? diagnostic.patternAttempts ?? [],
                  elapsedMs: Date.now() - cspStartedAt,
                  ...diagnostic,
                  cspAttemptMeta: {
                    attempted: true,
                    reason: cspResult.reason,
                    source: cspResult.meta.source,
                    algorithm: cspResult.meta.algorithm,
                    cspElapsedMs: cspResult.meta.cspElapsedMs,
                    cspTopUpCalls: cspResult.meta.cspTopUpCalls,
                    cspConstraintTopUpCalls: cspResult.meta.cspConstraintTopUpCalls,
                  },
                  bankAudit: {
                    rawPoolDistribution: cspBankAuditReport.distributions.rawPoolDistribution,
                    cspReservoirDistribution: cspBankAuditReport.distributions.cspReservoirDistribution,
                    legacyPoolDistribution: cspBankAuditReport.distributions.legacyPoolDistribution,
                    cspAdapterDistribution: cspBankAuditReport.distributions["csp-adapter-output"],
                    afterCspTopUpDistribution,
                  },
                },
              },
              { status: 422 }
            );
          }
        }
      }
      if (csp11Enabled) {
        cspBankAuditReport.distributions.afterCspTopUp = cspBankAuditDistribution(
          [...cspCandidateReservoir.candidates, ...cspTopUpCandidates].map((candidate) => candidate.answer)
        );
        cspBankAuditLog("final report", {
          ...cspBankAuditReport,
          rejectedByStage: cspBankAuditReport.rejectedByStage,
          rejectedSamplesByStage: cspBankAuditReport.rejectedSamplesByStage,
          samplesByStage: cspBankAuditReport.samplesByStage,
        });
      }
      if (!cspBuilt && n === 11 && process.env.ENABLE_EARLY_OPENING_11 === "1") {
        const earlyOpeningThematicSet = new Set<string>();
        const earlyOpeningCoreThematicSet = new Set<string>();

        for (const candidate of pool) {
          if (candidate.source === "filler") continue;
          if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
          if (LOW_VALUE_CONTEXTLESS_ANSWERS.has(candidate.answer)) continue;

          const strong =
            placementCoreThemeSet.has(candidate.answer) ||
            thematicKeepSet.has(candidate.answer) ||
            hasStrongThematicClueSupport({
              theme,
              answer: candidate.answer,
              language,
              note: notesByAnswer.get(candidate.answer),
            });

          if (!strong && candidate.source === "support") continue;
          earlyOpeningThematicSet.add(candidate.answer);
          if (!CONTEXTUAL_SUPPORT_ANSWERS.has(candidate.answer)) {
            earlyOpeningCoreThematicSet.add(candidate.answer);
          }
        }

        const earlyOpening = await tryOpeningDeterministic11({
          client,
          theme,
          language,
          candidates: pool,
          notesByAnswer,
          thematicSet: earlyOpeningThematicSet,
          coreThematicSet: earlyOpeningCoreThematicSet,
          seed: (seed ^ 0x6d2b79f5) >>> 0,
          targetEntries: minPublishEntriesForSize(n),
          deadlineMs: Date.now() + 18_000,
          source: "fallback-fast-opening-deterministic-11",
          attempt,
          extraMeta: {
            reason: "Published from validated opening builder before expensive rescue passes.",
          },
        });

        if (earlyOpening) {
          return publishCrosswordResponse(earlyOpening satisfies Crossword);
        }
      }
      const buildDeadlineMs = n === 11 ? Date.now() + 25_000 : Date.now() + 8_000;
      const localBuildDeadlineMs = n === 11 ? Date.now() + 25_000 : Date.now() + 8_000;

      const dictionaryPatternLayoutCandidate =
        !cspBuilt && n === 11 && process.env.ENABLE_DICTIONARY_PATTERN_11 === "1"
          ? constructPatternCrossword11({
              theme,
              size: n,
              candidates: pool,
              seed: (seed ^ 0x13198a2e) >>> 0,
              deadlineMs: Math.min(deadlineMs - 5_000, Date.now() + 35_000),
            })
          : null;
      const dictionaryPatternThematicCount =
        typeof dictionaryPatternLayoutCandidate?.meta?.thematicCount === "number"
          ? dictionaryPatternLayoutCandidate.meta.thematicCount
          : 0;
      const dictionaryPatternLayout =
        dictionaryPatternLayoutCandidate &&
        dictionaryPatternThematicCount >= minCoreThematicEntriesForPublish(
          n,
          dictionaryPatternLayoutCandidate.usedAnswers.length
        )
          ? dictionaryPatternLayoutCandidate
          : null;
      if (dictionaryPatternLayoutCandidate && !dictionaryPatternLayout) {
        console.warn("[generate-crossword] conventional pattern rejected for weak theme coverage", {
          entries: dictionaryPatternLayoutCandidate.usedAnswers.length,
          thematicEntries: dictionaryPatternThematicCount,
        });
      }
      let earlyValidatedLayout: { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null =
        dictionaryPatternLayout;
      if (
        !cspBuilt &&
        n === 11 &&
        allowModelRescueFor11 &&
        process.env.OPENAI_EARLY_LAYOUT_11 !== "0" &&
        Date.now() < deadlineMs - 25_000
      ) {
        {
          try {
            const generatedFixedGrid = await requestGeneratedPatternGrid11({
              client,
              theme,
              language,
              size: n,
              attempt,
            });
            if (generatedFixedGrid) {
              for (const [answer, note] of generatedFixedGrid.notes) {
                notesByAnswer.set(answer, note);
              }
              for (const answer of generatedFixedGrid.thematicAnswers) {
                thematicKeepSet.add(answer);
                publishThemeSet.add(answer);
                placementThemeSet.add(answer);
              }
              earlyValidatedLayout = {
                grid: generatedFixedGrid.grid,
                usedAnswers: generatedFixedGrid.usedAnswers,
                meta: generatedFixedGrid.meta,
              };
            }
          } catch (error: unknown) {
            console.warn("[generate-crossword] generated fixed pattern failed; continuing local build", {
              attempt,
              msg: errorSummary(error),
            });
          }
        }

        if (!earlyValidatedLayout) {
          try {
            earlyValidatedLayout = await requestValidatedPatternAssignment11({
              client,
              theme,
              language,
              size: n,
              pool,
              themeSet: publishThemeSet,
            });
          } catch (error: unknown) {
            console.warn("[generate-crossword] early pattern assignment failed; continuing local build", {
              attempt,
              msg: errorSummary(error),
            });
          }
        }

        if (earlyValidatedLayout) {
          try {
            const contextualAnswers = earlyValidatedLayout.usedAnswers.filter(
              (answer) => !thematicKeepSet.has(answer)
            );
            if (contextualAnswers.length > 0) {
              const validatedContextual = await validateThematicAnswers({
                client,
                theme,
                language,
                size: n,
                answers: contextualAnswers,
                attempt,
              });
              const validatedContextualSet = new Set(validatedContextual);
              if (contextualAnswers.some((answer) => !validatedContextualSet.has(answer))) {
                console.warn("[generate-crossword] pattern assignment contextual validation rejected", {
                  attempt,
                  contextualAnswers,
                  validatedContextual,
                });
                earlyValidatedLayout = null;
              } else {
                for (const answer of validatedContextual) {
                  thematicKeepSet.add(answer);
                  publishThemeSet.add(answer);
                  placementThemeSet.add(answer);
                }
              }
            }
          } catch (error: unknown) {
            console.warn("[generate-crossword] pattern contextual validation failed", {
              attempt,
              msg: errorSummary(error),
            });
            earlyValidatedLayout = null;
          }
        }

        if (!earlyValidatedLayout) {
          try {
            earlyValidatedLayout = await requestValidatedGridProposal({
              client,
              theme,
              language,
              size: n,
              pool,
              themeSet: publishThemeSet,
            });
          } catch (error: unknown) {
            console.warn("[generate-crossword] early validated grid proposal failed; continuing local build", {
              attempt,
              msg: errorSummary(error),
            });
          }
        }

        if (!earlyValidatedLayout) {
          try {
            earlyValidatedLayout = await requestValidatedLayoutProposal({
              client,
              theme,
              language,
              size: n,
              pool,
              themeSet: publishThemeSet,
            });
          } catch (error: unknown) {
            console.warn("[generate-crossword] early model layout failed; continuing local build", {
              attempt,
              msg: errorSummary(error),
            });
          }
        }
      }

      const compactBuildDeadlineMs = n === 11 ? Math.min(localBuildDeadlineMs, Date.now() + 15_000) : Date.now();
      const compactBuiltOptions =
        !cspBuilt && n === 11
          ? Array.from({ length: 2 }, (_, idx) => idx)
              .map((idx) => {
                if (Date.now() >= compactBuildDeadlineMs - 500) return null;
                const compactPool =
                  idx === 0
                    ? pool.filter((candidate) => candidate.source !== "filler")
                    : idx === 1
                    ? pool.filter(
                        (candidate) =>
                          candidate.thematic &&
                          publishThemeSet.has(candidate.answer) &&
                          candidate.source !== "support"
                      )
                    : idx === 2
                    ? pool.filter(
                        (candidate) =>
                          candidate.thematic &&
                          publishThemeSet.has(candidate.answer)
                      )
                    : idx === 3
                    ? pool.filter(
                        (candidate) =>
                          candidate.thematic ||
                          (candidate.source === "support" &&
                            hasStrongThematicClueSupport({
                              theme,
                              answer: candidate.answer,
                              language,
                              note: notesByAnswer.get(candidate.answer),
                            }))
                      )
                    : pool.filter((candidate) => candidate.source !== "filler");

                if (compactPool.length < minPublishEntriesForSize(n)) return null;
                return constructCompactPatternCrossword11({
                  theme,
                  size: n,
                  seed: (seed ^ 0x7f4a7c15 ^ Math.imul(idx + 1, 0x9e3779b9)) >>> 0,
                  candidates: compactPool,
                  deadlineMs: Math.min(compactBuildDeadlineMs, Date.now() + 7_000),
                });
              })
              .filter((candidate): candidate is { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } =>
                Boolean(candidate)
              )
          : [];

      const strictBuilt =
        !cspBuilt && n === 11 && compactBuiltOptions.length === 0 && Date.now() < localBuildDeadlineMs - 1500
          ? constructStrictCrossword11({
              theme,
              size: n,
              seed,
              candidates: pool,
              deadlineMs: localBuildDeadlineMs,
            })
          : null;

      const freeformBuildDeadlineMs = Date.now() + (n === 11 ? 60_000 : 8_000);
      const corePublishThemeSet =
        n === 11
          ? buildCoreThematicSetFromPool({
              pool,
              trustedThematicSet: thematicKeepSet,
              theme,
              language,
              notesByAnswer,
            })
          : publishThemeSet;
      const freeformBuiltOptions =
        !cspBuilt && n === 11
          ? !strictBuilt && compactBuiltOptions.length === 0
            ? Array.from({ length: 8 }, (_, idx) => idx)
                .map((idx) => {
                  if (Date.now() >= freeformBuildDeadlineMs - 1500) return null;

                  const isCommonFreeformCandidate = (candidate: WordCandidate) => {
                    if (candidate.answer.length < minEntryLenForSize(n) || candidate.answer.length > n) return false;
                    if (!ASCII_A_TO_Z.test(candidate.answer)) return false;
                    if (isForbiddenPublishAnswer(candidate.answer)) return false;
                    if (
                      !isPublishableAnswerForTheme({
                        theme,
                        answer: candidate.answer,
                        language,
                        size: n,
                        note: notesByAnswer.get(candidate.answer),
                        allowContextualGeneric: candidate.source === "support" || candidate.thematic,
                      })
                    ) {
                      return false;
                    }
                    if (isOverGenericThemeWordForTheme(theme, candidate.answer)) return false;
                    return true;
                  };

                  const coreFreeformPool = pool.filter(
                    (candidate) =>
                      isCommonFreeformCandidate(candidate) &&
                      candidate.thematic &&
                      publishThemeSet.has(candidate.answer) &&
                      candidate.source !== "support"
                  );
                  const coreFreeformAnswerSet = new Set(coreFreeformPool.map((candidate) => candidate.answer));
                  const hybridFreeformPool = pool.filter(
                    (candidate) =>
                      isCommonFreeformCandidate(candidate) &&
                      (coreFreeformAnswerSet.has(candidate.answer) ||
                        (candidate.thematic &&
                          publishThemeSet.has(candidate.answer)) ||
                        (candidate.source === "support" &&
                          hasStrongThematicClueSupport({
                            theme,
                            answer: candidate.answer,
                            language,
                            note: notesByAnswer.get(candidate.answer),
                          })))
                  );
                  const broadFreeformPool = pool.filter(isCommonFreeformCandidate);
                  const freeformPool =
                    idx === 0 && broadFreeformPool.length >= minPublishEntriesForSize(n)
                      ? broadFreeformPool
                    : idx < 3 && hybridFreeformPool.length >= minPublishEntriesForSize(n)
                      ? hybridFreeformPool
                    : idx < 5 && coreFreeformPool.length >= minPublishEntriesForSize(n)
                      ? coreFreeformPool
                      : broadFreeformPool;

                  if (freeformPool.length < minPublishEntriesForSize(n)) return null;

                  return constructFreeformCrossword({
                    size: n,
                    seed: (seed ^ 0x517cc1b7 ^ Math.imul(idx + 1, 0x85ebca6b)) >>> 0,
                    candidates: freeformPool,
                    deadlineMs: freeformBuildDeadlineMs,
                    maxPlacedWords: 42,
                    maxBuilds: 96,
                  });
                })
                .filter((candidate): candidate is { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } =>
                  Boolean(candidate)
                )
            : []
          : !strictBuilt
          ? Array.from({ length: 10 }, (_, idx) => idx)
              .map((idx) =>
                Date.now() < freeformBuildDeadlineMs - 1500
                  ? constructFreeformCrossword({
                      size: n,
                      seed: (seed ^ 0x9e3779b9 ^ Math.imul(idx + 1, 0x85ebca6b)) >>> 0,
                      candidates: pool,
                      deadlineMs: freeformBuildDeadlineMs,
                      maxPlacedWords: 42,
                    })
                  : null
              )
              .filter((candidate): candidate is { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } =>
                Boolean(candidate)
              )
          : [];
      let built =
        n === 11
          ? cspBuilt ?? [earlyValidatedLayout, ...compactBuiltOptions, ...freeformBuiltOptions, strictBuilt]
              .filter((candidate): candidate is { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } =>
                Boolean(candidate)
              )
              .map((candidate) => {
                const pruned = pruneWeakEntriesPreservingCrosses(
                  candidate.grid,
                  minEntryLenForSize(n),
                  minPublishEntriesForSize(n)
                );
                if (!pruned) return candidate;
                return {
                  ...candidate,
                  grid: pruned.grid,
                  usedAnswers: Array.from(
                    new Set(pruned.derived.map((entry) => entry.answer))
                  ),
                  meta: {
                    ...candidate.meta,
                    weakEntriesPruned: true,
                    prunedEntryCount: pruned.derived.length,
                  },
                };
              })
              .sort((a, b) => {
                const score = (candidate: { grid: string[][]; usedAnswers: string[] }) => {
                  const scoreGrid = blockForbiddenAnswerRuns(
                    candidate.grid,
                    minEntryLenForSize(n)
                  );
                  const derived = deriveEntriesFromGrid(scoreGrid, minEntryLenForSize(n));
                  const crossed = crossedEntryStats(scoreGrid, derived, minEntryLenForSize(n));
                  const entryCrossings = entryCrossingStats(scoreGrid, derived, minEntryLenForSize(n));
                  const checked = checkedCellStats(scoreGrid, minEntryLenForSize(n));
                  const themeCount = derived.filter((entry) => publishThemeSet.has(entry.answer)).length;
                  const coreThemeCount = derived.filter((entry) => corePublishThemeSet.has(entry.answer)).length;
                  const nonThemeCount = derived.length - themeCount;
                  const genericContextCount = derived.length - coreThemeCount;
                  const genericAnyCount = derived.filter((entry) =>
                    isOverGenericThemeWordForTheme(theme, entry.answer)
                  ).length;
                  const invalidAnswers = derived.filter((entry) => {
                    if (MODEL_FRAGMENT_ANSWERS.has(entry.answer)) return true;
                    if (BANNED_ANSWERS.has(entry.answer) && !CONTEXTUAL_GENERIC_ANSWERS.has(entry.answer)) return true;
                    if (isLikelyBadAnswer(entry.answer) && !ALWAYS_ALLOW_ANSWERS.has(entry.answer)) return true;
                    return false;
                  }).length;
                  const shortRunPenalty = hasShortLetterRuns(scoreGrid, minEntryLenForSize(n)) ? 50000 : 0;
                  const hasPublishableEntryCount = derived.length >= minPublishEntriesForSize(n);
                  const hasPreferredEntryCount = derived.length >= desiredPublishEntriesForSize(n);
                  const structurallyClean =
                    invalidAnswers === 0 &&
                    shortRunPenalty === 0 &&
                    entryCrossings.weakEntries.length === 0 &&
                    checked.ratio >= 0.25;
                  return (
                    (hasPreferredEntryCount ? 3_000_000 : 0) +
                    (hasPublishableEntryCount ? 1_500_000 : 0) +
                    (hasPublishableEntryCount && structurallyClean ? 1_500_000 : 0) +
                    derived.length * 22000 +
                    Math.min(derived.length, desiredPublishEntriesForSize(n)) * 5000 +
                    coreThemeCount * 30000 +
                    themeCount * 9000 +
                    crossed.crossed * 4000 +
                    checked.ratio * 3000 -
                    nonThemeCount * 5000 -
                    genericContextCount * 9000 -
                    genericAnyCount * 4500 -
                    entryCrossings.weakEntries.length * (hasPublishableEntryCount ? 100000 : 10000) -
                    invalidAnswers * 120000 -
                    shortRunPenalty
                  );
                };
                return score(b) - score(a);
              })[0] ?? null
          : constructFreeformCrossword({
              size: n,
              seed,
              candidates: pool,
              deadlineMs: buildDeadlineMs,
            });

      const allowModelLayoutGridUpgradeFor11 =
        !cspBuilt && n === 11 && allowModelRescueFor11 && process.env.OPENAI_11X11_MODEL_LAYOUT_GRID_UPGRADE === "1";

      if (allowModelLayoutGridUpgradeFor11 && built) {
        const builtDerivedForLayoutCheck = deriveEntriesFromGrid(
          built.grid,
          minEntryLenForSize(n)
        );
        const builtEntryCrossingsForLayoutCheck = entryCrossingStats(
          built.grid,
          builtDerivedForLayoutCheck,
          minEntryLenForSize(n)
        );
        if (
          builtDerivedForLayoutCheck.length < minPublishEntriesForSize(n) ||
          builtEntryCrossingsForLayoutCheck.weakEntries.length > 0
        ) {
          let layoutUpgrade: { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null = null;
          try {
            layoutUpgrade = await requestValidatedLayoutProposal({
              client,
              theme,
              language,
              size: n,
              pool,
              themeSet: publishThemeSet,
            });
          } catch (error: unknown) {
            console.warn("[generate-crossword] model layout upgrade failed; keeping local build", {
              attempt,
              entries: builtDerivedForLayoutCheck.length,
              msg: errorSummary(error),
            });
          }
          if (layoutUpgrade) {
            const layoutUpgradeDerived = deriveEntriesFromGrid(
              layoutUpgrade.grid,
              minEntryLenForSize(n)
            );
            if (layoutUpgradeDerived.length > builtDerivedForLayoutCheck.length) {
              built = {
                ...layoutUpgrade,
                meta: {
                  ...layoutUpgrade.meta,
                  upgradedWeakLocalBuild: true,
                  previousEntries: builtDerivedForLayoutCheck.length,
                },
              };
            }
          }

          if (builtDerivedForLayoutCheck.length < minPublishEntriesForSize(n)) {
            let gridUpgrade: { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null = null;
            try {
              gridUpgrade = await requestValidatedGridProposal({
                client,
                theme,
                language,
                size: n,
                pool,
                themeSet: publishThemeSet,
              });
            } catch (error: unknown) {
              console.warn("[generate-crossword] model grid upgrade failed; keeping local build", {
                attempt,
                entries: builtDerivedForLayoutCheck.length,
                msg: errorSummary(error),
              });
            }
            if (gridUpgrade) {
              const gridUpgradeDerived = deriveEntriesFromGrid(
                gridUpgrade.grid,
                minEntryLenForSize(n)
              );
              const currentDerived = deriveEntriesFromGrid(
                built.grid,
                minEntryLenForSize(n)
              );
              if (gridUpgradeDerived.length > currentDerived.length) {
                built = {
                  ...gridUpgrade,
                  meta: {
                    ...gridUpgrade.meta,
                    upgradedWeakLocalBuild: true,
                    previousEntries: currentDerived.length,
                  },
                };
              }
            }
          }
        }
      }

      if (!built) {
        let layoutProposal: { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null = null;
        if (allowModelLayoutGridUpgradeFor11) {
          try {
            layoutProposal = await requestValidatedLayoutProposal({
              client,
              theme,
              language,
              size: n,
              pool,
              themeSet: publishThemeSet,
            });
          } catch (error: unknown) {
            console.warn("[generate-crossword] model layout after null builder failed", {
              attempt,
              msg: errorSummary(error),
            });
          }
        }

        if (layoutProposal) {
          console.warn("[generate-crossword] accepted validated model layout after builder null", {
            attempt,
            entries: layoutProposal.usedAnswers.length,
            builder: layoutProposal.meta.builder,
          });
          built = {
            ...layoutProposal,
            meta: {
              ...layoutProposal.meta,
              recoveredFromNullBuilder: true,
            },
          };
        }

        if (!built) {
          let gridProposal: { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null = null;
          if (allowModelLayoutGridUpgradeFor11) {
            try {
              gridProposal = await requestValidatedGridProposal({
                client,
                theme,
                language,
                size: n,
                pool,
                themeSet: publishThemeSet,
              });
            } catch (error: unknown) {
              console.warn("[generate-crossword] model grid after null builder failed", {
                attempt,
                msg: errorSummary(error),
              });
            }
          }

          if (gridProposal) {
            console.warn("[generate-crossword] accepted validated model grid after builder null", {
              attempt,
              entries: gridProposal.usedAnswers.length,
              builder: gridProposal.meta.builder,
            });
            built = {
              ...gridProposal,
              meta: {
                ...gridProposal.meta,
                recoveredFromNullBuilder: true,
              },
            };
          }
        }
      }

      if (!built) {
        if (n === 11) {
          const trustedForNullBuilder = new Set(
            pool
              .filter((candidate) => thematicKeepSet.has(candidate.answer))
              .filter((candidate) => candidate.source !== "filler")
              .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
              .map((candidate) => candidate.answer)
          );
          const rescue = await buildThemeFirstRescueCrossword({
            client,
            theme,
            language,
            size: n,
            pool,
            notesByAnswer,
            trustedThematicSet: trustedForNullBuilder,
            seedBase: (seed ^ 0x7f4a7c15) >>> 0,
          });

          if (rescue) {
          console.warn("[generate-crossword] published null-builder theme-first rescue", {
            attempt,
            entries: rescue.entries.length,
            source: rescue.meta?.source,
          });
            return publishCrosswordResponse(rescue);
          }
        }

        lastBuildIssue = {
          stage: "builder-null",
          attempt,
          pool: pool.length,
          builder: n === 11 ? "pattern/freeform-11x11" : "freeform",
        };
        console.warn("[generate-crossword] skip: builder returned null", {
          attempt,
          builder: n === 11 ? "pattern/freeform-11x11" : "freeform",
        });
        continue;
      }

      const selectedBuilder = typeof built.meta?.builder === "string" ? built.meta.builder : "";
      if (n === 11 && selectedBuilder.startsWith("freeform")) {
        const allowedAnswers = new Set(
          pool
            .filter((c) => c.source !== "filler" || c.answer.length >= 4)
            .map((c) => c.answer)
        );
        const cleaned = rebuildGridFromAllowedEntries(
          built.grid,
          allowedAnswers,
          minEntryLenForSize(n)
        );

        if (cleaned) {
          built.grid = cleaned.grid;
          built.usedAnswers = Array.from(new Set(cleaned.derived.map((e) => e.answer)));
          built.meta = {
            ...built.meta,
            cleanedFreeform11: true,
            cleanedEntryCount: cleaned.derived.length,
          };
        }
      }

      let letterCount =
        built.grid.flat().filter((ch) => ch && ch !== "#").length;

      console.log("[generate-crossword] built stats", {
        hasBuilt: true,
        letterCount,
        usedAnswers: built.usedAnswers?.length ?? 0,
        builder: built.meta?.builder ?? null,
      });

      let derived = deriveEntriesFromGrid(built.grid, minEntryLenForSize(n));
      let checkedStats = checkedCellStats(built.grid, minEntryLenForSize(n));
      let crossedStats = crossedEntryStats(built.grid, derived, minEntryLenForSize(n));
      let entryCrossingStatsForBuilt = entryCrossingStats(built.grid, derived, minEntryLenForSize(n));
      let thematicDerivedCount = derived.filter((e) => publishThemeSet.has(e.answer)).length;
      let coreThematicDerivedCount = derived.filter((e) => corePublishThemeSet.has(e.answer)).length;
      let genericNonThemeCount = derived.reduce(
        (acc, e) => acc + (!publishThemeSet.has(e.answer) && isOverGenericThemeWordForTheme(theme, e.answer) ? 1 : 0),
        0
      );
      let nonThemeCount = derived.reduce(
        (acc, e) => acc + (!publishThemeSet.has(e.answer) ? 1 : 0),
        0
      );
      let genericAnyCount = derived.reduce(
        (acc, e) => acc + (isOverGenericThemeWordForTheme(theme, e.answer) ? 1 : 0),
        0
      );

      const fallbackScore =
        derived.length * 10000 +
        Math.min(derived.length, desiredPublishEntriesForSize(n)) * 2500 +
        Math.max(0, derived.length - minPublishEntriesForSize(n)) * 4500 +
        coreThematicDerivedCount * 18000 +
        thematicDerivedCount * 8000 +
        checkedStats.ratio * 5000 +
        (built.usedAnswers?.length ?? 0) * 1000 +
        letterCount * 10 -
        nonThemeCount * 4500 -
        genericNonThemeCount * 4500 -
        genericAnyCount * 3200 -
        entryCrossingStatsForBuilt.weakEntries.length *
          (derived.length >= minPublishEntriesForSize(n) ? 140000 : 18000);

      if (
        derived.length > 0 &&
        (!bestPartial ||
          (bestPartial.derived.length < minPublishEntriesForSize(n) && derived.length >= minPublishEntriesForSize(n)) ||
          ((bestPartial.derived.length >= minPublishEntriesForSize(n)) === (derived.length >= minPublishEntriesForSize(n)) &&
            fallbackScore > bestPartial.fallbackScore))
      ) {
        bestPartial = {
          built,
          derived,
          pool,
          notesByAnswer,
          trustedThematicSet: new Set(thematicKeepSet),
          attempt,
          fallbackScore,
        };
      }

      let acceptable = isAcceptable(built.grid, derived, publishThemeSet);

      if (
        !acceptable &&
        selectedBuilder !== "csp-pattern-11x11" &&
        n === 11 &&
        derived.length >= minPublishEntriesForSize(n) - 6
      ) {
        const densified = densifyCleanGrid11({
          theme,
          grid: built.grid,
          candidates: pool.filter((candidate) => candidate.source !== "filler"),
          targetEntries: minPublishEntriesForSize(n),
          seed: (seed ^ 0xa24baed5 ^ Math.imul(derived.length + 1, 0x9e3779b9)) >>> 0,
          deadlineMs: Math.min(deadlineMs - 1_000, Date.now() + 14_000),
          pruneWeakEntries: false,
        });

        if (densified && densified.derived.length > derived.length) {
          built = {
            ...built,
            grid: densified.grid,
            usedAnswers: Array.from(new Set(densified.derived.map((entry) => entry.answer))),
            meta: {
              ...built.meta,
              ...densified.meta,
              densifiedBeforeModelRecovery: true,
            },
          };
          letterCount = built.grid.flat().filter((ch) => ch && ch !== "#").length;
          derived = deriveEntriesFromGrid(built.grid, minEntryLenForSize(n));
          checkedStats = checkedCellStats(built.grid, minEntryLenForSize(n));
          crossedStats = crossedEntryStats(built.grid, derived, minEntryLenForSize(n));
          entryCrossingStatsForBuilt = entryCrossingStats(built.grid, derived, minEntryLenForSize(n));
          thematicDerivedCount = derived.filter((e) => publishThemeSet.has(e.answer)).length;
          coreThematicDerivedCount = derived.filter((e) => corePublishThemeSet.has(e.answer)).length;
          genericNonThemeCount = derived.reduce(
            (acc, e) =>
              acc + (!publishThemeSet.has(e.answer) && isOverGenericThemeWordForTheme(theme, e.answer) ? 1 : 0),
            0
          );
          nonThemeCount = derived.reduce((acc, e) => acc + (!publishThemeSet.has(e.answer) ? 1 : 0), 0);
          genericAnyCount = derived.reduce(
            (acc, e) => acc + (isOverGenericThemeWordForTheme(theme, e.answer) ? 1 : 0),
            0
          );
          acceptable = isAcceptable(built.grid, derived, publishThemeSet);
        }
      }

      if (!acceptable) {
        lastBuildIssue = {
          stage: "isAcceptable-failed",
          attempt,
          entries: derived.length,
          thematicEntries: thematicDerivedCount,
          crossedEntries: crossedStats.crossed,
          checkedRatio: checkedStats.ratio,
          density: crosswordDensityFromGrid(built.grid),
          across: derived.filter((e) => e.direction === "across").length,
          down: derived.filter((e) => e.direction === "down").length,
          minEntryCheckedCells: entryCrossingStatsForBuilt.minCheckedCells,
          weakEntries: entryCrossingStatsForBuilt.weakEntries,
          hasShortRuns: hasShortLetterRuns(built.grid, minEntryLenForSize(n)),
          genericAnyCount,
          genericNonThemeCount,
        };
        console.warn("[generate-crossword] skip: isAcceptable failed", {
          attempt,
          entries: derived.length,
          letterCount,
          checkedRatio: checkedStats.ratio,
        });
        continue;
      }

      const rebuiltAccepted = rebuildGridFromEntries(n, derived, minEntryLenForSize(n));
      const gridForAccepted = rebuiltAccepted?.grid ?? built.grid;
      const derivedForAccepted = rebuiltAccepted?.derived ?? derived;
      const uniqueAnswers = Array.from(new Set(derivedForAccepted.map((e) => e.answer)));

      // Phase 3: clues-only (anti-hallucination)
      const clueByAnswer = new Map<string, string>();
      const thematicSet = new Set(
        pool
          .filter((c) => thematicKeepSet.has(c.answer) && !isOverGenericThemeWordForTheme(theme, c.answer))
          .map((c) => c.answer)
      );
      const publishableThemeAdjacentSet = new Set(
        pool
          .filter((c) => c.source !== "filler")
          .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer))
          .filter((c) =>
            hasStrongThematicClueSupport({
              theme,
              answer: c.answer,
              language,
              note: notesByAnswer.get(c.answer),
            })
          )
          .map((c) => c.answer)
      );
      const contextualAcceptedThematicSet = new Set(
        uniqueAnswers.filter((a) => {
          if (publishableThemeAdjacentSet.has(a)) return true;
          if (thematicSet.has(a)) return true;
          if (specificThematicFallbackClue(theme, a, language)) return true;
          const note = notesByAnswer.get(a);
          if (note && clueFromThemeNote(theme, note, language)) return true;
          return false;
        })
      );
      const clueItems: ClueRequestItem[] = uniqueAnswers.map((a) => {
        const note = notesByAnswer.get(a);
        const hint =
          buildThematicClueRequestHint(theme, a, language, note) ??
          (selectedBuilder === "pattern-11x11"
            ? language === "es"
              ? `Relacion factual concreta entre ${a} y ${theme}; mencionar ${theme}`
              : `Concrete factual connection between ${a} and ${theme}; mention ${theme}`
            : undefined);
        return {
          answer: a,
          thematic: contextualAcceptedThematicSet.has(a),
          note,
          hint: contextualAcceptedThematicSet.has(a) ? hint : undefined,
        };
      });

      if (n === 11) {
        for (const item of clueItems) {
          const note = item.note;
          const fromHint =
            item.hint &&
            !(selectedBuilder === "pattern-11x11" && !note) &&
            !clueMentionsAnswer(item.hint, item.answer)
              ? item.hint
              : null;
          const fromNote = note ? clueFromThemeNote(theme, note, language) : null;
          const specific = specificThematicFallbackClue(theme, item.answer, language);
          const clue =
            fromHint ??
            fromNote ??
            specific ??
            (item.thematic
              ? language === "es"
                ? `Referencia asociada con ${theme}`
                : `Reference associated with ${theme}`
              : language === "es"
              ? `Entrada vinculada al contexto de ${theme}`
              : `Entry linked to the context of ${theme}`);
          clueByAnswer.set(item.answer, sanitizeModelClueText(clue, language));
        }
      }

      try {
        const modelClues = await requestModelClues({
          client,
          theme,
          language,
          items: clueItems,
        });
        for (const [a, clue] of modelClues.entries()) {
          if (
            selectedBuilder === "pattern-11x11" &&
            !clue.toLowerCase().includes(theme.toLowerCase())
          ) {
            continue;
          }
          if (
            selectedBuilder === "pattern-11x11" &&
            /\b(mentioned in .* context|in .* context|word .* lyrics|quality aspired|referenced in .* performances)\b/i.test(
              clue
            )
          ) {
            continue;
          }
          clueByAnswer.set(a, clue);
        }
      } catch (e: unknown) {
        console.warn("[generate-crossword] pre-clue request failed", {
          attempt,
          name: e instanceof Error ? e.name : "unknown",
          msg: e instanceof Error ? e.message : String(e),
        });
      }

      reinforceThematicClues(
        theme,
        language,
        uniqueAnswers,
        clueByAnswer,
        notesByAnswer,
        contextualAcceptedThematicSet
      );

      const pendingClueItems = clueItems.filter((item) => !clueByAnswer.has(item.answer));
      if (pendingClueItems.length > 0) {
      const itemsJson = JSON.stringify(pendingClueItems);

      const cluebankRequest =
        CLUEBANK_PROMPT
          .replace("${theme}", theme)
          .replace("${languageLabel}", language === "es" ? "Spanish" : "English")
          .replace("${itemsJson}", itemsJson) +
        "\n\n" +
        (language === "es"
          ? [
              "REGLAS CRÍTICAS (OBLIGATORIAS):",
              "- NO inventes hechos específicos ni afirmaciones dudosas.",
              "- NO uses comillas ni títulos entre comillas.",
              "- Si la categoría temática es clara y segura, podés usar pistas de categoría: 'canción de...', 'álbum de...', 'guitarrista de...', 'variedad de uva', 'ciudad de...', etc.",
              "- Generá pistas SEGURAS y concretas; evitá las pistas demasiado abstractas.",
              "- Si no estás 100% seguro, devolvé una pista neutra tipo: 'Entrada temática (N letras)' o 'Palabra (N letras)'.",
              "- Devolvé SOLO JSON válido con { clues: [{ answer, clue }] }.",
            ].join("\n")
          : [
              "CRITICAL RULES (MANDATORY):",
              "- Do NOT invent specific facts or doubtful claims.",
              "- Do NOT use quotes or claim a title is from something.",
              "- If the thematic category is clear and safe, you may use category clues like 'song title', 'album title', 'band member', 'grape variety', 'city in...', etc.",
              "- Produce SAFE and concrete crossword-style clues; avoid overly abstract clues.",
              "- If you are not 100% sure, return a neutral clue like: 'Themed entry (N letters)' or 'Word (N letters)'.",
              "- Return ONLY valid JSON with { clues: [{ answer, clue }] }.",
            ].join("\n"));

      try {
        const completionClues = await client.chat.completions.create({
          model: CLUE_MODEL,
          temperature: 0,
          max_tokens: 1600,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Return ONLY valid JSON. No extra text." },
            { role: "user", content: cluebankRequest },
          ],
        });

        const rawCluesText = completionClues.choices?.[0]?.message?.content ?? "";
        const parsedClues = safeJson<RawClueBank>(rawCluesText);

        const looksFactualOrRisky = (clue: string) => {
          const c = clue.toLowerCase();

          // Quotes often indicate specific titles/claims
          if (c.includes('"') || c.includes("'")) return true;

          // High-risk assertion triggers (hallucination surface)
          if (
            /\b(from|released|debut|year|in \d{4}|feat\.|featuring|track|single|lyrics|cover|tour|lineup|formed|included|includes)\b/i.test(
              c
            )
          ) {
            return true;
          }

          // Otherwise OK (including SAFE category wording like "album title", "song title", etc.)
          return false;
        };

        if (parsedClues?.clues && Array.isArray(parsedClues.clues)) {
          for (const item of parsedClues.clues) {
            const a = normalizeAnswer(item.answer ?? "");
            const clue = (item.clue ?? "").toString().trim();
            if (!a || !clue) continue;
            if (!ASCII_A_TO_Z.test(a)) continue;
            if (isBadClue(clue)) continue;
            if (clueMentionsAnswer(clue, a)) continue;
            if (looksFactualOrRisky(clue)) continue;
            if (clueLooksOffTheme(theme, clue)) continue;

            clueByAnswer.set(a, clue);
          }
        }
      } catch (e: unknown) {
        console.warn("[generate-crossword] model2 failed", {
          attempt,
          name: e instanceof Error ? e.name : "unknown",
          msg: e instanceof Error ? e.message : String(e),
        });
      }
      }

      // Fill missing clues with SAFE neutral fallbacks
      for (const a of uniqueAnswers) {
        if (clueByAnswer.has(a)) continue;

        const themed = contextualAcceptedThematicSet.has(a);
        if (language === "es") {
          if (themed) {
            const note = notesByAnswer.get(a);
            if (note) {
              const synthesized = clueFromThemeNote(theme, note, language);
              if (synthesized) {
                clueByAnswer.set(a, synthesized);
                continue;
              }
            }
          }

          const specific = themed ? specificThematicFallbackClue(theme, a, language) : null;
          clueByAnswer.set(
            a,
            specific ?? (themed ? `Referencia asociada con ${theme}` : "Entrada comun de crucigrama")
          );
        } else {
          if (themed) {
            const note = notesByAnswer.get(a);
            if (note) {
              const synthesized = clueFromThemeNote(theme, note, language);
              if (synthesized) {
                clueByAnswer.set(a, synthesized);
                continue;
              }

              const cleaned = note.replace(/\s{2,}/g, " ").trim().replace(/\.$/, "");
              if (cleaned.length >= 8) {
                clueByAnswer.set(a, cleaned);
                continue;
              }
            }
          }

          const specific = themed ? specificThematicFallbackClue(theme, a, language) : null;
          clueByAnswer.set(a, specific ?? `Common word (${a.length})`);
        }
      }

      const finalAcceptedThematicSet = new Set(
        uniqueAnswers.filter((a) => {
          if (isOverGenericThemeWordForTheme(theme, a)) return false;
          if (contextualAcceptedThematicSet.has(a)) return true;
          return thematicKeepSet.has(a);
        })
      );

      reinforceThematicClues(
        theme,
        language,
        uniqueAnswers,
        clueByAnswer,
        notesByAnswer,
        finalAcceptedThematicSet
      );

      const acceptedEntriesSource =
        selectedBuilder === "csp-pattern-11x11"
          ? derivedForAccepted
          : n === 11
          ? derivedForAccepted.filter((e) => finalAcceptedThematicSet.has(e.answer))
          : derivedForAccepted;
      const safeAcceptedEntriesSource =
        acceptedEntriesSource.length >= 4
          ? acceptedEntriesSource
          : derivedForAccepted;
      const rebuiltPlayableAccepted =
        selectedBuilder !== "csp-pattern-11x11" && safeAcceptedEntriesSource.length > 0
          ? rebuildGridFromEntries(n, safeAcceptedEntriesSource, minEntryLenForSize(n))
          : null;
      const finalAcceptedGrid = rebuiltPlayableAccepted?.grid ?? gridForAccepted;
      const finalAcceptedDerived = rebuiltPlayableAccepted?.derived ?? safeAcceptedEntriesSource;

      const entries = applyCluesAndOverrides(theme, language, finalAcceptedDerived, clueByAnswer);
      const fullyCheckedAccepted = rebuildFullyCheckedPublishableCrossword(
        theme,
        n,
        finalAcceptedGrid,
        language,
        n === 11 ? finalAcceptedThematicSet : thematicSet,
        clueByAnswer,
        n === 11 ? minPublishEntriesForSize(n) : 4
      );
      const sanitizedFullyCheckedAccepted =
        n === 11 && !(fullyCheckedAccepted && fullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n))
          ? rebuildSanitizedFullyCheckedPublishableCrossword(
            theme,
            n,
            finalAcceptedGrid,
            language,
            finalAcceptedThematicSet,
            clueByAnswer,
            minPublishEntriesForSize(n)
          )
          : null;
      const exactFullyCheckedAccepted = rebuildExactFullyCheckedPublishableCrossword(
        theme,
        n,
        entries,
        language,
        n === 11 ? finalAcceptedThematicSet : thematicSet,
        n === 11 ? minPublishEntriesForSize(n) : 3
      );
      const directAcceptedCheckedStats = checkedCellStats(
        finalAcceptedGrid,
        minEntryLenForSize(n)
      );
      const directAcceptedCrossedStats = crossedEntryStats(
        finalAcceptedGrid,
        entries,
        minEntryLenForSize(n)
      );
      const directAcceptedThemeEntries = entries.filter((e) =>
        finalAcceptedThematicSet.has(e.answer)
      ).length;
      const directAccepted11Publishable =
        n === 11 &&
        entries.length >= minPublishEntriesForSize(n) &&
        !hasShortLetterRuns(finalAcceptedGrid, minEntryLenForSize(n)) &&
        directAcceptedCrossedStats.crossed >= minCrossedEntriesForPublish(n) &&
        directAcceptedCheckedStats.ratio >= 0.25 &&
        directAcceptedThemeEntries >= 7;

      if (
        n === 11 &&
        !directAccepted11Publishable &&
        !(fullyCheckedAccepted && fullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)) &&
        !(sanitizedFullyCheckedAccepted && sanitizedFullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)) &&
        !(exactFullyCheckedAccepted && exactFullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n))
      ) {
        console.warn("[generate-crossword] skip: no clean accepted 11x11 publication", {
          attempt,
          entries: entries.length,
          fullyCheckedAccepted: fullyCheckedAccepted?.entries.length ?? 0,
          sanitizedFullyCheckedAccepted: sanitizedFullyCheckedAccepted?.entries.length ?? 0,
          exactFullyCheckedAccepted: exactFullyCheckedAccepted?.entries.length ?? 0,
        });
        continue;
      }
      const acceptedEntriesForResponseRaw =
        n === 11 && fullyCheckedAccepted && fullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)
          ? fullyCheckedAccepted.entries
          : n === 11 && sanitizedFullyCheckedAccepted && sanitizedFullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)
          ? sanitizedFullyCheckedAccepted.entries
          : n === 11 && exactFullyCheckedAccepted && exactFullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)
          ? exactFullyCheckedAccepted.entries
          : entries;
      const acceptedEntriesAfterClueRepair = repairPublishClues(acceptedEntriesForResponseRaw, {
        theme,
        language,
        thematicSet: finalAcceptedThematicSet,
        notesByAnswer,
      });
      const acceptedEntriesPruned = pruneForbiddenPublishAnswersIfPossible(
        pruneMaskedDuplicateAnswers(acceptedEntriesAfterClueRepair),
        minPublishEntriesForSize(n)
      );
      const acceptedPrunedRebuild =
        selectedBuilder !== "csp-pattern-11x11" &&
        acceptedEntriesPruned.length !== acceptedEntriesAfterClueRepair.length &&
        acceptedEntriesPruned.length >= minPublishEntriesForSize(n)
          ? rebuildGridFromEntries(n, acceptedEntriesPruned, minEntryLenForSize(n))
          : null;
      const acceptedEntriesForResponse =
        acceptedPrunedRebuild?.derived && acceptedPrunedRebuild.derived.length > 0
          ? repairPublishClues(applyCluesAndOverrides(theme, language, acceptedPrunedRebuild.derived, clueByAnswer), {
              theme,
              language,
              thematicSet: finalAcceptedThematicSet,
              notesByAnswer,
            })
          : acceptedEntriesPruned;
      const acceptedGridForResponseRaw =
        selectedBuilder === "csp-pattern-11x11"
          ? finalAcceptedGrid
          : n === 11 && fullyCheckedAccepted && fullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)
          ? fullyCheckedAccepted.grid
          : n === 11 && sanitizedFullyCheckedAccepted && sanitizedFullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)
          ? sanitizedFullyCheckedAccepted.grid
          : n === 11 && exactFullyCheckedAccepted && exactFullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)
          ? exactFullyCheckedAccepted.grid
          : finalAcceptedGrid;
      const acceptedGridForResponse = acceptedPrunedRebuild?.grid ?? acceptedGridForResponseRaw;

      const blandText = language === "es" ? "Definición breve." : "Brief definition.";
      const bland = acceptedEntriesForResponse.filter((e) => e.clue === blandText).length;
      const placeholderCount = acceptedEntriesForResponse.filter((e) => isPlaceholderClue(e.clue, language)).length;
      const acceptedQualityIssue = publishQualityIssue(
        acceptedEntriesForResponse,
        finalAcceptedThematicSet,
        language,
        minPublishEntriesForSize(n)
      );

      if (n === 11 && (bland > 0 || placeholderCount > 0 || acceptedQualityIssue)) {
        console.warn("[generate-crossword] skip: clue quality failed", {
          attempt,
          bland,
          placeholderCount,
          entries: acceptedEntriesForResponse.length,
          acceptedQualityIssue,
        });
        continue;
      }

      const out: Crossword = {
        theme,
        language,
        size: n,
        grid: acceptedGridForResponse,
        entries: acceptedEntriesForResponse,
          meta: {
            source: "answers-then-freeform-grid-then-clues",
            ...(lastCspAttemptMeta && { cspAttempt: lastCspAttemptMeta }),
            attempt,
            answerCount: usableParsedAnswers.answers?.length ?? 0,
          poolCount: pool.length,
          clueCount: clueByAnswer.size,
          bland,
          placeholderCount,
          ...built.meta,
        },
      };

      return publishCrosswordResponse(out);
    }

    if (bestPartial && shouldRejectBestPartialForStrict11(n)) {
      const bestForGate = bestPartial;
      const bestThematicSet = new Set(
        bestForGate.pool
          .filter((c) => bestForGate.trustedThematicSet.has(c.answer))
          .map((c) => c.answer)
      );
      const bestCheckedStats = checkedCellStats(
        bestForGate.built.grid,
        minEntryLenForSize(n)
      );
      const bestCrossedStats = crossedEntryStats(
        bestForGate.built.grid,
        bestForGate.derived,
        minEntryLenForSize(n)
      );
      const bestThematicEntries = bestForGate.derived.filter((e) => bestThematicSet.has(e.answer)).length;
      const bestNearPublishEntries =
        n === 11 && bestForGate.derived.length >= minPublishEntriesForSize(n);
      const bestMinThematicEntries = bestNearPublishEntries
        ? minThematicEntriesForPublish(n, bestForGate.derived.length)
        : minThematicEntriesForPublish(n, bestForGate.derived.length);
      const bestLooksPublishable =
        (bestForGate.derived.length >= minPublishEntriesForSize(n) || bestNearPublishEntries) &&
        bestThematicEntries >= 7 &&
        bestCrossedStats.crossed >= minCrossedEntriesForPublish(n) &&
        bestCheckedStats.ratio >= 0.25;
      if (bestLooksPublishable) {
        console.warn("[generate-crossword] bestPartial passes 11x11 thresholds; attempting direct publish before reconstruction", {
          bestEntries: bestPartial.derived.length,
          bestThematicEntries,
          bestCrossedEntries: bestCrossedStats.crossed,
          bestCheckedRatio: bestCheckedStats.ratio,
        });
      }

      const bestEntryCrossingStats = entryCrossingStats(
        bestForGate.built.grid,
        bestForGate.derived,
        minEntryLenForSize(n)
      );
      if (
        n === 11 &&
        bestNearPublishEntries &&
        bestThematicEntries >= bestMinThematicEntries &&
        !hasShortLetterRuns(bestForGate.built.grid, minEntryLenForSize(n)) &&
        bestCrossedStats.crossed >= bestForGate.derived.length &&
        bestEntryCrossingStats.weakEntries.length === 0 &&
        bestCheckedStats.ratio >= 0.25 &&
        !bestForGate.derived.some((entry) => isForbiddenPublishAnswer(entry.answer))
      ) {
        const clueByAnswer = new Map<string, string>();
        const broadThematicSet = buildPublishThematicSetFromPool({
          pool: bestForGate.pool,
          trustedThematicSet: bestForGate.trustedThematicSet,
          theme,
          language,
          notesByAnswer: bestForGate.notesByAnswer,
          clueByAnswer,
        });
        const directCoreThematicSet = buildCoreThematicSetFromPool({
          pool: bestForGate.pool,
          trustedThematicSet: bestForGate.trustedThematicSet,
          theme,
          language,
          notesByAnswer: bestForGate.notesByAnswer,
          clueByAnswer,
        });
        for (const entry of bestForGate.derived) {
          const note = bestForGate.notesByAnswer.get(entry.answer);
          const thematic = broadThematicSet.has(entry.answer);
          const repaired = fallbackClueForPublishRepair(theme, entry.answer, language, thematic, note);
          const fromNote = note ? clueFromThemeNote(theme, note, language) : null;
          const specific = specificThematicFallbackClue(theme, entry.answer, language);
          clueByAnswer.set(
            entry.answer,
            repaired ??
              fromNote ??
              specific ??
              (thematic
                ? language === "es"
                  ? `Dato temático vinculado a ${theme}`
                  : `Thematic fact linked to ${theme}`
                : language === "es"
                ? `Elemento asociado al contexto de ${theme}`
                : `Element associated with ${theme}`)
          );
        }
        reinforceThematicClues(
          theme,
          language,
          bestForGate.derived.map((entry) => entry.answer),
          clueByAnswer,
          bestForGate.notesByAnswer,
          broadThematicSet
        );
        const directEntries = repairPublishClues(
          applyCluesAndOverrides(theme, language, bestForGate.derived, clueByAnswer),
          {
            theme,
            language,
            thematicSet: broadThematicSet,
            notesByAnswer: bestForGate.notesByAnswer,
          }
        );
        const directGenericContextEntries = directEntries.filter(
          (entry) => broadThematicSet.has(entry.answer) && !directCoreThematicSet.has(entry.answer)
        ).length;
        const directPlaceholderCount = directEntries.filter((entry) =>
          isPlaceholderClue(entry.clue, language)
        ).length;
        const directQualityIssue = publishQualityIssue(
          directEntries,
          broadThematicSet,
          language,
          minPublishEntriesForSize(n)
        );
        const directCoreEntries = directEntries.filter((entry) =>
          directCoreThematicSet.has(entry.answer)
        ).length;

        if (
          directEntries.length >= minPublishEntriesForSize(n) &&
          directPlaceholderCount === 0 &&
          !directQualityIssue &&
          directCoreEntries >= minCoreThematicEntriesForPublish(n, directEntries.length) &&
          directGenericContextEntries <= maxGenericContextEntriesForPublish(n, directEntries.length) &&
          bestEntryCrossingStats.weakEntries.length === 0
        ) {
          return publishCrosswordResponse(
            {
              theme,
              language,
              size: n,
              grid: bestForGate.built.grid,
              entries: directEntries,
              meta: {
                source: "best-partial-direct-11",
                reason: "Published clean thematic 11x11 candidate before expensive rescue.",
                targetEntries: minPublishEntriesForSize(n),
                desiredEntries: desiredPublishEntriesForSize(n),
                entries: directEntries.length,
                trustedThematicEntries: bestThematicEntries,
                broadThematicEntries: directEntries.filter((entry) => broadThematicSet.has(entry.answer)).length,
                coreThematicEntries: directCoreEntries,
                genericContextEntries: directGenericContextEntries,
                crossedEntries: bestCrossedStats.crossed,
                checkedRatio: bestCheckedStats.ratio,
                minEntryCheckedCells: bestEntryCrossingStats.minCheckedCells,
                ...bestForGate.built.meta,
              },
            } satisfies Crossword
          );
        } else {
          console.warn("[generate-crossword] best-partial emergency direct rejected", {
            entries: directEntries.length,
            placeholderCount: directPlaceholderCount,
            qualityIssue: directQualityIssue,
            coreThematicEntries: directCoreEntries,
            minCoreThematicEntries: minCoreThematicEntriesForPublish(n, directEntries.length),
            genericContextEntries: directGenericContextEntries,
            maxGenericContextEntries: maxGenericContextEntriesForPublish(n, directEntries.length),
            weakCrossingEntries: bestEntryCrossingStats.weakEntries,
            trustedThematicEntries: bestThematicEntries,
            answers: directEntries.map((entry) => entry.answer),
          });
        }
      }

      {
        const rescue = allowModelRescueFor11
          ? await buildThemeFirstRescueCrossword({
              client,
              theme,
              language,
              size: n,
              pool: bestForGate.pool,
              notesByAnswer: bestForGate.notesByAnswer,
              trustedThematicSet: bestForGate.trustedThematicSet,
              seedBase: (theme.length * 40503 + n * 9176 + bestForGate.attempt * 2654435761) >>> 0,
            })
          : null;

        if (rescue) {
          console.warn("[generate-crossword] published theme-first 11x11 rescue", {
            bestEntries: bestForGate.derived.length,
            rescueEntries: rescue.entries.length,
            source: rescue.meta?.source,
          });
          return publishCrosswordResponse(rescue);
        }

        if (
          bestForGate.derived.length >= minPublishEntriesForSize(n) &&
          bestThematicEntries >= 11 &&
          bestThematicEntries / bestForGate.derived.length >= 0.6 &&
          !hasShortLetterRuns(bestForGate.built.grid, minEntryLenForSize(n)) &&
          bestCrossedStats.crossed >= minCrossedEntriesForPublish(n) &&
          bestCheckedStats.ratio >= 0.25 &&
          !bestForGate.derived.some((entry) => isLikelyBadAnswer(entry.answer) && !ALWAYS_ALLOW_ANSWERS.has(entry.answer))
        ) {
          const uniqueAnswers = Array.from(new Set(bestForGate.derived.map((entry) => entry.answer)));
          const clueByAnswer = new Map<string, string>();
          let broadThematicSet = buildPublishThematicSetFromPool({
            pool: bestForGate.pool,
            trustedThematicSet: bestForGate.trustedThematicSet,
            theme,
            language,
            notesByAnswer: bestForGate.notesByAnswer,
            clueByAnswer,
          });
          const clueItems: ClueRequestItem[] = uniqueAnswers.map((answer) => {
            const note = bestForGate.notesByAnswer.get(answer);
            const thematic = broadThematicSet.has(answer);
            return {
              answer,
              thematic,
              note,
              hint: thematic ? buildThematicClueRequestHint(theme, answer, language, note) ?? undefined : undefined,
            };
          });

          try {
            const modelClues = await requestModelClues({
              client,
              theme,
              language,
              items: clueItems,
            });
            for (const [answer, clue] of modelClues.entries()) clueByAnswer.set(answer, clue);
          } catch (error: unknown) {
            console.warn("[generate-crossword] best-partial direct clues failed", {
              name: error instanceof Error ? error.name : "unknown",
              msg: error instanceof Error ? error.message : String(error),
            });
          }

          for (const answer of uniqueAnswers) {
            if (clueByAnswer.has(answer)) continue;
            const note = bestForGate.notesByAnswer.get(answer);
            const fromNote = note ? clueFromThemeNote(theme, note, language) : null;
            const specific = specificThematicFallbackClue(theme, answer, language);
            clueByAnswer.set(
              answer,
              fromNote ??
                specific ??
                (language === "es"
                  ? `Referencia concreta asociada con ${theme}`
              : `Concrete reference associated with ${theme}`)
            );
          }

          broadThematicSet = buildPublishThematicSetFromPool({
            pool: bestForGate.pool,
            trustedThematicSet: bestForGate.trustedThematicSet,
            theme,
            language,
            notesByAnswer: bestForGate.notesByAnswer,
            clueByAnswer,
          });

          reinforceThematicClues(
            theme,
            language,
            uniqueAnswers,
            clueByAnswer,
            bestForGate.notesByAnswer,
            broadThematicSet
          );

          const directEntries = repairPublishClues(
            applyCluesAndOverrides(theme, language, bestForGate.derived, clueByAnswer),
            {
              theme,
              language,
              thematicSet: broadThematicSet,
              notesByAnswer: bestForGate.notesByAnswer,
            }
          );
          const directCoreThematicSet = buildCoreThematicSetFromPool({
            pool: bestForGate.pool,
            trustedThematicSet: bestForGate.trustedThematicSet,
            theme,
            language,
            notesByAnswer: bestForGate.notesByAnswer,
            clueByAnswer,
          });
          const directPlaceholderCount = directEntries.filter((entry) =>
            isPlaceholderClue(entry.clue, language)
          ).length;
          const directQualityIssue = publishQualityIssue(
            directEntries,
            broadThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const directCoreEntries = directEntries.filter((entry) =>
            directCoreThematicSet.has(entry.answer)
          ).length;
          const directGenericContextEntries = directEntries.filter(
            (entry) => broadThematicSet.has(entry.answer) && !directCoreThematicSet.has(entry.answer)
          ).length;
          const directBlocksPublish =
            directEntries.length < minPublishEntriesForSize(n) ||
            directPlaceholderCount > 0 ||
            directQualityIssue ||
            directCoreEntries < minCoreThematicEntriesForPublish(n, directEntries.length) ||
            directGenericContextEntries > maxGenericContextEntriesForPublish(n, directEntries.length) ||
            bestCrossedStats.crossed < directEntries.length ||
            bestEntryCrossingStats.weakEntries.length > 0 ||
            bestCheckedStats.ratio < 0.25;

          if (directBlocksPublish) {
            const directPlayableDegraded =
              directEntries.length >= minPublishEntriesForSize(n) &&
              directPlaceholderCount === 0 &&
              !directQualityIssue &&
              directCoreEntries >= minCoreThematicEntriesForPublish(n, directEntries.length) &&
              directGenericContextEntries <= maxGenericContextEntriesForPublish(n, directEntries.length) &&
              bestCrossedStats.crossed >= Math.max(6, directEntries.length - 1) &&
              bestEntryCrossingStats.weakEntries.length === 0 &&
              bestCheckedStats.ratio >= 0.25 &&
              !hasShortLetterRuns(bestForGate.built.grid, minEntryLenForSize(n)) &&
              !directEntries.some((entry) => isForbiddenPublishAnswer(entry.answer));

            if (directPlayableDegraded) {
              console.warn("[generate-crossword] best-partial direct degraded accepted", {
                entries: directEntries.length,
                placeholderCount: directPlaceholderCount,
                qualityIssue: directQualityIssue,
                weakCrossingEntries: bestEntryCrossingStats.weakEntries,
                checkedRatio: bestCheckedStats.ratio,
              });

              return publishCrosswordResponse({
                theme,
                language,
                size: n,
                grid: bestForGate.built.grid,
                entries: directEntries,
                meta: {
                  source: "best-partial-direct-degraded-11",
                  reason: "Published playable 11x11 best partial before destructive reconstruction.",
                  entries: directEntries.length,
                  broadThematicEntries: directEntries.filter((entry) => broadThematicSet.has(entry.answer)).length,
                  coreThematicEntries: directCoreEntries,
                  genericContextEntries: directGenericContextEntries,
                  trustedThematicEntries: bestThematicEntries,
                  trustedThematicRatio: bestThematicEntries / directEntries.length,
                  crossedEntries: bestCrossedStats.crossed,
                  checkedRatio: bestCheckedStats.ratio,
                  minEntryCheckedCells: bestEntryCrossingStats.minCheckedCells,
                  weakCrossingEntries: bestEntryCrossingStats.weakEntries,
                  placeholderCount: directPlaceholderCount,
                  qualityIssue: directQualityIssue,
                  nearThreshold: true,
                  degraded: true,
                  ...bestForGate.built.meta,
                },
              } satisfies Crossword);
            }

            console.warn("[generate-crossword] best-partial direct rejected by clue quality gate", {
              entries: directEntries.length,
              placeholderCount: directPlaceholderCount,
              qualityIssue: directQualityIssue,
              coreEntries: directCoreEntries,
              minCoreEntries: minCoreThematicEntriesForPublish(n, directEntries.length),
              genericContextEntries: directGenericContextEntries,
              maxGenericContextEntries: maxGenericContextEntriesForPublish(n, directEntries.length),
              crossedEntries: bestCrossedStats.crossed,
              checkedRatio: bestCheckedStats.ratio,
              weakCrossingEntries: bestEntryCrossingStats.weakEntries,
              answers: directEntries.map((entry) => entry.answer),
            });
          } else {
          const directOut: Crossword = {
            theme,
            language,
            size: n,
            grid: bestForGate.built.grid,
            entries: directEntries,
            meta: {
              source: "best-partial-direct-11",
              reason: "Published structurally valid 11x11 instead of returning threshold error.",
              entries: directEntries.length,
              broadThematicEntries: directEntries.filter((entry) => broadThematicSet.has(entry.answer)).length,
              coreThematicEntries: directCoreEntries,
              genericContextEntries: directGenericContextEntries,
              trustedThematicEntries: bestThematicEntries,
              trustedThematicRatio: bestThematicEntries / directEntries.length,
              crossedEntries: bestCrossedStats.crossed,
              checkedRatio: bestCheckedStats.ratio,
              clueCount: clueByAnswer.size,
            },
          };

          return publishCrosswordResponse(directOut);
          }
        }

        console.warn("[generate-crossword] bestPartial below early publish gate; continuing to fallback reconstruction", {
          bestEntries: bestForGate.derived.length,
          bestThematicEntries,
          bestCrossedEntries: bestCrossedStats.crossed,
          bestCheckedRatio: bestCheckedStats.ratio,
          minEntries: minPublishEntriesForSize(n),
          fallbackScore: bestPartial.fallbackScore,
          lastAnswerStats,
        });
      }
    }

    if (bestPartial) {
      if (n === 11 && bestPartial.derived.length < minPublishEntriesForSize(n) - 3) {
        console.warn("[generate-crossword] bestPartial small; continuing rescue instead of returning 422", {
          finalEntries: bestPartial.derived.length,
          minEntries: minPublishEntriesForSize(n),
          lastAnswerStats,
          lastBuildIssue,
        });
      }

      if (n === 11 && Date.now() > deadlineMs - 45_000) {
        const cleanupBest = bestPartial;
        if (cleanupBest.derived.length >= minPublishEntriesForSize(n)) {
          const cleanupDeadlineMs = Math.min(deadlineMs - 1_000, Date.now() + 22_000);
          const cleanupPool = cleanupBest.pool.filter((candidate) => candidate.source !== "filler");
          const cleanedGrid = hasShortLetterRuns(cleanupBest.built.grid, minEntryLenForSize(n))
            ? blockShortRunsOnly(cleanupBest.built.grid, minEntryLenForSize(n))
            : cleanupBest.built.grid;
          const cleanedDerived = deriveEntriesFromGrid(cleanedGrid, minEntryLenForSize(n));
          const cleanupBase =
            cleanedDerived.length >= minPublishEntriesForSize(n) - 2
              ? { grid: cleanedGrid, derived: cleanedDerived, added: [] as string[], meta: {} as Record<string, unknown> }
              : null;
          const noPruneDensified = densifyCleanGrid11({
              theme,
              grid: cleanedGrid,
              candidates: cleanupPool,
              targetEntries: minPublishEntriesForSize(n),
              seed: (theme.length * 1103515245 + cleanupBest.attempt * 12345 + n) >>> 0,
              deadlineMs: Math.min(cleanupDeadlineMs, Date.now() + 11_000),
              pruneWeakEntries: false,
            });
          const noPruneWeakCount = noPruneDensified
            ? entryCrossingStats(noPruneDensified.grid, noPruneDensified.derived, minEntryLenForSize(n)).weakEntries.length
            : Number.POSITIVE_INFINITY;
          const pruneDensified =
            noPruneWeakCount === 0 || Date.now() > cleanupDeadlineMs - 2_000
              ? null
              : densifyCleanGrid11({
                  theme,
                  grid: cleanedGrid,
                  candidates: cleanupPool,
                  targetEntries: minPublishEntriesForSize(n),
                  seed: (theme.length * 1103515245 + cleanupBest.attempt * 12345 + n ^ 0x85ebca6b) >>> 0,
                  deadlineMs: cleanupDeadlineMs,
                });
          const cleanedOrDensified =
            [noPruneDensified, pruneDensified, cleanupBase]
              .filter((candidate): candidate is { grid: string[][]; derived: DerivedEntry[]; added: string[]; meta: Record<string, unknown> } =>
                Boolean(candidate)
              )
              .sort((a, b) => {
                const weakA = entryCrossingStats(a.grid, a.derived, minEntryLenForSize(n)).weakEntries.length;
                const weakB = entryCrossingStats(b.grid, b.derived, minEntryLenForSize(n)).weakEntries.length;
                if (weakA !== weakB) return weakA - weakB;
                return b.derived.length - a.derived.length;
              })[0] ?? null;

          if (cleanedOrDensified) {
            const clueByAnswer = new Map<string, string>();
            const thematicSet = buildPublishThematicSetFromPool({
              pool: cleanupBest.pool,
              trustedThematicSet: cleanupBest.trustedThematicSet,
              theme,
              language,
              notesByAnswer: cleanupBest.notesByAnswer,
              clueByAnswer,
            });
            const coreThematicSet = buildCoreThematicSetFromPool({
              pool: cleanupBest.pool,
              trustedThematicSet: cleanupBest.trustedThematicSet,
              theme,
              language,
              notesByAnswer: cleanupBest.notesByAnswer,
              clueByAnswer,
            });
            const cleanupEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(
                applyCluesAndOverrides(theme, language, cleanedOrDensified.derived, clueByAnswer),
                {
                  theme,
                  language,
                  thematicSet,
                  notesByAnswer: cleanupBest.notesByAnswer,
                }
              )
            ).filter((entry) =>
              isPublishableAnswerForTheme({
                theme,
                answer: entry.answer,
                language,
                size: n,
                note: cleanupBest.notesByAnswer.get(entry.answer),
                allowContextualGeneric: thematicSet.has(entry.answer),
              })
            );
            const cleanupCrossed = crossedEntryStats(
              cleanedOrDensified.grid,
              cleanupEntries,
              minEntryLenForSize(n)
            );
            const cleanupEntryCrossings = entryCrossingStats(
              cleanedOrDensified.grid,
              cleanupEntries,
              minEntryLenForSize(n)
            );
            const cleanupChecked = checkedCellStats(cleanedOrDensified.grid, minEntryLenForSize(n));
            const cleanupThemeEntries = cleanupEntries.filter((entry) => thematicSet.has(entry.answer)).length;
            const cleanupCoreEntries = cleanupEntries.filter((entry) => coreThematicSet.has(entry.answer)).length;
            const cleanupGenericContextEntries = cleanupEntries.filter(
              (entry) => thematicSet.has(entry.answer) && !coreThematicSet.has(entry.answer)
            ).length;
            const cleanupQualityIssue = publishQualityIssue(
              cleanupEntries,
              thematicSet,
              language,
              minPublishEntriesForSize(n)
            );

            if (
              cleanupEntries.length >= minPublishEntriesForSize(n) &&
              cleanupCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              cleanupEntryCrossings.weakEntries.length === 0 &&
              cleanupChecked.ratio >= 0.25 &&
              cleanupThemeEntries >= minThematicEntriesForPublish(n, cleanupEntries.length) &&
              cleanupCoreEntries >= minCoreThematicEntriesForPublish(n, cleanupEntries.length) &&
              cleanupGenericContextEntries <= maxGenericContextEntriesForPublish(n, cleanupEntries.length) &&
              !hasShortLetterRuns(cleanedOrDensified.grid, minEntryLenForSize(n)) &&
              !cleanupQualityIssue
            ) {
              return publishCrosswordResponse({
                theme,
                language,
                size: n,
                grid: cleanedOrDensified.grid,
                entries: cleanupEntries,
                meta: {
                  source: "deadline-cleanup-11",
                  reason: "Cleaned a threshold candidate before returning timeout.",
                  attempt: cleanupBest.attempt,
                  entries: cleanupEntries.length,
                  thematicEntries: cleanupThemeEntries,
                  coreThematicEntries: cleanupCoreEntries,
                  genericContextEntries: cleanupGenericContextEntries,
                  crossedEntries: cleanupCrossed.crossed,
                  checkedRatio: cleanupChecked.ratio,
                  minEntryCheckedCells: cleanupEntryCrossings.minCheckedCells,
                  cleanupAdded: cleanedOrDensified.added,
                  ...cleanupBest.built.meta,
                  ...cleanedOrDensified.meta,
                },
              } satisfies Crossword);
            }

            lastBuildIssue = {
              ...(lastBuildIssue ?? {}),
              stage: "deadline-cleanup-rejected",
              cleanupEntries: cleanupEntries.length,
              cleanupWeakEntries: cleanupEntryCrossings.weakEntries,
              cleanupHasShortRuns: hasShortLetterRuns(cleanedOrDensified.grid, minEntryLenForSize(n)),
              cleanupQualityIssue,
            };
          }
        }

        return makeGenerationErrorResponse(
          {
            source: "generation-time-budget",
            reason: "Se agotó el tiempo de construcción antes de obtener un 11x11 completamente chequeado.",
            finalEntries: bestPartial.derived.length,
            minEntries: minPublishEntriesForSize(n),
            lastAnswerStats,
            lastBuildIssue,
          },
          422
        );
      }
      const boundedFallbackDeadline = (sliceMs: number, reserveMs = 1_000) =>
        Math.min(deadlineMs - reserveMs, Date.now() + sliceMs);
      const fallbackDeadlineMs =
        n === 11 ? boundedFallbackDeadline(8_000) : Date.now() + 20_000;
      if (n === 11 && fallbackDeadlineMs <= Date.now() + 500) {
        return makeGenerationErrorResponse(
          {
            source: "generation-time-budget",
            reason: "Se agotó el tiempo de construcción antes de iniciar el rescate final.",
            finalEntries: bestPartial.derived.length,
            minEntries: minPublishEntriesForSize(n),
            lastAnswerStats,
            lastBuildIssue,
          },
          422
        );
      }
      const best = bestPartial;
      let fallbackBuilt = bestPartial.built;
      let fallbackDerivedSeed: DerivedEntry[] = bestPartial.derived;
      let fallbackPool: WordCandidate[] = bestPartial.pool;
      const fallbackStrictSeed =
        (theme.length * 2246822519 + bestPartial.attempt * 3266489917 + n * 131) >>> 0;

      if (n === 11) {
        const strictRepackPool: WordCandidate[] = bestPartial.pool.filter(
          (c: WordCandidate) =>
            c.source !== "filler" &&
            !isOverGenericThemeWordForTheme(theme, c.answer) &&
            hasStrongThematicClueSupport({
              theme,
              answer: c.answer,
              language,
              note: best.notesByAnswer.get(c.answer),
            })
        );
        const broadStrictRepackPool: WordCandidate[] = bestPartial.pool.filter(
          (c: WordCandidate) => c.source !== "filler" && !isOverGenericThemeWordForTheme(theme, c.answer)
        );

        const strictRepacked =
          strictRepackPool.length >= 6
            ? constructStrictCrossword11({
                theme,
                size: n,
                seed: fallbackStrictSeed,
                candidates: strictRepackPool,
                deadlineMs: fallbackDeadlineMs,
              })
            : null;
        const broadStrictRepacked =
          !strictRepacked && broadStrictRepackPool.length >= 8
            ? constructStrictCrossword11({
                theme,
                size: n,
                seed: (fallbackStrictSeed ^ 0x9e3779b9) >>> 0,
                candidates: broadStrictRepackPool,
                deadlineMs: fallbackDeadlineMs,
              })
            : null;
        const strictFallbackCandidate = strictRepacked ?? broadStrictRepacked;

        if (strictFallbackCandidate) {
          const strictDerived = deriveEntriesFromGrid(strictFallbackCandidate.grid, minEntryLenForSize(n));
          if (strictDerived.length >= 3) {
            fallbackBuilt = strictFallbackCandidate;
            fallbackDerivedSeed = strictDerived;
            fallbackPool = strictFallbackCandidate === strictRepacked ? strictRepackPool : broadStrictRepackPool;
          }
        }
      }

      const strictFallbackAllowedAnswers: Set<string> = new Set<string>(
        fallbackPool
          .filter((c) => c.source !== "filler")
          .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer))
          .filter((c) =>
            hasStrongThematicClueSupport({
              theme,
              answer: c.answer,
              language,
              note: best.notesByAnswer.get(c.answer),
            })
          )
          .map((c) => c.answer)
      );
      const broadFallbackAllowedAnswers: Set<string> = new Set<string>(
        fallbackPool
          .filter((c) => c.source !== "filler")
          .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer))
          .map((c) => c.answer)
      );
      const fallbackAllowedAnswers: Set<string> =
        n === 11
          ? broadFallbackAllowedAnswers
          : strictFallbackAllowedAnswers.size >= Math.max(4, Math.floor(fallbackDerivedSeed.length * 0.35))
          ? strictFallbackAllowedAnswers
          : broadFallbackAllowedAnswers;

      const trimmed = rebuildGridFromAllowedEntries(
        fallbackBuilt.grid,
        fallbackAllowedAnswers,
        minEntryLenForSize(n)
      );

      const baseGrid = trimmed?.grid ?? fallbackBuilt.grid;
      const baseDerived =
        trimmed?.derived && trimmed.derived.length >= Math.max(4, Math.floor(fallbackDerivedSeed.length * 0.35))
          ? trimmed.derived
          : fallbackDerivedSeed;

      const sanitizedGrid = sanitizeUncheckedGrid(baseGrid, minEntryLenForSize(n));
      const sanitizedDerived = deriveEntriesFromGrid(sanitizedGrid, minEntryLenForSize(n)).filter(
        (e) => fallbackAllowedAnswers.size === 0 || fallbackAllowedAnswers.has(e.answer)
      );
      const sanitizedChecked = checkedCellStats(sanitizedGrid, minEntryLenForSize(n));
      const originalChecked = checkedCellStats(baseGrid, minEntryLenForSize(n));

      const gridForFallback =
        sanitizedDerived.length >= Math.max(4, Math.floor(baseDerived.length * 0.6)) &&
        sanitizedChecked.ratio >= originalChecked.ratio
          ? sanitizedGrid
          : baseGrid;
      const derivedForFallback =
        gridForFallback === sanitizedGrid
          ? sanitizedDerived
          : baseDerived.filter((e) => fallbackAllowedAnswers.size === 0 || fallbackAllowedAnswers.has(e.answer));

      const safeDerivedForFallback =
        derivedForFallback.length >= Math.max(4, Math.floor(fallbackDerivedSeed.length * 0.35))
          ? derivedForFallback
          : fallbackDerivedSeed;

      const rebuiltFallback = rebuildGridFromEntries(n, safeDerivedForFallback, minEntryLenForSize(n));
      let finalFallbackGrid =
        rebuiltFallback?.derived && rebuiltFallback.derived.length > 0
          ? rebuiltFallback.grid
          : fallbackBuilt.grid;
      let finalFallbackDerived =
        rebuiltFallback?.derived && rebuiltFallback.derived.length > 0
          ? rebuiltFallback.derived
          : fallbackDerivedSeed;

      const densifiedFallback =
        n === 11 && finalFallbackDerived.length < minPublishEntriesForSize(n)
          ? densifyCleanGrid11({
              theme,
              grid: finalFallbackGrid,
              candidates: fallbackPool,
              targetEntries: minPublishEntriesForSize(n),
              seed: (fallbackStrictSeed ^ 0x510e527f) >>> 0,
              deadlineMs: fallbackDeadlineMs,
            })
          : null;

      if (densifiedFallback && densifiedFallback.derived.length > finalFallbackDerived.length) {
        finalFallbackGrid = densifiedFallback.grid;
        finalFallbackDerived = densifiedFallback.derived;
        fallbackBuilt = {
          ...fallbackBuilt,
          grid: densifiedFallback.grid,
          usedAnswers: Array.from(new Set(densifiedFallback.derived.map((entry) => entry.answer))),
          meta: {
            ...fallbackBuilt.meta,
            ...densifiedFallback.meta,
          },
        };
        fallbackDerivedSeed = densifiedFallback.derived;
      }

      const clueByAnswer = new Map<string, string>();
      const fallbackNotesByAnswer = best.notesByAnswer;
      const thematicSet = new Set(
        bestPartial.pool
          .filter((c) => fallbackAllowedAnswers.size === 0 || fallbackAllowedAnswers.has(c.answer))
          .filter((c) => best.trustedThematicSet.has(c.answer))
          .filter((c) =>
            hasStrongThematicClueSupport({
              theme,
              answer: c.answer,
              language,
              note: fallbackNotesByAnswer.get(c.answer),
            })
          )
          .map((c) => c.answer)
      );
      const strongThematicSet = new Set(
        bestPartial.pool
          .filter((c) => fallbackAllowedAnswers.size === 0 || fallbackAllowedAnswers.has(c.answer))
          .filter((c) => c.source !== "filler")
          .filter((c) => !(n === 11 && c.source === "support"))
          .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer))
          .filter((c) =>
            hasStrongThematicClueSupport({
              theme,
              answer: c.answer,
              language,
              note: fallbackNotesByAnswer.get(c.answer),
            })
          )
          .map((c) => c.answer)
      );
      const contextualFallbackThematicSet: Set<string> = new Set<string>(
        Array.from(new Set<string>(finalFallbackDerived.map((e) => e.answer))).filter((a) => {
          if (strongThematicSet.has(a)) return true;
          if (thematicSet.has(a)) return true;
          if (specificThematicFallbackClue(theme, a, language)) return true;
          const note = fallbackNotesByAnswer.get(a);
          if (note && clueFromThemeNote(theme, note, language)) return true;
          return false;
        })
      );

      const fallbackClueItems: ClueRequestItem[] = Array.from(
        new Set<string>(finalFallbackDerived.map((e) => e.answer))
      ).map((a) => {
        const note = fallbackNotesByAnswer.get(a);
        const hint = buildThematicClueRequestHint(theme, a, language, note) ?? undefined;
        return {
          answer: a,
          thematic: contextualFallbackThematicSet.has(a),
          note,
          hint: contextualFallbackThematicSet.has(a) ? hint : undefined,
        };
      });

      if (n !== 11) try {
        const modelClues = await requestModelClues({
          client,
          theme,
          language,
          items: fallbackClueItems,
        });
        for (const [a, clue] of modelClues.entries()) {
          clueByAnswer.set(a, clue);
        }
      } catch (e: unknown) {
        console.warn("[generate-crossword] fallback pre-clue request failed", {
          attempt: best.attempt,
          name: e instanceof Error ? e.name : "unknown",
          msg: e instanceof Error ? e.message : String(e),
        });
      }

      reinforceThematicClues(
        theme,
        language,
        Array.from(new Set(finalFallbackDerived.map((e) => e.answer))),
        clueByAnswer,
        fallbackNotesByAnswer,
        contextualFallbackThematicSet
      );

      for (const a of Array.from(new Set(finalFallbackDerived.map((e) => e.answer)))) {
        if (clueByAnswer.has(a)) continue;

        const themed = contextualFallbackThematicSet.has(a);
        if (language === "es") {
          if (themed) {
            const note = bestPartial.notesByAnswer.get(a);
            if (note) {
              const synthesized = clueFromThemeNote(theme, note, language);
              if (synthesized) {
                clueByAnswer.set(a, synthesized);
                continue;
              }
            }
          }

        const specific = themed ? specificThematicFallbackClue(theme, a, language) : null;
        clueByAnswer.set(
          a,
          specific ?? (themed ? `Referencia asociada con ${theme}` : "Entrada comun de crucigrama")
        );
          continue;
        }

        const note = bestPartial.notesByAnswer.get(a);
        if (themed && note) {
          const synthesized = clueFromThemeNote(theme, note, language);
          if (synthesized) {
            clueByAnswer.set(a, synthesized);
            continue;
          }

          const cleaned = note.replace(/\s{2,}/g, " ").trim().replace(/\.$/, "");
          if (cleaned.length >= 8) {
            clueByAnswer.set(a, cleaned);
            continue;
          }
        }

        const specific = themed ? specificThematicFallbackClue(theme, a, language) : null;
        clueByAnswer.set(
          a,
          specific ??
            (themed
              ? `Named thematic item from ${theme}`
              : `Supporting term for the ${theme} puzzle`)
        );
      }

      const finalFallbackThematicSet = new Set(
        Array.from(new Set(finalFallbackDerived.map((e) => e.answer))).filter((a) => {
          if (contextualFallbackThematicSet.has(a)) return true;
          return best.trustedThematicSet.has(a);
        })
      );
      const finalFallbackCoreThematicSet = buildCoreThematicSetFromPool({
        pool: bestPartial.pool,
        trustedThematicSet: best.trustedThematicSet,
        theme,
        language,
        notesByAnswer: fallbackNotesByAnswer,
        clueByAnswer,
      });
      for (const entry of finalFallbackDerived) {
        if (CONTEXTUAL_SUPPORT_ANSWERS.has(entry.answer)) {
          finalFallbackThematicSet.add(entry.answer);
        }
      }
      for (const candidate of fallbackPool) {
        if (candidate.source === "filler") continue;
        if (n === 11 && candidate.source === "support") continue;
        if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
        if (LOW_VALUE_CONTEXTLESS_ANSWERS.has(candidate.answer)) continue;
        if (
          n === 11 &&
          !isCoreThematicCandidate({
            candidate,
            trustedThematicSet: best.trustedThematicSet,
            theme,
            language,
            notesByAnswer: fallbackNotesByAnswer,
            clueByAnswer,
          })
        ) {
          continue;
        }
        finalFallbackThematicSet.add(candidate.answer);
        finalFallbackCoreThematicSet.add(candidate.answer);
      }

      reinforceThematicClues(
        theme,
        language,
        Array.from(new Set(finalFallbackDerived.map((e) => e.answer))),
        clueByAnswer,
        fallbackNotesByAnswer,
        finalFallbackThematicSet
      );

      const safeFinalFallbackGrid =
        finalFallbackDerived.length > 0 ? finalFallbackGrid : bestPartial.built.grid;
      const safeFinalFallbackDerived =
        finalFallbackDerived.length > 0 ? finalFallbackDerived : bestPartial.derived;

      const filteredFallbackDerived =
        n === 11
          ? safeFinalFallbackDerived.filter((e) => finalFallbackThematicSet.has(e.answer))
          : safeFinalFallbackDerived.filter(
              (e) => finalFallbackThematicSet.has(e.answer) || !isOverGenericThemeWordForTheme(theme, e.answer)
            );
      const finalEntriesSource =
        filteredFallbackDerived.length >= (n === 11 ? 3 : 4)
          ? filteredFallbackDerived
          : safeFinalFallbackDerived;

      const rebuiltRenderedFallback = rebuildGridFromEntries(n, finalEntriesSource, minEntryLenForSize(n));
      const renderedFallbackDerived =
        rebuiltRenderedFallback?.derived && rebuiltRenderedFallback.derived.length > 0
          ? rebuiltRenderedFallback.derived
          : finalEntriesSource;

      const clueableFallbackEntries = renderedFallbackDerived.filter((entry) => {
        const answer = entry.answer;
        if (!finalFallbackThematicSet.has(answer)) return n !== 11;
        const existingClue = clueByAnswer.get(answer);
        if (existingClue && !isPlaceholderClue(existingClue, language)) return true;
        const note = fallbackNotesByAnswer.get(answer);
        if (note && clueFromThemeNote(theme, note, language)) return true;
        if (specificThematicFallbackClue(theme, answer, language)) return true;
        return false;
      });

      const finalRenderedFallback =
        clueableFallbackEntries.length >= 3
          ? clueableFallbackEntries
          : renderedFallbackDerived;

      const rebuiltClueableFallback = rebuildGridFromEntries(n, finalRenderedFallback, minEntryLenForSize(n));
      const minimumFallbackEntries = Math.max(3, Math.floor(bestPartial.derived.length * 0.25));
      const fallbackResponseSource =
        rebuiltClueableFallback?.derived && rebuiltClueableFallback.derived.length >= minimumFallbackEntries
          ? rebuiltClueableFallback.derived
          : finalRenderedFallback.length >= minimumFallbackEntries
            ? finalRenderedFallback
            : renderedFallbackDerived.length >= minimumFallbackEntries
              ? renderedFallbackDerived
              : safeFinalFallbackDerived.length >= minimumFallbackEntries
              ? safeFinalFallbackDerived
              : bestPartial.derived;

      const rebuiltFinalResponse = rebuildGridFromEntries(n, fallbackResponseSource, minEntryLenForSize(n));
      const fallbackBasePair =
        safeFinalFallbackDerived.length > 0
          ? { grid: safeFinalFallbackGrid, derived: safeFinalFallbackDerived }
          : { grid: fallbackBuilt.grid, derived: fallbackDerivedSeed };
      const finalFallbackPair =
        rebuiltFinalResponse?.derived && rebuiltFinalResponse.derived.length >= minimumFallbackEntries
          ? { grid: rebuiltFinalResponse.grid, derived: rebuiltFinalResponse.derived }
          : fallbackBasePair;
      const thematicFallbackEntriesForResponse =
        n === 11
          ? finalFallbackPair.derived.filter((e) => finalFallbackThematicSet.has(e.answer))
          : finalFallbackPair.derived;
      const safeThematicFallbackEntriesForResponse =
        thematicFallbackEntriesForResponse.length >= (n === 11 ? 3 : 4)
          ? thematicFallbackEntriesForResponse
          : finalFallbackPair.derived;
      const rebuiltThematicFallback =
        safeThematicFallbackEntriesForResponse.length > 0
          ? rebuildGridFromEntries(n, safeThematicFallbackEntriesForResponse, minEntryLenForSize(n))
          : null;
      const finalFallbackGridForResponse =
        rebuiltThematicFallback?.derived && rebuiltThematicFallback.derived.length > 0
          ? rebuiltThematicFallback.grid
          : finalFallbackPair.derived.length > 0
            ? finalFallbackPair.grid
            : bestPartial.built.grid;
      const finalFallbackEntriesForResponse =
        rebuiltThematicFallback?.derived && rebuiltThematicFallback.derived.length > 0
          ? rebuiltThematicFallback.derived
          : finalFallbackPair.derived.length > 0
            ? finalFallbackPair.derived
            : fallbackDerivedSeed;

      const entries = applyCluesAndOverrides(theme, language, finalFallbackEntriesForResponse, clueByAnswer);
      if (n === 11) {
        const buildFastPublishCandidate = (grid: string[][], derived: DerivedEntry[], source: string) => {
          const publishEntries = pruneForbiddenPublishAnswersIfPossible(
            pruneMaskedDuplicateAnswers(
              repairPublishClues(applyCluesAndOverrides(theme, language, derived, clueByAnswer), {
                theme,
                language,
                thematicSet: finalFallbackThematicSet,
                notesByAnswer: fallbackNotesByAnswer,
              })
            ),
            minPublishEntriesForSize(n)
          ).filter((entry) =>
            isPublishableAnswerForTheme({
              theme,
              answer: entry.answer,
              language,
              size: n,
              note: fallbackNotesByAnswer.get(entry.answer),
              allowContextualGeneric: finalFallbackThematicSet.has(entry.answer),
            })
          );
          const entryCrossings = entryCrossingStats(grid, publishEntries, minEntryLenForSize(n));
          const checked = checkedCellStats(grid, minEntryLenForSize(n));
          const crossed = crossedEntryStats(grid, publishEntries, minEntryLenForSize(n));
          const thematicEntries = publishEntries.filter((entry) =>
            finalFallbackThematicSet.has(entry.answer)
          ).length;
          const coreThematicEntries = publishEntries.filter((entry) =>
            finalFallbackCoreThematicSet.has(entry.answer)
          ).length;
          const genericContextEntries = publishEntries.filter(
            (entry) => finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
          ).length;
          const qualityIssue = publishQualityIssue(
            publishEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const hasShortRuns = hasShortLetterRuns(grid, minEntryLenForSize(n));

          return {
            source,
            grid,
            entries: publishEntries,
            entryCrossings,
            checked,
            crossed,
            thematicEntries,
            coreThematicEntries,
            genericContextEntries,
            qualityIssue,
            hasShortRuns,
            valid:
              publishEntries.length >= minPublishEntriesForSize(n) &&
              crossed.crossed >= minCrossedEntriesForPublish(n) &&
              entryCrossings.weakEntries.length === 0 &&
              checked.ratio >= 0.25 &&
              thematicEntries >= minThematicEntriesForPublish(n, publishEntries.length) &&
              coreThematicEntries >= minCoreThematicEntriesForPublish(n, publishEntries.length) &&
              genericContextEntries <= maxGenericContextEntriesForPublish(n, publishEntries.length) &&
              !hasShortRuns &&
              !qualityIssue,
          };
        };

        const fastBaseGrid = hasShortLetterRuns(finalFallbackGridForResponse, minEntryLenForSize(n))
          ? blockShortRunsOnly(finalFallbackGridForResponse, minEntryLenForSize(n))
          : finalFallbackGridForResponse;
        const fastBaseDerived = deriveEntriesFromGrid(fastBaseGrid, minEntryLenForSize(n));
        const fastBaseEntries =
          fastBaseDerived.length >= Math.max(minPublishEntriesForSize(n) - 3, finalFallbackEntriesForResponse.length - 3)
            ? fastBaseDerived
            : finalFallbackEntriesForResponse;
        const fastBaseGridForEntries = fastBaseEntries === fastBaseDerived ? fastBaseGrid : finalFallbackGridForResponse;

        let fastCandidate = buildFastPublishCandidate(
          fastBaseGridForEntries,
          fastBaseEntries,
          "fallback-fast-best-11"
        );

        if (
          !fastCandidate.valid &&
          fastCandidate.entries.length >= minPublishEntriesForSize(n) - 3 &&
          (fastCandidate.entries.length < minPublishEntriesForSize(n) ||
            fastCandidate.entryCrossings.weakEntries.length > 0 ||
            fastCandidate.hasShortRuns) &&
          fastCandidate.entryCrossings.weakEntries.length <= 4 &&
          Date.now() < deadlineMs - 8_000
        ) {
          const fastRepaired = densifyCleanGrid11({
            theme,
            grid: fastBaseGridForEntries,
            candidates: fallbackPool,
            targetEntries: minPublishEntriesForSize(n),
            seed: (fallbackStrictSeed ^ 0x7f4a7c15 ^ Math.imul(fastCandidate.entries.length + 1, 257)) >>> 0,
            deadlineMs: Math.min(deadlineMs - 1_000, Date.now() + 7_000),
            pruneWeakEntries: false,
          });

          if (fastRepaired) {
            const repairedCandidate = buildFastPublishCandidate(
              fastRepaired.grid,
              fastRepaired.derived,
              "fallback-fast-repaired-11"
            );
            if (
              repairedCandidate.valid ||
              repairedCandidate.entryCrossings.weakEntries.length < fastCandidate.entryCrossings.weakEntries.length
            ) {
              fastCandidate = repairedCandidate;
            }
          }
        }

        if (fastCandidate.valid) {
          console.warn("[generate-crossword] FALLBACK -> fast publish 11x11", {
            source: fastCandidate.source,
            entries: fastCandidate.entries.length,
            thematicEntries: fastCandidate.thematicEntries,
            coreThematicEntries: fastCandidate.coreThematicEntries,
            genericContextEntries: fastCandidate.genericContextEntries,
            checkedRatio: fastCandidate.checked.ratio,
          });

          return publishCrosswordResponse(
            {
              theme,
              language,
              size: n,
              grid: fastCandidate.grid,
              entries: fastCandidate.entries,
              meta: {
                source: fastCandidate.source,
                targetEntries: minPublishEntriesForSize(n),
                entries: fastCandidate.entries.length,
                thematicEntries: fastCandidate.thematicEntries,
                coreThematicEntries: fastCandidate.coreThematicEntries,
                genericContextEntries: fastCandidate.genericContextEntries,
                crossedEntries: fastCandidate.crossed.crossed,
                checkedRatio: fastCandidate.checked.ratio,
                minEntryCheckedCells: fastCandidate.entryCrossings.minCheckedCells,
                weakCrossingEntries: fastCandidate.entryCrossings.weakEntries,
                ...fallbackBuilt.meta,
              },
            } satisfies Crossword
          );
        }

        if (Date.now() > deadlineMs - 12_000) {
          return makeGenerationErrorResponse(
            {
              source: "generation-time-budget",
              reason: "Se agoto el tiempo de construccion antes de obtener un 11x11 completamente chequeado.",
              finalEntries: fastCandidate.entries.length,
              minEntries: minPublishEntriesForSize(n),
              finalThematicEntries: fastCandidate.thematicEntries,
              finalCoreThematicEntries: fastCandidate.coreThematicEntries,
              finalGenericContextEntries: fastCandidate.genericContextEntries,
              minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
              weakCrossingEntries: fastCandidate.entryCrossings.weakEntries,
              finalHasShortRuns: fastCandidate.hasShortRuns,
              finalQualityIssue: fastCandidate.qualityIssue,
              checkedRatio: fastCandidate.checked.ratio,
              lastAnswerStats,
              lastBuildIssue,
            },
            422
          );
        }
      }
      const cluedFallbackAnswerSet = new Set(
        Array.from(new Set(entries.map((e) => e.answer))).filter((a) => {
          if (isOverGenericThemeWordForTheme(theme, a)) return false;
          return hasStrongThematicClueSupport({
            theme,
            answer: a,
            language,
            note: fallbackNotesByAnswer.get(a),
            clue: clueByAnswer.get(a),
          });
        })
      );
      const publishableFallbackAnswerSet: Set<string> =
        n === 11
          ? new Set<string>([...finalFallbackThematicSet, ...cluedFallbackAnswerSet])
          : new Set<string>(
              bestPartial.pool
                .filter((c) => c.source !== "filler" && !isOverGenericThemeWordForTheme(theme, c.answer))
                .map((c) => c.answer)
            );
      const broadPublishableFallbackAnswerSet: Set<string> =
        n === 11
          ? publishableFallbackAnswerSet
          : publishableFallbackAnswerSet;
      const fullyCheckedFallback = rebuildFullyCheckedPublishableCrossword(
        theme,
        n,
        finalFallbackGridForResponse,
        language,
        publishableFallbackAnswerSet,
        clueByAnswer,
        n === 11 ? 6 : 4
      );
      const sanitizedFullyCheckedFallback =
        n === 11 && !(fullyCheckedFallback && fullyCheckedFallback.entries.length >= 6)
          ? rebuildSanitizedFullyCheckedPublishableCrossword(
              theme,
              n,
              finalFallbackGridForResponse,
              language,
              publishableFallbackAnswerSet,
              clueByAnswer,
              4
            )
          : null;
      const minimalFullyCheckedFallback =
        n === 11 && !(fullyCheckedFallback && fullyCheckedFallback.entries.length >= 6)
          ? rebuildFullyCheckedPublishableCrossword(
              theme,
              n,
              finalFallbackGridForResponse,
              language,
              publishableFallbackAnswerSet,
              clueByAnswer,
              2
            )
          : null;
      const minimalSanitizedFullyCheckedFallback =
        n === 11 &&
        !(sanitizedFullyCheckedFallback && sanitizedFullyCheckedFallback.entries.length >= 4)
          ? rebuildSanitizedFullyCheckedPublishableCrossword(
              theme,
              n,
              finalFallbackGridForResponse,
              language,
              publishableFallbackAnswerSet,
              clueByAnswer,
              2
            )
          : null;
      const playableFallback = rebuildPlayableCrossword(
        theme,
        n,
        entries,
        language,
        n === 11 ? strongThematicSet : thematicSet
      );
      const exactFullyCheckedFallback = rebuildExactFullyCheckedPublishableCrossword(
        theme,
        n,
        entries,
        language,
        publishableFallbackAnswerSet,
        n === 11 ? 4 : 3
      );
      const exactPublishableFallback = rebuildExactPublishableCrossword(
        theme,
        n,
        entries,
        language,
        publishableFallbackAnswerSet
      );
      const cluedExactPublishableFallback =
        n === 11 && !exactPublishableFallback
          ? rebuildExactPublishableCrossword(
              theme,
              n,
              entries,
              language,
              cluedFallbackAnswerSet,
              2
            )
          : null;
      const minimalExactPublishableFallback =
        n === 11 && !exactPublishableFallback && !cluedExactPublishableFallback
          ? rebuildExactPublishableCrossword(
              theme,
              n,
              entries,
              language,
              publishableFallbackAnswerSet,
              2
            )
          : null;
      const minimalExactFullyCheckedFallback =
        n === 11 &&
        !(exactFullyCheckedFallback && exactFullyCheckedFallback.entries.length >= 4)
          ? rebuildExactFullyCheckedPublishableCrossword(
              theme,
              n,
              entries,
              language,
              publishableFallbackAnswerSet,
              2
            )
          : null;
      const broadMinimalExactFullyCheckedFallback =
        n === 11 &&
        !(minimalExactFullyCheckedFallback && minimalExactFullyCheckedFallback.entries.length >= 2)
          ? rebuildExactFullyCheckedPublishableCrossword(
              theme,
              n,
              entries,
              language,
              broadPublishableFallbackAnswerSet,
              2
            )
          : null;
      const broadMinimalFullyCheckedFallback =
        n === 11 &&
        !(minimalFullyCheckedFallback && minimalFullyCheckedFallback.entries.length >= 2)
          ? rebuildFullyCheckedPublishableCrossword(
              theme,
              n,
              finalFallbackGridForResponse,
              language,
              broadPublishableFallbackAnswerSet,
              clueByAnswer,
              2
            )
          : null;
      if (
        n === 11 &&
        !(fullyCheckedFallback && fullyCheckedFallback.entries.length >= 6) &&
        !(sanitizedFullyCheckedFallback && sanitizedFullyCheckedFallback.entries.length >= 4) &&
        !(exactFullyCheckedFallback && exactFullyCheckedFallback.entries.length >= 4) &&
        !(minimalFullyCheckedFallback && minimalFullyCheckedFallback.entries.length >= 2) &&
        !(minimalSanitizedFullyCheckedFallback && minimalSanitizedFullyCheckedFallback.entries.length >= 2) &&
        !(minimalExactFullyCheckedFallback && minimalExactFullyCheckedFallback.entries.length >= 2) &&
        !(broadMinimalFullyCheckedFallback && broadMinimalFullyCheckedFallback.entries.length >= 2) &&
        !(broadMinimalExactFullyCheckedFallback && broadMinimalExactFullyCheckedFallback.entries.length >= 2) &&
        !exactPublishableFallback &&
        !(cluedExactPublishableFallback && cluedExactPublishableFallback.entries.length >= 2) &&
        !minimalExactPublishableFallback &&
        !(playableFallback && playableFallback.entries.length >= 3)
      ) {
        if (sanitizedFullyCheckedFallback && sanitizedFullyCheckedFallback.entries.length >= 3) {
          const sanitizedPlaceholderCount = sanitizedFullyCheckedFallback.entries.filter((e) =>
            isPlaceholderClue(e.clue, language)
          ).length;
          const sanitizedCheckedStats = checkedCellStats(
            sanitizedFullyCheckedFallback.grid,
            minEntryLenForSize(n)
          );

          console.warn("[generate-crossword] FALLBACK -> sanitized bestPartial", {
            attempt: bestPartial.attempt,
            entries: sanitizedFullyCheckedFallback.entries.length,
            checkedRatio: sanitizedCheckedStats.ratio,
            fallbackScore: bestPartial.fallbackScore,
            placeholderCount: sanitizedPlaceholderCount,
            builder: fallbackBuilt.meta?.builder ?? null,
          });

          return publishCrosswordResponse(
            {
              theme,
              language,
              size: n,
              grid: sanitizedFullyCheckedFallback.grid,
              entries: sanitizedFullyCheckedFallback.entries,
              meta: {
                source: "fallback-best-built-sanitized",
                attempt: best.attempt,
                fallbackScore: best.fallbackScore,
                checkedRatio: sanitizedCheckedStats.ratio,
                placeholderCount: sanitizedPlaceholderCount,
                ...fallbackBuilt.meta,
              },
            } satisfies Crossword
          );
        }

        const strictRepackRescuePools: WordCandidate[][] = [
          fallbackPool.filter(
            (c) => c.source !== "filler" && broadPublishableFallbackAnswerSet.has(c.answer)
          ),
          fallbackPool.filter(
            (c) => c.source !== "filler" && broadFallbackAllowedAnswers.has(c.answer)
          ),
        ];
        const strictRepackSeeds: number[] = Array.from({ length: n === 11 ? 2 : 8 }, (_, idx) =>
          (fallbackStrictSeed ^ Math.imul(idx + 1, 0x9e3779b9)) >>> 0
        );

        let checkedStrictRepackFallback:
          | { grid: string[][]; entries: Entry[]; meta: Record<string, unknown> }
          | null = null;

        for (const candidatePool of strictRepackRescuePools) {
          if (checkedStrictRepackFallback) break;
          if (Date.now() >= fallbackDeadlineMs - 300) break;
          if (candidatePool.length < 6) continue;

          for (const seed of strictRepackSeeds) {
            if (Date.now() >= fallbackDeadlineMs - 300) break;
            const repacked = constructStrictCrossword11({
              theme,
              size: n,
              seed,
              candidates: candidatePool,
              deadlineMs: fallbackDeadlineMs,
            });
            if (!repacked) continue;

            const repackedDerived = deriveEntriesFromGrid(
              repacked.grid,
              minEntryLenForSize(n)
            );
            if (repackedDerived.length < 2) continue;

            const repackedEntries = applyCluesAndOverrides(
              theme,
              language,
              repackedDerived,
              clueByAnswer
            );
            const repackedAllowedAnswers: Set<string> = new Set<string>(
              repackedEntries
                .filter((e) => !isPlaceholderClue(e.clue, language))
                .map((e) => e.answer)
                .filter((a) => !isOverGenericThemeWordForTheme(theme, a))
            );
            if (repackedAllowedAnswers.size < 2) continue;

            const exactChecked = rebuildExactFullyCheckedPublishableCrossword(
              theme,
              n,
              repackedEntries,
              language,
              repackedAllowedAnswers,
              2
            );
            if (!exactChecked) continue;

            checkedStrictRepackFallback = {
              grid: exactChecked.grid,
              entries: exactChecked.entries,
              meta: {
                source: "fallback-best-built-strict-repack",
                seed,
                candidatePool: candidatePool.length,
                builder: repacked.meta?.builder ?? "pattern-11x11-strict",
              },
            };
            break;
          }
        }

        if (checkedStrictRepackFallback) {
          const strictRepackStats = checkedCellStats(
            checkedStrictRepackFallback.grid,
            minEntryLenForSize(n)
          );
          const strictRepackPlaceholderCount = checkedStrictRepackFallback.entries.filter((e) =>
            isPlaceholderClue(e.clue, language)
          ).length;
          const strictRepackQualityIssue = publishQualityIssue(
            checkedStrictRepackFallback.entries,
            broadPublishableFallbackAnswerSet,
            language,
            minPublishEntriesForSize(n)
          );
          if (!strictRepackQualityIssue) {
          console.warn("[generate-crossword] FALLBACK -> strict repack checked", {
            attempt: bestPartial.attempt,
            entries: checkedStrictRepackFallback.entries.length,
            checkedRatio: strictRepackStats.ratio,
            fallbackScore: bestPartial.fallbackScore,
            ...checkedStrictRepackFallback.meta,
          });

          return publishCrosswordResponse(
            {
              theme,
              language,
              size: n,
              grid: checkedStrictRepackFallback.grid,
              entries: checkedStrictRepackFallback.entries,
              meta: {
                attempt: best.attempt,
                fallbackScore: best.fallbackScore,
                checkedRatio: strictRepackStats.ratio,
                placeholderCount: strictRepackPlaceholderCount,
                ...fallbackBuilt.meta,
                ...checkedStrictRepackFallback.meta,
              },
            } satisfies Crossword
          );
          }
        }

        const finalStrictRescuePoolMap = new Map<string, WordCandidate>();
        for (const candidate of [...fallbackPool, ...lastAttemptPool]) {
          if (candidate.source === "filler") continue;
          if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
          if (!finalStrictRescuePoolMap.has(candidate.answer)) {
            finalStrictRescuePoolMap.set(candidate.answer, candidate);
          }
        }
        const finalStrictRescuePool = Array.from(finalStrictRescuePoolMap.values());
        const finalStrictRescueSeeds: number[] = Array.from({ length: n === 11 ? 2 : 16 }, (_, idx) =>
          (fallbackStrictSeed ^ Math.imul(idx + 1, 0x85ebca6b)) >>> 0
        );

        let checkedFinalStrictRescue:
          | { grid: string[][]; entries: Entry[]; meta: Record<string, unknown> }
          | null = null;

        if (finalStrictRescuePool.length >= 6) {
          for (const seed of finalStrictRescueSeeds) {
            if (Date.now() >= fallbackDeadlineMs - 300) break;
            const repacked = constructStrictCrossword11({
              theme,
              size: n,
              seed,
              candidates: finalStrictRescuePool,
              deadlineMs: fallbackDeadlineMs,
            });
            if (!repacked) continue;

            const repackedDerived = deriveEntriesFromGrid(
              repacked.grid,
              minEntryLenForSize(n)
            );
            if (repackedDerived.length < 2) continue;

            const repackedEntries = applyCluesAndOverrides(
              theme,
              language,
              repackedDerived,
              clueByAnswer
            );
            const repackedAllowedAnswers: Set<string> = new Set<string>(
              repackedEntries
                .filter((e) => !isPlaceholderClue(e.clue, language))
                .map((e) => e.answer)
                .filter((a) => !isOverGenericThemeWordForTheme(theme, a))
            );
            if (repackedAllowedAnswers.size < 2) continue;

            const exactChecked =
              rebuildExactFullyCheckedPublishableCrossword(
                theme,
                n,
                repackedEntries,
                language,
                repackedAllowedAnswers,
                2
              ) ??
              rebuildFullyCheckedPublishableCrossword(
                theme,
                n,
                repacked.grid,
                language,
                repackedAllowedAnswers,
                clueByAnswer,
                2
              );
            if (!exactChecked) continue;

            checkedFinalStrictRescue = {
              grid: exactChecked.grid,
              entries: exactChecked.entries,
              meta: {
                source: "fallback-best-built-final-strict",
                seed,
                candidatePool: finalStrictRescuePool.length,
                builder: repacked.meta?.builder ?? "pattern-11x11-strict",
              },
            };
            break;
          }
        }

        if (checkedFinalStrictRescue) {
          const finalStrictStats = checkedCellStats(
            checkedFinalStrictRescue.grid,
            minEntryLenForSize(n)
          );
          const finalStrictPlaceholderCount = checkedFinalStrictRescue.entries.filter((e) =>
            isPlaceholderClue(e.clue, language)
          ).length;
          const finalStrictQualityIssue = publishQualityIssue(
            checkedFinalStrictRescue.entries,
            new Set(finalStrictRescuePoolMap.keys()),
            language,
            minPublishEntriesForSize(n)
          );
          if (!finalStrictQualityIssue) {
          console.warn("[generate-crossword] FALLBACK -> final strict checked rescue", {
            attempt: bestPartial.attempt,
            entries: checkedFinalStrictRescue.entries.length,
            checkedRatio: finalStrictStats.ratio,
            fallbackScore: bestPartial.fallbackScore,
            ...checkedFinalStrictRescue.meta,
          });

          return publishCrosswordResponse(
            {
              theme,
              language,
              size: n,
              grid: checkedFinalStrictRescue.grid,
              entries: checkedFinalStrictRescue.entries,
              meta: {
                attempt: best.attempt,
                fallbackScore: best.fallbackScore,
                checkedRatio: finalStrictStats.ratio,
                placeholderCount: finalStrictPlaceholderCount,
                ...fallbackBuilt.meta,
                ...checkedFinalStrictRescue.meta,
              },
            } satisfies Crossword
          );
          }
        }

      }
      const checkedFallbackForResponse =
        n === 11 && fullyCheckedFallback && fullyCheckedFallback.entries.length >= minPublishEntriesForSize(n)
          ? fullyCheckedFallback
          : n === 11 && sanitizedFullyCheckedFallback && sanitizedFullyCheckedFallback.entries.length >= minPublishEntriesForSize(n)
          ? sanitizedFullyCheckedFallback
          : n === 11 && exactFullyCheckedFallback && exactFullyCheckedFallback.entries.length >= minPublishEntriesForSize(n)
          ? exactFullyCheckedFallback
          : null;

      if (n === 11) {
        if (!checkedFallbackForResponse) {
          const directCandidateOptions: Array<{ grid: string[][]; derived: DerivedEntry[] }> = [];
          const minLenForFallback = minEntryLenForSize(n);

          const rebuiltFromEntries = rebuildGridFromEntries(n, entries, minLenForFallback);
          if (rebuiltFromEntries) {
            const cleaned = blockForbiddenAnswerRuns(rebuiltFromEntries.grid, minLenForFallback);
            const cleanedDerived = deriveEntriesFromGrid(cleaned, minLenForFallback);
            directCandidateOptions.push({
              grid: cleanedDerived.length > 0 ? cleaned : rebuiltFromEntries.grid,
              derived: cleanedDerived.length > 0 ? cleanedDerived : rebuiltFromEntries.derived,
            });
          }

          const augmented = augmentNoShortGridWithCandidates(
            finalFallbackGridForResponse,
            bestPartial.pool,
            minLenForFallback,
            desiredPublishEntriesForSize(n),
            minPublishEntriesForSize(n)
          ) ?? augmentNoShortGridWithCandidates(
            finalFallbackGridForResponse,
            bestPartial.pool,
            minLenForFallback,
            minPublishEntriesForSize(n)
          );
          if (augmented) {
            const cleaned = blockForbiddenAnswerRuns(augmented.grid, minLenForFallback);
            const cleanedDerived = deriveEntriesFromGrid(cleaned, minLenForFallback);
            directCandidateOptions.push({
              grid: cleanedDerived.length > 0 ? cleaned : augmented.grid,
              derived: cleanedDerived.length > 0 ? cleanedDerived : augmented.derived,
            });
          }

          if (hasShortLetterRuns(finalFallbackGridForResponse, minLenForFallback)) {
            const lightlyBlocked = blockShortRunsOnly(finalFallbackGridForResponse, minLenForFallback);
            directCandidateOptions.push({
              grid: lightlyBlocked,
              derived: deriveEntriesFromGrid(lightlyBlocked, minLenForFallback),
            });

            const sanitized = sanitizeUncheckedGrid(finalFallbackGridForResponse, minLenForFallback);
            const cleanedSanitized = blockForbiddenAnswerRuns(sanitized, minLenForFallback);
            const cleanedSanitizedDerived = deriveEntriesFromGrid(cleanedSanitized, minLenForFallback);
            directCandidateOptions.push({
              grid: cleanedSanitizedDerived.length > 0 ? cleanedSanitized : sanitized,
              derived:
                cleanedSanitizedDerived.length > 0
                  ? cleanedSanitizedDerived
                  : deriveEntriesFromGrid(sanitized, minLenForFallback),
            });
          }

          const cleanedFinalFallback = blockForbiddenAnswerRuns(finalFallbackGridForResponse, minLenForFallback);
          const cleanedFinalFallbackDerived = deriveEntriesFromGrid(cleanedFinalFallback, minLenForFallback);
          directCandidateOptions.push({
            grid: cleanedFinalFallbackDerived.length > 0 ? cleanedFinalFallback : finalFallbackGridForResponse,
            derived:
              cleanedFinalFallbackDerived.length > 0
                ? cleanedFinalFallbackDerived
                : deriveEntriesFromGrid(finalFallbackGridForResponse, minLenForFallback),
          });

          const rankedDirectCandidateOptions = directCandidateOptions
            .slice()
            .sort((a, b) => {
              const score = (candidate: { grid: string[][]; derived: DerivedEntry[] }) => {
                const checked = checkedCellStats(candidate.grid, minLenForFallback);
                const crossed = crossedEntryStats(candidate.grid, candidate.derived, minLenForFallback);
                const entryCrossings = entryCrossingStats(candidate.grid, candidate.derived, minLenForFallback);
                const shortPenalty = hasShortLetterRuns(candidate.grid, minLenForFallback) ? 100000 : 0;
                const forbiddenPenalty = candidate.derived.filter((entry) =>
                  isForbiddenPublishAnswer(entry.answer)
                ).length * 120000;
                const weakCrossingPenalty = entryCrossings.weakEntries.length * 80000;
                const themeCount = candidate.derived.filter((entry) =>
                  finalFallbackThematicSet.has(entry.answer)
                ).length;
                const coreThemeCount = candidate.derived.filter((entry) =>
                  finalFallbackCoreThematicSet.has(entry.answer)
                ).length;
                return (
                  candidate.derived.length * 10000 +
                  Math.min(candidate.derived.length, desiredPublishEntriesForSize(n)) * 3000 +
                  Math.max(0, candidate.derived.length - minPublishEntriesForSize(n)) * 6000 +
                  themeCount * 4500 +
                  coreThemeCount * 9000 +
                  crossed.crossed * 1500 +
                  checked.ratio * 1000 -
                  weakCrossingPenalty -
                  forbiddenPenalty -
                  shortPenalty
                );
              };
              return score(b) - score(a);
            });

          const hasPublishableShape = (candidate: { grid: string[][]; derived: DerivedEntry[] }) => {
            if (candidate.derived.length < minPublishEntriesForSize(n)) return false;
            if (hasShortLetterRuns(candidate.grid, minLenForFallback)) return false;
            if (candidate.derived.some((entry) => isForbiddenPublishAnswer(entry.answer))) return false;
            if (
              entryCrossingStats(candidate.grid, candidate.derived, minLenForFallback).weakEntries.length > 0
            ) {
              return false;
            }

            const themeCount = candidate.derived.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const coreThemeCount = candidate.derived.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const genericContextCount = candidate.derived.filter(
              (entry) => finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const minTheme = minThematicEntriesForPublish(n, candidate.derived.length);
            const minCore = minCoreThematicEntriesForPublish(n, candidate.derived.length);
            const maxGeneric = maxGenericContextEntriesForPublish(n, candidate.derived.length);

            return (
              themeCount >= minTheme &&
              coreThemeCount >= minCore &&
              genericContextCount <= maxGeneric
            );
          };

          const directCandidateOptionsWithoutForbidden = rankedDirectCandidateOptions.filter(
            (candidate) =>
              !candidate.derived.some(
                (entry) =>
                  isForbiddenPublishAnswer(entry.answer) ||
                  (isLikelyBadAnswer(entry.answer) && !ALWAYS_ALLOW_ANSWERS.has(entry.answer))
              )
          );
          const directCandidateSelectionOptions =
            directCandidateOptionsWithoutForbidden.length > 0
              ? directCandidateOptionsWithoutForbidden
              : rankedDirectCandidateOptions;

          const directCandidate =
            directCandidateSelectionOptions.find(
              (candidate) =>
                candidate.derived.length >= desiredPublishEntriesForSize(n) &&
                hasPublishableShape(candidate)
            ) ??
            directCandidateSelectionOptions.find(hasPublishableShape) ??
            directCandidateSelectionOptions.find(
              (candidate) =>
                candidate.derived.length >= desiredPublishEntriesForSize(n) &&
                !hasShortLetterRuns(candidate.grid, minLenForFallback)
            ) ??
            directCandidateSelectionOptions.find(
              (candidate) =>
                candidate.derived.length >= minPublishEntriesForSize(n) &&
                !hasShortLetterRuns(candidate.grid, minLenForFallback)
            ) ??
            directCandidateSelectionOptions.find((candidate) => candidate.derived.length >= minPublishEntriesForSize(n)) ??
            directCandidateSelectionOptions.find((candidate) => candidate.derived.length > 0) ??
            {
              grid: finalFallbackGridForResponse,
              derived: entries.map((entry) => ({
                number: entry.number,
                row: entry.row,
                col: entry.col,
                direction: entry.direction,
                answer: entry.answer,
              })),
            };

          const directFallbackGridCandidate = directCandidate.grid;
          const directFallbackDerivedCandidate = deriveEntriesFromGrid(
            directFallbackGridCandidate,
            minLenForFallback
          );
          const directFallbackEntryByKey = new Map(
            entries.map((entry) => [
              `${entry.direction}:${entry.row}:${entry.col}:${entry.answer}`,
              entry,
            ])
          );
          const directFallbackEntriesCandidateRaw = directFallbackDerivedCandidate.map((derived) => {
            const key = `${derived.direction}:${derived.row}:${derived.col}:${derived.answer}`;
            return directFallbackEntryByKey.get(key) ?? { ...derived, clue: clueByAnswer.get(derived.answer) ?? "" };
          });
          const directFallbackEntriesCandidate = pruneForbiddenPublishAnswersIfPossible(
            pruneMaskedDuplicateAnswers(
              repairPublishClues(directFallbackEntriesCandidateRaw, {
                theme,
                language,
                thematicSet: finalFallbackThematicSet,
                notesByAnswer: fallbackNotesByAnswer,
              })
            ),
            minPublishEntriesForSize(n)
          );
          const directFallbackRawQualityIssue = publishQualityIssue(
            directFallbackEntriesCandidate,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const directFallbackNeedsRebuild =
            Boolean(directFallbackRawQualityIssue) ||
            directFallbackEntriesCandidate.length !== directFallbackEntriesCandidateRaw.length;
          const directFallbackFilteredEntries = directFallbackEntriesCandidate.filter((entry) => {
            if (MODEL_FRAGMENT_ANSWERS.has(entry.answer)) return false;
            if (BANNED_ANSWERS.has(entry.answer) && !CONTEXTUAL_GENERIC_ANSWERS.has(entry.answer)) return false;
            if (
              !isPublishableAnswerForTheme({
                theme,
                answer: entry.answer,
                language,
                size: n,
                note: fallbackNotesByAnswer.get(entry.answer),
                allowContextualGeneric: finalFallbackThematicSet.has(entry.answer),
              })
            ) {
              return false;
            }
            if (!finalFallbackThematicSet.has(entry.answer) && LOW_VALUE_CONTEXTLESS_ANSWERS.has(entry.answer)) return false;
            if (n === 11 && !finalFallbackThematicSet.has(entry.answer)) return false;
            if (isPlaceholderClue(entry.clue, language) || isBadClue(entry.clue)) return false;
            if (!clueLanguageLooksValid(entry.clue, language)) return false;
            if (clueMentionsAnswer(entry.clue, entry.answer)) return false;
            return true;
          });
          const directFallbackAllowedAnswers = new Set(directFallbackFilteredEntries.map((entry) => entry.answer));
          const directFallbackExactFiltered =
            directFallbackNeedsRebuild && directFallbackFilteredEntries.length >= minPublishEntriesForSize(n)
              ? rebuildExactPublishableCrossword(
                  theme,
                  n,
                  directFallbackFilteredEntries,
                  language,
                  directFallbackAllowedAnswers,
                  minPublishEntriesForSize(n)
                )
              : null;
          const directFallbackRebuiltFiltered =
            directFallbackNeedsRebuild && !directFallbackExactFiltered && directFallbackFilteredEntries.length >= minPublishEntriesForSize(n)
              ? rebuildGridFromEntries(n, directFallbackFilteredEntries, minLenForFallback) ??
                rebuildGridFromAllowedEntries(directFallbackGridCandidate, directFallbackAllowedAnswers, minLenForFallback)
              : null;
          const directFallbackRebuiltEntries =
            directFallbackRebuiltFiltered?.derived && directFallbackRebuiltFiltered.derived.length > 0
              ? repairPublishClues(
                  applyCluesAndOverrides(theme, language, directFallbackRebuiltFiltered.derived, clueByAnswer),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              : null;
          const replacementDirectFallbackCandidates: Array<{ grid: string[][]; entries: Entry[] }> = [];
          if (directFallbackExactFiltered) {
            replacementDirectFallbackCandidates.push({
              grid: directFallbackExactFiltered.grid,
              entries: directFallbackExactFiltered.entries,
            });
          }
          if (directFallbackRebuiltFiltered && directFallbackRebuiltEntries) {
            replacementDirectFallbackCandidates.push({
              grid: directFallbackRebuiltFiltered.grid,
              entries: directFallbackRebuiltEntries,
            });
          }

          let directFallbackPublishGrid = directFallbackGridCandidate;
          let directFallbackPublishEntries = directFallbackEntriesCandidate;
          for (const candidate of replacementDirectFallbackCandidates) {
            const candidateChecked = checkedCellStats(candidate.grid, minEntryLenForSize(n));
            const candidateCrossed = crossedEntryStats(candidate.grid, candidate.entries, minEntryLenForSize(n));
            const candidateQualityIssue = publishQualityIssue(
              candidate.entries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );

            if (
              candidate.entries.length >= minPublishEntriesForSize(n) &&
              candidateCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              candidateChecked.ratio >= 0.25 &&
              !hasShortLetterRuns(candidate.grid, minEntryLenForSize(n)) &&
              !candidateQualityIssue
            ) {
              directFallbackPublishGrid = candidate.grid;
              directFallbackPublishEntries = candidate.entries;
              break;
            }
          }

          const directFallbackPreAugmentQualityIssue = publishQualityIssue(
            directFallbackPublishEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );

          if (
            directFallbackPublishEntries.length < desiredPublishEntriesForSize(n) ||
            directFallbackPreAugmentQualityIssue
          ) {
            const cleanBaseRebuild =
              directFallbackFilteredEntries.length > 0 &&
              directFallbackFilteredEntries.length < directFallbackPublishEntries.length
                ? rebuildGridFromEntries(n, directFallbackFilteredEntries, minLenForFallback) ??
                  rebuildGridFromAllowedEntries(
                    directFallbackPublishGrid,
                    directFallbackAllowedAnswers,
                    minLenForFallback
                  )
                : null;
            const augmentBaseGrid =
              cleanBaseRebuild?.grid ??
              (directFallbackPreAugmentQualityIssue ? null : directFallbackPublishGrid);
            const augmentedAfterPrune = augmentBaseGrid
                ? augmentNoShortGridWithCandidates(
                  augmentBaseGrid,
                  fallbackPool.filter((candidate) => candidate.source !== "filler"),
                  minLenForFallback,
                  desiredPublishEntriesForSize(n),
                  minPublishEntriesForSize(n)
                ) ?? augmentNoShortGridWithCandidates(
                  augmentBaseGrid,
                  fallbackPool.filter((candidate) => candidate.source !== "filler"),
                  minLenForFallback,
                  minPublishEntriesForSize(n)
                )
              : null;

            if (augmentedAfterPrune) {
              const augmentedEntries = pruneMaskedDuplicateAnswers(
                repairPublishClues(
                  applyCluesAndOverrides(theme, language, augmentedAfterPrune.derived, clueByAnswer),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              );
              const augmentedQualityIssue = publishQualityIssue(
                augmentedEntries,
                finalFallbackThematicSet,
                language,
                minPublishEntriesForSize(n)
              );
              const augmentedCrossed = crossedEntryStats(
                augmentedAfterPrune.grid,
                augmentedEntries,
                minEntryLenForSize(n)
              );
              const augmentedChecked = checkedCellStats(augmentedAfterPrune.grid, minEntryLenForSize(n));

              if (
                augmentedEntries.length >= minPublishEntriesForSize(n) &&
                augmentedCrossed.crossed >= minCrossedEntriesForPublish(n) &&
                augmentedChecked.ratio >= 0.25 &&
                !hasShortLetterRuns(augmentedAfterPrune.grid, minEntryLenForSize(n)) &&
                !augmentedQualityIssue
              ) {
                directFallbackPublishGrid = augmentedAfterPrune.grid;
                directFallbackPublishEntries = augmentedEntries;
              }
            }
          }

          const cleanedPublishGrid = blockForbiddenAnswerRuns(
            directFallbackPublishGrid,
            minEntryLenForSize(n)
          );
          const cleanedPublishDerived = deriveEntriesFromGrid(
            cleanedPublishGrid,
            minEntryLenForSize(n)
          );
          if (cleanedPublishDerived.length >= minPublishEntriesForSize(n)) {
            const cleanedPublishEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(
                applyCluesAndOverrides(theme, language, cleanedPublishDerived, clueByAnswer),
                {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                }
              )
            );
            const cleanedPublishCrossed = crossedEntryStats(
              cleanedPublishGrid,
              cleanedPublishEntries,
              minEntryLenForSize(n)
            );
            const cleanedPublishChecked = checkedCellStats(cleanedPublishGrid, minEntryLenForSize(n));

            if (
              cleanedPublishEntries.length >= minPublishEntriesForSize(n) &&
              cleanedPublishCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              cleanedPublishChecked.ratio >= 0.25 &&
              !hasShortLetterRuns(cleanedPublishGrid, minEntryLenForSize(n))
            ) {
              directFallbackPublishGrid = cleanedPublishGrid;
              directFallbackPublishEntries = cleanedPublishEntries;
            }
          }
          const directFallbackWeakBeforeDensify = entryCrossingStats(
            directFallbackPublishGrid,
            directFallbackPublishEntries,
            minEntryLenForSize(n)
          ).weakEntries;
          if (n === 11 && directFallbackWeakBeforeDensify.length > 0) {
            const weakAnswers = new Set(directFallbackWeakBeforeDensify.map((entry) => entry.answer));
            const weakPrunedGrid = directFallbackPublishGrid.map((row) => row.slice());
            for (const entry of directFallbackPublishEntries) {
              if (!weakAnswers.has(entry.answer)) continue;
              for (let i = 0; i < entry.answer.length; i++) {
                const r = entry.direction === "down" ? entry.row + i : entry.row;
                const c = entry.direction === "across" ? entry.col + i : entry.col;
                if (inBounds(n, r, c)) weakPrunedGrid[r][c] = "#";
              }
            }

            const weakCleanGrid = blockShortRunsOnly(weakPrunedGrid, minEntryLenForSize(n));
            const weakCleanDerived = deriveEntriesFromGrid(weakCleanGrid, minEntryLenForSize(n));
            if (weakCleanDerived.length >= minPublishEntriesForSize(n) - 2) {
              directFallbackPublishGrid = weakCleanGrid;
              directFallbackPublishEntries = pruneMaskedDuplicateAnswers(
                repairPublishClues(
                  applyCluesAndOverrides(theme, language, weakCleanDerived, clueByAnswer),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              );
              fallbackBuilt = {
                ...fallbackBuilt,
                grid: weakCleanGrid,
                usedAnswers: Array.from(new Set(weakCleanDerived.map((entry) => entry.answer))),
                meta: {
                  ...fallbackBuilt.meta,
                  weakEntriesPrunedBeforeDensify: Array.from(weakAnswers),
                },
              };
            }
          }

          const directFallbackFinalQualityBeforeDensify = publishQualityIssue(
            directFallbackPublishEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const finalDensifierBaseGrid =
            directFallbackFinalQualityBeforeDensify &&
            cleanedPublishDerived.length > 0 &&
            cleanedPublishDerived.length < directFallbackPublishEntries.length &&
            cleanedPublishDerived.length >=
              Math.max(minPublishEntriesForSize(n) - 2, directFallbackPublishEntries.length - 2)
              ? cleanedPublishGrid
              : directFallbackPublishGrid;
          const finalDensifierBaseEntries = deriveEntriesFromGrid(
            finalDensifierBaseGrid,
            minEntryLenForSize(n)
          );
          const finalDensifiedDirectFallback =
            directFallbackPublishEntries.length < minPublishEntriesForSize(n) ||
            directFallbackPublishEntries.length < desiredPublishEntriesForSize(n) ||
            Boolean(directFallbackFinalQualityBeforeDensify)
              ? densifyCleanGrid11({
                  theme,
                  grid: finalDensifierBaseGrid,
                  candidates: fallbackPool,
                  targetEntries: desiredPublishEntriesForSize(n),
                  seed:
                    (fallbackStrictSeed ^
                      Math.imul(directFallbackPublishEntries.length + 1, 0x9e3779b9) ^
                      0x6a09e667) >>>
                    0,
                  deadlineMs: fallbackDeadlineMs,
                })
              : null;

          if (finalDensifiedDirectFallback) {
            const finalDensifiedEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(
                applyCluesAndOverrides(theme, language, finalDensifiedDirectFallback.derived, clueByAnswer),
                {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                }
              )
            );
            const finalDensifiedQualityIssue = publishQualityIssue(
              finalDensifiedEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );

            const shouldUseFinalDensified =
              finalDensifiedEntries.length >= minPublishEntriesForSize(n) &&
              !finalDensifiedQualityIssue &&
              (finalDensifiedEntries.length > directFallbackPublishEntries.length ||
                Boolean(directFallbackFinalQualityBeforeDensify) ||
                finalDensifiedDirectFallback.derived.length > finalDensifierBaseEntries.length);

            if (shouldUseFinalDensified) {
            directFallbackPublishGrid = finalDensifiedDirectFallback.grid;
            directFallbackPublishEntries = finalDensifiedEntries;
            fallbackBuilt = {
              ...fallbackBuilt,
              grid: finalDensifiedDirectFallback.grid,
              usedAnswers: Array.from(new Set(finalDensifiedDirectFallback.derived.map((entry) => entry.answer))),
              meta: {
                ...fallbackBuilt.meta,
                ...finalDensifiedDirectFallback.meta,
                finalDirectDensified: true,
              },
            };
            }
          }
          const directFallbackQualityAfterDensify = publishQualityIssue(
            directFallbackPublishEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const finalAugmentedDirectFallback =
            directFallbackPublishEntries.length < minPublishEntriesForSize(n) ||
            directFallbackPublishEntries.length < desiredPublishEntriesForSize(n) ||
            Boolean(directFallbackQualityAfterDensify)
              ? augmentNoShortGridWithCandidates(
                  directFallbackPublishGrid,
                  fallbackPool.filter((candidate) => candidate.source !== "filler"),
                  minEntryLenForSize(n),
                  desiredPublishEntriesForSize(n),
                  minPublishEntriesForSize(n)
                )
              : null;

          if (finalAugmentedDirectFallback) {
            const finalAugmentedEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(
                applyCluesAndOverrides(theme, language, finalAugmentedDirectFallback.derived, clueByAnswer),
                {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                }
              )
            );
            const finalAugmentedQualityIssue = publishQualityIssue(
              finalAugmentedEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );

            if (
              finalAugmentedEntries.length >= minPublishEntriesForSize(n) &&
              !finalAugmentedQualityIssue
            ) {
              directFallbackPublishGrid = finalAugmentedDirectFallback.grid;
              directFallbackPublishEntries = finalAugmentedEntries;
              fallbackBuilt = {
                ...fallbackBuilt,
                grid: finalAugmentedDirectFallback.grid,
                usedAnswers: Array.from(new Set(finalAugmentedDirectFallback.derived.map((entry) => entry.answer))),
                meta: {
                  ...fallbackBuilt.meta,
                  finalDirectAugmented: true,
                },
              };
            }
          }
          let directFallbackQualityAfterAugment = publishQualityIssue(
            directFallbackPublishEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          if (directFallbackQualityAfterAugment) {
            const cleanedAfterAugmentGrid = blockForbiddenAnswerRuns(
              directFallbackPublishGrid,
              minEntryLenForSize(n)
            );
            const cleanedAfterAugmentDerived = deriveEntriesFromGrid(
              cleanedAfterAugmentGrid,
              minEntryLenForSize(n)
            );
            if (cleanedAfterAugmentDerived.length >= minPublishEntriesForSize(n) - 2) {
              const cleanedAfterAugmentEntries = pruneMaskedDuplicateAnswers(
                repairPublishClues(
                  applyCluesAndOverrides(theme, language, cleanedAfterAugmentDerived, clueByAnswer),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              );
              directFallbackPublishGrid = cleanedAfterAugmentGrid;
              directFallbackPublishEntries = cleanedAfterAugmentEntries;
              directFallbackQualityAfterAugment = publishQualityIssue(
                directFallbackPublishEntries,
                finalFallbackThematicSet,
                language,
                minPublishEntriesForSize(n)
              );
            }
          }
          const shouldRunStructuralRescue =
            n === 11 &&
            (directFallbackPublishEntries.length < minPublishEntriesForSize(n) ||
              hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)) ||
              entryCrossingStats(
                directFallbackPublishGrid,
                directFallbackPublishEntries,
                minEntryLenForSize(n)
              ).weakEntries.length > 0 ||
              Boolean(
                publishQualityIssue(
                  directFallbackPublishEntries,
                  finalFallbackThematicSet,
                  language,
                  minPublishEntriesForSize(n)
                )
              ));

          if (shouldRunStructuralRescue) {
            console.warn("[generate-crossword] direct fallback structural-rescue start", {
              entries: directFallbackPublishEntries.length,
              hasShortRuns: hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)),
              weakEntries: entryCrossingStats(
                directFallbackPublishGrid,
                directFallbackPublishEntries,
                minEntryLenForSize(n)
              ).weakEntries,
              qualityIssue: publishQualityIssue(
                directFallbackPublishEntries,
                finalFallbackThematicSet,
                language,
                minPublishEntriesForSize(n)
              ),
            });
            const pairExtended = extendGridWithCrossedPair11({
              grid: directFallbackPublishGrid,
              candidates: fallbackPool,
              targetEntries: minPublishEntriesForSize(n),
              seed: (fallbackStrictSeed ^ 0x51f15e0d ^ Math.imul(directFallbackPublishEntries.length + 1, 131)) >>> 0,
            });
            if (pairExtended) {
              const pairExtendedEntries = pruneForbiddenPublishAnswersIfPossible(
                pruneMaskedDuplicateAnswers(
                  repairPublishClues(
                    applyCluesAndOverrides(theme, language, pairExtended.derived, clueByAnswer),
                    {
                      theme,
                      language,
                      thematicSet: finalFallbackThematicSet,
                      notesByAnswer: fallbackNotesByAnswer,
                    }
                  )
                ),
                minPublishEntriesForSize(n)
              );
              directFallbackPublishGrid = pairExtended.grid;
              directFallbackPublishEntries = pairExtendedEntries;
              console.warn("[generate-crossword] direct fallback pair-extended", {
                fromEntries: directFallbackPublishEntries.length,
                addedAnswers: pairExtended.addedAnswers,
                derivedEntries: pairExtended.derived.length,
              });
            }
          }

          if (shouldRunStructuralRescue) {
            const structuralRescuePoolByAnswer = new Map<string, WordCandidate>(
              [...best.pool, ...lastAttemptPool]
                .filter((candidate) => candidate.answer.length >= minEntryLenForSize(n))
                .filter((candidate) => candidate.answer.length <= n)
                .filter((candidate) => ASCII_A_TO_Z.test(candidate.answer))
                .filter((candidate) => !isForbiddenPublishAnswer(candidate.answer))
                .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
                .map((candidate) => [candidate.answer, candidate] as const)
            );
            const structuralFillersByLength = new Map<number, string[]>();
            for (const word of language === "es" ? SPANISH_FILLER_WORDS : FILLER_WORDS) {
              const answer = normalizeAnswer(word);
              if (answer.length < minEntryLenForSize(n) || answer.length > 8) continue;
              if (!ASCII_A_TO_Z.test(answer)) continue;
              if (isForbiddenPublishAnswer(answer)) continue;
              const bucket = structuralFillersByLength.get(answer.length) ?? [];
              if (bucket.length < 100 && !bucket.includes(answer)) bucket.push(answer);
              structuralFillersByLength.set(answer.length, bucket);
            }
            const structuralFillers = Array.from(structuralFillersByLength)
              .sort(([a], [b]) => a - b)
              .flatMap(([, words]) => words)
              .map((word) => normalizeAnswer(word))
              .filter(Boolean);
            for (const answer of structuralFillers) {
              if (structuralRescuePoolByAnswer.has(answer)) continue;
              structuralRescuePoolByAnswer.set(answer, {
                answer,
                thematic: false,
                source: "filler",
              });
            }
            const structuralRescuePool: WordCandidate[] = Array.from(
              new Map(
                Array.from(structuralRescuePoolByAnswer.values()).map((candidate) => [
                  candidate.answer,
                  candidate,
                ] as const)
              ).values()
            );
            if (process.env.OPENAI_PATTERN_REPAIR_11 === "1") {
              try {
                const patternRepairWords = await generatePatternMatchedRepairWords({
                  client,
                  theme,
                  language,
                  grid: directFallbackPublishGrid,
                  entries: deriveEntriesFromGrid(
                    directFallbackPublishGrid,
                    minEntryLenForSize(n)
                  ),
                  existingAnswers: structuralRescuePool.map((candidate) => candidate.answer),
                });
                for (const candidate of patternRepairWords) {
                  if (structuralRescuePoolByAnswer.has(candidate.answer)) continue;
                  structuralRescuePoolByAnswer.set(candidate.answer, candidate);
                  structuralRescuePool.push(candidate);
                  finalFallbackThematicSet.add(candidate.answer);
                }
              } catch (error: unknown) {
                console.warn("[pattern-repair-11] request failed", {
                  msg: errorSummary(error),
                });
              }
            }

            for (const candidate of structuralRescuePool) {
              const strongSupport = hasStrongThematicClueSupport({
                theme,
                answer: candidate.answer,
                language,
                note: fallbackNotesByAnswer.get(candidate.answer),
              });
              if (candidate.thematic || strongSupport) finalFallbackThematicSet.add(candidate.answer);
              if (
                candidate.source !== "support" &&
                candidate.source !== "filler" &&
                (candidate.thematic || strongSupport)
              ) {
                finalFallbackCoreThematicSet.add(candidate.answer);
              }
            }

            const structuralFreeform = constructFreeformCrossword({
              size: n,
              seed: (fallbackStrictSeed ^ 0x6a09e667) >>> 0,
              candidates: structuralRescuePool.slice().sort((a, b) => {
                if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
                const aSource = a.source === "anchor" ? 3 : a.source === "model" ? 2 : 1;
                const bSource = b.source === "anchor" ? 3 : b.source === "model" ? 2 : 1;
                if (aSource !== bSource) return bSource - aSource;
                return b.answer.length - a.answer.length;
              }),
                  deadlineMs: boundedFallbackDeadline(9_000),
              maxPlacedWords: 50,
              maxBuilds: 32,
            });
            if (structuralFreeform) {
              const structuralPruned = pruneWeakEntriesPreservingCrosses(
                structuralFreeform.grid,
                minEntryLenForSize(n),
                minPublishEntriesForSize(n)
              );
              const structuralGrid = structuralPruned?.grid ?? structuralFreeform.grid;
              const structuralFreeformDerived = deriveEntriesFromGrid(
                structuralGrid,
                minEntryLenForSize(n)
              );
              const currentDerived = deriveEntriesFromGrid(
                directFallbackPublishGrid,
                minEntryLenForSize(n)
              );
              if (
                structuralFreeformDerived.length > currentDerived.length &&
                !structuralFreeformDerived.some((entry) =>
                  isForbiddenPublishAnswer(entry.answer)
                )
              ) {
                directFallbackPublishGrid = structuralGrid;
                directFallbackPublishEntries = pruneForbiddenPublishAnswersIfPossible(
                  pruneMaskedDuplicateAnswers(
                    repairPublishClues(
                      applyCluesAndOverrides(
                        theme,
                        language,
                        structuralFreeformDerived,
                        clueByAnswer
                      ),
                      {
                        theme,
                        language,
                        thematicSet: finalFallbackThematicSet,
                        notesByAnswer: fallbackNotesByAnswer,
                      }
                    )
                  ),
                  minPublishEntriesForSize(n)
                );
                console.warn("[generate-crossword] structural freeform improved fallback", {
                  fromEntries: currentDerived.length,
                  toEntries: structuralFreeformDerived.length,
                });
              }
            }

            const nearCompleteDerived = deriveEntriesFromGrid(
              directFallbackPublishGrid,
              minEntryLenForSize(n)
            );
            const nearCompleteWeak = entryCrossingStats(
              directFallbackPublishGrid,
              nearCompleteDerived,
              minEntryLenForSize(n)
            ).weakEntries;
            if (
              process.env.OPENAI_PATTERN_REPAIR_11 === "1" &&
              nearCompleteDerived.length >= minPublishEntriesForSize(n) &&
              nearCompleteWeak.length > 0 &&
              nearCompleteWeak.length <= 3
            ) {
              try {
                const targetedRepairWords = await generatePatternMatchedRepairWords({
                  client,
                  theme,
                  language,
                  grid: directFallbackPublishGrid,
                  entries: nearCompleteDerived,
                  existingAnswers: structuralRescuePool.map((candidate) => candidate.answer),
                });
                for (const candidate of targetedRepairWords) {
                  if (structuralRescuePoolByAnswer.has(candidate.answer)) continue;
                  structuralRescuePoolByAnswer.set(candidate.answer, candidate);
                  structuralRescuePool.push(candidate);
                  finalFallbackThematicSet.add(candidate.answer);
                }
                console.warn("[generate-crossword] targeted weak-entry repair pool", {
                  entries: nearCompleteDerived.length,
                  weakEntries: nearCompleteWeak,
                  addedCandidates: targetedRepairWords.length,
                });
              } catch (error: unknown) {
                console.warn("[pattern-repair-11] targeted request failed", {
                  msg: errorSummary(error),
                });
              }
            }

            if (hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n))) {
              const shortCleanGrid = blockShortRunsOnly(directFallbackPublishGrid, minEntryLenForSize(n));
              const shortCleanDerived = deriveEntriesFromGrid(shortCleanGrid, minEntryLenForSize(n));
              if (
                shortCleanDerived.length >= minPublishEntriesForSize(n) - 2 &&
                shortCleanDerived.length >= directFallbackPublishEntries.length - 2
              ) {
                directFallbackPublishGrid = shortCleanGrid;
                directFallbackPublishEntries = pruneForbiddenPublishAnswersIfPossible(
                  pruneMaskedDuplicateAnswers(
                    repairPublishClues(
                      applyCluesAndOverrides(theme, language, shortCleanDerived, clueByAnswer),
                      {
                        theme,
                        language,
                        thematicSet: finalFallbackThematicSet,
                        notesByAnswer: fallbackNotesByAnswer,
                      }
                    )
                  ),
                  minPublishEntriesForSize(n)
                );
              }
            }

            const structuralDensifyBaseGrid = directFallbackPublishGrid;
            const structuralDensifyBaseDerived = deriveEntriesFromGrid(
              structuralDensifyBaseGrid,
              minEntryLenForSize(n)
            );
            const structuralDensifyBaseWeakEntries = entryCrossingStats(
              structuralDensifyBaseGrid,
              structuralDensifyBaseDerived,
              minEntryLenForSize(n)
            ).weakEntries.length;
            const structuralDensifyBaseHasShortRuns = hasShortLetterRuns(
              structuralDensifyBaseGrid,
              minEntryLenForSize(n)
            );
            if (structuralDensifyBaseDerived.length >= Math.max(8, directFallbackPublishEntries.length - 5)) {
              const structuralDensified = densifyCleanGrid11({
                theme,
                grid: structuralDensifyBaseGrid,
                candidates: structuralRescuePool,
                targetEntries: minPublishEntriesForSize(n),
                seed: (fallbackStrictSeed ^ 0x94d049bb ^ Math.imul(structuralDensifyBaseDerived.length + 1, 137)) >>> 0,
                deadlineMs: boundedFallbackDeadline(14_000),
              });
              if (structuralDensified) {
                const newRepairAnswers = structuralDensified.added.filter(
                  (answer) => !clueByAnswer.has(answer)
                );
                if (newRepairAnswers.length > 0) {
                  try {
                    const repairClues = await requestModelClues({
                      client,
                      theme,
                      language,
                      items: newRepairAnswers.map((answer) => ({
                        answer,
                        thematic: true,
                        hint:
                          language === "es"
                            ? `Da una pista concreta que vincule ${answer} con ${theme}.`
                            : `Give a concrete clue linking ${answer} to ${theme}.`,
                      })),
                    });
                    for (const [answer, clue] of repairClues) {
                      clueByAnswer.set(answer, clue);
                    }
                  } catch (error: unknown) {
                    console.warn("[pattern-repair-11] clue request failed", {
                      msg: errorSummary(error),
                    });
                  }
                }
                const structuralDensifiedEntries = pruneForbiddenPublishAnswersIfPossible(
                  pruneMaskedDuplicateAnswers(
                    repairPublishClues(
                      applyCluesAndOverrides(theme, language, structuralDensified.derived, clueByAnswer),
                      {
                        theme,
                        language,
                        thematicSet: finalFallbackThematicSet,
                        notesByAnswer: fallbackNotesByAnswer,
                      }
                    )
                  ),
                  minPublishEntriesForSize(n)
                );
                const structuralDensifiedWeak = entryCrossingStats(
                  structuralDensified.grid,
                  structuralDensifiedEntries,
                  minEntryLenForSize(n)
                ).weakEntries.length;
                const structuralDensifiedHasShortRuns = hasShortLetterRuns(
                  structuralDensified.grid,
                  minEntryLenForSize(n)
                );
                const shouldUseStructuralDensified =
                  structuralDensifiedEntries.length >= minPublishEntriesForSize(n) &&
                  structuralDensifiedWeak === 0 &&
                  !structuralDensifiedHasShortRuns &&
                  !publishQualityIssue(
                    structuralDensifiedEntries,
                    finalFallbackThematicSet,
                    language,
                    minPublishEntriesForSize(n)
                  );

                if (shouldUseStructuralDensified) {
                  directFallbackPublishGrid = structuralDensified.grid;
                  directFallbackPublishEntries = structuralDensifiedEntries;
                  fallbackBuilt = {
                    ...fallbackBuilt,
                    grid: structuralDensified.grid,
                    usedAnswers: Array.from(new Set(structuralDensified.derived.map((entry) => entry.answer))),
                    meta: {
                      ...fallbackBuilt.meta,
                      structuralDensified: true,
                    },
                  };
                  console.warn("[generate-crossword] direct fallback structural densified", {
                    entries: structuralDensifiedEntries.length,
                    weakEntries: structuralDensifiedWeak,
                    added: structuralDensified.added,
                    acceptedForPublish: shouldUseStructuralDensified,
                  });
                } else {
                  const improvesWeakEntries =
                    structuralDensifiedWeak < structuralDensifyBaseWeakEntries;
                  const fixesShortRuns =
                    structuralDensifyBaseHasShortRuns && !structuralDensifiedHasShortRuns;
                  const keepsEnoughEntries =
                    structuralDensifiedEntries.length >=
                    Math.max(10, minPublishEntriesForSize(n) - 3);

                  if (keepsEnoughEntries && (improvesWeakEntries || fixesShortRuns)) {
                    directFallbackPublishGrid = structuralDensified.grid;
                    directFallbackPublishEntries = structuralDensifiedEntries;
                    fallbackBuilt = {
                      ...fallbackBuilt,
                      grid: structuralDensified.grid,
                      usedAnswers: Array.from(new Set(structuralDensified.derived.map((entry) => entry.answer))),
                      meta: {
                        ...fallbackBuilt.meta,
                        structuralDensifiedIntermediate: true,
                      },
                    };
                    console.warn("[generate-crossword] direct fallback structural densified intermediate", {
                      entries: structuralDensifiedEntries.length,
                      baseWeakEntries: structuralDensifyBaseWeakEntries,
                      weakEntries: structuralDensifiedWeak,
                      baseHasShortRuns: structuralDensifyBaseHasShortRuns,
                      hasShortRuns: structuralDensifiedHasShortRuns,
                      added: structuralDensified.added,
                    });
                  }
                }
              }
            }

            for (let round = 0; round < 4; round++) {
              if (directFallbackPublishEntries.length >= minPublishEntriesForSize(n)) break;
              const beforeEntries = directFallbackPublishEntries.length;
              const pairExtended = extendGridWithCrossedPair11({
                grid: directFallbackPublishGrid,
                candidates: structuralRescuePool,
                targetEntries: minPublishEntriesForSize(n),
                seed:
                  (fallbackStrictSeed ^
                    0x7f4a7c15 ^
                    Math.imul(round + 1, 2654435761) ^
                    Math.imul(beforeEntries + 1, 2246822519)) >>>
                  0,
              });
              if (!pairExtended || pairExtended.derived.length <= beforeEntries) break;
              const pairExtendedEntries = pruneForbiddenPublishAnswersIfPossible(
                pruneMaskedDuplicateAnswers(
                  repairPublishClues(
                    applyCluesAndOverrides(theme, language, pairExtended.derived, clueByAnswer),
                    {
                      theme,
                      language,
                      thematicSet: finalFallbackThematicSet,
                      notesByAnswer: fallbackNotesByAnswer,
                    }
                  )
                ),
                minPublishEntriesForSize(n)
              );
              directFallbackPublishGrid = pairExtended.grid;
              directFallbackPublishEntries = pairExtendedEntries;
              console.warn("[generate-crossword] direct fallback structural pair extension", {
                round,
                beforeEntries,
                afterEntries: directFallbackPublishEntries.length,
                addedAnswers: pairExtended.addedAnswers,
              });
            }

            const structuralRescueDeadlineMs = boundedFallbackDeadline(14_000);
            const structuralRescueBuilt =
              structuralRescuePool.length >= minPublishEntriesForSize(n)
                ? constructPatternCrossword11({
                    theme,
                    size: n,
                    seed: (fallbackStrictSeed ^ 0x3c6ef372) >>> 0,
                    candidates: structuralRescuePool,
                    deadlineMs: structuralRescueDeadlineMs,
                  }) ??
                  constructCompactPatternCrossword11({
                    theme,
                    size: n,
                    seed: (fallbackStrictSeed ^ 0xa5a5a5a5) >>> 0,
                    candidates: structuralRescuePool,
                    deadlineMs: structuralRescueDeadlineMs,
                  }) ??
                  constructOpeningCrossword11({
                    theme,
                    candidates: structuralRescuePool,
                    seed: (fallbackStrictSeed ^ 0xbb67ae85) >>> 0,
                    targetEntries: minPublishEntriesForSize(n),
                    deadlineMs: structuralRescueDeadlineMs,
                  })
                : null;

            if (structuralRescueBuilt) {
              const structuralRescueDerived = deriveEntriesFromGrid(
                structuralRescueBuilt.grid,
                minEntryLenForSize(n)
              );
              for (const entry of structuralRescueDerived) {
                if (clueByAnswer.has(entry.answer)) continue;
                const note = fallbackNotesByAnswer.get(entry.answer);
                const noteClue = note ? clueFromThemeNote(theme, note, language) : null;
                const specificClue = specificThematicFallbackClue(theme, entry.answer, language);
                if (noteClue || specificClue) {
                  clueByAnswer.set(entry.answer, noteClue ?? specificClue ?? "");
                }
              }

              const structuralRescueEntries = pruneForbiddenPublishAnswersIfPossible(
                pruneMaskedDuplicateAnswers(
                  repairPublishClues(
                    applyCluesAndOverrides(theme, language, structuralRescueDerived, clueByAnswer),
                    {
                      theme,
                      language,
                      thematicSet: finalFallbackThematicSet,
                      notesByAnswer: fallbackNotesByAnswer,
                    }
                  )
                ),
                minPublishEntriesForSize(n)
              );
              const structuralRescueChecked = checkedCellStats(
                structuralRescueBuilt.grid,
                minEntryLenForSize(n)
              );
              const structuralRescueCrossed = crossedEntryStats(
                structuralRescueBuilt.grid,
                structuralRescueEntries,
                minEntryLenForSize(n)
              );
              const structuralRescueEntryCrossings = entryCrossingStats(
                structuralRescueBuilt.grid,
                structuralRescueEntries,
                minEntryLenForSize(n)
              );
              const structuralRescueThemeEntries = structuralRescueEntries.filter((entry) =>
                finalFallbackThematicSet.has(entry.answer)
              ).length;
              const structuralRescueCoreEntries = structuralRescueEntries.filter((entry) =>
                finalFallbackCoreThematicSet.has(entry.answer)
              ).length;
              const structuralRescueGenericEntries = structuralRescueEntries.filter(
                (entry) => finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
              ).length;
              const structuralRescuePlaceholderCount = structuralRescueEntries.filter((entry) =>
                isPlaceholderClue(entry.clue, language)
              ).length;
              const structuralRescueQualityIssue = publishQualityIssue(
                structuralRescueEntries,
                finalFallbackThematicSet,
                language,
                minPublishEntriesForSize(n)
              );

              if (
                structuralRescueEntries.length >= minPublishEntriesForSize(n) &&
                structuralRescueCrossed.crossed >= structuralRescueEntries.length &&
                structuralRescueEntryCrossings.weakEntries.length === 0 &&
                structuralRescueChecked.ratio >= 0.25 &&
                structuralRescueThemeEntries >= minThematicEntriesForPublish(n, structuralRescueEntries.length) &&
                structuralRescueCoreEntries >= minCoreThematicEntriesForPublish(n, structuralRescueEntries.length) &&
                structuralRescueGenericEntries <= maxGenericContextEntriesForPublish(n, structuralRescueEntries.length) &&
                structuralRescuePlaceholderCount === 0 &&
                !hasShortLetterRuns(structuralRescueBuilt.grid, minEntryLenForSize(n)) &&
                !structuralRescueQualityIssue
              ) {
                directFallbackPublishGrid = structuralRescueBuilt.grid;
                directFallbackPublishEntries = structuralRescueEntries;
                fallbackBuilt = {
                  ...fallbackBuilt,
                  grid: structuralRescueBuilt.grid,
                  usedAnswers: Array.from(new Set(structuralRescueDerived.map((entry) => entry.answer))),
                  meta: {
                    ...fallbackBuilt.meta,
                    ...structuralRescueBuilt.meta,
                    structuralRescue: true,
                  },
                };
                console.warn("[generate-crossword] direct fallback structural-rescue accepted", {
                  entries: structuralRescueEntries.length,
                  thematicEntries: structuralRescueThemeEntries,
                  coreThematicEntries: structuralRescueCoreEntries,
                  genericContextEntries: structuralRescueGenericEntries,
                  checkedRatio: structuralRescueChecked.ratio,
                  builder: structuralRescueBuilt.meta?.builder ?? null,
                });
              } else {
                console.warn("[generate-crossword] direct fallback structural-rescue rejected", {
                  entries: structuralRescueEntries.length,
                  thematicEntries: structuralRescueThemeEntries,
                  coreThematicEntries: structuralRescueCoreEntries,
                  genericContextEntries: structuralRescueGenericEntries,
                  crossedEntries: structuralRescueCrossed.crossed,
                  weakEntries: structuralRescueEntryCrossings.weakEntries,
                  checkedRatio: structuralRescueChecked.ratio,
                  placeholderCount: structuralRescuePlaceholderCount,
                  qualityIssue: structuralRescueQualityIssue,
                  hasShortRuns: hasShortLetterRuns(structuralRescueBuilt.grid, minEntryLenForSize(n)),
                  builder: structuralRescueBuilt.meta?.builder ?? null,
                  answers: structuralRescueEntries.map((entry) => entry.answer),
                });
              }
            } else {
              const structuralLenCount = structuralRescuePool.reduce((acc, candidate) => {
                acc.set(candidate.answer.length, (acc.get(candidate.answer.length) ?? 0) + 1);
                return acc;
              }, new Map<number, number>());
              console.warn("[generate-crossword] direct fallback structural-rescue unavailable", {
                candidatePool: structuralRescuePool.length,
                lenCount: Object.fromEntries(structuralLenCount),
                targetEntries: minPublishEntriesForSize(n),
              });
            }
          }
          const weakBeforePrune = entryCrossingStats(
            directFallbackPublishGrid,
            directFallbackPublishEntries,
            minEntryLenForSize(n)
          ).weakEntries;
          if (
            directFallbackPublishEntries.length > minPublishEntriesForSize(n) &&
            weakBeforePrune.length > 0
          ) {
            for (const weakEntry of weakBeforePrune) {
              const survivors = directFallbackPublishEntries.filter(
                (entry) => entry.answer !== weakEntry.answer
              );
              if (survivors.length < minPublishEntriesForSize(n)) continue;
              const rebuiltWithoutWeak = rebuildGridFromEntries(
                n,
                survivors,
                minEntryLenForSize(n)
              );
              if (!rebuiltWithoutWeak) continue;
              const crossingsWithoutWeak = entryCrossingStats(
                rebuiltWithoutWeak.grid,
                rebuiltWithoutWeak.derived,
                minEntryLenForSize(n)
              );
              if (rebuiltWithoutWeak.derived.length < minPublishEntriesForSize(n)) continue;
              if (crossingsWithoutWeak.weakEntries.length > 0) continue;
              if (hasShortLetterRuns(rebuiltWithoutWeak.grid, minEntryLenForSize(n))) continue;

              directFallbackPublishGrid = rebuiltWithoutWeak.grid;
              directFallbackPublishEntries = repairPublishClues(
                applyCluesAndOverrides(
                  theme,
                  language,
                  rebuiltWithoutWeak.derived,
                  clueByAnswer
                ),
                {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                }
              );
              console.warn("[generate-crossword] pruned weak surplus entry", {
                removed: weakEntry.answer,
                entries: directFallbackPublishEntries.length,
                minEntryCheckedCells: crossingsWithoutWeak.minCheckedCells,
              });
              break;
            }
          }

          if (
            directFallbackPublishEntries.length >= minPublishEntriesForSize(n) - 2 &&
            directFallbackPublishEntries.length < minPublishEntriesForSize(n)
          ) {
            const oneWordAugment = augmentNoShortGridWithCandidates(
              directFallbackPublishGrid,
              fallbackPool,
              minEntryLenForSize(n),
              minPublishEntriesForSize(n),
              minPublishEntriesForSize(n)
            );
            if (oneWordAugment) {
              directFallbackPublishGrid = oneWordAugment.grid;
              directFallbackPublishEntries = pruneMaskedDuplicateAnswers(
                repairPublishClues(
                  applyCluesAndOverrides(
                    theme,
                    language,
                    oneWordAugment.derived,
                    clueByAnswer
                  ),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              );
              console.warn("[generate-crossword] one-word final augment accepted", {
                entries: directFallbackPublishEntries.length,
              });
            }
          }

          const finalStructuralPrune = pruneWeakEntriesPreservingCrosses(
            directFallbackPublishGrid,
            minEntryLenForSize(n),
            minPublishEntriesForSize(n)
          );
          if (finalStructuralPrune) {
            directFallbackPublishGrid = finalStructuralPrune.grid;
            directFallbackPublishEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(
                applyCluesAndOverrides(
                  theme,
                  language,
                  finalStructuralPrune.derived,
                  clueByAnswer
                ),
                {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                }
              )
            );
            console.warn("[generate-crossword] final structural prune accepted", {
              entries: directFallbackPublishEntries.length,
              minEntryCheckedCells: entryCrossingStats(
                directFallbackPublishGrid,
                directFallbackPublishEntries,
                minEntryLenForSize(n)
              ).minCheckedCells,
            });
          }

          const directFallbackCheckedStats = checkedCellStats(
            directFallbackPublishGrid,
            minEntryLenForSize(n)
          );
          const directFallbackCrossedStats = crossedEntryStats(
            directFallbackPublishGrid,
            directFallbackPublishEntries,
            minEntryLenForSize(n)
          );
          const directFallbackEntryCrossingStats = entryCrossingStats(
            directFallbackPublishGrid,
            directFallbackPublishEntries,
            minEntryLenForSize(n)
          );
          const directFallbackThemeEntries = directFallbackPublishEntries.filter((e) =>
            finalFallbackThematicSet.has(e.answer)
          ).length;
          const directFallbackCoreThematicEntries = directFallbackPublishEntries.filter((e) =>
            finalFallbackCoreThematicSet.has(e.answer)
          ).length;
          const directFallbackMinCoreThematicEntries = minCoreThematicEntriesForPublish(
            n,
            directFallbackPublishEntries.length
          );
          const directFallbackGenericContextEntries = directFallbackPublishEntries.filter((e) =>
            finalFallbackThematicSet.has(e.answer) && !finalFallbackCoreThematicSet.has(e.answer)
          ).length;
          const directFallbackMaxGenericContextEntries = maxGenericContextEntriesForPublish(
            n,
            directFallbackPublishEntries.length
          );
          const directFallbackMinThemeEntries = minThematicEntriesForPublish(
            n,
            directFallbackPublishEntries.length
          );
          const directFallbackPlaceholderCount = directFallbackPublishEntries.filter((e) =>
            isPlaceholderClue(e.clue, language)
          ).length;
          const directFallbackQualityIssue = publishQualityIssue(
            directFallbackPublishEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const directFallbackNearMinEntries =
            n === 11 ? 10 : minPublishEntriesForSize(n);
          const directFallbackUnsupportedEntries = directFallbackPublishEntries.filter(
            (entry) =>
              !isPublishableAnswerForTheme({
                theme,
                answer: entry.answer,
                language,
                size: n,
                note: fallbackNotesByAnswer.get(entry.answer),
                allowContextualGeneric: finalFallbackThematicSet.has(entry.answer),
              })
          );
          if (
            directFallbackPublishEntries.length >= minPublishEntriesForSize(n) &&
            !hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)) &&
            !directFallbackPublishEntries.some((entry) => isForbiddenPublishAnswer(entry.answer)) &&
            directFallbackUnsupportedEntries.length === 0 &&
            directFallbackCrossedStats.crossed >= minCrossedEntriesForPublish(n) &&
            directFallbackEntryCrossingStats.weakEntries.length === 0 &&
            directFallbackCheckedStats.ratio >= 0.25 &&
            directFallbackThemeEntries >= directFallbackMinThemeEntries &&
            directFallbackCoreThematicEntries >= directFallbackMinCoreThematicEntries &&
            directFallbackGenericContextEntries <= directFallbackMaxGenericContextEntries &&
            directFallbackPlaceholderCount === 0 &&
            !directFallbackQualityIssue
          ) {
            console.warn("[generate-crossword] FALLBACK -> direct 11x11 reconstructed", {
              attempt: bestPartial.attempt,
              entries: directFallbackPublishEntries.length,
              thematicEntries: directFallbackThemeEntries,
              coreThematicEntries: directFallbackCoreThematicEntries,
              genericContextEntries: directFallbackGenericContextEntries,
              crossedEntries: directFallbackCrossedStats.crossed,
              checkedRatio: directFallbackCheckedStats.ratio,
              fallbackScore: bestPartial.fallbackScore,
              builder: fallbackBuilt.meta?.builder ?? null,
            });

            return publishCrosswordResponse(
              {
                theme,
                language,
                size: n,
                grid: directFallbackPublishGrid,
                entries: directFallbackPublishEntries,
                meta: {
                  source: "fallback-best-built-direct-11",
                  attempt: best.attempt,
                  fallbackScore: best.fallbackScore,
                  checkedRatio: directFallbackCheckedStats.ratio,
                  crossedEntries: directFallbackCrossedStats.crossed,
                  thematicEntries: directFallbackThemeEntries,
                  minThematicEntries: directFallbackMinThemeEntries,
                  coreThematicEntries: directFallbackCoreThematicEntries,
                  minCoreThematicEntries: directFallbackMinCoreThematicEntries,
                  genericContextEntries: directFallbackGenericContextEntries,
                  maxGenericContextEntries: directFallbackMaxGenericContextEntries,
                  placeholderCount: directFallbackPlaceholderCount,
                  minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                  minEntryCheckedCells: directFallbackEntryCrossingStats.minCheckedCells,
                  hasShortRuns: false,
                  ...fallbackBuilt.meta,
                },
              } satisfies Crossword
            );
          }

          if (
            n === 11 &&
            directFallbackPublishEntries.length >= directFallbackNearMinEntries &&
            directFallbackThemeEntries === directFallbackPublishEntries.length &&
            !hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)) &&
            !directFallbackPublishEntries.some((entry) => isForbiddenPublishAnswer(entry.answer)) &&
            directFallbackUnsupportedEntries.length === 0 &&
            directFallbackCrossedStats.crossed >= Math.max(6, directFallbackPublishEntries.length - 1) &&
            directFallbackEntryCrossingStats.weakEntries.length === 0 &&
            directFallbackCheckedStats.ratio >= 0.25 &&
            directFallbackPlaceholderCount === 0 &&
            !directFallbackQualityIssue
          ) {
            console.warn("[generate-crossword] FALLBACK -> near-threshold clean 11x11", {
              attempt: bestPartial.attempt,
              entries: directFallbackPublishEntries.length,
              thematicEntries: directFallbackThemeEntries,
              crossedEntries: directFallbackCrossedStats.crossed,
              checkedRatio: directFallbackCheckedStats.ratio,
              fallbackScore: bestPartial.fallbackScore,
              builder: fallbackBuilt.meta?.builder ?? null,
            });

            return publishCrosswordResponse(
              {
                theme,
                language,
                size: n,
                grid: directFallbackPublishGrid,
                entries: directFallbackPublishEntries,
                meta: {
                  source: "fallback-best-built-near-threshold-11",
                  attempt: best.attempt,
                  fallbackScore: best.fallbackScore,
                  checkedRatio: directFallbackCheckedStats.ratio,
                  crossedEntries: directFallbackCrossedStats.crossed,
                  thematicEntries: directFallbackThemeEntries,
                  minThematicEntries: directFallbackMinThemeEntries,
                  coreThematicEntries: directFallbackCoreThematicEntries,
                  minCoreThematicEntries: directFallbackMinCoreThematicEntries,
                  genericContextEntries: directFallbackGenericContextEntries,
                  maxGenericContextEntries: directFallbackMaxGenericContextEntries,
                  placeholderCount: directFallbackPlaceholderCount,
                  nearThreshold: true,
                  targetEntries: minPublishEntriesForSize(n),
                  acceptedMinEntries: directFallbackNearMinEntries,
                  weakCrossingEntries: directFallbackEntryCrossingStats.weakEntries,
                  hasShortRuns: hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)),
                  ...fallbackBuilt.meta,
                },
              } satisfies Crossword
            );
          }

          const directFallbackEmergencyMinEntries = minPublishEntriesForSize(n);
          const directFallbackEmergencyQualityIssue = publishQualityIssue(
            directFallbackPublishEntries,
            finalFallbackThematicSet,
            language,
            directFallbackEmergencyMinEntries
          );

          if (
            n === 11 &&
            directFallbackPublishEntries.length >= directFallbackEmergencyMinEntries &&
            directFallbackThemeEntries === directFallbackPublishEntries.length &&
            !hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)) &&
            !directFallbackPublishEntries.some((entry) => isForbiddenPublishAnswer(entry.answer)) &&
            directFallbackUnsupportedEntries.length === 0 &&
            directFallbackCrossedStats.crossed >= directFallbackPublishEntries.length &&
            directFallbackEntryCrossingStats.weakEntries.length === 0 &&
            directFallbackCheckedStats.ratio >= 0.25 &&
            directFallbackPlaceholderCount === 0 &&
            !directFallbackEmergencyQualityIssue
          ) {
            console.warn("[generate-crossword] FALLBACK -> emergency clean 11x11", {
              attempt: bestPartial.attempt,
              entries: directFallbackPublishEntries.length,
              thematicEntries: directFallbackThemeEntries,
              coreThematicEntries: directFallbackCoreThematicEntries,
              genericContextEntries: directFallbackGenericContextEntries,
              crossedEntries: directFallbackCrossedStats.crossed,
              checkedRatio: directFallbackCheckedStats.ratio,
              targetEntries: minPublishEntriesForSize(n),
              builder: fallbackBuilt.meta?.builder ?? null,
            });

            return publishCrosswordResponse(
              {
                theme,
                language,
                size: n,
                grid: directFallbackPublishGrid,
                entries: directFallbackPublishEntries,
                meta: {
                  source: "fallback-emergency-clean-11",
                  attempt: best.attempt,
                  fallbackScore: best.fallbackScore,
                  checkedRatio: directFallbackCheckedStats.ratio,
                  crossedEntries: directFallbackCrossedStats.crossed,
                  thematicEntries: directFallbackThemeEntries,
                  minThematicEntries: directFallbackMinThemeEntries,
                  coreThematicEntries: directFallbackCoreThematicEntries,
                  minCoreThematicEntries: directFallbackMinCoreThematicEntries,
                  genericContextEntries: directFallbackGenericContextEntries,
                  maxGenericContextEntries: directFallbackMaxGenericContextEntries,
                  placeholderCount: directFallbackPlaceholderCount,
                  emergencyMinEntries: directFallbackEmergencyMinEntries,
                  targetEntries: minPublishEntriesForSize(n),
                  desiredEntries: desiredPublishEntriesForSize(n),
                  hasShortRuns: false,
                  ...fallbackBuilt.meta,
                },
              } satisfies Crossword
            );
          }

          const noShortRunFallback = rebuildNoShortRunPublishableCrossword(
            theme,
            n,
            directFallbackEntriesCandidate,
            language,
            finalFallbackThematicSet,
            minPublishEntriesForSize(n),
            9
          );

          if (noShortRunFallback) {
            const noShortEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(noShortRunFallback.entries, {
                theme,
                language,
                thematicSet: finalFallbackThematicSet,
                notesByAnswer: fallbackNotesByAnswer,
              })
            );
            const noShortStats = checkedCellStats(noShortRunFallback.grid, minEntryLenForSize(n));
            const noShortCrossed = crossedEntryStats(
              noShortRunFallback.grid,
              noShortEntries,
              minEntryLenForSize(n)
            );
            const noShortEntryCrossingStats = entryCrossingStats(
              noShortRunFallback.grid,
              noShortEntries,
              minEntryLenForSize(n)
            );
            const noShortThemeEntries = noShortEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const noShortCoreThematicEntries = noShortEntries.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const noShortMinCoreThematicEntries = minCoreThematicEntriesForPublish(
              n,
              noShortEntries.length
            );
            const noShortGenericContextEntries = noShortEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const noShortMaxGenericContextEntries = maxGenericContextEntriesForPublish(
              n,
              noShortEntries.length
            );
            const noShortMinThemeEntries = minThematicEntriesForPublish(n, noShortEntries.length);
            const noShortQualityIssue = publishQualityIssue(
              noShortEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );

            if (
              noShortEntries.length >= minPublishEntriesForSize(n) &&
              noShortCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              noShortEntryCrossingStats.weakEntries.length === 0 &&
              noShortStats.ratio >= 0.25 &&
              noShortThemeEntries >= noShortMinThemeEntries &&
              noShortCoreThematicEntries >= noShortMinCoreThematicEntries &&
              noShortGenericContextEntries <= noShortMaxGenericContextEntries &&
              !hasShortLetterRuns(noShortRunFallback.grid, minEntryLenForSize(n)) &&
              !noShortQualityIssue
            ) {
              console.warn("[generate-crossword] FALLBACK -> no-short-run reconstructed", {
                attempt: bestPartial.attempt,
                entries: noShortEntries.length,
                thematicEntries: noShortThemeEntries,
                coreThematicEntries: noShortCoreThematicEntries,
                genericContextEntries: noShortGenericContextEntries,
                crossedEntries: noShortCrossed.crossed,
                checkedRatio: noShortStats.ratio,
                fallbackScore: bestPartial.fallbackScore,
                builder: fallbackBuilt.meta?.builder ?? null,
              });

              return publishCrosswordResponse(
                {
                  theme,
                  language,
                  size: n,
                  grid: noShortRunFallback.grid,
                  entries: noShortEntries,
                  meta: {
                    source: "fallback-best-built-no-short-runs",
                    attempt: best.attempt,
                    fallbackScore: best.fallbackScore,
                    checkedRatio: noShortStats.ratio,
                    crossedEntries: noShortCrossed.crossed,
                    thematicEntries: noShortThemeEntries,
                    minThematicEntries: noShortMinThemeEntries,
                    coreThematicEntries: noShortCoreThematicEntries,
                    minCoreThematicEntries: noShortMinCoreThematicEntries,
                    genericContextEntries: noShortGenericContextEntries,
                    maxGenericContextEntries: noShortMaxGenericContextEntries,
                    minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                    minEntryCheckedCells: noShortEntryCrossingStats.minCheckedCells,
                    placeholderCount: 0,
                    ...fallbackBuilt.meta,
                  },
                } satisfies Crossword
              );
            }
          }

          const lateThemeFirstTrustedSet = new Set<string>([
            ...best.trustedThematicSet,
            ...lastAttemptPool
              .filter((candidate) => candidate.thematic && candidate.source !== "filler")
              .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
              .filter((candidate) =>
                hasStrongThematicClueSupport({
                  theme,
                  answer: candidate.answer,
                  language,
                  note: fallbackNotesByAnswer.get(candidate.answer),
                })
              )
              .map((candidate) => candidate.answer),
          ]);
          const lateThemeFirstPoolByAnswer = new Map<string, WordCandidate>();
          for (const candidate of [...fallbackPool, ...lastAttemptPool]) {
            if (candidate.source === "filler") continue;
            if (lateThemeFirstPoolByAnswer.has(candidate.answer)) continue;
            lateThemeFirstPoolByAnswer.set(candidate.answer, candidate);
          }
          const lateThemeFirstRescue =
            Date.now() < deadlineMs - 7_000
              ? await buildThemeFirstRescueCrossword({
                  client,
                  theme,
                  language,
                  size: n,
                  pool: Array.from(lateThemeFirstPoolByAnswer.values()),
                  notesByAnswer: fallbackNotesByAnswer,
                  trustedThematicSet: lateThemeFirstTrustedSet,
                  seedBase:
                    (fallbackStrictSeed ^
                      Math.imul(directFallbackPublishEntries.length + 1, 0x9e3779b9) ^
                      Math.imul(directFallbackThemeEntries + 1, 0x85ebca6b)) >>>
                    0,
                })
              : null;

          if (lateThemeFirstRescue) {
            console.warn("[generate-crossword] FALLBACK -> late theme-first rescue", {
              attempt: bestPartial.attempt,
              previousEntries: directFallbackPublishEntries.length,
              previousThematicEntries: directFallbackThemeEntries,
              rescueEntries: lateThemeFirstRescue.entries.length,
              source: lateThemeFirstRescue.meta?.source,
            });
            return publishCrosswordResponse(lateThemeFirstRescue);
          }

          const lateLayoutPoolByAnswer = new Map<string, WordCandidate>();
          for (const candidate of [
            ...Array.from(lateThemeFirstPoolByAnswer.values()),
            ...best.pool,
            ...lastAttemptPool,
          ]) {
            if (candidate.source === "filler") continue;
            if (lateLayoutPoolByAnswer.has(candidate.answer)) continue;
            if (candidate.answer.length < minEntryLenForSize(n) || candidate.answer.length > n) continue;
            if (!ASCII_A_TO_Z.test(candidate.answer)) continue;
            if (isForbiddenPublishAnswer(candidate.answer)) continue;
            if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
            lateLayoutPoolByAnswer.set(candidate.answer, {
              ...candidate,
              thematic:
                lateThemeFirstTrustedSet.has(candidate.answer) ||
                finalFallbackThematicSet.has(candidate.answer) ||
              candidate.thematic,
            });
          }

          const earlyOpeningFallback =
            n === 11
              ? constructOpeningCrossword11({
                  theme,
                  candidates: Array.from(lateLayoutPoolByAnswer.values()),
                  seed:
                    (fallbackStrictSeed ^
                      0x38ad11c7 ^
                      Math.imul(directFallbackPublishEntries.length + 1, 193)) >>>
                    0,
                  targetEntries: minPublishEntriesForSize(n),
                  deadlineMs: boundedFallbackDeadline(18_000),
                })
              : null;

          if (earlyOpeningFallback) {
            const openingItems: ClueRequestItem[] = earlyOpeningFallback.derived.map((entry) => ({
              answer: entry.answer,
              thematic: finalFallbackThematicSet.has(entry.answer),
              hint: buildThematicClueRequestHint(
                theme,
                entry.answer,
                language,
                fallbackNotesByAnswer.get(entry.answer)
              ) ?? undefined,
              note: fallbackNotesByAnswer.get(entry.answer),
            }));
            const openingModelClues = await requestModelClues({
              client,
              theme,
              language,
              items: openingItems,
            });
            for (const [answer, clue] of openingModelClues) {
              clueByAnswer.set(answer, clue);
            }

            const openingEntries = pruneForbiddenPublishAnswersIfPossible(
              pruneMaskedDuplicateAnswers(
                repairPublishClues(
                  applyCluesAndOverrides(theme, language, earlyOpeningFallback.derived, clueByAnswer),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              ),
              minPublishEntriesForSize(n)
            );
            const openingQualityIssue = publishQualityIssue(
              openingEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );
            const openingCrossed = crossedEntryStats(
              earlyOpeningFallback.grid,
              openingEntries,
              minEntryLenForSize(n)
            );
            const openingEntryCrossings = entryCrossingStats(
              earlyOpeningFallback.grid,
              openingEntries,
              minEntryLenForSize(n)
            );
            const openingChecked = checkedCellStats(earlyOpeningFallback.grid, minEntryLenForSize(n));
            const openingDensity = crosswordDensityFromGrid(earlyOpeningFallback.grid);
            const openingThemeEntries = openingEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const openingCoreThematicEntries = openingEntries.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const openingGenericContextEntries = openingEntries.filter(
              (entry) => finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const openingMinThemeEntries = minThematicEntriesForPublish(n, openingEntries.length);
            const openingMinCoreEntries = minCoreThematicEntriesForPublish(n, openingEntries.length);
            const openingMaxGenericEntries = maxGenericContextEntriesForPublish(n, openingEntries.length);
            const openingPlaceholderCount = openingEntries.filter((entry) =>
              isPlaceholderClue(entry.clue, language)
            ).length;

            if (
              openingEntries.length >= minPublishEntriesForSize(n) &&
              openingCrossed.crossed >= openingEntries.length &&
              openingEntryCrossings.weakEntries.length === 0 &&
              openingDensity >= 0.4 &&
              openingChecked.ratio >= 0.25 &&
              openingThemeEntries >= openingMinThemeEntries &&
              openingCoreThematicEntries >= openingMinCoreEntries &&
              openingGenericContextEntries <= openingMaxGenericEntries &&
              openingPlaceholderCount === 0 &&
              !hasShortLetterRuns(earlyOpeningFallback.grid, minEntryLenForSize(n)) &&
              !openingQualityIssue
            ) {
              console.warn("[generate-crossword] FALLBACK -> early opening deterministic 11x11", {
                attempt: bestPartial.attempt,
                previousEntries: directFallbackPublishEntries.length,
                entries: openingEntries.length,
                thematicEntries: openingThemeEntries,
                coreThematicEntries: openingCoreThematicEntries,
                genericContextEntries: openingGenericContextEntries,
                density: openingDensity,
                checkedRatio: openingChecked.ratio,
                ...earlyOpeningFallback.meta,
              });

              return publishCrosswordResponse(
                {
                  theme,
                  language,
                  size: n,
                  grid: earlyOpeningFallback.grid,
                  entries: openingEntries,
                  meta: {
                    source: "fallback-early-opening-deterministic-11",
                    attempt: best.attempt,
                    fallbackScore: best.fallbackScore,
                    previousEntries: directFallbackPublishEntries.length,
                    crossedEntries: openingCrossed.crossed,
                    checkedRatio: openingChecked.ratio,
                    thematicEntries: openingThemeEntries,
                    minThematicEntries: openingMinThemeEntries,
                    coreThematicEntries: openingCoreThematicEntries,
                    minCoreThematicEntries: openingMinCoreEntries,
                    genericContextEntries: openingGenericContextEntries,
                    density: openingDensity,
                    maxGenericContextEntries: openingMaxGenericEntries,
                    minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                    minEntryCheckedCells: openingEntryCrossings.minCheckedCells,
                    ...earlyOpeningFallback.meta,
                  },
                } satisfies Crossword
              );
            }

            console.warn("[generate-crossword] early opening deterministic rejected", {
              entries: openingEntries.length,
              answers: openingEntries.map((entry) => entry.answer),
              qualityIssue: openingQualityIssue,
              crossed: openingCrossed.crossed,
              weakEntries: openingEntryCrossings.weakEntries,
              density: openingDensity,
              checkedRatio: openingChecked.ratio,
              thematicEntries: openingThemeEntries,
              minThematicEntries: openingMinThemeEntries,
              coreThematicEntries: openingCoreThematicEntries,
              minCoreThematicEntries: openingMinCoreEntries,
              genericContextEntries: openingGenericContextEntries,
              maxGenericContextEntries: openingMaxGenericEntries,
              placeholderCount: openingPlaceholderCount,
              hasShortRuns: hasShortLetterRuns(earlyOpeningFallback.grid, minEntryLenForSize(n)),
              ...earlyOpeningFallback.meta,
            });
          }

          const lateValidatedLayout =
            allowModelRescueFor11 &&
            lateLayoutPoolByAnswer.size >= minPublishEntriesForSize(n) &&
            Date.now() < deadlineMs - 8_000
              ? await requestValidatedLayoutProposal({
                  client,
                  theme,
                  language,
                  size: n,
                  pool: Array.from(lateLayoutPoolByAnswer.values()),
                  themeSet: finalFallbackThematicSet,
                })
              : null;

          if (lateValidatedLayout) {
            const lateLayoutDerived = deriveEntriesFromGrid(
              lateValidatedLayout.grid,
              minEntryLenForSize(n)
            );
            const lateLayoutEntries = pruneForbiddenPublishAnswersIfPossible(
              pruneMaskedDuplicateAnswers(
                repairPublishClues(applyCluesAndOverrides(theme, language, lateLayoutDerived, clueByAnswer), {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                })
              ),
              minPublishEntriesForSize(n)
            );
            const lateLayoutEntryCrossings = entryCrossingStats(
              lateValidatedLayout.grid,
              lateLayoutEntries,
              minEntryLenForSize(n)
            );
            const lateLayoutCrossed = crossedEntryStats(
              lateValidatedLayout.grid,
              lateLayoutEntries,
              minEntryLenForSize(n)
            );
            const lateLayoutQualityIssue = publishQualityIssue(
              lateLayoutEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );
            const lateLayoutThemeEntries = lateLayoutEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const lateLayoutCoreEntries = lateLayoutEntries.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const lateLayoutGenericContextEntries = lateLayoutEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const lateLayoutMinThemeEntries = minThematicEntriesForPublish(n, lateLayoutEntries.length);
            const lateLayoutMinCoreEntries = minCoreThematicEntriesForPublish(n, lateLayoutEntries.length);
            const lateLayoutMaxGenericEntries = maxGenericContextEntriesForPublish(n, lateLayoutEntries.length);

            if (
              lateLayoutEntries.length >= minPublishEntriesForSize(n) &&
              lateLayoutCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              lateLayoutEntryCrossings.weakEntries.length === 0 &&
              lateLayoutThemeEntries >= lateLayoutMinThemeEntries &&
              lateLayoutCoreEntries >= lateLayoutMinCoreEntries &&
              lateLayoutGenericContextEntries <= lateLayoutMaxGenericEntries &&
              !hasShortLetterRuns(lateValidatedLayout.grid, minEntryLenForSize(n)) &&
              !lateLayoutQualityIssue
            ) {
              console.warn("[generate-crossword] FALLBACK -> late validated model layout", {
                attempt: bestPartial.attempt,
                previousEntries: directFallbackPublishEntries.length,
                layoutEntries: lateLayoutEntries.length,
                thematicEntries: lateLayoutThemeEntries,
                coreThematicEntries: lateLayoutCoreEntries,
                genericContextEntries: lateLayoutGenericContextEntries,
                builder: lateValidatedLayout.meta.builder,
              });

              return publishCrosswordResponse(
                {
                  theme,
                  language,
                  size: n,
                  grid: lateValidatedLayout.grid,
                  entries: lateLayoutEntries,
                  meta: {
                    source: "fallback-late-validated-model-layout-11",
                    attempt: best.attempt,
                    previousEntries: directFallbackPublishEntries.length,
                    thematicEntries: lateLayoutThemeEntries,
                    minThematicEntries: lateLayoutMinThemeEntries,
                    coreThematicEntries: lateLayoutCoreEntries,
                    minCoreThematicEntries: lateLayoutMinCoreEntries,
                    genericContextEntries: lateLayoutGenericContextEntries,
                    maxGenericContextEntries: lateLayoutMaxGenericEntries,
                    crossedEntries: lateLayoutCrossed.crossed,
                    minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                    minEntryCheckedCells: lateLayoutEntryCrossings.minCheckedCells,
                    ...lateValidatedLayout.meta,
                  },
                } satisfies Crossword
              );
            }
          }

          const lateValidatedGrid =
            allowModelRescueFor11 &&
            lateLayoutPoolByAnswer.size >= minPublishEntriesForSize(n) &&
            Date.now() < deadlineMs - 8_000
              ? await requestValidatedGridProposal({
                  client,
                  theme,
                  language,
                  size: n,
                  pool: Array.from(lateLayoutPoolByAnswer.values()),
                  themeSet: finalFallbackThematicSet,
                })
              : null;

          if (lateValidatedGrid) {
            const lateGridDerived = deriveEntriesFromGrid(lateValidatedGrid.grid, minEntryLenForSize(n));
            const lateGridEntries = pruneForbiddenPublishAnswersIfPossible(
              pruneMaskedDuplicateAnswers(
                repairPublishClues(applyCluesAndOverrides(theme, language, lateGridDerived, clueByAnswer), {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                })
              ),
              minPublishEntriesForSize(n)
            );
            const lateGridEntryCrossings = entryCrossingStats(
              lateValidatedGrid.grid,
              lateGridEntries,
              minEntryLenForSize(n)
            );
            const lateGridCrossed = crossedEntryStats(
              lateValidatedGrid.grid,
              lateGridEntries,
              minEntryLenForSize(n)
            );
            const lateGridQualityIssue = publishQualityIssue(
              lateGridEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );
            const lateGridThemeEntries = lateGridEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const lateGridCoreEntries = lateGridEntries.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const lateGridGenericContextEntries = lateGridEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const lateGridMinThemeEntries = minThematicEntriesForPublish(n, lateGridEntries.length);
            const lateGridMinCoreEntries = minCoreThematicEntriesForPublish(n, lateGridEntries.length);
            const lateGridMaxGenericEntries = maxGenericContextEntriesForPublish(n, lateGridEntries.length);

            if (
              lateGridEntries.length >= minPublishEntriesForSize(n) &&
              lateGridCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              lateGridEntryCrossings.weakEntries.length === 0 &&
              lateGridThemeEntries >= lateGridMinThemeEntries &&
              lateGridCoreEntries >= lateGridMinCoreEntries &&
              lateGridGenericContextEntries <= lateGridMaxGenericEntries &&
              !hasShortLetterRuns(lateValidatedGrid.grid, minEntryLenForSize(n)) &&
              !lateGridQualityIssue
            ) {
              console.warn("[generate-crossword] FALLBACK -> late validated model grid", {
                attempt: bestPartial.attempt,
                previousEntries: directFallbackPublishEntries.length,
                gridEntries: lateGridEntries.length,
                thematicEntries: lateGridThemeEntries,
                coreThematicEntries: lateGridCoreEntries,
                genericContextEntries: lateGridGenericContextEntries,
                builder: lateValidatedGrid.meta.builder,
              });

              return publishCrosswordResponse(
                {
                  theme,
                  language,
                  size: n,
                  grid: lateValidatedGrid.grid,
                  entries: lateGridEntries,
                  meta: {
                    source: "fallback-late-validated-model-grid-11",
                    attempt: best.attempt,
                    previousEntries: directFallbackPublishEntries.length,
                    thematicEntries: lateGridThemeEntries,
                    minThematicEntries: lateGridMinThemeEntries,
                    coreThematicEntries: lateGridCoreEntries,
                    minCoreThematicEntries: lateGridMinCoreEntries,
                    genericContextEntries: lateGridGenericContextEntries,
                    maxGenericContextEntries: lateGridMaxGenericEntries,
                    crossedEntries: lateGridCrossed.crossed,
                    minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                    minEntryCheckedCells: lateGridEntryCrossings.minCheckedCells,
                    ...lateValidatedGrid.meta,
                  },
                } satisfies Crossword
              );
            }
          }

          const cleanDegradedEntries = directFallbackPublishEntries.filter(
            (entry) => !isForbiddenPublishAnswer(entry.answer)
          );
          const cleanDegradedRebuild =
            cleanDegradedEntries.length >= 10
              ? rebuildGridFromEntries(
                  n,
                  cleanDegradedEntries.map((entry) => ({
                    number: entry.number,
                    row: entry.row,
                    col: entry.col,
                    direction: entry.direction,
                    answer: entry.answer,
                  })),
                  minEntryLenForSize(n)
                )
              : null;
          if (cleanDegradedRebuild && !hasShortLetterRuns(cleanDegradedRebuild.grid, minEntryLenForSize(n))) {
            const rebuiltKeyMap = new Map(
              cleanDegradedEntries.map((entry) => [
                `${entry.direction}:${entry.row}:${entry.col}:${entry.answer}`,
                entry,
              ])
            );
            const cleanDegradedResponseEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(
                cleanDegradedRebuild.derived.map((derived) => {
                  const key = `${derived.direction}:${derived.row}:${derived.col}:${derived.answer}`;
                  return rebuiltKeyMap.get(key) ?? { ...derived, clue: clueByAnswer.get(derived.answer) ?? "" };
                }),
                {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                }
              )
            );
            const cleanDegradedCrossed = crossedEntryStats(
              cleanDegradedRebuild.grid,
              cleanDegradedResponseEntries,
              minEntryLenForSize(n)
            );
            const cleanDegradedEntryCrossingStats = entryCrossingStats(
              cleanDegradedRebuild.grid,
              cleanDegradedResponseEntries,
              minEntryLenForSize(n)
            );
            const cleanDegradedThemeEntries = cleanDegradedResponseEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const cleanDegradedCoreThematicEntries = cleanDegradedResponseEntries.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const cleanDegradedMinCoreThematicEntries = minCoreThematicEntriesForPublish(
              n,
              cleanDegradedResponseEntries.length
            );
            const cleanDegradedGenericContextEntries = cleanDegradedResponseEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const cleanDegradedMaxGenericContextEntries = maxGenericContextEntriesForPublish(
              n,
              cleanDegradedResponseEntries.length
            );
            const cleanDegradedMinThemeEntries = minThematicEntriesForPublish(
              n,
              cleanDegradedResponseEntries.length
            );
            const cleanDegradedQuality = publishQualityIssue(
              cleanDegradedResponseEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );

            if (
              cleanDegradedResponseEntries.length >= minPublishEntriesForSize(n) &&
              cleanDegradedCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              cleanDegradedEntryCrossingStats.weakEntries.length === 0 &&
              cleanDegradedThemeEntries >= cleanDegradedMinThemeEntries &&
              cleanDegradedCoreThematicEntries >= cleanDegradedMinCoreThematicEntries &&
              cleanDegradedGenericContextEntries <= cleanDegradedMaxGenericContextEntries &&
              !cleanDegradedQuality
            ) {
              return publishCrosswordResponse(
                {
                  theme,
                  language,
                  size: n,
                  grid: cleanDegradedRebuild.grid,
                  entries: cleanDegradedResponseEntries,
                  meta: {
                    source: "fallback-clean-degraded-11",
                    attempt: best.attempt,
                    crossedEntries: cleanDegradedCrossed.crossed,
                    thematicEntries: cleanDegradedThemeEntries,
                    minThematicEntries: cleanDegradedMinThemeEntries,
                    coreThematicEntries: cleanDegradedCoreThematicEntries,
                    minCoreThematicEntries: cleanDegradedMinCoreThematicEntries,
                    genericContextEntries: cleanDegradedGenericContextEntries,
                    maxGenericContextEntries: cleanDegradedMaxGenericContextEntries,
                    minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                    minEntryCheckedCells: cleanDegradedEntryCrossingStats.minCheckedCells,
                    targetEntries: minPublishEntriesForSize(n),
                    degraded: true,
                    ...fallbackBuilt.meta,
                  },
                } satisfies Crossword
              );
            }
          }

          const openingFallback =
            n === 11
              ? constructOpeningCrossword11({
                  theme,
                  candidates: fallbackPool,
                  seed: (fallbackStrictSeed ^ 0x7f4a7c15 ^ Math.imul(directFallbackPublishEntries.length + 1, 97)) >>> 0,
                  targetEntries: minPublishEntriesForSize(n),
                  deadlineMs: boundedFallbackDeadline(18_000),
                })
              : null;

          if (openingFallback) {
            const openingEntries = pruneForbiddenPublishAnswersIfPossible(
              pruneMaskedDuplicateAnswers(
                repairPublishClues(
                  applyCluesAndOverrides(theme, language, openingFallback.derived, clueByAnswer),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              ),
              minPublishEntriesForSize(n)
            );
            const openingQualityIssue = publishQualityIssue(
              openingEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );
            const openingCrossed = crossedEntryStats(
              openingFallback.grid,
              openingEntries,
              minEntryLenForSize(n)
            );
            const openingEntryCrossings = entryCrossingStats(
              openingFallback.grid,
              openingEntries,
              minEntryLenForSize(n)
            );
            const openingChecked = checkedCellStats(openingFallback.grid, minEntryLenForSize(n));
            const openingDensity = crosswordDensityFromGrid(openingFallback.grid);
            const openingThemeEntries = openingEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const openingCoreThematicEntries = openingEntries.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const openingGenericContextEntries = openingEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const openingMinThemeEntries = minThematicEntriesForPublish(n, openingEntries.length);
            const openingMinCoreEntries = minCoreThematicEntriesForPublish(n, openingEntries.length);
            const openingMaxGenericEntries = maxGenericContextEntriesForPublish(n, openingEntries.length);
            const openingPlaceholderCount = openingEntries.filter((entry) =>
              isPlaceholderClue(entry.clue, language)
            ).length;

            if (
              openingEntries.length >= minPublishEntriesForSize(n) &&
              openingCrossed.crossed >= openingEntries.length &&
              openingEntryCrossings.weakEntries.length === 0 &&
              openingDensity >= 0.4 &&
              openingChecked.ratio >= 0.25 &&
              openingThemeEntries >= openingMinThemeEntries &&
              openingCoreThematicEntries >= openingMinCoreEntries &&
              openingGenericContextEntries <= openingMaxGenericEntries &&
              openingPlaceholderCount === 0 &&
              !hasShortLetterRuns(openingFallback.grid, minEntryLenForSize(n)) &&
              !openingQualityIssue
            ) {
              console.warn("[generate-crossword] FALLBACK -> opening deterministic 11x11", {
                attempt: bestPartial.attempt,
                previousEntries: directFallbackPublishEntries.length,
                entries: openingEntries.length,
                thematicEntries: openingThemeEntries,
                coreThematicEntries: openingCoreThematicEntries,
                genericContextEntries: openingGenericContextEntries,
                density: openingDensity,
                checkedRatio: openingChecked.ratio,
                ...openingFallback.meta,
              });

              return publishCrosswordResponse(
                {
                  theme,
                  language,
                  size: n,
                  grid: openingFallback.grid,
                  entries: openingEntries,
                  meta: {
                    source: "fallback-opening-deterministic-11",
                    attempt: best.attempt,
                    fallbackScore: best.fallbackScore,
                    previousEntries: directFallbackPublishEntries.length,
                    crossedEntries: openingCrossed.crossed,
                    checkedRatio: openingChecked.ratio,
                    thematicEntries: openingThemeEntries,
                    minThematicEntries: openingMinThemeEntries,
                    coreThematicEntries: openingCoreThematicEntries,
                    minCoreThematicEntries: openingMinCoreEntries,
                    genericContextEntries: openingGenericContextEntries,
                    density: openingDensity,
                    maxGenericContextEntries: openingMaxGenericEntries,
                    minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                    minEntryCheckedCells: openingEntryCrossings.minCheckedCells,
                    ...openingFallback.meta,
                  },
                } satisfies Crossword
              );
            }

            console.warn("[generate-crossword] opening deterministic rejected", {
              entries: openingEntries.length,
              answers: openingEntries.map((entry) => entry.answer),
              qualityIssue: openingQualityIssue,
              crossed: openingCrossed.crossed,
              weakEntries: openingEntryCrossings.weakEntries,
              density: openingDensity,
              checkedRatio: openingChecked.ratio,
              thematicEntries: openingThemeEntries,
              minThematicEntries: openingMinThemeEntries,
              coreThematicEntries: openingCoreThematicEntries,
              minCoreThematicEntries: openingMinCoreEntries,
              genericContextEntries: openingGenericContextEntries,
              maxGenericContextEntries: openingMaxGenericEntries,
              placeholderCount: openingPlaceholderCount,
              hasShortRuns: hasShortLetterRuns(openingFallback.grid, minEntryLenForSize(n)),
              ...openingFallback.meta,
            });
          } else {
            console.warn("[generate-crossword] opening deterministic unavailable", {
              candidatePool: fallbackPool.length,
              targetEntries: minPublishEntriesForSize(n),
            });
          }

          const directFallbackNearThreshold =
            n === 11 &&
            directFallbackPublishEntries.length >= Math.max(10, minPublishEntriesForSize(n) - 1) &&
            (!directFallbackQualityIssue || directFallbackQualityIssue === "too-few-entries") &&
            directFallbackThemeEntries >= minThematicEntriesForPublish(n, directFallbackPublishEntries.length) &&
            directFallbackCoreThematicEntries >= directFallbackMinCoreThematicEntries &&
            directFallbackGenericContextEntries <= directFallbackMaxGenericContextEntries &&
            directFallbackCrossedStats.crossed >= Math.max(6, directFallbackPublishEntries.length - 1) &&
            directFallbackEntryCrossingStats.weakEntries.length === 0 &&
            directFallbackPlaceholderCount === 0 &&
            !hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n));

          if (directFallbackNearThreshold) {
            console.warn("[generate-crossword] FALLBACK -> near-threshold clean 11x11", {
              entries: directFallbackPublishEntries.length,
              thematicEntries: directFallbackThemeEntries,
              coreThematicEntries: directFallbackCoreThematicEntries,
              genericContextEntries: directFallbackGenericContextEntries,
              checkedRatio: directFallbackCheckedStats.ratio,
            });

            return publishCrosswordResponse(
              {
                theme,
                language,
                size: n,
                grid: directFallbackPublishGrid,
                entries: directFallbackPublishEntries,
                meta: {
                  source: "fallback-near-threshold-clean-11",
                  reason: "Published a clean 11x11 candidate one entry below target instead of returning 422.",
                  targetEntries: minPublishEntriesForSize(n),
                  entries: directFallbackPublishEntries.length,
                  thematicEntries: directFallbackThemeEntries,
                  minThematicEntries: minThematicEntriesForPublish(n, directFallbackPublishEntries.length),
                  coreThematicEntries: directFallbackCoreThematicEntries,
                  minCoreThematicEntries: directFallbackMinCoreThematicEntries,
                  genericContextEntries: directFallbackGenericContextEntries,
                  maxGenericContextEntries: directFallbackMaxGenericContextEntries,
                  crossedEntries: directFallbackCrossedStats.crossed,
                  checkedRatio: directFallbackCheckedStats.ratio,
                  minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                  minEntryCheckedCells: directFallbackEntryCrossingStats.minCheckedCells,
                  nearThreshold: true,
                  ...fallbackBuilt.meta,
                },
              } satisfies Crossword
            );
          }

          const directFallbackPlayableDegraded =
            n === 11 &&
            directFallbackPublishEntries.length >= minPublishEntriesForSize(n) &&
            directFallbackThemeEntries >= minThematicEntriesForPublish(n, directFallbackPublishEntries.length) &&
            directFallbackCoreThematicEntries >= directFallbackMinCoreThematicEntries &&
            directFallbackGenericContextEntries <= directFallbackMaxGenericContextEntries &&
            !directFallbackPublishEntries.some((entry) => isForbiddenPublishAnswer(entry.answer)) &&
            directFallbackUnsupportedEntries.length === 0 &&
            directFallbackCrossedStats.crossed >= Math.max(6, directFallbackPublishEntries.length - 1) &&
            directFallbackEntryCrossingStats.weakEntries.length === 0 &&
            directFallbackCheckedStats.ratio >= 0.25 &&
            !hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)) &&
            directFallbackPlaceholderCount === 0 &&
            !directFallbackQualityIssue;

          if (directFallbackPlayableDegraded) {
            console.warn("[generate-crossword] FALLBACK -> playable degraded 11x11", {
              entries: directFallbackPublishEntries.length,
              thematicEntries: directFallbackThemeEntries,
              coreThematicEntries: directFallbackCoreThematicEntries,
              genericContextEntries: directFallbackGenericContextEntries,
              weakEntries: directFallbackEntryCrossingStats.weakEntries,
              checkedRatio: directFallbackCheckedStats.ratio,
              qualityIssue: directFallbackQualityIssue,
              hasShortRuns: hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)),
            });

            return publishCrosswordResponse(
              {
                theme,
                language,
                size: n,
                grid: directFallbackPublishGrid,
                entries: directFallbackPublishEntries,
                meta: {
                  source: "fallback-playable-degraded-11",
                  reason: "Published a playable 11x11 candidate instead of returning 422.",
                  targetEntries: minPublishEntriesForSize(n),
                  entries: directFallbackPublishEntries.length,
                  thematicEntries: directFallbackThemeEntries,
                  minThematicEntries: minThematicEntriesForPublish(n, directFallbackPublishEntries.length),
                  coreThematicEntries: directFallbackCoreThematicEntries,
                  minCoreThematicEntries: directFallbackMinCoreThematicEntries,
                  genericContextEntries: directFallbackGenericContextEntries,
                  maxGenericContextEntries: directFallbackMaxGenericContextEntries,
                  crossedEntries: directFallbackCrossedStats.crossed,
                  checkedRatio: directFallbackCheckedStats.ratio,
                  minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                  minEntryCheckedCells: directFallbackEntryCrossingStats.minCheckedCells,
                  weakCrossingEntries: directFallbackEntryCrossingStats.weakEntries,
                  nearThreshold: true,
                  degraded: true,
                  qualityIssue: directFallbackQualityIssue,
                  hasShortRuns: hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)),
                  ...fallbackBuilt.meta,
                },
              } satisfies Crossword
            );
          }

          const noShortFallbackGrid = blockShortRunsOnly(
            directFallbackPublishGrid,
            minEntryLenForSize(n)
          );
          const noShortFallbackDerived = deriveEntriesFromGrid(
            noShortFallbackGrid,
            minEntryLenForSize(n)
          );
          const noShortFallbackAllowed = new Set(
            directFallbackPublishEntries.map((entry) => entry.answer)
          );
          const noShortFallbackEntries = repairPublishClues(
            applyCluesAndOverrides(
              theme,
              language,
              noShortFallbackDerived,
              clueByAnswer
            ).filter((entry) => noShortFallbackAllowed.has(entry.answer)),
            {
              theme,
              language,
              thematicSet: finalFallbackThematicSet,
              notesByAnswer: fallbackNotesByAnswer,
            }
          );
          const noShortFallbackUnsupported = noShortFallbackEntries.filter(
            (entry) =>
              !isPublishableAnswerForTheme({
                theme,
                answer: entry.answer,
                language,
                size: n,
                note: fallbackNotesByAnswer.get(entry.answer),
                allowContextualGeneric: finalFallbackThematicSet.has(entry.answer),
              })
          );
          const noShortFallbackQuality = publishQualityIssue(
            noShortFallbackEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const noShortFallbackCrossed = crossedEntryStats(
            noShortFallbackGrid,
            noShortFallbackEntries,
            minEntryLenForSize(n)
          );
          const noShortFallbackEntryCrossings = entryCrossingStats(
            noShortFallbackGrid,
            noShortFallbackEntries,
            minEntryLenForSize(n)
          );
          const noShortFallbackChecked = checkedCellStats(
            noShortFallbackGrid,
            minEntryLenForSize(n)
          );
          const noShortFallbackThemeEntries = noShortFallbackEntries.filter((entry) =>
            finalFallbackThematicSet.has(entry.answer)
          ).length;
          const noShortFallbackCoreEntries = noShortFallbackEntries.filter((entry) =>
            finalFallbackCoreThematicSet.has(entry.answer)
          ).length;
          const noShortFallbackGenericContextEntries = noShortFallbackEntries.filter(
            (entry) => finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
          ).length;

          if (
            n === 11 &&
            noShortFallbackEntries.length >= minPublishEntriesForSize(n) &&
            !hasShortLetterRuns(noShortFallbackGrid, minEntryLenForSize(n)) &&
            noShortFallbackUnsupported.length === 0 &&
            noShortFallbackCrossed.crossed >= Math.max(6, noShortFallbackEntries.length - 1) &&
            noShortFallbackEntryCrossings.weakEntries.length === 0 &&
            noShortFallbackChecked.ratio >= 0.25 &&
            noShortFallbackThemeEntries >= minThematicEntriesForPublish(n, noShortFallbackEntries.length) &&
            noShortFallbackCoreEntries >= minCoreThematicEntriesForPublish(n, noShortFallbackEntries.length) &&
            noShortFallbackGenericContextEntries <= maxGenericContextEntriesForPublish(n, noShortFallbackEntries.length) &&
            !noShortFallbackQuality
          ) {
            console.warn("[generate-crossword] FALLBACK -> no-short-run repaired 11x11", {
              entries: noShortFallbackEntries.length,
              thematicEntries: noShortFallbackThemeEntries,
              coreThematicEntries: noShortFallbackCoreEntries,
              genericContextEntries: noShortFallbackGenericContextEntries,
              weakEntries: noShortFallbackEntryCrossings.weakEntries,
              checkedRatio: noShortFallbackChecked.ratio,
            });

            return publishCrosswordResponse(
              {
                theme,
                language,
                size: n,
                grid: noShortFallbackGrid,
                entries: noShortFallbackEntries,
                meta: {
                  source: "fallback-no-short-run-repaired-11",
                  reason: "Removed invalid short letter runs before publishing.",
                  targetEntries: minPublishEntriesForSize(n),
                  entries: noShortFallbackEntries.length,
                  thematicEntries: noShortFallbackThemeEntries,
                  coreThematicEntries: noShortFallbackCoreEntries,
                  genericContextEntries: noShortFallbackGenericContextEntries,
                  crossedEntries: noShortFallbackCrossed.crossed,
                  checkedRatio: noShortFallbackChecked.ratio,
                  minEntryCheckedCells: noShortFallbackEntryCrossings.minCheckedCells,
                  weakCrossingEntries: noShortFallbackEntryCrossings.weakEntries,
                  repairedShortRuns: true,
                  nearThreshold: true,
                  ...fallbackBuilt.meta,
                },
              } satisfies Crossword
            );
          }

          if (n === 11 && noShortFallbackEntries.length >= minPublishEntriesForSize(n) - 2) {
            const lastChanceDensified = densifyCleanGrid11({
              theme,
              grid: noShortFallbackGrid,
              candidates: fallbackPool,
              targetEntries: minPublishEntriesForSize(n),
              seed: (fallbackStrictSeed ^ 0xd1b54a35 ^ Math.imul(noShortFallbackEntries.length + 1, 193)) >>> 0,
              deadlineMs: boundedFallbackDeadline(16_000),
            });

            if (lastChanceDensified) {
              const lastChanceEntries = pruneForbiddenPublishAnswersIfPossible(
                pruneMaskedDuplicateAnswers(
                  repairPublishClues(
                    applyCluesAndOverrides(theme, language, lastChanceDensified.derived, clueByAnswer),
                    {
                      theme,
                      language,
                      thematicSet: finalFallbackThematicSet,
                      notesByAnswer: fallbackNotesByAnswer,
                    }
                  )
                ),
                minPublishEntriesForSize(n)
              ).filter((entry) =>
                isPublishableAnswerForTheme({
                  theme,
                  answer: entry.answer,
                  language,
                  size: n,
                  note: fallbackNotesByAnswer.get(entry.answer),
                  allowContextualGeneric: finalFallbackThematicSet.has(entry.answer),
                })
              );
              const lastChanceQuality = publishQualityIssue(
                lastChanceEntries,
                finalFallbackThematicSet,
                language,
                minPublishEntriesForSize(n)
              );
              const lastChanceEntryCrossings = entryCrossingStats(
                lastChanceDensified.grid,
                lastChanceEntries,
                minEntryLenForSize(n)
              );
              const lastChanceChecked = checkedCellStats(
                lastChanceDensified.grid,
                minEntryLenForSize(n)
              );
              const lastChanceCrossed = crossedEntryStats(
                lastChanceDensified.grid,
                lastChanceEntries,
                minEntryLenForSize(n)
              );
              const lastChanceThemeEntries = lastChanceEntries.filter((entry) =>
                finalFallbackThematicSet.has(entry.answer)
              ).length;
              const lastChanceCoreEntries = lastChanceEntries.filter((entry) =>
                finalFallbackCoreThematicSet.has(entry.answer)
              ).length;
              const lastChanceGenericContextEntries = lastChanceEntries.filter(
                (entry) => finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
              ).length;

              if (
                lastChanceEntries.length >= minPublishEntriesForSize(n) &&
                lastChanceCrossed.crossed >= minCrossedEntriesForPublish(n) &&
                lastChanceEntryCrossings.weakEntries.length === 0 &&
                lastChanceChecked.ratio >= 0.25 &&
                lastChanceThemeEntries >= minThematicEntriesForPublish(n, lastChanceEntries.length) &&
                lastChanceCoreEntries >= minCoreThematicEntriesForPublish(n, lastChanceEntries.length) &&
                lastChanceGenericContextEntries <= maxGenericContextEntriesForPublish(n, lastChanceEntries.length) &&
                !hasShortLetterRuns(lastChanceDensified.grid, minEntryLenForSize(n)) &&
                !lastChanceQuality
              ) {
                console.warn("[generate-crossword] FALLBACK -> last-chance weak repair 11x11", {
                  entries: lastChanceEntries.length,
                  thematicEntries: lastChanceThemeEntries,
                  coreThematicEntries: lastChanceCoreEntries,
                  genericContextEntries: lastChanceGenericContextEntries,
                  weakEntries: lastChanceEntryCrossings.weakEntries,
                  checkedRatio: lastChanceChecked.ratio,
                  added: lastChanceDensified.added,
                });

                return publishCrosswordResponse(
                  {
                    theme,
                    language,
                    size: n,
                    grid: lastChanceDensified.grid,
                    entries: lastChanceEntries,
                    meta: {
                      source: "fallback-last-chance-weak-repair-11",
                      reason: "Pruned weak entries and densified before returning 422.",
                      targetEntries: minPublishEntriesForSize(n),
                      entries: lastChanceEntries.length,
                      thematicEntries: lastChanceThemeEntries,
                      coreThematicEntries: lastChanceCoreEntries,
                      genericContextEntries: lastChanceGenericContextEntries,
                      crossedEntries: lastChanceCrossed.crossed,
                      checkedRatio: lastChanceChecked.ratio,
                      minEntryCheckedCells: lastChanceEntryCrossings.minCheckedCells,
                      weakCrossingEntries: lastChanceEntryCrossings.weakEntries,
                      repairedWeakEntries: true,
                      added: lastChanceDensified.added,
                      ...fallbackBuilt.meta,
                    },
                  } satisfies Crossword
                );
              }

              console.warn("[generate-crossword] last-chance weak repair rejected", {
                entries: lastChanceEntries.length,
                thematicEntries: lastChanceThemeEntries,
                coreThematicEntries: lastChanceCoreEntries,
                genericContextEntries: lastChanceGenericContextEntries,
                weakEntries: lastChanceEntryCrossings.weakEntries,
                checkedRatio: lastChanceChecked.ratio,
                qualityIssue: lastChanceQuality,
                hasShortRuns: hasShortLetterRuns(lastChanceDensified.grid, minEntryLenForSize(n)),
                added: lastChanceDensified.added,
                answers: lastChanceEntries.map((entry) => entry.answer),
              });
            }
          }

          return makeGenerationErrorResponse(
            {
              source: "generation-error",
              reason: "No se pudo reconstruir un 11x11 completamente chequeado.",
              finalEntries: directFallbackPublishEntries.length,
              finalThematicEntries: directFallbackThemeEntries,
              finalCrossedEntries: directFallbackCrossedStats.crossed,
              minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
              weakCrossingEntries: directFallbackEntryCrossingStats.weakEntries,
              finalCheckedRatio: directFallbackCheckedStats.ratio,
              finalPlaceholderCount: directFallbackPlaceholderCount,
              finalQualityIssue: directFallbackQualityIssue,
              finalUnsupportedAnswers: directFallbackUnsupportedEntries.map((entry) => entry.answer),
              finalHasShortRuns: hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)),
              finalAnswers: directFallbackPublishEntries.map((entry) => entry.answer),
              lastAnswerStats,
              lastBuildIssue,
              lastPoolSample: lastAttemptPool.slice(0, 40).map((candidate) => ({
                answer: candidate.answer,
                source: candidate.source,
                thematic: candidate.thematic,
              })),
            },
            422
          );
        }

        const placeholderCount = checkedFallbackForResponse.entries.filter((e) =>
          isPlaceholderClue(e.clue, language)
        ).length;
        const repairedCheckedFallbackEntriesRaw = pruneForbiddenPublishAnswersIfPossible(
          pruneMaskedDuplicateAnswers(
            repairPublishClues(checkedFallbackForResponse.entries, {
              theme,
              language,
              thematicSet: broadPublishableFallbackAnswerSet,
              notesByAnswer: fallbackNotesByAnswer,
            })
          ),
          minPublishEntriesForSize(n)
        );
        const repairedCheckedFallbackEntries = repairedCheckedFallbackEntriesRaw.filter((entry) =>
          isPublishableAnswerForTheme({
            theme,
            answer: entry.answer,
            language,
            size: n,
            note: fallbackNotesByAnswer.get(entry.answer),
            allowContextualGeneric: broadPublishableFallbackAnswerSet.has(entry.answer),
          })
        );
        const checkedFallbackQualityIssue = publishQualityIssue(
          repairedCheckedFallbackEntries,
          broadPublishableFallbackAnswerSet,
          language,
          minPublishEntriesForSize(n)
        );
        const checkedStats = checkedCellStats(
          checkedFallbackForResponse.grid,
          minEntryLenForSize(n)
        );
        const checkedEntryCrossingStats = entryCrossingStats(
          checkedFallbackForResponse.grid,
          repairedCheckedFallbackEntries,
          minEntryLenForSize(n)
        );
        const checkedThemeEntries = repairedCheckedFallbackEntries.filter((entry) =>
          broadPublishableFallbackAnswerSet.has(entry.answer)
        ).length;
        const checkedCoreThematicEntries = repairedCheckedFallbackEntries.filter((entry) =>
          finalFallbackCoreThematicSet.has(entry.answer)
        ).length;
        const checkedMinCoreThematicEntries = minCoreThematicEntriesForPublish(
          n,
          repairedCheckedFallbackEntries.length
        );
        const checkedGenericContextEntries = repairedCheckedFallbackEntries.filter((entry) =>
          broadPublishableFallbackAnswerSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
        ).length;
        const checkedMaxGenericContextEntries = maxGenericContextEntriesForPublish(
          n,
          repairedCheckedFallbackEntries.length
        );
        const checkedMinThemeEntries = minThematicEntriesForPublish(
          n,
          repairedCheckedFallbackEntries.length
        );

        if (
          hasShortLetterRuns(checkedFallbackForResponse.grid, minEntryLenForSize(n)) ||
          checkedFallbackQualityIssue ||
          (n === 11 &&
            (repairedCheckedFallbackEntries.length < minPublishEntriesForSize(n) ||
              checkedThemeEntries < checkedMinThemeEntries ||
              checkedCoreThematicEntries < checkedMinCoreThematicEntries ||
              checkedGenericContextEntries > checkedMaxGenericContextEntries ||
              checkedEntryCrossingStats.weakEntries.length > 0))
        ) {
          return makeGenerationErrorResponse(
            {
              source: "generation-error",
              reason:
                checkedFallbackQualityIssue ??
                (checkedCoreThematicEntries < checkedMinCoreThematicEntries
                  ? "La grilla final no alcanzo suficientes entradas tematicas reales."
                  : "La grilla final contenia secuencias demasiado cortas."),
              finalEntries: repairedCheckedFallbackEntries.length,
              finalThematicEntries: checkedThemeEntries,
              minThematicEntries: checkedMinThemeEntries,
              finalCoreThematicEntries: checkedCoreThematicEntries,
              minCoreThematicEntries: checkedMinCoreThematicEntries,
              finalGenericContextEntries: checkedGenericContextEntries,
              maxGenericContextEntries: checkedMaxGenericContextEntries,
              minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
              weakCrossingEntries: checkedEntryCrossingStats.weakEntries,
            },
            422
          );
        }

        console.warn("[generate-crossword] FALLBACK -> bestPartial fully checked", {
          attempt: bestPartial.attempt,
          entries: checkedFallbackForResponse.entries.length,
          usedAnswers: fallbackBuilt.usedAnswers.length,
          checkedRatio: checkedStats.ratio,
          thematicEntries: checkedThemeEntries,
          coreThematicEntries: checkedCoreThematicEntries,
          genericContextEntries: checkedGenericContextEntries,
          fallbackScore: bestPartial.fallbackScore,
          placeholderCount,
          builder: fallbackBuilt.meta?.builder ?? null,
        });

        return publishCrosswordResponse(
          {
            theme,
            language,
            size: n,
            grid: checkedFallbackForResponse.grid,
            entries: repairedCheckedFallbackEntries,
            meta: {
              source: "fallback-best-built-fully-checked",
              attempt: best.attempt,
              fallbackScore: best.fallbackScore,
              checkedRatio: checkedStats.ratio,
              thematicEntries: checkedThemeEntries,
              minThematicEntries: checkedMinThemeEntries,
              coreThematicEntries: checkedCoreThematicEntries,
              minCoreThematicEntries: checkedMinCoreThematicEntries,
              genericContextEntries: checkedGenericContextEntries,
              maxGenericContextEntries: checkedMaxGenericContextEntries,
              minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
              minEntryCheckedCells: checkedEntryCrossingStats.minCheckedCells,
              placeholderCount,
              ...fallbackBuilt.meta,
            },
          } satisfies Crossword
        );
      }

      const fallbackEntriesForResponse =
        n === 11 && fullyCheckedFallback && fullyCheckedFallback.entries.length >= 6
          ? fullyCheckedFallback.entries
          : n === 11 && sanitizedFullyCheckedFallback && sanitizedFullyCheckedFallback.entries.length >= 4
          ? sanitizedFullyCheckedFallback.entries
          : n === 11 && exactFullyCheckedFallback && exactFullyCheckedFallback.entries.length >= 4
          ? exactFullyCheckedFallback.entries
          : n === 11 && exactPublishableFallback && exactPublishableFallback.entries.length >= 3
          ? exactPublishableFallback.entries
          : n === 11 && cluedExactPublishableFallback && cluedExactPublishableFallback.entries.length >= 2
          ? cluedExactPublishableFallback.entries
          : n === 11 && minimalExactPublishableFallback && minimalExactPublishableFallback.entries.length >= 2
          ? minimalExactPublishableFallback.entries
          : n === 11 && playableFallback && playableFallback.entries.length >= 3
          ? playableFallback.entries
          : entries;
      const fallbackGridForResponse =
        n === 11 && fullyCheckedFallback && fullyCheckedFallback.entries.length >= 6
          ? fullyCheckedFallback.grid
          : n === 11 && sanitizedFullyCheckedFallback && sanitizedFullyCheckedFallback.entries.length >= 4
          ? sanitizedFullyCheckedFallback.grid
          : n === 11 && exactFullyCheckedFallback && exactFullyCheckedFallback.entries.length >= 4
          ? exactFullyCheckedFallback.grid
          : n === 11 && exactPublishableFallback && exactPublishableFallback.entries.length >= 3
          ? exactPublishableFallback.grid
          : n === 11 && cluedExactPublishableFallback && cluedExactPublishableFallback.entries.length >= 2
          ? cluedExactPublishableFallback.grid
          : n === 11 && minimalExactPublishableFallback && minimalExactPublishableFallback.entries.length >= 2
          ? minimalExactPublishableFallback.grid
          : n === 11 && playableFallback && playableFallback.entries.length >= 3
          ? playableFallback.grid
          : finalFallbackGridForResponse;
      const repairedFallbackEntriesForResponseRaw = pruneForbiddenPublishAnswersIfPossible(
        pruneMaskedDuplicateAnswers(
          repairPublishClues(fallbackEntriesForResponse, {
            theme,
            language,
            thematicSet: finalFallbackThematicSet,
            notesByAnswer: fallbackNotesByAnswer,
          })
        ),
        minPublishEntriesForSize(n)
      );
      const repairedFallbackEntriesForResponse = repairedFallbackEntriesForResponseRaw.filter((entry) =>
        isPublishableAnswerForTheme({
          theme,
          answer: entry.answer,
          language,
          size: n,
          note: fallbackNotesByAnswer.get(entry.answer),
          allowContextualGeneric: finalFallbackThematicSet.has(entry.answer),
        })
      );
      const placeholderCount = repairedFallbackEntriesForResponse.filter((e) =>
        isPlaceholderClue(e.clue, language)
      ).length;
      const checkedStats = checkedCellStats(fallbackGridForResponse, minEntryLenForSize(n));
      const fallbackEntryCrossingStats = entryCrossingStats(
        fallbackGridForResponse,
        repairedFallbackEntriesForResponse,
        minEntryLenForSize(n)
      );
      const fallbackThemeEntries = repairedFallbackEntriesForResponse.filter((entry) =>
        finalFallbackThematicSet.has(entry.answer)
      ).length;
      const fallbackCoreThematicEntries = repairedFallbackEntriesForResponse.filter((entry) =>
        finalFallbackCoreThematicSet.has(entry.answer)
      ).length;
      const fallbackMinCoreThematicEntries = minCoreThematicEntriesForPublish(
        n,
        repairedFallbackEntriesForResponse.length
      );
      const fallbackGenericContextEntries = repairedFallbackEntriesForResponse.filter((entry) =>
        finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
      ).length;
      const fallbackMaxGenericContextEntries = maxGenericContextEntriesForPublish(
        n,
        repairedFallbackEntriesForResponse.length
      );
      const fallbackMinThemeEntries = minThematicEntriesForPublish(
        n,
        repairedFallbackEntriesForResponse.length
      );
      const fallbackQualityIssue = publishQualityIssue(
        repairedFallbackEntriesForResponse,
        finalFallbackThematicSet,
        language,
        minPublishEntriesForSize(n)
      );
      const fallbackStructurallyPublishable =
        n === 11 &&
        repairedFallbackEntriesForResponse.length >= minPublishEntriesForSize(n) &&
        fallbackThemeEntries >= fallbackMinThemeEntries &&
        placeholderCount === 0 &&
        fallbackEntryCrossingStats.weakEntries.length === 0 &&
        !hasShortLetterRuns(fallbackGridForResponse, minEntryLenForSize(n)) &&
        !fallbackQualityIssue;
      const allowRelaxedCoreFallback = process.env.ALLOW_RELAXED_CORE_11 === "1";
      const fallbackNearCoreEnough =
        fallbackCoreThematicEntries >= fallbackMinCoreThematicEntries &&
        fallbackGenericContextEntries <= fallbackMaxGenericContextEntries;

      if (
        n === 11 &&
        (repairedFallbackEntriesForResponse.length < minPublishEntriesForSize(n) ||
          fallbackThemeEntries < fallbackMinThemeEntries ||
          fallbackCoreThematicEntries < fallbackMinCoreThematicEntries ||
          fallbackGenericContextEntries > fallbackMaxGenericContextEntries ||
          fallbackEntryCrossingStats.weakEntries.length > 0 ||
          placeholderCount > 0 ||
          hasShortLetterRuns(fallbackGridForResponse, minEntryLenForSize(n)) ||
          fallbackQualityIssue)
      ) {
        if (allowRelaxedCoreFallback && fallbackStructurallyPublishable && fallbackNearCoreEnough) {
          console.warn("[generate-crossword] FALLBACK -> relaxed core gate", {
            attempt: bestPartial.attempt,
            entries: repairedFallbackEntriesForResponse.length,
            thematicEntries: fallbackThemeEntries,
            coreThematicEntries: fallbackCoreThematicEntries,
            minCoreThematicEntries: fallbackMinCoreThematicEntries,
            genericContextEntries: fallbackGenericContextEntries,
            maxGenericContextEntries: fallbackMaxGenericContextEntries,
            checkedRatio: checkedStats.ratio,
            builder: fallbackBuilt.meta?.builder ?? null,
          });

          return publishCrosswordResponse(
            {
              theme,
              language,
              size: n,
              grid: fallbackGridForResponse,
              entries: repairedFallbackEntriesForResponse,
              meta: {
                source: "fallback-best-built-relaxed-core",
                attempt: best.attempt,
                fallbackScore: best.fallbackScore,
                checkedRatio: checkedStats.ratio,
                thematicEntries: fallbackThemeEntries,
                minThematicEntries: fallbackMinThemeEntries,
                coreThematicEntries: fallbackCoreThematicEntries,
                minCoreThematicEntries: fallbackMinCoreThematicEntries,
                genericContextEntries: fallbackGenericContextEntries,
                maxGenericContextEntries: fallbackMaxGenericContextEntries,
                placeholderCount,
                relaxedCoreGate: true,
                ...fallbackBuilt.meta,
              },
            } satisfies Crossword
          );
        }

        return makeGenerationErrorResponse(
          {
            source: "generation-error",
            reason:
              fallbackQualityIssue ??
              (fallbackCoreThematicEntries < fallbackMinCoreThematicEntries
                ? "La grilla final no alcanzo suficientes entradas tematicas reales."
                : "No se pudo reconstruir un 11x11 completamente chequeado."),
            finalEntries: repairedFallbackEntriesForResponse.length,
            finalThematicEntries: fallbackThemeEntries,
            minThematicEntries: fallbackMinThemeEntries,
            finalCoreThematicEntries: fallbackCoreThematicEntries,
            minCoreThematicEntries: fallbackMinCoreThematicEntries,
            finalGenericContextEntries: fallbackGenericContextEntries,
            maxGenericContextEntries: fallbackMaxGenericContextEntries,
            minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
            weakCrossingEntries: fallbackEntryCrossingStats.weakEntries,
            finalPlaceholderCount: placeholderCount,
            finalHasShortRuns: hasShortLetterRuns(fallbackGridForResponse, minEntryLenForSize(n)),
            finalQualityIssue: fallbackQualityIssue,
          },
          422
        );
      }

      console.warn("[generate-crossword] FALLBACK -> bestPartial", {
        attempt: bestPartial.attempt,
        entries: repairedFallbackEntriesForResponse.length,
        usedAnswers: fallbackBuilt.usedAnswers.length,
        checkedRatio: checkedStats.ratio,
        thematicEntries: fallbackThemeEntries,
        coreThematicEntries: fallbackCoreThematicEntries,
        genericContextEntries: fallbackGenericContextEntries,
        fallbackScore: bestPartial.fallbackScore,
        placeholderCount,
        builder: fallbackBuilt.meta?.builder ?? null,
      });

      return publishCrosswordResponse(
        {
          theme,
          language,
          size: n,
          grid: fallbackGridForResponse,
          entries: repairedFallbackEntriesForResponse,
          meta: {
            source: "fallback-best-built",
            attempt: best.attempt,
            fallbackScore: best.fallbackScore,
            checkedRatio: checkedStats.ratio,
            thematicEntries: fallbackThemeEntries,
            minThematicEntries: fallbackMinThemeEntries,
            coreThematicEntries: fallbackCoreThematicEntries,
            minCoreThematicEntries: fallbackMinCoreThematicEntries,
            genericContextEntries: fallbackGenericContextEntries,
            maxGenericContextEntries: fallbackMaxGenericContextEntries,
            minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
            minEntryCheckedCells: fallbackEntryCrossingStats.minCheckedCells,
            placeholderCount,
            ...fallbackBuilt.meta,
          },
        } satisfies Crossword
      );
    }

    if (lastAttemptPool.length === 0 && lastModelError) {
      return makeGenerationErrorResponse(
        {
          source: "openai-error",
          reason: "No se pudo obtener el banco inicial de respuestas tematicas desde OpenAI.",
          lastModelError,
          lastAnswerbankIssue,
        },
        503
      );
    }

    if (n === 11) {
      return makeGenerationErrorResponse(
        {
          source: "generation-error",
          reason: "No 11x11 candidate reached the publication threshold.",
          minEntries: minPublishEntriesForSize(n),
          lastAttemptPool: lastAttemptPool.length,
          lastModelError,
          lastAnswerbankIssue,
          lastBuildIssue,
          lastAnswerStats,
        },
        422
      );
    }

    return makeGenerationErrorResponse(
      {
        source: "generation-error",
        reason: "No se pudo generar un crucigrama aceptable.",
        minEntries: minPublishEntriesForSize(n),
        lastModelError,
        lastAnswerbankIssue,
        lastBuildIssue,
        lastAnswerStats,
      },
      422
    );
  } catch (err: unknown) {
    return makeGenerationErrorResponse(
      {
        source: "generation-error",
        reason: err instanceof Error ? err.message : "unknown error",
      },
      500
    );
  }
}
