import type { Entry } from "@/app/lib/crosswordTypes";
import { inBounds, isBlock } from "@/app/lib/crosswordUtils";
import type {
  CheckedCellStats,
  CrossedEntryStats,
  EntryCrossingStats,
  GridValidationInput,
  GridValidationResult,
} from "./gridValidationTypes";

export function crosswordDensityFromGrid(grid: string[][]): number {
  const n = grid.length;
  let letters = 0;
  const total = n * n;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!isBlock(grid[r][c])) letters++;
    }
  }
  return total > 0 ? letters / total : 0;
}

export function checkedCellStats(grid: string[][], minLen: number): CheckedCellStats {
  const n = grid.length;

  const runLenAcrossAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c)) return 0;
    if (isBlock(grid[r][c])) return 0;

    let start = c;
    while (start - 1 >= 0 && !isBlock(grid[r][start - 1])) start--;

    let end = c;
    while (end + 1 < n && !isBlock(grid[r][end + 1])) end++;

    return end - start + 1;
  };

  const runLenDownAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c)) return 0;
    if (isBlock(grid[r][c])) return 0;

    let start = r;
    while (start - 1 >= 0 && !isBlock(grid[start - 1][c])) start--;

    let end = r;
    while (end + 1 < n && !isBlock(grid[end + 1][c])) end++;

    return end - start + 1;
  };

  let total = 0;
  let checked = 0;

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (isBlock(grid[r][c])) continue;
      total++;

      const acrossLen = runLenAcrossAt(r, c);
      const downLen = runLenDownAt(r, c);
      if (acrossLen >= minLen && downLen >= minLen) checked++;
    }
  }

  return {
    total,
    checked,
    ratio: total > 0 ? checked / total : 0,
  };
}

export function crossedEntryStats(
  grid: string[][],
  entries: Omit<Entry, "clue">[],
  minLen: number
): CrossedEntryStats {
  const n = grid.length;

  const runLenAcrossAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c) || isBlock(grid[r][c])) return 0;
    let start = c;
    while (start - 1 >= 0 && !isBlock(grid[r][start - 1])) start--;
    let end = c;
    while (end + 1 < n && !isBlock(grid[r][end + 1])) end++;
    return end - start + 1;
  };

  const runLenDownAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c) || isBlock(grid[r][c])) return 0;
    let start = r;
    while (start - 1 >= 0 && !isBlock(grid[start - 1][c])) start--;
    let end = r;
    while (end + 1 < n && !isBlock(grid[end + 1][c])) end++;
    return end - start + 1;
  };

  const crossed = entries.filter((entry) => {
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      if (runLenAcrossAt(r, c) >= minLen && runLenDownAt(r, c) >= minLen) return true;
    }
    return false;
  }).length;

  return {
    total: entries.length,
    crossed,
    ratio: entries.length > 0 ? crossed / entries.length : 0,
  };
}

export function entryCrossingStats(
  grid: string[][],
  entries: Omit<Entry, "clue">[],
  minLen: number
): EntryCrossingStats {
  const n = grid.length;

  const runLenAcrossAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c) || isBlock(grid[r][c])) return 0;
    let start = c;
    while (start - 1 >= 0 && !isBlock(grid[r][start - 1])) start--;
    let end = c;
    while (end + 1 < n && !isBlock(grid[r][end + 1])) end++;
    return end - start + 1;
  };

  const runLenDownAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c) || isBlock(grid[r][c])) return 0;
    let start = r;
    while (start - 1 >= 0 && !isBlock(grid[start - 1][c])) start--;
    let end = r;
    while (end + 1 < n && !isBlock(grid[end + 1][c])) end++;
    return end - start + 1;
  };

  const counts = entries.map((entry) => {
    let checkedCells = 0;
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      if (runLenAcrossAt(r, c) >= minLen && runLenDownAt(r, c) >= minLen) checkedCells++;
    }
    return {
      answer: entry.answer,
      checkedCells,
    };
  });

  return {
    minCheckedCells: counts.length > 0 ? Math.min(...counts.map((entry) => entry.checkedCells)) : 0,
    weakEntries: counts.filter((entry) => entry.checkedCells < minCrossingsPerEntryForPublish(n)),
    counts,
  };
}

export function minCrossingsPerEntryForPublish(size: number): number {
  if (size <= 11) return 2;
  return 2;
}

export function minEntriesForSize(size: number): number {
  if (size <= 9) return 10;
  if (size <= 11) return 15;
  return 20;
}

export function minPublishEntriesForSize(size: number): number {
  if (size <= 9) return 10;
  if (size <= 11) return 15;
  return 18;
}

export function desiredPublishEntriesForSize(size: number): number {
  if (size <= 9) return 12;
  if (size <= 11) return 16;
  return 22;
}

export function minCrossedEntriesForPublish(size: number): number {
  return minPublishEntriesForSize(size);
}

export function minThematicEntriesForPublish(size: number, entryCount: number): number {
  if (size <= 9) return 7;
  if (size <= 11) return Math.max(8, entryCount - maxGenericContextEntriesForPublish(size, entryCount));
  return 12;
}

export function minCoreThematicEntriesForPublish(size: number, entryCount: number): number {
  if (size <= 9) return 6;
  if (size <= 11) {
    if (entryCount > 20) return Math.max(10, Math.ceil(entryCount * 0.4));
    return 8;
  }
  return 10;
}

export function maxGenericContextEntriesForPublish(size: number, entryCount: number): number {
  if (size <= 9) return 4;
  if (size <= 11) {
    if (entryCount > 20) return Math.max(5, entryCount - minCoreThematicEntriesForPublish(size, entryCount));
    return Math.min(7, Math.max(2, Math.floor(entryCount / 2)));
  }
  return 8;
}

export function minEntryLenForSize(size: number): number {
  if (size <= 11) return 3;
  return 4;
}

export function hasShortLetterRuns(grid: string[][], minLen: number): boolean {
  const n = grid.length;

  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      while (c < n && isBlock(grid[r]?.[c] ?? "#")) c++;
      const start = c;
      while (c < n && !isBlock(grid[r]?.[c] ?? "#")) c++;
      const len = c - start;
      if (len > 1 && len < minLen) return true;
    }
  }

  for (let c = 0; c < n; c++) {
    let r = 0;
    while (r < n) {
      while (r < n && isBlock(grid[r]?.[c] ?? "#")) r++;
      const start = r;
      while (r < n && !isBlock(grid[r]?.[c] ?? "#")) r++;
      const len = r - start;
      if (len > 1 && len < minLen) return true;
    }
  }

  return false;
}

export function runGridValidation(input: GridValidationInput): GridValidationResult {
  const { grid, derived, themeSet, policies } = input;
  const n = grid.length;
  const minLen = minEntryLenForSize(n);
  const density = crosswordDensityFromGrid(grid);
  const checkedStatsResult = checkedCellStats(grid, minLen);
  const crossedStatsResult = crossedEntryStats(grid, derived, minLen);
  const entryCrossings = entryCrossingStats(grid, derived, minLen);

  const reject = (issue: string): GridValidationResult => ({
    accepted: false,
    issue,
    density,
    checkedStats: checkedStatsResult,
    crossedStats: crossedStatsResult,
    entryCrossings,
  });

  if (n !== 9 && n !== 11 && n !== 13) return reject("invalid-size");
  if (hasShortLetterRuns(grid, minLen)) return reject("short-runs");
  if (n === 11 && density < 0.4) return reject("low-density");
  if (n !== 11 && density < 0.32) return reject("low-density");

  const minEntries = n === 11 ? minPublishEntriesForSize(n) : minEntriesForSize(n);
  if (derived.length < minEntries) return reject("too-few-entries");

  const across = derived.filter((e) => e.direction === "across").length;
  const down = derived.length - across;
  if (across === 0 || down === 0) return reject("missing-direction");
  if (n === 11 && (across < 6 || down < 6)) return reject("direction-imbalance");

  const shortCount = derived.filter((e) => e.answer.length < minLen).length;
  if (shortCount > 0) return reject("short-entry");

  const genericAnyCount = derived.reduce(
    (acc, e) => acc + (policies.isOverGenericThemeWord(e.answer) ? 1 : 0),
    0
  );
  if (n === 11 && genericAnyCount > 7) return reject("too-many-generic");

  if (n === 11 && crossedStatsResult.crossed < minEntries) return reject("too-few-crossed");
  if (n === 11 && entryCrossings.weakEntries.length > 0) return reject("weak-crossings");
  if (n === 11 && checkedStatsResult.ratio < 0.2) return reject("low-checked-ratio");

  if (themeSet) {
    const minTheme = n === 11 ? minThematicEntriesForPublish(n, derived.length) : n >= 13 ? 12 : n >= 9 ? 7 : 5;
    const themedCount = derived.reduce((acc, e) => acc + (themeSet.has(e.answer) ? 1 : 0), 0);
    if (themedCount < minTheme) return reject("too-few-themed");

    const genericNonThemedCount = derived.reduce(
      (acc, e) => acc + (!themeSet.has(e.answer) && policies.isOverGenericThemeWord(e.answer) ? 1 : 0),
      0
    );
    if (n === 11 && genericNonThemedCount > 4) return reject("too-many-generic-nonthemed");
    if (n !== 11 && genericNonThemedCount > 0) return reject("generic-nonthemed");
  }

  return {
    accepted: true,
    issue: null,
    density,
    checkedStats: checkedStatsResult,
    crossedStats: crossedStatsResult,
    entryCrossings,
  };
}

export function isAcceptableGridWithPolicies(input: GridValidationInput): boolean {
  return runGridValidation(input).accepted;
}
