import type { Cell, DerivedEntry, Direction, WordCandidate } from "@/app/lib/crosswordTypes";
import { ASCII_A_TO_Z, inBounds, makeSeededRng, shuffleInPlace } from "@/app/lib/crosswordUtils";
import { placeWordWithPolicies } from "../gridConstruction";
import { deriveEntriesFromGrid } from "@/app/lib/publishPipeline";
import {
  blockShortRunsOnly,
  checkedCellStats,
  crossedEntryStats,
  entryCrossingStats,
  gridToStrings,
  hasShortLetterRuns,
  minCrossingsPerEntryForPublish,
  minEntryLenForSize,
  paintBlocks,
} from "@/app/lib/gridValidation";
import type {
  AugmentNoShortGridResult,
  DensifyCleanGrid11Input,
  DensifyCleanGrid11Result,
  ExtendGridWithCrossedPair11Input,
  ExtendGridWithCrossedPair11Result,
  GridEnhancementDependencies,
} from "./gridEnhancementTypes";

export function densifyCleanGrid11(opts: DensifyCleanGrid11Input): DensifyCleanGrid11Result | null {
  const { theme, candidates, targetEntries, seed, deadlineMs, dependencies } = opts;
  const { isForbiddenPublishAnswer, isOverGenericThemeWordForTheme, logger } = dependencies;
  const size = 11;
  const minLen = minEntryLenForSize(size);
  const localDeadlineMs =
    deadlineMs && deadlineMs > Date.now() + 500 ? deadlineMs : Date.now() + 5_000;
  const nowOk = () => Date.now() <= localDeadlineMs;

  let grid = opts.grid.map((row) => row.slice());
  let derived = deriveEntriesFromGrid(grid, minLen);
  const initialEntryCount = derived.length;

  const pruneWeakEntriesForRepair = () => {
    const stats = entryCrossingStats(grid, derived, minLen);
    if (stats.weakEntries.length === 0) return false;
    if (derived.length - stats.weakEntries.length < Math.max(8, targetEntries - 5)) return false;

    const weakAnswers = new Set(stats.weakEntries.map((entry) => entry.answer));
    const nonWeakCellKeys = new Set<string>();
    for (const entry of derived) {
      if (weakAnswers.has(entry.answer)) continue;
      for (let i = 0; i < entry.answer.length; i++) {
        const rr = entry.direction === "down" ? entry.row + i : entry.row;
        const cc = entry.direction === "across" ? entry.col + i : entry.col;
        nonWeakCellKeys.add(`${rr}:${cc}`);
      }
    }

    const next = grid.map((row) => row.slice());
    for (const entry of derived) {
      if (!weakAnswers.has(entry.answer)) continue;
      for (let i = 0; i < entry.answer.length; i++) {
        const rr = entry.direction === "down" ? entry.row + i : entry.row;
        const cc = entry.direction === "across" ? entry.col + i : entry.col;
        if (!nonWeakCellKeys.has(`${rr}:${cc}`)) next[rr][cc] = "#";
      }
    }

    const cleaned = blockShortRunsOnly(next, minLen);
    const cleanedDerived = deriveEntriesFromGrid(cleaned, minLen);
    if (cleanedDerived.length < Math.max(8, targetEntries - 5)) return false;
    if (hasShortLetterRuns(cleaned, minLen)) return false;

    grid = cleaned;
    derived = cleanedDerived;
    logger.warn("[densify-11] pruned weak entries before repair", {
      removed: Array.from(weakAnswers),
      fromEntries: initialEntryCount,
      toEntries: derived.length,
    });
    return true;
  };

  const prunedWeakForRepair = opts.pruneWeakEntries === false ? false : pruneWeakEntriesForRepair();

  const allowedAnswers = new Set<string>([
    ...candidates
      .filter((candidate) => candidate.source !== "filler")
      .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
      .filter((candidate) => candidate.answer.length >= minLen && candidate.answer.length <= size)
      .filter((candidate) => ASCII_A_TO_Z.test(candidate.answer))
      .filter((candidate) => !isForbiddenPublishAnswer(candidate.answer))
      .map((candidate) => candidate.answer),
    ...derived.map((entry) => entry.answer).filter((answer) => !isForbiddenPublishAnswer(answer)),
  ]);

  const thematicAnswers = new Set(
    candidates
      .filter((candidate) => candidate.source !== "filler")
      .filter((candidate) => candidate.thematic)
      .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
      .map((candidate) => candidate.answer)
  );

  const rng = makeSeededRng(seed);
  const orderedWords = Array.from(allowedAnswers)
    .filter((answer) => !derived.some((entry) => entry.answer === answer))
    .sort((a, b) => {
      const aTheme = thematicAnswers.has(a) ? 1 : 0;
      const bTheme = thematicAnswers.has(b) ? 1 : 0;
      if (aTheme !== bTheme) return bTheme - aTheme;
      const aLenFit = a.length >= 4 && a.length <= 7 ? 1 : 0;
      const bLenFit = b.length >= 4 && b.length <= 7 ? 1 : 0;
      if (aLenFit !== bLenFit) return bLenFit - aLenFit;
      return a.length - b.length || a.localeCompare(b);
    });
  shuffleInPlace(orderedWords, rng);
  orderedWords.sort((a, b) => {
    const aTheme = thematicAnswers.has(a) ? 1 : 0;
    const bTheme = thematicAnswers.has(b) ? 1 : 0;
    if (aTheme !== bTheme) return bTheme - aTheme;
    const aLenFit = a.length >= 4 && a.length <= 7 ? 1 : 0;
    const bLenFit = b.length >= 4 && b.length <= 7 ? 1 : 0;
    if (aLenFit !== bLenFit) return bLenFit - aLenFit;
    return a.length - b.length || a.localeCompare(b);
  });

  const added: string[] = [];

  const weakCellKeysFor = (entries: DerivedEntry[], weakAnswers: Set<string>) => {
    const keys = new Set<string>();
    for (const entry of entries) {
      if (!weakAnswers.has(entry.answer)) continue;
      for (let i = 0; i < entry.answer.length; i++) {
        const rr = entry.direction === "down" ? entry.row + i : entry.row;
        const cc = entry.direction === "across" ? entry.col + i : entry.col;
        keys.add(`${rr},${cc}`);
      }
    }
    return keys;
  };

  let currentWeakStats = entryCrossingStats(grid, derived, minLen);
  let currentWeakEntryCount = currentWeakStats.weakEntries.length;
  if (derived.length >= targetEntries && currentWeakEntryCount === 0) return null;

  const countExistingCrossings = (
    source: string[][],
    word: string,
    row: number,
    col: number,
    dir: Direction,
    weakCellKeys: Set<string>
  ) => {
    let crossings = 0;
    let weakCrossings = 0;
    let newCells = 0;

    for (let i = 0; i < word.length; i++) {
      const rr = dir === "down" ? row + i : row;
      const cc = dir === "across" ? col + i : col;
      if (!inBounds(size, rr, cc)) return null;

      const cur = source[rr][cc];
      const ch = word[i];
      if (cur !== "#" && cur !== ch) return null;
      if (cur === ch) {
        crossings++;
        if (weakCellKeys.has(`${rr},${cc}`)) weakCrossings++;
      }
      if (cur === "#") newCells++;
    }

    if (crossings < 1 || newCells < 1) return null;
    return { crossings, weakCrossings, newCells };
  };

  const evaluateInsertion = (word: string, row: number, col: number, dir: Direction) => {
    const currentWeakAnswers = new Set(currentWeakStats.weakEntries.map((entry) => entry.answer));
    const weakCellKeys = weakCellKeysFor(derived, currentWeakAnswers);
    const placement = countExistingCrossings(grid, word, row, col, dir, weakCellKeys);
    if (!placement) return null;
    const stagedRepair =
      currentWeakEntryCount > 0 &&
      placement.crossings === 1 &&
      placement.weakCrossings > 0;
    if (placement.crossings < minCrossingsPerEntryForPublish(size) && !stagedRepair) return null;

    const nextGrid = grid.map((r) => r.slice());
    for (let i = 0; i < word.length; i++) {
      const rr = dir === "down" ? row + i : row;
      const cc = dir === "across" ? col + i : col;
      nextGrid[rr][cc] = word[i];
    }

    const normalizedNextGrid = hasShortLetterRuns(nextGrid, minLen)
      ? blockShortRunsOnly(nextGrid, minLen)
      : nextGrid;
    const nextDerived = deriveEntriesFromGrid(normalizedNextGrid, minLen);
    if (!nextDerived.some((entry) => entry.answer === word)) return null;
    if (nextDerived.some((entry) => !allowedAnswers.has(entry.answer))) return null;
    if (nextDerived.some((entry) => isForbiddenPublishAnswer(entry.answer))) return null;
    const nextWeakStats = entryCrossingStats(normalizedNextGrid, nextDerived, minLen);
    const nextWeakEntryCount = nextWeakStats.weakEntries.length;
    const allowTemporaryWeakRepairStep =
      opts.pruneWeakEntries === false && placement.weakCrossings > 0;
    if (nextWeakEntryCount > currentWeakEntryCount + (allowTemporaryWeakRepairStep ? 1 : 0)) {
      return null;
    }
    if (
      nextDerived.length <= derived.length &&
      nextWeakEntryCount >= currentWeakEntryCount &&
      !(allowTemporaryWeakRepairStep && nextWeakEntryCount <= currentWeakEntryCount)
    ) {
      return null;
    }

    const checked = checkedCellStats(normalizedNextGrid, minLen);
    const thematicCount = nextDerived.filter((entry) => thematicAnswers.has(entry.answer)).length;
    const score =
      (currentWeakEntryCount - nextWeakEntryCount) * 8000 +
      (nextDerived.length - derived.length) * 5000 +
      thematicCount * 900 +
      placement.weakCrossings * 3500 +
      placement.crossings * 350 +
      placement.newCells * 30 +
      checked.ratio * 700;

    return {
      grid: normalizedNextGrid,
      derived: nextDerived,
      score,
      weakEntryCount: nextWeakEntryCount,
      weakStats: nextWeakStats,
      crossings: placement.crossings,
      newCells: placement.newCells,
    };
  };

  for (
    let round = 0;
    round < 12 && nowOk() && (derived.length < targetEntries || currentWeakEntryCount > 0);
    round++
  ) {
    let best:
      | {
          word: string;
          grid: string[][];
          derived: DerivedEntry[];
          score: number;
          weakEntryCount: number;
          weakStats: ReturnType<typeof entryCrossingStats>;
        }
      | null = null;

    for (const word of orderedWords) {
      if (!nowOk()) break;
      if (added.includes(word) || derived.some((entry) => entry.answer === word)) continue;

      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
          for (const dir of ["across", "down"] as const) {
            const candidate = evaluateInsertion(word, row, col, dir);
            if (!candidate) continue;
            if (!best || candidate.score > best.score) {
              best = {
                word,
                grid: candidate.grid,
                derived: candidate.derived,
                score: candidate.score,
                weakEntryCount: candidate.weakEntryCount,
                weakStats: candidate.weakStats,
              };
            }
          }
        }
      }
    }

    if (!best) break;
    grid = best.grid;
    derived = best.derived;
    currentWeakEntryCount = best.weakEntryCount;
    currentWeakStats = best.weakStats;
    added.push(best.word);
  }

  if (added.length === 0 && !prunedWeakForRepair) return null;

  logger.warn("[densify-11] completed", {
    fromEntries: deriveEntriesFromGrid(opts.grid, minLen).length,
    toEntries: derived.length,
    targetEntries,
    added,
    weakEntries: currentWeakEntryCount,
    candidates: allowedAnswers.size,
    deadlineMs: localDeadlineMs - Date.now(),
  });

  return {
    grid,
    derived,
    added,
    meta: {
      densifier: "clean-grid-11",
      densifierAdded: added,
      densifierEntries: derived.length,
    },
  };
}

export function augmentNoShortGridWithCandidates(
  grid: string[][],
  candidates: WordCandidate[],
  minLen: number,
  targetEntries: number,
  minimumReturnEntries = targetEntries,
  dependencies: GridEnhancementDependencies
): AugmentNoShortGridResult | null {
  const { isForbiddenPublishAnswer } = dependencies;
  const placeWord = (
    workingGrid: Cell[][],
    word: string,
    row: number,
    col: number,
    dir: Direction
  ) => placeWordWithPolicies(workingGrid, word, row, col, dir, { isForbiddenPublishAnswer });
  const size = grid.length;
  const candidateAnswers = Array.from(
    new Set(
      candidates
        .map((candidate) => candidate.answer)
        .filter(
          (answer) =>
            answer.length >= minLen &&
            answer.length <= size &&
            ASCII_A_TO_Z.test(answer) &&
            !isForbiddenPublishAnswer(answer)
        )
    )
  );
  if (candidateAnswers.length === 0) return null;
  const candidateByAnswer = new Map(candidates.map((candidate) => [candidate.answer, candidate]));

  const allowedAnswers = new Set([
    ...deriveEntriesFromGrid(grid, minLen).map((entry) => entry.answer),
    ...candidateAnswers,
  ]);

  let working = grid.map((row) => row.map((cell) => (cell === "#" ? "" : cell))) as Cell[][];
  let bestFinal: { grid: string[][]; derived: DerivedEntry[] } | null = null;

  for (let step = 0; step < 12; step++) {
    const currentFinal = gridToStrings(paintBlocks(working) as (string | null)[][]);
    const currentDerived = deriveEntriesFromGrid(currentFinal, minLen);
    const currentWeakCount = entryCrossingStats(currentFinal, currentDerived, minLen).weakEntries.length;
    if (
      !hasShortLetterRuns(currentFinal, minLen) &&
      currentDerived.length >= minimumReturnEntries &&
      !currentDerived.some((entry) => isForbiddenPublishAnswer(entry.answer)) &&
      currentWeakCount === 0
    ) {
      bestFinal = { grid: currentFinal, derived: currentDerived };
      if (currentDerived.length >= targetEntries) break;
    }

    const used = new Set(currentDerived.map((entry) => entry.answer));
    let best:
      | {
          scratch: Cell[][];
          final: string[][];
          derived: DerivedEntry[];
          score: number;
        }
      | null = null;

    for (const answer of candidateAnswers) {
      if (used.has(answer)) continue;
      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
          for (const dir of ["across", "down"] as const) {
            const scratch = working.map((r) => r.slice()) as Cell[][];
            const placed = placeWord(scratch, answer, row, col, dir);
            if (!placed) continue;

            const final = gridToStrings(paintBlocks(scratch) as (string | null)[][]);
            if (hasShortLetterRuns(final, minLen)) continue;

            const derived = deriveEntriesFromGrid(final, minLen);
            if (derived.length <= currentDerived.length) continue;
            if (derived.some((entry) => !allowedAnswers.has(entry.answer))) continue;
            if (derived.some((entry) => isForbiddenPublishAnswer(entry.answer))) continue;
            if (!derived.some((entry) => entry.answer === answer)) continue;
            const nextWeakCount = entryCrossingStats(final, derived, minLen).weakEntries.length;
            if (derived.length >= targetEntries && nextWeakCount > 0) continue;
            if (derived.length < targetEntries && nextWeakCount > currentWeakCount) continue;

            const crossed = crossedEntryStats(final, derived, minLen);
            const checked = checkedCellStats(final, minLen);
            const candidate = candidateByAnswer.get(answer);
            const score =
              derived.length * 10000 +
              crossed.crossed * 1200 +
              Math.max(0, currentWeakCount - nextWeakCount) * 7000 -
              nextWeakCount * 2500 +
              checked.ratio * 800 +
              answer.length * 25 +
              (candidate?.thematic ? 12000 : 0) +
              (candidate?.source === "model" || candidate?.source === "anchor" ? 3000 : 0) -
              (candidate?.source === "support" ? 4500 : 0) -
              derived.filter((entry) => isForbiddenPublishAnswer(entry.answer)).length * 100000;

            if (!best || score > best.score) {
              best = { scratch, final, derived, score };
            }
          }
        }
      }
    }

    if (!best) break;
    working = best.scratch;
    if (best.derived.length >= (bestFinal?.derived.length ?? 0)) {
      bestFinal = { grid: best.final, derived: best.derived };
    }
  }

  if (!bestFinal) return null;
  if (bestFinal.derived.length < minimumReturnEntries) return null;
  if (hasShortLetterRuns(bestFinal.grid, minLen)) return null;
  if (entryCrossingStats(bestFinal.grid, bestFinal.derived, minLen).weakEntries.length > 0) return null;
  return bestFinal;
}

export function extendGridWithCrossedPair11(
  opts: ExtendGridWithCrossedPair11Input
): ExtendGridWithCrossedPair11Result | null {
  const { isForbiddenPublishAnswer } = opts.dependencies;
  const size = 11;
  const minLen = minEntryLenForSize(size);
  const currentDerived = deriveEntriesFromGrid(opts.grid, minLen);
  if (currentDerived.length >= opts.targetEntries) return null;
  const currentWeakCount = entryCrossingStats(opts.grid, currentDerived, minLen).weakEntries.length;

  const currentAnswers = new Set(currentDerived.map((entry) => entry.answer));
  const candidateByAnswer = new Map<string, WordCandidate>();
  for (const candidate of opts.candidates) {
    const answer = candidate.answer;
    if (answer.length < minLen || answer.length > size) continue;
    if (!ASCII_A_TO_Z.test(answer)) continue;
    if (currentAnswers.has(answer)) continue;
    if (isForbiddenPublishAnswer(answer)) continue;
    const prev = candidateByAnswer.get(answer);
    if (
      !prev ||
      (candidate.thematic && !prev.thematic) ||
      (candidate.source === "model" && prev.source !== "model")
    ) {
      candidateByAnswer.set(answer, candidate);
    }
  }

  const allowedAnswers = new Set([...currentAnswers, ...candidateByAnswer.keys()]);
  const rng = makeSeededRng(opts.seed);
  const remaining = Array.from(candidateByAnswer.keys()).sort((a, b) => {
    const ca = candidateByAnswer.get(a);
    const cb = candidateByAnswer.get(b);
    const aTheme = ca?.thematic ? 1 : 0;
    const bTheme = cb?.thematic ? 1 : 0;
    if (aTheme !== bTheme) return bTheme - aTheme;
    const aSource =
      ca?.source === "model" || ca?.source === "anchor" ? 2 : ca?.source === "support" ? 1 : 0;
    const bSource =
      cb?.source === "model" || cb?.source === "anchor" ? 2 : cb?.source === "support" ? 1 : 0;
    if (aSource !== bSource) return bSource - aSource;
    return Math.abs(6 - a.length) - Math.abs(6 - b.length) || a.localeCompare(b);
  });
  shuffleInPlace(remaining, rng);

  let best:
    | {
        grid: string[][];
        derived: DerivedEntry[];
        addedAnswers: string[];
        score: number;
      }
    | null = null;

  const maxWords = Math.min(remaining.length, 48);
  for (let aiw = 0; aiw < maxWords; aiw++) {
    const acrossWord = remaining[aiw];
    for (let diw = 0; diw < maxWords; diw++) {
      const downWord = remaining[diw];
      if (acrossWord === downWord) continue;
      for (let ai = 0; ai < acrossWord.length; ai++) {
        for (let di = 0; di < downWord.length; di++) {
          if (acrossWord[ai] !== downWord[di]) continue;
          for (let crossR = 0; crossR < size; crossR++) {
            for (let crossC = 0; crossC < size; crossC++) {
              const acrossRow = crossR;
              const acrossCol = crossC - ai;
              const downRow = crossR - di;
              const downCol = crossC;
              if (acrossCol < 0 || downRow < 0) continue;
              if (acrossCol + acrossWord.length > size || downRow + downWord.length > size) continue;

              const next = opts.grid.map((row) => row.slice());
              let ok = true;
              let newCells = 0;
              let existingTouches = 0;

              for (let i = 0; i < acrossWord.length && ok; i++) {
                const r = acrossRow;
                const c = acrossCol + i;
                const cur = next[r][c];
                const ch = acrossWord[i];
                if (cur !== "#" && cur !== ch) {
                  ok = false;
                  break;
                }
                if (cur === "#") newCells++;
                else existingTouches++;
                next[r][c] = ch;
              }

              for (let i = 0; i < downWord.length && ok; i++) {
                const r = downRow + i;
                const c = downCol;
                const cur = next[r][c];
                const ch = downWord[i];
                if (cur !== "#" && cur !== ch) {
                  ok = false;
                  break;
                }
                if (cur === "#") newCells++;
                else existingTouches++;
                next[r][c] = ch;
              }

              if (!ok || newCells < 2) continue;

              const normalizedNext = hasShortLetterRuns(next, minLen)
                ? blockShortRunsOnly(next, minLen)
                : next;
              const nextDerived = deriveEntriesFromGrid(normalizedNext, minLen);
              if (nextDerived.length <= currentDerived.length) continue;
              if (!nextDerived.some((entry) => entry.answer === acrossWord)) continue;
              if (!nextDerived.some((entry) => entry.answer === downWord)) continue;
              if (nextDerived.some((entry) => !allowedAnswers.has(entry.answer))) continue;
              if (nextDerived.some((entry) => isForbiddenPublishAnswer(entry.answer))) continue;

              const entryCrossings = entryCrossingStats(normalizedNext, nextDerived, minLen);
              const weakCount = entryCrossings.weakEntries.length;
              if (nextDerived.length >= opts.targetEntries && weakCount > 0) continue;
              if (nextDerived.length < opts.targetEntries && weakCount > currentWeakCount) continue;

              const crossed = crossedEntryStats(normalizedNext, nextDerived, minLen);
              const checked = checkedCellStats(normalizedNext, minLen);
              const themeScore =
                (candidateByAnswer.get(acrossWord)?.thematic ? 1 : 0) +
                (candidateByAnswer.get(downWord)?.thematic ? 1 : 0);
              const weakImprovement = Math.max(0, currentWeakCount - weakCount);
              const score =
                nextDerived.length * 30000 +
                crossed.crossed * 3000 +
                themeScore * 12000 +
                weakImprovement * 18000 -
                weakCount * 12000 +
                checked.ratio * 4000 +
                existingTouches * 500 -
                (Math.abs(crossR - 5) + Math.abs(crossC - 5)) * 50;

              if (!best || score > best.score) {
                best = {
                  grid: normalizedNext,
                  derived: nextDerived,
                  addedAnswers: [acrossWord, downWord],
                  score,
                };
              }
            }
          }
        }
      }
    }
  }

  if (!best) return null;
  const bestWeakCount = entryCrossingStats(best.grid, best.derived, minLen).weakEntries.length;
  if (best.derived.length <= currentDerived.length) return null;
  if (best.derived.length < opts.targetEntries && bestWeakCount > currentWeakCount) return null;
  return best;
}
