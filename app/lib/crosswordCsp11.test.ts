import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CSP_PATTERN_11,
  buildCspCrossword11,
  extractSlotsFromPattern11,
  prepareCandidateDomains,
  solveCrosswordPattern11WithReport,
  validatePattern11,
  type CspCandidate,
  type CrosswordSlot,
} from "./crosswordCsp11";

function syntheticSolvedGrid(): string[][] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from({ length: 11 }, (_, row) =>
    Array.from({ length: 11 }, (_, col) => alphabet[(row * 3 + col * 5) % alphabet.length] ?? "A")
  );
}

function wordsFromGrid(grid: string[][]): CspCandidate[] {
  const across = grid.map((row) => row.join(""));
  const down = Array.from({ length: 11 }, (_, col) => grid.map((row) => row[col]).join(""));
  return [...across, ...down].map((answer, index) => ({
    answer,
    thematic: index % 2 === 0,
    source: "test-fixture",
  }));
}

function derivedEntries(grid: string[][]) {
  const entries: Array<{ direction: "across" | "down"; row: number; col: number; answer: string }> = [];

  for (let row = 0; row < 11; row++) {
    entries.push({ direction: "across", row, col: 0, answer: grid[row]?.join("") ?? "" });
  }

  for (let col = 0; col < 11; col++) {
    entries.push({
      direction: "down",
      row: 0,
      col,
      answer: grid.map((row) => row[col]).join(""),
    });
  }

  return entries;
}

function slotAt(slots: CrosswordSlot[], id: string): CrosswordSlot {
  const slot = slots.find((item) => item.id === id);
  assert.ok(slot, `Expected slot ${id}`);
  return slot;
}

test("valid 11x11 pattern has at least 15 slots and every slot has two or more intersections", () => {
  const validation = validatePattern11(DEFAULT_CSP_PATTERN_11);

  assert.equal(validation.valid, true, validation.issues.join("; "));
  assert.equal(validation.slots.length, 22);
  assert.equal(validation.slots.filter((slot) => slot.direction === "across").length, 11);
  assert.equal(validation.slots.filter((slot) => slot.direction === "down").length, 11);
  assert.ok(validation.slots.every((slot) => slot.intersections.length >= 2));
});

test("invalid pattern with a two-letter run is rejected with an explanatory issue", () => {
  const pattern = [
    "##..#######",
    "###########",
    "###########",
    "###########",
    "###########",
    "###########",
    "###########",
    "###########",
    "###########",
    "###########",
    "###########",
  ];

  const validation = validatePattern11(pattern);

  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.includes("length 2")));
});

test("invalid pattern with a slot that has one crossing is rejected", () => {
  const pattern = [
    "...########",
    "#.#########",
    "#.#########",
    "###########",
    "###########",
    "###########",
    "###########",
    "###########",
    "###########",
    "###########",
    "###########",
  ];

  const validation = validatePattern11(pattern);

  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.includes("intersections; at least 2")));
});

test("intersections are symmetric, unique, and point to shared cells with correct indexes", () => {
  const slots = extractSlotsFromPattern11(DEFAULT_CSP_PATTERN_11);
  const a1 = slotAt(slots, "A1");
  const d1 = slotAt(slots, "D1");

  const a1d1 = a1.intersections.find((item) => item.otherSlotId === "D1");
  const d1a1 = d1.intersections.find((item) => item.otherSlotId === "A1");
  const a1d6 = a1.intersections.find((item) => item.otherSlotId === "D6");

  assert.deepEqual(a1d1, { otherSlotId: "D1", ownIndex: 0, otherIndex: 0 });
  assert.deepEqual(d1a1, { otherSlotId: "A1", ownIndex: 0, otherIndex: 0 });
  assert.deepEqual(a1d6, { otherSlotId: "D6", ownIndex: 5, otherIndex: 0 });

  for (const slot of slots) {
    const keys = slot.intersections.map((item) => `${item.otherSlotId}:${item.ownIndex}:${item.otherIndex}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(slot.intersections.length >= 2);
    for (const intersection of slot.intersections) {
      const other = slotAt(slots, intersection.otherSlotId);
      assert.deepEqual(slot.cells[intersection.ownIndex], other.cells[intersection.otherIndex]);
    }
  }
});

test("candidate domains normalize, deduplicate, group by length, and do not invent answers", () => {
  const slots = extractSlotsFromPattern11(DEFAULT_CSP_PATTERN_11);
  const domains = prepareCandidateDomains(slots, [
    { answer: " abc-def12345 ", thematic: false, source: "raw" },
    { answer: "ABCDEF12345", thematic: true, source: "better" },
    { answer: "", thematic: true },
    { answer: "TOO-SHORT", thematic: true },
  ]);

  assert.equal(domains.candidatesByAnswer.has("ABCDEF12345"), true);
  assert.equal(domains.candidatesByAnswer.get("ABCDEF12345")?.thematic, true);
  assert.equal(domains.candidatesByAnswer.has("TOOSHORT"), false);
  assert.equal(domains.domainsBySlotId.get("A1")?.some((candidate) => candidate.answer === "ABCDEF12345"), true);
});

test("deterministic synthetic fixture fills the complete pattern with no unassigned sequences", () => {
  const fixtureGrid = syntheticSolvedGrid();
  const candidates = wordsFromGrid(fixtureGrid);
  const result = buildCspCrossword11({
    pattern: DEFAULT_CSP_PATTERN_11,
    candidates,
    maxNodes: 100_000,
    seed: 123,
  });

  assert.ok(result);
  assert.equal(result.stats.solved, true);
  assert.equal(Object.keys(result.assignments).length, result.slots.length);
  assert.equal(result.usedAnswers.length, result.slots.length);
  assert.equal(new Set(result.usedAnswers).size, result.usedAnswers.length);
  assert.equal(result.grid.some((row) => row.includes("")), false);

  const entries = derivedEntries(result.grid);
  assert.equal(entries.length, result.slots.length);

  const assignmentsByRun = new Map(
    result.slots.map((slot) => [`${slot.direction}:${slot.row}:${slot.col}`, result.assignments[slot.id]])
  );

  for (const entry of entries) {
    assert.equal(assignmentsByRun.get(`${entry.direction}:${entry.row}:${entry.col}`), entry.answer);
  }

  for (const slot of result.slots) {
    assert.ok(slot.intersections.length >= 2);
  }
});

test("impossible candidate bank returns null without a partial grid", () => {
  const result = buildCspCrossword11({
    pattern: DEFAULT_CSP_PATTERN_11,
    candidates: [{ answer: "AAAAAAAAAAA", thematic: true }],
    maxNodes: 10_000,
    seed: 1,
  });

  assert.equal(result, null);
});

test("duplicate candidate answers are not reused across slots", () => {
  const fixtureGrid = syntheticSolvedGrid();
  const candidates = [
    ...wordsFromGrid(fixtureGrid),
    { answer: wordsFromGrid(fixtureGrid)[0]?.answer ?? "", thematic: true, source: "duplicate" },
  ];
  const result = buildCspCrossword11({
    pattern: DEFAULT_CSP_PATTERN_11,
    candidates,
    maxNodes: 100_000,
    seed: 123,
  });

  assert.ok(result);
  assert.equal(new Set(result.usedAnswers).size, result.usedAnswers.length);
});

test("maxNodes limit terminates cleanly", () => {
  const result = buildCspCrossword11({
    pattern: DEFAULT_CSP_PATTERN_11,
    candidates: wordsFromGrid(syntheticSolvedGrid()),
    maxNodes: 1,
    seed: 123,
  });

  assert.equal(result, null);
});

test("solve report captures propagation conflicts with positional constraints", () => {
  const report = solveCrosswordPattern11WithReport({
    pattern: DEFAULT_CSP_PATTERN_11,
    candidates: Array.from({ length: 8 }, (_, index) => ({
      answer: `B${String.fromCharCode(67 + index)}DEFAGHIJK`,
      thematic: true,
    })),
    maxNodes: 100,
    seed: 123,
  });

  assert.equal(report.failureReason, "propagation-empty-domain");
  assert.equal(report.emptyDomainStage, "propagation");
  assert.ok(report.firstPropagationConflict);
  assert.ok(report.firstPropagationConflict.constraints.length > 0);
  assert.ok(report.firstPropagationConflict.candidateCountBeforeEachConstraint.length > 0);
  assert.ok(report.propagationConflictSummary && report.propagationConflictSummary.length > 0);
});

test("solve report records real search profile metrics", () => {
  const report = solveCrosswordPattern11WithReport({
    pattern: DEFAULT_CSP_PATTERN_11,
    candidates: wordsFromGrid(syntheticSolvedGrid()),
    maxNodes: 100_000,
    seed: 123,
  });

  assert.ok(report.result);
  assert.ok(report.searchProfile);
  assert.ok(report.searchProfile.nodesVisited > 0);
  assert.ok(report.searchProfile.mrvCalls > 0);
  assert.ok(report.searchProfile.valueOrderingCalls > 0);
  assert.ok(report.searchProfile.propagationCalls > 0);
  assert.ok(report.searchProfile.constraintChecks > 0);
  assert.ok(report.searchProfile.nodesPerSecond > 0);
  assert.ok(report.searchProfile.searchCausality);
  assert.ok(Object.keys(report.searchProfile.searchCausality.depthProfile.nodesByDepth).length > 0);
  assert.ok(report.searchProfile.searchCausality.branchingDiagnostics.maxSelectedDomainSize > 0);
  assert.ok(report.searchProfile.searchCausality.valueOrderingDiagnostics.triedByOrdinal[0] > 0);
});

test("solve report causality records backtracks by depth and wipeout causes", () => {
  const report = solveCrosswordPattern11WithReport({
    pattern: DEFAULT_CSP_PATTERN_11,
    candidates: Array.from({ length: 8 }, (_, index) => ({
      answer: `B${String.fromCharCode(67 + index)}DEFAGHIJK`,
      thematic: true,
    })),
    maxNodes: 100,
    seed: 123,
  });

  const causality = report.searchProfile?.searchCausality;
  assert.ok(causality);
  assert.ok(Object.values(causality.depthProfile.backtracksByDepth).reduce((sum, count) => sum + count, 0) > 0);
  assert.ok(Object.values(causality.depthProfile.wipeoutsByDepth).reduce((sum, count) => sum + count, 0) > 0);
  assert.ok(causality.wipeoutRankings.samples.length > 0);
  assert.ok(causality.summary.primaryCause.length > 0);
});

test("final validation confirms all derived entries match assignments", () => {
  const result = buildCspCrossword11({
    pattern: DEFAULT_CSP_PATTERN_11,
    candidates: wordsFromGrid(syntheticSolvedGrid()),
    maxNodes: 100_000,
    seed: 999,
  });

  assert.ok(result);
  const entries = derivedEntries(result.grid);
  const assigned = new Set(Object.values(result.assignments));

  assert.equal(entries.length, result.slots.length);
  assert.ok(entries.every((entry) => assigned.has(entry.answer)));
  assert.ok(entries.every((entry) => entry.answer.length === 11));
});
