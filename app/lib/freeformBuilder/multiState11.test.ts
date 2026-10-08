import assert from "node:assert/strict";
import test from "node:test";
import { canPlaceWord, makeEmptyWorkingGrid, placeWordWithPolicies } from "../gridConstruction";
import type { FreeformBuilderInput } from "./freeformBuilderTypes";
import { expandGridState, MULTI_STATE_LIMITS, retainGridStates, runMultiState11 } from "./multiState11";

const input: FreeformBuilderInput = {
  size: 11, seed: 123, maxPlacedWords: 42,
  candidates: ["PLANETS", "PLASTER", "PAINTER", "TRAINER", "STONE", "STORE", "ROUTE", "TONE", "NOTE", "LINE", "LATE", "EAST", "STAR", "ART", "RAT"].map(answer => ({ answer, thematic: true, source: "model" })),
  dependencies: { isForbiddenPublishAnswer: () => false },
};

test("independent grid branches survive and evolve across successive layers", () => {
  const first = runMultiState11(input, { width: 8, depth: 1, expansions: 40 });
  assert.ok(first.frontier.length > 1);
  const saved = JSON.stringify(first.frontier.map(s => ({ grid: s.grid, placements: s.placements, used: [...s.used] })));
  const children = first.frontier.flatMap(s => expandGridState(s, input, input.candidates.map(c => c.answer)));
  const next = retainGridStates(children, 8);
  assert.ok(next.length > 1);
  assert.ok(new Set(children.map(s => s.parent)).size > 1);
  assert.ok(new Set(next.map(s => s.parent)).size > 1);
  assert.ok(next.every(s => s.placements.length === 3));
  assert.equal(JSON.stringify(first.frontier.map(s => ({ grid: s.grid, placements: s.placements, used: [...s.used] }))), saved);
  assert.notEqual(next[0].grid, next[1].grid);
  for (const state of next) {
    const grid = makeEmptyWorkingGrid(11);
    for (const p of state.placements) {
      assert.equal(canPlaceWord(grid, p.word, p.row, p.col, p.dir).ok, true);
      assert.ok(placeWordWithPolicies(grid, p.word, p.row, p.col, p.dir, input.dependencies));
    }
    assert.deepEqual(grid, state.grid);
  }
});

test("frontier, work, depth and deadline are bounded and repeatable", () => {
  const options = { width: 4, depth: 3, expansions: 9 };
  const a = runMultiState11(input, options), b = runMultiState11(input, options);
  assert.deepEqual(a, b);
  assert.ok(a.frontier.length <= 4);
  assert.ok(a.expansions <= 9);
  assert.ok(a.layers <= 3);
  assert.ok(a.frontier.every(s => s.placements.length <= 4));
  assert.equal(runMultiState11({ ...input, deadlineMs: 0 }).expansions, 0);
  assert.ok(MULTI_STATE_LIMITS.placementChecks > 0);
});

test("forbidden and malformed answers cannot be placed; metadata does not privilege vocabulary", () => {
  const forbidden = new Set(["PLANETS", "STONE"]);
  const changed = { ...input, candidates: [...input.candidates, { answer: "!bad", thematic: true, source: "model" as const }], dependencies: { isForbiddenPublishAnswer: (a: string) => forbidden.has(a) } };
  const output = runMultiState11(changed, { width: 8, expansions: 16, depth: 2 });
  for (const state of output.frontier) for (const word of state.used) assert.ok(!forbidden.has(word) && /^[A-Z0-9]+$/.test(word));
  const renamedMetadata = { ...input, candidates: input.candidates.map(c => ({ ...c, source: "support" as const })) };
  assert.deepEqual(runMultiState11(input, { depth: 2, expansions: 16 }), runMultiState11(renamedMetadata, { depth: 2, expansions: 16 }));
});

test("consistent alphabet substitution preserves search structure", () => {
  const substitute = (s: string) => s.replace(/[A-Z]/g, c => String.fromCharCode(155 - c.charCodeAt(0)));
  const options = { depth: 3, expansions: 16, width: 8 };
  const original = runMultiState11(input, options);
  const transformed = runMultiState11({ ...input, candidates: input.candidates.map(c => ({ ...c, answer: substitute(c.answer) })) }, options);
  assert.equal(original.expansions, transformed.expansions);
  assert.deepEqual(original.result?.grid.map(row => row.map(substitute)), transformed.result?.grid);
});
