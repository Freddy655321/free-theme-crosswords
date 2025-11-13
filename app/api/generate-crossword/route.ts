// app/api/generate-crossword/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

type Direction = "across" | "down";

interface Entry {
  number: number;
  row: number; // 0-index
  col: number; // 0-index
  direction: Direction;
  answer: string; // A–Z (ASCII), sin espacios
  clue: string;
}

interface Crossword {
  theme: string;
  language: "es" | "en";
  size: number; // NxN
  grid: string[][];
  entries: Entry[];
  meta?: Record<string, unknown>;
}

// ---------- Utilidades básicas ----------

const AtoZ = /^[A-ZÑÁÉÍÓÚÜ]+$/u;
const isBlock = (c: string) => c === "#";

function normalizeAnswer(s: string | undefined | null): string {
  if (!s) return "";
  return s
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s|-/g, "");
}

function safeJson<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Deriva entries a partir del grid, útil como último recurso cuando
 * el modelo no manda una lista decente de entradas.
 */
function deriveEntriesFromGrid(grid: string[][], minLen = 3): Entry[] {
  const n = grid.length;
  const entries: Entry[] = [];
  let num = 1;

  // Across
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
        if (norm.length >= minLen && AtoZ.test(norm)) {
          entries.push({
            number: num++,
            row: r,
            col: c,
            direction: "across",
            answer: norm,
            clue: "Thematic clue.",
          });
        }
        c = end + 1;
        continue;
      }
      c++;
    }
  }

  // Down
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
        if (norm.length >= minLen && AtoZ.test(norm)) {
          entries.push({
            number: num++,
            row: r,
            col: c,
            direction: "down",
            answer: norm,
            clue: "Thematic clue.",
          });
        }
        r = end + 1;
        continue;
      }
      r++;
    }
  }

  return entries;
}

/**
 * Limpia y normaliza un crossword devuelto por el modelo.
 * Regla de oro ahora: solo rechazamos si la estructura es *muy* inválida.
 */
function normalizeCrossword(
  raw: Partial<Crossword>,
  theme: string,
  language: "es" | "en",
  requestedSize: number
): Crossword | null {
  if (!raw || !Array.isArray(raw.grid) || raw.grid.length === 0) {
    return null;
  }

  // Forzar tamaño cuadrado NxN
  const n = Math.min(13, Math.max(9, requestedSize || raw.size || raw.grid.length));
  const grid: string[][] = Array.from({ length: n }, (_, r) => {
    const row = Array.isArray(raw.grid?.[r]) ? (raw.grid as unknown as string[][])[r] : [];
    const padded = Array.from({ length: n }, (_, c) => {
      const cell = row[c];
      if (typeof cell === "string" && cell.length > 0) {
        return cell.length === 1 ? cell.toUpperCase() : cell[0].toUpperCase();
      }
      return "#";
    });
    return padded;
  });

  // Normalizar entries o derivarlas
  let entries: Entry[] = Array.isArray(raw.entries)
    ? (raw.entries as Entry[])
    : [];

  entries = entries
    .map((e, idx) => {
      const dir: Direction = e.direction === "down" ? "down" : "across";
      const ans = normalizeAnswer(e.answer);
      const row = Number(e.row) || 0;
      const col = Number(e.col) || 0;

      if (
        row < 0 ||
        col < 0 ||
        row >= n ||
        col >= n ||
        ans.length < 2
      ) {
        return null;
      }

      return {
        number: e.number ?? idx + 1,
        row,
        col,
        direction: dir,
        answer: ans,
        clue: (e.clue ?? "").toString().trim() || "Thematic clue.",
      };
    })
    .filter((e): e is Entry => !!e);

  // Si después de limpiar quedan muy pocas, derivamos desde el grid
  if (entries.length < 10) {
    entries = deriveEntriesFromGrid(grid, 3);
  }

  if (entries.length === 0) {
    // Esto sí es fallo duro -> forzamos fallback
    return null;
  }

  return {
    theme,
    language,
    size: n,
    grid,
    entries,
    meta: {
      source: "openai-clean",
      ...(raw.meta ?? {}),
    },
  };
}

// ---------- DEMO curado (9x9) ----------

const demoBase: Crossword = {
  theme: "Argentina",
  language: "es",
  size: 9,
  grid: [
    ["#", "M", "A", "T", "E", "#", "A", "N", "D"],
    ["B", "O", "C", "A", "#", "R", "I", "O", "S"],
    ["A", "#", "P", "A", "M", "P", "A", "#", "S"],
    ["N", "E", "U", "Q", "U", "E", "N", "#", "#"],
    ["D", "#", "S", "A", "L", "T", "A", "#", "T"],
    ["O", "B", "E", "L", "I", "S", "C", "O", "#"],
    ["#", "A", "N", "D", "#", "#", "M", "A", "R"],
    ["T", "A", "N", "G", "O", "#", "U", "V", "A"],
    ["P", "A", "T", "#", "R", "I", "O", "#", "#"],
  ],
  entries: [],
  meta: { source: "demo" },
};

function sanitizeDemo(d: Crossword): Crossword {
  const derived = deriveEntriesFromGrid(d.grid, 3);
  const clueDict: Record<string, string> = {
    MATE: "Infusión tradicional argentina.",
    AND: "Conjunción; acá se usa como cruce, sin pista.",
    BOCA: "Club xeneize de Buenos Aires.",
    RIOS: "Cuerpos de agua importantes del país.",
    PAMPA: "Gran llanura argentina.",
    NEUQUEN: "Provincia patagónica y su capital homónimas.",
    SALTA: "Provincia del noroeste, famosa por sus vinos.",
    OBELISCO: "Icono porteño sobre la 9 de Julio.",
    MAR: "El Atlántico baña su costa.",
    TANGO: "Baile y música emblema nacional.",
    UVA: "Fruto base de muchos vinos argentinos.",
    PAT: "Abreviatura coloquial; cruce técnico.",
    RIO: "Curso de agua.",
  };

  const entries = derived.map((e) => ({
    ...e,
    clue: clueDict[e.answer] ?? "Pista temática.",
  }));

  return {
    theme: "Argentina",
    language: "es",
    size: d.size,
    grid: d.grid,
    entries,
    meta: { source: "demo-clean" },
  };
}

/**
 * Expande el demo 9x9 a n×n centrando el grid y rellenando con bloques (#).
 */
function expandDemoTo(n: number): Crossword {
  const d = sanitizeDemo(demoBase);
  if (n === 9) return d;

  const pad = Math.floor((n - 9) / 2);
  const grid: string[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => "#")
  );

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      grid[r + pad][c + pad] = d.grid[r][c];
    }
  }

  const entries = deriveEntriesFromGrid(grid, 3).map((e) => ({
    ...e,
    clue:
      d.entries.find(
        (x) =>
          x.answer === e.answer // mantenemos las pistas originales cuando coinciden
      )?.clue ?? "Pista temática.",
  }));

  return {
    theme: d.theme,
    language: d.language,
    size: n,
    grid,
    entries,
    meta: { source: "demo-expanded" },
  };
}

// ---------- Prompts ----------

function makePrompt(theme: string, language: "es" | "en", size: number) {
  const langLine =
    language === "es"
      ? `Escribe pistas claras en español rioplatense.`
      : `Write clear clues in natural English.`;

  return `
You are an expert crossword constructor.

TASK: Create a ${size}x${size} crossword about the theme "${theme}".

HARD RULES:
- Reply with JSON ONLY, no prose.
- JSON keys: theme, language, size, grid, entries, meta.
- "grid" must be a ${size}x${size} matrix of strings: A–Z or "#".
- Answers must be UPPERCASE, no spaces or hyphens.
- Avoid 1-letter answers when possible.

${langLine}

JSON FORMAT EXAMPLE:
{
  "theme": "${theme}",
  "language": "${language}",
  "size": ${size},
  "grid": [["#", "A", ...], ...],
  "entries": [
    { "number": 1, "row": 0, "col": 0, "direction": "across", "answer": "EXAMPLE", "clue": "Clear, specific clue." }
  ],
  "meta": { "source": "openai" }
}
`;
}

// ---------- Handler ----------

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    theme?: string;
    language?: "es" | "en";
    size?: number;
  };

  const theme = body.theme || "Argentina";
  const language = body.language || "es";
  const n = Math.min(13, Math.max(9, Number(body.size) || 9));

  const apiKey = process.env.OPENAI_API_KEY;
  const client = apiKey ? new OpenAI({ apiKey }) : null;

  // Si no hay clave, vamos directo al demo
  if (!client) {
    const demo = expandDemoTo(n);
    return NextResponse.json(demo, { status: 200 });
  }

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 3500,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Sos un constructor de crucigramas. Devolvés SOLO JSON válido.",
        },
        { role: "user", content: makePrompt(theme, language, n) },
      ],
    });

    const rawContent = completion.choices?.[0]?.message?.content ?? "";
    const parsed = safeJson<Partial<Crossword>>(rawContent);

    const normalized = normalizeCrossword(parsed || {}, theme, language, n);

    if (normalized) {
      return NextResponse.json(normalized, { status: 200 });
    }

    // Si llegamos acá, el JSON era demasiado roto ⇒ demo
    const demo = expandDemoTo(n);
    return NextResponse.json(demo, {
      status: 200,
    });
  } catch (err: unknown) {
    const demo = expandDemoTo(n);
    return NextResponse.json(
      {
        ...demo,
        meta: {
          ...(demo.meta ?? {}),
          source: "fallback",
          error:
            err instanceof Error ? err.message : "unknown error in generate-crossword",
        },
      },
      { status: 200 }
    );
  }
}
