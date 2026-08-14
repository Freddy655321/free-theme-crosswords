import assert from "node:assert/strict";
import test from "node:test";

import type { WordCandidate } from "@/app/lib/crosswordTypes";
import { runLegacyBuilder, type LegacyBuilderDependencies } from "./index";

function makeDependencies(calls: string[] = []): LegacyBuilderDependencies {
  return {
    alwaysAllowAnswers: new Set(),
    commonEnglishDictionaryWords: [],
    fillerWords: [],
    frequencyEnglishDictionaryWords: [],
    frequencySpanishDictionaryWords: [],
    isAcceptable: () => {
      calls.push("isAcceptable");
      return true;
    },
    isForbiddenPublishAnswer: () => false,
    isLikelyBadAnswer: () => false,
    isOverGenericThemeWordForTheme: () => false,
    patterns11: [
      [
        ".....######",
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
      ],
    ],
    spanishFillerWords: [],
    weakContextDictionaryWords: new Set(),
  };
}

const candidates: WordCandidate[] = [
  { answer: "ALPHA", thematic: true, source: "model" },
  { answer: "OMEGA", thematic: true, source: "model" },
];

test("runLegacyBuilder returns null for non-11 sizes without touching dependencies", () => {
  const calls: string[] = [];
  const result = runLegacyBuilder({
    mode: "pattern-11",
    theme: "Any theme",
    size: 9,
    candidates,
    seed: 123,
    dependencies: makeDependencies(calls),
  });

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test("runLegacyBuilder returns null for pattern mode below real publish thresholds", () => {
  const calls: string[] = [];
  const original = candidates.map((candidate) => ({ ...candidate }));
  const result = runLegacyBuilder({
    mode: "pattern-11",
    theme: "Any theme",
    size: 11,
    candidates,
    seed: 123,
    dependencies: makeDependencies(calls),
  });

  assert.deepEqual(candidates, original);
  assert.equal(result, null);
});

test("runLegacyBuilder preserves strict mode null behavior below real publish thresholds", () => {
  const result = runLegacyBuilder({
    mode: "strict-11",
    theme: "Any theme",
    size: 11,
    candidates,
    seed: 123,
    dependencies: makeDependencies(),
  });

  assert.equal(result, null);
});

test("runLegacyBuilder returns null when compact mode has no usable mask", () => {
  const result = runLegacyBuilder({
    mode: "compact-pattern-11",
    theme: "Any theme",
    size: 11,
    candidates,
    seed: 123,
    dependencies: makeDependencies(),
  });

  assert.equal(result, null);
});

test("runLegacyBuilder returns null when greedy mode has insufficient candidates", () => {
  const result = runLegacyBuilder({
    mode: "greedy-checked-11",
    theme: "Any theme",
    size: 11,
    candidates: [],
    seed: 123,
    dependencies: makeDependencies(),
  });

  assert.equal(result, null);
});
