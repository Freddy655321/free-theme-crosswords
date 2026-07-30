import assert from "node:assert/strict";
import test from "node:test";

import { createCspBankAuditReport } from "@/app/lib/answerPipeline";
import type { CspAdapterInputCandidate } from "@/app/lib/crosswordCspAdapter11";
import type { IntegratedCspBuildResult11 } from "@/app/lib/buildCspCrossword11";
import type {
  CspOrchestrationCompletionRequest,
  CspOrchestrationInput,
  CspOrchestrationPrepared,
} from "./cspOrchestrationTypes";
import { prepareCspOrchestration, runCspOrchestration } from "./runCspOrchestration";

const pattern = {
  id: "test-pattern",
  rows: [],
  metadata: {
    lengths: {
      5: 2,
      6: 1,
    },
  },
};

function makePrepared(): CspOrchestrationPrepared {
  const report = createCspBankAuditReport("Neutral", "en", 11);
  return prepareCspOrchestration({
    theme: "Neutral",
    language: "en",
    attempt: 0,
    rawPool: [
      { answer: "OMEGA", thematic: true, source: "model" },
      { answer: "ALPHA", thematic: true, source: "anchor" },
      { answer: "SUPPORT", thematic: false, source: "support" },
      { answer: "ALPHA", thematic: true, source: "model" },
      { answer: "PLANET", thematic: true, source: "model" },
    ],
    thematicKeepSet: new Set(["OMEGA", "PLANET"]),
    cspBankAuditReport: report,
    hybridDiagnostic: false,
    dependencies: {
      patterns: [pattern],
      warn: () => undefined,
    },
  });
}

function makeInput(
  overrides: Omit<Partial<CspOrchestrationInput>, "dependencies"> & {
    dependencies?: Partial<CspOrchestrationInput["dependencies"]>;
  } = {},
  calls: Array<{ label: string; payload?: unknown }> = []
): CspOrchestrationInput {
  const report = createCspBankAuditReport("Neutral", "en", 11);
  const prepared = makePrepared();
  return {
    size: 11,
    theme: "Neutral",
    language: "en",
    attempt: 3,
    seed: 12345,
    startedAtMs: 500,
    deadlineMs: 60_000,
    enabled: true,
    alreadyAttempted: false,
    diagnosticOnly: false,
    diagnosticBudgetMs: 45_000,
    hybridDiagnostic: false,
    answerbankSearchModel: "test-model",
    client: null,
    prepared,
    cspBankAuditReport: report,
    thematicKeepSet: new Set(["ALPHA"]),
    publishThemeSet: new Set(["ALPHA"]),
    placementThemeSet: new Set(["ALPHA"]),
    ...overrides,
    dependencies: {
      now: () => 1_000,
      warn: (message, payload) => calls.push({ label: message, payload }),
      validateThematicAnswers: async ({ answers }) => answers,
      buildCspCrossword11ForEndpoint: async () => ({
        ok: true,
        grid: [["A"]],
        usedAnswers: ["ALPHA"],
        patternId: "test-pattern",
        meta: {
          builder: "csp-pattern-11x11",
          nodesVisited: 1,
          backtracks: 0,
          cspElapsedMs: 4,
        },
      }),
      ...overrides.dependencies,
    },
  };
}

test("prepareCspOrchestration preserves reservoir composition and ordering", () => {
  const prepared = makePrepared();

  assert.deepEqual(prepared.requiredLengths, [5, 6]);
  assert.deepEqual(
    prepared.cspCandidateReservoir.candidates.map((candidate) => candidate.answer),
    ["ALPHA", "OMEGA", "PLANET"]
  );
  assert.deepEqual(prepared.cspCandidateReservoir.distributionByLength, { 5: 2, 6: 1 });
});

test("runCspOrchestration accepts normal CSP result and preserves solver args", async () => {
  const solverCalls: unknown[] = [];
  const input = makeInput({
    dependencies: {
      buildCspCrossword11ForEndpoint: async (args) => {
        solverCalls.push(args);
        return {
          ok: true,
          grid: [["A"]],
          usedAnswers: ["ALPHA"],
          patternId: "test-pattern",
          meta: { nodesVisited: 7, backtracks: 2, cspElapsedMs: 11 },
        };
      },
      validateThematicAnswers: async ({ answers }) => answers,
    },
  });

  const result = await runCspOrchestration(input);

  assert.equal(result.status, "accepted");
  assert.equal(result.attempted, true);
  assert.deepEqual(result.crossword.grid, [["A"]]);
  assert.deepEqual(result.crossword.usedAnswers, ["ALPHA"]);
  assert.equal(solverCalls.length, 1);
  const solverArgs = solverCalls[0] as {
    theme: string;
    language: string;
    seed: number;
    deadlineMs: number;
    candidates: CspAdapterInputCandidate[];
    patterns?: unknown;
  };
  assert.equal(solverArgs.theme, "Neutral");
  assert.equal(solverArgs.language, "en");
  assert.equal(solverArgs.seed, 12345);
  assert.equal(solverArgs.deadlineMs, 25_000);
  assert.equal(solverArgs.patterns, undefined);
  assert.deepEqual(
    solverArgs.candidates.map((candidate) => candidate.answer),
    ["ALPHA", "OMEGA", "PLANET"]
  );
});

test("runCspOrchestration skips without solver for disabled, wrong size, already attempted, and deadline", async () => {
  let solverCalls = 0;
  const solver = async (): Promise<IntegratedCspBuildResult11> => {
    solverCalls++;
    return { ok: false, reason: "deadline", meta: {} };
  };

  assert.equal((await runCspOrchestration(makeInput({ enabled: false, dependencies: { buildCspCrossword11ForEndpoint: solver } }))).status, "skipped");
  assert.equal((await runCspOrchestration(makeInput({ size: 9, dependencies: { buildCspCrossword11ForEndpoint: solver } }))).status, "skipped");
  assert.equal((await runCspOrchestration(makeInput({ alreadyAttempted: true, dependencies: { buildCspCrossword11ForEndpoint: solver } }))).status, "skipped");
  assert.equal(
    (
      await runCspOrchestration(
        makeInput({
          deadlineMs: 13_000,
          dependencies: {
            now: () => 1_000,
            buildCspCrossword11ForEndpoint: solver,
          },
        })
      )
    ).status,
    "skipped"
  );
  assert.equal(solverCalls, 0);
});

test("runCspOrchestration returns rejected result and metadata on CSP failure", async () => {
  const result = await runCspOrchestration(
    makeInput({
      dependencies: {
        buildCspCrossword11ForEndpoint: async () => ({
          ok: false,
          reason: "search-exhausted",
          meta: { source: "csp", cspElapsedMs: 9 },
        }),
        validateThematicAnswers: async ({ answers }) => answers,
      },
    })
  );

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "search-exhausted");
  assert.deepEqual(result.metadata.attemptMeta, {
    attempted: true,
    reason: "search-exhausted",
    elapsedMs: 0,
    source: "csp",
    cspElapsedMs: 9,
  });
});

test("runCspOrchestration preserves diagnostic-only response payload", async () => {
  const result = await runCspOrchestration(
    makeInput({
      diagnosticOnly: true,
      dependencies: {
        buildCspCrossword11ForEndpoint: async () => ({
          ok: false,
          reason: "deadline",
          meta: {
            source: "csp",
            algorithm: "ranked",
            cspElapsedMs: 12,
            cspTopUpCalls: 0,
            cspConstraintTopUpCalls: 0,
            diagnostic: { patternAttempts: [{ patternId: "p" }] },
          },
        }),
        validateThematicAnswers: async ({ answers }) => answers,
      },
    })
  );

  assert.equal(result.status, "diagnostic");
  assert.equal(result.diagnostics.responsePayload.error, "csp-diagnostic-failed");
  assert.deepEqual((result.diagnostics.responsePayload.diagnostic as Record<string, unknown>).patternAttempts, [
    { patternId: "p" },
  ]);
});

test("runCspOrchestration passes hybrid diagnostic args", async () => {
  let hybridSeen: unknown;
  const prepared = makePrepared();
  prepared.hybridCspCandidateReservoir = {
    candidates: [{ answer: "DELTA", thematic: false, source: "test", kind: "support" }],
    thematicCountsByLength: { 5: 1 },
    supportCountsByLength: { 5: 1 },
    totalCountsByLength: { 5: 2 },
    excludedSupportByReason: {},
  };

  await runCspOrchestration(
    makeInput({
      diagnosticOnly: true,
      hybridDiagnostic: true,
      prepared,
      dependencies: {
        buildCspCrossword11ForEndpoint: async (args) => {
          hybridSeen = args.hybrid;
          return {
            ok: false,
            reason: "deadline",
            meta: { diagnostic: {} },
          };
        },
        validateThematicAnswers: async ({ answers }) => answers,
      },
    })
  );

  assert.deepEqual(hybridSeen, {
    enabled: true,
    candidates: [{ answer: "DELTA", thematic: false, source: "test", kind: "support" }],
    minThematicEntries: 8,
    targetThematicEntries: 10,
    thematicCountsByLength: { 5: 1 },
    supportCountsByLength: { 5: 1 },
  });
});

test("runCspOrchestration preserves top-up payload, validation, audit, and set mutation", async () => {
  const payloads: CspOrchestrationCompletionRequest[] = [];
  const input = makeInput({
    client: {
      chat: {
        completions: {
          create: async (request) => {
            payloads.push(request);
            return { choices: [{ message: { content: '{"byLength":{"5":["DELTA","SIGMA"]}}' } }] };
          },
        },
      },
    },
    dependencies: {
      buildCspCrossword11ForEndpoint: async (args) => {
        const topUps = await args.topUpByLength?.({
          requestedByLength: { 5: 2 },
          existingAnswers: ["ALPHA"],
          attempt: 2,
          deadlineMs: 10_000,
        });
        return {
          ok: true,
          grid: [["A"]],
          usedAnswers: ["ALPHA", ...(topUps?.map((candidate) => candidate.answer) ?? [])],
          patternId: "test-pattern",
          meta: { nodesVisited: 1, backtracks: 0, cspElapsedMs: 1 },
        };
      },
      validateThematicAnswers: async ({ answers }) => answers.filter((answer) => answer === "DELTA"),
    },
  });

  const result = await runCspOrchestration(input);

  assert.equal(result.status, "accepted");
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].model, "test-model");
  assert.equal(payloads[0].temperature, 0.1);
  assert.equal(payloads[0].max_tokens, 1400);
  assert.deepEqual(payloads[0].response_format, { type: "json_object" });
  assert.equal(payloads[0].messages[0].role, "system");
  assert.equal(payloads[0].messages[0].content, "Return ONLY valid JSON. No extra text.");
  assert.equal(input.thematicKeepSet.has("DELTA"), true);
  assert.equal(input.publishThemeSet.has("DELTA"), true);
  assert.equal(input.placementThemeSet.has("DELTA"), true);
  assert.deepEqual(result.diagnostics.topUpCandidates, [{ answer: "DELTA", thematic: true, source: "model" }]);
});

test("runCspOrchestration preserves constraint top-up payload", async () => {
  const payloads: CspOrchestrationCompletionRequest[] = [];
  await runCspOrchestration(
    makeInput({
      client: {
        chat: {
          completions: {
            create: async (request) => {
              payloads.push(request);
              return { choices: [{ message: { content: '{"groups":[{"requestId":"len5-p0D","answers":["DELTA"]}]}' } }] };
            },
          },
        },
      },
      dependencies: {
        buildCspCrossword11ForEndpoint: async (args) => {
          await args.topUpByConstraints?.({
            requests: [
              {
                requestId: "len5-p0D",
                length: 5,
                constraints: [{ position: 0, requiredLetter: "D" }],
                count: 1,
              },
            ],
            existingAnswers: ["ALPHA"],
            attempt: 4,
            deadlineMs: 10_000,
          });
          return {
            ok: false,
            reason: "search-exhausted",
            meta: {},
          };
        },
        validateThematicAnswers: async ({ answers }) => answers,
      },
    })
  );

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].model, "test-model");
  assert.equal(payloads[0].temperature, 0.1);
  assert.equal(payloads[0].max_tokens, 1600);
  assert.deepEqual(payloads[0].response_format, { type: "json_object" });
});

test("runCspOrchestration omits top-up callbacks when budget guard is exhausted", async () => {
  await runCspOrchestration(
    makeInput({
      client: {
        chat: {
          completions: {
            create: async () => ({ choices: [] }),
          },
        },
      },
      deadlineMs: 29_000,
      dependencies: {
        now: () => 1_000,
        buildCspCrossword11ForEndpoint: async (args) => {
          assert.equal(args.topUpByLength, undefined);
          assert.equal(args.topUpByConstraints, undefined);
          return {
            ok: false,
            reason: "search-exhausted",
            meta: {},
          };
        },
        validateThematicAnswers: async ({ answers }) => answers,
      },
    })
  );
});

test("runCspOrchestration supports patterns override without mutating reservoir input", async () => {
  const input = makeInput({
    dependencies: {
      patterns: [pattern],
      buildCspCrossword11ForEndpoint: async (args) => {
        assert.deepEqual(args.patterns, [pattern]);
        return {
          ok: true,
          grid: [["A"]],
          usedAnswers: ["ALPHA"],
          patternId: "test-pattern",
          meta: { nodesVisited: 1, backtracks: 0, cspElapsedMs: 1 },
        };
      },
      validateThematicAnswers: async ({ answers }) => answers,
    },
  });
  const originalCandidates = input.prepared.cspCandidateReservoir.candidates.map((candidate) => ({ ...candidate }));

  await runCspOrchestration(input);

  assert.deepEqual(input.prepared.cspCandidateReservoir.candidates, originalCandidates);
});

test("runCspOrchestration propagates solver null and thrown errors like the original inline block", async () => {
  await assert.rejects(
    () =>
      runCspOrchestration(
        makeInput({
          dependencies: {
            buildCspCrossword11ForEndpoint: async () => null as unknown as IntegratedCspBuildResult11,
            validateThematicAnswers: async ({ answers }) => answers,
          },
        })
      ),
    TypeError
  );

  await assert.rejects(
    () =>
      runCspOrchestration(
        makeInput({
          dependencies: {
            buildCspCrossword11ForEndpoint: async () => {
              throw new Error("solver exploded");
            },
            validateThematicAnswers: async ({ answers }) => answers,
          },
        })
      ),
    /solver exploded/
  );
});

test("runCspOrchestration is deterministic for repeated identical inputs", async () => {
  const first = await runCspOrchestration(makeInput());
  const second = await runCspOrchestration(makeInput());

  assert.deepEqual(first, second);
});
