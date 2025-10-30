// lib/crosswordSchema.ts
export type Language = "es" | "en";

export type Cell = "#" | string; // "#" bloque; letra A-Z

export type Clue = {
  number: number;
  answer: string;
  row: number;
  col: number;
  direction: "across" | "down";
  clue: string;
};

export type CrosswordPayload = {
  theme: string;
  language: Language;
  size: number;           // cuadrado
  grid: Cell[][];         // size x size
  clues: Clue[];          // across + down
  title: string;
  notes?: string;
};

export function normalizeAnswer(s: string) {
  const map: Record<string, string> = {
    "á": "A", "é": "E", "í": "I", "ó": "O", "ú": "U",
    "ü": "U", "ñ": "N"
  };
  return s
    .toLowerCase()
    .replace(/[áéíóúüñ]/g, ch => map[ch] || ch)
    .replace(/[^a-z0-9]/g, "")
    .toUpperCase();
}
