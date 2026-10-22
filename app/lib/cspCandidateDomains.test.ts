import assert from "node:assert/strict";
import test from "node:test";
import { CspCandidateIndex, CspDomainBudget, CspDomainDeadline } from "./cspCandidateDomains";
import { normalizeCspAnswer11 } from "./crosswordCspAdapter11";

const records = ["CATS", "CARS", "BARS", "BATS", "RATE", "RATS", "TAR", "BAR"]
  .map(answer => ({ answer, thematic: false, source: "synthetic" }));
const answers = (domain: Iterable<{ answer: string }>) => [...domain].map(candidate => candidate.answer);

test("stable IDs, length/position indexing, metadata, normalized duplicates and deterministic iteration", () => {
  const input = [...records, { answer: "cá-ts", thematic: true, source: "theme" }];
  const index = new CspCandidateIndex(input, normalizeCspAnswer11);
  const again = new CspCandidateIndex(input, normalizeCspAnswer11);
  assert.equal(index.size, records.length);
  assert.equal(index.id("CATS"), 0);
  assert.equal(index.candidate(0).source, "theme");
  assert.equal(index.candidate(0).thematic, true);
  assert.ok(Object.isFrozen(index.candidate(0)));
  assert.ok(Object.isFrozen(index.posting(4, 0, "B")));
  assert.deepEqual(index.posting(4, 0, "B"), [2, 3]);
  assert.deepEqual(answers(index.domain(3)), ["TAR", "BAR"]);
  assert.deepEqual(answers(index.domain(4)), answers(again.domain(4)));
  assert.deepEqual(answers(index.domain(4).matching(0, "B").matching(2, "T")), ["BATS"]);
  assert.equal(index.domain(4).matching(0, "Z").length, 0);
});

test("immutable reductions, membership, duplicate exclusion and MRV cardinality", () => {
  const index = new CspCandidateIndex(records, normalizeCspAnswer11);
  const original = index.domain(4);
  const reduced = original.matching(0, "C").exclude(new Set(["CATS"]));
  assert.equal(original.length, 6);
  assert.equal(reduced.length, 1);
  assert.equal(reduced.has(index.id("CARS")!), true);
  assert.equal(reduced.has(index.id("CATS")!), false);
  assert.deepEqual(answers(original.intersect(reduced)), ["CARS"]);
  assert.equal(index.domain(4).length, 6);
  assert.equal(original.letterCounts(0), original.letterCounts(0), "repeated support lookup uses cached counts");
  assert.deepEqual([original, reduced].sort((a, b) => a.length - b.length).map(d => d.length), [1, 6]);
});

test("indexed crossing propagation equals naive filtering, including chains, uniqueness and wipeouts", () => {
  const index = new CspCandidateIndex(records, normalizeCspAnswer11);
  for (const [p, q] of [[0, 0], [2, 0], [1, 1], [3, 2]]) {
    const a = index.domain(4), b = index.domain(3);
    const expected = answers(a).filter(answer => answers(b).some(other => other !== answer && answer[p] === other[q]));
    assert.deepEqual(answers(a.supportedBy(p, b, q)), expected);
  }
  const fixed = index.domain(4).matching(0, "C");
  const next = index.domain(3).supportedBy(0, fixed, 2);
  const final = index.domain(4).supportedBy(2, next, 0);
  const naiveNext = records.filter(c => c.answer.length === 3 && answers(fixed).some(a => a[2] === c.answer[0])).map(c => c.answer);
  assert.deepEqual(answers(next), naiveNext);
  assert.deepEqual(answers(final), records.filter(c => c.answer.length === 4 && naiveNext.some(a => a[0] === c.answer[2])).map(c => c.answer));
  assert.equal(index.domain(4).supportedBy(0, index.domain(3).matching(0, "Z"), 0).length, 0);
  const singleton = index.domain(4).matching(0, "C").matching(2, "T");
  assert.equal(singleton.supportedBy(0, singleton, 0).length, 0);
});

test("cancellation before and during an operation throws deadline, never an empty-domain result", () => {
  let cancelled = false;
  const budget = new CspDomainBudget(Infinity, () => cancelled);
  const index = new CspCandidateIndex(records, normalizeCspAnswer11, budget);
  cancelled = true;
  assert.throws(() => index.domain(4).matching(0, "C"), CspDomainDeadline);
  assert.throws(() => new CspCandidateIndex(records, normalizeCspAnswer11, budget), CspDomainDeadline);
});

test("50,000 candidate domain: indexed operations, propagation and prompt periodic cancellation", { timeout: 10000 }, () => {
  const input = Array.from({ length: 50000 }, (_, i) => ({ answer: `W${i.toString(36).toUpperCase().padStart(6, "0")}`, source: "generated" }));
  let evaluated = 0, cancelAfter = Infinity;
  const budget = new CspDomainBudget(Infinity, () => evaluated >= cancelAfter);
  const start = performance.now();
  const index = new CspCandidateIndex(input, normalizeCspAnswer11, budget);
  const indexedMs = performance.now() - start;
  const domain = index.domain(7);
  const lookupStart = performance.now();
  const filtered = domain.matching(6, "A").matching(5, "B");
  const lookupMs = performance.now() - lookupStart;
  assert.deepEqual(answers(filtered), input.filter(c => c.answer[6] === "A" && c.answer[5] === "B").map(c => c.answer));
  const propagationStart = performance.now();
  const propagated = domain.supportedBy(6, filtered, 5);
  const propagationMs = performance.now() - propagationStart;
  assert.deepEqual(answers(propagated), input.filter(c => c.answer[6] === "B").map(c => c.answer));
  cancelAfter = 500;
  const cancellationStart = performance.now();
  assert.throws(() => domain.filter(() => { evaluated++; return true; }), CspDomainDeadline);
  const cancellationMs = performance.now() - cancellationStart;
  assert.ok(evaluated >= 500 && evaluated <= 500 + CspDomainBudget.CHECK_INTERVAL);
  assert.ok(cancellationMs < 1000);
  console.log(JSON.stringify({ candidateCount: index.size, indexedMs, lookupMs, propagationMs,
    filteredCount: filtered.length, propagatedCount: propagated.length, cancellationMs, inspectedBeforeCancellation: evaluated }));
});

test("short real deadline interrupts expensive candidate work within a generous wall bound", { timeout: 5000 }, () => {
  let deadline = Infinity;
  const budget = new CspDomainBudget(Infinity, () => Date.now() > deadline);
  const input = Array.from({ length: 50000 }, (_, i) => ({ answer: `W${i.toString(36).toUpperCase().padStart(6, "0")}` }));
  const domain = new CspCandidateIndex(input, normalizeCspAnswer11, budget).domain(7);
  deadline = Date.now() + 1;
  let count = 0;
  const started = performance.now();
  assert.throws(() => domain.filter(candidate => {
    count++;
    let value = candidate.answer.length;
    for (let i = 0; i < 1000; i++) value = Math.imul(value, 31) + i;
    return value !== 0;
  }), CspDomainDeadline);
  const elapsedMs = performance.now() - started;
  assert.ok(count < input.length);
  assert.ok(elapsedMs < 1000);
  console.log(JSON.stringify({ requestedDeadlineMs: 1, elapsedMs, evaluated: count, status: "deadline" }));
});
