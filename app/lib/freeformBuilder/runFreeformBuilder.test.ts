import test from "node:test";
import assert from "node:assert/strict";
import type { Cell, DerivedEntry, Direction, WordCandidate } from "@/app/lib/crosswordTypes";
import { inBounds } from "@/app/lib/crosswordUtils";
import {
  gridToStrings,
  hasShortLetterRuns,
  minEntryLenForSize,
  paintBlocks,
} from "@/app/lib/gridValidation";
import { runFreeformBuilder } from "./runFreeformBuilder";
import type { FreeformBuilderDependencies } from "./freeformBuilderTypes";

function makeEmptyWorkingGrid(n: number): Cell[][] {
  return Array.from({ length: n }, () => Array.from({ length: n }, () => "" as Cell));
}

function getCell(grid: Cell[][], r: number, c: number): Cell {
  return grid[r]?.[c] ?? "#";
}

function setCell(grid: Cell[][], r: number, c: number, v: Cell) {
  grid[r][c] = v;
}

function canPlaceWord(
  grid: Cell[][],
  word: string,
  row: number,
  col: number,
  dir: Direction
) {
  const n = grid.length;
  let crossings = 0;

  for (let i = 0; i < word.length; i++) {
    const r = dir === "across" ? row : row + i;
    const c = dir === "across" ? col + i : col;

    if (!inBounds(n, r, c)) {
      return { ok: false, crossings: 0, reason: "out_of_bounds" as const };
    }

    const cur = getCell(grid, r, c);
    const ch = word[i];

    if (cur === "#") {
      return { ok: false, crossings: 0, reason: "blocked_cell" as const };
    }

    if (cur !== "" && cur !== ch) {
      return { ok: false, crossings: 0, reason: "letter_conflict" as const };
    }

    if (cur === ch) {
      crossings++;
      continue;
    }

    if (dir === "across") {
      const up = inBounds(n, r - 1, c) ? getCell(grid, r - 1, c) : "#";
      const down = inBounds(n, r + 1, c) ? getCell(grid, r + 1, c) : "#";
      if (up !== "" && up !== "#") return { ok: false, crossings: 0, reason: "side_touch_up" as const };
      if (down !== "" && down !== "#") return { ok: false, crossings: 0, reason: "side_touch_down" as const };
    } else {
      const left = inBounds(n, r, c - 1) ? getCell(grid, r, c - 1) : "#";
      const right = inBounds(n, r, c + 1) ? getCell(grid, r, c + 1) : "#";
      if (left !== "" && left !== "#") return { ok: false, crossings: 0, reason: "side_touch_left" as const };
      if (right !== "" && right !== "#") return { ok: false, crossings: 0, reason: "side_touch_right" as const };
    }
  }

  const beforeR = dir === "across" ? row : row - 1;
  const beforeC = dir === "across" ? col - 1 : col;
  const afterR = dir === "across" ? row : row + word.length;
  const afterC = dir === "across" ? col + word.length : col;

  if (inBounds(n, beforeR, beforeC)) {
    const b = getCell(grid, beforeR, beforeC);
    if (b !== "" && b !== "#") return { ok: false, crossings: 0, reason: "before_cell_occupied" as const };
  }

  if (inBounds(n, afterR, afterC)) {
    const a = getCell(grid, afterR, afterC);
    if (a !== "" && a !== "#") return { ok: false, crossings: 0, reason: "after_cell_occupied" as const };
  }

  return { ok: true, crossings };
}

function placeWord(
  grid: Cell[][],
  word: string,
  row: number,
  col: number,
  dir: Direction
): Array<{ r: number; c: number; prev: Cell }> | null {
  const n = grid.length;
  const changes: Array<{ r: number; c: number; prev: Cell }> = [];
  const pre = canPlaceWord(grid, word, row, col, dir);
  if (!pre.ok) return null;

  for (let i = 0; i < word.length; i++) {
    const r = dir === "across" ? row : row + i;
    const c = dir === "across" ? col + i : col;
    if (!inBounds(n, r, c)) return null;

    const prev = getCell(grid, r, c);
    if (prev === "#") return null;

    const ch = word[i];
    if (prev !== "" && prev !== ch) return null;

    if (prev !== ch) {
      changes.push({ r, c, prev });
      setCell(grid, r, c, ch);
    }
  }

  const painted = gridToStrings(paintBlocks(grid) as (string | null)[][]);
  if (hasShortLetterRuns(painted, minEntryLenForSize(n))) {
    for (let i = changes.length - 1; i >= 0; i--) {
      const change = changes[i];
      setCell(grid, change.r, change.c, change.prev);
    }
    return null;
  }

  return changes;
}

function deriveEntriesFromGrid(grid: string[][], minLen = 3): DerivedEntry[] {
  const out: DerivedEntry[] = [];
  let number = 1;
  const entryNumber = new Map<string, number>();

  const getNumber = (r: number, c: number) => {
    const key = `${r},${c}`;
    const existing = entryNumber.get(key);
    if (existing) return existing;
    entryNumber.set(key, number);
    return number++;
  };

  for (let r = 0; r < grid.length; r++) {
    let c = 0;
    while (c < grid.length) {
      while (c < grid.length && grid[r][c] === "#") c++;
      const start = c;
      while (c < grid.length && grid[r][c] !== "#") c++;
      if (c - start >= minLen) {
        out.push({
          number: getNumber(r, start),
          row: r,
          col: start,
          direction: "across",
          answer: grid[r].slice(start, c).join(""),
        });
      }
    }
  }

  for (let c = 0; c < grid.length; c++) {
    let r = 0;
    while (r < grid.length) {
      while (r < grid.length && grid[r][c] === "#") r++;
      const start = r;
      while (r < grid.length && grid[r][c] !== "#") r++;
      if (r - start >= minLen) {
        out.push({
          number: getNumber(start, c),
          row: start,
          col: c,
          direction: "down",
          answer: Array.from({ length: r - start }, (_, i) => grid[start + i][c]).join(""),
        });
      }
    }
  }

  return out;
}

const baseDependencies: FreeformBuilderDependencies = {
  canPlaceWord,
  deriveEntriesFromGrid,
  makeEmptyWorkingGrid,
  placeWord,
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

test("runFreeformBuilder uses injected dependencies", () => {
  let makeGridCalls = 0;
  let canPlaceCalls = 0;
  const result = withMutedWarnings(() => runFreeformBuilder({
    size: 11,
    candidates,
    seed: 11,
    maxBuilds: 1,
    dependencies: {
      ...baseDependencies,
      makeEmptyWorkingGrid: (n) => {
        makeGridCalls++;
        return makeEmptyWorkingGrid(n);
      },
      canPlaceWord: (...args) => {
        canPlaceCalls++;
        return canPlaceWord(...args);
      },
    },
  }));

  assert.equal(result, null);
  assert.ok(makeGridCalls > 0);
  assert.ok(canPlaceCalls > 0);
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
