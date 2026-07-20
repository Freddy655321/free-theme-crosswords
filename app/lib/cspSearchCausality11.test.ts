import assert from "node:assert/strict";
import test from "node:test";

import { summarizeCspSearchCausality11 } from "./cspSearchCausality11";

test("summarizeCspSearchCausality11 detects insufficient data", () => {
  const summary = summarizeCspSearchCausality11({
    totalBacktracks: 0,
    maxDepth: 0,
    depthWithMostBacktracks: null,
    percentageBacktracksTop3Depths: 0,
  });

  assert.equal(summary.primaryCause, "insufficient-data");
});

test("summarizeCspSearchCausality11 detects early decision quality", () => {
  const summary = summarizeCspSearchCausality11({
    totalBacktracks: 100,
    maxDepth: 12,
    depthWithMostBacktracks: 3,
    percentageBacktracksTop3Depths: 75,
    earlyDecisionFailureRate: 0.9,
  });

  assert.equal(summary.primaryCause, "early-decision-quality");
  assert.equal(summary.confidence, "high");
});

test("summarizeCspSearchCausality11 detects value ordering", () => {
  const summary = summarizeCspSearchCausality11({
    totalBacktracks: 100,
    maxDepth: 12,
    depthWithMostBacktracks: 8,
    percentageBacktracksTop3Depths: 30,
    topCandidateFailureRate: 0.95,
    firstThreeCandidatesFailureRate: 0.85,
  });

  assert.equal(summary.primaryCause, "value-ordering");
});

test("summarizeCspSearchCausality11 detects intersection bottlenecks", () => {
  const summary = summarizeCspSearchCausality11({
    totalBacktracks: 100,
    maxDepth: 12,
    depthWithMostBacktracks: 8,
    percentageBacktracksTop3Depths: 30,
    topWipeoutIntersectionShare: 0.5,
  });

  assert.equal(summary.primaryCause, "specific-intersection-bottleneck");
});

test("summarizeCspSearchCausality11 detects large domains", () => {
  const summary = summarizeCspSearchCausality11({
    totalBacktracks: 100,
    maxDepth: 12,
    depthWithMostBacktracks: 8,
    percentageBacktracksTop3Depths: 30,
    p90SelectedDomainSize: 120,
  });

  assert.equal(summary.primaryCause, "large-domains");
});

test("summarizeCspSearchCausality11 detects quota pressure", () => {
  const summary = summarizeCspSearchCausality11({
    totalBacktracks: 100,
    maxDepth: 12,
    depthWithMostBacktracks: 8,
    percentageBacktracksTop3Depths: 30,
    quotaPrunes: 40,
  });

  assert.equal(summary.primaryCause, "quota-pressure");
});

test("summarizeCspSearchCausality11 detects late search conflicts", () => {
  const summary = summarizeCspSearchCausality11({
    totalBacktracks: 100,
    maxDepth: 12,
    depthWithMostBacktracks: 10,
    percentageBacktracksTop3Depths: 30,
    lateBacktrackShare: 0.65,
  });

  assert.equal(summary.primaryCause, "late-search-conflicts");
});

test("summarizeCspSearchCausality11 detects slot selection", () => {
  const summary = summarizeCspSearchCausality11({
    totalBacktracks: 100,
    maxDepth: 12,
    depthWithMostBacktracks: 8,
    percentageBacktracksTop3Depths: 30,
    selectedMinimumDomainRate: 0.5,
  });

  assert.equal(summary.primaryCause, "slot-selection");
});

test("summarizeCspSearchCausality11 falls back to mixed", () => {
  const summary = summarizeCspSearchCausality11({
    totalBacktracks: 100,
    maxDepth: 12,
    depthWithMostBacktracks: 8,
    percentageBacktracksTop3Depths: 30,
    selectedMinimumDomainRate: 1,
  });

  assert.equal(summary.primaryCause, "mixed");
});
