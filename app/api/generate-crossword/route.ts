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

interface RawEntry {
number?: number;
row?: number;
col?: number;
clue?: string;
answer?: string;
direction?: Direction;
}

interface RawCrossword {
title?: string;
theme?: string;
language?: string;
size?: number;
grid?: string[][];
across?: RawEntry[];
down?: RawEntry[];
entries?: RawEntry[];
meta?: Record<string, unknown>;
}

// ---------- Utilidades básicas ----------

const AtoZ = /^[A-ZÑÁÉÍÓÚÜ]+$/u;
const ASCII_A_TO_Z = /^[A-Z]+$/;
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

// ---------- Heurísticas de tema / pistas ----------

function isGenericThematicClue(clue: string): boolean {
const lower = clue.toLowerCase().trim();

if (lower.startsWith("thematic entry related to")) return true;
if (lower.startsWith("term related to")) return true;
if (lower.startsWith("término relacionado con")) return true;
if (lower.includes("related to the theme")) return true;
if (lower.includes("relacionado con el tema")) return true;
if (lower.startsWith("palabra relacionada con")) return true;

return false;
}

function isBadClue(clue: string): boolean {
const c = clue.trim();
if (c.length < 3) return true;
if (isGenericThematicClue(c)) return true;
return false;
}

// la pista “dice” literalmente la respuesta (evitamos eso)
function clueMentionsAnswer(clue: string, answer: string): boolean {
const lowerClue = clue.toLowerCase();
const lowerAns = answer.toLowerCase();

if (lowerAns.length <= 3) return false;

return lowerClue.includes(lowerAns);
}

// bloquear algunas respuestas que son demasiado obvias o feas para cierto tema
function disallowAnswerForTheme(theme: string, answer: string): boolean {
const t = theme.toLowerCase();
const a = answer.toUpperCase();

if (t.includes("metal") && a === "METAL") return true;
if (t.includes("metal") && a === "MUSIC") return true;

if (t.includes("argentina")) {
const offThemeBanned = new Set<string>([
"NASA",
"BILLINGS",
"PEACE",
"WAR",
"SOL",
"METRO",
"BILL",
]);
if (offThemeBanned.has(a)) return true;
}

return false;
}

// ---------- Pre-filtro de respuestas raras ----------

function hasWeirdConsonantCluster(answer: string): boolean {
const upper = answer.toUpperCase();
if (/[BCDFGHJKLMNPQRSTVWXYZ]{4,}/.test(upper)) return true;
if (/(.)\1\1/.test(upper)) return true;
return false;
}

const FORBIDDEN_SUBSTRINGS = new Set<string>(["AGENDATA", "DEAFTONEZ", "REOU", "TCD"]);

const FAMOUS_ACRONYMS = new Set<string>([
"USA",
"FBI",
"CIA",
"NBA",
"NASA",
"UN",
"EU",
"UK",
"ONU",
"OTAN",
]);

const ALWAYS_ALLOW_ANSWERS = new Set<string>([
"METALLICA",
"SLAYER",
"MEGADETH",
"PANTERA",
"IRONMAIDEN",
"BLACKSABBATH",
"MASTEROFPUPPETS",
"REIGNINBLOOD",
"RUSTINPEACE",
"SLIPKNOT",
"SABBATH",
"MAIDEN",
"TANGO",
"GAUCHO",
"MATE",
"ASADO",
"OBELISCO",
"MALBEC",
"PAMPA",
"BANDONEON",
"LITORAL",
"CHORIPAN",
"OMBU",
]);

const COMMON_BIGRAMS: string[] = [
"TH",
"HE",
"IN",
"ER",
"ON",
"AN",
"RE",
"ES",
"ST",
"EN",
"AR",
"AL",
"TO",
"OR",
"TE",
"TI",
"IS",
"IT",
"AS",
"AT",
"OF",
"DE",
"LA",
"EL",
"LO",
"OS",
"RA",
"RO",
"RI",
"MA",
"ME",
"MO",
"PA",
"PE",
"PO",
"TA",
"TE",
"TO",
"CA",
"CO",
"CI",
"CH",
"QU",
"GA",
"GO",
"GE",
"GI",
];

function hasNaturalBigram(word: string): boolean {
const up = word.toUpperCase();
for (let i = 0; i < up.length - 1; i++) {
const bg = up.slice(i, i + 2);
if (COMMON_BIGRAMS.includes(bg)) return true;
}
return false;
}

function isSuspiciousAnswer(answer: string): boolean {
const up = normalizeAnswer(answer);

if (ALWAYS_ALLOW_ANSWERS.has(up)) return false;

if (up.length < 3) return true;
if (up.length > 24) return true;
if (!ASCII_A_TO_Z.test(up)) return true;

if (FAMOUS_ACRONYMS.has(up)) return false;

if (!/[AEIOU]/.test(up)) return true;

if (up.length >= 8 && hasWeirdConsonantCluster(up)) return true;

if (up.length >= 10 && !hasNaturalBigram(up)) return true;

for (const bad of FORBIDDEN_SUBSTRINGS) {
if (up.includes(bad)) return true;
}

return false;
}

// ---------- Derivar entries desde el grid (para la demo) ----------

function deriveEntriesFromGrid(grid: string[][], _theme: string, minLen = 3): Entry[] {
const n = grid.length;
const entries: Entry[] = [];
let num = 1;

const genericClue = "Placeholder clue — should be replaced by model-generated clue.";

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
    if (norm.length >= minLen && ASCII_A_TO_Z.test(norm)) {
      entries.push({
        number: num++,
        row: r,
        col: c,
        direction: "across",
        answer: norm,
        clue: genericClue,
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
    if (norm.length >= minLen && ASCII_A_TO_Z.test(norm)) {
      entries.push({
        number: num++,
        row: r,
        col: c,
        direction: "down",
        answer: norm,
        clue: genericClue,
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

// ---------- Normalización de crossword devuelto por el modelo ----------

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

function minEntriesForSize(size: number): number {
if (size <= 9) return 8;
if (size <= 11) return 12;
return 16;
}

function isAcceptableCrossword(c: Crossword): boolean {
const minEntries = minEntriesForSize(c.size);
if (c.entries.length < minEntries) return false;

const density = crosswordDensityFromGrid(c.grid);
if (density < 0.4) return false;

const across = c.entries.filter((e) => e.direction === "across").length;
const down = c.entries.length - across;

if (across === 0 || down === 0) return false;

return true;
}

function isHopelessCrossword(c: Crossword): boolean {
const total = c.entries.length;
const across = c.entries.filter((e) => e.direction === "across").length;
const down = total - across;

if (total < 4) return true;
if (across === 0 || down === 0) return true;

return false;
}

// ---------- STUBS DE TEMA (para que compile) ----------

function getThemeClueOverrides(
theme: string
): Record<string, { es: string; en: string }> {
const t = theme.toLowerCase();

if (t.includes("argentina")) {
return {
PATAGONIA: {
es: "Región al sur de Argentina, compartida con Chile.",
en: "Region in southern Argentina, shared with Chile.",
},
MATE: {
es: "Infusión tradicional argentina, servida en calabaza.",
en: "Traditional Argentine infusion, served in a gourd.",
},
PAMPA: {
es: "Gran llanura fértil de Argentina.",
en: "Vast fertile plain of Argentina.",
},
GAUCHO: {
es: "Jinete rural típico de la pampa argentina.",
en: "Traditional horseman of the Argentine pampas.",
},
ASADO: {
es: "Reunión en torno a la parrilla, símbolo gastronómico.",
en: "Barbecue gathering, emblematic Argentine meal.",
},
BARRIO: {
es: "Zona o vecindario dentro de una ciudad.",
en: "Neighborhood or district within a city.",
},
BANDONEON: {
es: "Instrumento de fuelle clave en el tango.",
en: "Accordion-like instrument central to tango music.",
},
OBELISCO: {
es: "Monumento icónico sobre la avenida 9 de Julio en Buenos Aires.",
en: "Iconic monument on Buenos Aires's 9 de Julio Avenue.",
},
MALBEC: {
es: "Cepa de vino asociada fuertemente a Argentina.",
en: "Wine grape variety strongly associated with Argentina.",
},
LITORAL: {
es: "Región noreste argentina bañada por grandes ríos.",
en: "Northeastern Argentine region along major rivers.",
},
CHORIPAN: {
es: "Sándwich de chorizo a la parrilla, típico de canchas y asados.",
en: "Grilled sausage sandwich, common at games and cookouts.",
},
OMBU: {
es: "Árbol emblemático de la pampa argentina.",
en: "Iconic tree of the Argentine pampas.",
},
TANGO: {
es: "Género musical y baile nacido en el Río de la Plata.",
en: "Music and dance genre born in the Río de la Plata region.",
},
};
}

return {};
}

// Versión simplificada: no marcamos ninguna respuesta como "claramente fuera de tema".
// Si más adelante queremos volver a endurecer este filtro, lo hacemos acá.
function isClearlyOffTheme(
_theme: string,
_clue: string,
_answer: string
): boolean {
return false;
}

function normalizeCrossword(
raw: RawCrossword,
theme: string,
language: "es" | "en",
requestedSize: number
): Crossword | null {
if (!raw) return null;

// Tamaño base
const baseSize =
raw.size ??
(Array.isArray(raw.grid) && raw.grid.length > 0
? raw.grid.length
: requestedSize || 11);

const clamped = Math.min(13, Math.max(9, baseSize));
const n = clamped % 2 === 0 ? clamped - 1 : clamped;

// Unificamos TODAS las entries con dirección
type RawWithDir = RawEntry & { direction: Direction };

const collected: RawWithDir[] = [];

const across = Array.isArray(raw.across) ? raw.across : [];
const down = Array.isArray(raw.down) ? raw.down : [];
const extra = Array.isArray(raw.entries) ? raw.entries : [];

for (const e of across) {
collected.push({ ...e, direction: "across" });
}
for (const e of down) {
collected.push({ ...e, direction: "down" });
}
for (const e of extra) {
if (e.direction === "across" || e.direction === "down") {
collected.push(e as RawWithDir);
}
}

if (!collected.length) return null;

const themeClues = getThemeClueOverrides(theme);

// Empezamos de una grilla vacía NxN con todo "#"
const grid: string[][] = Array.from({ length: n }, () =>
Array.from({ length: n }, () => "#")
);

const entries: Entry[] = [];
const usedStart = new Set<string>();
let num = 1;

const inBounds = (row: number, col: number) =>
row >= 0 && col >= 0 && row < n && col < n;

for (const e of collected) {
const dir = e.direction;
if (dir !== "across" && dir !== "down") continue;

const row = typeof e.row === "number" ? e.row : 0;
const col = typeof e.col === "number" ? e.col : 0;
if (!inBounds(row, col)) continue;

const rawAns = e.answer?.toString() ?? "";
const answer = normalizeAnswer(rawAns);
if (!answer || answer.length < 3) continue; // evitamos 1–2 letras
if (!AtoZ.test(answer)) continue;
if (isSuspiciousAnswer(answer)) continue;
if (disallowAnswerForTheme(theme, answer)) continue;

const len = answer.length;

// Check de límites
if (dir === "across" && col + len > n) continue;
if (dir === "down" && row + len > n) continue;

// Check de conflictos con lo que ya escribimos en la grilla
let conflict = false;
for (let i = 0; i < len; i++) {
  const r = dir === "across" ? row : row + i;
  const c = dir === "across" ? col + i : col;
  const existing = grid[r][c];
  const ch = answer[i];
  if (existing !== "#" && existing !== ch) {
    conflict = true;
    break;
  }
}
if (conflict) continue;

// Pista
const rawClue = (e.clue ?? "").toString().trim();
let finalClue = rawClue;

// Si la pista es muy meta/vacía o menciona la respuesta, intentamos override
if (
  !finalClue ||
  isBadClue(finalClue) ||
  clueMentionsAnswer(finalClue, answer) ||
  isClearlyOffTheme(theme, finalClue, answer)
) {
  const override = themeClues[answer];
  if (override) {
    finalClue = language === "es" ? override.es : override.en;
  } else if (!finalClue) {
    finalClue =
      language === "es"
        ? "Pista pendiente de revisión."
        : "Clue to be edited.";
  }
}

const startKey = `${row}:${col}:${dir}`;
if (usedStart.has(startKey)) continue;

// Escribimos letras en la grilla
for (let i = 0; i < len; i++) {
  const r = dir === "across" ? row : row + i;
  const c = dir === "across" ? col + i : col;
  grid[r][c] = answer[i];
}

entries.push({
  number: num++,
  row,
  col,
  direction: dir,
  answer,
  clue: finalClue,
});
usedStart.add(startKey);


}

if (!entries.length) return null;

// Renumeramos 1..N por prolijidad
const finalEntries = entries.map((e, idx) => ({
...e,
number: idx + 1,
}));

const title = typeof raw.title === "string" ? raw.title : undefined;

return {
theme,
language,
size: n,
grid,
entries: finalEntries,
meta: {
source: "openai-clean",
originalGrid: raw.grid,
...(title ? { title } : {}),
...(raw.meta ?? {}),
lastRaw: raw,
},
};
}

// ---------- DEMO ----------

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
const derived = deriveEntriesFromGrid(d.grid, d.theme, 3);
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

const entries: Entry[] = d.entries.map((e) => ({
...e,
row: e.row + pad,
col: e.col + pad,
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

// ---------- STRICT PROMPT V3 (simplificado pero estricto) ----------

const STRICT_PROMPT_V3 = `
You are a professional American-style crossword constructor.

Your task:
Given a THEME, LANGUAGE and GRID SIZE, build ONE small but high-quality themed crossword
and return ONLY a single JSON object with this exact schema:

{
"title": string,
"theme": string,
"language": string,
"size": number,
"grid": string[][],
"across": { "number": number, "row": number, "col": number, "clue": string, "answer": string }[],
"down": { "number": number, "row": number, "col": number, "clue": string, "answer": string }[]
}

Hard structural rules (NON-NEGOTIABLE):

size is exactly the given SIZE (e.g., 9 means 9x9, 13 means 13x13).

grid is a square SIZE x SIZE matrix of single-character strings:

"#" for black squares

uppercase A–Z letters for filled cells

Every non-# cell belongs to exactly ONE across entry and ONE down entry.

No 2-letter entries. Every answer length >= 3.

No fully blocked internal row or column (you may fully block outer border edge segments, but not an entire internal row or column).

At least the following total entries (across + down combined):

SIZE 9: at least 10 entries

SIZE 13: at least 18 entries

At least 40% of entries across and at least 40% of entries down.

Target density: at least 55% of cells must be letters (not "#").

Theme handling:

THEME is a loose topic, not a word list.

25–40% of entries must be clearly thematic and factual.

Among thematic entries, strongly prefer specific, real-world items:

people, bands, artists, characters,

albums, songs, books, movies, works,

places, events, subgenres, teams, etc.

Generic words that could fit almost any topic are allowed but must NOT be the majority of thematic entries.

Do NOT output the generic theme word itself as an answer.

Factuality and bans:

Use ONLY real, widely-attested words, names, places and terms.

NEVER invent bands, albums, songs, brands, or fake acronyms.

NEVER output nonsense strings like "DEAFTONEZ", "AGENDATA", "TAAQALDG" or similar.

Avoid unusual all-consonant clusters or triple repeated letters.

Acronyms are only allowed if they are clearly famous (USA, FBI, NBA, NASA, etc.).

Clue quality:

Every clue must be a natural-language definition or description.

Do NOT use meta clues like "Thematic entry related to metal music." or "Word about the topic."

Do NOT repeat the answer inside the clue text.

Clues must be specific and factual, not generic placeholders.

The clue language must match the requested LANGUAGE.

Language:

All answers and clues must be in the specified LANGUAGE.

If LANGUAGE = "es", avoid English answers unless they are globally used loanwords.

If LANGUAGE = "en", use everyday American English.

Self-check BEFORE outputting JSON:

Verify that:

At least 10 total entries (for size 9) and at least 18 entries (for size 13).

At least 40% across and 40% down.

25–40% of entries are clearly thematic.

No invented or nonsense strings.

No generic, meta, or placeholder clues.

Return ONLY the final JSON object, no comments, no explanations.
`;

// ---------- Theme anchors ----------

type LocalizedClue = { en: string; es: string };
type LocalizedClueMap = Record<string, LocalizedClue>; // (reservado para futuro)

const THEME_ANCHORS: Record<string, string[]> = {
"metal music": [
"THRASH",
"DOOM",
"BLACKMETAL",
"DEATHMETAL",
"METALCORE",
"MOSH",
"MOSHPIT",
"HEADBANG",
"RIFF",
"DOUBLEBASS",
"METALLICA",
"SLAYER",
"MEGADETH",
"PANTERA",
"IRONMAIDEN",
"BLACKSABBATH",
"MASTEROFPUPPETS",
"REIGNINBLOOD",
"RUSTINPEACE",
"GIG",
"STAGE",
"TOUR",
"BASS",
"DRUMS",
"TEMPO",
"LOUD",
"CROWD",
"ALBUM",
],

argentina: [
"TANGO",
"MATE",
"PAMPA",
"GAUCHO",
"ASADO",
"BARRIO",
"BANDONEON",
"OBELISCO",
"MALBEC",
"PATAGONIA",
"LITORAL",
"CHORIPAN",
"OMBU",
],
};

function getThemeAnchors(theme: string): string[] {
const key = theme.toLowerCase();
if (THEME_ANCHORS[key]) return THEME_ANCHORS[key];

if (key.includes("metal") && key.includes("music")) {
return THEME_ANCHORS["metal music"];
}
if (key.includes("argentina")) {
return THEME_ANCHORS["argentina"];
}

return [];
}

// ---------- Prompts ----------

function makePrompt(theme: string, language: "es" | "en", size: number) {
const languageLabel = language === "es" ? "Spanish" : "English";
const anchors = getThemeAnchors(theme);
const anchorsText = anchors.length ? anchors.join(", ") : "(none specified)";

return (
STRICT_PROMPT_V3 +
`

THEME: ${theme}
LANGUAGE: ${languageLabel}
SIZE: ${size}

Pre-approved thematic anchor words you MAY use if they fit well in the grid:
${anchorsText}
`
);
}

// ---------- Handler ----------

export async function POST(req: NextRequest) {
const body = (await req.json().catch(() => ({}))) as {
theme?: string;
language?: "es" | "en";
size?: number;
};

const theme = body.theme || "Argentina";
const language = body.language === "en" ? "en" : "es";

const requestedSize = typeof body.size === "number" ? body.size : 9;
const clamped = Math.min(13, Math.max(9, requestedSize));
const n = clamped % 2 === 0 ? clamped - 1 : clamped;

const apiKey = process.env.OPENAI_API_KEY;
const client = apiKey ? new OpenAI({ apiKey }) : null;

// Sin API key -> demo
if (!client) {
const demo = expandDemoTo(n);
return NextResponse.json(demo, { status: 200 });
}

const MAX_ATTEMPTS = 6;
let best: Crossword | null = null;
let lastRaw: RawCrossword | null = null;

try {
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
const completion = await client.chat.completions.create({
model: "gpt-4o",
temperature: attempt <= 3 ? 0.3 : 0.6,
max_tokens: 3500,
response_format: { type: "json_object" },
messages: [
{
role: "system",
content:
"Sos un constructor profesional de crucigramas. Devolvés SOLO JSON válido, respetando estrictamente las reglas.",
},
{ role: "user", content: makePrompt(theme, language, n) },
],
});

  const rawContent = completion.choices?.[0]?.message?.content ?? "";
  const parsed = safeJson<RawCrossword>(rawContent);
  if (!parsed) continue;
  lastRaw = parsed;

  const normalized = normalizeCrossword(parsed, theme, language, n);
  if (!normalized) continue;

  if (isAcceptableCrossword(normalized)) {
    return NextResponse.json(
      {
        ...normalized,
        meta: {
          ...(normalized.meta ?? {}),
          source: "openai-strong",
          lastRaw,
        },
      },
      { status: 200 }
    );
  }

  if (
    !best ||
    normalized.entries.length > best.entries.length ||
    (normalized.entries.length === best.entries.length &&
      crosswordDensityFromGrid(normalized.grid) >
        crosswordDensityFromGrid(best.grid))
  ) {
    best = normalized;
  }
}

if (best) {
  const hopeless = isHopelessCrossword(best);
  return NextResponse.json(
    {
      ...best,
      meta: {
        ...(best.meta ?? {}),
        source: hopeless ? "openai-hopeless" : "openai-weak",
        lastRaw,
      },
    },
    { status: 200 }
  );
}

const demo = expandDemoTo(n);
return NextResponse.json(
  {
    ...demo,
    meta: {
      ...(demo.meta ?? {}),
      source: "fallback-retries",
      lastRaw,
    },
  },
  { status: 200 }
);


} catch (err: unknown) {
const demo = expandDemoTo(n);
return NextResponse.json(
{
...demo,
meta: {
...(demo.meta ?? {}),
source: "fallback-error",
error:
err instanceof Error
? err.message
: "unknown error in generate-crossword",
lastRaw,
},
},
{ status: 200 }
);
}
}