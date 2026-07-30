import type { RawAnswerBank, WordCandidate } from "@/app/lib/crosswordTypes";

export type CspBankAuditRejectedSample = {
  answer: string;
  reason: string;
};

export type CspBankAuditReport = {
  theme: string;
  language: "es" | "en";
  size: number;
  initialRawCount: number;
  initialSanitizedCount: number;
  validatedCount: number;
  candidatePoolCount: number;
  cspCandidateCount: number;
  distributions: Record<string, Record<string, number>>;
  rejectedByStage: Record<string, Record<string, number>>;
  rejectedSamplesByStage: Record<string, CspBankAuditRejectedSample[]>;
  samplesByStage: Record<string, string[]>;
  cspMissingLengths: Record<string, number>;
  cspRequestedTopUpByLength: Record<string, number>;
  cspTopUpRawByLength: Record<string, number>;
  cspTopUpAcceptedByLength: Record<string, number>;
  cspTopUpRejectedByLength: Record<string, number>;
  cspAdapterRejectedByReason: Record<string, number>;
  cspDomainDiagnostics: unknown[];
};

export type SanitizeAuditPolicies = {
  asciiAnswerPattern: RegExp;
  bannedAnswers: ReadonlySet<string>;
  alwaysAllowAnswers: ReadonlySet<string>;
  answerLanguageLooksValidForPuzzle: (answer: string, language: "es" | "en") => boolean;
  isLikelyBadAnswer: (answer: string) => boolean;
};

export type AnswerLanguage = "es" | "en";

export type NoteItem = {
  answer?: unknown;
  note?: unknown;
};

export type AnswerSanitizationPolicies = SanitizeAuditPolicies & {
  noteLooksWeakThematicContext: (note: string, language: AnswerLanguage) => boolean;
  minEntryLenForSize: (size: number) => number;
};

export type SanitizeAnswerListPolicies = Pick<
  AnswerSanitizationPolicies,
  | "asciiAnswerPattern"
  | "bannedAnswers"
  | "alwaysAllowAnswers"
  | "answerLanguageLooksValidForPuzzle"
  | "isLikelyBadAnswer"
>;

export type SanitizedInitialAnswerBankResult = {
  notesByAnswer: Map<string, string>;
  rawNormalizedAnswers: string[];
  cleanAnswers: string[];
  normalizedThemeAnswer: string;
};

export type MergeExpandedAnswersInput = {
  target: string[];
  source: readonly string[];
  size: number;
  expandAnswers: (answers: string[], maxLen: number) => string[];
  acceptExpanded?: (answer: string) => boolean;
};

export type ThematicKeepSetPolicies = {
  noteLooksWeakThematicContext: (note: string, language: AnswerLanguage) => boolean;
};

export type BuildThematicKeepSetInput = {
  validated: readonly string[];
  contextAnswers: readonly string[];
  structuredTrustedSet: ReadonlySet<string>;
  notesByAnswer: Map<string, string>;
  language: AnswerLanguage;
  size: number;
  cleanAnswers: string[];
  expandAnswers: (answers: string[], maxLen: number) => string[];
  policies: ThematicKeepSetPolicies;
};

export type AnswerBankStats = {
  cleanCount: number;
  cleanSample: string[];
  validatedCount: number;
  validatedSample: string[];
  thematicKeepCount: number;
  thematicKeepSample: string[];
};

export type ApplyValidatedAnswersToCleanBankInput = {
  cleanAnswers: string[];
  validated: readonly string[];
  size: number;
  minClean: number;
  targetAnswers: number;
};

export type ApplyValidatedAnswersToCleanBankResult = {
  applied: boolean;
  minKeepToApply: number;
  finalCount: number;
  cleanBefore?: number;
};

export type PrePoolAnswerBankPolicies = {
  isExcludedFromBroadThematicSet: (theme: string, answer: string) => boolean;
};

export type AnswerBankThematicSets = {
  broadModelThematicSet: Set<string>;
  themeSetForAttempt: Set<string>;
  publishThemeSet: Set<string>;
  placementThemeSet: Set<string>;
};

export type BuildPrePoolAnswerBankStateInput = {
  cleanAnswers: string[];
  validated: readonly string[];
  thematicKeepSet: Set<string>;
  theme: string;
  language: AnswerLanguage;
  size: number;
  fillerWords: readonly string[];
  policies: PrePoolAnswerBankPolicies;
};

export type PrePoolAnswerBankState = {
  normalizedAnswerBank: {
    answers: string[];
  };
  thematicSets: AnswerBankThematicSets;
  stats: AnswerBankStats;
};

export type RequestAnswerTopUpMessage = {
  role: "system" | "user";
  content: string;
};

export type RequestAnswerTopUpRequestArgs = {
  model: string;
  temperature: number;
  max_tokens: number;
  response_format: { type: "json_object" };
  messages: RequestAnswerTopUpMessage[];
};

export type RequestAnswerTopUpCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

export type RequestAnswerTopUpClient = {
  chat: {
    completions: {
      create(request: RequestAnswerTopUpRequestArgs): Promise<RequestAnswerTopUpCompletionResponse>;
    };
  };
};

export type RequestAnswerTopUpParseMode = "answers-with-salvage" | "answers-no-salvage";

export type RequestAnswerTopUpLoggerPayload = {
  rawText: string;
  rawText_len: number;
  rawText_head: string;
  rawText_tail: string;
};

export type RequestAnswerTopUpInput = {
  client: RequestAnswerTopUpClient;
  request: RequestAnswerTopUpRequestArgs;
  parseMode: RequestAnswerTopUpParseMode;
  maxLen: number;
  language: AnswerLanguage;
  sanitize: (raw: unknown, maxLen: number, language: AnswerLanguage) => string[];
  logger?: (payload: RequestAnswerTopUpLoggerPayload) => void;
};

export type RequestAnswerTopUpResult = {
  rawText: string;
  parsedAnswers: string[];
  salvagedAnswers: string[];
  cleanedAnswers: string[];
};

export type RobustAnswerTopUpBatchRequest = {
  existing: string[];
  need: number;
  tryIndex: number;
};

export type RunRobustAnswerTopUpInput = {
  existing: readonly string[];
  need: number;
  size: number;
  normalizeKey: (answer: string) => string;
  requestBatch: (request: RobustAnswerTopUpBatchRequest) => Promise<string[]>;
};

export type AnswerbankTextResultLike = {
  text: string;
  model: string;
  finishReason?: string;
  usedWebSearch: boolean;
  trustedAnswers?: string[];
  coreAnswers?: string[];
  contextAnswers?: string[];
};

export type LocalSupportWord = {
  answer: string;
  thematic: boolean;
};

export type ValidateThematicAnswersInput = {
  answers: string[];
};

export type LengthBalancedTopUpInput = {
  existing: string[];
  desiredByLength: Map<number, number>;
};

export type RobustTopUpInput = {
  existing: string[];
  need: number;
};

export type SupportWordsInput = {
  existing: string[];
};

export type BuildCandidatePoolInput = {
  theme: string;
  normalizedAnswerBank: RawAnswerBank;
  size: number;
  placementThemeSet: Set<string>;
  supportWords: string[];
  localSupportWords: LocalSupportWord[];
  language: AnswerLanguage;
};

export type RunAnswerPipelinePolicies = AnswerSanitizationPolicies & {
  isPublishableAnswerForTheme: (input: {
    theme: string;
    answer: string;
    language: AnswerLanguage;
    size: number;
    note?: string;
    allowContextualGeneric: boolean;
  }) => boolean;
  isForbiddenPublishAnswer: (answer: string) => boolean;
  isOverGenericThemeWordForTheme: (theme: string, answer: string) => boolean;
  isThemeCoreWord: (theme: string, answer: string) => boolean;
};

export type RunAnswerPipelineDependencies = {
  expandGeographicCompoundAnswers: (answers: string[], maxLen: number) => string[];
  inferLocalSupportWords: (
    theme: string,
    size: number,
    notesByAnswer: Map<string, string>
  ) => LocalSupportWord[];
  validateThematicAnswers: (input: ValidateThematicAnswersInput) => Promise<string[]>;
  topUpAnswers: (input: RobustTopUpInput) => Promise<string[]>;
  generateLengthBalancedThematicAnswers: (input: LengthBalancedTopUpInput) => Promise<string[]>;
  generateSupportWords: (input: SupportWordsInput) => Promise<string[]>;
  rankSemanticSupportWords: () => Promise<string[]>;
  buildCandidatePoolFromAnswers: (input: BuildCandidatePoolInput) => WordCandidate[];
  minPublishEntriesForSize: (size: number) => number;
  now: () => number;
  warn: (message: string, payload?: Record<string, unknown>) => void;
  recordAuditDistribution: (
    report: CspBankAuditReport,
    stage: string,
    values: Iterable<string>
  ) => void;
  errorSummary: (error: unknown) => string;
};

export type RunAnswerPipelineInput = {
  answerbankTextResult: AnswerbankTextResultLike;
  theme: string;
  language: AnswerLanguage;
  size: number;
  attempt: number;
  deadlineMs: number;
  targetAnswers: number;
  enableSemanticSupport11: boolean;
  fillerWords: readonly string[];
  policies: RunAnswerPipelinePolicies;
  dependencies: RunAnswerPipelineDependencies;
};

export type RunAnswerPipelineSkipResult = {
  status: "skip";
  reason: "answerbank-parse-failed" | "not-enough-clean-answers";
  issue: string;
  cspBankAuditReport?: CspBankAuditReport;
};

export type RunAnswerPipelineSuccessResult = {
  status: "ok";
  cspBankAuditReport: CspBankAuditReport;
  notesByAnswer: Map<string, string>;
  cleanAnswers: string[];
  validated: string[];
  thematicKeepSet: Set<string>;
  publishThemeSet: Set<string>;
  placementThemeSet: Set<string>;
  normalizedAnswerBank: RawAnswerBank;
  rawPool: WordCandidate[];
  supportWords: string[];
  localSupportWords: LocalSupportWord[];
  lastAnswerStats: AnswerBankStats;
};

export type RunAnswerPipelineResult =
  | RunAnswerPipelineSkipResult
  | RunAnswerPipelineSuccessResult;
