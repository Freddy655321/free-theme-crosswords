// /lib/crossword.ts
export type Cell = string;           // "A"… o "#"
export type Grid = Cell[][];

export type Direction = "across" | "down";

export interface Entry {
  number: number;   // 1,2,3...
  row: number;      // 0-based
  col: number;      // 0-based
  direction: Direction;
  answer: string;   // solo letras (sin espacios)
  clue: string;     // "1. …"
}

export interface Crossword {
  title: string;
  language: string; // "es" | "en"...
  size: number;     // ancho = alto
  grid: Grid;       // NxN, "#" = bloque
  entries: Entry[]; // coherentes con grid
  // Compat: por si algún payload viejo trae clues
  clues?: { across: string[]; down: string[] };
  meta?: Record<string, unknown>;
}

/* Helpers de type-guard */
function isString(x: unknown): x is string { return typeof x === "string"; }
function isNumber(x: unknown): x is number { return typeof x === "number" && Number.isFinite(x); }
function isRecord(x: unknown): x is Record<string, unknown> { return typeof x === "object" && x !== null && !Array.isArray(x); }

function isCell(x: unknown): x is Cell {
  if (!isString(x)) return false;
  if (x === "#") return true;
  // una letra (permitimos acentos y ñ)
  return x.length === 1 && /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]$/u.test(x);
}

function isRow(x: unknown, size: number): x is Cell[] {
  return Array.isArray(x) && x.length === size && x.every(isCell);
}

function isGrid(x: unknown, size: number): x is Grid {
  return Array.isArray(x) && x.length === size && x.every((row) => isRow(row, size));
}

function isDirection(x: unknown): x is Direction {
  return x === "across" || x === "down";
}

function isEntry(x: unknown, size: number): x is Entry {
  if (!isRecord(x)) return false;
  const n = x as Record<string, unknown>;
  return isNumber(n.number)
    && isNumber(n.row) && n.row >= 0 && n.row < size
    && isNumber(n.col) && n.col >= 0 && n.col < size
    && isDirection(n.direction)
    && isString(n.answer) && /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+$/u.test(n.answer)
    && isString(n.clue) && n.clue.trim().length > 0;
}

export function isCrossword(x: unknown): x is Crossword {
  if (!isRecord(x)) return false;

  const obj = x as Record<string, unknown>;
  if (!isString(obj.title) || obj.title.trim() === "") return false;
  if (!isString(obj.language) || obj.language.trim() === "") return false;
  if (!isNumber(obj.size) || obj.size < 9 || obj.size > 13) return false;

  const size = obj.size as number;
  if (!isGrid(obj.grid, size)) return false;

  if (!Array.isArray(obj.entries) || obj.entries.length < 10) return false;
  // *** FIX de tipado: casteamos a unknown[] y usamos la variable size (number) ***
  const entriesUnknown = obj.entries as unknown[];
  if (!entriesUnknown.every((e) => isEntry(e, size))) return false;

  // Comprobación rápida de coherencia con la grilla
  const grid = obj.grid as Grid;
  for (const raw of entriesUnknown) {
    const e = raw as Entry;
    const len = e.answer.length;
    if (e.direction === "across") {
      if (e.col + len > size) return false;
      for (let i = 0; i < len; i++) {
        const cell = grid[e.row][e.col + i];
        if (cell === "#") return false;
      }
    } else {
      if (e.row + len > size) return false;
      for (let i = 0; i < len; i++) {
        const cell = grid[e.row + i][e.col];
        if (cell === "#") return false;
      }
    }
  }
  return true;
}

export function explainCrosswordError(obj: unknown): string {
  if (!isRecord(obj)) return "El resultado no es un objeto JSON.";
  if (!("title" in obj) || !isString(obj.title) || obj.title.trim() === "") return 'Falta "title" válido.';
  if (!("language" in obj) || !isString(obj.language) || obj.language.trim() === "") return 'Falta "language" válido.';
  if (!("size" in obj) || !isNumber(obj.size) || obj.size < 9 || obj.size > 13) return '"size" debe ser un número entre 9 y 13.';
  const size = obj.size as number;
  if (!("grid" in obj) || !isGrid((obj as { grid: unknown }).grid, size)) return '"grid" debe ser NxN con "#" en bloques.';
  if (!("entries" in obj) || !Array.isArray(obj.entries) || obj.entries.length < 10) return '"entries" debe ser un array con 10+ elementos.';
  const entriesUnknown = obj.entries as unknown[];
  for (const e of entriesUnknown) {
    if (!isEntry(e, size)) return "Una o más entradas de 'entries' no son válidas.";
  }
  // chequeo liviano de cruces ya cubierto en isCrossword
  return "Inconsistencias de longitud o bloques en alguna entrada.";
}
