import assert from "node:assert/strict";
import test from "node:test";

import { buildCspCrossword11, extractSlotsFromPattern11, type CspCandidate } from "./crosswordCsp11";
import {
  CROSSWORD_PATTERNS_11,
  analyzePattern11,
  benchmarkPatterns11,
  rankPatternsForCandidates11,
  type CrosswordPattern11,
  type PatternBenchmarkScenario11,
} from "./crosswordPatterns11";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function isRotationallySymmetric(rows: string[]): boolean {
  for (let row = 0; row < 11; row++) {
    for (let col = 0; col < 11; col++) {
      if (rows[row]?.[col] !== rows[10 - row]?.[10 - col]) return false;
    }
  }
  return true;
}

function makeSolvedGrid(pattern: CrosswordPattern11, seed: number): string[][] {
  const slots = extractSlotsFromPattern11(pattern.rows);

  for (let attempt = 0; attempt < 600; attempt++) {
    const grid = Array.from({ length: 11 }, (_, row) =>
      Array.from({ length: 11 }, (_, col) => {
        if (pattern.rows[row]?.[col] === "#") return "#";
        const value =
          Math.imul(row + 3, 17) +
          Math.imul(col + 5, 29) +
          Math.imul(seed + attempt + 11, 37) +
          Math.imul(row + 1, col + 7);
        return ALPHABET[((value % ALPHABET.length) + ALPHABET.length) % ALPHABET.length] ?? "A";
      })
    );
    const answers = slots.map((slot) => slot.cells.map((cell) => grid[cell.row]?.[cell.col]).join(""));
    if (answers.every((answer) => answer.length > 0) && new Set(answers).size === answers.length) {
      return grid;
    }
  }

  throw new Error(`Could not create unique fixture grid for ${pattern.id}`);
}

function candidatesFromSolvedGrid(
  pattern: CrosswordPattern11,
  grid: string[][],
  distractorsPerAnswer = 0,
  opts: { noisy?: boolean } = {}
): CspCandidate[] {
  const slots = extractSlotsFromPattern11(pattern.rows);
  const answers = slots.map((slot) => slot.cells.map((cell) => grid[cell.row]?.[cell.col]).join(""));
  const used = new Set(answers);
  const candidates: CspCandidate[] = answers.map((answer, index) => ({
    answer,
    thematic: !opts.noisy || index % 3 !== 0,
    source: "test-fixture",
  }));

  candidates.push(...answers.slice(0, 3).map((answer) => ({ answer, thematic: false, source: "duplicate" })));
  candidates.push({ answer: "XX", thematic: true, source: "wrong-length" });
  candidates.push({ answer: "ABCDEFGHIJKLMNOP", thematic: false, source: "wrong-length" });

  for (const [answerIndex, answer] of answers.entries()) {
    for (let distractorIndex = 0; distractorIndex < distractorsPerAnswer; distractorIndex++) {
      let distractor = "";
      let salt = 0;
      do {
        const chars = Array.from({ length: answer.length }, (_, index) => {
          if (index === distractorIndex % answer.length) return answer[index] ?? "A";
          const value =
            Math.imul(answerIndex + 7, 31) +
            Math.imul(distractorIndex + 5, 43) +
            Math.imul(index + 3, 19) +
            Math.imul(salt + 1, 23);
          return ALPHABET[((value % ALPHABET.length) + ALPHABET.length) % ALPHABET.length] ?? "A";
        });
        distractor = chars.join("");
        salt++;
      } while (used.has(distractor));

      used.add(distractor);
      candidates.push({
        answer: distractor,
        thematic: Boolean(opts.noisy && distractorIndex % 4 === 0),
        source: "test-distractor",
      });
    }
  }

  return deterministicShuffle(candidates, 9301);
}

function deterministicShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let index = out.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    const current = out[index];
    out[index] = out[swapIndex] as T;
    out[swapIndex] = current as T;
  }
  return out;
}

function derivedEntries(grid: string[][]) {
  const entries: Array<{ direction: "across" | "down"; row: number; col: number; answer: string }> = [];

  for (const direction of ["across", "down"] as const) {
    for (let outer = 0; outer < 11; outer++) {
      let inner = 0;
      while (inner < 11) {
        const read = (offset: number) =>
          direction === "across" ? grid[outer]?.[offset] : grid[offset]?.[outer];
        while (inner < 11 && read(inner) === "#") inner++;
        const start = inner;
        let answer = "";
        while (inner < 11 && read(inner) !== "#") {
          answer += read(inner);
          inner++;
        }
        if (answer.length >= 3) {
          entries.push({
            direction,
            row: direction === "across" ? outer : start,
            col: direction === "across" ? start : outer,
            answer,
          });
        }
      }
    }
  }

  return entries;
}

function assertSolvedPattern(pattern: CrosswordPattern11, distractorsPerAnswer: number) {
  const expectedGrid = makeSolvedGrid(pattern, pattern.id.length * 101);
  const candidates = candidatesFromSolvedGrid(pattern, expectedGrid, distractorsPerAnswer);
  const result = buildCspCrossword11({
    pattern: pattern.rows,
    candidates,
    maxNodes: 500_000,
    deadlineMs: 7_500,
    seed: 4242,
  });

  assert.ok(result, `Expected ${pattern.id} to solve`);
  assert.equal(Object.keys(result.assignments).length, result.slots.length);
  assert.equal(new Set(result.usedAnswers).size, result.usedAnswers.length);

  const entries = derivedEntries(result.grid);
  const assigned = new Set(Object.values(result.assignments));
  assert.equal(entries.length, result.slots.length);
  assert.ok(entries.every((entry) => assigned.has(entry.answer)));
  assert.ok(result.slots.every((slot) => slot.intersections.length >= 2));

  return { result, candidates };
}

test("pattern library has at least four valid 11x11 patterns with unique ids", () => {
  assert.ok(CROSSWORD_PATTERNS_11.length >= 4);
  assert.equal(new Set(CROSSWORD_PATTERNS_11.map((pattern) => pattern.id)).size, CROSSWORD_PATTERNS_11.length);

  for (const pattern of CROSSWORD_PATTERNS_11) {
    const analysis = analyzePattern11(pattern.rows);
    assert.equal(pattern.rows.length, 11);
    assert.ok(pattern.rows.every((row) => row.length === 11));
    assert.ok(pattern.rows.every((row) => /^[#.]+$/.test(row)));
    assert.equal(analysis.valid, true, `${pattern.id}: ${analysis.issues.join("; ")}`);
  }
});

test("each productive pattern has corrected slot and direction counts", () => {
  for (const pattern of CROSSWORD_PATTERNS_11) {
    const analysis = analyzePattern11(pattern.rows);
    assert.ok(analysis.slotCount >= 22 && analysis.slotCount <= 26, pattern.id);
    assert.ok(analysis.acrossCount >= 11, pattern.id);
    assert.ok(analysis.downCount >= 11, pattern.id);
  }
});

test("each productive pattern has strong intersections and useful length distribution", () => {
  for (const pattern of CROSSWORD_PATTERNS_11) {
    const analysis = analyzePattern11(pattern.rows);
    const distinctLengths = Object.keys(analysis.lengthCounts).length;
    const middleLengthSlots = Object.entries(analysis.lengthCounts).reduce(
      (sum, [length, count]) => sum + (Number(length) >= 4 && Number(length) <= 7 ? count : 0),
      0
    );
    const longSlots = Object.entries(analysis.lengthCounts).reduce(
      (sum, [length, count]) => sum + (Number(length) >= 9 ? count : 0),
      0
    );
    const threeSlots = analysis.lengthCounts[3] ?? 0;

    assert.ok(analysis.minIntersections >= 2, pattern.id);
    assert.ok(distinctLengths >= 4, pattern.id);
    assert.ok(middleLengthSlots / analysis.slotCount >= 0.6, pattern.id);
    assert.ok(longSlots <= 3, pattern.id);
    assert.ok(threeSlots <= 2, pattern.id);
  }
});

test("each productive pattern uses the complete 11x11 visual area", () => {
  for (const pattern of CROSSWORD_PATTERNS_11) {
    const analysis = analyzePattern11(pattern.rows);
    assert.ok(analysis.openDensity >= 0.4, pattern.id);
    assert.ok(analysis.openDensity <= 0.58, pattern.id);
    assert.equal(analysis.usedRows, 11, pattern.id);
    assert.equal(analysis.usedColumns, 11, pattern.id);
    assert.ok(analysis.openCellsTopRow > 0, pattern.id);
    assert.ok(analysis.openCellsBottomRow > 0, pattern.id);
    assert.ok(analysis.openCellsLeftColumn > 0, pattern.id);
    assert.ok(analysis.openCellsRightColumn > 0, pattern.id);
    assert.equal(analysis.boundingBoxCoverage, 1, pattern.id);
  }
});

test("each productive pattern is rotationally symmetric and connected", () => {
  for (const pattern of CROSSWORD_PATTERNS_11) {
    const analysis = analyzePattern11(pattern.rows);
    assert.equal(isRotationallySymmetric(pattern.rows), true, pattern.id);
    assert.equal(analysis.valid, true, pattern.id);
  }
});

test("each productive pattern can be completely solved with synthetic fixtures and distractors", () => {
  for (const pattern of CROSSWORD_PATTERNS_11) {
    assertSolvedPattern(pattern, 4);
  }
});

test("same pattern, candidates, and seed produce deterministic assignments", () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const expectedGrid = makeSolvedGrid(pattern, 777);
  const candidates = candidatesFromSolvedGrid(pattern, expectedGrid, 2);
  const first = buildCspCrossword11({ pattern: pattern.rows, candidates, seed: 19, maxNodes: 500_000 });
  const second = buildCspCrossword11({ pattern: pattern.rows, candidates, seed: 19, maxNodes: 500_000 });

  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(first.assignments, second.assignments);
  assert.equal(first.stats.nodesVisited, second.stats.nodesVisited);
  assert.equal(first.stats.backtracks, second.stats.backtracks);
});

test("solver returns null when candidates for a required length are removed", () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const analysis = analyzePattern11(pattern.rows);
  const removedLength = Math.min(...Object.keys(analysis.lengthCounts).map(Number));
  const grid = makeSolvedGrid(pattern, 888);
  const candidates = candidatesFromSolvedGrid(pattern, grid, 2).filter(
    (candidate) => candidate.answer.length !== removedLength
  );

  const result = buildCspCrossword11({
    pattern: pattern.rows,
    candidates,
    seed: 1,
    maxNodes: 20_000,
  });

  assert.equal(result, null);
});

test("rankPatternsForCandidates11 reports available, required, and missing counts deterministically", () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const grid = makeSolvedGrid(pattern, 999);
  const candidates = candidatesFromSolvedGrid(pattern, grid, 1);
  const ranked = rankPatternsForCandidates11(CROSSWORD_PATTERNS_11, candidates);
  const repeated = rankPatternsForCandidates11(CROSSWORD_PATTERNS_11, candidates);

  assert.deepEqual(ranked.map((item) => item.pattern.id), repeated.map((item) => item.pattern.id));
  assert.ok(ranked.some((item) => item.pattern.id === pattern.id));
  const current = ranked.find((item) => item.pattern.id === pattern.id);
  assert.ok(current);
  assert.deepEqual(current.missingByLength, {});
  assert.ok(Object.keys(current.requiredByLength).length >= 4);
});

test("benchmarkPatterns11 covers clean, noisy, and incompatible scenarios", () => {
  const clean: Record<string, CspCandidate[]> = {};
  const noisy10: Record<string, CspCandidate[]> = {};
  const noisy25: Record<string, CspCandidate[]> = {};
  const incompatible: Record<string, CspCandidate[]> = {};

  for (const pattern of CROSSWORD_PATTERNS_11) {
    const grid = makeSolvedGrid(pattern, 2026);
    clean[pattern.id] = candidatesFromSolvedGrid(pattern, grid, 0);
    noisy10[pattern.id] = candidatesFromSolvedGrid(pattern, grid, 10, { noisy: true });
    noisy25[pattern.id] = candidatesFromSolvedGrid(pattern, grid, 25, { noisy: true });
    incompatible[pattern.id] = candidatesFromSolvedGrid(pattern, grid, 2).map((candidate) => ({
      ...candidate,
      answer: "Z".repeat(candidate.answer.length),
    }));
  }

  const scenarios: PatternBenchmarkScenario11[] = [
    { id: "clean", candidatesByPatternId: clean },
    { id: "noisy-10", candidatesByPatternId: noisy10 },
    { id: "noisy-25", candidatesByPatternId: noisy25 },
    { id: "partially-incompatible", candidatesByPatternId: incompatible },
  ];

  const results = benchmarkPatterns11({
    patterns: CROSSWORD_PATTERNS_11,
    scenarios,
    runsPerPattern: 1,
    maxNodes: 600_000,
    deadlineMs: 10_000,
    seed: 55,
  });

  assert.equal(results.length, CROSSWORD_PATTERNS_11.length * scenarios.length);
  assert.ok(results.filter((result) => result.scenarioId === "clean").every((result) => result.solved));
  assert.ok(results.filter((result) => result.scenarioId === "noisy-10").every((result) => result.solved));
  assert.ok(results.filter((result) => result.scenarioId === "noisy-25").every((result) => result.solved));
  assert.ok(results.some((result) => result.backtracks > 0));
  assert.ok(results.every((result) => result.minimumInitialDomainSize >= 0));
});
