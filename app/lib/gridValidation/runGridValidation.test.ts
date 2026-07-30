import test from "node:test";
import assert from "node:assert/strict";
import type { Cell } from "@/app/lib/crosswordTypes";
import { deriveEntriesFromGrid } from "@/app/lib/publishPipeline";
import {
  blockShortRunsOnly,
  checkedCellStats,
  crosswordDensityFromGrid,
  crossedEntryStats,
  enforceMinWordLen,
  entryCrossingStats,
  gridToStrings,
  hasShortLetterRuns,
  keepLargestConnectedComponent,
  minEntryLenForSize,
  paintBlocks,
  pruneDanglingRuns,
  runGridValidation,
  sanitizeUncheckedGrid,
  shortRunCellKeys,
} from "./index";

const policies = {
  isOverGenericThemeWord: (answer: string) => answer === "THING",
};

test("grid density and checked stats preserve current calculations", () => {
  const grid = [
    ["A", "B", "C"],
    ["D", "#", "E"],
    ["F", "G", "H"],
  ];

  assert.equal(crosswordDensityFromGrid(grid), 8 / 9);
  assert.deepEqual(checkedCellStats(grid, 3), { total: 8, checked: 4, ratio: 0.5 });
});

test("crossed entry stats and weak entry stats use existing crossing semantics", () => {
  const grid = [
    ["C", "A", "T", "#", "#"],
    ["A", "#", "O", "#", "#"],
    ["R", "#", "O", "#", "#"],
    ["#", "#", "L", "A", "B"],
    ["#", "#", "#", "#", "#"],
  ];
  const derived = deriveEntriesFromGrid(grid, 3);

  assert.deepEqual(crossedEntryStats(grid, derived, 3), { total: 4, crossed: 4, ratio: 1 });
  assert.deepEqual(entryCrossingStats(grid, derived, 3).counts, [
    { answer: "CAT", checkedCells: 2 },
    { answer: "LAB", checkedCells: 1 },
    { answer: "CAR", checkedCells: 1 },
    { answer: "TOOL", checkedCells: 2 },
  ]);
});

test("short-run detection and repair helpers preserve block behavior", () => {
  const grid = [
    ["A", "B", "#", "C"],
    ["#", "#", "#", "D"],
    ["E", "F", "G", "H"],
    ["#", "#", "#", "#"],
  ];

  assert.equal(hasShortLetterRuns(grid, 3), true);
  assert.deepEqual(Array.from(shortRunCellKeys(grid, 3)).sort(), ["0,0", "0,1"].sort());
  assert.deepEqual(blockShortRunsOnly(grid, 3), [
    ["#", "#", "#", "C"],
    ["#", "#", "#", "D"],
    ["E", "F", "G", "H"],
    ["#", "#", "#", "#"],
  ]);
});

test("paint, enforce min word length, dangling prune, and component pruning are deterministic", () => {
  const working: Cell[][] = [
    ["A", "", "", "#"],
    ["B", "", "", "#"],
    ["C", "", "", "#"],
    ["#", "", "", "Z"],
  ];

  const painted = paintBlocks(working);
  assert.deepEqual(painted, [
    ["A", "#", "#", "#"],
    ["B", "#", "#", "#"],
    ["C", "#", "#", "#"],
    ["#", "#", "#", "Z"],
  ]);

  assert.deepEqual(enforceMinWordLen(painted, 3), [
    ["A", "#", "#", "#"],
    ["B", "#", "#", "#"],
    ["C", "#", "#", "#"],
    ["#", "#", "#", "#"],
  ]);
  assert.deepEqual(pruneDanglingRuns(painted, 3), [
    ["A", "#", "#", "#"],
    ["B", "#", "#", "#"],
    ["C", "#", "#", "#"],
    ["#", "#", "#", "Z"],
  ]);
  assert.deepEqual(keepLargestConnectedComponent(painted), [
    ["A", "#", "#", "#"],
    ["B", "#", "#", "#"],
    ["C", "#", "#", "#"],
    ["#", "#", "#", "#"],
  ]);
});

test("sanitizeUncheckedGrid uppercases letters and keeps the largest repaired component", () => {
  const grid = [
    ["a", "#", "x"],
    ["b", "#", "y"],
    ["c", "#", "z"],
  ];

  assert.deepEqual(sanitizeUncheckedGrid(grid, 3), [
    ["A", "#", "#"],
    ["B", "#", "#"],
    ["C", "#", "#"],
  ]);
});

test("runGridValidation accepts a valid 11x11 grid and reports issue names for rejections", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const grid = Array.from({ length: 11 }, (_, r) =>
    Array.from({ length: 11 }, (_, c) => alphabet[(r * 11 + c) % alphabet.length])
  );
  const derived = deriveEntriesFromGrid(grid, minEntryLenForSize(11));
  const accepted = runGridValidation({
    grid,
    derived,
    themeSet: new Set(derived.map((entry) => entry.answer)),
    policies,
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.issue, null);

  const rejected = runGridValidation({
    grid: [["A"]],
    derived: [],
    policies,
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.issue, "invalid-size");
});

test("gridToStrings preserves current string normalization", () => {
  assert.deepEqual(
    gridToStrings([
      ["a", null],
      ["Z", "1"],
    ]),
    [
      ["A", "#"],
      ["Z", "1"],
    ]
  );
});
