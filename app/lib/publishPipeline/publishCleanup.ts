import type { Entry } from "@/app/lib/crosswordTypes";
import { inBounds } from "@/app/lib/crosswordUtils";
import { keepLargestConnectedComponent, pruneDanglingRuns } from "@/app/lib/gridValidation";
import { deriveEntriesFromGrid } from "./deriveEntries";
import type { PublishCleanupPolicies } from "./publishPipelineTypes";

export function pruneMaskedDuplicateAnswers(entries: Entry[]): Entry[] {
  const answers = new Set(entries.map((entry) => entry.answer));
  return entries.filter((entry) => {
    const answer = entry.answer;
    if (answer.length > 3 && answer.endsWith("S") && answers.has(answer.slice(0, -1))) {
      return false;
    }
    return true;
  });
}

export function pruneForbiddenPublishAnswersIfPossible(
  entries: Entry[],
  minEntries: number,
  policies: PublishCleanupPolicies
): Entry[] {
  const pruned = entries.filter((entry) => !policies.isForbiddenPublishAnswer(entry.answer));
  return pruned.length >= minEntries ? pruned : entries;
}

export function blockForbiddenAnswerRuns(
  grid: string[][],
  minLen: number,
  policies: PublishCleanupPolicies
): string[][] {
  let out = grid.map((row) => row.slice());
  const badEntries = deriveEntriesFromGrid(out, minLen).filter((entry) =>
    policies.isForbiddenPublishAnswer(entry.answer)
  );

  if (badEntries.length === 0) return out;

  for (const entry of badEntries) {
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      if (inBounds(out.length, r, c)) out[r][c] = "#";
    }
  }

  out = pruneDanglingRuns(out, minLen);
  out = keepLargestConnectedComponent(out);
  return out;
}

export function createPublishCleanupServices(policies: PublishCleanupPolicies): {
  pruneForbiddenPublishAnswersIfPossible(entries: Entry[], minEntries: number): Entry[];
  blockForbiddenAnswerRuns(grid: string[][], minLen: number): string[][];
} {
  return {
    pruneForbiddenPublishAnswersIfPossible: (entries, minEntries) =>
      pruneForbiddenPublishAnswersIfPossible(entries, minEntries, policies),
    blockForbiddenAnswerRuns: (grid, minLen) => blockForbiddenAnswerRuns(grid, minLen, policies),
  };
}
