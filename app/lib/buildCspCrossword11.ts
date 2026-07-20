import { adaptCandidatesForCsp11, normalizeCspAnswer11, type CspAdapterInputCandidate } from "./crosswordCspAdapter11";
import {
  buildConstraintTopUpRequestsFromConflicts11,
  type CspConstraintTopUpRequest11,
} from "./crosswordCspConstraintTopUp11";
import { extractSlotsFromPattern11, validatePattern11, type CspBuildResult } from "./crosswordCsp11";
import { solveWithRankedPatterns11, type RankedPatternSolveResult11 } from "./crosswordCspOrchestrator11";
import { CROSSWORD_PATTERNS_11, type CrosswordPattern11 } from "./crosswordPatterns11";
import type { HybridCspCandidate11 } from "./buildHybridCspCandidateReservoir11";

export type IntegratedCspFailureReason11 =
  | "missing-lengths"
  | "empty-domain"
  | "zero-intersection-compatibility"
  | "propagation-empty-domain"
  | "search-exhausted"
  | "unsatisfiable"
  | "node-limit"
  | "deadline"
  | "invalid-solution";

export type IntegratedCspBuildResult11 =
  | {
      ok: true;
      grid: string[][];
      usedAnswers: string[];
      patternId: string;
      meta: Record<string, unknown>;
    }
  | {
      ok: false;
      reason: IntegratedCspFailureReason11;
      meta: Record<string, unknown>;
    };

export type CspTopUpByLength11 = (opts: {
  requestedByLength: Record<number, number>;
  existingAnswers: string[];
  attempt: number;
  deadlineMs: number;
}) => Promise<CspAdapterInputCandidate[]>;

export type CspTopUpByConstraints11 = (opts: {
  requests: CspConstraintTopUpRequest11[];
  existingAnswers: string[];
  attempt: number;
  deadlineMs: number;
}) => Promise<CspAdapterInputCandidate[]>;

export type CspBankAuditEvent11 = {
  stage: string;
  data: Record<string, unknown>;
};

export function isCsp11Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CROSSWORD_CSP_11_ENABLED === "true";
}

export function shouldUseCspDiagnosticOnly(opts: {
  cspEnabled: boolean;
  diagnosticOnly?: boolean | string;
}): boolean {
  return opts.cspEnabled && (opts.diagnosticOnly === true || opts.diagnosticOnly === "true");
}

export async function runCspThenLegacy11<T>(opts: {
  enabled: boolean;
  tryCsp: () => Promise<IntegratedCspBuildResult11>;
  runLegacy: (cspAttempt: IntegratedCspBuildResult11 | null) => Promise<T>;
  useCsp: (csp: Extract<IntegratedCspBuildResult11, { ok: true }>) => Promise<T>;
}): Promise<T> {
  if (!opts.enabled) return opts.runLegacy(null);
  const csp = await opts.tryCsp();
  if (csp.ok) return opts.useCsp(csp);
  return opts.runLegacy(csp);
}

export function deriveCspEntriesFromGrid11(grid: string[][]): Array<{
  row: number;
  col: number;
  direction: "across" | "down";
  answer: string;
}> {
  const entries: Array<{ row: number; col: number; direction: "across" | "down"; answer: string }> = [];
  for (const direction of ["across", "down"] as const) {
    for (let outer = 0; outer < 11; outer++) {
      let inner = 0;
      while (inner < 11) {
        const read = (offset: number) =>
          direction === "across" ? grid[outer]?.[offset] : grid[offset]?.[outer];
        while (inner < 11 && read(inner) === "#") inner++;
        const start = inner;
        let answer = "";
        while (inner < 11 && read(inner) !== "#") {
          const cell = read(inner);
          if (!cell) return [];
          answer += normalizeCspAnswer11(cell);
          inner++;
        }
        if (answer.length > 0) {
          entries.push({
            row: direction === "across" ? outer : start,
            col: direction === "across" ? start : outer,
            direction,
            answer,
          });
        }
      }
    }
  }
  return entries;
}

export function validateCspCrosswordSolution11(opts: {
  theme: string;
  pattern: CrosswordPattern11;
  grid: string[][];
  usedAnswers: string[];
  allowedAnswers: Set<string>;
}): { valid: boolean; issues: string[]; entries: ReturnType<typeof deriveCspEntriesFromGrid11> } {
  const issues: string[] = [];
  const themeNorm = normalizeCspAnswer11(opts.theme);

  if (opts.grid.length !== 11 || opts.grid.some((row) => row.length !== 11)) {
    issues.push("grid-dimensions");
    return { valid: false, issues, entries: [] };
  }

  for (let row = 0; row < 11; row++) {
    for (let col = 0; col < 11; col++) {
      const expected = opts.pattern.rows[row]?.[col];
      const actual = opts.grid[row]?.[col];
      if (expected === "#" && actual !== "#") issues.push(`block-altered:${row}:${col}`);
      if (expected === "." && (!actual || actual === "#")) issues.push(`slot-incomplete:${row}:${col}`);
    }
  }

  const patternValidation = validatePattern11(opts.pattern.rows);
  if (!patternValidation.valid) issues.push("invalid-pattern");

  const slots = patternValidation.slots.length > 0 ? patternValidation.slots : extractSlotsFromPattern11(opts.pattern.rows);
  if (slots.length !== 22) issues.push(`slot-count:${slots.length}`);
  if (slots.filter((slot) => slot.direction === "across").length !== 11) issues.push("across-count");
  if (slots.filter((slot) => slot.direction === "down").length !== 11) issues.push("down-count");
  if (slots.some((slot) => slot.intersections.length < 2)) issues.push("weak-slot-crossings");

  const entries = deriveCspEntriesFromGrid11(opts.grid);
  if (entries.length !== slots.length) issues.push(`entry-count:${entries.length}`);
  if (entries.some((entry) => entry.answer.length < 3)) issues.push("short-run");

  const slotKeys = new Set(slots.map((slot) => `${slot.direction}:${slot.row}:${slot.col}:${slot.length}`));
  for (const entry of entries) {
    if (!slotKeys.has(`${entry.direction}:${entry.row}:${entry.col}:${entry.answer.length}`)) {
      issues.push(`accidental-run:${entry.direction}:${entry.row}:${entry.col}:${entry.answer}`);
    }
  }

  const answers = entries.map((entry) => entry.answer);
  if (new Set(answers).size !== answers.length) issues.push("duplicate-answer");
  if (answers.some((answer) => answer === themeNorm)) issues.push("theme-answer");
  for (const answer of answers) {
    if (!opts.allowedAnswers.has(answer)) issues.push(`out-of-bank:${answer}`);
  }

  const usedSet = new Set(opts.usedAnswers);
  if (usedSet.size !== opts.usedAnswers.length) issues.push("used-answers-duplicate");
  if (usedSet.size !== answers.length || answers.some((answer) => !usedSet.has(answer))) {
    issues.push("used-answers-mismatch");
  }

  const cellDirections = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (let index = 0; index < entry.answer.length; index++) {
      const row = entry.row + (entry.direction === "down" ? index : 0);
      const col = entry.col + (entry.direction === "across" ? index : 0);
      const letter = opts.grid[row]?.[col];
      if (letter !== entry.answer[index]) issues.push(`letter-mismatch:${entry.answer}`);
      const key = `${row}:${col}`;
      const directions = cellDirections.get(key) ?? new Set<string>();
      directions.add(entry.direction);
      cellDirections.set(key, directions);
    }
  }

  for (const entry of entries) {
    let crossings = 0;
    for (let index = 0; index < entry.answer.length; index++) {
      const row = entry.row + (entry.direction === "down" ? index : 0);
      const col = entry.col + (entry.direction === "across" ? index : 0);
      if ((cellDirections.get(`${row}:${col}`)?.size ?? 0) > 1) crossings++;
    }
    if (crossings < 2) issues.push(`entry-crossings:${entry.answer}:${crossings}`);
  }

  return { valid: issues.length === 0, issues, entries };
}

export async function buildCspCrossword11ForEndpoint(opts: {
  theme: string;
  language: "es" | "en";
  candidates: CspAdapterInputCandidate[];
  seed?: number;
  deadlineMs: number;
  topUpByLength?: CspTopUpByLength11;
  topUpByConstraints?: CspTopUpByConstraints11;
  patterns?: CrosswordPattern11[];
  maxTopUpRounds?: number;
  maxNodesPerPattern?: number;
  solverDeadlineMs?: number;
  audit?: (event: CspBankAuditEvent11) => void;
  diagnosticLog?: (event: CspBankAuditEvent11) => void;
  hybrid?: {
    enabled: boolean;
    candidates: HybridCspCandidate11[];
    minThematicEntries: number;
    targetThematicEntries: number;
    thematicCountsByLength: Record<number, number>;
    supportCountsByLength: Record<number, number>;
  };
}): Promise<IntegratedCspBuildResult11> {
  const startedAt = Date.now();
  const totalBudgetMs = Math.max(0, opts.deadlineMs - startedAt);
  const patterns = opts.patterns ?? CROSSWORD_PATTERNS_11;
  const maxTopUpRounds = opts.maxTopUpRounds ?? 2;
  const solverDeadlineMs = opts.solverDeadlineMs ?? 8_000;
  const maxNodesPerPattern = opts.maxNodesPerPattern ?? 800_000;
  let currentCandidates = [...opts.candidates];
  let cspTopUpCalls = 0;
  let cspConstraintTopUpCalls = 0;
  let requestedTopUpByLength: Record<number, number> = {};
  let requestedConstraintTopUps: CspConstraintTopUpRequest11[] = [];
  let lastSolve: RankedPatternSolveResult11 | null = null;
  let candidateCountBeforeTopUp = 0;
  let constraintRequestsGenerated = 0;
  let constraintGroupsReturned = 0;
  let constraintAnswersThematicallyAccepted = 0;
  let constraintAnswersAddedToReservoir = 0;
  let reservoirSizeBeforeConstraintTopUp = 0;
  let reservoirSizeAfterConstraintTopUp = 0;
  let lengthTopUpRaw: Array<Record<string, unknown>> = [];
  let lengthTopUpAccepted: Array<Record<string, unknown>> = [];
  let constraintTopUpRawGroups: Array<Record<string, unknown>> = [];
  let constraintTopUpAccepted: Array<Record<string, unknown>> = [];
  let stoppedBecauseBudgetExhausted = false;
  let initialCompatibility: unknown[] = [];
  let postTopUpCompatibility: unknown[] = [];
  let initialSolveReport: Record<string, unknown> | null = null;
  let finalSolveReport: Record<string, unknown> | null = null;
  let thematicOnlyDiagnostic: Record<string, unknown> | null = null;
  let hybridDiagnostic: Record<string, unknown> | null = null;
  let initialChosenPattern: string | null = null;
  let postTopUpChosenPattern: string | null = null;

  const emitDiagnostic = (stage: string, data: Record<string, unknown>) => {
    opts.diagnosticLog?.({
      stage,
      data: {
        theme: opts.theme,
        language: opts.language,
        elapsedMs: Date.now() - startedAt,
        ...data,
      },
    });
  };

  emitDiagnostic("start", {
    candidateCount: currentCandidates.length,
    patternCount: patterns.length,
    totalBudgetMs,
  });

  for (let round = 0; round <= maxTopUpRounds; round++) {
    const adapted = adaptCandidatesForCsp11({
      theme: opts.theme,
      candidates: currentCandidates,
      patterns,
    });
    opts.audit?.({
      stage: "adapted-candidates",
      data: {
        round,
        inputCount: currentCandidates.length,
        cspCandidateCount: adapted.candidates.length,
        compatibleLengths: adapted.compatibleLengths,
        stats: adapted.stats,
        sample: adapted.candidates.slice(0, 20).map((candidate) => candidate.answer),
      },
    });
    emitDiagnostic("reservoir-ready", {
      attempt: round,
      candidateCount: adapted.candidates.length,
      stats: adapted.stats,
    });
    if (round === 0) candidateCountBeforeTopUp = adapted.candidates.length;

    const remaining = opts.deadlineMs - Date.now();
    if (remaining <= 0) {
      stoppedBecauseBudgetExhausted = true;
      return fail("deadline", { round, adapted, lastSolve });
    }

    const solveDeadline = Math.min(solverDeadlineMs, Math.max(1, remaining));
    emitDiagnostic(round === 0 ? "solve-before" : "solve-after", {
      attempt: round,
      remainingBeforeSolve: remaining,
      solveDeadlineMs: solveDeadline,
    });
    const solve = solveWithRankedPatterns11({
      patterns,
      candidates: adapted.candidates,
      seed: opts.seed,
      deadlineMs: solveDeadline,
      maxNodesPerPattern,
    });
    lastSolve = solve;
    opts.audit?.({
      stage: "pattern-compatibility",
      data: {
        round,
        patterns: solve.attempts.slice(0, 4).map((attempt) => ({
          patternId: attempt.patternId,
          domainSizesByLength: attempt.initialDomainSizesByLength,
          zeroCompatibilityIntersections: attempt.zeroCompatibilityIntersections.length,
          weakestIntersections: attempt.weakestIntersections.slice(0, 5),
          patternCompatibilityScore: attempt.patternCompatibilityScore,
        })),
      },
    });
    const compatibilitySummary = solve.attempts.slice(0, 4).map((attempt) => ({
      patternId: attempt.patternId,
      domainSizesByLength: attempt.initialDomainSizesByLength,
      zeroCompatibilityIntersections: attempt.zeroCompatibilityIntersections.length,
      weakestIntersections: attempt.weakestIntersections.slice(0, 10),
      patternCompatibilityScore: attempt.patternCompatibilityScore,
    }));
    if (round === 0) initialCompatibility = compatibilitySummary;
    else postTopUpCompatibility = compatibilitySummary;
    emitDiagnostic(round === 0 ? "compatibility-before" : "compatibility-after", {
      attempt: round,
      patterns: compatibilitySummary,
    });
    const solveSummary = {
      attempt: round,
      solved: solve.solved,
      selectedPatternId: solve.selectedPatternId,
      failureReason: normalizeFailureReason(solve),
      nodesVisited: solve.attempts.reduce((sum, attempt) => sum + attempt.nodesVisited, 0),
      backtracks: solve.attempts.reduce((sum, attempt) => sum + attempt.backtracks, 0),
      searchProfile: mergeSearchProfiles(
        solve.attempts
          .map((attempt) => attempt.searchProfile)
          .filter((profile): profile is NonNullable<typeof profile> => Boolean(profile))
      ),
      attempts: limitPatternAttemptsForDiagnostic(solve.attempts),
    };
    if (round === 0) {
      initialSolveReport = solveSummary;
      initialChosenPattern = solve.selectedPatternId ?? solve.attempts[0]?.patternId ?? null;
    } else {
      finalSolveReport = solveSummary;
      postTopUpChosenPattern = solve.selectedPatternId ?? solve.attempts[0]?.patternId ?? null;
    }
    emitDiagnostic("search-profile", {
      attempt: round,
      phase: "thematic-only",
      profile: solveSummary.searchProfile,
    });
    opts.audit?.({
      stage: "solve-diagnostics",
      data: {
        round,
        solved: solve.solved,
        selectedPatternId: solve.selectedPatternId,
        requestedTopUpByLength: solve.requestedTopUpByLength,
        attempts: solve.attempts.map((attempt) => ({
          patternId: attempt.patternId,
          rankScore: attempt.rankScore,
          solved: attempt.solved,
          failureReason: attempt.failureReason,
          requiredByLength: attempt.requiredByLength,
          availableByLength: attempt.availableByLength,
          missingByLength: attempt.missingByLength,
          initialDomainSizes: attempt.initialDomainSizes,
          emptyDomainStage: attempt.emptyDomainStage,
          emptySlotId: attempt.emptySlotId,
          emptySlotLength: attempt.emptySlotLength,
          initialDomainSizesBySlot: attempt.initialDomainSizesBySlot,
          initialDomainSizesByLength: attempt.initialDomainSizesByLength,
          zeroCompatibilityIntersections: attempt.zeroCompatibilityIntersections.length,
          weakestIntersections: attempt.weakestIntersections.slice(0, 5),
          patternCompatibilityScore: attempt.patternCompatibilityScore,
          firstPropagationConflict: attempt.firstPropagationConflict,
          deepestPropagationConflict: attempt.deepestPropagationConflict,
          propagationConflictSummary: attempt.propagationConflictSummary,
          nodesVisited: attempt.nodesVisited,
          backtracks: attempt.backtracks,
          elapsedMs: attempt.elapsedMs,
        })),
      },
    });

    if (solve.solved && solve.solution && solve.selectedPatternId) {
      const pattern = patterns.find((item) => item.id === solve.selectedPatternId);
      if (!pattern) return fail("invalid-solution", { round, adapted, solve, validationIssues: ["pattern-not-found"] });
      const allowedAnswers = new Set(adapted.candidates.map((candidate) => candidate.answer));
      const validation = validateCspCrosswordSolution11({
        theme: opts.theme,
        pattern,
        grid: solve.solution.grid,
        usedAnswers: solve.solution.usedAnswers,
        allowedAnswers,
      });
      if (!validation.valid) {
        return fail("invalid-solution", { round, adapted, solve, validationIssues: validation.issues });
      }
      emitDiagnostic("success", {
        attempt: round,
        patternId: pattern.id,
        nodesVisited: solve.solution.stats.nodesVisited,
        backtracks: solve.solution.stats.backtracks,
      });
      return {
        ok: true,
        grid: solve.solution.grid,
        usedAnswers: solve.solution.usedAnswers,
        patternId: pattern.id,
        meta: successMeta({
          solution: solve.solution,
          solve,
          startedAt,
          cspTopUpCalls,
          cspConstraintTopUpCalls,
          requestedTopUpByLength,
          requestedConstraintTopUps,
          candidateCountBeforeTopUp,
          candidateCountAfterTopUp: adapted.candidates.length,
        }),
      };
    }

    const constraintRequests = buildGuidedTopUpRequests(solve);
    constraintRequestsGenerated += constraintRequests.length;
    const canConstraintTopUp =
      opts.topUpByConstraints &&
      constraintRequests.length > 0 &&
      round < maxTopUpRounds &&
      opts.deadlineMs - Date.now() >= 12_000;
    if (constraintRequests.length > 0 && !canConstraintTopUp && opts.deadlineMs - Date.now() < 12_000) {
      stoppedBecauseBudgetExhausted = true;
    }
    if (canConstraintTopUp) {
      requestedConstraintTopUps = [...requestedConstraintTopUps, ...constraintRequests];
      opts.audit?.({
        stage: "constraint-topup-requested",
        data: {
          round,
          requests: constraintRequests,
        },
      });
      emitDiagnostic("constraint-topup-request", {
        attempt: round + 1,
        requestCount: constraintRequests.length,
        requests: constraintRequests,
        remainingBeforeTopUp: opts.deadlineMs - Date.now(),
      });
      const existingAnswers = adapted.candidates.map((candidate) => candidate.answer);
      const topUpDeadline = Math.min(opts.deadlineMs, Date.now() + 8_000);
      reservoirSizeBeforeConstraintTopUp = adapted.candidates.length;
      const topUpCandidates = await opts.topUpByConstraints?.({
        requests: constraintRequests,
        existingAnswers,
        attempt: round + 1,
        deadlineMs: topUpDeadline,
      });
      cspTopUpCalls++;
      cspConstraintTopUpCalls++;
      constraintGroupsReturned += topUpCandidates ? 1 : 0;
      constraintAnswersThematicallyAccepted += topUpCandidates?.length ?? 0;
      constraintAnswersAddedToReservoir += topUpCandidates?.length ?? 0;
      reservoirSizeAfterConstraintTopUp = adapted.candidates.length + (topUpCandidates?.length ?? 0);
      constraintTopUpRawGroups = [
        ...constraintTopUpRawGroups,
        {
          attempt: round + 1,
          requests: constraintRequests,
          returnedCount: topUpCandidates?.length ?? 0,
          returnedByLength: countInputCandidatesByLength(topUpCandidates ?? []),
        },
      ].slice(-10);
      constraintTopUpAccepted = [
        ...constraintTopUpAccepted,
        {
          attempt: round + 1,
          accepted: (topUpCandidates ?? []).slice(0, 20).map((candidate) => normalizeCspAnswer11(candidate.answer)),
        },
      ].slice(-10);
      opts.audit?.({
        stage: "constraint-topup-returned",
        data: {
          round,
          requested: constraintRequests,
          returnedCount: topUpCandidates?.length ?? 0,
          returnedByLength: countInputCandidatesByLength(topUpCandidates ?? []),
          sample: (topUpCandidates ?? []).slice(0, 20).map((candidate) => candidate.answer),
        },
      });
      emitDiagnostic("constraint-topup-result", {
        attempt: round + 1,
        requestCount: constraintRequests.length,
        returnedCount: topUpCandidates?.length ?? 0,
        returnedByLength: countInputCandidatesByLength(topUpCandidates ?? []),
        reservoirSizeBeforeConstraintTopUp,
        reservoirSizeAfterConstraintTopUp,
      });
      if (topUpCandidates && topUpCandidates.length > 0) {
        currentCandidates = [...currentCandidates, ...topUpCandidates];
        continue;
      }
    }

    requestedTopUpByLength = mergeTopUpRequests(requestedTopUpByLength, solve.requestedTopUpByLength);
    const canTopUp =
      opts.topUpByLength &&
      Object.keys(solve.requestedTopUpByLength).length > 0 &&
      round < maxTopUpRounds &&
      opts.deadlineMs - Date.now() >= 12_000;
    if (!canTopUp) {
      if (Object.keys(solve.requestedTopUpByLength).length > 0 && opts.deadlineMs - Date.now() < 12_000) {
        stoppedBecauseBudgetExhausted = true;
      }
      break;
    }

    const existingAnswers = adapted.candidates.map((candidate) => candidate.answer);
    const topUpDeadline = Math.min(opts.deadlineMs, Date.now() + 8_000);
    emitDiagnostic("length-topup-request", {
      attempt: round + 1,
      requestedByLength: solve.requestedTopUpByLength,
      remainingBeforeTopUp: opts.deadlineMs - Date.now(),
    });
    const topUpCandidates = await opts.topUpByLength?.({
      requestedByLength: solve.requestedTopUpByLength,
      existingAnswers,
      attempt: round + 1,
      deadlineMs: topUpDeadline,
    });
    cspTopUpCalls++;
    lengthTopUpRaw = [
      ...lengthTopUpRaw,
      {
        attempt: round + 1,
        requestedByLength: solve.requestedTopUpByLength,
        returnedCount: topUpCandidates?.length ?? 0,
        returnedByLength: countInputCandidatesByLength(topUpCandidates ?? []),
      },
    ].slice(-10);
    lengthTopUpAccepted = [
      ...lengthTopUpAccepted,
      {
        attempt: round + 1,
        accepted: (topUpCandidates ?? []).slice(0, 20).map((candidate) => normalizeCspAnswer11(candidate.answer)),
      },
    ].slice(-10);
    opts.audit?.({
      stage: "topup-returned",
      data: {
        round,
        requestedByLength: solve.requestedTopUpByLength,
        returnedCount: topUpCandidates?.length ?? 0,
        returnedByLength: countInputCandidatesByLength(topUpCandidates ?? []),
        sample: (topUpCandidates ?? []).slice(0, 20).map((candidate) => candidate.answer),
      },
    });
    emitDiagnostic("length-topup-result", {
      attempt: round + 1,
      requestedByLength: solve.requestedTopUpByLength,
      returnedCount: topUpCandidates?.length ?? 0,
      returnedByLength: countInputCandidatesByLength(topUpCandidates ?? []),
    });
    if (!topUpCandidates || topUpCandidates.length === 0) break;
    currentCandidates = [...currentCandidates, ...topUpCandidates];
  }

  const thematicOnlyReason = normalizeFailureReason(lastSolve);
  thematicOnlyDiagnostic = {
    solved: false,
    failureReason: thematicOnlyReason,
    chosenPattern: lastSolve?.selectedPatternId ?? lastSolve?.attempts[0]?.patternId ?? null,
    nodesVisited: lastSolve?.attempts.reduce((sum, attempt) => sum + attempt.nodesVisited, 0) ?? 0,
    backtracks: lastSolve?.attempts.reduce((sum, attempt) => sum + attempt.backtracks, 0) ?? 0,
  };

  if (opts.hybrid?.enabled) {
    emitDiagnostic("hybrid-start", {
      candidateCount: opts.hybrid.candidates.length,
      minThematicEntries: opts.hybrid.minThematicEntries,
      targetThematicEntries: opts.hybrid.targetThematicEntries,
    });
    const remaining = opts.deadlineMs - Date.now();
    if (remaining > 1_000) {
      const hybridAdapted = adaptCandidatesForCsp11({
        theme: opts.theme,
        candidates: opts.hybrid.candidates,
        patterns,
      });
      const hybridKinds = countHybridKinds(hybridAdapted.candidates);
      opts.audit?.({
        stage: "hybrid-reservoir",
        data: {
          candidateCount: hybridAdapted.candidates.length,
          thematicCountsByLength: opts.hybrid.thematicCountsByLength,
          supportCountsByLength: opts.hybrid.supportCountsByLength,
          totalByLength: hybridAdapted.stats.totalByLength,
        },
      });
      const hybridSolve = solveWithRankedPatterns11({
        patterns,
        candidates: hybridAdapted.candidates,
        seed: opts.seed,
        deadlineMs: Math.min(Math.max(solverDeadlineMs, 20_000), Math.max(1, remaining)),
        maxNodesPerPattern,
        minThematicEntries: opts.hybrid.minThematicEntries,
        targetThematicEntries: opts.hybrid.targetThematicEntries,
      });
      const hybridReason = normalizeFailureReason(hybridSolve);
      const hybridAttempts = hybridSolve.attempts;
      const hybridSolutionKinds = hybridSolve.solution
        ? countAssignedAnswersByKind(hybridSolve.solution.usedAnswers, hybridAdapted.candidates)
        : {
            thematicEntryCount: 0,
            supportEntryCount: 0,
            thematicRatio: 0,
            thematicAnswers: [] as string[],
            supportAnswers: [] as string[],
          };
      hybridDiagnostic = {
        attempted: true,
        solved: hybridSolve.solved,
        failureReason: hybridSolve.solved ? null : hybridReason,
        chosenPattern: hybridSolve.selectedPatternId ?? hybridSolve.attempts[0]?.patternId ?? null,
        nodesVisited: hybridAttempts.reduce((sum, attempt) => sum + attempt.nodesVisited, 0),
        backtracks: hybridAttempts.reduce((sum, attempt) => sum + attempt.backtracks, 0),
        searchProfile: mergeSearchProfiles(
          hybridAttempts
            .map((attempt) => attempt.searchProfile)
            .filter((profile): profile is NonNullable<typeof profile> => Boolean(profile))
        ),
        minThematicEntries: opts.hybrid.minThematicEntries,
        targetThematicEntries: opts.hybrid.targetThematicEntries,
        thematicCountsByLength: opts.hybrid.thematicCountsByLength,
        supportCountsByLength: opts.hybrid.supportCountsByLength,
        assignedThematicAnswers: hybridSolutionKinds.thematicAnswers,
        assignedSupportAnswers: hybridSolutionKinds.supportAnswers,
        thematicEntryCount: hybridSolutionKinds.thematicEntryCount,
        supportEntryCount: hybridSolutionKinds.supportEntryCount,
        thematicRatio: hybridSolutionKinds.thematicRatio,
        candidatesByKind: hybridKinds,
      };
      emitDiagnostic("search-profile", {
        phase: "hybrid",
        profile: hybridDiagnostic.searchProfile,
      });
      if (hybridSolve.solved && hybridSolve.solution && hybridSolve.selectedPatternId) {
        const pattern = patterns.find((item) => item.id === hybridSolve.selectedPatternId);
        if (pattern) {
          const allowedAnswers = new Set(hybridAdapted.candidates.map((candidate) => candidate.answer));
          const validation = validateCspCrosswordSolution11({
            theme: opts.theme,
            pattern,
            grid: hybridSolve.solution.grid,
            usedAnswers: hybridSolve.solution.usedAnswers,
            allowedAnswers,
          });
          if (validation.valid && hybridSolutionKinds.thematicEntryCount >= opts.hybrid.minThematicEntries) {
            emitDiagnostic("hybrid-success", {
              patternId: pattern.id,
              thematicEntryCount: hybridSolutionKinds.thematicEntryCount,
              supportEntryCount: hybridSolutionKinds.supportEntryCount,
            });
            return {
              ok: true,
              grid: hybridSolve.solution.grid,
              usedAnswers: hybridSolve.solution.usedAnswers,
              patternId: pattern.id,
              meta: {
                ...successMeta({
                  solution: hybridSolve.solution,
                  solve: hybridSolve,
                  startedAt,
                  cspTopUpCalls,
                  cspConstraintTopUpCalls,
                  requestedTopUpByLength,
                  requestedConstraintTopUps,
                  candidateCountBeforeTopUp,
                  candidateCountAfterTopUp: hybridAdapted.candidates.length,
                }),
                source: "answers-csp11-hybrid-then-clues",
                hybrid: hybridDiagnostic,
                thematicOnly: thematicOnlyDiagnostic,
                thematicEntryCount: hybridSolutionKinds.thematicEntryCount,
                supportEntryCount: hybridSolutionKinds.supportEntryCount,
                thematicRatio: hybridSolutionKinds.thematicRatio,
                thematicAnswers: hybridSolutionKinds.thematicAnswers,
                supportAnswers: hybridSolutionKinds.supportAnswers,
                geometrySolved: true,
                clueValidationPassed: null,
              },
            };
          }
          hybridDiagnostic = {
            ...hybridDiagnostic,
            solved: false,
            failureReason: validation.valid ? "quota-impossible" : "invalid-solution",
            validationIssues: validation.issues,
          };
        }
      }
      emitDiagnostic("hybrid-failed", {
        failureReason: hybridDiagnostic.failureReason,
        chosenPattern: hybridDiagnostic.chosenPattern,
      });
    } else {
      hybridDiagnostic = {
        attempted: true,
        solved: false,
        failureReason: "deadline",
        minThematicEntries: opts.hybrid.minThematicEntries,
        targetThematicEntries: opts.hybrid.targetThematicEntries,
      };
    }
  }

  const reason = thematicOnlyReason;
  return fail(reason, { lastSolve, requestedTopUpByLength });

  function fail(reason: IntegratedCspFailureReason11, meta: Record<string, unknown>): IntegratedCspBuildResult11 {
    return {
      ok: false,
      reason,
      meta: {
        source: "answers-csp11-failed",
        algorithm: "csp-pattern-11x11",
        cspElapsedMs: Date.now() - startedAt,
        cspTopUpCalls,
        cspConstraintTopUpCalls,
        requestedTopUpByLength,
        requestedConstraintTopUps,
        diagnostic: buildDiagnosticPayload({
          reason,
          startedAt,
          totalBudgetMs,
          stoppedBecauseBudgetExhausted,
          requestedTopUpByLength,
          requestedConstraintTopUps,
          lastSolve,
          initialCompatibility,
          postTopUpCompatibility,
          initialChosenPattern,
          postTopUpChosenPattern,
          initialSolveReport,
          finalSolveReport,
          lengthTopUpRaw,
          lengthTopUpAccepted,
          constraintTopUpRawGroups,
          constraintTopUpAccepted,
          constraintRequestsGenerated,
          constraintGroupsReturned,
          constraintAnswersThematicallyAccepted,
          constraintAnswersAddedToReservoir,
          reservoirSizeBeforeConstraintTopUp,
          reservoirSizeAfterConstraintTopUp,
          candidateCountBeforeTopUp,
          candidateCountAfterTopUp: countInputCandidatesByLength(currentCandidates),
          cspTopUpCalls,
          cspConstraintTopUpCalls,
          thematicOnly: thematicOnlyDiagnostic,
          hybrid: hybridDiagnostic ?? { attempted: Boolean(opts.hybrid?.enabled), solved: false },
        }),
        ...summarizeSolve(lastSolve),
        ...meta,
      },
    };
  }
}

function buildDiagnosticPayload(opts: {
  reason: IntegratedCspFailureReason11;
  startedAt: number;
  totalBudgetMs: number;
  stoppedBecauseBudgetExhausted: boolean;
  requestedTopUpByLength: Record<number, number>;
  requestedConstraintTopUps: CspConstraintTopUpRequest11[];
  lastSolve: RankedPatternSolveResult11 | null;
  initialCompatibility: unknown[];
  postTopUpCompatibility: unknown[];
  initialChosenPattern: string | null;
  postTopUpChosenPattern: string | null;
  initialSolveReport: Record<string, unknown> | null;
  finalSolveReport: Record<string, unknown> | null;
  lengthTopUpRaw: Array<Record<string, unknown>>;
  lengthTopUpAccepted: Array<Record<string, unknown>>;
  constraintTopUpRawGroups: Array<Record<string, unknown>>;
  constraintTopUpAccepted: Array<Record<string, unknown>>;
  constraintRequestsGenerated: number;
  constraintGroupsReturned: number;
  constraintAnswersThematicallyAccepted: number;
  constraintAnswersAddedToReservoir: number;
  reservoirSizeBeforeConstraintTopUp: number;
  reservoirSizeAfterConstraintTopUp: number;
  candidateCountBeforeTopUp: number;
  candidateCountAfterTopUp: Record<number, number>;
  cspTopUpCalls: number;
  cspConstraintTopUpCalls: number;
  thematicOnly?: Record<string, unknown> | null;
  hybrid?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const patternAttempts = opts.lastSolve ? limitPatternAttemptsForDiagnostic(opts.lastSolve.attempts) : [];
  return {
    failureReason: opts.reason,
    patternAttempts,
    initialCompatibility: opts.initialCompatibility,
    initialChosenPattern: opts.initialChosenPattern,
    initialSolveReport: opts.initialSolveReport,
    lengthTopUp: {
      requested: opts.requestedTopUpByLength,
      raw: opts.lengthTopUpRaw,
      accepted: opts.lengthTopUpAccepted,
    },
    constraintTopUp: {
      requests: opts.requestedConstraintTopUps.slice(-10),
      rawGroups: opts.constraintTopUpRawGroups,
      locallyValid: opts.constraintTopUpAccepted,
      thematicallyAccepted: opts.constraintTopUpAccepted,
    },
    postTopUpReservoirCountsByLength: opts.candidateCountAfterTopUp,
    postTopUpCompatibility: opts.postTopUpCompatibility,
    postTopUpChosenPattern: opts.postTopUpChosenPattern,
    finalSolveReport: opts.finalSolveReport ?? opts.initialSolveReport,
    elapsedMs: Date.now() - opts.startedAt,
    topUpRounds: opts.cspTopUpCalls,
    constraintRequestsGenerated: opts.constraintRequestsGenerated,
    constraintGroupsReturned: opts.constraintGroupsReturned,
    constraintAnswersLocallyValid: opts.constraintAnswersThematicallyAccepted,
    constraintAnswersThematicallyAccepted: opts.constraintAnswersThematicallyAccepted,
    constraintAnswersAddedToReservoir: opts.constraintAnswersAddedToReservoir,
    reservoirSizeBeforeConstraintTopUp: opts.reservoirSizeBeforeConstraintTopUp,
    reservoirSizeAfterConstraintTopUp: opts.reservoirSizeAfterConstraintTopUp,
    totalBudgetMs: opts.totalBudgetMs,
    remainingBeforeInitialSolve: Math.max(0, opts.totalBudgetMs),
    remainingBeforeTopUp: Math.max(0, opts.totalBudgetMs - (Date.now() - opts.startedAt)),
    remainingBeforeFinalSolve: Math.max(0, opts.totalBudgetMs - (Date.now() - opts.startedAt)),
    stoppedBecauseBudgetExhausted: opts.stoppedBecauseBudgetExhausted,
    candidateCountBeforeTopUp: opts.candidateCountBeforeTopUp,
    cspConstraintTopUpCalls: opts.cspConstraintTopUpCalls,
    thematicOnly: opts.thematicOnly,
    hybrid: opts.hybrid,
    searchCausality:
      (opts.hybrid?.searchProfile as { searchCausality?: unknown } | undefined)?.searchCausality ??
      (opts.finalSolveReport?.searchProfile as { searchCausality?: unknown } | undefined)?.searchCausality ??
      (opts.initialSolveReport?.searchProfile as { searchCausality?: unknown } | undefined)?.searchCausality ??
      null,
  };
}

function limitPatternAttemptsForDiagnostic(
  attempts: RankedPatternSolveResult11["attempts"]
): Array<Record<string, unknown>> {
  return attempts.slice(0, 4).map((attempt) => ({
    patternId: attempt.patternId,
    rankScore: attempt.rankScore,
    solved: attempt.solved,
    failureReason: attempt.failureReason,
    nodesVisited: attempt.nodesVisited,
    backtracks: attempt.backtracks,
    elapsedMs: attempt.elapsedMs,
    requiredByLength: attempt.requiredByLength,
    availableByLength: attempt.availableByLength,
    missingByLength: attempt.missingByLength,
    initialDomainSizesByLength: attempt.initialDomainSizesByLength,
    emptyDomainStage: attempt.emptyDomainStage,
    emptySlotId: attempt.emptySlotId,
    emptySlotLength: attempt.emptySlotLength,
    zeroCompatibilityIntersections: attempt.zeroCompatibilityIntersections.length,
    weakestIntersections: attempt.weakestIntersections.slice(0, 10),
    patternCompatibilityScore: attempt.patternCompatibilityScore,
    searchProfile: attempt.searchProfile,
    firstPropagationConflict: limitPropagationConflict(attempt.firstPropagationConflict),
    deepestPropagationConflict: limitPropagationConflict(attempt.deepestPropagationConflict),
    propagationConflictSummary: attempt.propagationConflictSummary.slice(0, 10),
  }));
}

function limitPropagationConflict(
  conflict: RankedPatternSolveResult11["attempts"][number]["firstPropagationConflict"]
) {
  if (!conflict) return null;
  return {
    ...conflict,
    constraints: conflict.constraints.slice(0, 10),
    candidateCountBeforeEachConstraint: conflict.candidateCountBeforeEachConstraint.slice(0, 10),
    assignedSlots: conflict.assignedSlots.slice(0, 20),
  };
}

function countHybridKinds(candidates: Array<{ thematic: boolean }>): Record<"thematic" | "support", number> {
  return candidates.reduce(
    (acc, candidate) => {
      if (candidate.thematic) acc.thematic++;
      else acc.support++;
      return acc;
    },
    { thematic: 0, support: 0 }
  );
}

function countAssignedAnswersByKind(
  answers: string[],
  candidates: Array<{ answer: string; thematic: boolean }>
): {
  thematicEntryCount: number;
  supportEntryCount: number;
  thematicRatio: number;
  thematicAnswers: string[];
  supportAnswers: string[];
} {
  const byAnswer = new Map(candidates.map((candidate) => [candidate.answer, candidate]));
  const thematicAnswers: string[] = [];
  const supportAnswers: string[] = [];
  for (const answer of answers) {
    if (byAnswer.get(answer)?.thematic) thematicAnswers.push(answer);
    else supportAnswers.push(answer);
  }
  thematicAnswers.sort();
  supportAnswers.sort();
  return {
    thematicEntryCount: thematicAnswers.length,
    supportEntryCount: supportAnswers.length,
    thematicRatio: answers.length > 0 ? thematicAnswers.length / answers.length : 0,
    thematicAnswers,
    supportAnswers,
  };
}

function mergeSearchProfiles(profiles: Array<NonNullable<RankedPatternSolveResult11["attempts"][number]["searchProfile"]>>) {
  if (profiles.length === 0) return null;
  const elapsedMs = profiles.reduce((sum, profile) => sum + profile.elapsedMs, 0);
  const nodesVisited = profiles.reduce((sum, profile) => sum + profile.nodesVisited, 0);
  const backtracks = profiles.reduce((sum, profile) => sum + profile.backtracks, 0);
  const selectedSamples = profiles.filter((profile) => profile.averageSelectedDomainSize > 0);
  const branchingSamples = profiles.filter((profile) => profile.averageBranchingFactor > 0);
  const searchCausality = [...profiles]
    .sort((a, b) => b.backtracks - a.backtracks || b.nodesVisited - a.nodesVisited)
    .find((profile) => profile.searchCausality)?.searchCausality;
  return {
    elapsedMs,
    nodesVisited,
    backtracks,
    nodesPerSecond: elapsedMs > 0 ? nodesVisited / (elapsedMs / 1000) : nodesVisited,
    maxDepth: Math.max(...profiles.map((profile) => profile.maxDepth)),
    bestAssignedSlots: Math.max(...profiles.map((profile) => profile.bestAssignedSlots)),
    bestThematicAssigned: Math.max(...profiles.map((profile) => profile.bestThematicAssigned)),
    domainCloneCount: profiles.reduce((sum, profile) => sum + profile.domainCloneCount, 0),
    copiedDomainItems: profiles.reduce((sum, profile) => sum + profile.copiedDomainItems, 0),
    mrvCalls: profiles.reduce((sum, profile) => sum + profile.mrvCalls, 0),
    mrvElapsedMs: profiles.reduce((sum, profile) => sum + profile.mrvElapsedMs, 0),
    valueOrderingCalls: profiles.reduce((sum, profile) => sum + profile.valueOrderingCalls, 0),
    valueOrderingElapsedMs: profiles.reduce((sum, profile) => sum + profile.valueOrderingElapsedMs, 0),
    propagationCalls: profiles.reduce((sum, profile) => sum + profile.propagationCalls, 0),
    propagationElapsedMs: profiles.reduce((sum, profile) => sum + profile.propagationElapsedMs, 0),
    constraintChecks: profiles.reduce((sum, profile) => sum + profile.constraintChecks, 0),
    domainValuesRemoved: profiles.reduce((sum, profile) => sum + profile.domainValuesRemoved, 0),
    domainWipeouts: profiles.reduce((sum, profile) => sum + profile.domainWipeouts, 0),
    rollbackCalls: profiles.reduce((sum, profile) => sum + profile.rollbackCalls, 0),
    rollbackElapsedMs: profiles.reduce((sum, profile) => sum + profile.rollbackElapsedMs, 0),
    averageSelectedDomainSize:
      selectedSamples.length > 0
        ? selectedSamples.reduce((sum, profile) => sum + profile.averageSelectedDomainSize, 0) / selectedSamples.length
        : 0,
    maxSelectedDomainSize: Math.max(...profiles.map((profile) => profile.maxSelectedDomainSize)),
    averageBranchingFactor:
      branchingSamples.length > 0
        ? branchingSamples.reduce((sum, profile) => sum + profile.averageBranchingFactor, 0) / branchingSamples.length
        : 0,
    quotaPrunes: profiles.reduce((sum, profile) => sum + profile.quotaPrunes, 0),
    quotaImpossibleAtDepth: profiles
      .map((profile) => profile.quotaImpossibleAtDepth)
      .filter((depth): depth is number => typeof depth === "number")
      .sort((a, b) => a - b)[0] ?? null,
    searchCausality,
  };
}

function countInputCandidatesByLength(candidates: CspAdapterInputCandidate[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const candidate of candidates) {
    const answer = normalizeCspAnswer11(candidate.answer);
    if (!answer) continue;
    out[answer.length] = (out[answer.length] ?? 0) + 1;
  }
  return out;
}

function successMeta(opts: {
  solution: CspBuildResult;
  solve: RankedPatternSolveResult11;
  startedAt: number;
  cspTopUpCalls: number;
  cspConstraintTopUpCalls: number;
  requestedTopUpByLength: Record<number, number>;
  requestedConstraintTopUps: CspConstraintTopUpRequest11[];
  candidateCountBeforeTopUp: number;
  candidateCountAfterTopUp: number;
}): Record<string, unknown> {
  const attempts = opts.solve.attempts;
  return {
    source: "answers-csp11-then-clues",
    builder: "csp-pattern-11x11",
    algorithm: "csp-pattern-11x11",
    patternId: opts.solve.selectedPatternId,
    slots: opts.solution.slots.length,
    acrossSlots: opts.solution.slots.filter((slot) => slot.direction === "across").length,
    downSlots: opts.solution.slots.filter((slot) => slot.direction === "down").length,
    nodesVisited: attempts.reduce((sum, attempt) => sum + attempt.nodesVisited, 0),
    backtracks: attempts.reduce((sum, attempt) => sum + attempt.backtracks, 0),
    cspElapsedMs: Date.now() - opts.startedAt,
    cspTopUpCalls: opts.cspTopUpCalls,
    cspConstraintTopUpCalls: opts.cspConstraintTopUpCalls,
    requestedTopUpByLength: opts.requestedTopUpByLength,
    requestedConstraintTopUps: opts.requestedConstraintTopUps,
    candidateCountBeforeTopUp: opts.candidateCountBeforeTopUp,
    candidateCountAfterTopUp: opts.candidateCountAfterTopUp,
    patternsTried: attempts.length,
  };
}

function summarizeSolve(solve: RankedPatternSolveResult11 | null): Record<string, unknown> {
  if (!solve) return {};
  return {
    patternsTried: solve.attempts.length,
    nodesVisited: solve.attempts.reduce((sum, attempt) => sum + attempt.nodesVisited, 0),
    backtracks: solve.attempts.reduce((sum, attempt) => sum + attempt.backtracks, 0),
    failureReason: normalizeFailureReason(solve),
    patternDiagnostics: solve.attempts.map((attempt) => ({
      patternId: attempt.patternId,
      solved: attempt.solved,
      failureReason: attempt.failureReason,
      missingByLength: attempt.missingByLength,
      emptyDomainStage: attempt.emptyDomainStage,
      emptySlotId: attempt.emptySlotId,
      emptySlotLength: attempt.emptySlotLength,
      initialDomainSizesByLength: attempt.initialDomainSizesByLength,
      zeroCompatibilityIntersections: attempt.zeroCompatibilityIntersections.length,
      weakestIntersections: attempt.weakestIntersections.slice(0, 5),
      patternCompatibilityScore: attempt.patternCompatibilityScore,
      firstPropagationConflict: attempt.firstPropagationConflict,
      deepestPropagationConflict: attempt.deepestPropagationConflict,
      propagationConflictSummary: attempt.propagationConflictSummary,
      nodesVisited: attempt.nodesVisited,
      backtracks: attempt.backtracks,
    })),
  };
}

function normalizeFailureReason(solve: RankedPatternSolveResult11 | null): IntegratedCspFailureReason11 {
  const lastReason = solve?.attempts
    .slice()
    .reverse()
    .find((attempt) => attempt.failureReason)?.failureReason;
  if (
    lastReason === "missing-lengths" ||
    lastReason === "empty-domain" ||
    lastReason === "zero-intersection-compatibility" ||
    lastReason === "propagation-empty-domain" ||
    lastReason === "search-exhausted" ||
    lastReason === "node-limit" ||
    lastReason === "deadline" ||
    lastReason === "unsatisfiable"
  ) {
    return lastReason;
  }
  return "unsatisfiable";
}

function buildGuidedTopUpRequests(solve: RankedPatternSolveResult11): CspConstraintTopUpRequest11[] {
  const attempts = solve.attempts.filter(
    (attempt) =>
      attempt.failureReason === "propagation-empty-domain" ||
      attempt.failureReason === "zero-intersection-compatibility"
  );
  const conflicts = attempts.flatMap((attempt) => {
    const out = [];
    if (attempt.firstPropagationConflict) out.push(attempt.firstPropagationConflict);
    if (attempt.deepestPropagationConflict) out.push(attempt.deepestPropagationConflict);
    return out;
  });
  const summaries = attempts.flatMap((attempt) => attempt.propagationConflictSummary);
  const conflictRequests = buildConstraintTopUpRequestsFromConflicts11({
    conflicts,
    summaries,
    maxRequests: 3,
    maxFixedLetters: 3,
    countPerRequest: 8,
  });
  if (conflictRequests.length > 0) return conflictRequests;

  const compatibilityRequests = attempts
    .flatMap((attempt) =>
      [...attempt.zeroCompatibilityIntersections, ...attempt.weakestIntersections].slice(0, 3).flatMap((intersection) => {
        const domainA = attempt.initialDomainSizesBySlot[intersection.slotA] ?? Number.POSITIVE_INFINITY;
        const domainB = attempt.initialDomainSizesBySlot[intersection.slotB] ?? Number.POSITIVE_INFINITY;
        const useA = domainA <= domainB;
        const allowedLetters = useA ? intersection.lettersAtB : intersection.lettersAtA;
        if (allowedLetters.length === 0) return [];
        const length = useA ? intersection.slotALength : intersection.slotBLength;
        const position = useA ? intersection.positionA : intersection.positionB;
        return [{
          requestId: `len${length}-p${position}${allowedLetters.join("")}`,
          length,
          constraints: [{ position, allowedLetters }],
          count: 8,
        }];
      })
    )
    .slice(0, 3);
  return compatibilityRequests;
}

function mergeTopUpRequests(
  current: Record<number, number>,
  next: Record<number, number>
): Record<number, number> {
  const out = { ...current };
  for (const [lengthKey, count] of Object.entries(next)) {
    const length = Number(lengthKey);
    out[length] = Math.max(out[length] ?? 0, count);
  }
  return out;
}
