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
  answer: string; // A–Z (ASCII), sin espacios, len >= 3 en fallback
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

/* -------------------- Utilidades -------------------- */
const AtoZ = /^[A-ZÑÁÉÍÓÚÜ]+$/u;
const isBlock = (c: string) => c === "#";

function normalizeAnswer(s: unknown) {
  if (typeof s !== "string") return "";
  return s
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

function deriveEntriesFromGrid(grid: string[][], minLen = 3): Entry[] {
  const n = grid.length;
  const entries: Entry[] = [];
  let num = 1;

  // Across
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!isBlock(grid[r][c]) && (c === 0 || isBlock(grid[r][c - 1]))) {
        let end = c;
        let ans = "";
        while (end < n && !isBlock(grid[r][end])) {
          ans += grid[r][end];
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
            clue: "",
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
      if (!isBlock(grid[r][c]) && (r === 0 || isBlock(grid[r - 1][c]))) {
        let end = r;
        let ans = "";
        while (end < n && !isBlock(grid[end][c])) {
          ans += grid[end][c];
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
            clue: "",
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

function validateCrossword(x: Crossword) {
  const problems: string[] = [];
  if (!x || !Array.isArray(x.grid) || !Array.isArray(x.entries)) {
    problems.push("Estructura base inválida.");
    return { ok: false, problems };
  }
  const n = x.grid.length;
  if (n < 9 || n > 13) problems.push("size fuera de rango [9..13].");

  for (const row of x.grid) {
    if (!Array.isArray(row) || row.length !== n) {
      problems.push("Grid no es NxN.");
      break;
    }
    for (const cell of row) {
      const good =
        typeof cell === "string" &&
        (isBlock(cell) || AtoZ.test(normalizeAnswer(cell)));
      if (!good) {
        problems.push("Grid contiene celdas inválidas.");
        break;
      }
    }
  }

  const seen = new Set<string>();
  let across = 0;
  let down = 0;

  for (const e of x.entries) {
    if ((e.answer ?? "").length < 2) problems.push(`Entrada #${e.number} < 2 letras.`);
    if (!AtoZ.test(e.answer ?? "")) problems.push(`Entrada #${e.number} con caracteres inválidos.`);
    if (e.direction === "across") across++;
    else if (e.direction === "down") down++;

    const sig = `${e.direction}@${e.row},${e.col}`;
    if (seen.has(sig)) problems.push(`Entrada duplicada en ${sig}.`);
    seen.add(sig);

    for (let k = 0; k < (e.answer?.length ?? 0); k++) {
      const rr = e.row + (e.direction === "down" ? k : 0);
      const cc = e.col + (e.direction === "across" ? k : 0);
      if (rr >= n || cc >= n) {
        problems.push(`Entrada #${e.number} se sale del grid.`);
        break;
      }
      const cell = x.grid[rr][cc];
      if (isBlock(cell)) {
        problems.push(`Entrada #${e.number} atraviesa bloque.`);
        break;
      }
    }
  }

  const total = across + down;
  if (total < 18 && n === 9) problems.push("Muy pocas entradas (min 18 para 9x9).");
  if (total < 24 && n === 11) problems.push("Muy pocas entradas (min 24 para 11x11).");
  if (total < 30 && n === 13) problems.push("Muy pocas entradas (min 30 para 13x13).");
  const diff = Math.abs(across - down);
  if (total > 0 && diff / total > 0.35) problems.push("Desbalance entre across/down.");

  const trivial = x.entries.filter((e) => /\b(letra|vocal|consonante)\b/i.test(e.clue));
  if (trivial.length > 4) problems.push("Demasiadas pistas triviales.");

  return { ok: problems.length === 0, problems };
}

function ensureClueQuality(e: Entry, language: "es" | "en"): Entry {
  if (language === "es") {
    if (e.answer === "MENDOZA" && /regi(o|ó)n/i.test(e.clue)) {
      return { ...e, clue: "Provincia argentina famosa por su vino." };
    }
  } else {
    if (e.answer === "MENDOZA" && /region/i.test(e.clue)) {
      return { ...e, clue: "Argentine province famous for wine." };
    }
  }
  return e;
}

/* -------------------- Prompts -------------------- */
function makeStrictPrompt(theme: string, language: "es" | "en", size: number) {
  const langLine =
    language === "es"
      ? `Escribe pistas sólidas en español rioplatense.`
      : `Write solid, natural English clues.`;

  return `
TAREA: Diseñar un crucigrama ${size}x${size} sobre el tema "${theme}".
REQUISITOS ESTRICTOS:
- Devuelve SOLO JSON (sin texto extra): theme, language, size, grid, entries, meta.
- Grid ${size}x${size} con letras A–Z (ASCII) o "#".
- Todas las entries con longitud mínima 2 (prohibido 1 letra).
- Mínimos: 18 (9x9), 24 (11x11), 30 (13x13). Balance across/down (diferencia ≤35%).
- Evita pistas triviales tipo “letra/vocal/consonante”.
- Answers en mayúsculas, sin espacios ni guiones.
- Cada entry debe calzar exacto en el grid; no atravieses "#".
- Estética similar a crucigramas del NYT.

${langLine}

FORMATO JSON:
{
  "theme": "${theme}",
  "language": "${language}",
  "size": ${size},
  "grid": string[${size}][${size}],
  "entries": [
    { "number": 1, "row": 0, "col": 0, "direction": "across", "answer": "EJEMPLO", "clue": "Pista clara y específica." }
  ],
  "meta": { "source": "openai" }
}
`;
}

function makeFreePrompt(theme: string, language: "es" | "en", size: number) {
  const lang = language === "es" ? "español rioplatense" : "English";
  return `
Generá un crucigrama ${size}x${size} sobre "${theme}".
- Devolvé SOLO JSON con (theme, language, size, grid, entries, meta).
- Evitá respuestas de 1 letra y pistas triviales. Balanceá across y down.
- Respuestas en mayúsculas sin espacios (A-Z).
Idioma de las pistas: ${lang}.
`;
}

/* -------------------- DEMO 9x9 -------------------- */
/**
 * Grid pensado para:
 * Across válidos: MATE, AND, BOCA, RIOS, PAMPA, NEUQUEN, SALTA, OBELISCO, AND, MAR, TANGO, UVA, PAT, RIO
 */
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

const esClues: Record<string, string> = {
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

const enClues: Record<string, string> = {
  MATE: "Traditional Argentine infusion.",
  AND: "Conjunction; used here only as a crossing.",
  BOCA: "Famous Buenos Aires football club.",
  RIOS: "Important waterways of the country.",
  PAMPA: "Vast Argentine plain.",
  NEUQUEN: "Patagonian province and its capital share this name.",
  SALTA: "Northwestern province known for its wines.",
  OBELISCO: "Icon on Buenos Aires’ 9 de Julio Ave.",
  MAR: "The Atlantic washes its coast.",
  TANGO: "Argentina’s emblematic music and dance.",
  UVA: "Fruit behind many Argentine wines.",
  PAT: "Colloquial abbr.; technical crossing.",
  RIO: "River.",
};

function sanitizeDemo(language: "es" | "en"): Crossword {
  // Derivar entries desde el grid y filtrar < 3; mapear pistas por idioma
  const derived = deriveEntriesFromGrid(demoBase.grid, 3).map((e) => {
    const dict = language === "en" ? enClues : esClues;
    return {
      ...e,
      clue: dict[e.answer] ?? (language === "en" ? "Thematic clue." : "Pista temática."),
    };
  });

  return {
    theme: demoBase.theme,
    language,
    size: demoBase.size,
    grid: demoBase.grid,
    entries: derived,
    meta: { source: "demo-clean" },
  };
}

/**
 * Expande el demo 9x9 a n×n centrando el grid y rellenando con bloques (#),
 * re-deriva las entries y aplica pistas en el idioma pedido.
 * Además inyecta SIEMPRE { theme, language } solicitados.
 */
function expandDemoTo(n: number, theme: string, language: "es" | "en"): Crossword {
  const d = sanitizeDemo(language);
  if (n === 9) {
    return { ...d, theme, language, size: 9 }; // respeta theme/lang pedidos
  }

  const pad = Math.floor((n - 9) / 2);
  const grid: string[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => "#")
  );

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      grid[r + pad][c + pad] = d.grid[r][c];
    }
  }

  const dict = language === "en" ? enClues : esClues;
  const baseDerived = deriveEntriesFromGrid(d.grid, 3);

  const entries = deriveEntriesFromGrid(grid, 3).map((e) => {
    // Intentamos conservar la pista si coincide con la misma palabra desplazada
    const original = baseDerived.find(
      (x) => x.answer === e.answer
    );
    const clue =
      (original && dict[original.answer]) ??
      dict[e.answer] ??
      (language === "en" ? "Thematic clue." : "Pista temática.");

    return { ...e, clue };
  });

  return {
    theme,
    language,
    size: n,
    grid,
    entries,
    meta: { source: "demo-expanded" },
  };
}

/* -------------------- Handler -------------------- */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    theme?: string;
    language?: "es" | "en";
    size?: number;
  };

  const theme = (body.theme && String(body.theme).trim()) || "Argentina";
  const language = (body.language === "en" ? "en" : "es") as "es" | "en";
  const n = Math.min(13, Math.max(9, Number(body.size) || 9));

  const apiKey = process.env.OPENAI_API_KEY;
  const client = apiKey ? new OpenAI({ apiKey }) : null;

  const tryGenerate = async (prompt: string): Promise<Crossword | null> => {
    if (!client) return null;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 3500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Sos un constructor de crucigramas estricto. Devolvés SOLO JSON válido." },
        { role: "user", content: prompt },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content ?? "";
    const parsed = safeJson<Crossword>(raw);
    if (!parsed) return null;

    parsed.language = language;
    parsed.size = Math.min(13, Math.max(9, parsed.size || n));
    parsed.theme = theme;

    parsed.entries = (parsed.entries || []).map((e) => ({
      ...e,
      answer: normalizeAnswer(e.answer),
      clue: typeof e.clue === "string" ? e.clue.trim() : "",
    }));
    parsed.entries = parsed.entries.map((e) => ensureClueQuality(e, language));

    let check = validateCrossword(parsed);
    if (check.ok) return parsed;

    // Re-derivar desde grid (y filtrar <3)
    const red = { ...parsed, entries: deriveEntriesFromGrid(parsed.grid, 3) };
    check = validateCrossword(red);
    if (check.ok) return red;

    return null;
  };

  try {
    // 1) Intento estricto primero
    const strict = await tryGenerate(makeStrictPrompt(theme, language, n));
    if (strict) return NextResponse.json({ ...strict, meta: { source: "openai" } });

    // 2) Intento libre
    const free = await tryGenerate(makeFreePrompt(theme, language, n));
    if (free) return NextResponse.json({ ...free, meta: { source: "openai" } });

    // 3) Fallback demo respetando SIEMPRE tema/idioma/tamaño solicitados
    const demo = expandDemoTo(n, theme, language);
    return NextResponse.json(demo, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "unknown";
    const demo = expandDemoTo(n, theme, language);
    return NextResponse.json(
      { ...demo, meta: { ...(demo.meta ?? {}), source: "fallback", error: message } },
      { status: 200 }
    );
  }
}
