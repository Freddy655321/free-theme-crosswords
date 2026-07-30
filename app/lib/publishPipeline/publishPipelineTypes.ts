import type { Entry } from "@/app/lib/crosswordTypes";

export type PublishPipelineLanguage = "es" | "en";

export type ClueRequestItem = {
  answer: string;
  thematic: boolean;
  hint?: string;
  note?: string;
};

export type ClueCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    } | null;
  }> | null;
};

export type ClueGenerationClient = {
  chat: {
    completions: {
      create(args: {
        model: string;
        temperature: number;
        max_tokens: number;
        response_format: { type: "json_object" };
        messages: Array<{ role: "system" | "user"; content: string }>;
      }): Promise<ClueCompletionResponse>;
    };
  };
};

export type RequestModelCluesPolicies = {
  isBadClue(clue: string): boolean;
  clueMentionsAnswer(clue: string, answer: string): boolean;
  clueMakesUnstableTemporalClaim(clue: string, language: PublishPipelineLanguage): boolean;
  clueMislabelsPartialPersonAnswer(
    answer: string,
    clue: string,
    language: PublishPipelineLanguage
  ): boolean;
  clueMislabelsKnownPartialTitle(theme: string, answer: string, clue: string): boolean;
  clueLooksOffTheme(theme: string, clue: string): boolean;
  warnClueRetryFailed(payload: { name: string; msg: string }): void;
};

export type RequestModelCluesInput = {
  client: ClueGenerationClient;
  theme: string;
  language: PublishPipelineLanguage;
  items: ClueRequestItem[];
  cluebankPrompt: string;
  answerbankSearchModel: string;
  clueModel: string;
  policies: RequestModelCluesPolicies;
};

export type ApplyCluesPolicies = {
  getThemeClueOverrides(theme: string): Record<string, { es: string; en: string }>;
  specificThematicFallbackClue(
    theme: string,
    answer: string,
    language: PublishPipelineLanguage
  ): string | null;
  isBadClue(clue: string): boolean;
  clueMentionsAnswer(clue: string, answer: string): boolean;
};

export type RepairPublishCluesPolicies = {
  contextualSupportAnswers: Set<string>;
  fallbackClueForPublishRepair(
    theme: string,
    answer: string,
    language: PublishPipelineLanguage,
    thematic: boolean,
    note?: string
  ): string | null;
  isPlaceholderClue(clue: string, language: PublishPipelineLanguage): boolean;
  isBadClue(clue: string): boolean;
  clueLooksTooGenericForThematic(clue: string, language: PublishPipelineLanguage): boolean;
  clueLooksWeakGeneratedFallback(clue: string, language: PublishPipelineLanguage): boolean;
  clueMakesUnstableTemporalClaim(clue: string, language: PublishPipelineLanguage): boolean;
  clueMislabelsPartialPersonAnswer(
    answer: string,
    clue: string,
    language: PublishPipelineLanguage
  ): boolean;
  clueMislabelsKnownPartialTitle(theme: string, answer: string, clue: string): boolean;
  clueLanguageLooksValid(clue: string, language: PublishPipelineLanguage): boolean;
  clueLooksOffTheme(theme: string, clue: string): boolean;
  clueMentionsAnswer(clue: string, answer: string): boolean;
};

export type PublishQualityPolicies = {
  answerLanguageLooksValidForPuzzle(answer: string, language: PublishPipelineLanguage): boolean;
  isLikelyBadAnswer(answer: string): boolean;
  alwaysAllowAnswers: Set<string>;
  modelFragmentAnswers: Set<string>;
  bannedAnswers: Set<string>;
  contextualGenericAnswers: Set<string>;
  contextualSupportAnswers: Set<string>;
  isPlaceholderClue(clue: string, language: PublishPipelineLanguage): boolean;
  isBadClue(clue: string): boolean;
  clueMakesUnstableTemporalClaim(clue: string, language: PublishPipelineLanguage): boolean;
  clueMislabelsPartialPersonAnswer(
    answer: string,
    clue: string,
    language: PublishPipelineLanguage
  ): boolean;
  clueMislabelsKnownPartialTitle(theme: string, answer: string, clue: string): boolean;
  clueLooksTooGenericForThematic(clue: string, language: PublishPipelineLanguage): boolean;
  clueLanguageLooksValid(clue: string, language: PublishPipelineLanguage): boolean;
  clueMentionsAnswer(clue: string, answer: string): boolean;
  lowValueContextlessAnswers: Set<string>;
  clueLooksWeakGeneratedFallback(clue: string, language: PublishPipelineLanguage): boolean;
  minEntriesForSize(size: number): number;
};

export type RunPublishPipelineInput = {
  theme: string;
  language: PublishPipelineLanguage;
  size: number;
  grid: string[][];
  notesByAnswer: Map<string, string>;
  thematicSet: Set<string>;
  meta?: Record<string, unknown>;
  source?: string;
  client?: ClueGenerationClient;
  answerbankSearchModel: string;
  clueModel: string;
  minEntryLenForSize(size: number): number;
  buildThematicClueRequestHint(
    theme: string,
    answer: string,
    language: PublishPipelineLanguage,
    note?: string | null
  ): string | null;
  reinforceThematicClues(
    theme: string,
    language: PublishPipelineLanguage,
    answers: Iterable<string>,
    clueByAnswer: Map<string, string>,
    notesByAnswer: Map<string, string>,
    thematicSet: Set<string>
  ): void;
  requestModelClues?: (opts: {
    client: ClueGenerationClient;
    theme: string;
    language: PublishPipelineLanguage;
    items: ClueRequestItem[];
  }) => Promise<Map<string, string>>;
  applyCluesAndOverrides(
    theme: string,
    language: PublishPipelineLanguage,
    derived: Omit<Entry, "clue">[],
    clueByAnswer: Map<string, string>
  ): Entry[];
  repairPublishClues(
    entries: Entry[],
    opts: {
      theme: string;
      language: PublishPipelineLanguage;
      thematicSet: Set<string>;
      notesByAnswer: Map<string, string>;
    }
  ): Entry[];
};

export type PublishPipelineResult = {
  crossword: {
    theme: string;
    language: PublishPipelineLanguage;
    size: number;
    grid: string[][];
    entries: Entry[];
    meta: Record<string, unknown>;
  };
  clueByAnswer: Map<string, string>;
};
