import assert from "node:assert/strict";
import test from "node:test";

import type { Cell, DerivedEntry, WordCandidate } from "@/app/lib/crosswordTypes";
import { runLegacyBuilder, type LegacyBuilderDependencies } from "./index";

const slot = {
  row: 0,
  col: 0,
  direction: "across" as const,
  len: 5,
  cells: Array.from({ length: 5 }, (_, c) => ({ r: 0, c })),
};

function makeDependencies(calls: string[] = []): LegacyBuilderDependencies {
  return {
    alwaysAllowAnswers: new Set(),
    asciiAnswerPattern: /^[A-Z0-9]+$/,
    canPlaceWord: () => ({ ok: true, crossings: 1 }),
    checkedCellStats: () => ({ checked: 1, total: 1, ratio: 1 }),
    commonEnglishDictionaryWords: [],
    crosswordDensityFromGrid: () => 0.5,
    deriveEntriesFromGrid: (grid): DerivedEntry[] => {
      const answer = grid[0]?.slice(0, 5).join("") ?? "";
      return answer === "ALPHA"
        ? [
            {
              number: 1,
              row: 0,
              col: 0,
              direction: "across",
              answer,
            },
          ]
        : [];
    },
    desiredPublishEntriesForSize: () => 1,
    entryCrossingStats: () => ({ weakEntries: [], minCheckedCells: 1 }),
    extractPatternSlots: () => {
      calls.push("extractPatternSlots");
      return [slot];
    },
    fillerWords: [],
    frequencyEnglishDictionaryWords: [],
    frequencySpanishDictionaryWords: [],
    gridToStrings: (grid) => grid.map((row) => row.map((cell) => cell ?? "#")),
    hasShortLetterRuns: () => false,
    inBounds: (n, r, c) => r >= 0 && r < n && c >= 0 && c < n,
    isAcceptable: () => true,
    isForbiddenPublishAnswer: () => false,
    isLikelyBadAnswer: () => false,
    isOverGenericThemeWordForTheme: () => false,
    makeEmptyWorkingGrid: (n) => Array.from({ length: n }, () => Array.from({ length: n }, () => "" as Cell)),
    makeSeededRng: () => () => 0,
    minCoreThematicEntriesForPublish: () => 1,
    minCrossingsPerEntryForPublish: () => 0,
    minEntryLenForSize: () => 3,
    minPublishEntriesForSize: () => 1,
    paintBlocks: (grid) => grid.map((row) => row.map((cell) => cell ?? "#")),
    patterns11: [["....."]],
    placeWord: (grid, word, row, col, dir) => {
      const changes: Array<{ r: number; c: number; prev: Cell }> = [];
      for (let i = 0; i < word.length; i++) {
        const r = dir === "down" ? row + i : row;
        const c = dir === "across" ? col + i : col;
        changes.push({ r, c, prev: grid[r][c] });
        grid[r][c] = word[i];
      }
      return changes;
    },
    shuffleInPlace: () => undefined,
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

test("runLegacyBuilder delegates pattern mode to the injected pattern mechanics", () => {
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
  assert.deepEqual(calls, ["extractPatternSlots"]);
  assert.deepEqual(result?.usedAnswers, ["ALPHA"]);
  assert.equal(result?.meta.builder, "pattern-11x11");
});

test("runLegacyBuilder preserves strict mode fallback to preferred pattern", () => {
  const result = runLegacyBuilder({
    mode: "strict-11",
    theme: "Any theme",
    size: 11,
    candidates,
    seed: 123,
    dependencies: makeDependencies(),
  });

  assert.deepEqual(result?.usedAnswers, ["ALPHA"]);
  assert.equal(result?.meta.builder, "pattern-11x11");
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
