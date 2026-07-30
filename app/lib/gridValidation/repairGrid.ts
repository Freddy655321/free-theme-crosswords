import type { Cell } from "@/app/lib/crosswordTypes";
import { inBounds, isBlock } from "@/app/lib/crosswordUtils";
import { deriveEntriesFromGrid } from "@/app/lib/publishPipeline";
import type { GridRepairResult, GridValidationEntry } from "./gridValidationTypes";
import {
  entryCrossingStats,
  hasShortLetterRuns,
  minCrossingsPerEntryForPublish,
} from "./validateGrid";

export function gridToStrings(grid: (string | null)[][]): string[][] {
  return grid.map((row) =>
    row.map((cell) => {
      if (typeof cell === "string" && cell.length === 1) {
        if (/[a-z]/.test(cell)) return cell.toUpperCase();
        if (/[A-Z0-9]/.test(cell)) return cell;
      }
      return "#";
    })
  );
}

export function sanitizeUncheckedGrid(grid: string[][], minLen: number): string[][] {
  let blocked: Cell[][] = grid.map((row) => row.map((cell) => (cell === "#" ? "#" : cell)));
  blocked = pruneDanglingRuns(blocked, minLen);
  blocked = keepLargestConnectedComponent(blocked);
  blocked = keepLargestConnectedComponent(blocked);

  return blocked.map((row) =>
    row.map((cell) => {
      if (cell === "#") return "#";
      return typeof cell === "string" && cell.length === 1 ? cell.toUpperCase() : "#";
    })
  );
}

export function blockShortRunsOnly(grid: string[][], minLen: number): string[][] {
  const n = grid.length;
  const out = grid.map((row) => row.slice());
  let changed = true;

  while (changed) {
    changed = false;
    const toBlock = new Set<string>();

    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        while (c < n && isBlock(out[r]?.[c] ?? "#")) c++;
        const start = c;
        while (c < n && !isBlock(out[r]?.[c] ?? "#")) c++;
        const len = c - start;
        if (len > 1 && len < minLen) {
          for (let cc = start; cc < c; cc++) toBlock.add(`${r},${cc}`);
        }
      }
    }

    for (let c = 0; c < n; c++) {
      let r = 0;
      while (r < n) {
        while (r < n && isBlock(out[r]?.[c] ?? "#")) r++;
        const start = r;
        while (r < n && !isBlock(out[r]?.[c] ?? "#")) r++;
        const len = r - start;
        if (len > 1 && len < minLen) {
          for (let rr = start; rr < r; rr++) toBlock.add(`${rr},${c}`);
        }
      }
    }

    for (const key of toBlock) {
      const [rRaw, cRaw] = key.split(",");
      const r = Number(rRaw);
      const c = Number(cRaw);
      if (out[r]?.[c] && out[r][c] !== "#") {
        out[r][c] = "#";
        changed = true;
      }
    }
  }

  return out;
}

export function shortRunCellKeys(grid: string[][], minLen: number): Set<string> {
  const n = grid.length;
  const keys = new Set<string>();

  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      while (c < n && isBlock(grid[r]?.[c] ?? "#")) c++;
      const start = c;
      while (c < n && !isBlock(grid[r]?.[c] ?? "#")) c++;
      const len = c - start;
      if (len > 1 && len < minLen) {
        for (let cc = start; cc < c; cc++) keys.add(`${r},${cc}`);
      }
    }
  }

  for (let c = 0; c < n; c++) {
    let r = 0;
    while (r < n) {
      while (r < n && isBlock(grid[r]?.[c] ?? "#")) r++;
      const start = r;
      while (r < n && !isBlock(grid[r]?.[c] ?? "#")) r++;
      const len = r - start;
      if (len > 1 && len < minLen) {
        for (let rr = start; rr < r; rr++) keys.add(`${rr},${c}`);
      }
    }
  }

  return keys;
}

export function paintBlocks(grid: Cell[][]): Cell[][] {
  const n = grid.length;
  const out: Cell[][] = [];
  for (let r = 0; r < n; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < n; c++) {
      row.push(grid[r][c] === "" ? "#" : grid[r][c]);
    }
    out.push(row);
  }
  return out;
}

export function enforceMinWordLen(blocked: Cell[][], minLen: number): Cell[][] {
  const n = blocked.length;
  const grid = blocked.map((row) => row.slice());

  const runLenAcrossAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c)) return 0;
    if (grid[r][c] === "#") return 0;

    let cc = c;
    while (cc - 1 >= 0 && grid[r][cc - 1] !== "#") cc--;
    const start = cc;

    while (cc + 1 < n && grid[r][cc + 1] !== "#") cc++;
    const end = cc;

    return end - start + 1;
  };

  const runLenDownAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c)) return 0;
    if (grid[r][c] === "#") return 0;

    let rr = r;
    while (rr - 1 >= 0 && grid[rr - 1][c] !== "#") rr--;
    const start = rr;

    while (rr + 1 < n && grid[rr + 1][c] !== "#") rr++;
    const end = rr;

    return end - start + 1;
  };

  const toKill: Array<{ r: number; c: number }> = [];

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r][c] === "#") continue;

      const la = runLenAcrossAt(r, c);
      const ld = runLenDownAt(r, c);

      if (la < minLen && ld < minLen) toKill.push({ r, c });
    }
  }

  for (const cell of toKill) grid[cell.r][cell.c] = "#";
  return grid;
}

export function pruneDanglingRuns(blocked: Cell[][], minLen: number): Cell[][] {
  const n = blocked.length;
  const grid = blocked.map((row) => row.slice());

  const runLenAcrossAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c)) return 0;
    if (grid[r][c] === "#") return 0;

    let start = c;
    while (start - 1 >= 0 && grid[r][start - 1] !== "#") start--;

    let end = c;
    while (end + 1 < n && grid[r][end + 1] !== "#") end++;

    return end - start + 1;
  };

  const runLenDownAt = (r: number, c: number): number => {
    if (!inBounds(n, r, c)) return 0;
    if (grid[r][c] === "#") return 0;

    let start = r;
    while (start - 1 >= 0 && grid[start - 1][c] !== "#") start--;

    let end = r;
    while (end + 1 < n && grid[end + 1][c] !== "#") end++;

    return end - start + 1;
  };

  let changed = true;

  while (changed) {
    changed = false;
    const toKill: Array<{ r: number; c: number }> = [];

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (grid[r][c] === "#") continue;

        const la = runLenAcrossAt(r, c);
        const ld = runLenDownAt(r, c);

        if ((la > 1 && la < minLen) || (ld > 1 && ld < minLen)) {
          toKill.push({ r, c });
        }
      }
    }

    if (toKill.length > 0) {
      changed = true;
      for (const cell of toKill) grid[cell.r][cell.c] = "#";
    }
  }

  return grid;
}

export function keepLargestConnectedComponent(blocked: Cell[][]): Cell[][] {
  const n = blocked.length;
  const seen = Array.from({ length: n }, () => Array.from({ length: n }, () => false));
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  const components: Array<Array<{ r: number; c: number }>> = [];

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (seen[r][c]) continue;
      if (blocked[r][c] === "#") continue;

      const comp: Array<{ r: number; c: number }> = [];
      const stack = [{ r, c }];
      seen[r][c] = true;

      while (stack.length) {
        const cur = stack.pop()!;
        comp.push(cur);
        for (const [dr, dc] of dirs) {
          const rr = cur.r + dr;
          const cc = cur.c + dc;
          if (!inBounds(n, rr, cc)) continue;
          if (seen[rr][cc]) continue;
          if (blocked[rr][cc] === "#") continue;
          seen[rr][cc] = true;
          stack.push({ r: rr, c: cc });
        }
      }

      components.push(comp);
    }
  }

  if (components.length <= 1) return blocked;

  components.sort((a, b) => b.length - a.length);
  const keep = new Set(components[0].map((p) => `${p.r},${p.c}`));

  const out = blocked.map((row) => row.slice());
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (out[r][c] === "#") continue;
      if (!keep.has(`${r},${c}`)) out[r][c] = "#";
    }
  }
  return out;
}

export function pruneWeakEntriesPreservingCrosses(
  grid: string[][],
  minLen: number,
  minEntries: number
): GridRepairResult | null {
  let working = grid.map((row) => row.slice());

  for (let pass = 0; pass < 8; pass++) {
    const derived = deriveEntriesFromGrid(working, minLen);
    if (derived.length < minEntries) return null;
    const stats = entryCrossingStats(working, derived, minLen);
    const checkedCellsForEntry = (entry: GridValidationEntry) => {
      let checked = 0;
      for (let i = 0; i < entry.answer.length; i++) {
        const r = entry.direction === "down" ? entry.row + i : entry.row;
        const c = entry.direction === "across" ? entry.col + i : entry.col;
        const across = derived.some(
          (other) =>
            other.direction === "across" &&
            other.row === r &&
            c >= other.col &&
            c < other.col + other.answer.length
        );
        const down = derived.some(
          (other) =>
            other.direction === "down" &&
            other.col === c &&
            r >= other.row &&
            r < other.row + other.answer.length
        );
        if (across && down) checked++;
      }
      return checked;
    };
    const seenAnswers = new Set<string>();
    const duplicateEntries = derived.filter((entry) => {
      if (seenAnswers.has(entry.answer)) return true;
      seenAnswers.add(entry.answer);
      return false;
    });
    const weakEntries = derived.filter(
      (entry) => checkedCellsForEntry(entry) < minCrossingsPerEntryForPublish(grid.length)
    );
    const targets = Array.from(new Set([...weakEntries, ...duplicateEntries]));
    if (targets.length === 0 && stats.weakEntries.length === 0) {
      return { grid: working, derived };
    }

    let best:
      | {
          grid: string[][];
          derived: GridValidationEntry[];
          weakCount: number;
        }
      | null = null;

    for (const weakEntry of targets) {
      const next = working.map((row) => row.slice());
      for (let i = 0; i < weakEntry.answer.length; i++) {
        const r = weakEntry.direction === "down" ? weakEntry.row + i : weakEntry.row;
        const c = weakEntry.direction === "across" ? weakEntry.col + i : weakEntry.col;
        const sharedByOther = derived.some((entry) => {
          if (entry === weakEntry) return false;
          for (let j = 0; j < entry.answer.length; j++) {
            const otherR = entry.direction === "down" ? entry.row + j : entry.row;
            const otherC = entry.direction === "across" ? entry.col + j : entry.col;
            if (otherR === r && otherC === c) return true;
          }
          return false;
        });
        if (!sharedByOther) next[r][c] = "#";
      }

      const cleaned = blockShortRunsOnly(next, minLen);
      if (hasShortLetterRuns(cleaned, minLen)) continue;
      const nextDerived = deriveEntriesFromGrid(cleaned, minLen);
      if (nextDerived.length < minEntries) continue;
      const nextStats = entryCrossingStats(cleaned, nextDerived, minLen);
      const nextDuplicateCount =
        nextDerived.length - new Set(nextDerived.map((entry) => entry.answer)).size;
      const currentDuplicateCount =
        derived.length - new Set(derived.map((entry) => entry.answer)).size;
      const currentProblemCount = stats.weakEntries.length + currentDuplicateCount;
      const nextProblemCount = nextStats.weakEntries.length + nextDuplicateCount;
      if (nextProblemCount >= currentProblemCount) continue;

      if (
        !best ||
        nextProblemCount < best.weakCount ||
        (nextProblemCount === best.weakCount &&
          nextDerived.length > best.derived.length)
      ) {
        best = {
          grid: cleaned,
          derived: nextDerived,
          weakCount: nextProblemCount,
        };
      }
    }

    if (!best) return null;
    working = best.grid;
  }

  const derived = deriveEntriesFromGrid(working, minLen);
  if (derived.length < minEntries) return null;
  if (entryCrossingStats(working, derived, minLen).weakEntries.length > 0) return null;
  return { grid: working, derived };
}
