import type { Cell, DerivedEntry, Direction, WordCandidate } from "@/app/lib/crosswordTypes";

export type GridEnhancementLogger = {
  warn(message?: unknown, ...optionalParams: unknown[]): void;
};

export type GridEnhancementDependencies = {
  isForbiddenPublishAnswer(answer: string): boolean;
  isOverGenericThemeWordForTheme(theme: string, answer: string): boolean;
  placeWord(
    grid: Cell[][],
    word: string,
    row: number,
    col: number,
    dir: Direction
  ): Array<{ r: number; c: number; prev: Cell }> | null;
  logger: GridEnhancementLogger;
};

export type DensifyCleanGrid11Input = {
  theme: string;
  grid: string[][];
  candidates: WordCandidate[];
  targetEntries: number;
  seed: number;
  deadlineMs?: number;
  pruneWeakEntries?: boolean;
  dependencies: GridEnhancementDependencies;
};

export type DensifyCleanGrid11Result = {
  grid: string[][];
  derived: DerivedEntry[];
  added: string[];
  meta: Record<string, unknown>;
};

export type AugmentNoShortGridResult = {
  grid: string[][];
  derived: DerivedEntry[];
};

export type ExtendGridWithCrossedPair11Input = {
  grid: string[][];
  candidates: WordCandidate[];
  targetEntries: number;
  seed: number;
  dependencies: GridEnhancementDependencies;
};

export type ExtendGridWithCrossedPair11Result = {
  grid: string[][];
  derived: DerivedEntry[];
  addedAnswers: string[];
};
