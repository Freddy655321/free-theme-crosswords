import assert from "node:assert/strict";
import test from "node:test";

import { extractSlotsFromPattern11, type CspCandidate } from "./crosswordCsp11";
import {
  CROSSWORD_PATTERNS_11,
  analyzePattern11,
  type CrosswordPattern11,
} from "./crosswordPatterns11";
import {
  analyzeCandidateDomains11,
  solveWithRankedPatterns11,
} from "./crosswordCspOrchestrator11";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function makeSolvedGrid(pattern: CrosswordPattern11, seed: number): string[][] {
  const slots = extractSlotsFromPattern11(pattern.rows);

  for (let attempt = 0; attempt < 600; attempt++) {
    const grid = Array.from({ length: 11 }, (_, row) =>
      Array.from({ length: 11 }, (_, col) => {
        if (pattern.rows[row]?.[col] === "#") return "#";
        const value =
          Math.imul(row + 2, 23) +
          Math.imul(col + 7, 31) +
          Math.imul(seed + attempt + 5, 41) +
          Math.imul(row + 1, col + 3);
        return ALPHABET[((value % ALPHABET.length) + ALPHABET.length) % ALPHABET.length] ?? "A";
      })
    );
    const answers = slots.map((slot) => slot.cells.map((cell) => grid[cell.row]?.[cell.col]).join(""));
    if (new Set(answers).size === answers.length) return grid;
  }

  throw new Error(`Could not build fixture for ${pattern.id}`);
}

function candidatesFromGrid(pattern: CrosswordPattern11, grid: string[][], distractorsPerAnswer = 0): CspCandidate[] {
  const slots = extractSlotsFromPattern11(pattern.rows);
  const answers = slots.map((slot) => slot.cells.map((cell) => grid[cell.row]?.[cell.col]).join(""));
  const used = new Set(answers);
  const candidates: CspCandidate[] = answers.map((answer, index) => ({
    answer,
    thematic: index % 4 !== 0,
    source: "test-fixture",
  }));

  for (const [answerIndex, answer] of answers.entries()) {
    for (let distractorIndex = 0; distractorIndex < distractorsPerAnswer; distractorIndex++) {
      let distractor = "";
      let salt = 0;
      do {
        distractor = Array.from({ length: answer.length }, (_, index) => {
          if (index === distractorIndex % answer.length) return answer[index] ?? "A";
          const value =
            Math.imul(answerIndex + 11, 37) +
            Math.imul(distractorIndex + 13, 29) +
            Math.imul(index + 17, 19) +
            Math.imul(salt + 1, 7);
          return ALPHABET[((value % ALPHABET.length) + ALPHABET.length) % ALPHABET.length] ?? "A";
        }).join("");
        salt++;
      } while (used.has(distractor));

      used.add(distractor);
      candidates.push({ answer: distractor, thematic: distractorIndex % 3 === 0, source: "distractor" });
    }
  }

  candidates.push(...answers.slice(0, 2).map((answer) => ({ answer, thematic: false, source: "duplicate" })));
  candidates.push({ answer: "NO", thematic: true, source: "wrong-length" });
  return deterministicShuffle(candidates, 8171);
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

function candidatesByDistinctLength(pattern: CrosswordPattern11): CspCandidate[] {
  const analysis = analyzePattern11(pattern.rows);
  return Object.entries(analysis.lengthCounts).flatMap(([lengthKey, count], lengthIndex) => {
    const length = Number(lengthKey);
    const base = ALPHABET[(lengthIndex * 3) % ALPHABET.length] ?? "A";
    return Array.from({ length: count }, (_, index) => ({
      answer: `${base.repeat(Math.max(0, length - 2))}${String(index).padStart(2, "0")}`.slice(0, length),
      thematic: true,
      source: "incompatible-length-bank",
    }));
  });
}

function assertCompleteSolution(pattern: CrosswordPattern11, candidates: CspCandidate[]) {
  const result = solveWithRankedPatterns11({
    patterns: [pattern],
    candidates,
    seed: 123,
    deadlineMs: 10_000,
    maxNodesPerPattern: 800_000,
  });

  assert.equal(result.solved, true, JSON.stringify(result.attempts));
  assert.ok(result.solution);
  assert.equal(result.selectedPatternId, pattern.id);
  assert.equal(Object.keys(result.solution.assignments).length, result.solution.slots.length);
  assert.equal(new Set(result.solution.usedAnswers).size, result.solution.usedAnswers.length);
  assert.ok(result.solution.slots.every((slot) => slot.intersections.length >= 2));
  return result;
}

test("selects the best ranked resolvable pattern and returns a complete solution", () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const candidates = candidatesFromGrid(pattern, makeSolvedGrid(pattern, 101), 12);
  const result = solveWithRankedPatterns11({
    patterns: CROSSWORD_PATTERNS_11,
    candidates,
    seed: 3,
    deadlineMs: 10_000,
    maxNodesPerPattern: 800_000,
  });

  assert.equal(result.solved, true, JSON.stringify(result.attempts));
  assert.ok(result.solution);
  assert.deepEqual(result.requestedTopUpByLength, {});
});

test("skips patterns with missing lengths and reports deterministic top-up", () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const analysis = analyzePattern11(pattern.rows);
  const removedLength = Number(Object.keys(analysis.lengthCounts)[0]);
  const candidates = candidatesFromGrid(pattern, makeSolvedGrid(pattern, 102), 2).filter(
    (candidate) => candidate.answer.length !== removedLength
  );
  const result = solveWithRankedPatterns11({
    patterns: [pattern],
    candidates,
    seed: 4,
    maxNodesPerPattern: 10_000,
  });

  assert.equal(result.solved, false);
  assert.equal(result.attempts[0]?.failureReason, "missing-lengths");
  assert.ok((result.requestedTopUpByLength[removedLength] ?? 0) > 0);
  assert.equal(result.attempts[0]?.emptyDomainStage, "initial");
  assert.equal(result.attempts[0]?.emptySlotLength, removedLength);
});

test("detects empty domains after arc consistency despite sufficient length counts", () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const candidates = candidatesByDistinctLength(pattern);
  const analysis = analyzeCandidateDomains11(pattern, candidates);
  const result = solveWithRankedPatterns11({
    patterns: [pattern],
    candidates,
    seed: 5,
    maxNodesPerPattern: 10_000,
  });

  assert.deepEqual(analysis.missingByLength, {});
  assert.ok(analysis.emptySlots.length > 0);
  assert.equal(analysis.emptyDomainStage, "propagation");
  assert.equal(result.attempts[0]?.failureReason, "zero-intersection-compatibility");
  assert.equal(result.attempts[0]?.emptyDomainStage, "propagation");
  assert.ok(result.attempts[0]?.emptySlotId);
});

test("continues to the next pattern when the first one is unsatisfiable", () => {
  const first = CROSSWORD_PATTERNS_11[0];
  const second = CROSSWORD_PATTERNS_11[1];
  assert.ok(first);
  assert.ok(second);
  const unsat = candidatesByDistinctLength(first);
  const solvable = candidatesFromGrid(second, makeSolvedGrid(second, 103), 6);
  const result = solveWithRankedPatterns11({
    patterns: [first, second],
    candidates: [...unsat, ...solvable],
    seed: 6,
    deadlineMs: 10_000,
    maxNodesPerPattern: 800_000,
  });

  assert.equal(result.solved, true);
  assert.equal(result.selectedPatternId, second.id);
  assert.ok(result.attempts.some((attempt) => attempt.patternId === first.id && !attempt.solved));
});

test("noisy bank solves and requires real backtracking in at least one run", () => {
  const backtracks = CROSSWORD_PATTERNS_11.map((pattern, index) => {
    const result = assertCompleteSolution(pattern, candidatesFromGrid(pattern, makeSolvedGrid(pattern, 200 + index), 25));
    return result.solution?.stats.backtracks ?? 0;
  });

  assert.ok(backtracks.some((count) => count > 0), `Expected backtracking, got ${backtracks.join(", ")}`);
});

test("node limit and deadline are reported distinctly", () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const candidates = candidatesFromGrid(pattern, makeSolvedGrid(pattern, 301), 15);
  const nodeLimited = solveWithRankedPatterns11({
    patterns: [pattern],
    candidates,
    seed: 7,
    maxNodesPerPattern: 1,
    deadlineMs: 10_000,
  });
  const deadlineLimited = solveWithRankedPatterns11({
    patterns: [pattern],
    candidates,
    seed: 7,
    maxNodesPerPattern: 800_000,
    deadlineMs: 1,
  });

  assert.equal(nodeLimited.attempts[0]?.failureReason, "node-limit");
  assert.equal(deadlineLimited.attempts[0]?.failureReason, "deadline");
});

test("respects maxPatterns", () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const result = solveWithRankedPatterns11({
    patterns: CROSSWORD_PATTERNS_11,
    candidates: candidatesByDistinctLength(pattern),
    seed: 8,
    maxPatterns: 1,
    maxNodesPerPattern: 10_000,
  });

  assert.equal(result.attempts.length, 1);
});

test("is deterministic and does not mutate candidates or patterns", () => {
  const pattern = CROSSWORD_PATTERNS_11[0];
  assert.ok(pattern);
  const candidates = candidatesFromGrid(pattern, makeSolvedGrid(pattern, 401), 10);
  const candidatesBefore = JSON.stringify(candidates);
  const patternsBefore = JSON.stringify(CROSSWORD_PATTERNS_11);
  const first = solveWithRankedPatterns11({
    patterns: CROSSWORD_PATTERNS_11,
    candidates,
    seed: 9,
    deadlineMs: 10_000,
    maxNodesPerPattern: 800_000,
  });
  const second = solveWithRankedPatterns11({
    patterns: CROSSWORD_PATTERNS_11,
    candidates,
    seed: 9,
    deadlineMs: 10_000,
    maxNodesPerPattern: 800_000,
  });

  assert.equal(first.selectedPatternId, second.selectedPatternId);
  assert.deepEqual(first.solution?.assignments, second.solution?.assignments);
  assert.equal(JSON.stringify(candidates), candidatesBefore);
  assert.equal(JSON.stringify(CROSSWORD_PATTERNS_11), patternsBefore);
});
