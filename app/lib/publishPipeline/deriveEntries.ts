import type { DerivedEntry } from "@/app/lib/crosswordTypes";
import { ASCII_A_TO_Z, isBlock, normalizeAnswer } from "@/app/lib/crosswordUtils";

export function deriveEntriesFromGrid(grid: string[][], minLen = 3): DerivedEntry[] {
  const n = grid.length;
  const entries: DerivedEntry[] = [];
  let num = 1;

  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      const cell = grid[r]?.[c] ?? "#";
      const prev = grid[r]?.[c - 1] ?? "#";
      if (!isBlock(cell) && (c === 0 || isBlock(prev))) {
        let end = c;
        let ans = "";
        while (end < n && !isBlock(grid[r]?.[end] ?? "#")) {
          ans += grid[r]?.[end] ?? "#";
          end++;
        }
        const norm = normalizeAnswer(ans);
        if (norm.length >= minLen && ASCII_A_TO_Z.test(norm)) {
          entries.push({ number: num++, row: r, col: c, direction: "across", answer: norm });
        }
        c = end + 1;
        continue;
      }
      c++;
    }
  }

  for (let c = 0; c < n; c++) {
    let r = 0;
    while (r < n) {
      const cell = grid[r]?.[c] ?? "#";
      const prev = grid[r - 1]?.[c] ?? "#";
      if (!isBlock(cell) && (r === 0 || isBlock(prev))) {
        let end = r;
        let ans = "";
        while (end < n && !isBlock(grid[end]?.[c] ?? "#")) {
          ans += grid[end]?.[c] ?? "#";
          end++;
        }
        const norm = normalizeAnswer(ans);
        if (norm.length >= minLen && ASCII_A_TO_Z.test(norm)) {
          entries.push({ number: num++, row: r, col: c, direction: "down", answer: norm });
        }
        r = end + 1;
        continue;
      }
      r++;
    }
  }

  return entries;
}
