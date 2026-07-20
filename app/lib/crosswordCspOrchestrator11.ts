import {
  analyzeCspCompatibility11,
  type CspIntersectionCompatibility11,
} from "./analyzeCspCompatibility11";
import {
  extractSlotsFromPattern11,
  prepareCandidateDomains,
  solveCrosswordPattern11WithReport,
  type CspBuildResult,
  type CspCandidate,
  type CspFailureReason,
  type CspPropagationConflict11,
  type CspPropagationConflictSummaryItem11,
  type CspSearchProfile11,
  type CrosswordSlot,
  type PreparedCandidate,
} from "./crosswordCsp11";
import {
  analyzePattern11,
  rankPatternsForCandidates11,
  type CrosswordPattern11,
  type PatternRank11,
} from "./crosswordPatterns11";

export type CandidateDomainAnalysis11 = {
  requiredByLength: Record<number, number>;
  availableByLength: Record<number, number>;
  missingByLength: Record<number, number>;
  domainSizeBySlot: Record<string, number>;
  initialDomainSizesBySlot: Record<string, number>;
  initialDomainSizesByLength: Record<number, number>;
  emptySlots: string[];
  narrowSlots: string[];
  averageDomainSize: number;
  minimumDomainSize: number;
  emptyDomainStage: "initial" | "propagation" | null;
  emptySlotId: string | null;
  emptySlotLength: number | null;
};

export type CspPatternAttempt11 = {
  patternId: string;
  rankScore: number;
  solved: boolean;
  nodesVisited: number;
  backtracks: number;
  elapsedMs: number;
  requiredByLength: Record<number, number>;
  availableByLength: Record<number, number>;
  missingByLength: Record<number, number>;
  initialDomainSizes: Record<string, number>;
  initialDomainSizesBySlot: Record<string, number>;
  initialDomainSizesByLength: Record<number, number>;
  emptyDomainStage: "initial" | "propagation" | null;
  emptySlotId: string | null;
  emptySlotLength: number | null;
  zeroCompatibilityIntersections: CspIntersectionCompatibility11[];
  weakestIntersections: CspIntersectionCompatibility11[];
  patternCompatibilityScore: number;
  searchProfile?: CspSearchProfile11;
  firstPropagationConflict: CspPropagationConflict11 | null;
  deepestPropagationConflict: CspPropagationConflict11 | null;
  propagationConflictSummary: CspPropagationConflictSummaryItem11[];
  failureReason:
    | "missing-lengths"
    | "empty-domain"
    | "zero-intersection-compatibility"
    | "propagation-empty-domain"
    | "search-exhausted"
    | "node-limit"
    | "deadline"
    | "unsatisfiable"
    | null;
};

export type RankedPatternSolveResult11 = {
  solved: boolean;
  solution: CspBuildResult | null;
  selectedPatternId: string | null;
  attempts: CspPatternAttempt11[];
  requestedTopUpByLength: Record<number, number>;
};

export function analyzeCandidateDomains11(
  pattern: CrosswordPattern11,
  candidates: CspCandidate[]
): CandidateDomainAnalysis11 {
  const analysis = analyzePattern11(pattern.rows);
  const slots = extractSlotsFromPattern11(pattern.rows);
  const prepared = prepareCandidateDomains(slots, candidates);
  const availableByLength = countPreparedByLength(prepared.candidatesByAnswer.values());
  const missingByLength: Record<number, number> = {};
  const initialDomainSizesBySlot = Object.fromEntries(
    slots.map((slot) => [slot.id, prepared.domainsBySlotId.get(slot.id)?.length ?? 0])
  );
  const initialDomainSizesByLength = countPreparedByLength(prepared.candidatesByAnswer.values());

  for (const [lengthKey, required] of Object.entries(analysis.lengthCounts)) {
    const length = Number(lengthKey);
    const available = availableByLength[length] ?? 0;
    const missing = Math.max(0, required - available);
    if (missing > 0) missingByLength[length] = missing;
  }

  const arcDomains = enforceArcConsistency(slots, prepared.domainsBySlotId);
  const domainSizeBySlot = Object.fromEntries(
    slots.map((slot) => [slot.id, arcDomains.get(slot.id)?.length ?? 0])
  );
  const sizes = Object.values(domainSizeBySlot);
  const initialEmptySlot = slots.find((slot) => (prepared.domainsBySlotId.get(slot.id) ?? []).length === 0) ?? null;
  const missingLengthSlot =
    !initialEmptySlot && Object.keys(missingByLength).length > 0
      ? slots.find((slot) => (missingByLength[slot.length] ?? 0) > 0) ?? null
      : null;
  const propagatedEmptySlot =
    !initialEmptySlot && !missingLengthSlot && Object.keys(missingByLength).length === 0
      ? slots.find((slot) => (arcDomains.get(slot.id) ?? []).length === 0) ?? null
      : null;

  return {
    requiredByLength: { ...analysis.lengthCounts },
    availableByLength,
    missingByLength,
    domainSizeBySlot,
    initialDomainSizesBySlot,
    initialDomainSizesByLength,
    emptySlots: Object.entries(domainSizeBySlot)
      .filter(([, size]) => size === 0)
      .map(([slotId]) => slotId),
    narrowSlots: Object.entries(domainSizeBySlot)
      .filter(([, size]) => size > 0 && size <= 2)
      .map(([slotId]) => slotId),
    averageDomainSize: sizes.length > 0 ? sizes.reduce((sum, size) => sum + size, 0) / sizes.length : 0,
    minimumDomainSize: sizes.length > 0 ? Math.min(...sizes) : 0,
    emptyDomainStage: initialEmptySlot || missingLengthSlot ? "initial" : propagatedEmptySlot ? "propagation" : null,
    emptySlotId: initialEmptySlot?.id ?? missingLengthSlot?.id ?? propagatedEmptySlot?.id ?? null,
    emptySlotLength: initialEmptySlot?.length ?? missingLengthSlot?.length ?? propagatedEmptySlot?.length ?? null,
  };
}

export function solveWithRankedPatterns11(opts: {
  patterns: CrosswordPattern11[];
  candidates: CspCandidate[];
  seed?: number;
  deadlineMs?: number;
  maxNodesPerPattern?: number;
  maxPatterns?: number;
  topUpMargin?: number;
  minThematicEntries?: number;
  targetThematicEntries?: number;
}): RankedPatternSolveResult11 {
  const startedAt = Date.now();
  const deadlineAt = opts.deadlineMs ? startedAt + opts.deadlineMs : Number.POSITIVE_INFINITY;
  const ranked = rankPatternsByCompatibility(
    rankPatternsForCandidates11(opts.patterns, opts.candidates),
    opts.candidates
  ).slice(0, opts.maxPatterns ?? opts.patterns.length);
  const attempts: CspPatternAttempt11[] = [];

  for (const item of ranked) {
    const domainAnalysis = analyzeCandidateDomains11(item.pattern, opts.candidates);
    const compatibility = analyzeCspCompatibility11({ pattern: item.pattern, candidates: opts.candidates });
    const baseAttempt = {
      patternId: item.pattern.id,
      rankScore: item.score,
      requiredByLength: domainAnalysis.requiredByLength,
      availableByLength: domainAnalysis.availableByLength,
      missingByLength: domainAnalysis.missingByLength,
      initialDomainSizes: domainAnalysis.domainSizeBySlot,
      initialDomainSizesBySlot: domainAnalysis.initialDomainSizesBySlot,
      initialDomainSizesByLength: domainAnalysis.initialDomainSizesByLength,
      emptyDomainStage: domainAnalysis.emptyDomainStage,
      emptySlotId: domainAnalysis.emptySlotId,
      emptySlotLength: domainAnalysis.emptySlotLength,
      zeroCompatibilityIntersections: compatibility.zeroCompatibilityIntersections,
      weakestIntersections: compatibility.weakestIntersections,
      patternCompatibilityScore: compatibility.patternCompatibilityScore,
      firstPropagationConflict: null,
      deepestPropagationConflict: null,
      propagationConflictSummary: [],
    };

    if (Object.keys(domainAnalysis.missingByLength).length > 0) {
      attempts.push({
        ...baseAttempt,
        solved: false,
        nodesVisited: 0,
        backtracks: 0,
        elapsedMs: 0,
        failureReason: "missing-lengths",
      });
      continue;
    }

    if (compatibility.zeroCompatibilityIntersections.length > 0) {
      const firstZero = compatibility.zeroCompatibilityIntersections[0] ?? null;
      attempts.push({
        ...baseAttempt,
        solved: false,
        nodesVisited: 0,
        backtracks: 0,
        elapsedMs: 0,
        emptyDomainStage: "propagation",
        emptySlotId: firstZero?.slotA ?? null,
        emptySlotLength: findSlotLength(item.pattern, firstZero?.slotA ?? null),
        failureReason: "zero-intersection-compatibility",
      });
      continue;
    }

    if (domainAnalysis.emptySlots.length > 0) {
      attempts.push({
        ...baseAttempt,
        solved: false,
        nodesVisited: 0,
        backtracks: 0,
        elapsedMs: 0,
        failureReason: domainAnalysis.emptyDomainStage === "propagation" ? "propagation-empty-domain" : "empty-domain",
      });
      continue;
    }

    const remainingDeadline = Math.max(0, deadlineAt - Date.now());
    if (remainingDeadline <= 0) {
      attempts.push({
        ...baseAttempt,
        solved: false,
        nodesVisited: 0,
        backtracks: 0,
        elapsedMs: 0,
        failureReason: "deadline",
      });
      break;
    }

    const report = solveCrosswordPattern11WithReport({
      pattern: item.pattern.rows,
      candidates: opts.candidates,
      seed: opts.seed,
      deadlineMs: Math.min(remainingDeadline, opts.deadlineMs ?? remainingDeadline),
      maxNodes: opts.maxNodesPerPattern,
      minThematicEntries: opts.minThematicEntries,
      targetThematicEntries: opts.targetThematicEntries,
    });
    const failureReason = mapFailureReason(report.failureReason);
    attempts.push({
      ...baseAttempt,
      solved: Boolean(report.result),
      nodesVisited: report.stats.nodesVisited,
      backtracks: report.stats.backtracks,
      elapsedMs: report.stats.elapsedMs,
      failureReason,
      emptyDomainStage: report.emptyDomainStage ?? baseAttempt.emptyDomainStage,
      firstPropagationConflict: report.firstPropagationConflict ?? null,
      deepestPropagationConflict: report.deepestPropagationConflict ?? null,
      propagationConflictSummary: report.propagationConflictSummary ?? [],
      searchProfile: report.searchProfile ?? report.stats.searchProfile,
    });

    if (report.result) {
      return {
        solved: true,
        solution: report.result,
        selectedPatternId: item.pattern.id,
        attempts,
        requestedTopUpByLength: {},
      };
    }
  }

  return {
    solved: false,
    solution: null,
    selectedPatternId: null,
    attempts,
    requestedTopUpByLength: computeRequestedTopUp(ranked, opts.candidates, opts.topUpMargin ?? 1),
  };
}

function enforceArcConsistency(
  slots: CrosswordSlot[],
  domains: Map<string, PreparedCandidate[]>
): Map<string, PreparedCandidate[]> {
  const slotById = new Map(slots.map((slot) => [slot.id, slot]));
  const next = new Map<string, PreparedCandidate[]>();
  for (const [slotId, domain] of domains) next.set(slotId, [...domain]);

  let changed = true;
  while (changed) {
    changed = false;
    for (const slot of slots) {
      const domain = next.get(slot.id) ?? [];
      const filtered = domain.filter((candidate) =>
        slot.intersections.every((intersection) => {
          const otherSlot = slotById.get(intersection.otherSlotId);
          if (!otherSlot) return false;
          return (next.get(otherSlot.id) ?? []).some(
            (otherCandidate) =>
              otherCandidate.answer !== candidate.answer &&
              otherCandidate.answer[intersection.otherIndex] === candidate.answer[intersection.ownIndex]
          );
        })
      );
      if (filtered.length !== domain.length) {
        next.set(slot.id, filtered);
        changed = true;
      }
    }
  }

  return next;
}

function computeRequestedTopUp(
  ranked: ReturnType<typeof rankPatternsForCandidates11>,
  candidates: CspCandidate[],
  margin: number
): Record<number, number> {
  if (ranked.length === 0) return {};

  const availableByLength = countUniqueCandidatesByLength(candidates);
  const best = [...ranked].sort((a, b) => {
    const deficitA = weightedDeficit(a.requiredByLength, availableByLength);
    const deficitB = weightedDeficit(b.requiredByLength, availableByLength);
    return deficitA - deficitB || b.score - a.score || a.pattern.id.localeCompare(b.pattern.id);
  })[0];
  if (!best) return {};

  const topUp: Record<number, number> = {};
  for (const [lengthKey, required] of Object.entries(best.requiredByLength)) {
    const length = Number(lengthKey);
    const available = availableByLength[length] ?? 0;
    if (available < required) {
      topUp[length] = required - available + margin;
    } else if (available <= required + margin) {
      topUp[length] = margin;
    }
  }
  return topUp;
}

function weightedDeficit(requiredByLength: Record<number, number>, availableByLength: Record<number, number>): number {
  return Object.entries(requiredByLength).reduce((sum, [lengthKey, required]) => {
    const length = Number(lengthKey);
    return sum + Math.max(0, required - (availableByLength[length] ?? 0)) * (length + 3);
  }, 0);
}

function countPreparedByLength(candidates: Iterable<PreparedCandidate>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const candidate of candidates) out[candidate.answer.length] = (out[candidate.answer.length] ?? 0) + 1;
  return out;
}

function countUniqueCandidatesByLength(candidates: CspCandidate[]): Record<number, number> {
  const byLength = new Map<number, Set<string>>();
  for (const candidate of candidates) {
    const answer = candidate.answer
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!answer) continue;
    const bucket = byLength.get(answer.length) ?? new Set<string>();
    bucket.add(answer);
    byLength.set(answer.length, bucket);
  }
  return Object.fromEntries(Array.from(byLength.entries()).map(([length, answers]) => [length, answers.size]));
}

function mapFailureReason(
  reason: CspFailureReason | null
): CspPatternAttempt11["failureReason"] {
  if (!reason) return null;
  if (
    reason === "node-limit" ||
    reason === "deadline" ||
    reason === "empty-domain" ||
    reason === "initial-empty-domain" ||
    reason === "zero-intersection-compatibility" ||
    reason === "propagation-empty-domain" ||
    reason === "search-exhausted"
  ) {
    return reason === "initial-empty-domain" ? "empty-domain" : reason;
  }
  return "unsatisfiable";
}

function rankPatternsByCompatibility(ranked: PatternRank11[], candidates: CspCandidate[]): PatternRank11[] {
  return [...ranked].sort((a, b) => {
    const compatibilityA = analyzeCspCompatibility11({ pattern: a.pattern, candidates });
    const compatibilityB = analyzeCspCompatibility11({ pattern: b.pattern, candidates });
    return (
      compatibilityA.zeroCompatibilityIntersections.length - compatibilityB.zeroCompatibilityIntersections.length ||
      compatibilityB.patternCompatibilityScore - compatibilityA.patternCompatibilityScore ||
      b.score - a.score ||
      a.pattern.id.localeCompare(b.pattern.id)
    );
  });
}

function findSlotLength(pattern: CrosswordPattern11, slotId: string | null): number | null {
  if (!slotId) return null;
  return extractSlotsFromPattern11(pattern.rows).find((slot) => slot.id === slotId)?.length ?? null;
}
