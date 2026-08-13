import type { Crossword, DerivedEntry, Entry, WordCandidate } from "@/app/lib/crosswordTypes";
import type { LegacyBuilderInputBase, LegacyBuilderResult } from "@/app/lib/legacyBuilder";
import type { ClueGenerationClient, ClueRequestItem } from "@/app/lib/publishPipeline";

export type ThemeFirstRescueDependencies = {
  buildCompactPatternCrossword11(opts: LegacyBuilderInputBase): LegacyBuilderResult | null;
  buildPatternCrossword11(opts: LegacyBuilderInputBase): LegacyBuilderResult | null;
  buildBeamCrossword11(opts: LegacyBuilderInputBase): LegacyBuilderResult | null;
  rebuildGridFromAllowedEntries(
    grid: string[][],
    allowedAnswers: Set<string>,
    minLen: number
  ): { grid: string[][]; derived: DerivedEntry[] } | null;
  deriveEntriesFromGrid(grid: string[][], minLen?: number): DerivedEntry[];
  checkedCellStats(grid: string[][], minLen: number): { checked: number; total: number; ratio: number };
  crossedEntryStats(grid: string[][], entries: DerivedEntry[], minLen: number): { crossed: number; total: number };
  entryCrossingStats(
    grid: string[][],
    entries: DerivedEntry[],
    minLen: number
  ): { weakEntries: Array<{ answer: string; checkedCells?: number }>; minCheckedCells: number };
  crosswordDensityFromGrid(grid: string[][]): number;
  minEntryLenForSize(size: number): number;
  minPublishEntriesForSize(size: number): number;
  minCrossingsPerEntryForPublish(size: number): number;
  isOverGenericThemeWordForTheme(theme: string, answer: string): boolean;
  hasStrongThematicClueSupport(opts: {
    theme: string;
    answer: string;
    language: "es" | "en";
    note?: string | null;
  }): boolean;
  buildThematicClueRequestHint(
    theme: string,
    answer: string,
    language: "es" | "en",
    note?: string | null
  ): string | null;
  requestModelClues(opts: {
    client: ClueGenerationClient;
    theme: string;
    language: "es" | "en";
    items: ClueRequestItem[];
  }): Promise<Map<string, string>>;
  clueFromThemeNote(theme: string, note: string, language: "es" | "en"): string | null;
  specificThematicFallbackClue(theme: string, answer: string, language: "es" | "en"): string | null;
  reinforceThematicClues(
    theme: string,
    language: "es" | "en",
    answers: string[],
    clueByAnswer: Map<string, string>,
    notesByAnswer: Map<string, string>,
    thematicSet: Set<string>
  ): void;
  applyCluesAndOverrides(
    theme: string,
    language: "es" | "en",
    derived: Omit<Entry, "clue">[],
    clueByAnswer: Map<string, string>
  ): Entry[];
  isPlaceholderClue(clue: string, language: "es" | "en"): boolean;
  now(): number;
  warn(message: string, payload: unknown): void;
};

export type ThemeFirstRescueInput = {
  client: ClueGenerationClient;
  theme: string;
  language: "es" | "en";
  size: number;
  pool: WordCandidate[];
  notesByAnswer: Map<string, string>;
  trustedThematicSet: Set<string>;
  seedBase: number;
  dependencies: ThemeFirstRescueDependencies;
};

export type ThemeFirstRescueResult = Crossword | null;
