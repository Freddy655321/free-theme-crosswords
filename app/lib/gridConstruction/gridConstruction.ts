import type { Cell, Direction } from "@/app/lib/crosswordTypes";
import { inBounds } from "@/app/lib/crosswordUtils";
import {
  gridToStrings,
  hasShortLetterRuns,
  minEntryLenForSize,
  paintBlocks,
} from "@/app/lib/gridValidation";
import { deriveEntriesFromGrid } from "@/app/lib/publishPipeline";
import type {
  GridPlacementChange,
  GridPlacementCheck,
  PatternSlot,
  PlaceWordPolicies,
} from "./gridConstructionTypes";

export function makeEmptyWorkingGrid(n: number): Cell[][] {
  return Array.from({ length: n }, () => Array.from({ length: n }, () => "" as Cell));
}

function getCell(grid: Cell[][], r: number, c: number): Cell {
  return grid[r]?.[c] ?? "#";
}

function setCell(grid: Cell[][], r: number, c: number, v: Cell) {
  grid[r][c] = v;
}

export function canPlaceWord(
  grid: Cell[][],
  word: string,
  row: number,
  col: number,
  dir: Direction
): GridPlacementCheck {
  const n = grid.length;
  let crossings = 0;

  for (let i = 0; i < word.length; i++) {
    const r = dir === "across" ? row : row + i;
    const c = dir === "across" ? col + i : col;

    if (!inBounds(n, r, c)) {
      return { ok: false, crossings: 0, reason: "out_of_bounds" };
    }

    const cur = getCell(grid, r, c);
    const ch = word[i];

    if (cur === "#") {
      return { ok: false, crossings: 0, reason: "blocked_cell" };
    }

    if (cur !== "" && cur !== ch) {
      return { ok: false, crossings: 0, reason: "letter_conflict" };
    }

    if (cur === ch) {
      crossings++;
      continue;
    }

    if (dir === "across") {
      const up = inBounds(n, r - 1, c) ? getCell(grid, r - 1, c) : "#";
      const down = inBounds(n, r + 1, c) ? getCell(grid, r + 1, c) : "#";

      if (up !== "" && up !== "#") {
        return { ok: false, crossings: 0, reason: "side_touch_up" };
      }

      if (down !== "" && down !== "#") {
        return { ok: false, crossings: 0, reason: "side_touch_down" };
      }
    } else {
      const left = inBounds(n, r, c - 1) ? getCell(grid, r, c - 1) : "#";
      const right = inBounds(n, r, c + 1) ? getCell(grid, r, c + 1) : "#";

      if (left !== "" && left !== "#") {
        return { ok: false, crossings: 0, reason: "side_touch_left" };
      }

      if (right !== "" && right !== "#") {
        return { ok: false, crossings: 0, reason: "side_touch_right" };
      }
    }
  }

  const beforeR = dir === "across" ? row : row - 1;
  const beforeC = dir === "across" ? col - 1 : col;
  const afterR = dir === "across" ? row : row + word.length;
  const afterC = dir === "across" ? col + word.length : col;

  if (inBounds(n, beforeR, beforeC)) {
    const b = getCell(grid, beforeR, beforeC);
    if (b !== "" && b !== "#") {
      return { ok: false, crossings: 0, reason: "before_cell_occupied" };
    }
  }

  if (inBounds(n, afterR, afterC)) {
    const a = getCell(grid, afterR, afterC);
    if (a !== "" && a !== "#") {
      return { ok: false, crossings: 0, reason: "after_cell_occupied" };
    }
  }

  return { ok: true, crossings };
}

export function placeWordWithPolicies(
  grid: Cell[][],
  word: string,
  row: number,
  col: number,
  dir: Direction,
  policies: PlaceWordPolicies
): GridPlacementChange[] | null {
  const n = grid.length;
  const changes: GridPlacementChange[] = [];

  // Ensure placement is legal (including anti-touch) before committing.
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

  if (deriveEntriesFromGrid(painted, minEntryLenForSize(n)).some((entry) => policies.isForbiddenPublishAnswer(entry.answer))) {
    for (let i = changes.length - 1; i >= 0; i--) {
      const change = changes[i];
      setCell(grid, change.r, change.c, change.prev);
    }
    return null;
  }

  return changes;
}

export function extractPatternSlots(pattern: string[]): PatternSlot[] {
  const n = pattern.length;
  const slots: PatternSlot[] = [];
  const minSlotLen = n === 11 ? 3 : 4;

  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      while (c < n && pattern[r][c] === "#") c++;
      const start = c;
      while (c < n && pattern[r][c] !== "#") c++;
      const len = c - start;
      if (len >= minSlotLen) {
        slots.push({
          row: r,
          col: start,
          direction: "across",
          len,
          cells: Array.from({ length: len }, (_, i) => ({ r, c: start + i })),
        });
      }
    }
  }

  for (let c = 0; c < n; c++) {
    let r = 0;
    while (r < n) {
      while (r < n && pattern[r][c] === "#") r++;
      const start = r;
      while (r < n && pattern[r][c] !== "#") r++;
      const len = r - start;
      if (len >= minSlotLen) {
        slots.push({
          row: start,
          col: c,
          direction: "down",
          len,
          cells: Array.from({ length: len }, (_, i) => ({ r: start + i, c })),
        });
      }
    }
  }

  return slots;
}
