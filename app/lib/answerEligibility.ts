import { normalizeCspAnswer11 } from "./crosswordCspAdapter11";

/** Bounded product exclusions, not a guarantee of universal PG-13 compliance. */
export const ANSWER_ELIGIBILITY_POLICY_VERSION = "wordynamo-pg13-v1";
const EXCLUSIONS: Readonly<Record<string, string>> = Object.freeze({
  RETARD: "Explicit product exclusion: derogatory usage; technical meanings do not override it.",
  DIKE: "Explicit product exclusion: slur usage; technical meanings do not override it.",
  CATPISS: "Explicit product exclusion: vulgar expression.",
});

export function evaluateAnswerEligibility(answer: string) {
  const normalizedAnswer = normalizeCspAnswer11(answer);
  const reason = Object.hasOwn(EXCLUSIONS, normalizedAnswer) ? EXCLUSIONS[normalizedAnswer] : null;
  return { normalizedAnswer, eligible: reason === null, reason, policyVersion: ANSWER_ELIGIBILITY_POLICY_VERSION };
}

/** Preserve record order/metadata and source data; indexing still resolves eligible overlaps. */
export function filterEligibleAnswerCandidates<T extends { answer: string }>(
  source: readonly T[], step: () => void = () => {},
) {
  const candidates: T[] = [];
  const identities = new Set<string>();
  const excluded = new Map<string, { answer: string; reason: string; occurrences: number }>();
  for (const candidate of source) {
    step();
    const decision = evaluateAnswerEligibility(candidate.answer);
    if (decision.normalizedAnswer) identities.add(decision.normalizedAnswer);
    if (decision.reason !== null) {
      const previous = excluded.get(decision.normalizedAnswer);
      excluded.set(decision.normalizedAnswer, {
        answer: decision.normalizedAnswer, reason: decision.reason, occurrences: (previous?.occurrences ?? 0) + 1,
      });
    } else candidates.push(candidate);
  }
  return { candidates, inventory: {
    policyVersion: ANSWER_ELIGIBILITY_POLICY_VERSION,
    sourceCandidateCount: source.length,
    eligibleCandidateCount: candidates.length,
    // Unique nonempty canonical answers; eligibility here is content policy only,
    // not a claim that length, geometry or quality requirements are satisfied.
    sourceInventorySize: identities.size,
    eligibleInventorySize: identities.size - excluded.size,
    exclusions: [...excluded.values()],
  } };
}
