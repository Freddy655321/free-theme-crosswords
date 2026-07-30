import type { DerivedEntry, Entry } from "@/app/lib/crosswordTypes";

export type GridRebuildResult = {
  grid: string[][];
  derived: DerivedEntry[];
};

export type PublishableGridRebuildResult = {
  grid: string[][];
  entries: Entry[];
};

export type GridReconstructionLanguage = "es" | "en";

export type GridReconstructionPolicies = {
  applyCluesAndOverrides: (
    theme: string,
    language: GridReconstructionLanguage,
    derived: DerivedEntry[],
    clueByAnswer: Map<string, string>
  ) => Entry[];
  isAlwaysAllowedAnswer: (answer: string) => boolean;
  isLikelyBadAnswer: (answer: string) => boolean;
  isOverGenericThemeWordForTheme: (theme: string, answer: string) => boolean;
  isPlaceholderClue: (clue: string, language: GridReconstructionLanguage) => boolean;
  specificThematicFallbackClue: (
    theme: string,
    answer: string,
    language: GridReconstructionLanguage
  ) => string | null;
};
