import type OpenAI from "openai";
import type { Crossword, Entry, WordCandidate } from "@/app/lib/crosswordTypes";
import type { FreeformBuilderDependencies } from "@/app/lib/freeformBuilder";
import type { GridEnhancementDependencies } from "@/app/lib/gridEnhancement";
import type { GridReconstructionPolicies } from "@/app/lib/gridReconstruction";
import type { LegacyBuilderDependencies } from "@/app/lib/legacyBuilder";
import type { OpenAiRepairServicesDependencies } from "@/app/lib/openaiRepairServices";
import type { OpeningBuilderDependencies } from "@/app/lib/openingBuilder";
import type { CspBankAuditReport } from "@/app/lib/answerPipeline";
import type { ClueGenerationClient, ClueRequestItem } from "@/app/lib/publishPipeline";
import type { ThemeFirstRescueDependencies } from "@/app/lib/themeFirstRescue";

export type PreparedGenerationAttempt =
  | {
      status: "continue";
      lastModelError: string | null;
      lastAnswerStats?: Record<string, unknown> | null;
    }
  | {
      status: "skip";
      issue: string;
      lastModelError: string | null;
      lastAnswerStats?: Record<string, unknown> | null;
    }
  | {
      status: "ready";
      attempt: number;
      cspBankAuditReport: CspBankAuditReport;
      notesByAnswer: Map<string, string>;
      thematicKeepSet: Set<string>;
      publishThemeSet: Set<string>;
      placementThemeSet: Set<string>;
      rawPool: WordCandidate[];
      lastModelError: string | null;
      lastAnswerStats: Record<string, unknown> | null;
    };

export type GenerationFailureKind = "service-unavailable" | "unprocessable" | "internal";

export type GenerationPipelineAccepted = {
  status: "accepted";
  crossword: Crossword;
  lastCspAttemptMeta: Record<string, unknown> | null;
};

export type GenerationPipelineDiagnostic = {
  status: "diagnostic";
  responsePayload: unknown;
  lastCspAttemptMeta: Record<string, unknown> | null;
};

export type GenerationPipelineFailed = {
  status: "failed";
  failureKind: GenerationFailureKind;
  meta: Record<string, unknown>;
  lastCspAttemptMeta: Record<string, unknown> | null;
};

export type GenerationPipelineResult =
  | GenerationPipelineAccepted
  | GenerationPipelineDiagnostic
  | GenerationPipelineFailed;

export type GenerationPipelineDependencies = {
  prepareAttemptAnswers(input: { attempt: number }): Promise<PreparedGenerationAttempt>;
  requestModelClues(opts: {
    client: ClueGenerationClient;
    theme: string;
    language: "es" | "en";
    items: ClueRequestItem[];
  }): Promise<Map<string, string>>;
  sanitizeAnswerList(raw: unknown, maxLen: number, language?: "es" | "en"): string[];
  freeformBuilderDependencies: FreeformBuilderDependencies;
  legacyBuilderDependencies: LegacyBuilderDependencies;
  openingBuilderDependencies: OpeningBuilderDependencies;
  themeFirstRescueDependencies: ThemeFirstRescueDependencies;
  gridEnhancementDependencies: GridEnhancementDependencies;
  openAiRepairServicesDependencies: OpenAiRepairServicesDependencies;
  gridReconstructionPolicies: GridReconstructionPolicies;
  applyCluesAndOverrides(
    theme: string,
    language: "es" | "en",
    derived: Omit<Entry, "clue">[],
    clueByAnswer: Map<string, string>
  ): Entry[];
  buildCoreThematicSetFromPool(opts: {
    pool: WordCandidate[];
    trustedThematicSet: Set<string>;
    theme: string;
    language: "es" | "en";
    notesByAnswer: Map<string, string>;
    clueByAnswer?: Map<string, string>;
  }): Set<string>;
  buildPublishThematicSetFromPool(opts: {
    pool: WordCandidate[];
    trustedThematicSet: Set<string>;
    theme: string;
    language: "es" | "en";
    notesByAnswer: Map<string, string>;
    clueByAnswer?: Map<string, string>;
  }): Set<string>;
  buildThematicClueRequestHint(theme: string, answer: string, language: "es" | "en", note?: string | null): string | null;
  clueFromThemeNote(theme: string, note: string, language: "es" | "en"): string | null;
  clueLooksOffTheme(theme: string, clue: string): boolean;
  fallbackClueForPublishRepair(theme: string, answer: string, language: "es" | "en", thematic: boolean, note?: string): string | null;
  hasStrongThematicClueSupport(opts: { theme: string; answer: string; language: "es" | "en"; note?: string | null; clue?: string }): boolean;
  isAcceptable(grid: string[][], derived: Omit<Entry, "clue">[], themeSet?: Set<string>): boolean;
  isCoreThematicCandidate(opts: {
    candidate: WordCandidate;
    trustedThematicSet: Set<string>;
    theme: string;
    language: "es" | "en";
    notesByAnswer: Map<string, string>;
    clueByAnswer?: Map<string, string>;
  }): boolean;
  isForbiddenPublishAnswer(answer: string): boolean;
  isLikelyBadAnswer(answer: string): boolean;
  isOverGenericThemeWordForTheme(theme: string, answer: string): boolean;
  isPublishableAnswerForTheme(opts: { theme: string; answer: string; language: "es" | "en"; size: number; note?: string; allowContextualGeneric?: boolean }): boolean;
  publishQualityIssue(entries: Entry[], thematicSet: Set<string>, language: "es" | "en", minEntries: number, theme?: string): string | null;
  reinforceThematicClues(
    theme: string,
    language: "es" | "en",
    answers: Iterable<string>,
    clueByAnswer: Map<string, string>,
    notesByAnswer: Map<string, string>,
    thematicSet: Set<string>
  ): void;
  repairPublishClues(entries: Entry[], opts: { theme: string; language: "es" | "en"; thematicSet: Set<string>; notesByAnswer: Map<string, string> }): Entry[];
  specificThematicFallbackClue(theme: string, answer: string, language: "es" | "en"): string | null;
  alwaysAllowAnswers: Set<string>;
  bannedAnswers: Set<string>;
  contextualGenericAnswers: Set<string>;
  contextualSupportAnswers: Set<string>;
  fillerWords: string[];
  lowValueContextlessAnswers: Set<string>;
  modelFragmentAnswers: Set<string>;
  spanishFillerWords: string[];
};

export type GenerationPipelineInput = {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
  startedAtMs: number;
  deadlineMs: number;
  firstAttemptDeadlineCheckMs?: number;
  csp11Enabled: boolean;
  csp11DiagnosticOnly: boolean;
  csp11DiagnosticBudgetMs: number;
  csp11HybridDiagnostic: boolean;
  answerbankSearchModel: string;
  dependencies: GenerationPipelineDependencies;
};
