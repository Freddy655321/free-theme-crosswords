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
