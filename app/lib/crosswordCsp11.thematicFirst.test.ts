import assert from "node:assert/strict";
import test from "node:test";
import { compareCspValuePriority, DEFAULT_CSP_PATTERN_11, prepareCandidateDomains, solveCrosswordPattern11WithReport, validatePattern11 } from "./crosswordCsp11";
import { CspCandidateIndex } from "./cspCandidateDomains";

const value = (answer: string, thematic: boolean, remainingOptions: number) => ({ candidate: { answer, thematic }, remainingOptions });

test("thematic values precede fill while existing support ordering remains within each class", () => {
  const values = [value("GENERAL1", false, 100), value("THEMATIC1", true, 1), value("THEMATIC2", true, 5), value("GENERAL2", false, 2)];
  values.sort((a, b) => compareCspValuePriority(a, b, 177466920));
  assert.deepEqual(values.map(item => item.candidate.answer), ["THEMATIC2", "THEMATIC1", "GENERAL1", "GENERAL2"]);
});

test("equal support uses the established deterministic seeded tie-break", () => {
  const a = value("ALPHA", true, 5);
  const b = value("BRAVO", true, 5);
  const first = [a, b].sort((left, right) => compareCspValuePriority(left, right, 123)).map(item => item.candidate.answer);
  const second = [b, a].sort((left, right) => compareCspValuePriority(left, right, 123)).map(item => item.candidate.answer);
  assert.deepEqual(first, second);
  assert.equal(compareCspValuePriority(a, b, 123), -compareCspValuePriority(b, a, 123));
});

test("ordering does not change domains or thematic provenance through indexing", () => {
  const slots = validatePattern11(DEFAULT_CSP_PATTERN_11).slots;
  const candidates = [
    { answer: "ABCDEFGHIJK", thematic: false, source: "fill" },
    { answer: "KJIHGFEDCBA", thematic: true, source: "theme" },
    { answer: "ZYXWVUTSRQP", thematic: false, source: "fill" },
  ];
  const prepared = prepareCandidateDomains(slots, candidates);
  const index = new CspCandidateIndex(candidates, answer => answer);
  assert.equal(prepared.domainsBySlotId.get("A1")?.length, 3);
  assert.equal(index.domain(11).length, 3);
  assert.equal(index.domain(11).matching(0, "K").map(item => item.source).join(), "theme");
  assert.equal(index.domain(11).exclude(new Set(["ABCDEFGHIJK"])).length, 2);
  assert.equal(index.candidate(index.id("KJIHGFEDCBA")!).thematic, true);
});

function gridCandidates() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const grid = Array.from({ length: 11 }, (_, row) => Array.from({ length: 11 }, (_, col) => alphabet[(row * 3 + col * 5) % 26]));
  return [...grid.map(row => row.join("")), ...Array.from({ length: 11 }, (_, col) => grid.map(row => row[col]).join(""))];
}

test("no-theme set fills deterministically with unchanged MRV, propagation and uniqueness", () => {
  const candidates = gridCandidates().map(answer => ({ answer, thematic: false }));
  const options = { pattern: DEFAULT_CSP_PATTERN_11, candidates, maxNodes: 10000, seed: 123 };
  const first = solveCrosswordPattern11WithReport(options);
  const second = solveCrosswordPattern11WithReport(options);
  assert.ok(first.result);
  assert.deepEqual(first.result.assignments, second.result?.assignments);
  assert.equal(first.stats.nodesVisited, second.stats.nodesVisited);
  assert.equal(first.stats.backtracks, second.stats.backtracks);
  assert.equal(new Set(Object.values(first.result.assignments)).size, first.result.slots.length);
  assert.equal(first.thematicEntryCount, 0);
});

test("contradictory thematic value backtracks to feasible general fill", () => {
  const answers = gridCandidates();
  const contradictory = `Z${answers[0].slice(1)}`;
  const report = solveCrosswordPattern11WithReport({
    pattern: DEFAULT_CSP_PATTERN_11,
    candidates: [{ answer: contradictory, thematic: true }, ...answers.map(answer => ({ answer, thematic: false }))],
    maxNodes: 10000, seed: 123,
  });
  assert.ok(report.result);
  assert.equal(Object.values(report.result.assignments).includes(contradictory), false);
  assert.equal(report.thematicEntryCount, 0);
  assert.ok(report.stats.backtracks > 0);
});

test("multiple contradictory thematic values are tried before feasible general fill", () => {
  const answers = gridCandidates();
  const first = `Z${answers[0].slice(1)}`;
  const second = `Y${answers[0].slice(1)}`;
  const report = solveCrosswordPattern11WithReport({
    pattern: DEFAULT_CSP_PATTERN_11,
    candidates: [
      { answer: first, thematic: true },
      { answer: second, thematic: true },
      ...answers.map(answer => ({ answer, thematic: false })),
    ],
    maxNodes: 10000, seed: 123,
  });
  assert.ok(report.result);
  assert.equal(report.thematicEntryCount, 0);
  assert.ok(report.stats.backtracks >= 2);
});

test("deadline and cancellation remain deadline, never a contradiction", () => {
  const answers = gridCandidates();
  let checks = 0;
  const report = solveCrosswordPattern11WithReport({ pattern: DEFAULT_CSP_PATTERN_11, candidates: answers.map(answer => ({ answer, thematic: true })), cancelled: () => ++checks >= 64 });
  assert.equal(report.result, null);
  assert.equal(report.failureReason, "deadline");
});
