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
  hasAcceptableCrossingCoverage,
  keepLargestConnectedComponent,
  minEntryLenForSize,
  paintBlocks,
  pruneDanglingRuns,
  pruneWeakEntriesPreservingCrosses,
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

function crossingFixture(bridgeCount: number): string[][] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const grid = Array.from({ length: 11 }, (_, r) =>
    Array.from({ length: 11 }, (_, c) => r % 2 === 0 ? alphabet[(r * 11 + c) % 26] : "#")
  );
  const perGap = bridgeCount === 12 ? [3, 2, 3, 2, 2] : bridgeCount === 10 ? [2, 2, 2, 2, 2] :
    bridgeCount === 9 ? [2, 2, 2, 2, 1] : [1, 1, 1, 1, 2];
  perGap.forEach((count, gap) => {
    const columns = gap % 2 === 0 ? [0, 4, 8] : [2, 6, 10];
    columns.slice(0, count).forEach((col) => {
      grid[gap * 2 + 1][col] = alphabet[((gap * 2 + 1) * 11 + col) % 26];
    });
  });
  return grid;
}

test("11x11 validation enforces exact 80% coverage and rejects zero checks", () => {
  const grid = crossingFixture(12);
  const actual = deriveEntriesFromGrid(grid, 3);
  const across = actual.filter((entry) => entry.direction === "across");
  const down = actual.filter((entry) => entry.direction === "down");
  assert.equal(actual.length, 18);
  assert.equal(runGridValidation({ grid, derived: actual, policies }).accepted, true);

  const withSingles = (total: number, singles: number) => {
    const entries = [...across, ...down.slice(0, total - across.length)];
    for (let i = 0; i < singles; i++) {
      const entry = entries[i];
      const start = Array.from({ length: 9 }, (_, col) => col).find((col) => {
        const segment = { ...entry, col, answer: grid[entry.row].slice(col, col + 3).join("") };
        return entryCrossingStats(grid, [segment], 3).counts[0].checkedCells === 1;
      });
      assert.notEqual(start, undefined);
      entries[i] = { ...entry, col: start!, answer: grid[entry.row].slice(start!, start! + 3).join("") };
    }
    return entries;
  };

  for (const [total, strong, expected] of [
    [15, 12, true], [15, 11, false],
    [16, 13, true], [16, 12, false],
    [18, 15, true], [18, 14, false],
    [17, 14, true], [17, 13, false],
    [19, 16, true], [19, 15, false],
    [20, 16, true], [20, 15, false],
  ] as const) {
    // For 19/20, use repeated derived records only to isolate the percentage
    // boundary; the validator receives the final derived list as its contract.
    const entries = withSingles(Math.min(total, 18), total - strong);
    while (entries.length < total) entries.push({ ...down[entries.length % down.length] });
    const stats = entryCrossingStats(grid, entries, 3);
    assert.equal(stats.counts.filter((entry) => entry.checkedCells >= 2).length, strong);
    assert.equal(hasAcceptableCrossingCoverage(stats), expected);
    const result = runGridValidation({ grid, derived: entries, policies });
    assert.equal(result.accepted, expected, `${total} entries, ${strong} strong`);
    if (!expected) assert.equal(result.issue, "weak-crossings");
  }

  const zero = withSingles(18, 3);
  const zeroEntry = zero[0];
  const noCheck = Array.from({ length: 9 }, (_, col) => col).find((col) =>
    entryCrossingStats(grid, [{ ...zeroEntry, col, answer: grid[zeroEntry.row].slice(col, col + 3).join("") }], 3)
      .counts[0].checkedCells === 0
  );
  assert.notEqual(noCheck, undefined);
  zero[0] = { ...zeroEntry, col: noCheck!, answer: grid[zeroEntry.row].slice(noCheck!, noCheck! + 3).join("") };
  assert.equal(runGridValidation({ grid, derived: zero, policies }).issue, "weak-crossings");
});

test("repair completion retains a real derived grid with permitted single checks", () => {
  const grid = crossingFixture(9);
  const derived = deriveEntriesFromGrid(grid, 3);
  assert.equal(derived.length, 15);
  assert.equal(entryCrossingStats(grid, derived, 3).weakEntries.length, 1);
  assert.equal(runGridValidation({ grid, derived, policies }).accepted, true);
  assert.deepEqual(pruneWeakEntriesPreservingCrosses(grid, 3, 15), { grid, derived });
});

test("global checked ratio and unrelated structural gates still reject independently", () => {
  const lowChecked = crossingFixture(6);
  const entries = deriveEntriesFromGrid(lowChecked, 3);
  const padded = [...entries, ...entries.filter((entry) => entry.direction === "down").slice(0, 3)];
  assert.equal(hasAcceptableCrossingCoverage(entryCrossingStats(lowChecked, padded, 3)), true);
  assert.equal(runGridValidation({ grid: lowChecked, derived: padded, policies }).issue, "low-checked-ratio");
  assert.equal(runGridValidation({ grid: crossingFixture(9), derived: deriveEntriesFromGrid(crossingFixture(9), 3).slice(0, 14), policies }).issue, "too-few-entries");
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
