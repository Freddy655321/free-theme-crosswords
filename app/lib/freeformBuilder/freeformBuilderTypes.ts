import type { Cell, DerivedEntry, Direction, WordCandidate } from "@/app/lib/crosswordTypes";

export type FreeformBuilderCanPlaceResult = {
  ok: boolean;
  crossings: number;
  reason?:
    | "out_of_bounds"
    | "blocked_cell"
    | "letter_conflict"
    | "side_touch_up"
    | "side_touch_down"
    | "side_touch_left"
    | "side_touch_right"
    | "before_cell_occupied"
    | "after_cell_occupied";
};

export type FreeformBuilderDependencies = {
  makeEmptyWorkingGrid: (n: number) => Cell[][];
  canPlaceWord: (
    grid: Cell[][],
    word: string,
    row: number,
    col: number,
    dir: Direction
  ) => FreeformBuilderCanPlaceResult;
  placeWord: (
    grid: Cell[][],
    word: string,
    row: number,
    col: number,
    dir: Direction
  ) => Array<{ r: number; c: number; prev: Cell }> | null;
  deriveEntriesFromGrid: (grid: string[][], minLen?: number) => DerivedEntry[];
};

export type FreeformBuilderInput = {
  size: number;
  candidates: WordCandidate[];
  seed: number;
  deadlineMs?: number;
  maxPlacedWords?: number;
  maxBuilds?: number;
  dependencies: FreeformBuilderDependencies;
};

export type FreeformBuilderResult = {
  grid: string[][];
  usedAnswers: string[];
  meta: Record<string, unknown>;
};
