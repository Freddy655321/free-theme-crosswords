import type { Crossword, DerivedEntry, Entry, WordCandidate } from "@/app/lib/crosswordTypes";

export type OpenAiRepairLanguage = "es" | "en";

export interface OpenAiRepairChatClient {
  chat: {
    completions: {
      create(request: unknown): Promise<{
        choices?: Array<{
          message?: {
            content?: string | null;
          } | null;
        }> | null;
      }>;
    };
  };
}

export interface OpenAiRepairPatternSlot {
  direction: "across" | "down";
  row: number;
  col: number;
  len: number;
  cells: Array<{ r: number; c: number }>;
}

export type OpenAiRepairClueRequestItem = {
  answer: string;
  thematic: boolean;
  note?: string;
  hint?: string;
};

export interface OpenAiRepairServicesDependencies {
  answerbankSearchModel: string;
  alwaysAllowAnswers: ReadonlySet<string>;
  commonEnglishDictionaryWords: readonly string[];
  frequencyEnglishDictionaryWords: readonly string[];
  frequencySpanishDictionaryWords: readonly string[];
  weakContextDictionaryWords: ReadonlySet<string>;
  spanishFillerWords: readonly string[];
  fillerWords: readonly string[];
  pattern11x11s: readonly string[][];
  logger: Pick<Console, "warn">;
  errorSummary(error: unknown): string;
  extractPatternSlots(pattern: string[]): OpenAiRepairPatternSlot[];
  deriveEntriesFromGrid(grid: string[][], minLen?: number): DerivedEntry[];
  isAcceptable(grid: string[][], derived: Omit<Entry, "clue">[], themeSet?: Set<string>): boolean;
  isForbiddenPublishAnswer(answer: string): boolean;
  isLikelyBadAnswer(answer: string): boolean;
  isOverGenericThemeWordForTheme(theme: string, answer: string): boolean;
  noteLooksWeakThematicContext(note: string, language: OpenAiRepairLanguage): boolean;
  hasStrongThematicClueSupport(opts: {
    theme: string;
    answer: string;
    language: OpenAiRepairLanguage;
    note?: string;
  }): boolean;
  validateThematicAnswers(opts: {
    client: OpenAiRepairChatClient;
    theme: string;
    language: OpenAiRepairLanguage;
    size: number;
    answers: string[];
    attempt: number;
  }): Promise<string[]>;
  sanitizeModelClueText(clue: string, language: OpenAiRepairLanguage): string;
  isBadClue(clue: string): boolean;
  clueMentionsAnswer(clue: string, answer: string): boolean;
  clueMakesUnstableTemporalClaim(clue: string, language: OpenAiRepairLanguage): boolean;
  clueMislabelsPartialPersonAnswer(answer: string, clue: string, language: OpenAiRepairLanguage): boolean;
  clueMislabelsKnownPartialTitle(theme: string, answer: string, clue: string): boolean;
  buildThematicClueRequestHint(
    theme: string,
    answer: string,
    language: OpenAiRepairLanguage,
    note?: string | null
  ): string | null;
  requestModelClues(opts: {
    client: OpenAiRepairChatClient;
    theme: string;
    language: OpenAiRepairLanguage;
    items: OpenAiRepairClueRequestItem[];
  }): Promise<Map<string, string>>;
  reinforceThematicClues(
    theme: string,
    language: OpenAiRepairLanguage,
    answers: string[],
    clueByAnswer: Map<string, string>,
    notesByAnswer: Map<string, string>,
    thematicSet: Set<string>
  ): void;
  applyCluesAndOverrides(
    theme: string,
    language: OpenAiRepairLanguage,
    derived: DerivedEntry[],
    clueByAnswer: Map<string, string>
  ): Entry[];
  repairPublishClues(
    entries: Entry[],
    opts: {
      theme: string;
      language: OpenAiRepairLanguage;
      thematicSet: Set<string>;
      notesByAnswer?: Map<string, string>;
    }
  ): Entry[];
  publishQualityIssue(
    entries: Entry[],
    thematicSet: Set<string>,
    language: OpenAiRepairLanguage,
    minEntries: number,
    theme?: string
  ): string | null;
  augmentNoShortGridWithCandidates(
    grid: string[][],
    candidates: WordCandidate[],
    minLen: number,
    targetEntries: number,
    minimumReturnEntries?: number
  ): { grid: string[][]; derived: DerivedEntry[] } | null;
}

export type DirectPlayableCrosswordResult = Crossword | null;
