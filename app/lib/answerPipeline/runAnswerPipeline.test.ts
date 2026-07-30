import assert from "node:assert/strict";
import test from "node:test";

import type { WordCandidate } from "@/app/lib/crosswordTypes";
import {
  cspBankAuditSetDistribution,
  runAnswerPipeline,
  type BuildCandidatePoolInput,
  type RunAnswerPipelineDependencies,
  type RunAnswerPipelineInput,
  type RunAnswerPipelinePolicies,
} from "./index";

function makePolicies(overrides: Partial<RunAnswerPipelinePolicies> = {}): RunAnswerPipelinePolicies {
  return {
    asciiAnswerPattern: /^[A-Z0-9]+$/,
    bannedAnswers: new Set<string>(),
    alwaysAllowAnswers: new Set<string>(),
    answerLanguageLooksValidForPuzzle: () => true,
    isLikelyBadAnswer: () => false,
    noteLooksWeakThematicContext: () => false,
    minEntryLenForSize: () => 3,
    isPublishableAnswerForTheme: () => true,
    isForbiddenPublishAnswer: () => false,
    isOverGenericThemeWordForTheme: () => false,
    isThemeCoreWord: (_theme, answer) => answer === "CORE",
    ...overrides,
  };
}

function makeDependencies(
  overrides: Partial<RunAnswerPipelineDependencies> = {}
): RunAnswerPipelineDependencies & {
  warnings: Array<{ message: string; payload?: Record<string, unknown> }>;
  builtPools: BuildCandidatePoolInput[];
} {
  const warnings: Array<{ message: string; payload?: Record<string, unknown> }> = [];
  const builtPools: BuildCandidatePoolInput[] = [];
  return {
    expandGeographicCompoundAnswers: () => [],
    inferLocalSupportWords: () => [],
    validateThematicAnswers: async ({ answers }) => answers,
    topUpAnswers: async () => [],
    generateLengthBalancedThematicAnswers: async () => [],
    generateSupportWords: async () => [],
    rankSemanticSupportWords: async () => [],
    buildCandidatePoolFromAnswers: (input) => {
      builtPools.push(input);
      return (input.normalizedAnswerBank.answers ?? []).map<WordCandidate>((answer) => ({
        answer,
        thematic: input.placementThemeSet.has(answer),
        source: input.placementThemeSet.has(answer) ? "model" : "support",
      }));
    },
    minPublishEntriesForSize: () => 2,
    now: () => 0,
    warn: (message, payload) => warnings.push({ message, payload }),
    recordAuditDistribution: (report, stage, values) =>
      cspBankAuditSetDistribution(report, stage, values),
    errorSummary: (error) => error instanceof Error ? error.message : String(error),
    warnings,
    builtPools,
    ...overrides,
  };
}

function makeInput(overrides: Partial<RunAnswerPipelineInput> = {}): RunAnswerPipelineInput {
  const dependencies = makeDependencies();
  return {
    answerbankTextResult: {
      text: JSON.stringify({
        answers: ["ALPHA", "BETA", "GAMMA", "DELTA"],
        notes: [
          { answer: "ALPHA", note: "specific alpha note" },
          { answer: "BETA", note: "specific beta note" },
        ],
      }),
      model: "test-model",
      finishReason: "structured-length-buckets",
      usedWebSearch: false,
      trustedAnswers: ["ALPHA", "BETA"],
      contextAnswers: ["ALPHA", "BETA"],
    },
    theme: "ocean science",
    language: "en",
    size: 11,
    attempt: 1,
    deadlineMs: 1_000,
    targetAnswers: 70,
    enableSemanticSupport11: false,
    fillerWords: [],
    policies: makePolicies(),
    dependencies,
    ...overrides,
  };
}

test("runAnswerPipeline parses, audits, sanitizes, validates, and builds the pre-builder pool", async () => {
  const dependencies = makeDependencies();
  const result = await runAnswerPipeline(makeInput({ dependencies }));

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.cleanAnswers, ["ALPHA", "BETA", "GAMMA", "DELTA"]);
  assert.deepEqual(result.validated, ["ALPHA", "BETA", "GAMMA", "DELTA"]);
  assert.deepEqual(Array.from(result.thematicKeepSet), ["ALPHA", "BETA", "GAMMA", "DELTA"]);
  assert.deepEqual(result.rawPool.map((candidate) => candidate.answer), ["ALPHA", "BETA", "GAMMA", "DELTA"]);
  assert.equal(result.cspBankAuditReport.initialRawCount, 4);
  assert.equal(result.cspBankAuditReport.initialSanitizedCount, 4);
  assert.equal(result.cspBankAuditReport.candidatePoolCount, 4);
  assert.equal(dependencies.warnings[0]?.message, "[generate-crossword] answerbank raw");
});

test("runAnswerPipeline returns the current parse skip contract for invalid answer bank text", async () => {
  const result = await runAnswerPipeline(makeInput({
    answerbankTextResult: {
      text: "{not json",
      model: "test-model",
      finishReason: "stop",
      usedWebSearch: false,
    },
  }));

  assert.deepEqual(result, {
    status: "skip",
    reason: "answerbank-parse-failed",
    issue: "answerbank parse failed; chars=9; finish=stop",
  });
});

test("runAnswerPipeline preserves sanitization order, dedupe, exact-theme exclusion, and notes", async () => {
  const result = await runAnswerPipeline(makeInput({
    answerbankTextResult: {
      text: JSON.stringify({
        answers: ["Ocean", "Beta", "BE-TA", "Gamma"],
        notes: [{ answer: "be-ta", note: "winning beta note" }],
      }),
      model: "test-model",
      finishReason: "structured-length-buckets",
      usedWebSearch: false,
    },
    theme: "ocean",
  }));

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.cleanAnswers, ["BETA", "GAMMA"]);
  assert.equal(result.notesByAnswer.get("BETA"), "winning beta note");
  assert.equal(result.notesByAnswer.has("OCEAN"), false);
});

test("runAnswerPipeline uses injected expansion before validation and after top-ups", async () => {
  const expandedInputs: string[][] = [];
  const dependencies = makeDependencies({
    expandGeographicCompoundAnswers: (answers) => {
      expandedInputs.push(answers.slice());
      return answers.includes("LAGONORTE") ? ["LAGO", "NORTE"] : [];
    },
  });

  const result = await runAnswerPipeline(makeInput({
    answerbankTextResult: {
      text: JSON.stringify({ answers: ["LAGONORTE"] }),
      model: "test-model",
      finishReason: "structured-length-buckets",
      usedWebSearch: false,
    },
    dependencies,
  }));

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(expandedInputs, [
    ["LAGONORTE"],
    ["LAGONORTE", "LAGO", "NORTE"],
    ["LAGONORTE", "LAGO", "NORTE"],
  ]);
  assert.deepEqual(result.cleanAnswers, ["LAGONORTE", "LAGO", "NORTE"]);
});

test("runAnswerPipeline requests the current non-11 general top-up and preserves merge order", async () => {
  const topUpRequests: Array<{ existing: string[]; need: number }> = [];
  const dependencies = makeDependencies({
    topUpAnswers: async (request) => {
      topUpRequests.push({ existing: request.existing.slice(), need: request.need });
      return ["PHI", "CHI"];
    },
  });

  const result = await runAnswerPipeline(makeInput({
    answerbankTextResult: {
      text: JSON.stringify({
        answers: [
          "ALPHA",
          "BETA",
          "GAMMA",
          "DELTA",
          "EPSILON",
          "ZETA",
          "THETA",
          "IOTA",
          "KAPPA",
          "LAMBDA",
          "SIGMA",
          "TAU",
          "UPSILON",
          "OMEGA",
        ],
      }),
      model: "test-model",
      finishReason: "stop",
      usedWebSearch: false,
    },
    size: 9,
    targetAnswers: 17,
    deadlineMs: 1_000,
    dependencies,
  }));

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(topUpRequests, [
    {
      existing: [
        "ALPHA",
        "BETA",
        "GAMMA",
        "DELTA",
        "EPSILON",
        "ZETA",
        "THETA",
        "IOTA",
        "KAPPA",
        "LAMBDA",
        "SIGMA",
        "TAU",
        "UPSILON",
        "OMEGA",
      ],
      need: 3,
    },
  ]);
  assert.deepEqual(result.cleanAnswers, [
    "ALPHA",
    "BETA",
    "GAMMA",
    "DELTA",
    "EPSILON",
    "ZETA",
    "THETA",
    "IOTA",
    "KAPPA",
    "LAMBDA",
    "SIGMA",
    "TAU",
    "UPSILON",
    "OMEGA",
    "PHI",
    "CHI",
  ]);
});

test("runAnswerPipeline preserves length-balanced 11x11 top-up conditions and validation", async () => {
  const desiredLengths: Record<string, number> = {};
  const dependencies = makeDependencies({
    now: () => 0,
    generateLengthBalancedThematicAnswers: async ({ desiredByLength }) => {
      for (const [len, count] of desiredByLength) desiredLengths[String(len)] = count;
      return ["BALANCE"];
    },
    validateThematicAnswers: async ({ answers }) =>
      answers.includes("BALANCE") ? ["BALANCE"] : answers,
  });

  const result = await runAnswerPipeline(makeInput({
    answerbankTextResult: {
      text: JSON.stringify({ answers: ["ALPHA", "BETA"] }),
      model: "test-model",
      usedWebSearch: false,
    },
    deadlineMs: 100_000,
    dependencies,
  }));

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(desiredLengths["3"], 7);
  assert.equal(desiredLengths["4"], 12);
  assert.equal(result.cleanAnswers.includes("BALANCE"), true);
  assert.equal(result.validated.includes("BALANCE"), true);
});

test("runAnswerPipeline preserves validation fallback filtering when model validation fails", async () => {
  const dependencies = makeDependencies({
    validateThematicAnswers: async () => {
      throw new Error("validation failed");
    },
  });
  const policies = makePolicies({
    isPublishableAnswerForTheme: ({ answer }) => answer !== "DROP",
    isForbiddenPublishAnswer: (answer) => answer === "FORBID",
    isOverGenericThemeWordForTheme: (_theme, answer) => answer === "GENERIC",
    noteLooksWeakThematicContext: (note) => note === "weak note",
    isThemeCoreWord: (_theme, answer) => answer === "CORE",
  });

  const result = await runAnswerPipeline(makeInput({
    answerbankTextResult: {
      text: JSON.stringify({
        answers: ["KEEP", "CORE", "DROP", "FORBID", "GENERIC", "WEAK"],
        notes: [
          { answer: "KEEP", note: "useful note" },
          { answer: "WEAK", note: "weak note" },
        ],
      }),
      model: "test-model",
      finishReason: "structured-length-buckets",
      usedWebSearch: false,
    },
    policies,
    dependencies,
  }));

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.validated, ["KEEP", "CORE"]);
});

test("runAnswerPipeline preserves support words, fallback notes, support validation, and semantic support", async () => {
  const dependencies = makeDependencies({
    now: () => 0,
    generateSupportWords: async () => ["SUPPORT", "BAD"],
    validateThematicAnswers: async ({ answers }) => answers.filter((answer) => answer !== "BAD"),
    inferLocalSupportWords: () => [{ answer: "LOCAL", thematic: true }],
    rankSemanticSupportWords: async () => ["SEMANTIC"],
  });
  const policies = makePolicies({
    isLikelyBadAnswer: (answer) => answer === "BAD",
  });

  const result = await runAnswerPipeline(makeInput({
    deadlineMs: 100_000,
    enableSemanticSupport11: true,
    dependencies,
    policies,
  }));

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.supportWords, ["SUPPORT"]);
  assert.equal(result.notesByAnswer.get("SUPPORT"), "Concrete domain vocabulary for the theme ocean science.");
  assert.deepEqual(result.localSupportWords, [
    { answer: "LOCAL", thematic: true },
    { answer: "SEMANTIC", thematic: false },
  ]);
  assert.equal(result.thematicKeepSet.has("SUPPORT"), true);
});

test("runAnswerPipeline preserves the not-enough-clean skip after validation apply", async () => {
  const dependencies = makeDependencies({
    minPublishEntriesForSize: () => 4,
    validateThematicAnswers: async () => ["ALPHA"],
  });

  const result = await runAnswerPipeline(makeInput({
    answerbankTextResult: {
      text: JSON.stringify({ answers: ["ALPHA", "BETA"] }),
      model: "test-model",
      finishReason: "structured-length-buckets",
      usedWebSearch: false,
    },
    dependencies,
  }));

  assert.equal(result.status, "skip");
  if (result.status !== "skip") return;
  assert.equal(result.reason, "not-enough-clean-answers");
  assert.equal(result.issue, "not enough clean answers after sanitize/topup; clean=2; min=4");
});

test("runAnswerPipeline passes exact pre-pool state to the injected candidate pool builder", async () => {
  const dependencies = makeDependencies({
    inferLocalSupportWords: () => [{ answer: "LOCAL", thematic: false }],
    generateSupportWords: async () => ["SUPPORT"],
    now: () => 0,
  });

  const result = await runAnswerPipeline(makeInput({
    deadlineMs: 100_000,
    dependencies,
  }));

  assert.equal(result.status, "ok");
  assert.equal(dependencies.builtPools.length, 1);
  const built = dependencies.builtPools[0];
  assert.equal(built.theme, "ocean science");
  assert.equal(built.size, 11);
  assert.equal(built.language, "en");
  assert.deepEqual(built.supportWords, ["SUPPORT"]);
  assert.deepEqual(built.localSupportWords, [{ answer: "LOCAL", thematic: false }]);
  assert.equal(built.normalizedAnswerBank.answers, result.status === "ok" ? result.cleanAnswers : undefined);
});
