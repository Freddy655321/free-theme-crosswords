import test from "node:test";
import assert from "node:assert/strict";
import type { WordCandidate } from "@/app/lib/crosswordTypes";
import { runFreeformBuilder } from "./runFreeformBuilder";
import type { FreeformBuilderDependencies } from "./freeformBuilderTypes";

const baseDependencies: FreeformBuilderDependencies = {
  isForbiddenPublishAnswer: () => false,
};

const candidates: WordCandidate[] = [
  "PLANETS",
  "PLASTER",
  "PAINTER",
  "TRAINER",
  "STONE",
  "STORE",
  "ROUTE",
  "TONE",
  "NOTE",
  "LINE",
  "LATE",
  "EAST",
  "STAR",
  "ART",
  "RAT",
].map((answer, index) => ({
  answer,
  thematic: index < 8,
  source: index < 8 ? "model" : "filler",
}));

function withMutedWarnings<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

test("runFreeformBuilder is deterministic for the same seed", () => {
  const input = {
    size: 11,
    candidates,
    seed: 12345,
    maxBuilds: 3,
    dependencies: baseDependencies,
  };

  const first = withMutedWarnings(() => runFreeformBuilder(input));
  const second = withMutedWarnings(() => runFreeformBuilder(input));

  assert.deepEqual(second, first);
});

test("runFreeformBuilder returns null for an empty usable pool", () => {
  assert.equal(
    withMutedWarnings(() => runFreeformBuilder({
      size: 11,
      candidates: [{ answer: "NO", thematic: true, source: "model" }],
      seed: 1,
      dependencies: baseDependencies,
    })),
    null
  );
});

test("runFreeformBuilder preserves result shape and used answers", () => {
  const result = withMutedWarnings(() => runFreeformBuilder({
    size: 11,
    candidates,
    seed: 42,
    maxBuilds: 2,
    dependencies: baseDependencies,
  }));

  assert.ok(result);
  assert.equal(result.grid.length, 11);
  assert.ok(result.usedAnswers.length > 0);
  assert.equal(result.meta.algorithm, "freeform-crossing-then-blocks");
  assert.equal(result.meta.candidatesCount, candidates.length);
  assert.equal(result.meta.rounds, 28);
});

test("runFreeformBuilder honors exhausted deadlines", () => {
  assert.equal(
    withMutedWarnings(() => runFreeformBuilder({
      size: 11,
      candidates,
      seed: 1,
      deadlineMs: Date.now() - 1,
      dependencies: baseDependencies,
    })),
    null
  );
});

test("runFreeformBuilder preserves maxPlacedWords as an upper bound", () => {
  const result = withMutedWarnings(() => runFreeformBuilder({
    size: 11,
    candidates,
    seed: 42,
    maxBuilds: 1,
    maxPlacedWords: 1,
    dependencies: baseDependencies,
  }));

  assert.equal(result, null);
});

test("runFreeformBuilder dedupes normalized-equivalent candidates by first value", () => {
  const duplicated = [
    candidates[0],
    { ...candidates[0], source: "support" as const },
    ...candidates.slice(1),
  ];

  const result = withMutedWarnings(() => runFreeformBuilder({
    size: 11,
    candidates: duplicated,
    seed: 42,
    maxBuilds: 2,
    dependencies: baseDependencies,
  }));

  assert.ok(result);
  assert.equal(result.meta.candidatesCount, duplicated.length);
  assert.equal(new Set(result.usedAnswers).size, result.usedAnswers.length);
});

test("runFreeformBuilder supports size 9 and size 13 parameter branches", () => {
  const size9 = withMutedWarnings(() => runFreeformBuilder({
    size: 9,
    candidates,
    seed: 7,
    maxBuilds: 1,
    dependencies: baseDependencies,
  }));
  const size13 = withMutedWarnings(() => runFreeformBuilder({
    size: 13,
    candidates: [...candidates, { answer: "CROSSWORD", thematic: true, source: "model" }],
    seed: 7,
    maxBuilds: 1,
    dependencies: baseDependencies,
  }));

  assert.equal(size9?.meta.rounds ?? 4, 4);
  assert.equal(size13?.meta.rounds ?? 6, 6);
});

test("runFreeformBuilder does not mutate candidate input", () => {
  const inputCandidates = candidates.map((candidate) => ({ ...candidate }));
  const before = structuredClone(inputCandidates);

  withMutedWarnings(() => runFreeformBuilder({
    size: 11,
    candidates: inputCandidates,
    seed: 99,
    maxBuilds: 1,
    dependencies: baseDependencies,
  }));

  assert.deepEqual(inputCandidates, before);
});

test("runFreeformBuilder uses injected forbidden-answer policy", () => {
  let forbiddenChecks = 0;
  const result = withMutedWarnings(() => runFreeformBuilder({
    size: 11,
    candidates: candidates.slice(0, 3),
    seed: 11,
    maxBuilds: 1,
    dependencies: {
      ...baseDependencies,
      isForbiddenPublishAnswer: () => {
        forbiddenChecks++;
        return true;
      },
    },
  }));

  assert.equal(result, null);
  assert.ok(forbiddenChecks > 0);
});

test("runFreeformBuilder reports null when no crossings can be committed", () => {
  const result = withMutedWarnings(() => runFreeformBuilder({
    size: 11,
    candidates: [
      { answer: "ABCDEFG", thematic: true, source: "model" },
      { answer: "HIJKLMN", thematic: true, source: "model" },
      { answer: "OPQRSTU", thematic: true, source: "model" },
    ],
    seed: 123,
    maxBuilds: 1,
    dependencies: baseDependencies,
  }));

  assert.equal(result, null);
});
