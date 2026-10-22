import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DEFAULT_CSP_PATTERN_11, solveCrosswordPattern11WithReport } from "./crosswordCsp11";

// Synthetic assignment/order snapshots from the unchanged array-domain solver at
// 08b4c23d7ae8df12abcfc2f6befb346a60ef9378. No real crossword pool is used.
for (const [offset, seed, expected] of [
  [0, 1, "785fbcadc3aa925d51d57ee76ce6b1eb9a7c20e1e3d9af708eaa2b3a0c60edf0"],
  [3, 123, "8de5f415827001125c5735702e7596eeff697fca34fd274f5f17b366e73ebb63"],
  [7, 911, "c949e478cc403343dada68111812aa0751ee9a5bec5b6a45344b464fc2d6241b"],
] as const) {
  test(`indexed solver preserves baseline synthetic assignment and search order: seed ${seed}`, () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const grid = Array.from({ length: 11 }, (_, r) => Array.from({ length: 11 }, (_, c) => alphabet[(r * 3 + c * 5 + offset) % 26]));
    const answers = [...grid.map(row => row.join("")), ...Array.from({ length: 11 }, (_, c) => grid.map(row => row[c]).join(""))];
    const candidates = answers.map((answer, i) => ({ answer, thematic: i % 3 === 0, source: "synthetic" }));
    const report = solveCrosswordPattern11WithReport({ pattern: DEFAULT_CSP_PATTERN_11, candidates, seed, maxNodes: 10000 });
    assert.ok(report.result);
    assert.equal(createHash("sha256").update(JSON.stringify(report.result.assignments)).digest("hex"), expected);
    assert.equal(report.stats.nodesVisited, 23);
    assert.equal(report.stats.backtracks, 0);
  });
}

test("solver cancellation during large preparation reports deadline, never contradiction", { timeout: 5000 }, () => {
  const candidates = Array.from({ length: 50000 }, (_, i) => ({ answer: `W${i.toString(36).toUpperCase().padStart(10, "0")}`, thematic: false }));
  let checks = 0;
  const started = performance.now();
  const report = solveCrosswordPattern11WithReport({
    pattern: DEFAULT_CSP_PATTERN_11, candidates,
    cancelled: () => ++checks >= 4,
  });
  assert.equal(report.result, null);
  assert.equal(report.failureReason, "deadline");
  assert.equal(report.stats.nodesVisited, 0);
  assert.ok(performance.now() - started < 1000);
});

test("cancellation inside a search node unwinds as deadline with partial counters", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const grid = Array.from({ length: 11 }, (_, r) => Array.from({ length: 11 }, (_, c) => alphabet[(r * 3 + c * 5) % 26]));
  const answers = [...grid.map(row => row.join("")), ...Array.from({ length: 11 }, (_, c) => grid.map(row => row[c]).join(""))];
  let checks = 0;
  const report = solveCrosswordPattern11WithReport({
    pattern: DEFAULT_CSP_PATTERN_11,
    candidates: answers.map(answer => ({ answer, thematic: false })),
    cancelled: () => ++checks >= 64,
  });
  assert.equal(report.result, null);
  assert.equal(report.failureReason, "deadline");
  assert.ok(report.stats.nodesVisited > 0, "cancellation must occur after search begins");
  assert.equal(report.searchProfile?.domainWipeouts, 0, "cancellation is not a contradiction");
});
