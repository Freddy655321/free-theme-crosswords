import type { Entry } from "../../app/lib/crosswordTypes";

export type BaselineLanguage = "en" | "es";

export type BenchmarkCaseCategory = "popular" | "geographic" | "cultural" | "broad";

export interface BenchmarkCase {
  id: string;
  theme: string;
  category: BenchmarkCaseCategory;
  defaultLanguage: BaselineLanguage;
  defaultSize: number;
  seed: string;
}

export interface GenerationBaselineOptions {
  execute: boolean;
  dryRun: boolean;
  cases: BenchmarkCase[];
  repeat: number;
  language: BaselineLanguage;
  size: number;
  outputDir: string;
  timeoutMs: number;
  compare?: [string, string];
}

export interface GenerationBaselineRunInfo {
  benchmarkRunId: string;
  timestamp: string;
  gitCommit: string | null;
  execute: boolean;
  dryRun: boolean;
  repeat: number;
  language: BaselineLanguage;
  size: number;
  timeoutMs: number;
  caseCount: number;
  plannedGenerations: number;
}

export interface EndpointEntry extends Entry {
  source?: string;
  thematic?: boolean;
}

export interface EndpointCrosswordResponse {
  error?: string;
  theme?: string;
  language?: string;
  size?: number;
  grid?: string[][];
  entries?: EndpointEntry[];
  meta?: Record<string, unknown>;
  diagnostic?: Record<string, unknown>;
}

export interface GenerationCaseIdentity {
  benchmarkRunId: string;
  timestamp: string;
  gitCommit: string | null;
  caseId: string;
  theme: string;
  language: BaselineLanguage;
  size: number;
  seed: string;
  attemptIndex: number;
}

export interface GridMetrics {
  dimensions: { rows: number; cols: number } | null;
  openCells: number | null;
  blockCells: number | null;
  density: number | null;
  totalEntries: number | null;
  acrossEntries: number | null;
  downEntries: number | null;
  crossingCells: number | null;
  checkedCellRatio: number | null;
  uncheckedCells: number | null;
  connectedComponents: number | null;
  shortRuns: number | null;
  validationAccepted: boolean | null;
  repairsApplied: unknown;
}

export interface AnswerMetrics {
  initialAnswerBankCount: number | null;
  sanitizedAnswerCount: number | null;
  mergedAnswerCount: number | null;
  candidatePoolFinalCount: number | null;
  usedAnswers: string[];
  thematicUsedAnswers: string[];
  supportOrFillerUsedAnswers: string[];
  unknownUsedAnswers: string[];
  confirmedThematicRatio: number | null;
  confirmedSupportFillerRatio: number | null;
  unknownRatio: number | null;
  thematicCellRatio: number | null;
  usedAnswerLengths: Record<string, number>;
  duplicates: string[];
  rejectedByLanguageOrPolicy: number | null;
}

export interface PublishMetrics {
  entriesWithClue: number | null;
  clueFallbacks: unknown;
  editorialRepairs: unknown;
  publishGateAccepted: boolean | null;
  finalWarnings: unknown[];
}

export interface PipelineMetrics {
  builder: string | null;
  strategiesAttempted: string[] | null;
  strategyOrder: string[] | null;
  attemptsByBuilder: Record<string, number> | null;
  deadlineExhausted: boolean | null;
  fallbackUsed: boolean | null;
  answerBankSource: string | null;
  openAiCallCount: number | null;
  modelsUsed: string[] | null;
  tokenUsage: { input: number | null; output: number | null } | null;
  estimatedCost: number | null;
}

export interface GenerationCaseEvaluation {
  identity: GenerationCaseIdentity;
  success: boolean;
  status: number | null;
  failureStage: string | null;
  failureReason: string | null;
  exceptionType: string | null;
  exceptionMessage: string | null;
  durationMs: number;
  pipeline: PipelineMetrics;
  grid: GridMetrics;
  answers: AnswerMetrics;
  publish: PublishMetrics;
  unavailableMetrics: string[];
  rawResponse?: EndpointCrosswordResponse;
}

export interface GenerationBaselineSummary {
  run: GenerationBaselineRunInfo;
  successRate: number;
  durationMedianMs: number | null;
  durationP95Ms: number | null;
  under30SecondsRate: number;
  builderUsage: Record<string, number>;
  fallbackUsage: Record<string, number>;
  averageEntries: number | null;
  medianEntries: number | null;
  averageConfirmedThematicRatio: number | null;
  medianConfirmedThematicRatio: number | null;
  averageCheckedCellRatio: number | null;
  failuresByStageReason: Record<string, number>;
  bestCases: string[];
  worstCases: string[];
  unavailableMetrics: Record<string, number>;
  cases: GenerationCaseEvaluation[];
}

export interface BaselineComparisonMetric {
  previous: number | string | null;
  current: number | string | null;
  status: "improvement" | "regression" | "unchanged" | "unavailable";
}

export interface BaselineComparison {
  previousRunId: string | null;
  currentRunId: string | null;
  metrics: Record<string, BaselineComparisonMetric>;
}
