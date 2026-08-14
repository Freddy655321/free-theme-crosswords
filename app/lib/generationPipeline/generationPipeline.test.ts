import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCspBankAuditReport } from "@/app/lib/answerPipeline";
import { runGenerationPipeline } from "./runGenerationPipeline";
import type { GenerationPipelineDependencies, GenerationPipelineInput } from "./generationPipelineTypes";

function makeDependencies(overrides: Partial<GenerationPipelineDependencies> = {}): GenerationPipelineDependencies {
  return {
    prepareAttemptAnswers: async () => ({ status: "continue", lastModelError: "model down" }),
    requestModelClues: async () => new Map(),
    sanitizeAnswerList: () => [],
    freeformBuilderDependencies: { isForbiddenPublishAnswer: () => false },
    legacyBuilderDependencies: {
      alwaysAllowAnswers: new Set(),
      commonEnglishDictionaryWords: [],
      fillerWords: [],
      frequencyEnglishDictionaryWords: [],
      frequencySpanishDictionaryWords: [],
      isAcceptable: () => false,
      isForbiddenPublishAnswer: () => false,
      isLikelyBadAnswer: () => false,
      isOverGenericThemeWordForTheme: () => false,
      patterns11: [],
      spanishFillerWords: [],
      weakContextDictionaryWords: new Set(),
    },
    openingBuilderDependencies: {
      isForbiddenPublishAnswer: () => false,
      isOverGenericThemeWordForTheme: () => false,
    },
    themeFirstRescueDependencies: {} as GenerationPipelineDependencies["themeFirstRescueDependencies"],
    gridEnhancementDependencies: { isForbiddenPublishAnswer: () => false, isOverGenericThemeWordForTheme: () => false, logger: console },
    openAiRepairServicesDependencies: {} as GenerationPipelineDependencies["openAiRepairServicesDependencies"],
    gridReconstructionPolicies: {} as GenerationPipelineDependencies["gridReconstructionPolicies"],
    applyCluesAndOverrides: (_theme, _language, derived) => derived.map((entry) => ({ ...entry, clue: "clue" })),
    buildCoreThematicSetFromPool: () => new Set(),
    buildPublishThematicSetFromPool: () => new Set(),
    buildThematicClueRequestHint: () => null,
    clueFromThemeNote: () => null,
    clueLooksOffTheme: () => false,
    fallbackClueForPublishRepair: () => "clue",
    hasStrongThematicClueSupport: () => false,
    isAcceptable: () => false,
    isCoreThematicCandidate: () => false,
    isForbiddenPublishAnswer: () => false,
    isLikelyBadAnswer: () => false,
    isOverGenericThemeWordForTheme: () => false,
    isPublishableAnswerForTheme: () => true,
    publishQualityIssue: () => null,
    reinforceThematicClues: () => undefined,
    repairPublishClues: (entries) => entries,
    specificThematicFallbackClue: () => null,
    alwaysAllowAnswers: new Set(),
    bannedAnswers: new Set(),
    contextualGenericAnswers: new Set(),
    contextualSupportAnswers: new Set(),
    fillerWords: [],
    lowValueContextlessAnswers: new Set(),
    modelFragmentAnswers: new Set(),
    spanishFillerWords: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<GenerationPipelineInput> = {}): GenerationPipelineInput {
  return {
    client: {} as never,
    theme: "Synthetic",
    language: "en",
    size: 11,
    startedAtMs: 0,
    deadlineMs: Date.now() + 30_000,
    csp11Enabled: false,
    csp11DiagnosticOnly: false,
    csp11DiagnosticBudgetMs: 1_000,
    csp11HybridDiagnostic: false,
    answerbankSearchModel: "fake-model",
    dependencies: makeDependencies(),
    ...overrides,
  };
}

async function withFakeNow<T>(values: number[], fn: () => Promise<T>): Promise<{ result: T; reads: number[] }> {
  const originalNow = Date.now;
  const reads: number[] = [];
  let index = 0;
  Date.now = () => {
    const value = index < values.length ? values[index] : values[values.length - 1];
    reads.push(value);
    index += 1;
    return value;
  };
  try {
    const result = await fn();
    return { result, reads };
  } finally {
    Date.now = originalNow;
  }
}

test("runGenerationPipeline preserves attempt ordering for preparation failures", async () => {
  const attempts: number[] = [];
  const result = await runGenerationPipeline(
    makeInput({
    dependencies: makeDependencies({
      prepareAttemptAnswers: async ({ attempt }) => {
        attempts.push(attempt);
        return { status: "continue", lastModelError: "model down" };
      },
    }),
    })
  );

  assert.deepEqual(attempts, [1, 2]);
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.failureKind, "service-unavailable");
    assert.equal(result.meta.source, "openai-error");
  }
});

test("runGenerationPipeline short-circuits before attempts when deadline is exhausted", async () => {
  const attempts: number[] = [];
  const result = await runGenerationPipeline(
    makeInput({
      deadlineMs: Date.now() - 1,
      dependencies: makeDependencies({
        prepareAttemptAnswers: async ({ attempt }) => {
          attempts.push(attempt);
          return { status: "continue", lastModelError: "late" };
        },
      }),
    })
  );

  assert.deepEqual(attempts, []);
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.failureKind, "unprocessable");
    assert.equal(result.meta.source, "generation-error");
  }
});

test("runGenerationPipeline preserves prepared skip issue in final failure metadata", async () => {
  const result = await runGenerationPipeline(
    makeInput({
      dependencies: makeDependencies({
        prepareAttemptAnswers: async ({ attempt }) => ({
          status: "skip",
          issue: `skip-${attempt}`,
          lastModelError: null,
        }),
      }),
    })
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.failureKind, "unprocessable");
    assert.equal(result.meta.source, "generation-error");
    assert.equal(result.meta.lastAnswerbankIssue, "skip-2");
  }
});

test("runGenerationPipeline retries answer-bank errors when the next loop deadline read is live", async () => {
  const attempts: number[] = [];
  const { result, reads } = await withFakeNow([0, 0, 0], () =>
    runGenerationPipeline(
      makeInput({
        deadlineMs: 10,
        dependencies: makeDependencies({
          prepareAttemptAnswers: async ({ attempt }) => {
            attempts.push(attempt);
            return {
              status: "continue",
              lastModelError: "answer bank failed",
            };
          },
        }),
      })
    )
  );

  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(reads, [0, 0, 0]);
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.failureKind, "service-unavailable");
    assert.equal(result.meta.source, "openai-error");
  }
});

test("runGenerationPipeline stops invalid-json skips when the next loop deadline read is expired", async () => {
  const attempts: number[] = [];
  const { result, reads } = await withFakeNow([0, 0, 11], () =>
    runGenerationPipeline(
      makeInput({
        deadlineMs: 10,
        dependencies: makeDependencies({
          prepareAttemptAnswers: async ({ attempt }) => {
            attempts.push(attempt);
            return {
              status: "skip",
              issue: "not enough clean answers after sanitize/topup; clean=0; min=15",
              lastModelError: null,
            };
          },
        }),
      })
    )
  );

  assert.deepEqual(attempts, [1]);
  assert.deepEqual(reads, [0, 0, 11]);
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.meta.lastAnswerbankIssue, "not enough clean answers after sanitize/topup; clean=0; min=15");
  }
});

test("runGenerationPipeline preserves empty-object skip retrying while the next loop deadline read is live", async () => {
  const attempts: number[] = [];
  const { result, reads } = await withFakeNow([0, 0, 0], () =>
    runGenerationPipeline(
      makeInput({
        deadlineMs: 10,
        dependencies: makeDependencies({
          prepareAttemptAnswers: async ({ attempt }) => {
            attempts.push(attempt);
            return {
              status: "skip",
              issue: `skip-${attempt}`,
              lastModelError: null,
            };
          },
        }),
      })
    )
  );

  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(reads, [0, 0, 0]);
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.meta.lastAnswerbankIssue, "skip-2");
  }
});

test("runGenerationPipeline accepts prepared snapshots and returns semantic failure without builders succeeding", async () => {
  const pool = [{ answer: "ALPHA", thematic: true, source: "model" as const }];
  const notesByAnswer = new Map([["ALPHA", "theme note"]]);
  const report = createCspBankAuditReport("Synthetic", "en", 11);
  const result = await runGenerationPipeline(
    makeInput({
      dependencies: makeDependencies({
        prepareAttemptAnswers: async () => ({
          status: "ready",
          attempt: 1,
          cspBankAuditReport: report,
          notesByAnswer,
          thematicKeepSet: new Set(["ALPHA"]),
          publishThemeSet: new Set(["ALPHA"]),
          placementThemeSet: new Set(["ALPHA"]),
          rawPool: pool,
          lastModelError: null,
          lastAnswerStats: { source: "test" },
        }),
      }),
    })
  );

  assert.equal(result.status, "failed");
});

test("generationPipeline module stays independent from Next.js HTTP objects", () => {
  const source = readFileSync("app/lib/generationPipeline/runGenerationPipeline.ts", "utf8");
  assert.equal(source.includes("next/server"), false);
  assert.equal(source.includes("NextResponse"), false);
});
