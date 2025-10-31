// app/api/generate-crossword/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ───────────────────────────────────────────────────────────────────────────────
// Tipos
type Language = "es" | "en";

type Body = {
  theme?: string;
  language?: Language;
};

type ClueEntry = {
  number: number;
  row: number; // 0-based
  col: number; // 0-based
  answer: string;
  clue: string;
};

type CrosswordPayload = {
  title: string;
  language: Language;
  notes?: string;
  size?: number;
  grid: string[][];
  clues: {
    across: ClueEntry[];
    down: ClueEntry[];
  };
  meta?: Record<string, unknown>;
};

// ───────────────────────────────────────────────────────────────────────────────
// Utilidades mínimas de validación (sin dependencias externas)
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isClueEntry(e: unknown): e is ClueEntry {
  if (!isRecord(e)) return false;
  return (
    typeof e.number === "number" &&
    typeof e.row === "number" &&
    typeof e.col === "number" &&
    typeof e.answer === "string" &&
    typeof e.clue === "string"
  );
}

function validatePayload(raw: unknown):
  | { success: true; data: CrosswordPayload }
  | { success: false; error: string } {
  if (!isRecord(raw)) return { success: false, error: "Payload no es objeto" };

  const { title, language, grid, clues } = raw;

  if (typeof title !== "string" || !title.trim()) {
    return { success: false, error: "title inválido" };
  }
  if (language !== "es" && language !== "en") {
    return { success: false, error: "language inválido" };
  }

  if (!Array.isArray(grid) || grid.length === 0) {
    return { success: false, error: "grid inválido" };
  }
  for (const row of grid) {
    if (!Array.isArray(row)) return { success: false, error: "grid no es 2D" };
    for (const cell of row) {
      if (typeof cell !== "string") {
        return { success: false, error: "grid contiene celdas no string" };
      }
    }
  }

  if (!isRecord(clues)) return { success: false, error: "clues inválido" };
  const acrossUnknown = clues["across"];
  const downUnknown = clues["down"];

  if (!Array.isArray(acrossUnknown) || !Array.isArray(downUnknown)) {
    return { success: false, error: "clues.across/down inválidos" };
  }
  if (!acrossUnknown.every(isClueEntry)) {
    return { success: false, error: "across inválido" };
  }
  if (!downUnknown.every(isClueEntry)) {
    return { success: false, error: "down inválido" };
  }

  const across = acrossUnknown as ClueEntry[];
  const down = downUnknown as ClueEntry[];

  return {
    success: true,
    data: {
      title,
      language,
      grid: grid as string[][],
      clues: { across, down },
      notes: typeof raw["notes"] === "string" ? (raw["notes"] as string) : undefined,
      size: typeof raw["size"] === "number" ? (raw["size"] as number) : undefined,
      meta: isRecord(raw["meta"]) ? (raw["meta"] as Record<string, unknown>) : undefined,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// GET de diagnóstico
export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      where: "/api/generate-crossword",
      hint: "Use POST with { theme, language }",
    },
    { status: 200 }
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// POST con integración OpenAI
export async function POST(req: Request) {
  // 1) Validar body
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const theme = (body.theme ?? "").trim();
  const language = body.language;

  if (!theme) {
    return NextResponse.json({ error: "Field 'theme' is required" }, { status: 400 });
  }
  if (language !== "es" && language !== "en") {
    return NextResponse.json(
      { error: "Field 'language' must be 'es' or 'en'" },
      { status: 400 }
    );
  }

  // 2) Chequear API key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY no configurada en el proyecto." },
      { status: 500 }
    );
  }

  // 3) Modelo (configurable por env)
  const MODEL = process.env.CROSSWORD_MODEL || "gpt-4o-mini";

  // 4) Prompt
  const system =
    language === "es"
      ? "Sos un generador de crucigramas temáticos. Devolvé SIEMPRE JSON válido, sin comentarios, sin texto adicional."
      : "You are a crossword generator. ALWAYS return valid JSON only, no comments, no extra text.";

  const sizeHint = 7;

  const userPrompt =
    language === "es"
      ? `
Generá un crucigrama TEMÁTICO sobre: "${theme}".
Requisitos:
- Idioma: "es".
- Tamaño aproximado: ${sizeHint}x${sizeHint}.
- Representá la grilla como array 2D de strings; usa "#" para bloques.
- Pistas coherentes y variadas. Respuestas en MAYÚSCULAS sin tildes.
- Balance entre across y down.
- Devolvé SOLO un JSON con esta forma:

{
  "title": "string",
  "language": "es",
  "notes": "string (opcional)",
  "size": number,
  "grid": [["A","#","B",...], [...]],
  "clues": {
    "across": [{"number":1,"row":0,"col":0,"answer":"...","clue":"..."}],
    "down":   [{"number":1,"row":0,"col":0,"answer":"...","clue":"..."}]
  },
  "meta": { "source": "ai" }
}
`
      : `
Generate a THEMED crossword about: "${theme}".
Requirements:
- Language: "en".
- Approximate size: ${sizeHint}x${sizeHint}.
- Grid as 2D string array; use "#" for blocks.
- Varied, non-trivial clues; answers in UPPERCASE.
- Balance across and down.
- Return ONLY a JSON with this exact shape:

{
  "title": "string",
  "language": "en",
  "notes": "string (optional)",
  "size": number,
  "grid": [["A","#","B",...], [...]],
  "clues": {
    "across": [{"number":1,"row":0,"col":0,"answer":"...","clue":"..."}],
    "down":   [{"number":1,"row":0,"col":0,"answer":"...","clue":"..."}]
  },
  "meta": { "source": "ai" }
}
`;

  // 5) Llamada a OpenAI (SDK oficial) – import dinámico
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey });

  let aiText: string | null = null;
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt.trim() },
      ],
    });
    aiText = completion.choices[0]?.message?.content ?? null;
  } catch (_err) {
    return NextResponse.json(
      { error: "Fallo al invocar el modelo de IA." },
      { status: 502 }
    );
  }

  if (!aiText) {
    return NextResponse.json(
      { error: "La IA no devolvió contenido." },
      { status: 502 }
    );
  }

  // 6) Parseo y validación
  let parsed: unknown;
  try {
    parsed = JSON.parse(aiText);
  } catch (_err) {
    return NextResponse.json(
      { error: "La IA devolvió un JSON inválido." },
      { status: 502 }
    );
  }

  const result = validatePayload(parsed);
  if (!result.success) {
    return NextResponse.json(
      { error: `Respuesta inválida del modelo: ${result.error}` },
      { status: 502 }
    );
  }

  // 7) Normalización mínima
  const payload = result.data;
  payload.language = language;
  payload.meta = { ...(payload.meta ?? {}), model: MODEL, source: "ai" };

  return NextResponse.json(payload, { status: 200 });
}
