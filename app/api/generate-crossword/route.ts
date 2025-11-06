// /app/api/generate-crossword/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { Crossword, Entry, isCrossword, explainCrosswordError } from "../../../lib/crossword";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MODEL = "gpt-4o-mini";

/* ---------- Prompts ---------- */
function buildSystemPrompt(): string {
  return [
    "Eres un generador de crucigramas ESTRICTO. Responde SOLO JSON válido.",
    "Requisitos:",
    "- Crucigrama CUADRADO, tamaño entre 9 y 13 (preferir 9).",
    "- '#' indica bloque. Una letra por celda (A–Z, admite acentos).",
    "- Usa 'entries' con: number,row,col,direction('across'|'down'),answer,clue.",
    "- Las answers deben encajar en la grilla SIN pisar '#'.",
    "- Numera clásicos: izquierda→derecha (across) y arriba→abajo (down).",
    "- Nivel fácil/medio, pistas claras, sin nombres demasiado oscuros.",
  ].join("\n");
}

function buildUserPrompt(theme: string, language: string): string {
  return [
    `Tema: "${theme}".`,
    `Idioma de las PISTAS: ${language}.`,
    "Preferí tamaño 9x9. Permitido 10–13 si mejora cruces.",
    "Objetivo: 12–18 palabras, cruces limpios y sin letras sueltas.",
    "Devuelve JSON con: title, language, size, grid (NxN; '#' en bloques), entries[].",
  ].join("\n");
}

// Prompt más estricto para reintento: fija 9x9 y SOLO entries
function buildRetryPrompt(theme: string, language: string): string {
  return [
    `Tema: "${theme}".`,
    `Idioma de las PISTAS: ${language}.`,
    "Generá un crucigrama de tamaño EXACTO 9x9.",
    "Devuelve SOLO este JSON (sin campos extra, SIN 'grid'):",
    `{
  "title": "Crucigrama sobre ${theme}",
  "language": "${language}",
  "size": 9,
  "entries": [
    // EXACTAMENTE 14 entradas: 7 'across' y 7 'down'.
    // Cada item: { "number": <entero>, "row": 0..8, "col": 0..8, "direction": "across"|"down", "answer": "PALABRA", "clue": "Texto de pista" }
    // Coordenadas dentro de 0..8. No repitas (number,direction).
  ]
}`,
    "Responde SOLO JSON válido.",
  ].join("\n");
}

/* ---------- Utilidades ---------- */
type OAErrorShape = {
  response?: {
    status?: number;
    data?: { error?: { code?: string; type?: string; message?: string } };
  };
  message?: string;
};

function extractOpenAIError(e: unknown): { status?: number; code?: string; type?: string; message: string } {
  const base: { status?: number; code?: string; type?: string; message: string } = { message: "Error interno" };
  const err = e as OAErrorShape;
  if (typeof err?.message === "string") base.message = err.message;
  const resp = err?.response;
  if (resp) {
    if (typeof resp.status === "number") base.status = resp.status;
    const inner = resp.data?.error;
    if (inner) {
      if (typeof inner.code === "string") base.code = inner.code;
      if (typeof inner.type === "string") base.type = inner.type;
      if (typeof inner.message === "string") base.message = inner.message;
    }
  }
  return base;
}

function maskKey(k: string | undefined) {
  if (!k) return "undefined";
  const s = k.trim();
  return `${s.slice(0, 6)}...${s.slice(-4)} (len=${s.length})`;
}

/* ---------- Reconstrucción ---------- */
function clampSize(n: number | undefined): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 9;
  return Math.max(9, Math.min(13, v));
}

function sanitizeEntry(raw: unknown, size: number): Entry | null {
  const e = raw as Record<string, unknown>;
  const dirRaw = e?.direction;
  const dir = dirRaw === "down" ? "down" : dirRaw === "across" ? "across" : null;

  const number = typeof e?.number === "number" ? e.number : NaN;
  const row = typeof e?.row === "number" ? e.row : NaN;
  const col = typeof e?.col === "number" ? e.col : NaN;
  const ansRaw = typeof e?.answer === "string" ? e.answer : "";
  const clueRaw = typeof e?.clue === "string" ? e.clue : "";

  if (!dir || !Number.isFinite(number) || !Number.isFinite(row) || !Number.isFinite(col)) return null;
  if (row < 0 || col < 0 || row >= size || col >= size) return null;

  const answer = ansRaw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/[^A-ZÑ]/g, "");

  const clue = clueRaw.trim();
  if (!answer || !clue) return null;

  return { number, row, col, direction: dir, answer, clue };
}

function rebuildGrid(candidate: Crossword): Crossword {
  const size = clampSize(candidate.size || candidate.grid?.length || 9);
  const grid: string[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => "#"));

  const entries = [...candidate.entries].sort((a, b) => a.number - b.number);
  for (const e of entries) {
    const word = e.answer.toUpperCase();
    if (e.direction === "across") {
      if (e.col + word.length > size) continue;
      for (let i = 0; i < word.length; i++) {
        const r = e.row;
        const c = e.col + i;
        const ch = word[i];
        grid[r][c] = ch;
      }
    } else {
      if (e.row + word.length > size) continue;
      for (let i = 0; i < word.length; i++) {
        const r = e.row + i;
        const c = e.col;
        const ch = word[i];
        grid[r][c] = ch;
      }
    }
  }

  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (grid[r][c] === "") grid[r][c] = "#";

  return { ...candidate, size, grid };
}

/* ---------- Core ---------- */
async function callOpenAI(client: OpenAI, theme: string, language: string, attempt: 1 | 2) {
  const messages =
    attempt === 1
      ? [
          { role: "system" as const, content: buildSystemPrompt() },
          { role: "user" as const, content: buildUserPrompt(theme, language) },
        ]
      : [
          { role: "system" as const, content: buildSystemPrompt() },
          { role: "user" as const, content: buildRetryPrompt(theme, language) },
        ];

  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: attempt === 1 ? 0.3 : 0.2,
    response_format: { type: "json_object" },
    messages,
  });

  const content = completion.choices[0]?.message?.content ?? "";
  return content;
}

function sanitizeAndBuild(rawUnknown: unknown, fallbackTitle: string, fallbackLang: string): { built: Crossword; count: number } {
  const raw = rawUnknown as { size?: unknown; grid?: unknown; entries?: unknown; title?: unknown; language?: unknown };

  const size = clampSize(
    typeof raw.size === "number" ? raw.size : Array.isArray(raw.grid) ? (raw.grid as unknown[]).length : 9
  );

  const entriesRaw = Array.isArray(raw.entries) ? (raw.entries as unknown[]) : [];
  const seen = new Set<string>();
  const cleanEntries = entriesRaw
    .map((e: unknown) => sanitizeEntry(e, size))
    .filter((e): e is Entry => e !== null)
    .filter((e: Entry) => {
      const k = `${e.number}:${e.direction}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  const base: Crossword = {
    title: typeof raw.title === "string" && raw.title.trim() ? (raw.title as string).trim() : fallbackTitle,
    language:
      typeof raw.language === "string" && (raw.language as string).trim()
        ? (raw.language as string)
        : fallbackLang,
    size,
    grid: Array.from({ length: size }, () => Array.from({ length: size }, () => "#")),
    entries: cleanEntries,
    meta: { source: "openai" },
  };

  const rebuilt = rebuildGrid(base);
  return { built: rebuilt, count: cleanEntries.length };
}

export async function POST(req: NextRequest) {
  try {
    const bodyUnknown: unknown = await req.json();
    const body = bodyUnknown as { theme?: unknown; language?: unknown };
    const theme = body.theme;
    const language = body.language;

    if (typeof theme !== "string" || typeof language !== "string") {
      return NextResponse.json({ error: 'Faltan "theme" y/o "language" (string).' }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY no configurada." }, { status: 500 });
    console.log("[generate-crossword] Using OPENAI_API_KEY:", maskKey(apiKey));

    const client = new OpenAI({ apiKey });

    // ---- Intento 1
    let content = await callOpenAI(client, theme, language, 1);
    let raw1: unknown;
    try {
      raw1 = JSON.parse(content);
    } catch {
      raw1 = {};
    }
    const { built: candidate1, count: count1 } = sanitizeAndBuild(
      raw1,
      `Crucigrama sobre ${theme}`,
      language
    );

    // Si no hay suficientes entries, Intento 2 (más estricto)
    const MIN_ENTRIES = 10; // umbral mínimo razonable para un 9x9
    let finalPuzzle = candidate1;

    if (count1 < MIN_ENTRIES) {
      content = await callOpenAI(client, theme, language, 2);
      let raw2: unknown;
      try {
        raw2 = JSON.parse(content);
      } catch {
        raw2 = {};
      }
      const { built: candidate2, count: count2 } = sanitizeAndBuild(
        raw2,
        `Crucigrama sobre ${theme}`,
        language
      );

      if (count2 >= MIN_ENTRIES) {
        finalPuzzle = candidate2;
      } else {
        return NextResponse.json({ error: "Muy pocas 'entries' válidas tras sanitizar." }, { status: 502 });
      }
    }

    if (!isCrossword(finalPuzzle)) {
      return NextResponse.json(
        { error: `Formato inválido: ${explainCrosswordError(finalPuzzle)}` },
        { status: 502 }
      );
    }

    return NextResponse.json({ ...finalPuzzle, meta: { ...(finalPuzzle.meta ?? {}), source: "openai" } }, { status: 200 });
  } catch (e: unknown) {
    const d = extractOpenAIError(e);
    console.error("generate-crossword error:", d, e);
    const isQuota = d.status === 429 || d.code === "insufficient_quota" || /quota/i.test(d.message ?? "");
    if (isQuota) {
      const demo: Crossword = {
        title: "Demo 9x9",
        language: "es",
        size: 9,
        grid: Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => "#")),
        entries: [
          { number: 1, row: 0, col: 0, direction: "across", answer: "ARGENTINA", clue: "1. País de América del Sur." },
          { number: 2, row: 0, col: 0, direction: "down", answer: "ANDES", clue: "2. Cordillera occidental." },
        ],
        meta: { source: "demo-429" },
      };
      const rebuilt = rebuildGrid(demo);
      return NextResponse.json(rebuilt, { status: 200 });
    }
    const http = d.status && d.status >= 400 && d.status < 600 ? d.status : 502;
    return NextResponse.json({ error: d.message || "Error interno." }, { status: http });
  }
}
