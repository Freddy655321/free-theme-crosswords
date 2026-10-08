import type { Cell, Placement } from "../crosswordTypes";
import { ASCII_A_TO_Z, makeSeededRng, shuffleInPlace } from "../crosswordUtils";
import { canPlaceWord, makeEmptyWorkingGrid, placeWordWithPolicies } from "../gridConstruction";
import { deriveEntriesFromGrid } from "../publishPipeline/deriveEntries";
import { checkedCellStats, crosswordDensityFromGrid, entryCrossingStats, gridToStrings, paintBlocks, runGridValidation } from "../gridValidation";
import type { FreeformBuilderInput, FreeformBuilderResult } from "./freeformBuilderTypes";

export type GridState = {
  grid: Cell[][];
  placements: Placement[];
  used: Set<string>;
  score: number;
  key: string;
  parent: string | null;
};

export const MULTI_STATE_LIMITS = { width: 64, expansions: 2048, depth: 32, children: 24, placementChecks: 30000 } as const;

function stateOf(grid: Cell[][], placements: Placement[], parent: string | null): GridState {
  const final = gridToStrings(paintBlocks(grid));
  const entries = deriveEntriesFromGrid(final, 3);
  const crossings = entryCrossingStats(final, entries, 3);
  const checked = checkedCellStats(final, 3);
  return {
    grid, placements, used: new Set(placements.map(p => p.word)), parent,
    key: final.map(row => row.join("")).join("/"),
    score: entries.length * 1000 - crossings.weakEntries.length * 650 + checked.ratio * 600,
  };
}

export function expandGridState(state: GridState, input: FreeformBuilderInput, words: string[]): GridState[] {
  const children: GridState[] = [];
  const seen = new Set<string>();
  let checks = 0;
  const letters: Array<{ r: number; c: number; ch: string }> = [];
  state.grid.forEach((row, r) => row.forEach((ch, c) => { if (ch && ch !== "#") letters.push({ r, c, ch }); }));
  outer: for (const word of words) {
    if (state.used.has(word)) continue;
    for (let i = 0; i < word.length; i++) for (const cell of letters) {
      if (word[i] !== cell.ch) continue;
      for (const dir of ["across", "down"] as const) {
        if (++checks > MULTI_STATE_LIMITS.placementChecks || (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs)) break outer;
        const row = cell.r - (dir === "down" ? i : 0);
        const col = cell.c - (dir === "across" ? i : 0);
        const placementKey = `${word}:${row}:${col}:${dir}`;
        if (seen.has(placementKey)) continue;
        seen.add(placementKey);
        const legal = canPlaceWord(state.grid, word, row, col, dir);
        if (!legal.ok || legal.crossings === 0 || legal.crossings === word.length) continue;
        const grid = state.grid.map(r => r.slice());
        if (!placeWordWithPolicies(grid, word, row, col, dir, input.dependencies)) continue;
        const child = stateOf(grid, [...state.placements, { word, row, col, dir }], state.key);
        const derived = deriveEntriesFromGrid(gridToStrings(paintBlocks(grid)), 3);
        if (derived.length !== child.placements.length || derived.some(e => !child.used.has(e.answer))) continue;
        children.push(child);
      }
    }
  }
  return children.sort((a, b) => b.score - a.score).slice(0, MULTI_STATE_LIMITS.children);
}

export function retainGridStates(states: GridState[], width: number): GridState[] {
  const seen = new Set<string>();
  return states.sort((a, b) => b.score - a.score).filter(state => {
    if (seen.has(state.key)) return false;
    seen.add(state.key);
    return true;
  }).slice(0, width);
}

export function runMultiState11(input: FreeformBuilderInput, limits: { width?: number; expansions?: number; depth?: number } = {}) {
  const width = Math.max(1, Math.min(MULTI_STATE_LIMITS.width, Math.floor(limits.width ?? MULTI_STATE_LIMITS.width)));
  const maxExpansions = Math.max(0, Math.min(MULTI_STATE_LIMITS.expansions, Math.floor(limits.expansions ?? MULTI_STATE_LIMITS.expansions)));
  const depth = Math.max(0, Math.min(MULTI_STATE_LIMITS.depth, Math.floor(limits.depth ?? MULTI_STATE_LIMITS.depth)));
  const live = () => input.deadlineMs === undefined || Date.now() < input.deadlineMs;
  const words = [...new Set(input.candidates.map(c => c.answer))].filter(w => w.length >= 3 && w.length <= 11 && ASCII_A_TO_Z.test(w) && !input.dependencies.isForbiddenPublishAnswer(w));
  shuffleInPlace(words, makeSeededRng(input.seed));
  let frontier: GridState[] = [];
  let expansions = 0;
  let layers = 0;
  let best: GridState | null = null;
  const prefer = (a: GridState, b: GridState | null) => !b || a.placements.length > b.placements.length || (a.placements.length === b.placements.length && a.score > b.score);
  if (input.size === 11) for (const word of words) {
    if (!live()) break;
    const grid = makeEmptyWorkingGrid(11);
    const row = 5, col = Math.floor((11 - word.length) / 2);
    if (placeWordWithPolicies(grid, word, row, col, "across", input.dependencies)) frontier.push(stateOf(grid, [{ word, row, col, dir: "across" }], null));
  }
  frontier = frontier.slice(0, width);
  for (; layers < depth && frontier.length && expansions < maxExpansions && live(); layers++) {
    const next: GridState[] = [];
    for (const state of frontier) {
      if (prefer(state, best)) best = state;
      if (!live() || expansions >= maxExpansions) break;
      if (state.placements.length >= (input.maxPlacedWords ?? 42)) continue;
      expansions++;
      const children = expandGridState(state, input, words);
      for (const child of children) if (prefer(child, best)) best = child;
      next.push(...children);
    }
    frontier = retainGridStates(next, width);
  }
  let result: FreeformBuilderResult | null = null;
  let publishable = false;
  if (best && best.placements.length >= 2) {
    const grid = gridToStrings(paintBlocks(best.grid));
    const derived = deriveEntriesFromGrid(grid, 3);
    const checkedRatio = checkedCellStats(grid, 3).ratio;
    publishable = runGridValidation({ grid, derived, themeSet: new Set(input.candidates.filter(c => c.thematic).map(c => c.answer)), policies: { isOverGenericThemeWord: () => false } }).accepted;
    result = { grid, usedAnswers: derived.map(e => e.answer), meta: { algorithm: "freeform-crossing-then-blocks", candidatesCount: input.candidates.length, rounds: 28, entryCount: derived.length, placedWordsAttempted: best.placements.length, checkedRatio, density: crosswordDensityFromGrid(grid) } };
  }
  return { result, publishable, frontier, expansions, layers };
}
