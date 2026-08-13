import type { BestPartial, BestPartialCandidateInput } from "./bestPartialTypes";

export function createBestPartialCandidate(input: BestPartialCandidateInput): BestPartial | null {
  if (input.derived.length === 0) return null;

  return {
    built: input.built,
    derived: input.derived,
    pool: input.pool,
    notesByAnswer: input.notesByAnswer,
    trustedThematicSet: new Set(input.thematicKeepSet),
    attempt: input.attempt,
    fallbackScore: input.fallbackScore,
  };
}

export function shouldReplaceBestPartial(
  current: BestPartial | null,
  candidate: BestPartial | null,
  minPublishEntries: number
): boolean {
  return (
    !!candidate &&
    (!current ||
      (current.derived.length < minPublishEntries && candidate.derived.length >= minPublishEntries) ||
      ((current.derived.length >= minPublishEntries) === (candidate.derived.length >= minPublishEntries) &&
        candidate.fallbackScore > current.fallbackScore))
  );
}

export function selectBetterBestPartial(
  current: BestPartial | null,
  candidate: BestPartial | null,
  minPublishEntries: number
): BestPartial | null {
  return shouldReplaceBestPartial(current, candidate, minPublishEntries) ? candidate : current;
}
