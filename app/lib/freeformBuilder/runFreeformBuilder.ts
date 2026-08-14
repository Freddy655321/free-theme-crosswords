import type { Cell, Direction, Placement, WordCandidate } from "@/app/lib/crosswordTypes";
import { ASCII_A_TO_Z, inBounds, makeSeededRng, shuffleInPlace } from "@/app/lib/crosswordUtils";
import {
  canPlaceWord,
  makeEmptyWorkingGrid,
  placeWordWithPolicies,
} from "../gridConstruction";
import { deriveEntriesFromGrid } from "@/app/lib/publishPipeline";
import {
  checkedCellStats,
  crosswordDensityFromGrid,
  desiredPublishEntriesForSize,
  enforceMinWordLen,
  entryCrossingStats,
  gridToStrings,
  hasShortLetterRuns,
  keepLargestConnectedComponent,
  minEntryLenForSize,
  minPublishEntriesForSize,
  paintBlocks,
  pruneDanglingRuns,
} from "@/app/lib/gridValidation";
import type { FreeformBuilderInput, FreeformBuilderResult } from "./freeformBuilderTypes";
export function runFreeformBuilder(opts: FreeformBuilderInput): FreeformBuilderResult | null {
  const { size, candidates, seed, dependencies } = opts;
  const {
    isForbiddenPublishAnswer,
  } = dependencies;
  const placeWord = (
    grid: Cell[][],
    word: string,
    row: number,
    col: number,
    dir: Direction
  ) => placeWordWithPolicies(grid, word, row, col, dir, { isForbiddenPublishAnswer });
  console.warn("[freeform] ENTER constructFreeformCrossword", { size, seed, candidates: candidates.length });

  const deadline = opts.deadlineMs;
  const nowOk = () => !deadline || Date.now() <= deadline;

  const minLen = minEntryLenForSize(size);

  const rawWords = candidates
    .filter((c) => c.answer.length >= minLen && c.answer.length <= size && ASCII_A_TO_Z.test(c.answer))
    .sort((a, b) => {
      if (size === 11) {
        const score = (candidate: WordCandidate) => {
          const len = candidate.answer.length;
          const lengthBand =
            len >= 5 && len <= 7 ? 500 :
            len === 4 || len === 8 ? 380 :
            len === 9 ? 180 :
            len >= 10 ? 60 :
            0;
          const sourceBonus =
            candidate.source === "model" || candidate.source === "anchor" ? 90 :
            candidate.source === "support" ? 20 :
            0;
          return (candidate.thematic ? 1000 : 0) + sourceBonus + lengthBand;
        };
        const diff = score(b) - score(a);
        if (diff !== 0) return diff;
        return a.answer.length - b.answer.length;
      }
      if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
      return b.answer.length - a.answer.length;
    })
    .map((c) => c.answer);

  if (rawWords.length === 0) return null;

  const uniq = Array.from(new Set(rawWords));

  const byLen = new Map<number, string[]>();
  for (const w of uniq) {
    const L = w.length;
    const arr = byLen.get(L) ?? [];
    arr.push(w);
    byLen.set(L, arr);
  }
 const lengthPriority = (L: number) => {
  if (size === 11) {
    if (L >= 5 && L <= 7) return 300 + L;
    if (L === 4 || L === 8) return 200 + L;
    return 100 + L;
  }

  return L;
};

const lengths = Array.from(byLen.keys()).sort(
  (a, b) => lengthPriority(b) - lengthPriority(a)
);

  const maxPlaced = opts.maxPlacedWords ?? (size === 9 ? 48 : size === 11 ? 140 : 132);

  const targetDensity = size === 9 ? 0.60 : size === 11 ? 0.68 : 0.56;
  const maxBuilds = opts.maxBuilds ?? (size === 9 ? 10 : size === 11 ? 24 : 18);
  const rounds = size === 9 ? 4 : size === 11 ? 28 : 6;

  type BuildResult = { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> };

  const buildOnce = (localSeed: number): BuildResult | null => {
    const rng = makeSeededRng(localSeed);

    const words: string[] = [];
    for (const L of lengths) {
      const bucket = (byLen.get(L) ?? []).slice();
      shuffleInPlace(bucket, rng);
      words.push(...bucket);
    }
    if (words.length === 0) return null;
    const allBuildAnswerSet = new Set(words);

    const grid = makeEmptyWorkingGrid(size);
    const placed: Placement[] = [];
    const nonFillerWords = new Set(
      candidates.filter((c) => c.source !== "filler").map((c) => c.answer)
    );
    const startRow = Math.floor(size / 2);

    // Seed: try a handful of candidate seed words and both orientations.
    let seedWord: string | null = null;
    let seedDir: Direction = "across";
    let seedCol = 0;

const seedMinLen = size === 9 ? 5 : size === 11 ? 6 : 7;
const seedMaxLen = size === 9 ? 7 : size === 11 ? 8 : 9;

const buildLetterFreq = (pool: string[]) => {
  const freq = new Map<string, number>();
  for (const w of pool) {
    const uniqLetters = new Set(w.split(""));
    for (const ch of uniqLetters) {
      freq.set(ch, (freq.get(ch) ?? 0) + 1);
    }
  }
  return freq;
};

const letterFreq = buildLetterFreq(words);

const seedCrossabilityScore = (w: string) => {
  let score = 0;
  const uniqLetters = new Set(w.split(""));

  for (const ch of uniqLetters) {
    score += letterFreq.get(ch) ?? 0;
  }

  let pairLinks = 0;
  for (const other of words) {
    if (other === w) continue;
    let shared = 0;
    const otherSet = new Set(other.split(""));
    for (const ch of uniqLetters) {
      if (otherSet.has(ch)) shared++;
    }
    if (shared >= 2) pairLinks += 1;
    else if (shared >= 1) pairLinks += 0.35;
  }

  const lengthBonus =
    w.length >= seedMinLen && w.length <= seedMaxLen ? 40 : 0;

  const midLenBonus =
    w.length >= 5 && w.length <= 8 ? 18 : 0;

  const thematicSeedBonus = nonFillerWords.has(w) ? 100000 : 0;
  return thematicSeedBonus + score + pairLinks * 18 + lengthBonus + midLenBonus;
};

const preferredSeedWords = words
  .filter((w) => w.length >= Math.max(minLen, 4) && w.length <= size)
  .slice()
  .sort((a, b) => seedCrossabilityScore(b) - seedCrossabilityScore(a));

const seedCandidates = preferredSeedWords.slice(0, Math.min(size === 11 ? 18 : 12, preferredSeedWords.length));

const estimateSeedFollowups = (
  w: string,
  row: number,
  col: number,
  dir: Direction
) => {
  const scratch = makeEmptyWorkingGrid(size);
  const placedSeed = placeWord(scratch, w, row, col, dir);
  if (!placedSeed) return -1;

  const letters: Array<{ r: number; c: number; ch: string }> = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const v = scratch[r][c];
      if (v !== "" && v !== "#") letters.push({ r, c, ch: v as string });
    }
  }

  let possible = 0;

  for (const other of words) {
    if (other === w) continue;
    if (other.length < Math.max(minLen, 4) || other.length > size) continue;

    let foundForThisWord = false;

    for (let i = 0; i < other.length && !foundForThisWord; i++) {
      const ch = other[i];

      for (const cell of letters) {
        if (cell.ch !== ch) continue;

        const rowA = cell.r;
        const colA = cell.c - i;
        const checkA = canPlaceWord(scratch, other, rowA, colA, "across");
        if (checkA.ok && checkA.crossings >= 1) {
          possible++;
          foundForThisWord = true;
          break;
        }

        const rowD = cell.r - i;
        const colD = cell.c;
        const checkD = canPlaceWord(scratch, other, rowD, colD, "down");
        if (checkD.ok && checkD.crossings >= 1) {
          possible++;
          foundForThisWord = true;
          break;
        }
      }
    }
  }

  return possible;
};

type SeedOption = {
  word: string;
  row: number;
  col: number;
  dir: Direction;
  viability: number;
};

const seedOptions: SeedOption[] = [];

for (const w of seedCandidates) {
  const colAcross = Math.max(0, Math.floor((size - w.length) / 2));
  const rowAcross = startRow;

  const canA = canPlaceWord(grid, w, rowAcross, colAcross, "across");
  if (canA.ok) {
    const viabilityA = estimateSeedFollowups(w, rowAcross, colAcross, "across");
    if (viabilityA >= 0) {
      seedOptions.push({
        word: w,
        row: rowAcross,
        col: colAcross,
        dir: "across",
        viability: viabilityA * 100 + seedCrossabilityScore(w),
      });
    }
  }

  if (w.length <= size) {
    const rowDown = Math.max(0, Math.floor((size - w.length) / 2));
    const colDown = Math.floor(size / 2);
    const canD = canPlaceWord(grid, w, rowDown, colDown, "down");
    if (canD.ok) {
      const viabilityD = estimateSeedFollowups(w, rowDown, colDown, "down");
      if (viabilityD >= 0) {
        seedOptions.push({
          word: w,
          row: rowDown,
          col: colDown,
          dir: "down",
          viability: viabilityD * 100 + seedCrossabilityScore(w),
        });
      }
    }
  }
}

seedOptions.sort((a, b) => b.viability - a.viability);

const topSeedOptions = seedOptions.slice(0, Math.min(size === 11 ? 8 : 6, seedOptions.length));
shuffleInPlace(topSeedOptions, rng);

let seedRow = 0;

for (const s of topSeedOptions) {
  const placedSeed = placeWord(grid, s.word, s.row, s.col, s.dir);
  if (!placedSeed) continue;

  seedWord = s.word;
  seedDir = s.dir;
  seedRow = s.row;
  seedCol = s.col;
  break;
}

if (!seedWord) {
  console.warn("[freeform] seed failed", {
    size,
    tried: words.slice(0, Math.min(12, words.length)),
  });
  return null;
}

placed.push({
  word: seedWord,
  row: seedRow,
  col: seedCol,
  dir: seedDir,
});

    const used = new Set<string>([seedWord]);

const countLetters = (g: Cell[][]) =>
  g.reduce(
    (acc, row) => acc + row.filter((x) => typeof x === "string" && x !== "" && x !== "#").length,
    0
  );

console.warn("[freeform] after seed placement", {
  seedWord,
  letters: countLetters(grid)
});

    const filled = () => {
      const out: Array<{ r: number; c: number; ch: string }> = [];
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const v = grid[r][c];
          if (v !== "" && v !== "#") out.push({ r, c, ch: v as string });
        }
      }
      return out;
    };

    const rejectReasonCounts = new Map<string, number>();

    const tryWriteWordLoose = (
      target: Cell[][],
      word: string,
      row: number,
      col: number,
      dir: Direction
    ) => {
      let changed = false;

      for (let i = 0; i < word.length; i++) {
        const rr = dir === "down" ? row + i : row;
        const cc = dir === "across" ? col + i : col;

        if (!inBounds(size, rr, cc)) return { ok: false as const, crossings: 0, newCells: 0 };

        const cur = target[rr][cc];
        const ch = word[i];

        if (cur === "#") return { ok: false as const, crossings: 0, newCells: 0 };
        if (cur !== "" && cur !== ch) return { ok: false as const, crossings: 0, newCells: 0 };
      }

      let crossings = 0;
      let newCells = 0;

      for (let i = 0; i < word.length; i++) {
        const rr = dir === "down" ? row + i : row;
        const cc = dir === "across" ? col + i : col;
        const cur = target[rr][cc];
        const ch = word[i];

        if (cur === ch) crossings++;
        if (cur === "") {
          target[rr][cc] = ch;
          changed = true;
          newCells++;
        }
      }

      if (!changed) return { ok: false as const, crossings, newCells };
      return { ok: true as const, crossings, newCells };
    };

    const projectGridOutcome = (scratch: Cell[][]) => {
      let blocked = paintBlocks(scratch);
      blocked = enforceMinWordLen(blocked, minEntryLenForSize(size));

      const blockedBeforePrune = blocked.map((row) => row.slice());
      const prunedBlocked = pruneDanglingRuns(blocked, minEntryLenForSize(size));
      const derivedBeforePrune = deriveEntriesFromGrid(
        gridToStrings(blockedBeforePrune as (string | null)[][]),
        minEntryLenForSize(size)
      );
      const derivedAfterPrune = deriveEntriesFromGrid(
        gridToStrings(prunedBlocked as (string | null)[][]),
        minEntryLenForSize(size)
      );

      blocked =
        size === 11 ||
        derivedAfterPrune.length >= Math.max(4, Math.floor(derivedBeforePrune.length * 0.6))
          ? prunedBlocked
          : blockedBeforePrune;

      blocked = keepLargestConnectedComponent(blocked);
      blocked = keepLargestConnectedComponent(blocked);

      const final: string[][] = [];
      for (let r = 0; r < size; r++) {
        const outRow: string[] = [];
        for (let c = 0; c < size; c++) {
          const v = blocked[r][c];
          if (v === "#") {
            outRow.push("#");
            continue;
          }
          if (typeof v === "string" && v.length === 1) {
            if (/[A-Z]/.test(v)) {
              outRow.push(v);
              continue;
            }
            if (/[a-z]/.test(v)) {
              outRow.push(v.toUpperCase());
              continue;
            }
            if (/[0-9]/.test(v)) {
              outRow.push(v);
              continue;
            }
          }
          outRow.push("#");
        }
        final.push(outRow);
      }

      const derived = deriveEntriesFromGrid(final, minEntryLenForSize(size));
      const checked = checkedCellStats(final, minEntryLenForSize(size));
      const density = crosswordDensityFromGrid(final);
      const nonFillerUsed = derived.filter((e) => nonFillerWords.has(e.answer)).length;

      return {
        final,
        derived,
        checkedRatio: checked.ratio,
        density,
        nonFillerUsed,
      };
    };

    const evaluateLoosePlacement = (
      word: string,
      row: number,
      col: number,
      dir: Direction
    ) => {
      const scratch = grid.map((r) => r.slice()) as Cell[][];
      const wrote = tryWriteWordLoose(scratch, word, row, col, dir);
      if (!wrote.ok) return null;

      const projected = projectGridOutcome(scratch);
      const allowedAnswers = allBuildAnswerSet;

      if (
        size === 11 &&
        (hasShortLetterRuns(projected.final, minEntryLenForSize(size)) ||
          projected.derived.some((e) => !allowedAnswers.has(e.answer)) ||
          !projected.derived.some((e) => e.answer === word))
      ) {
        const rawGrid = gridToStrings(scratch);
        const rawDerived = deriveEntriesFromGrid(rawGrid, minEntryLenForSize(size));
        if (
          hasShortLetterRuns(rawGrid, minEntryLenForSize(size)) ||
          rawDerived.some((e) => !allowedAnswers.has(e.answer)) ||
          !rawDerived.some((e) => e.answer === word)
        ) {
          return null;
        }

        const rawChecked = checkedCellStats(rawGrid, minEntryLenForSize(size));
        const rawDensity = crosswordDensityFromGrid(rawGrid);
        const rawNonFillerUsed = rawDerived.filter((e) => nonFillerWords.has(e.answer)).length;
        return {
          final: rawGrid,
          derived: rawDerived,
          checkedRatio: rawChecked.ratio,
          density: rawDensity,
          nonFillerUsed: rawNonFillerUsed,
          score:
            rawDerived.length * 520 +
            rawChecked.ratio * 1800 +
            rawDensity * 120 +
            rawNonFillerUsed * 1000 +
            wrote.crossings * 80 +
            wrote.newCells * 18,
          crossings: wrote.crossings,
          newCells: wrote.newCells,
          scratch,
        };
      }

      if (hasShortLetterRuns(projected.final, minEntryLenForSize(size))) return null;
      if (projected.derived.some((e) => !allowedAnswers.has(e.answer))) return null;
      if (!projected.derived.some((e) => e.answer === word)) return null;

      const score =
        projected.derived.length * 600 +
        projected.checkedRatio * 2200 +
        projected.density * 180 +
        projected.nonFillerUsed * 1200 +
        wrote.crossings * 80 +
        wrote.newCells * 18;

      return {
        ...projected,
        score,
        crossings: wrote.crossings,
        newCells: wrote.newCells,
        scratch,
      };
    };

     const placementScore = (
      p: { row: number; col: number; dir: Direction; crossings: number },
      wlen: number
    ) => {

      const mid = (size - 1) / 2;
      const rCenter = p.row + (p.dir === "down" ? (wlen - 1) / 2 : 0);
      const cCenter = p.col + (p.dir === "across" ? (wlen - 1) / 2 : 0);
      const dist = Math.abs(rCenter - mid) + Math.abs(cCenter - mid);

      const touchesTop = p.row <= 0;
      const touchesLeft = p.col <= 0;
      const touchesBottom = p.dir === "down" ? p.row + wlen - 1 >= size - 1 : p.row >= size - 1;
      const touchesRight = p.dir === "across" ? p.col + wlen - 1 >= size - 1 : p.col >= size - 1;
      const borderTouches =
        (touchesTop ? 1 : 0) +
        (touchesLeft ? 1 : 0) +
        (touchesBottom ? 1 : 0) +
        (touchesRight ? 1 : 0);

      let newCells = 0;
      let sideOpenings = 0;
      let doubleSideOpenings = 0;

      for (let i = 0; i < wlen; i++) {
        const rr = p.dir === "down" ? p.row + i : p.row;
        const cc = p.dir === "across" ? p.col + i : p.col;
        const current = grid[rr][cc];
        const isNewCell = current === "";

        if (isNewCell) {
          newCells += 1;

          if (p.dir === "across") {
            const upOpen = rr > 0 && grid[rr - 1][cc] === "";
            const downOpen = rr < size - 1 && grid[rr + 1][cc] === "";
            if (upOpen) sideOpenings += 1;
            if (downOpen) sideOpenings += 1;
            if (upOpen && downOpen) doubleSideOpenings += 1;
          } else {
            const leftOpen = cc > 0 && grid[rr][cc - 1] === "";
            const rightOpen = cc < size - 1 && grid[rr][cc + 1] === "";
            if (leftOpen) sideOpenings += 1;
            if (rightOpen) sideOpenings += 1;
            if (leftOpen && rightOpen) doubleSideOpenings += 1;
          }
        }
      }

      const edgePenalty = borderTouches * (placed.length < 10 ? 18 : 8);
      const distancePenalty = dist * 2.25;
      const crossingScore = p.crossings * 120;
      const freshCellScore = newCells * 22;
      const openingScore = sideOpenings * 7 + doubleSideOpenings * 10;
      const lengthBonus =
        wlen >= 5 && wlen <= 8 ? 18 : wlen === 4 ? 8 : wlen >= 9 ? 6 : 0;

      return (
        crossingScore +
        freshCellScore +
        openingScore +
        lengthBonus -
        distancePenalty -
        edgePenalty
      );
    };

          const collectPlacements = (word: string, minCrossesWanted: number) => {
      const letters = filled();

      type Cand = {
        row: number;
        col: number;
        dir: Direction;
        crossings: number;
        score: number;
      };

      const placements: Cand[] = [];

      for (let i = 0; i < word.length; i++) {
        const ch = word[i];

        for (const cell of letters) {
          if (cell.ch !== ch) continue;

          const rowA = cell.r;
          const colA = cell.c - i;
          const checkA = canPlaceWord(grid, word, rowA, colA, "across");

          if (checkA.ok && checkA.crossings >= minCrossesWanted) {
            const base = {
              row: rowA,
              col: colA,
              dir: "across" as Direction,
              crossings: checkA.crossings,
            };
            placements.push({ ...base, score: placementScore(base, word.length) });
          } else if (!checkA.ok && checkA.reason) {
            rejectReasonCounts.set(
              checkA.reason,
              (rejectReasonCounts.get(checkA.reason) ?? 0) + 1
            );
          }

          const rowD = cell.r - i;
          const colD = cell.c;
          const checkD = canPlaceWord(grid, word, rowD, colD, "down");

          if (checkD.ok && checkD.crossings >= minCrossesWanted) {
            const base = {
              row: rowD,
              col: colD,
              dir: "down" as Direction,
              crossings: checkD.crossings,
            };
            placements.push({ ...base, score: placementScore(base, word.length) });
          } else if (!checkD.ok && checkD.reason) {
            rejectReasonCounts.set(
              checkD.reason,
              (rejectReasonCounts.get(checkD.reason) ?? 0) + 1
            );
          }
        }
      }

      const seen = new Set<string>();
      const unique = placements.filter((p) => {
        const key = `${p.row}:${p.col}:${p.dir}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      unique.sort((a, b) => b.score - a.score);
      return unique;
    };

    const collectPlacementsLoose = (word: string, minCrossesWanted: number) => {
      type Cand = {
        row: number;
        col: number;
        dir: Direction;
        crossings: number;
        score: number;
      };

      const out: Cand[] = [];

      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
          for (const dir of ["across", "down"] as const) {
            const scratch = grid.map((r) => r.slice()) as Cell[][];
            const wrote = tryWriteWordLoose(scratch, word, row, col, dir);
            if (!wrote.ok) continue;
            if (wrote.crossings < minCrossesWanted) continue;

            let sideOpenings = 0;
            for (let i = 0; i < word.length; i++) {
              const rr = dir === "down" ? row + i : row;
              const cc = dir === "across" ? col + i : col;
              if (grid[rr][cc] !== "") continue;

              if (dir === "across") {
                if (rr > 0 && grid[rr - 1][cc] === "") sideOpenings++;
                if (rr < size - 1 && grid[rr + 1][cc] === "") sideOpenings++;
              } else {
                if (cc > 0 && grid[rr][cc - 1] === "") sideOpenings++;
                if (cc < size - 1 && grid[rr][cc + 1] === "") sideOpenings++;
              }
            }

            const centerBias =
              Math.abs(row - Math.floor(size / 2)) + Math.abs(col - Math.floor(size / 2));

            out.push({
              row,
              col,
              dir,
              crossings: wrote.crossings,
              score:
                wrote.crossings * 110 +
                wrote.newCells * 16 +
                sideOpenings * 7 +
                (size - centerBias) * 4 +
                (word.length >= 5 && word.length <= 8 ? 24 : 0),
            });
          }
        }
      }

      const seen = new Set<string>();
      const unique = out.filter((p) => {
        const key = `${p.row}:${p.col}:${p.dir}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      unique.sort((a, b) => b.score - a.score);
      return unique;
    };

const commitPlacementChecked = (
  word: string,
  row: number,
  col: number,
  dir: Direction
): boolean => {
  const evalResult = evaluateLoosePlacement(word, row, col, dir);
  if (!evalResult) return false;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      grid[r][c] = evalResult.scratch[r][c];
    }
  }

  return true;
};

const tryPlaceOne = (word: string): boolean => {
  if (size === 11 && !nonFillerWords.has(word) && word.length <= 3) {
    return false;
  }

  const minCrossesWanted =
    size === 11
      ? placed.length < 11
        ? 1
        : 2
      : placed.length < 3
      ? 1
      : 2;

  let placements = collectPlacements(word, minCrossesWanted);

  if (placements.length === 0 && minCrossesWanted > 1 && size !== 11) {
    placements = collectPlacements(word, 1);
  }

  if (placements.length === 0 && (size !== 11 || minCrossesWanted <= 1)) {
    placements = collectPlacementsLoose(word, Math.max(1, minCrossesWanted - 1));
  }

  if (placements.length === 0) return false;

  const candidatesToTry = placements.slice(0, Math.min(size === 11 ? 24 : 14, placements.length));

  const evaluatedCandidates = candidatesToTry
    .map((p) => {
      const evalResult = evaluateLoosePlacement(word, p.row, p.col, p.dir);
      if (!evalResult) return null;
      return { placement: p, evalResult };
    })
    .filter((item): item is { placement: typeof placements[number]; evalResult: NonNullable<ReturnType<typeof evaluateLoosePlacement>> } => Boolean(item))
    .sort((a, b) => b.evalResult.score - a.evalResult.score);

  for (const { placement: p, evalResult } of evaluatedCandidates) {
    if (!nowOk()) return false;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        grid[r][c] = evalResult.scratch[r][c];
      }
    }
    placed.push({ word, row: p.row, col: p.col, dir: p.dir });
    used.add(word);
    return true;
  }

  return false;
};

const buildSecondAnchorOrder = () => {
  const candidatesForSecondAnchor = words
    .filter((w) => w !== seedWord && !used.has(w))
    .filter((w) => {
      if (size !== 11) return true;
      return w.length >= 4 && w.length <= 8;
    });

  return candidatesForSecondAnchor
    .slice()
    .sort((a, b) => {
      const aTheme = nonFillerWords.has(a) ? 1 : 0;
      const bTheme = nonFillerWords.has(b) ? 1 : 0;
      if (aTheme !== bTheme) return bTheme - aTheme;

      const rank = (w: string) => {
        if (w.length >= 5 && w.length <= 7) return 500;
        if (w.length === 8) return 420;
        if (w.length === 4) return 300;
        if (w.length === 9) return 180;
        if (w.length >= 10) return 60;
        return 0;
      };

      return rank(b) - rank(a) || a.length - b.length;
    });
};

const tryPlaceSecondAnchor = (): boolean => {
  let best:
    | {
        word: string;
        row: number;
        col: number;
        dir: Direction;
        score: number;
      }
    | null = null;

  for (const word of buildSecondAnchorOrder()) {
    const placements = collectPlacements(word, 1);
    if (placements.length === 0) continue;

    for (const p of placements.slice(0, Math.min(18, placements.length))) {
      const viability = estimateSeedFollowups(word, p.row, p.col, p.dir);
      if (viability < 2) continue;

      let newCells = 0;
      for (let i = 0; i < word.length; i++) {
        const rr = p.dir === "down" ? p.row + i : p.row;
        const cc = p.dir === "across" ? p.col + i : p.col;
        if (grid[rr][cc] === "") newCells++;
      }

      const thematicBonus = nonFillerWords.has(word) ? 60 : 0;
      const lengthBonus =
        word.length >= 5 && word.length <= 8 ? 40 :
        word.length === 4 ? 20 :
        word.length === 9 ? 14 :
        -10;

      const finalScore =
        p.score +
        thematicBonus +
        lengthBonus +
        viability * 120 +
        newCells * 18;

      if (!best || finalScore > best.score) {
        best = {
          word,
          row: p.row,
          col: p.col,
          dir: p.dir,
          score: finalScore,
        };
      }
    }
  }

if (!best) return false;

const committed = commitPlacementChecked(best.word, best.row, best.col, best.dir);
if (!committed) return false;

placed.push({
  word: best.word,
  row: best.row,
  col: best.col,
  dir: best.dir,
});
used.add(best.word);

  console.warn("[freeform] second anchor placed", {
    word: best.word,
    row: best.row,
    col: best.col,
    dir: best.dir,
    letters: countLetters(grid),
  });

  return true;
};

const extraAnchors = size === 11 ? 2 : 1;

for (let k = 0; k < extraAnchors; k++) {
  if (!nowOk()) break;
  if (placed.length >= maxPlaced) break;

  const added = tryPlaceSecondAnchor();
  if (!added) break;
}

const rest = words.filter((w) => w !== seedWord);

const buildGlobalOrder = () => {
  const remaining = rest.filter((w) => !used.has(w));

  return remaining
    .slice()
    .sort((a, b) => {
      const aTheme = nonFillerWords.has(a) ? 1 : 0;
      const bTheme = nonFillerWords.has(b) ? 1 : 0;
      if (aTheme !== bTheme) return bTheme - aTheme;

      const rank = (w: string) => {
        if (placed.length < 6) {
          if (w.length >= 5 && w.length <= 7) return 500;
          if (w.length === 8) return 380;
          if (w.length === 4) return 260;
          if (w.length === 9) return 180;
          return 80;
        }

        if (w.length >= 4 && w.length <= 6) return 520;
        if (w.length === 7) return 360;
        if (w.length === 8) return 200;
        if (w.length >= 9) return 80;
        return 0;
      };

      return rank(b) - rank(a) || a.length - b.length;
    });
};

const placeBestNextWord = (): boolean => {
  const order = buildGlobalOrder();

  for (const word of order) {
    if (!nowOk()) return false;
    if (used.has(word)) continue;
    if (placed.length >= maxPlaced) return false;

    const placedOne = tryPlaceOne(word);
    if (placedOne) return true;
  }

  return false;
};

const maxMainIterations = size === 11 ? 120 : size === 9 ? 22 : 48;

for (let iter = 0; iter < maxMainIterations; iter++) {
  if (!nowOk()) break;
  if (placed.length >= maxPlaced) break;

  const placedOne = placeBestNextWord();
  if (!placedOne) break;
}

const tryFillSlots = () => {
  let totalAdded = 0;
  let fillIterations = 0;
  let wordsScanned = 0;
  let placementsSeen = 0;
  let placementsTried = 0;

  let zeroSharedLettersCount = 0;
  let zeroPlacementsCount = 0;
  let placeFailuresCount = 0;
  let successCount = 0;

  const zeroSharedSamples: Array<Record<string, unknown>> = [];
  const zeroPlacementSamples: Array<Record<string, unknown>> = [];
  const placeFailureSamples: Array<Record<string, unknown>> = [];
  const successSamples: Array<Record<string, unknown>> = [];

  const remainingWords = () =>
    rest.filter((w) => !used.has(w) && w.length >= (size === 11 ? 4 : minEntryLenForSize(size)));

  const buildWaveOrder = (
    words: string[],
    wave: "long-first" | "medium-first" | "short-first"
  ) => {
    const thematic: string[] = [];
    const filler: string[] = [];

    for (const w of words) {
      if (nonFillerWords.has(w)) thematic.push(w);
      else filler.push(w);
    }

    const rank = (w: string) => {
      if (size !== 11) {
        return 100 + (20 - w.length);
      }

      if (wave === "long-first") {
        if (w.length >= 6 && w.length <= 8) return 500 + (20 - w.length);
        if (w.length === 9) return 420;
        if (w.length === 5) return 320;
        if (w.length === 4) return 220;
        if (w.length >= 10) return 180;
        return 100;
      }

      if (wave === "medium-first") {
        if (w.length >= 5 && w.length <= 7) return 520 + (20 - w.length);
        if (w.length === 8) return 420;
        if (w.length === 4) return 340;
        if (w.length === 9) return 220;
        if (w.length >= 10) return 120;
        return 100;
      }

      if (w.length === 4) return 560;
      if (w.length === 5) return 520;
      if (w.length === 6) return 430;
      if (w.length === 7) return 320;
      if (w.length === 8) return 180;
      return 100;
    };

    thematic.sort((a, b) => rank(b) - rank(a) || b.length - a.length);
    filler.sort((a, b) => rank(b) - rank(a) || b.length - a.length);

    return [...thematic, ...filler];
  };

  const waves: Array<"long-first" | "medium-first" | "short-first"> =
    size === 11
      ? ["long-first", "medium-first", "short-first", "medium-first", "short-first"]
      : ["medium-first", "short-first"];

  const passes = size === 11 ? 10 : size === 9 ? 5 : 7;

  const getGridLetters = () => {
    const letters = new Set<string>();
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const v = grid[r][c];
        if (typeof v === "string" && v !== "" && v !== "#") {
          letters.add(v);
        }
      }
    }
    return letters;
  };

  const countSharedLettersWithGrid = (word: string) => {
    const gridLetters = getGridLetters();
    const uniqLetters = new Set(word.split(""));
    let shared = 0;
    for (const ch of uniqLetters) {
      if (gridLetters.has(ch)) shared++;
    }
    return {
      shared,
      gridLetters: Array.from(gridLetters).sort().join(""),
      wordLetters: Array.from(uniqLetters).sort().join(""),
    };
  };

const collectPlacementsForFill = (word: string, minCrossesWanted: number) => {
  type Cand = {
    row: number;
    col: number;
    dir: Direction;
    crossings: number;
    score: number;
  };

  const out: Cand[] = [];

  const tryCandidate = (row: number, col: number, dir: Direction) => {
    let crossings = 0;
    let newCells = 0;

    for (let i = 0; i < word.length; i++) {
      const rr = dir === "down" ? row + i : row;
      const cc = dir === "across" ? col + i : col;

      if (!inBounds(size, rr, cc)) return;

      const cur = grid[rr][cc];
      const ch = word[i];

      if (cur === "#") return;
      if (cur !== "" && cur !== ch) return;

      if (cur === ch) crossings += 1;
      if (cur === "") newCells += 1;
    }

    if (crossings < minCrossesWanted) return;
    if (newCells === 0) return;

    const centerBias =
      Math.abs(row - Math.floor(size / 2)) + Math.abs(col - Math.floor(size / 2));

    let sideOpenings = 0;
    for (let i = 0; i < word.length; i++) {
      const rr = dir === "down" ? row + i : row;
      const cc = dir === "across" ? col + i : col;
      if (grid[rr][cc] !== "") continue;

      if (dir === "across") {
        if (rr > 0 && grid[rr - 1][cc] === "") sideOpenings++;
        if (rr < size - 1 && grid[rr + 1][cc] === "") sideOpenings++;
      } else {
        if (cc > 0 && grid[rr][cc - 1] === "") sideOpenings++;
        if (cc < size - 1 && grid[rr][cc + 1] === "") sideOpenings++;
      }
    }

    const score =
      crossings * 120 +
      newCells * 18 +
      sideOpenings * 8 +
      (size - centerBias) * 4 +
      (word.length >= 5 && word.length <= 8 ? 20 : 0);

    out.push({ row, col, dir, crossings, score });
  };

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      tryCandidate(r, c, "across");
      tryCandidate(r, c, "down");
    }
  }

  const seen = new Set<string>();
  const unique = out.filter((p) => {
    const key = `${p.row}:${p.col}:${p.dir}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => b.score - a.score);
  return unique;
};

  for (let pass = 0; pass < passes; pass++) {
    if (!nowOk()) break;
    if (placed.length >= maxPlaced) break;

    fillIterations++;

    let addedThisPass = 0;

    for (const wave of waves) {
      if (!nowOk()) break;
      if (placed.length >= maxPlaced) break;

      const words = buildWaveOrder(remainingWords(), wave);

      for (const w of words) {
        if (!nowOk()) break;
        if (used.has(w)) continue;
        if (placed.length >= maxPlaced) break;

        wordsScanned++;

        const isThematic = nonFillerWords.has(w);

        const minCrossesWanted = size === 11 && placed.length >= 14 ? 2 : 1;

        const sharedInfo = countSharedLettersWithGrid(w);

        if (sharedInfo.shared === 0) {
          zeroSharedLettersCount++;
          if (zeroSharedSamples.length < 12) {
            zeroSharedSamples.push({
              pass,
              wave,
              word: w,
              len: w.length,
              thematic: isThematic,
              minCrossesWanted,
              sharedLetters: 0,
              wordLetters: sharedInfo.wordLetters,
              gridLetters: sharedInfo.gridLetters,
              placedSoFar: placed.length,
            });
          }
        }

        let placements =
          size === 11
            ? collectPlacements(w, minCrossesWanted)
            : collectPlacementsForFill(w, minCrossesWanted);
        let usedRelaxedCrossRule = false;

        if (placements.length === 0 && minCrossesWanted > 1 && size !== 11) {
          placements = collectPlacementsForFill(w, 1);
          usedRelaxedCrossRule = true;
        }

        if (placements.length === 0 && size === 11) {
          placements = collectPlacementsForFill(w, minCrossesWanted);
        }

        if (placements.length === 0 && (size !== 11 || minCrossesWanted <= 1)) {
          placements = collectPlacementsLoose(w, 1);
        }

        placementsSeen += placements.length;

        if (placements.length === 0) {
          zeroPlacementsCount++;
          if (zeroPlacementSamples.length < 16) {
            zeroPlacementSamples.push({
              pass,
              wave,
              word: w,
              len: w.length,
              thematic: isThematic,
              minCrossesWanted,
              usedRelaxedCrossRule,
              sharedLetters: sharedInfo.shared,
              wordLetters: sharedInfo.wordLetters,
              gridLetters: sharedInfo.gridLetters,
              placedSoFar: placed.length,
            });
          }
          continue;
        }

        const candidatesToTry = placements.slice(
          0,
          Math.min(
            wave === "short-first" ? 32 : wave === "medium-first" ? 28 : 24,
            placements.length
          )
        );

        let placedThisWord = false;

        const scoredCandidates = candidatesToTry
          .map((p) => {
            const evalResult = evaluateLoosePlacement(w, p.row, p.col, p.dir);
            if (!evalResult) return null;
            return { placement: p, evalResult };
          })
          .filter(
            (
              item
            ): item is {
              placement: typeof candidatesToTry[number];
              evalResult: NonNullable<ReturnType<typeof evaluateLoosePlacement>>;
            } => Boolean(item)
          )
          .sort((a, b) => b.evalResult.score - a.evalResult.score);

        const evaluatedCandidates =
          scoredCandidates.length > 0
            ? scoredCandidates
            : size === 11
            ? candidatesToTry.map((placement) => ({ placement, evalResult: null }))
            : [];

        for (const { placement: p, evalResult } of evaluatedCandidates) {
          if (!nowOk()) break;

          const scratch =
            evalResult?.scratch ??
            (() => {
              const candidateGrid = grid.map((row) => row.slice()) as Cell[][];
              const wrote = tryWriteWordLoose(candidateGrid, w, p.row, p.col, p.dir);
              return wrote.ok ? candidateGrid : null;
            })();

          if (!scratch) continue;
          if (size === 11 && !evalResult) {
            const rawGrid = gridToStrings(scratch);
            const rawDerived = deriveEntriesFromGrid(rawGrid, minEntryLenForSize(size));
            const allowedAnswers = allBuildAnswerSet;
            if (
              rawDerived.some((entry) => !allowedAnswers.has(entry.answer)) ||
              !rawDerived.some((entry) => entry.answer === w)
            ) {
              continue;
            }
          }

          placementsTried++;

          for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
              grid[r][c] = scratch[r][c];
            }
          }

          placed.push({ word: w, row: p.row, col: p.col, dir: p.dir });
          used.add(w);
          addedThisPass++;
          totalAdded++;
          placedThisWord = true;
          successCount++;

          if (successSamples.length < 12) {
            successSamples.push({
              pass,
              wave,
              word: w,
              len: w.length,
              thematic: isThematic,
              row: p.row,
              col: p.col,
              dir: p.dir,
              crossings: p.crossings,
              score: p.score,
              placedSoFar: placed.length,
            });
          }

          break;
        }

        if (!placedThisWord && placements.length > 0) {
          placeFailuresCount += placements.length;
        }

        if (!placedThisWord && placements.length > 0 && placeFailureSamples.length < 12) {
          placeFailureSamples.push({
            pass,
            wave,
            word: w,
            len: w.length,
            thematic: isThematic,
            note: "had placements but none could be committed",
          });
        }
      }
    }

    console.warn("[freeform] fill pass summary", {
      pass,
      addedThisPass,
      placedSoFar: placed.length,
      wordsScannedSoFar: wordsScanned,
      placementsSeenSoFar: placementsSeen,
      placementsTriedSoFar: placementsTried,
    });

    if (addedThisPass === 0) break;
  }

  console.warn("[freeform] fill phase", {
    fillIterations,
    wordsScanned,
    placementsSeen,
    placementsTried,
    placedInFillPhase: totalAdded,
    rejectReasons: Object.fromEntries(
      Array.from(rejectReasonCounts.entries()).sort((a, b) => b[1] - a[1])
    ),
    zeroSharedLettersCount,
    zeroPlacementsCount,
    placeFailuresCount,
    successCount,
    zeroSharedSamples,
    zeroPlacementSamples,
    placeFailureSamples,
    successSamples
  });

  return totalAdded;
};

const repairAndDensify11 = () => {
  if (size !== 11) return 0;

  let added = 0;
  const maxRepairPasses = 60;

  const remainingRepairWords = () =>
    rest
      .filter((w) => !used.has(w) && w.length >= 3)
      .sort((a, b) => {
        const aTheme = nonFillerWords.has(a) ? 1 : 0;
        const bTheme = nonFillerWords.has(b) ? 1 : 0;
        if (aTheme !== bTheme) return bTheme - aTheme;

        const rank = (w: string) => {
          if (w.length >= 5 && w.length <= 7) return 600;
          if (w.length === 4) return 520;
          if (w.length === 8) return 420;
          if (w.length === 9) return 220;
          return 120;
        };

        return rank(b) - rank(a) || a.length - b.length;
      });

  for (let pass = 0; pass < maxRepairPasses; pass++) {
    if (!nowOk()) break;
    if (placed.length >= maxPlaced) break;

    const projected = projectGridOutcome(grid);
    const currentStats = entryCrossingStats(
      projected.final,
      projected.derived,
      minEntryLenForSize(size)
    );
    const currentWeakAnswers = new Set(currentStats.weakEntries.map((entry) => entry.answer));
    const weakCellKeys = new Set<string>();

    for (const entry of projected.derived) {
      if (!currentWeakAnswers.has(entry.answer)) continue;
      for (let i = 0; i < entry.answer.length; i++) {
        const r = entry.direction === "down" ? entry.row + i : entry.row;
        const c = entry.direction === "across" ? entry.col + i : entry.col;
        weakCellKeys.add(`${r},${c}`);
      }
    }

    let best:
      | {
          word: string;
          row: number;
          col: number;
          dir: Direction;
          score: number;
          evalResult: NonNullable<ReturnType<typeof evaluateLoosePlacement>>;
          afterWeakCount: number;
          afterEntries: number;
          entryGain: number;
          weakReduction: number;
          weakCrosses: number;
        }
      | null = null;

    for (const word of remainingRepairWords().slice(0, 240)) {
      if (!nowOk()) break;

      const placements = [
        ...collectPlacements(word, 1),
        ...collectPlacementsLoose(word, 1),
      ];
      const seenPlacements = new Set<string>();
      const uniquePlacements = placements.filter((p) => {
        const key = `${p.row}:${p.col}:${p.dir}`;
        if (seenPlacements.has(key)) return false;
        seenPlacements.add(key);
        return true;
      });

      for (const p of uniquePlacements.slice(0, 96)) {
        if (!nowOk()) break;

        let weakCrosses = 0;
        for (let i = 0; i < word.length; i++) {
          const r = p.dir === "down" ? p.row + i : p.row;
          const c = p.dir === "across" ? p.col + i : p.col;
          if (!inBounds(size, r, c)) continue;
          if (grid[r][c] === word[i] && weakCellKeys.has(`${r},${c}`)) weakCrosses++;
        }

        const evalResult = evaluateLoosePlacement(word, p.row, p.col, p.dir);
        if (!evalResult) continue;

        const afterStats = entryCrossingStats(
          evalResult.final,
          evalResult.derived,
          minEntryLenForSize(size)
        );
        const entryGain = evalResult.derived.length - projected.derived.length;
        const weakReduction = currentStats.weakEntries.length - afterStats.weakEntries.length;

        if (currentStats.weakEntries.length > 0) {
          if (weakReduction < -1) continue;
          if (weakReduction === 0 && weakCrosses === 0 && entryGain <= 0) continue;
        } else {
          if (afterStats.weakEntries.length > 0) continue;
          if (entryGain <= 0) continue;
        }

        if (evalResult.derived.length < Math.max(4, projected.derived.length - 1)) continue;

        const score =
          weakReduction * 420000 +
          weakCrosses * 120000 +
          entryGain * 50000 +
          evalResult.derived.length * 7000 +
          evalResult.checkedRatio * 5000 +
          evalResult.nonFillerUsed * 3500 +
          (nonFillerWords.has(word) ? 12000 : 0) +
          p.crossings * 3500 -
          afterStats.weakEntries.length * 35000;

        if (!best || score > best.score) {
          best = {
            word,
            row: p.row,
            col: p.col,
            dir: p.dir,
            score,
            evalResult,
            afterWeakCount: afterStats.weakEntries.length,
            afterEntries: evalResult.derived.length,
            entryGain,
            weakReduction,
            weakCrosses,
          };
        }
      }
    }

    if (!best) break;

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        grid[r][c] = best.evalResult.scratch[r][c];
      }
    }

    placed.push({ word: best.word, row: best.row, col: best.col, dir: best.dir });
    used.add(best.word);
    added++;

    console.warn("[freeform] repair/densify placed", {
      pass,
      word: best.word,
      row: best.row,
      col: best.col,
      dir: best.dir,
      afterEntries: best.afterEntries,
      entryGain: best.entryGain,
      weakReduction: best.weakReduction,
      weakCrosses: best.weakCrosses,
      afterWeakCount: best.afterWeakCount,
    });
  }

  return added;
};

    const fillSlotsAdded = tryFillSlots();
const repairDensifyAdded = repairAndDensify11();
const placedAfterFillSlots = placed.length;

    let blocked = paintBlocks(grid);
    blocked = enforceMinWordLen(blocked, minEntryLenForSize(size));

    const blockedBeforePrune = blocked.map((row) => row.slice());
    const prunedBlocked = pruneDanglingRuns(blocked, minEntryLenForSize(size));
    const derivedBeforePrune = deriveEntriesFromGrid(
      gridToStrings(blockedBeforePrune as (string | null)[][]),
      minEntryLenForSize(size)
    );
    const derivedAfterPrune = deriveEntriesFromGrid(
      gridToStrings(prunedBlocked as (string | null)[][]),
      minEntryLenForSize(size)
    );

    if (
      size === 11 &&
      derivedAfterPrune.length < Math.max(4, derivedBeforePrune.length - 2)
    ) {
      console.warn("[freeform] reject prune-damaged 11x11", {
        before: derivedBeforePrune.length,
        after: derivedAfterPrune.length,
      });
      return null;
    }

    blocked =
      size === 11 ||
      derivedAfterPrune.length >= Math.max(4, Math.floor(derivedBeforePrune.length * 0.6))
        ? prunedBlocked
        : blockedBeforePrune;

    blocked = keepLargestConnectedComponent(blocked);
    blocked = keepLargestConnectedComponent(blocked);

    const final: string[][] = [];

    for (let r = 0; r < size; r++) {
      const row: string[] = [];

      for (let c = 0; c < size; c++) {
        const v = blocked[r][c];

        if (v === "#") {
          row.push("#");
          continue;
        }

        if (typeof v === "string" && v.length === 1) {
          if (/[A-Z]/.test(v)) {
            row.push(v);
            continue;
          }

          if (/[a-z]/.test(v)) {
            row.push(v.toUpperCase());
            continue;
          }

          if (/[0-9]/.test(v)) {
            row.push(v);
            continue;
          }
        }

        row.push("#");
      }

      final.push(row);
    }

const derivedBeforeBlocking = deriveEntriesFromGrid(gridToStrings(grid), minEntryLenForSize(size));
const derived = deriveEntriesFromGrid(final, minEntryLenForSize(size));

if (size === 11 && hasShortLetterRuns(final, minEntryLenForSize(size))) {
  console.warn("[freeform] reject final short runs 11x11", {
    derived: derived.length,
  });
  return null;
}

const allowedAnswersFinal = new Set(candidates.map((c) => c.answer));
const invalidDerived = derived.filter((e) => !allowedAnswersFinal.has(e.answer));

if (invalidDerived.length > 0) {
  console.warn("[freeform] reject invalid derived entries", {
    invalidDerived: invalidDerived.map((e) => ({
      answer: e.answer,
      row: e.row,
      col: e.col,
      len: e.answer.length,
    })),
  });
  return null;
}

const nonFillerSet = new Set(
  candidates.filter((c) => c.source !== "filler").map((c) => c.answer)
);
const nonFillerUsed = derived.filter((e) => nonFillerSet.has(e.answer)).length;
const nonFillerRatio = derived.length ? nonFillerUsed / derived.length : 0;
const checkedStats = checkedCellStats(final, minEntryLenForSize(size));

const usedAnswers = Array.from(new Set(derived.map((e) => e.answer)));

console.warn("[freeform] build summary", {
  placedAfterFillSlots,
  fillSlotsAdded,
  repairDensifyAdded,
  placedFinal: placed.length,
  derivedBeforeBlocking: derivedBeforeBlocking.length,
  derivedAfterBlocking: derived.length,
  usedAnswersFinal: usedAnswers.length,
  densityFinal: crosswordDensityFromGrid(final),
  checkedRatio: checkedStats.ratio,
});

       return {
      grid: final,
      usedAnswers,
      meta: {
        algorithm: "freeform-crossing-then-blocks",
        candidatesCount: candidates.length,
        placedWordsAttempted: placed.length,
        usedAnswers: usedAnswers.length,
        entryCount: derived.length,
        density: crosswordDensityFromGrid(final),
        checkedRatio: checkedStats.ratio,
        buildSeed: localSeed,
        rounds,
        nonFillerRatio,
        repairDensifyAdded,
      },
    };
  };

  let best: BuildResult | null = null;
  let bestScore = -Infinity;

  for (let i = 0; i < maxBuilds; i++) {
    if (deadline && Date.now() > deadline) break;

    const localSeed = (seed ^ ((i + 1) * 0x9e3779b9)) >>> 0;
    const res = buildOnce(localSeed);

    if (!res) {
      console.warn("[freeform] buildOnce returned null", {
        i,
        localSeed,
        size,
        candidates: candidates.length,
        uniq: uniq.length,
      });
      continue;
    }

    const d = (res.meta.density as number) ?? crosswordDensityFromGrid(res.grid);
    const usedCount = res.usedAnswers.length;
    const entryCount = Number(res.meta.entryCount ?? 0);
    const checkedRatio = Number(res.meta.checkedRatio ?? 0);
    const derivedForScore = deriveEntriesFromGrid(res.grid, minEntryLenForSize(size));
    const weakEntryCount = entryCrossingStats(
      res.grid,
      derivedForScore,
      minEntryLenForSize(size)
    ).weakEntries.length;

    // Prioridad real:
    // 1) más entradas derivadas
    // 2) más celdas correctamente cruzadas
    // 3) más respuestas usadas
    // 4) mejor densidad
    const nonFillerRatio = Number(res.meta.nonFillerRatio ?? 0);
    const hasPublishableEntryCount = entryCount >= minPublishEntriesForSize(size);
    const hasPreferredEntryCount = entryCount >= desiredPublishEntriesForSize(size);
    const structurallyClean =
      weakEntryCount === 0 &&
      !hasShortLetterRuns(res.grid, minEntryLenForSize(size)) &&
      checkedRatio >= (size === 11 ? 0.18 : 0.12);
    const score =
      (hasPreferredEntryCount ? 3_000_000 : 0) +
      (hasPublishableEntryCount ? 1_500_000 : 0) +
      (hasPublishableEntryCount && structurallyClean ? 1_500_000 : 0) +
      entryCount * 22000 +
      Math.min(entryCount, desiredPublishEntriesForSize(size)) * 5000 +
      Math.max(0, entryCount - minPublishEntriesForSize(size)) * 8000 +
      checkedRatio * 7000 +
      usedCount * 1500 +
      d * 500 +
      nonFillerRatio * 9000 -
      weakEntryCount * (hasPublishableEntryCount ? 90000 : size === 11 ? 45000 : 12000);

    if (score > bestScore) {
      bestScore = score;
      best = res;
    }

    if (
      entryCount >= (size === 11 ? minPublishEntriesForSize(size) : size === 9 ? 8 : 16) &&
      checkedRatio >= (size === 11 ? 0.18 : 0.6) &&
      weakEntryCount === 0 &&
      usedCount >= (size === 11 ? minPublishEntriesForSize(size) : size === 9 ? 7 : 14) &&
      d >= targetDensity * (size === 11 ? 0.78 : 0.9)
    ) {
      return res;
    }
  }

  return best;
}
