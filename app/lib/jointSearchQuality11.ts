import type { JointCandidate } from "./jointPlacementDomains11";

/** Experimental offline acceptance policy, not a universal interpretation of CWL. */
export type JointQualityPolicy = {
  requireThematicMajority: boolean;
  minimumGeneralScore: number;
  lowScoreThreshold: number;
  maximumLowScoreEntries: number;
  minimumGeneralMedian: number;
  minimumGeneralMean: number;
};

export const DEFAULT_JOINT_QUALITY_POLICY: Readonly<JointQualityPolicy> = Object.freeze({
  requireThematicMajority: true,
  minimumGeneralScore: 20,
  lowScoreThreshold: 50,
  maximumLowScoreEntries: 2,
  minimumGeneralMedian: 50,
  minimumGeneralMean: 55,
});

export function validJointQualityPolicy(policy: JointQualityPolicy): boolean {
  return typeof policy.requireThematicMajority === "boolean" &&
    Number.isInteger(policy.maximumLowScoreEntries) && policy.maximumLowScoreEntries >= 0 &&
    [policy.minimumGeneralScore, policy.lowScoreThreshold, policy.minimumGeneralMedian,
      policy.minimumGeneralMean].every(value => Number.isFinite(value) && value >= 0 && value <= 100);
}

export function validGeneralScore(score: number | undefined): score is number {
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100;
}

export function summarizeJointQuality(candidates: readonly Readonly<JointCandidate>[], threshold = 50) {
  const general = candidates.filter(candidate => !candidate.thematic);
  const scores = general.map(candidate => candidate.score).filter(validGeneralScore).sort((a,b) => a-b);
  return {
    totalEntries: candidates.length,
    thematicEntries: candidates.length-general.length,
    generalEntries: general.length,
    unscoredGeneralEntries: general.length-scores.length,
    lowScoreEntries: scores.filter(score => score < threshold).length,
    minimum: scores[0] ?? null,
    median: scores.length ? (scores[Math.floor((scores.length-1)/2)]+scores[Math.floor(scores.length/2)])/2 : null,
    mean: scores.length ? scores.reduce((sum,score) => sum+score,0)/scores.length : null,
  };
}

/** Only irreversible defects prune partial states. Mean, median and majority can recover. */
export function jointQualityIssue(
  quality: ReturnType<typeof summarizeJointQuality>, policy: JointQualityPolicy, terminal: boolean,
): string | null {
  if (quality.unscoredGeneralEntries) return "general-score-missing-or-invalid";
  if (quality.minimum !== null && quality.minimum < policy.minimumGeneralScore) return "general-score-floor";
  if (quality.lowScoreEntries > policy.maximumLowScoreEntries) return "general-low-score-limit";
  if (!terminal) return null;
  if (policy.requireThematicMajority && quality.thematicEntries*2 <= quality.totalEntries) return "thematic-majority";
  if (quality.median !== null && quality.median < policy.minimumGeneralMedian) return "general-score-median";
  if (quality.mean !== null && quality.mean < policy.minimumGeneralMean) return "general-score-mean";
  return null;
}
