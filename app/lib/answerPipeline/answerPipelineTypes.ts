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
