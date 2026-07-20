export type CspSearchPrimaryCause11 =
  | "early-decision-quality"
  | "value-ordering"
  | "slot-selection"
  | "specific-intersection-bottleneck"
  | "large-domains"
  | "quota-pressure"
  | "late-search-conflicts"
  | "mixed"
  | "insufficient-data";

export type CspSearchCausalitySummary11 = {
  primaryCause: CspSearchPrimaryCause11;
  confidence: "low" | "medium" | "high";
  evidence: string[];
  recommendedNextExperiment: string;
};

export type CspSearchCausalityInput11 = {
  totalBacktracks: number;
  maxDepth: number;
  depthWithMostBacktracks: number | null;
  percentageBacktracksTop3Depths: number;
  earlyDecisionFailureRate?: number;
  topCandidateFailureRate?: number;
  firstThreeCandidatesFailureRate?: number;
  topWipeoutIntersectionShare?: number;
  p90SelectedDomainSize?: number;
  quotaPrunes?: number;
  lateBacktrackShare?: number;
  selectedMinimumDomainRate?: number;
};

export function summarizeCspSearchCausality11(input: CspSearchCausalityInput11): CspSearchCausalitySummary11 {
  const evidence: string[] = [];
  if (input.totalBacktracks <= 0) {
    return {
      primaryCause: "insufficient-data",
      confidence: "low",
      evidence: ["No backtracking was recorded."],
      recommendedNextExperiment: "Run the diagnostic on a bank that reaches search and records backtracks.",
    };
  }

  const topDepth = input.depthWithMostBacktracks ?? -1;
  const earlyConcentration = topDepth >= 0 && topDepth <= 4 && input.percentageBacktracksTop3Depths >= 60;
  if (earlyConcentration && (input.earlyDecisionFailureRate ?? 0) >= 0.7) {
    evidence.push(`Backtracks are concentrated early (${input.percentageBacktracksTop3Depths.toFixed(1)}%).`);
    evidence.push(`Early decision failure rate is ${(input.earlyDecisionFailureRate ?? 0).toFixed(2)}.`);
    return {
      primaryCause: "early-decision-quality",
      confidence: "high",
      evidence,
      recommendedNextExperiment: "Add a diagnostic value-ordering experiment for the first five depths.",
    };
  }

  if ((input.topCandidateFailureRate ?? 0) >= 0.8 && (input.firstThreeCandidatesFailureRate ?? 0) >= 0.75) {
    evidence.push(`Top candidate failure rate is ${(input.topCandidateFailureRate ?? 0).toFixed(2)}.`);
    evidence.push(`First-three candidate failure rate is ${(input.firstThreeCandidatesFailureRate ?? 0).toFixed(2)}.`);
    return {
      primaryCause: "value-ordering",
      confidence: "high",
      evidence,
      recommendedNextExperiment: "Test an alternate value ordering using observed failure and neighbor-domain preservation.",
    };
  }

  if ((input.topWipeoutIntersectionShare ?? 0) >= 0.35) {
    evidence.push(`One intersection family explains ${(input.topWipeoutIntersectionShare ?? 0).toFixed(2)} of wipeouts.`);
    return {
      primaryCause: "specific-intersection-bottleneck",
      confidence: "medium",
      evidence,
      recommendedNextExperiment: "Try pattern ranking or candidate ordering that reduces the bottleneck intersection first.",
    };
  }

  if ((input.p90SelectedDomainSize ?? 0) >= 80) {
    evidence.push(`p90 selected domain size is ${input.p90SelectedDomainSize}.`);
    return {
      primaryCause: "large-domains",
      confidence: "medium",
      evidence,
      recommendedNextExperiment: "Test a non-arbitrary domain slimming pass that preserves letter diversity and all thematic candidates.",
    };
  }

  if ((input.quotaPrunes ?? 0) > input.totalBacktracks * 0.25) {
    evidence.push(`Quota prunes are high (${input.quotaPrunes}).`);
    return {
      primaryCause: "quota-pressure",
      confidence: "medium",
      evidence,
      recommendedNextExperiment: "Measure thematic availability by slot before changing the quota or ordering.",
    };
  }

  if ((input.lateBacktrackShare ?? 0) >= 0.5) {
    evidence.push(`Late backtrack share is ${(input.lateBacktrackShare ?? 0).toFixed(2)}.`);
    return {
      primaryCause: "late-search-conflicts",
      confidence: "medium",
      evidence,
      recommendedNextExperiment: "Add stronger lookahead for nearly-complete grids without relaxing constraints.",
    };
  }

  if ((input.selectedMinimumDomainRate ?? 1) < 0.85) {
    evidence.push(`MRV minimum-domain selection rate is ${(input.selectedMinimumDomainRate ?? 0).toFixed(2)}.`);
    return {
      primaryCause: "slot-selection",
      confidence: "medium",
      evidence,
      recommendedNextExperiment: "Audit MRV tie-breaks against observed slot failure rates.",
    };
  }

  return {
    primaryCause: "mixed",
    confidence: "low",
    evidence: ["No single diagnostic signal dominated."],
    recommendedNextExperiment: "Compare value-ordering and domain-size experiments on the same diagnostic fixture.",
  };
}
