// /app/api/generate-crossword/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { Crossword, Entry, isCrossword, explainCrosswordError } from "../../../lib/crossword";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MODEL = "gpt-4o-mini";

/* ---------- Prompt estricto ---------- */
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
    "JSON EXACTO (ejemplo):",
    `{
  "title": "Crucigrama sobre X",
  "language": "es",
  "size": 9,
  "grid": [["#","A","..."] /* NxN */],
  "entries": [
    { "number": 1, "row": 0, "col": 0, "direction": "across", "answer": "ARGENTINA", "clue": "1. País en América del Sur." },
    { "number": 2, "row": 0, "col": 0, "direction": "down",   "answer": "ANDES",     "clue": "2. Cordillera occidental." }
  ],
  "meta": { "source": "openai" }
}`,
  ].join("\n");
}

function buildUserPrompt(theme: string, language: string): string {
  return [
    `Tema: "${theme}".`,
    `Idioma de las PISTAS: ${language}.`,
    "Preferí tamaño 9x9. Permitido 10–13 si mejora cruces.",
    "Objetivo: 12–18 palabras, cruces limpios y sin letras sueltas.",
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

/* ---------- Reconstrucción de grilla desde entries ---------- */
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
    .replace(/[^A-ZÑ]/g, ""); // dejamos letras (incl. Ñ)

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
        if (grid[r][c] === "#" || grid[r][c] === ch || grid[r][c] === "") grid[r][c] = ch;
        else grid[r][c] = ch;
      }
    } else {
      if (e.row + word.length > size) continue;
      for (let i = 0; i < word.length; i++) {
        const r = e.row + i;
        const c = e.col;
        const ch = word[i];
        if (grid[r][c] === "#" || grid[r][c] === ch || grid[r][c] === "") grid[r][c] = ch;
        else grid[r][c] = ch;
      }
    }
  }

  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (grid[r][c] === "") grid[r][c] = "#";

  return { ...candidate, size, grid };
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
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(theme, language) },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return NextResponse.json({ error: "Respuesta vacía." }, { status: 502 });

    // --- 1) Parsear y SANITIZAR siempre, ignorando la grilla que manda la IA
    let rawUnknown: unknown;
    try {
      rawUnknown = JSON.parse(content);
    } catch {
      return NextResponse.json({ error: "JSON inválido." }, { status: 502 });
    }

    const raw = rawUnknown as { size?: unknown; grid?: unknown; entries?: unknown; title?: unknown; language?: unknown };
    const size = clampSize(typeof raw.size === "number" ? raw.size : Array.isArray(raw.grid) ? (raw.grid as unknown[]).length : 9);

    if (!Array.isArray(raw.entries)) {
      return NextResponse.json({ error: "Faltan 'entries' en la respuesta de IA." }, { status: 502 });
    }

    // Sanitizar entries y descartar las inválidas/fuera de rango
    const seen = new Set<string>();
    const cleanEntries = (raw.entries as unknown[])
      .map((e: unknown) => sanitizeEntry(e, size))
      .filter((e): e is Entry => e !== null)
      .filter((e: Entry) => {
        const k = `${e.number}:${e.direction}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    if (cleanEntries.length < 8) {
      return NextResponse.json({ error: "Muy pocas 'entries' válidas tras sanitizar." }, { status: 502 });
    }

    const base: Crossword = {
      title: typeof raw.title === "string" && raw.title.trim() ? (raw.title as string).trim() : `Crucigrama sobre ${theme}`,
      language: typeof raw.language === "string" && (raw.language as string).trim() ? (raw.language as string) : language,
      size,
      grid: Array.from({ length: size }, () => Array.from({ length: size }, () => "#")),
      entries: cleanEntries,
      meta: { source: "openai" },
    };

    // --- 2) Reconstruir grilla SIEMPRE y recién ahí validar
    const rebuilt = rebuildGrid(base);

    if (!isCrossword(rebuilt)) {
      // Si aún así no pasa, devolvemos el motivo y el crudo para depurar
      return NextResponse.json(
        { error: `Formato inválido: ${explainCrosswordError(rebuilt)}`, raw: rawUnknown },
        { status: 502 }
      );
    }

    return NextResponse.json({ ...rebuilt, meta: { ...(rebuilt.meta ?? {}), source: "openai" } }, { status: 200 });
  } catch (e: unknown) {
    const d = extractOpenAIError(e);
    console.error("generate-crossword error:", d, e);
    const isQuota = d.status === 429 || d.code === "insufficient_quota" || /quota/i.test(d.message ?? "");
    if (isQuota) {
      // Fallback mínimo 9×9 solo para desarrollo sin créditos
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
