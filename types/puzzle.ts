// types/puzzle.ts
export type Direction = "across" | "down";

export interface Cell {
  row: number;
  col: number;
  char: string; // '' si vacío
  isBlock: boolean;
  number?: number; // numerito de pista
}

export interface Clue {
  number: number;
  direction: Direction;
  answer: string; // en MAYÚSCULAS
  text: string;   // enunciado
}

export interface Puzzle {
  id: string;
  title: string;
  width: number;
  height: number;
  grid: Cell[];  // flatten width*height
  clues: Clue[];
}

export interface GenerateRequest {
  topic: string;
}

export interface GenerateResponse {
  puzzle: Puzzle;
}
