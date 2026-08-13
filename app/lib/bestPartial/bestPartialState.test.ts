import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DerivedEntry, WordCandidate } from "@/app/lib/crosswordTypes";
import {
  createBestPartialCandidate,
  selectBetterBestPartial,
  shouldReplaceBestPartial,
  shouldRejectBestPartialForStrict11,
} from "./bestPartialState";
import type { BestPartial, BestPartialBuilt } from "./bestPartialTypes";

function built(): BestPartialBuilt {
  return {
    grid: [["A"]],
    usedAnswers: ["ALPHA"],
    meta: { builder: "synthetic" },
  };
}

function derived(count: number): DerivedEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    row: index,
    col: 0,
    direction: "across",
    answer: `ANSWER${index}`,
  }));
}

function pool(): WordCandidate[] {
  return [
    { answer: "ALPHA", thematic: true, source: "model" },
    { answer: "BRAVO", thematic: false, source: "support" },
  ];
}

function candidate(opts: {
  count?: number;
  score?: number;
  thematicKeepSet?: Set<string>;
  builtRef?: BestPartialBuilt;
  derivedRef?: DerivedEntry[];
  poolRef?: WordCandidate[];
  notesRef?: Map<string, string>;
  attempt?: number;
} = {}): BestPartial {
  const builtRef = opts.builtRef ?? built();
  const derivedRef = opts.derivedRef ?? derived(opts.count ?? 4);
  const poolRef = opts.poolRef ?? pool();
  const notesRef = opts.notesRef ?? new Map([["ALPHA", "note"]]);
  const created = createBestPartialCandidate({
    built: builtRef,
    derived: derivedRef,
    pool: poolRef,
    notesByAnswer: notesRef,
    thematicKeepSet: opts.thematicKeepSet ?? new Set(["ALPHA"]),
    attempt: opts.attempt ?? 1,
    fallbackScore: opts.score ?? 10,
  });
  assert.ok(created);
  return created;
}

describe("bestPartialState", () => {
  it("returns null for empty derived candidates", () => {
    assert.equal(
      createBestPartialCandidate({
        built: built(),
        derived: [],
        pool: pool(),
        notesByAnswer: new Map(),
        thematicKeepSet: new Set(),
        attempt: 1,
        fallbackScore: 0,
      }),
      null
    );
  });

  it("stores the first valid candidate when current is null", () => {
    const next = candidate({ count: 3, score: 10 });

    assert.equal(shouldReplaceBestPartial(null, next, 6), true);
    assert.equal(selectBetterBestPartial(null, next, 6), next);
  });

  it("replaces better candidates on the same side of the threshold", () => {
    const currentBelow = candidate({ count: 3, score: 10 });
    const betterBelow = candidate({ count: 4, score: 11 });
    const worseBelow = candidate({ count: 4, score: 9 });
    const currentAbove = candidate({ count: 6, score: 10 });
    const betterAbove = candidate({ count: 7, score: 11 });

    assert.equal(selectBetterBestPartial(currentBelow, betterBelow, 6), betterBelow);
    assert.equal(selectBetterBestPartial(currentBelow, worseBelow, 6), currentBelow);
    assert.equal(selectBetterBestPartial(currentAbove, betterAbove, 6), betterAbove);
  });

  it("does not replace ties", () => {
    const currentBelow = candidate({ count: 3, score: 10 });
    const tiedBelow = candidate({ count: 4, score: 10 });
    const currentAbove = candidate({ count: 6, score: 10 });
    const tiedAbove = candidate({ count: 7, score: 10 });

    assert.equal(shouldReplaceBestPartial(currentBelow, tiedBelow, 6), false);
    assert.equal(selectBetterBestPartial(currentBelow, tiedBelow, 6), currentBelow);
    assert.equal(shouldReplaceBestPartial(currentAbove, tiedAbove, 6), false);
    assert.equal(selectBetterBestPartial(currentAbove, tiedAbove, 6), currentAbove);
  });

  it("replaces threshold-crossing candidates but not reverse-threshold candidates", () => {
    const below = candidate({ count: 5, score: 100 });
    const aboveLowerScore = candidate({ count: 6, score: 1 });
    const above = candidate({ count: 6, score: 10 });
    const belowHigherScore = candidate({ count: 5, score: 1000 });

    assert.equal(selectBetterBestPartial(below, aboveLowerScore, 6), aboveLowerScore);
    assert.equal(selectBetterBestPartial(above, belowHigherScore, 6), above);
  });

  it("uses minPublishEntries as the only threshold input", () => {
    const current = candidate({ count: 4, score: 50 });
    const next = candidate({ count: 5, score: 1 });

    assert.equal(selectBetterBestPartial(current, next, 5), next);
    assert.equal(selectBetterBestPartial(current, next, 6), current);
  });

  it("preserves current aliasing and snapshots only trustedThematicSet", () => {
    const builtRef = built();
    const derivedRef = derived(4);
    const poolRef = pool();
    const notesRef = new Map([["ALPHA", "note"]]);
    const thematicKeepSet = new Set(["ALPHA"]);
    const created = createBestPartialCandidate({
      built: builtRef,
      derived: derivedRef,
      pool: poolRef,
      notesByAnswer: notesRef,
      thematicKeepSet,
      attempt: 3,
      fallbackScore: 77,
    });

    assert.ok(created);
    assert.equal(created.built, builtRef);
    assert.equal(created.derived, derivedRef);
    assert.equal(created.pool, poolRef);
    assert.equal(created.notesByAnswer, notesRef);
    assert.equal(created.attempt, 3);
    assert.equal(created.fallbackScore, 77);
    assert.notEqual(created.trustedThematicSet, thematicKeepSet);
    assert.deepEqual(Array.from(created.trustedThematicSet), ["ALPHA"]);

    thematicKeepSet.add("BRAVO");
    poolRef.push({ answer: "CHARLIE", thematic: true, source: "model" });
    builtRef.meta.changed = true;
    derivedRef.push({
      number: 5,
      row: 5,
      col: 0,
      direction: "down",
      answer: "DELTA",
    });
    notesRef.set("BRAVO", "note 2");

    assert.deepEqual(Array.from(created.trustedThematicSet), ["ALPHA"]);
    assert.equal(created.pool.length, 3);
    assert.equal(created.built.meta.changed, true);
    assert.equal(created.derived.length, 5);
    assert.equal(created.notesByAnswer.get("BRAVO"), "note 2");
  });

  it("has no runtime dependency on builders, policies, publish, or thematic logic", () => {
    const created = candidate();

    assert.equal(Object.keys(created).includes("builder"), false);
    assert.equal(Object.keys(created).includes("publish"), false);
    assert.equal(Object.keys(created).includes("theme"), false);
  });

  it("preserves the strict 11 best-partial rejection gate", () => {
    assert.equal(shouldRejectBestPartialForStrict11(11), true);
    assert.equal(shouldRejectBestPartialForStrict11(9), false);
    assert.equal(shouldRejectBestPartialForStrict11(13), false);
  });
});
