import type { Cell, DerivedEntry, Entry, WordCandidate } from "@/app/lib/crosswordTypes";

export type LegacyEntryCrossingStats = {
  weakEntries: Array<{ answer: string; checkedCells?: number }>;
  minCheckedCells: number;
};

export type LegacyBuilderMode =
  | "pattern-11"
  | "compact-pattern-11"
  | "beam-11"
  | "strict-11"
  | "greedy-checked-11";

export type LegacyBuilderResult = {
  grid: string[][];
  usedAnswers: string[];
  meta: Record<string, unknown>;
};

export type LegacyPatternSlot = {
  row: number;
  col: number;
  direction: "across" | "down";
  len: number;
  cells: Array<{ r: number; c: number }>;
};

export type LegacyBuilderDependencies = {
  alwaysAllowAnswers: Set<string>;
  asciiAnswerPattern: RegExp;
  canPlaceWord: (
    grid: Cell[][],
    word: string,
    row: number,
    col: number,
    dir: "across" | "down"
  ) => { ok: boolean; crossings: number; reason?: string };
  checkedCellStats: (grid: string[][], minLen: number) => { checked: number; total: number; ratio: number };
  commonEnglishDictionaryWords: string[];
  crosswordDensityFromGrid: (grid: string[][]) => number;
  deriveEntriesFromGrid: (grid: string[][], minLen?: number) => DerivedEntry[];
  desiredPublishEntriesForSize: (size: number) => number;
  entryCrossingStats: (
    grid: string[][],
    entries: Omit<Entry, "clue">[],
    minLen: number
  ) => LegacyEntryCrossingStats;
  extractPatternSlots: (pattern: string[]) => LegacyPatternSlot[];
  fillerWords: string[];
  frequencyEnglishDictionaryWords: string[];
  frequencySpanishDictionaryWords: string[];
  gridToStrings: (grid: (string | null)[][]) => string[][];
  hasShortLetterRuns: (grid: string[][], minLen: number) => boolean;
  inBounds: (n: number, r: number, c: number) => boolean;
  isAcceptable: (grid: string[][], derived: Omit<Entry, "clue">[], themeSet?: Set<string>) => boolean;
  isForbiddenPublishAnswer: (answer: string) => boolean;
  isLikelyBadAnswer: (answer: string) => boolean;
  isOverGenericThemeWordForTheme: (theme: string, answer: string) => boolean;
  makeEmptyWorkingGrid: (n: number) => Cell[][];
  makeSeededRng: (seed: number) => () => number;
  minCrossingsPerEntryForPublish: (size: number) => number;
  minCoreThematicEntriesForPublish: (size: number, entryCount: number) => number;
  minEntryLenForSize: (size: number) => number;
  minPublishEntriesForSize: (size: number) => number;
  paintBlocks: (grid: (string | null)[][] | Cell[][]) => (string | null)[][];
  patterns11: string[][];
  placeWord: (
    grid: Cell[][],
    word: string,
    row: number,
    col: number,
    dir: "across" | "down"
  ) => Array<{ r: number; c: number; prev: Cell }> | null;
  shuffleInPlace: <T>(arr: T[], rng: () => number) => void;
  spanishFillerWords: string[];
  weakContextDictionaryWords: Set<string>;
};

export type LegacyBuilderInputBase = {
  theme: string;
  size: number;
  candidates: WordCandidate[];
  seed: number;
  deadlineMs?: number;
};

export type LegacyBuilderInput = LegacyBuilderInputBase & {
  mode: LegacyBuilderMode;
  dependencies: LegacyBuilderDependencies;
};
