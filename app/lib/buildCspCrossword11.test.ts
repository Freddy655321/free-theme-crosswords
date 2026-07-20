import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CSP_PATTERN_11,
  extractSlotsFromPattern11,
  solveCrosswordPattern11WithReport,
  type CspCandidate,
} from "./crosswordCsp11";
import { CROSSWORD_PATTERNS_11, type CrosswordPattern11 } from "./crosswordPatterns11";
import {
  buildCspCrossword11ForEndpoint,
  deriveCspEntriesFromGrid11,
  isCsp11Enabled,
  runCspThenLegacy11,
  shouldUseCspDiagnosticOnly,
  validateCspCrosswordSolution11,
} from "./buildCspCrossword11";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function makeSolvedGrid(pattern: CrosswordPattern11, seed: number): string[][] {
  const slots = extractSlotsFromPattern11(pattern.rows);
  for (let attempt = 0; attempt < 700; attempt++) {
    const grid = Array.from({ length: 11 }, (_, row) =>
      Array.from({ length: 11 }, (_, col) => {
        if (pattern.rows[row]?.[col] === "#") return "#";
        const value =
          Math.imul(row + 5, 17) +
          Math.imul(col + 11, 23) +
          Math.imul(seed + attempt + 3, 31) +
          Math.imul(row + 1, col + 1);
        return ALPHABET[((value % ALPHABET.length) + ALPHABET.length) % ALPHABET.length] ?? "A";
      })
    );
    const answers = slots.map((slot) => slot.cells.map((cell) => grid[cell.row]?.[cell.col]).join(""));
    if (new Set(answers).size === answers.length) return grid;
  }
  throw new Error("Could not create fixture grid");
}

function candidatesFromGrid(pattern: CrosswordPattern11, grid: string[][], distractors = 0): CspCandidate[] {
  const slots = extractSlotsFromPattern11(pattern.rows);
  const answers = slots.map((slot) => slot.cells.map((cell) => grid[cell.row]?.[cell.col]).join(""));
  const used = new Set(answers);
  const candidates: CspCandidate[] = answers.map((answer, index) => ({
    answer,
    thematic: index % 3 !== 0,
    source: "fixture",
  }));
  for (const [answerIndex, answer] of answers.entries()) {
    for (let idx = 0; idx < distractors; idx++) {
      let distractor = "";
      let salt = 0;
      do {
        distractor = Array.from({ length: answer.length }, (_, charIndex) => {
          if (charIndex === idx % answer.length) return answer[charIndex] ?? "A";
          const value =
            Math.imul(answerIndex + 7, 37) +
            Math.imul(idx + 13, 19) +
            Math.imul(charIndex + 3, 29) +
            salt;
          return ALPHABET[((value % ALPHABET.length) + ALPHABET.length) % ALPHABET.length] ?? "A";
        }).join("");
        salt++;
      } while (used.has(distractor));
      used.add(distractor);
      candidates.push({ answer: distractor, thematic: idx % 4 === 0, source: "noise" });
    }
  }
  return candidates;
}

function hybridCandidatesFromGrid(
  pattern: CrosswordPattern11,
  grid: string[][],
  thematicCount: number
): Array<CspCandidate & { kind: "thematic" | "support"; source: string }> {
  const slots = extractSlotsFromPattern11(pattern.rows);
  return slots.map((slot, index) => {
    const answer = slot.cells.map((cell) => grid[cell.row]?.[cell.col]).join("");
    const thematic = index < thematicCount;
    return {
      answer,
      thematic,
      kind: thematic ? "thematic" : "support",
      source: thematic ? "fixture-thematic" : "fixture-support",
    };
  });
}

function incompatibleCandidates(pattern: CrosswordPattern11): CspCandidate[] {
  const counts = new Map<number, number>();
  for (const slot of extractSlotsFromPattern11(pattern.rows)) {
    counts.set(slot.length, (counts.get(slot.length) ?? 0) + 1);
  }
  return Array.from(counts.entries()).flatMap(([length, count], lengthIndex) =>
    Array.from({ length: count }, (_, index) => ({
      answer: `${ALPHABET[lengthIndex] ?? "A"}${String(index).padStart(length - 1, "0")}`.slice(0, length),
      thematic: true,
      source: "fixture",
    }))
  );
}

test("integrated CSP succeeds with a realistic noisy fixture and returns 22 entries", async () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const result = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates: candidatesFromGrid(pattern, makeSolvedGrid(pattern, 1), 8),
    seed: 1,
    deadlineMs: Date.now() + 20_000,
    patterns: [pattern],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const entries = deriveCspEntriesFromGrid11(result.grid);
  assert.equal(entries.length, 22);
  assert.equal(result.usedAnswers.length, 22);
  assert.equal(new Set(result.usedAnswers).size, 22);
  assert.equal(result.meta.source, "answers-csp11-then-clues");
});

test("integrated CSP reports missing-lengths and can request top-up by length", async () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const grid = makeSolvedGrid(pattern, 2);
  const missingLength = 4;
  let requested: Record<number, number> = {};
  const result = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates: candidatesFromGrid(pattern, grid).filter((candidate) => candidate.answer.length !== missingLength),
    seed: 2,
    deadlineMs: Date.now() + 20_000,
    patterns: [pattern],
    topUpByLength: async ({ requestedByLength }) => {
      requested = requestedByLength;
      return [];
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "missing-lengths");
  assert.ok((requested[missingLength] ?? 0) > 0);
  const diagnostics = result.meta.patternDiagnostics as Array<{ emptyDomainStage?: string; emptySlotLength?: number }>;
  assert.equal(diagnostics[0]?.emptyDomainStage, "initial");
  assert.equal(diagnostics[0]?.emptySlotLength, missingLength);
});

test("integrated CSP reports compatibility/domain failures, node-limit, and deadline", async () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const emptyDomain = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates: incompatibleCandidates(pattern),
    seed: 3,
    deadlineMs: Date.now() + 20_000,
    patterns: [pattern],
  });
  assert.equal(emptyDomain.ok, false);
  if (!emptyDomain.ok) {
    assert.equal(emptyDomain.reason, "zero-intersection-compatibility");
    const diagnostics = emptyDomain.meta.patternDiagnostics as Array<{ emptyDomainStage?: string }>;
    assert.equal(diagnostics[0]?.emptyDomainStage, "propagation");
  }

  const grid = makeSolvedGrid(pattern, 3);
  const nodeLimit = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates: candidatesFromGrid(pattern, grid, 5),
    seed: 3,
    deadlineMs: Date.now() + 20_000,
    patterns: [pattern],
    maxNodesPerPattern: 1,
  });
  assert.equal(nodeLimit.ok, false);
  if (!nodeLimit.ok) assert.equal(nodeLimit.reason, "node-limit");

  const deadline = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates: candidatesFromGrid(pattern, grid, 5),
    seed: 3,
    deadlineMs: Date.now() - 1,
    patterns: [pattern],
  });
  assert.equal(deadline.ok, false);
  if (!deadline.ok) assert.equal(deadline.reason, "deadline");
});

test("integrated CSP requests constrained top-up for propagation compatibility failures", async () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  let requestsSeen = 0;
  const result = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates: incompatibleCandidates(pattern),
    seed: 3,
    deadlineMs: Date.now() + 30_000,
    patterns: [pattern],
    maxTopUpRounds: 1,
    topUpByConstraints: async ({ requests }) => {
      requestsSeen += requests.length;
      assert.ok(requests.every((request) => request.constraints.length > 0));
      return [];
    },
  });

  assert.equal(result.ok, false);
  assert.ok(requestsSeen > 0);
  if (!result.ok) assert.equal(result.meta.cspConstraintTopUpCalls, 1);
});

test("diagnostic solver reports propagation conflict when constraints empty a domain", () => {
  const report = solveCrosswordPattern11WithReport({
    pattern: DEFAULT_CSP_PATTERN_11,
    candidates: [
      { answer: "ABCDEFGHIJK", thematic: true },
      { answer: "KJIHGFEDCBA", thematic: true },
    ],
    maxNodes: 10_000,
    seed: 1,
  });

  assert.equal(report.result, null);
  assert.equal(report.failureReason, "propagation-empty-domain");
  assert.ok(report.firstPropagationConflict);
});

test("solution validation catches deliberate corruptions", () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const grid = makeSolvedGrid(pattern, 4);
  const entries = deriveCspEntriesFromGrid11(grid);
  const allowedAnswers = new Set(entries.map((entry) => entry.answer));
  const usedAnswers = entries.map((entry) => entry.answer);

  assert.equal(
    validateCspCrosswordSolution11({ theme: "sample", pattern, grid, usedAnswers, allowedAnswers }).valid,
    true
  );

  const alteredLetter = grid.map((row) => [...row]);
  const firstOpen = pattern.rows.flatMap((row, rowIndex) =>
    Array.from(row).map((cell, col) => ({ cell, row: rowIndex, col }))
  ).find((cell) => cell.cell === ".");
  assert.ok(firstOpen);
  alteredLetter[firstOpen.row][firstOpen.col] = alteredLetter[firstOpen.row][firstOpen.col] === "A" ? "B" : "A";
  assert.equal(
    validateCspCrosswordSolution11({ theme: "sample", pattern, grid: alteredLetter, usedAnswers, allowedAnswers }).valid,
    false
  );

  assert.equal(
    validateCspCrosswordSolution11({
      theme: usedAnswers[0] ?? "sample",
      pattern,
      grid,
      usedAnswers,
      allowedAnswers,
    }).valid,
    false
  );

  assert.equal(
    validateCspCrosswordSolution11({
      theme: "sample",
      pattern,
      grid,
      usedAnswers: [usedAnswers[0] ?? "", ...(usedAnswers.slice(1, -1))],
      allowedAnswers,
    }).valid,
    false
  );

  const missingBank = new Set(usedAnswers.slice(1));
  assert.equal(
    validateCspCrosswordSolution11({ theme: "sample", pattern, grid, usedAnswers, allowedAnswers: missingBank }).valid,
    false
  );

  const incomplete = grid.map((row) => [...row]);
  incomplete[firstOpen.row][firstOpen.col] = "#";
  assert.equal(
    validateCspCrosswordSolution11({ theme: "sample", pattern, grid: incomplete, usedAnswers, allowedAnswers }).valid,
    false
  );

  const badDimensions = grid.slice(0, 10);
  assert.equal(
    validateCspCrosswordSolution11({ theme: "sample", pattern, grid: badDimensions, usedAnswers, allowedAnswers }).valid,
    false
  );
});

test("integrated CSP is deterministic by seed", async () => {
  const pattern = CROSSWORD_PATTERNS_11[1];
  assert.ok(pattern);
  const candidates = candidatesFromGrid(pattern, makeSolvedGrid(pattern, 5), 8);
  const first = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates,
    seed: 99,
    deadlineMs: Date.now() + 20_000,
    patterns: [pattern],
  });
  const second = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates,
    seed: 99,
    deadlineMs: Date.now() + 20_000,
    patterns: [pattern],
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) assert.deepEqual(first.grid, second.grid);
});

test("feature flag helper preserves legacy flow when disabled", async () => {
  let cspCalls = 0;
  let legacyCalls = 0;
  const result = await runCspThenLegacy11({
    enabled: isCsp11Enabled({ CROSSWORD_CSP_11_ENABLED: "false" }),
    tryCsp: async () => {
      cspCalls++;
      return { ok: false, reason: "unsatisfiable", meta: {} };
    },
    runLegacy: async () => {
      legacyCalls++;
      return "legacy";
    },
    useCsp: async () => "csp",
  });

  assert.equal(result, "legacy");
  assert.equal(cspCalls, 0);
  assert.equal(legacyCalls, 1);
});

test("diagnostic-only helper is gated by the CSP flag", () => {
  assert.equal(shouldUseCspDiagnosticOnly({ cspEnabled: false, diagnosticOnly: "true" }), false);
  assert.equal(shouldUseCspDiagnosticOnly({ cspEnabled: true, diagnosticOnly: "false" }), false);
  assert.equal(shouldUseCspDiagnosticOnly({ cspEnabled: true, diagnosticOnly: undefined }), false);
  assert.equal(shouldUseCspDiagnosticOnly({ cspEnabled: true, diagnosticOnly: "true" }), true);
  assert.equal(shouldUseCspDiagnosticOnly({ cspEnabled: true, diagnosticOnly: true }), true);
});

test("feature flag helper tries CSP first and skips legacy on success", async () => {
  let legacyCalls = 0;
  const result = await runCspThenLegacy11({
    enabled: isCsp11Enabled({ CROSSWORD_CSP_11_ENABLED: "true" }),
    tryCsp: async () => ({
      ok: true,
      grid: [],
      usedAnswers: [],
      patternId: "p",
      meta: {},
    }),
    runLegacy: async () => {
      legacyCalls++;
      return "legacy";
    },
    useCsp: async () => "csp",
  });

  assert.equal(result, "csp");
  assert.equal(legacyCalls, 0);
});

test("feature flag helper falls back to legacy when CSP fails", async () => {
  let legacySawFailure = false;
  const result = await runCspThenLegacy11({
    enabled: true,
    tryCsp: async () => ({ ok: false, reason: "missing-lengths", meta: {} }),
    runLegacy: async (cspAttempt) => {
      legacySawFailure = cspAttempt?.ok === false && cspAttempt.reason === "missing-lengths";
      return "legacy";
    },
    useCsp: async () => "csp",
  });

  assert.equal(result, "legacy");
  assert.equal(legacySawFailure, true);
});

test("integrated CSP constrained top-up expands the reservoir before the second solve", async () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const grid = makeSolvedGrid(pattern, 11);
  const topUpCandidates = candidatesFromGrid(pattern, grid, 2);
  let requestsSeen = 0;

  const result = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates: incompatibleCandidates(pattern),
    seed: 11,
    deadlineMs: Date.now() + 30_000,
    patterns: [pattern],
    maxTopUpRounds: 1,
    topUpByConstraints: async ({ requests }) => {
      requestsSeen += requests.length;
      return topUpCandidates;
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(requestsSeen > 0);
  if (!result.ok) return;
  assert.equal(result.meta.cspConstraintTopUpCalls, 1);
  assert.ok(Number(result.meta.candidateCountAfterTopUp) > Number(result.meta.candidateCountBeforeTopUp));
});

test("integrated CSP failure includes bounded diagnostic payload", async () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const result = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates: incompatibleCandidates(pattern),
    seed: 12,
    deadlineMs: Date.now() + 20_000,
    patterns: [pattern],
    maxTopUpRounds: 0,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  const diagnostic = result.meta.diagnostic as {
    failureReason?: string;
    patternAttempts?: unknown[];
    constraintRequestsGenerated?: number;
    stoppedBecauseBudgetExhausted?: boolean;
  };
  assert.equal(diagnostic.failureReason, "zero-intersection-compatibility");
  assert.ok(Array.isArray(diagnostic.patternAttempts));
  assert.ok(diagnostic.patternAttempts.length <= 4);
  assert.ok((diagnostic.constraintRequestsGenerated ?? 0) > 0);
  assert.equal(typeof diagnostic.stoppedBecauseBudgetExhausted, "boolean");
});

test("integrated CSP does not call top-up when the diagnostic budget is exhausted", async () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  let topUpCalls = 0;
  const result = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates: incompatibleCandidates(pattern),
    seed: 13,
    deadlineMs: Date.now() + 2,
    patterns: [pattern],
    solverDeadlineMs: 1,
    topUpByConstraints: async () => {
      topUpCalls++;
      return [];
    },
  });

  assert.equal(result.ok, false);
  assert.equal(topUpCalls, 0);
});

test("integrated hybrid CSP runs only after thematic-only fails and satisfies the thematic quota", async () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const grid = makeSolvedGrid(pattern, 21);
  const hybridCandidates = hybridCandidatesFromGrid(pattern, grid, 8);
  const result = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates: incompatibleCandidates(pattern),
    seed: 21,
    deadlineMs: Date.now() + 30_000,
    patterns: [pattern],
    maxTopUpRounds: 0,
    hybrid: {
      enabled: true,
      candidates: hybridCandidates,
      minThematicEntries: 8,
      targetThematicEntries: 10,
      thematicCountsByLength: {},
      supportCountsByLength: {},
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const hybrid = result.meta.hybrid as { solved?: boolean; thematicEntryCount?: number; supportEntryCount?: number };
  const thematicOnly = result.meta.thematicOnly as { solved?: boolean; failureReason?: string };
  assert.equal(thematicOnly.solved, false);
  assert.equal(hybrid.solved, true);
  assert.equal(hybrid.thematicEntryCount, 8);
  assert.equal(hybrid.supportEntryCount, 14);
});

test("integrated hybrid CSP rejects a geometric solution below the thematic quota", async () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const grid = makeSolvedGrid(pattern, 22);
  const result = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates: incompatibleCandidates(pattern),
    seed: 22,
    deadlineMs: Date.now() + 30_000,
    patterns: [pattern],
    maxTopUpRounds: 0,
    hybrid: {
      enabled: true,
      candidates: hybridCandidatesFromGrid(pattern, grid, 7),
      minThematicEntries: 8,
      targetThematicEntries: 10,
      thematicCountsByLength: {},
      supportCountsByLength: {},
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  const diagnostic = result.meta.diagnostic as { hybrid?: { solved?: boolean; failureReason?: string } };
  assert.equal(diagnostic.hybrid?.solved, false);
});

test("integrated hybrid CSP is skipped when thematic-only solves", async () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const grid = makeSolvedGrid(pattern, 23);
  const result = await buildCspCrossword11ForEndpoint({
    theme: "sample",
    language: "en",
    candidates: candidatesFromGrid(pattern, grid, 2),
    seed: 23,
    deadlineMs: Date.now() + 30_000,
    patterns: [pattern],
    hybrid: {
      enabled: true,
      candidates: hybridCandidatesFromGrid(pattern, grid, 8),
      minThematicEntries: 8,
      targetThematicEntries: 10,
      thematicCountsByLength: {},
      supportCountsByLength: {},
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.meta.hybrid, undefined);
});
