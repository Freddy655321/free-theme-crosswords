import type { Cell, Entry } from "@/app/lib/crosswordTypes";
import { inBounds } from "@/app/lib/crosswordUtils";
import {
  checkedCellStats,
  crossedEntryStats,
  enforceMinWordLen,
  gridToStrings,
  hasShortLetterRuns,
  keepLargestConnectedComponent,
  minEntryLenForSize,
  paintBlocks,
  pruneDanglingRuns,
  sanitizeUncheckedGrid,
  shortRunCellKeys,
} from "@/app/lib/gridValidation";
import { deriveEntriesFromGrid } from "@/app/lib/publishPipeline";
import type {
  GridRebuildResult,
  GridReconstructionLanguage,
  GridReconstructionPolicies,
  PublishableGridRebuildResult,
} from "./gridReconstructionTypes";

function makeEmptyRebuildGrid(size: number): Cell[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => ""));
}

function entryKey(entry: Omit<Entry, "clue">): string {
  return `${entry.direction}:${entry.row}:${entry.col}:${entry.answer}`;
}

function rebuildOriginalEntries(
  rebuilt: GridRebuildResult,
  selected: Entry[]
): Entry[] | null {
  const originalMap = new Map(selected.map((entry) => [entryKey(entry), entry]));
  const finalEntries: Entry[] = [];

  for (const derived of rebuilt.derived) {
    const original = originalMap.get(entryKey(derived));
    if (!original) return null;
    finalEntries.push(original);
  }

  return finalEntries;
}

function scorePublishableEntry(
  theme: string,
  language: GridReconstructionLanguage,
  entry: Entry,
  policies: GridReconstructionPolicies
): number {
  let score = 0;
  if (!policies.isPlaceholderClue(entry.clue, language)) score += 100;
  if (policies.specificThematicFallbackClue(theme, entry.answer, language)) score += 40;
  score += Math.min(entry.answer.length, 12);
  return score;
}

export function rebuildGridFromAllowedEntries(
  grid: string[][],
  allowedAnswers: Set<string>,
  minLen: number
): GridRebuildResult | null {
  const derived = deriveEntriesFromGrid(grid, minLen).filter((e) => allowedAnswers.has(e.answer));
  if (derived.length === 0) return null;

  const size = grid.length;
  const scratch = makeEmptyRebuildGrid(size);

  for (const entry of derived) {
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      const ch = entry.answer[i];
      const cur = scratch[r][c];
      if (cur !== "" && cur !== ch) return null;
      scratch[r][c] = ch;
    }
  }

  let blocked = paintBlocks(scratch);
  blocked = enforceMinWordLen(blocked, minLen);
  blocked = pruneDanglingRuns(blocked, minLen);
  blocked = keepLargestConnectedComponent(blocked);
  blocked = keepLargestConnectedComponent(blocked);

  const final = gridToStrings(blocked as (string | null)[][]);
  const finalDerived = deriveEntriesFromGrid(final, minLen);

  if (finalDerived.length === 0) return null;
  if (finalDerived.some((e) => !allowedAnswers.has(e.answer))) return null;

  return { grid: final, derived: finalDerived };
}

export function rebuildGridFromEntries(
  size: number,
  entries: Omit<Entry, "clue">[],
  minLen: number
): GridRebuildResult | null {
  if (entries.length === 0) return null;

  const scratch = makeEmptyRebuildGrid(size);

  for (const entry of entries) {
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      if (!inBounds(size, r, c)) return null;
      const cur = scratch[r][c];
      const ch = entry.answer[i];
      if (cur !== "" && cur !== ch) return null;
      scratch[r][c] = ch;
    }
  }

  let blocked = paintBlocks(scratch);
  blocked = enforceMinWordLen(blocked, minLen);
  blocked = pruneDanglingRuns(blocked, minLen);
  blocked = keepLargestConnectedComponent(blocked);
  blocked = keepLargestConnectedComponent(blocked);

  const final = gridToStrings(blocked as (string | null)[][]);
  const finalDerived = deriveEntriesFromGrid(final, minLen);
  const expectedKeys = new Set(entries.map((e) => entryKey(e)));
  const finalKeys = new Set(finalDerived.map((e) => entryKey(e)));

  for (const key of finalKeys) {
    if (!expectedKeys.has(key)) return null;
  }

  return { grid: final, derived: finalDerived };
}

export function rebuildGridFromEntriesAllowingAllowedDerived(
  size: number,
  entries: Omit<Entry, "clue">[],
  minLen: number,
  allowedAnswers: Set<string>
): GridRebuildResult | null {
  if (entries.length === 0) return null;

  const scratch = makeEmptyRebuildGrid(size);

  for (const entry of entries) {
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      if (!inBounds(size, r, c)) return null;
      const cur = scratch[r][c];
      const ch = entry.answer[i];
      if (cur !== "" && cur !== ch) return null;
      scratch[r][c] = ch;
    }
  }

  let blocked = paintBlocks(scratch);
  blocked = enforceMinWordLen(blocked, minLen);
  blocked = pruneDanglingRuns(blocked, minLen);
  blocked = keepLargestConnectedComponent(blocked);
  blocked = keepLargestConnectedComponent(blocked);

  const final = gridToStrings(blocked as (string | null)[][]);
  const finalDerived = deriveEntriesFromGrid(final, minLen);

  if (finalDerived.length === 0) return null;
  if (finalDerived.some((entry) => !allowedAnswers.has(entry.answer))) return null;

  return { grid: final, derived: finalDerived };
}

export function rebuildPlayableCrossword(
  theme: string,
  size: number,
  entries: Entry[],
  language: GridReconstructionLanguage,
  allowedAnswers: Set<string>,
  policies: GridReconstructionPolicies
): PublishableGridRebuildResult | null {
  const playableEntries = entries.filter((e) => {
    if (!allowedAnswers.has(e.answer)) return false;
    if (policies.isOverGenericThemeWordForTheme(theme, e.answer)) return false;
    if (policies.isPlaceholderClue(e.clue, language)) return false;
    return true;
  });

  if (playableEntries.length === 0) return null;

  const minLen = minEntryLenForSize(size);
  const tryExactRebuild = (selected: Entry[]): PublishableGridRebuildResult | null => {
    const rebuilt = rebuildGridFromEntries(
      size,
      selected.map((entry) => ({
        number: entry.number,
        row: entry.row,
        col: entry.col,
        direction: entry.direction,
        answer: entry.answer,
      })),
      minLen
    );

    if (!rebuilt?.derived || rebuilt.derived.length === 0) return null;

    const finalEntries = rebuildOriginalEntries(rebuilt, selected);
    if (!finalEntries) return null;

    return { grid: rebuilt.grid, entries: finalEntries };
  };

  const sortedPlayable = [...playableEntries].sort(
    (a, b) =>
      scorePublishableEntry(theme, language, b, policies) -
      scorePublishableEntry(theme, language, a, policies)
  );
  const direct = tryExactRebuild(sortedPlayable);
  if (direct) return direct;

  let working = [...sortedPlayable];
  while (working.length >= 4) {
    let improved = false;
    for (let i = working.length - 1; i >= 0; i -= 1) {
      const candidate = working.filter((_, idx) => idx !== i);
      if (candidate.length < 4) continue;
      const rebuilt = tryExactRebuild(candidate);
      if (rebuilt) return rebuilt;
    }

    working = working.slice(0, -1);
    const rebuilt = working.length >= 4 ? tryExactRebuild(working) : null;
    if (rebuilt) return rebuilt;
    improved = true;
    if (!improved) break;
  }

  return null;
}

export function rebuildExactPublishableCrossword(
  theme: string,
  size: number,
  entries: Entry[],
  language: GridReconstructionLanguage,
  allowedAnswers: Set<string>,
  policies: GridReconstructionPolicies,
  minEntries = 3
): PublishableGridRebuildResult | null {
  const selected = entries.filter((e) => {
    if (!allowedAnswers.has(e.answer)) return false;
    if (policies.isOverGenericThemeWordForTheme(theme, e.answer)) return false;
    if (policies.isPlaceholderClue(e.clue, language)) return false;
    return true;
  });

  if (selected.length < minEntries) return null;

  const sorted = [...selected].sort(
    (a, b) =>
      scorePublishableEntry(theme, language, b, policies) -
      scorePublishableEntry(theme, language, a, policies)
  );
  const tryExact = (candidate: Entry[]): PublishableGridRebuildResult | null => {
    const rebuilt = rebuildGridFromEntries(
      size,
      candidate.map((entry) => ({
        number: entry.number,
        row: entry.row,
        col: entry.col,
        direction: entry.direction,
        answer: entry.answer,
      })),
      minEntryLenForSize(size)
    );
    if (!rebuilt?.derived || rebuilt.derived.length < minEntries) return null;

    const finalEntries = rebuildOriginalEntries(rebuilt, candidate);
    if (!finalEntries) return null;

    return { grid: rebuilt.grid, entries: finalEntries };
  };

  const direct = tryExact(sorted);
  if (direct) return direct;

  let working = [...sorted];
  while (working.length >= minEntries) {
    for (let i = working.length - 1; i >= 0; i -= 1) {
      const candidate = working.filter((_, idx) => idx !== i);
      if (candidate.length < minEntries) continue;
      const rebuilt = tryExact(candidate);
      if (rebuilt) return rebuilt;
    }
    working = working.slice(0, -1);
    if (working.length >= minEntries) {
      const rebuilt = tryExact(working);
      if (rebuilt) return rebuilt;
    }
  }

  return null;
}

export function rebuildExactFullyCheckedPublishableCrossword(
  theme: string,
  size: number,
  entries: Entry[],
  language: GridReconstructionLanguage,
  allowedAnswers: Set<string>,
  policies: GridReconstructionPolicies,
  minEntries = 3
): PublishableGridRebuildResult | null {
  const selected = entries.filter((e) => {
    if (!allowedAnswers.has(e.answer)) return false;
    if (policies.isOverGenericThemeWordForTheme(theme, e.answer)) return false;
    if (policies.isPlaceholderClue(e.clue, language)) return false;
    return true;
  });

  if (selected.length < minEntries) return null;

  const minLen = minEntryLenForSize(size);
  const sorted = [...selected].sort(
    (a, b) =>
      scorePublishableEntry(theme, language, b, policies) -
      scorePublishableEntry(theme, language, a, policies)
  );

  const tryExactChecked = (candidate: Entry[]): PublishableGridRebuildResult | null => {
    const rebuilt = rebuildGridFromEntries(
      size,
      candidate.map((entry) => ({
        number: entry.number,
        row: entry.row,
        col: entry.col,
        direction: entry.direction,
        answer: entry.answer,
      })),
      minLen
    );
    if (!rebuilt?.derived || rebuilt.derived.length < minEntries) return null;

    const checked = checkedCellStats(rebuilt.grid, minLen);
    if (checked.total === 0 || checked.checked !== checked.total) return null;

    const finalEntries = rebuildOriginalEntries(rebuilt, candidate);
    if (!finalEntries) return null;

    return { grid: rebuilt.grid, entries: finalEntries };
  };

  const direct = tryExactChecked(sorted);
  if (direct) return direct;

  let working = [...sorted];
  while (working.length >= minEntries) {
    for (let i = working.length - 1; i >= 0; i -= 1) {
      const candidate = working.filter((_, idx) => idx !== i);
      if (candidate.length < minEntries) continue;
      const rebuilt = tryExactChecked(candidate);
      if (rebuilt) return rebuilt;
    }
    working = working.slice(0, -1);
    if (working.length >= minEntries) {
      const rebuilt = tryExactChecked(working);
      if (rebuilt) return rebuilt;
    }
  }

  return null;
}

export function rebuildFullyCheckedPublishableCrossword(
  theme: string,
  size: number,
  grid: string[][],
  language: GridReconstructionLanguage,
  allowedAnswers: Set<string>,
  clueByAnswer: Map<string, string>,
  policies: GridReconstructionPolicies,
  minEntries = 4
): PublishableGridRebuildResult | null {
  const minLen = minEntryLenForSize(size);
  const rebuilt = rebuildGridFromAllowedEntries(grid, allowedAnswers, minLen);
  if (!rebuilt?.derived || rebuilt.derived.length < minEntries) return null;

  const checked = checkedCellStats(rebuilt.grid, minLen);
  if (checked.total === 0 || checked.checked !== checked.total) return null;

  const entries = policies.applyCluesAndOverrides(theme, language, rebuilt.derived, clueByAnswer);
  if (entries.some((e) => policies.isPlaceholderClue(e.clue, language))) return null;

  return { grid: rebuilt.grid, entries };
}

export function rebuildSanitizedFullyCheckedPublishableCrossword(
  theme: string,
  size: number,
  grid: string[][],
  language: GridReconstructionLanguage,
  allowedAnswers: Set<string>,
  clueByAnswer: Map<string, string>,
  policies: GridReconstructionPolicies,
  minEntries: number
): PublishableGridRebuildResult | null {
  const minLen = minEntryLenForSize(size);
  const sanitized = sanitizeUncheckedGrid(grid, minLen);
  const sanitizedDerived = deriveEntriesFromGrid(sanitized, minLen);
  if (sanitizedDerived.length < minEntries) return null;

  return rebuildFullyCheckedPublishableCrossword(
    theme,
    size,
    sanitized,
    language,
    allowedAnswers,
    clueByAnswer,
    policies,
    minEntries
  );
}

export function rebuildNoShortRunPublishableCrossword(
  theme: string,
  size: number,
  entries: Entry[],
  language: GridReconstructionLanguage,
  thematicSet: Set<string>,
  minEntries: number,
  minThematicEntries: number,
  policies: GridReconstructionPolicies
): PublishableGridRebuildResult | null {
  const minLen = minEntryLenForSize(size);
  const usable = entries.filter((entry) => {
    if (policies.isPlaceholderClue(entry.clue, language)) return false;
    if (policies.isLikelyBadAnswer(entry.answer) && !policies.isAlwaysAllowedAnswer(entry.answer)) return false;
    return true;
  });

  if (usable.length < minEntries) return null;

  const scoreEntry = (entry: Entry) => {
    let score = 0;
    if (thematicSet.has(entry.answer)) score += 1000;
    if (policies.specificThematicFallbackClue(theme, entry.answer, language)) score += 250;
    if (!policies.isOverGenericThemeWordForTheme(theme, entry.answer)) score += 120;
    score += Math.min(entry.answer.length, 12);
    return score;
  };

  const sorted = [...usable].sort((a, b) => scoreEntry(b) - scoreEntry(a));
  const seen = new Set<string>();
  const maxStates = 12000;
  let states = 0;

  const tryCandidate = (candidate: Entry[]): PublishableGridRebuildResult | null => {
    const rebuilt = rebuildGridFromEntries(
      size,
      candidate.map((entry) => ({
        number: entry.number,
        row: entry.row,
        col: entry.col,
        direction: entry.direction,
        answer: entry.answer,
      })),
      minLen
    );
    if (!rebuilt) return null;
    if (rebuilt.derived.length < minEntries) return null;
    if (hasShortLetterRuns(rebuilt.grid, minLen)) return null;

    const rebuiltEntries = rebuildOriginalEntries(rebuilt, candidate);
    if (!rebuiltEntries) return null;

    const checked = checkedCellStats(rebuilt.grid, minLen);
    const crossed = crossedEntryStats(rebuilt.grid, rebuiltEntries, minLen);
    const thematicCount = rebuiltEntries.filter((entry) => thematicSet.has(entry.answer)).length;
    if (crossed.crossed < minEntries) return null;
    if (checked.ratio < 0.25) return null;
    if (thematicCount < minThematicEntries) return null;

    return { grid: rebuilt.grid, entries: rebuiltEntries };
  };

  const search = (candidate: Entry[], startDropIndex: number): PublishableGridRebuildResult | null => {
    states++;
    if (states > maxStates) return null;
    if (candidate.length < minEntries) return null;

    const key = candidate.map((entry) => entryKey(entry)).join("|");
    if (seen.has(key)) return null;
    seen.add(key);

    const direct = tryCandidate(candidate);
    if (direct) return direct;

    const rebuiltForDrops = rebuildGridFromEntries(
      size,
      candidate.map((entry) => ({
        number: entry.number,
        row: entry.row,
        col: entry.col,
        direction: entry.direction,
        answer: entry.answer,
      })),
      minLen
    );
    const shortCells = rebuiltForDrops ? shortRunCellKeys(rebuiltForDrops.grid, minLen) : new Set<string>();
    const entryTouchesShortRun = (entry: Entry) => {
      for (let i = 0; i < entry.answer.length; i++) {
        const r = entry.direction === "down" ? entry.row + i : entry.row;
        const c = entry.direction === "across" ? entry.col + i : entry.col;
        if (shortCells.has(`${r},${c}`)) return true;
      }
      return false;
    };
    const dropOrder = candidate
      .map((entry, idx) => ({ entry, idx }))
      .sort((a, b) => {
        const aTouches = entryTouchesShortRun(a.entry) ? 1 : 0;
        const bTouches = entryTouchesShortRun(b.entry) ? 1 : 0;
        if (aTouches !== bTouches) return bTouches - aTouches;
        return scoreEntry(a.entry) - scoreEntry(b.entry);
      })
      .map((item) => item.idx);

    const minDropIndex = Math.max(0, startDropIndex);
    for (const i of dropOrder) {
      if (i < minDropIndex) continue;
      const next = candidate.filter((_, idx) => idx !== i);
      const result = search(next, 0);
      if (result) return result;
    }

    return null;
  };

  return search(sorted, 0);
}
