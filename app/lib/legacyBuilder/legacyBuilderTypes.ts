import type { Entry, WordCandidate } from "@/app/lib/crosswordTypes";
import type { PatternSlot } from "../gridConstruction";

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

export type LegacyPatternSlot = PatternSlot;

export type LegacyBuilderDependencies = {
  alwaysAllowAnswers: Set<string>;
  commonEnglishDictionaryWords: string[];
  fillerWords: string[];
  frequencyEnglishDictionaryWords: string[];
  frequencySpanishDictionaryWords: string[];
  isAcceptable: (grid: string[][], derived: Omit<Entry, "clue">[], themeSet?: Set<string>) => boolean;
  isForbiddenPublishAnswer: (answer: string) => boolean;
  isLikelyBadAnswer: (answer: string) => boolean;
  isOverGenericThemeWordForTheme: (theme: string, answer: string) => boolean;
  patterns11: string[][];
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
