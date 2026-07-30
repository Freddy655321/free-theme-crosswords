import type { CspBankAuditEvent11, IntegratedCspBuildResult11 } from "@/app/lib/buildCspCrossword11";
import type { CspCandidateReservoir11, CspReservoirInputCandidate11 } from "@/app/lib/buildCspCandidateReservoir11";
import type {
  CspConstraintTopUpParsed11,
  CspConstraintTopUpRequest11,
  CspConstraintTopUpRequestInput11,
} from "@/app/lib/crosswordCspConstraintTopUp11";
import type { CspLengthTopUpParsed11, CspLengthTopUpRequest11 } from "@/app/lib/crosswordCspTopUp11";
import type { HybridCspCandidateReservoir11 } from "@/app/lib/buildHybridCspCandidateReservoir11";
import type { CspAdapterInputCandidate } from "@/app/lib/crosswordCspAdapter11";
import type { CrosswordPattern11 } from "@/app/lib/crosswordPatterns11";
import type { WordCandidate } from "@/app/lib/crosswordTypes";
import type { CspBankAuditReport } from "@/app/lib/answerPipeline";

export type CspOrchestrationLanguage = "es" | "en";

export type CspOrchestrationCompletionRequest = {
  model: string;
  temperature: number;
  max_tokens: number;
  response_format: { type: "json_object" };
  messages: Array<{ role: "system" | "user"; content: string }>;
};

export type CspOrchestrationCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

export type CspOrchestrationClient = {
  chat: {
    completions: {
      create(request: CspOrchestrationCompletionRequest): Promise<CspOrchestrationCompletionResponse>;
    };
  };
};

export type CspOrchestrationBuiltCrossword = {
  grid: string[][];
  usedAnswers: string[];
  meta: Record<string, unknown>;
};

export type CspOrchestrationPrepared = {
  requiredLengths: number[];
  cspCandidateReservoir: CspCandidateReservoir11;
  hybridCspCandidateReservoir: HybridCspCandidateReservoir11 | null;
};

export type PrepareCspOrchestrationInput = {
  theme: string;
  language: CspOrchestrationLanguage;
  attempt: number;
  rawPool: CspReservoirInputCandidate11[];
  thematicKeepSet: Set<string>;
  cspBankAuditReport: CspBankAuditReport;
  hybridDiagnostic: boolean;
  dependencies?: Partial<Pick<CspOrchestrationDependencies, "patterns" | "warn">>;
};

export type CspOrchestrationDependencies = {
  now: () => number;
  warn: (message: string, payload?: Record<string, unknown>) => void;
  patterns: CrosswordPattern11[];
  buildCspCrossword11ForEndpoint: (opts: {
    theme: string;
    language: CspOrchestrationLanguage;
    candidates: CspAdapterInputCandidate[];
    seed?: number;
    deadlineMs: number;
    topUpByLength?: (opts: {
      requestedByLength: Record<number, number>;
      existingAnswers: string[];
      attempt: number;
      deadlineMs: number;
    }) => Promise<CspAdapterInputCandidate[]>;
    topUpByConstraints?: (opts: {
      requests: CspConstraintTopUpRequest11[];
      existingAnswers: string[];
      attempt: number;
      deadlineMs: number;
    }) => Promise<CspAdapterInputCandidate[]>;
    patterns?: CrosswordPattern11[];
    maxTopUpRounds?: number;
    maxNodesPerPattern?: number;
    solverDeadlineMs?: number;
    audit?: (event: CspBankAuditEvent11) => void;
    diagnosticLog?: (event: CspBankAuditEvent11) => void;
    hybrid?: {
      enabled: boolean;
      candidates: HybridCspCandidateReservoir11["candidates"];
      minThematicEntries: number;
      targetThematicEntries: number;
      thematicCountsByLength: Record<number, number>;
      supportCountsByLength: Record<number, number>;
    };
  }) => Promise<IntegratedCspBuildResult11>;
  requestCspLengthTopUpAnswers11: (
    opts: CspLengthTopUpRequest11 & { completeJson: (prompt: string) => Promise<string> }
  ) => Promise<CspLengthTopUpParsed11>;
  requestCspConstraintTopUpAnswers11: (
    opts: CspConstraintTopUpRequestInput11 & { completeJson: (prompt: string) => Promise<string> }
  ) => Promise<CspConstraintTopUpParsed11>;
  validateThematicAnswers: (input: {
    client: CspOrchestrationClient;
    theme: string;
    language: CspOrchestrationLanguage;
    size: number;
    answers: string[];
    attempt: number;
  }) => Promise<string[]>;
};

export type CspOrchestrationInput = {
  size: number;
  theme: string;
  language: CspOrchestrationLanguage;
  attempt: number;
  seed: number;
  startedAtMs: number;
  deadlineMs: number;
  enabled: boolean;
  alreadyAttempted: boolean;
  diagnosticOnly: boolean;
  diagnosticBudgetMs: number;
  hybridDiagnostic: boolean;
  answerbankSearchModel: string;
  client: CspOrchestrationClient | null;
  prepared: CspOrchestrationPrepared;
  cspBankAuditReport: CspBankAuditReport;
  thematicKeepSet: Set<string>;
  publishThemeSet: Set<string>;
  placementThemeSet: Set<string>;
  dependencies: Pick<CspOrchestrationDependencies, "validateThematicAnswers"> &
    Partial<Omit<CspOrchestrationDependencies, "validateThematicAnswers">>;
};

export type CspOrchestrationDiagnostics = {
  auditReport: CspBankAuditReport;
  topUpCandidates: WordCandidate[];
};

export type CspOrchestrationResult =
  | {
      status: "accepted";
      attempted: true;
      crossword: CspOrchestrationBuiltCrossword;
      diagnostics: CspOrchestrationDiagnostics;
      metadata: {
        attemptMeta: Record<string, unknown>;
      };
    }
  | {
      status: "rejected";
      attempted: true;
      reason: string;
      diagnostics: CspOrchestrationDiagnostics;
      metadata: {
        attemptMeta: Record<string, unknown>;
      };
    }
  | {
      status: "skipped";
      attempted: false;
      reason: "disabled" | "wrong-size" | "already-attempted" | "deadline";
      diagnostics: CspOrchestrationDiagnostics;
    }
  | {
      status: "diagnostic";
      attempted: true;
      reason: string;
      diagnostics: CspOrchestrationDiagnostics & {
        responsePayload: Record<string, unknown>;
      };
      metadata: {
        attemptMeta: Record<string, unknown>;
      };
    };
