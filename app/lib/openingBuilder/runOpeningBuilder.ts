import type { DerivedEntry, Direction, WordCandidate } from "@/app/lib/crosswordTypes";
import { ASCII_A_TO_Z, inBounds, makeSeededRng, shuffleInPlace } from "@/app/lib/crosswordUtils";
import {
  checkedCellStats,
  crossedEntryStats,
  crosswordDensityFromGrid,
  entryCrossingStats,
  hasShortLetterRuns,
  minEntryLenForSize,
} from "@/app/lib/gridValidation";
import { deriveEntriesFromGrid } from "@/app/lib/publishPipeline";
import type { OpeningBuilderInput, OpeningBuilderResult } from "./openingBuilderTypes";

export function runOpeningBuilder(opts: OpeningBuilderInput): OpeningBuilderResult | null {
  const { dependencies } = opts;
  const size = 11;
  const minLen = minEntryLenForSize(size);
  const localDeadlineMs =
    opts.deadlineMs && opts.deadlineMs > Date.now() + 500 ? opts.deadlineMs : Date.now() + 18_000;
  const nowOk = () => Date.now() <= localDeadlineMs;
  const rng = makeSeededRng(opts.seed);

  const candidateByAnswer = new Map<string, WordCandidate>();
  for (const candidate of opts.candidates) {
    const answer = candidate.answer;
    if (candidate.source === "filler") continue;
    if (answer.length < minLen || answer.length > size) continue;
    if (!ASCII_A_TO_Z.test(answer)) continue;
    if (dependencies.isForbiddenPublishAnswer(answer)) continue;
    if (dependencies.isOverGenericThemeWordForTheme(opts.theme, answer) && !candidate.thematic) continue;
    const prev = candidateByAnswer.get(answer);
    if (!prev || (candidate.thematic && !prev.thematic)) candidateByAnswer.set(answer, candidate);
  }

  const answers = Array.from(candidateByAnswer.keys());
  if (answers.length < opts.targetEntries) return null;

  const thematicAnswers = new Set(
    Array.from(candidateByAnswer.values())
      .filter((candidate) => candidate.thematic && candidate.source !== "support")
      .map((candidate) => candidate.answer)
  );

  const orderedSeeds = answers
    .slice()
    .sort((a, b) => {
      const aTheme = thematicAnswers.has(a) ? 1 : 0;
      const bTheme = thematicAnswers.has(b) ? 1 : 0;
      if (aTheme !== bTheme) return bTheme - aTheme;
      const aFit = a.length >= 5 && a.length <= 8 ? 1 : 0;
      const bFit = b.length >= 5 && b.length <= 8 ? 1 : 0;
      if (aFit !== bFit) return bFit - aFit;
      return Math.abs(7 - a.length) - Math.abs(7 - b.length);
    })
    .slice(0, Math.min(28, answers.length));
  shuffleInPlace(orderedSeeds, rng);

  const writeWord = (grid: string[][], word: string, row: number, col: number, dir: Direction) => {
    let crossings = 0;
    let newCells = 0;
    for (let i = 0; i < word.length; i++) {
      const r = dir === "down" ? row + i : row;
      const c = dir === "across" ? col + i : col;
      if (!inBounds(size, r, c)) return null;
      const cur = grid[r][c];
      const ch = word[i];
      if (cur !== "#" && cur !== ch) return null;
      if (cur === ch) crossings++;
      if (cur === "#") newCells++;
    }
    if (crossings < 1 || newCells < 1) return null;

    const next = grid.map((r) => r.slice());
    for (let i = 0; i < word.length; i++) {
      const r = dir === "down" ? row + i : row;
      const c = dir === "across" ? col + i : col;
      next[r][c] = word[i];
    }
    return { grid: next, crossings, newCells };
  };

  const allowedAnswers = new Set(answers);

  const tryBuild = (seedWord: string, seedDir: Direction, seedOffset: number) => {
    let grid = Array.from({ length: size }, () => Array.from({ length: size }, () => "#"));
    const seedRow = seedDir === "across" ? Math.floor(size / 2) + seedOffset : Math.floor((size - seedWord.length) / 2);
    const seedCol = seedDir === "across" ? Math.floor((size - seedWord.length) / 2) : Math.floor(size / 2) + seedOffset;
    if (seedRow < 0 || seedCol < 0 || seedRow >= size || seedCol >= size) return null;
    for (let i = 0; i < seedWord.length; i++) {
      const r = seedDir === "down" ? seedRow + i : seedRow;
      const c = seedDir === "across" ? seedCol + i : seedCol;
      if (!inBounds(size, r, c)) return null;
      grid[r][c] = seedWord[i];
    }

    let derived = deriveEntriesFromGrid(grid, minLen);
    const used = new Set<string>([seedWord]);

    for (let round = 0; round < 26 && nowOk() && derived.length < opts.targetEntries; round++) {
      let best:
        | {
            word: string;
            grid: string[][];
            derived: DerivedEntry[];
            score: number;
          }
        | null = null;

      const currentAnswers = new Set(derived.map((entry) => entry.answer));
      const wordOrder = answers
        .filter((answer) => !used.has(answer) && !currentAnswers.has(answer))
        .sort((a, b) => {
          const aTheme = thematicAnswers.has(a) ? 1 : 0;
          const bTheme = thematicAnswers.has(b) ? 1 : 0;
          if (aTheme !== bTheme) return bTheme - aTheme;
          const aFit = a.length >= 4 && a.length <= 7 ? 1 : 0;
          const bFit = b.length >= 4 && b.length <= 7 ? 1 : 0;
          if (aFit !== bFit) return bFit - aFit;
          return a.length - b.length || a.localeCompare(b);
        });

      for (const word of wordOrder) {
        if (!nowOk()) break;
        for (let row = 0; row < size; row++) {
          for (let col = 0; col < size; col++) {
            for (const dir of ["across", "down"] as const) {
              const written = writeWord(grid, word, row, col, dir);
              if (!written) continue;
              if (hasShortLetterRuns(written.grid, minLen)) continue;
              const nextDerived = deriveEntriesFromGrid(written.grid, minLen);
              if (nextDerived.length <= derived.length) continue;
              if (!nextDerived.some((entry) => entry.answer === word)) continue;
              if (nextDerived.some((entry) => !allowedAnswers.has(entry.answer))) continue;
              if (nextDerived.some((entry) => dependencies.isForbiddenPublishAnswer(entry.answer))) continue;

              const crossed = crossedEntryStats(written.grid, nextDerived, minLen);
              const entryCrossings = entryCrossingStats(written.grid, nextDerived, minLen);
              if (
                nextDerived.length >= opts.targetEntries - 1 &&
                entryCrossings.weakEntries.length > 0
              ) {
                continue;
              }
              const checked = checkedCellStats(written.grid, minLen);
              const across = nextDerived.filter((entry) => entry.direction === "across").length;
              const down = nextDerived.length - across;
              const themeCount = nextDerived.filter((entry) => thematicAnswers.has(entry.answer)).length;
              const score =
                nextDerived.length * 20000 +
                themeCount * 6500 +
                crossed.crossed * 1800 +
                checked.ratio * 4500 +
                Math.min(across, down) * 1800 +
                written.crossings * 700 -
                entryCrossings.weakEntries.length * 50000 +
                Math.abs(across - down) * -700 +
                written.newCells * 18;

              if (!best || score > best.score) {
                best = { word, grid: written.grid, derived: nextDerived, score };
              }
            }
          }
        }
      }

      if (!best) break;
      grid = best.grid;
      derived = best.derived;
      used.add(best.word);
    }

    for (let pairRound = 0; pairRound < 4 && nowOk() && derived.length < opts.targetEntries; pairRound++) {
      let bestPair:
        | {
            words: [string, string];
            grid: string[][];
            derived: DerivedEntry[];
            score: number;
          }
        | null = null;
      const currentAnswers = new Set(derived.map((entry) => entry.answer));
      const remaining = answers.filter((answer) => !used.has(answer) && !currentAnswers.has(answer));

      for (const acrossWord of remaining) {
        for (const downWord of remaining) {
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

                  const next = grid.map((r) => r.slice());
                  let ok = true;
                  let newAcrossCells = 0;
                  let newDownCells = 0;

                  for (let i = 0; i < acrossWord.length && ok; i++) {
                    const r = acrossRow;
                    const c = acrossCol + i;
                    const cur = next[r][c];
                    const ch = acrossWord[i];
                    if (cur !== "#" && cur !== ch) {
                      ok = false;
                      break;
                    }
                    if (cur === "#") newAcrossCells++;
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
                    if (cur === "#") newDownCells++;
                    next[r][c] = ch;
                  }

                  if (!ok || newAcrossCells < 1 || newDownCells < 1) continue;
                  if (hasShortLetterRuns(next, minLen)) continue;

                  const nextDerived = deriveEntriesFromGrid(next, minLen);
                  if (nextDerived.length <= derived.length) continue;
                  if (!nextDerived.some((entry) => entry.answer === acrossWord)) continue;
                  if (!nextDerived.some((entry) => entry.answer === downWord)) continue;
                  if (nextDerived.some((entry) => !allowedAnswers.has(entry.answer))) continue;
                  if (nextDerived.some((entry) => dependencies.isForbiddenPublishAnswer(entry.answer))) continue;

                  const entryCrossings = entryCrossingStats(next, nextDerived, minLen);
                  if (
                    nextDerived.length >= opts.targetEntries &&
                    entryCrossings.weakEntries.length > 0
                  ) {
                    continue;
                  }
                  const checked = checkedCellStats(next, minLen);
                  const themeCount = nextDerived.filter((entry) => thematicAnswers.has(entry.answer)).length;
                  const score =
                    nextDerived.length * 25000 +
                    themeCount * 8000 +
                    checked.ratio * 5000 +
                    (thematicAnswers.has(acrossWord) ? 2000 : 0) +
                    (thematicAnswers.has(downWord) ? 2000 : 0) -
                    entryCrossings.weakEntries.length * 90000 -
                    (Math.abs(crossR - 5) + Math.abs(crossC - 5)) * 80;

                  if (!bestPair || score > bestPair.score) {
                    bestPair = {
                      words: [acrossWord, downWord],
                      grid: next,
                      derived: nextDerived,
                      score,
                    };
                  }
                }
              }
            }
          }
        }
      }

      if (!bestPair) break;
      grid = bestPair.grid;
      derived = bestPair.derived;
      used.add(bestPair.words[0]);
      used.add(bestPair.words[1]);
    }

    const entryCrossings = entryCrossingStats(grid, derived, minLen);
    const crossed = crossedEntryStats(grid, derived, minLen);
    const checked = checkedCellStats(grid, minLen);
    const density = crosswordDensityFromGrid(grid);
    const across = derived.filter((entry) => entry.direction === "across").length;
    const down = derived.length - across;
    const themeCount = derived.filter((entry) => thematicAnswers.has(entry.answer)).length;
    const score =
      derived.length * 30000 +
      themeCount * 9000 +
      crossed.crossed * 2200 +
      checked.ratio * 5000 +
      density * 18000 +
      Math.min(across, down) * 2500 -
      entryCrossings.weakEntries.length * 100000 -
      Math.abs(across - down) * 900;

    return { grid, derived, usedAnswers: Array.from(used), score };
  };

  let best:
    | {
        grid: string[][];
        derived: DerivedEntry[];
        usedAnswers: string[];
        score: number;
      }
    | null = null;

  for (const seedWord of orderedSeeds) {
    if (!nowOk()) break;
    for (const dir of ["across", "down"] as const) {
      for (const offset of [0, -1, 1]) {
        const built = tryBuild(seedWord, dir, offset);
        if (!built) continue;
        if (!best || built.score > best.score) best = built;
        if (
          built.derived.length >= opts.targetEntries &&
          crossedEntryStats(built.grid, built.derived, minLen).crossed >= built.derived.length &&
          entryCrossingStats(built.grid, built.derived, minLen).weakEntries.length === 0 &&
          crosswordDensityFromGrid(built.grid) >= 0.4 &&
          !hasShortLetterRuns(built.grid, minLen)
        ) {
          return {
            grid: built.grid,
            derived: built.derived,
            usedAnswers: Array.from(new Set(built.derived.map((entry) => entry.answer))),
            meta: {
              builder: "opening-crossword-11",
              openingSeed: seedWord,
              openingEntries: built.derived.length,
              density: crosswordDensityFromGrid(built.grid),
              openingTargetEntries: opts.targetEntries,
              openingThemeEntries: built.derived.filter((entry) => thematicAnswers.has(entry.answer)).length,
            },
          };
        }
      }
    }
  }

  if (!best || best.derived.length < opts.targetEntries) return null;
  if (crosswordDensityFromGrid(best.grid) < 0.4) return null;
  if (hasShortLetterRuns(best.grid, minLen)) return null;
  if (best.derived.some((entry) => !allowedAnswers.has(entry.answer))) return null;
  if (entryCrossingStats(best.grid, best.derived, minLen).weakEntries.length > 0) return null;

  return {
    grid: best.grid,
    derived: best.derived,
    usedAnswers: Array.from(new Set(best.derived.map((entry) => entry.answer))),
    meta: {
      builder: "opening-crossword-11",
      openingEntries: best.derived.length,
      density: crosswordDensityFromGrid(best.grid),
      openingTargetEntries: opts.targetEntries,
      openingThemeEntries: best.derived.filter((entry) => thematicAnswers.has(entry.answer)).length,
    },
  };
}
