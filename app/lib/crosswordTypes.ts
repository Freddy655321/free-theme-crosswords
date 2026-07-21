export type Direction = "across" | "down";

export interface Entry {
  number: number;
  row: number; // 0-index
  col: number; // 0-index
  direction: Direction;
  answer: string; // A-Z0-9 (ASCII), sin espacios
  clue: string;
}

export interface Crossword {
  theme: string;
  language: "es" | "en";
  size: number; // NxN
  grid: string[][];
  entries: Entry[];
  meta?: Record<string, unknown>;
}

export type DerivedEntry = Omit<Entry, "clue">;

export type Cell = "#" | "" | string;

export type Placement = {
  word: string;
  row: number;
  col: number;
  dir: Direction;
};

export type WordCandidate = {
  answer: string;
  thematic: boolean;
  source: "anchor" | "model" | "support" | "filler";
};

export type RawAnswerBank = { answers?: string[]; notes?: { answer: string; note: string }[] };

export type RawClueBank = { clues?: Array<{ answer?: string; clue?: string }> };
