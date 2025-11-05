// /app/api/generate-crossword/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { Crossword, isCrossword, explainCrosswordError } from "../../../lib/crossword";

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
function extractOpenAIError(e: unknown): { status?: number; code?: string; type?: string; message: string } {
  const base = { message: "Error interno" as string, status: undefined as number | undefined, code: undefined as string | undefined, type: undefined as string | undefined };
  if (e instanceof Error) base.message = e.message;
  const resp = (e as Record<string, unknown>)?.["response"];
  if (resp && typeof resp === "object") {
    const data = (resp as Record<string, unknown>)?.["data"];
    const status = (resp as Record<string, unknown>)?.["status"];
    if (typeof status === "number") base.status = status;
    if (data && typeof data === "object") {
      const err = (data as Record<string, unknown>)?.["error"];
      if (err && typeof err === "object") {
        const code = (err as Record<string, unknown>)?.["code"];
        const type = (err as Record<string, unknown>)?.["type"];
        const msg = (err as Record<string, unknown>)?.["message"];
        if (typeof code === "string") base.code = code;
        if (typeof type === "string") base.type = type;
        if (typeof msg === "string") base.message = msg;
      }
    }
  }
  return base;
}

function maskKey(k: string | undefined) {
  if (!k) return "undefined";
  const s = k.trim(); return `${s.slice(0,6)}...${s.slice(-4)} (len=${s.length})`;
}

/* ---------- Reconstrucción de grilla desde entries ---------- */
function rebuildGrid(candidate: Crossword): Crossword {
  const size = Math.max(9, Math.min(13, candidate.size || candidate.grid?.length || 9));
  // Grilla vacía con bloques
  const grid: string[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => "#"));

  const entries = [...candidate.entries].sort((a, b) => a.number - b.number);
  for (const e of entries) {
    const word = e.answer.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase(); // letras planas
    if (e.direction === "across") {
      if (e.col + word.length > size) continue; // fuera de rango: ignoramos esa entrada
      for (let i = 0; i < word.length; i++) {
        const r = e.row, c = e.col + i;
        const ch = word[i];
        if (grid[r][c] === "#" || grid[r][c] === ch || grid[r][c] === "") grid[r][c] = ch;
        else if (grid[r][c] !== ch) {
          // conflicto: anulamos esa letra para no romper el cruce
          grid[r][c] = ch; // preferimos la última (simplifica)
        }
      }
    } else {
      if (e.row + word.length > size) continue;
      for (let i = 0; i < word.length; i++) {
        const r = e.row + i, c = e.col;
        const ch = word[i];
        if (grid[r][c] === "#" || grid[r][c] === ch || grid[r][c] === "") grid[r][c] = ch;
        else if (grid[r][c] !== ch) {
          grid[r][c] = ch;
        }
      }
    }
  }

  // Rellena vacíos con bloques si quedó alguno
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c] === "") grid[r][c] = "#";
    }
  }

  return { ...candidate, size, grid };
}

export async function POST(req: NextRequest) {
  try {
    const body: unknown = await req.json();
    const theme = (body as { theme?: unknown }).theme;
    const language = (body as { language?: unknown }).language;

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

    let candidate: unknown;
    try { candidate = JSON.parse(content); }
    catch { return NextResponse.json({ error: "JSON inválido." }, { status: 502 }); }

    if (!isCrossword(candidate)) {
      return NextResponse.json({ error: `Formato inválido: ${explainCrosswordError(candidate)}`, raw: candidate }, { status: 502 });
    }

    const rebuilt = rebuildGrid(candidate as Crossword);
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
        grid: [
          ["#","#","#","#","#","#","#","#","#"],
          ["#","#","#","#","#","#","#","#","#"],
          ["#","#","#","#","#","#","#","#","#"],
          ["#","#","#","#","#","#","#","#","#"],
          ["#","#","#","#","#","#","#","#","#"],
          ["#","#","#","#","#","#","#","#","#"],
          ["#","#","#","#","#","#","#","#","#"],
          ["#","#","#","#","#","#","#","#","#"],
          ["#","#","#","#","#","#","#","#","#"],
        ],
        entries: [
          { number:1,row:0,col:0,direction:"across",answer:"ARGENTINA",clue:"1. País de América del Sur." },
          { number:2,row:0,col:0,direction:"down",answer:"ANDES",clue:"2. Cordillera occidental." },
        ],
        meta:{ source:"demo-429" }
      };
      const rebuilt = rebuildGrid(demo);
      return NextResponse.json(rebuilt, { status: 200 });
    }
    const http = d.status && d.status >= 400 && d.status < 600 ? d.status : 502;
    return NextResponse.json({ error: d.message || "Error interno." }, { status: http });
  }
}
