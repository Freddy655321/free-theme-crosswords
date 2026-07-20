import {
  CspSearchCausalitySummary11,
  summarizeCspSearchCausality11,
} from "./cspSearchCausality11";

export type Direction = "across" | "down";

export type CspCandidate = {
  answer: string;
  thematic: boolean;
  source?: string;
  kind?: "thematic" | "support";
};

export type CrosswordCell = {
  row: number;
  col: number;
};

export type CrosswordSlot = {
  id: string;
  direction: Direction;
  row: number;
  col: number;
  length: number;
  cells: CrosswordCell[];
  intersections: Array<{
    otherSlotId: string;
    ownIndex: number;
    otherIndex: number;
  }>;
};

export type CspBuildResult = {
  grid: string[][];
  assignments: Record<string, string>;
  usedAnswers: string[];
  slots: CrosswordSlot[];
  stats: {
    nodesVisited: number;
    backtracks: number;
    elapsedMs: number;
    solved: boolean;
    searchProfile?: CspSearchProfile11;
  };
};

export type CspSearchProfile11 = {
  elapsedMs: number;
  nodesVisited: number;
  backtracks: number;
  nodesPerSecond: number;
  maxDepth: number;
  bestAssignedSlots: number;
  bestThematicAssigned: number;
  domainCloneCount: number;
  copiedDomainItems: number;
  mrvCalls: number;
  mrvElapsedMs: number;
  valueOrderingCalls: number;
  valueOrderingElapsedMs: number;
  propagationCalls: number;
  propagationElapsedMs: number;
  constraintChecks: number;
  domainValuesRemoved: number;
  domainWipeouts: number;
  rollbackCalls: number;
  rollbackElapsedMs: number;
  averageSelectedDomainSize: number;
  maxSelectedDomainSize: number;
  averageBranchingFactor: number;
  quotaPrunes: number;
  quotaImpossibleAtDepth: number | null;
  searchCausality?: CspSearchCausalityDiagnostics11;
};

export type CspBacktrackDepthProfile11 = {
  backtracksByDepth: Record<number, number>;
  nodesByDepth: Record<number, number>;
  wipeoutsByDepth: Record<number, number>;
  quotaPrunesByDepth: Record<number, number>;
  maxDepthReached: number;
  depthWithMostBacktracks: number | null;
  percentageBacktracksTop3Depths: number;
};

export type CspSlotSearchStats11 = {
  slotId: string;
  length: number;
  intersections: number;
  selectedCount: number;
  selectedAtDepthSum: number;
  averageSelectedDepth: number;
  domainSizeWhenSelectedSum: number;
  averageDomainSizeWhenSelected: number;
  maxDomainSizeWhenSelected: number;
  attemptedValues: number;
  successfulAssignments: number;
  failedAssignments: number;
  causedImmediateWipeouts: number;
  causedDeepBacktracks: number;
  quotaPrunesAfterAssignment: number;
  totalValuesRemovedFromNeighbors: number;
  averageValuesRemovedPerAssignment: number;
};

export type CspEarlyDecisionStats11 = {
  depth: number;
  slotId: string;
  candidate: string;
  thematic: boolean;
  domainSizeBefore: number;
  compatibleNeighborSupportBefore: number;
  timesTried: number;
  branchesSolved: number;
  branchesFailed: number;
  immediateWipeouts: number;
  deepestDepthReachedAfterDecision: number;
  totalDescendantNodes: number;
  totalDescendantBacktracks: number;
};

export type CspCandidateSearchStats11 = {
  answer: string;
  thematic: boolean;
  length: number;
  timesTried: number;
  timesCommitted: number;
  immediateFailures: number;
  deepFailures: number;
  solutionUses: number;
  valuesRemovedFromNeighbors: number;
  averageRemainingNeighborDomain: number;
  maxDepthReachedAfterUse: number;
  descendantNodes: number;
  descendantBacktracks: number;
};

export type CspWipeoutCause11 = {
  depth: number;
  assignedSlotId: string;
  assignedCandidate: string;
  emptiedSlotId: string;
  emptiedSlotLength: number;
  intersection?: {
    assignedIndex: number;
    emptiedIndex: number;
    requiredLetter: string;
  };
  domainSizeBefore: number;
  valuesRemoved: number;
  reason: "crossing-incompatibility" | "duplicate-answer" | "quota" | "arc-propagation" | "unknown";
};

export type CspBranchingDiagnostics11 = {
  selectedDomainSizeHistogram: Record<number, number>;
  averageSelectedDomainSize: number;
  p50SelectedDomainSize: number;
  p75SelectedDomainSize: number;
  p90SelectedDomainSize: number;
  maxSelectedDomainSize: number;
  averageUnassignedNeighborCount: number;
  averageNeighborDomainSum: number;
  worstBranchingSelections: Array<{
    depth: number;
    slotId: string;
    domainSize: number;
    unassignedNeighbors: number;
    neighborDomainSum: number;
    thematicOptions: number;
    supportOptions: number;
  }>;
};

export type CspValueOrderingDiagnostics11 = {
  triedByOrdinal: Record<number, number>;
  solvedByOrdinal: Record<number, number>;
  immediateFailuresByOrdinal: Record<number, number>;
  deepFailuresByOrdinal: Record<number, number>;
  averageDescendantNodesByOrdinal: Record<number, number>;
  averageWinningOrdinal: number | null;
  topCandidateFailureRate: number;
  firstThreeCandidatesFailureRate: number;
};

export type CspBestProgressState11 = {
  assignedSlots: number;
  thematicAssigned: number;
  supportAssigned: number;
  depth: number;
  remainingDomainSizes: Array<{ slotId: string; size: number }>;
  weakestRemainingSlots: Array<{ slotId: string; size: number; thematicOptions: number; supportOptions: number }>;
  decisionPath: Array<{ depth: number; slotId: string; answer: string; thematic: boolean }>;
  failureAfterBestState?: {
    reason: string;
    slotId?: string;
    candidate?: string;
    emptiedSlotId?: string;
  };
};

export type CspSearchCausalityDiagnostics11 = {
  summary: CspSearchCausalitySummary11;
  depthProfile: CspBacktrackDepthProfile11;
  slotRankings: {
    byFailedAssignments: CspSlotSearchStats11[];
    byImmediateWipeouts: CspSlotSearchStats11[];
    byDeepBacktracks: CspSlotSearchStats11[];
    byAverageDomainSize: CspSlotSearchStats11[];
  };
  earlyDecisionRankings: {
    byDescendantBacktracks: CspEarlyDecisionStats11[];
    byFailureRate: CspEarlyDecisionStats11[];
    byDeepestReach: CspEarlyDecisionStats11[];
    solutionDecisions: CspEarlyDecisionStats11[];
  };
  candidateRankings: {
    byTimesTried: CspCandidateSearchStats11[];
    byDeepFailures: CspCandidateSearchStats11[];
    byFailureRate: CspCandidateSearchStats11[];
    byNeighborElimination: CspCandidateSearchStats11[];
    solutionCandidates: CspCandidateSearchStats11[];
  };
  wipeoutRankings: {
    byReason: Record<string, number>;
    byAssignedSlot: Array<{ key: string; count: number }>;
    byEmptiedSlot: Array<{ key: string; count: number }>;
    byIntersection: Array<{ key: string; count: number }>;
    samples: CspWipeoutCause11[];
  };
  branchingDiagnostics: CspBranchingDiagnostics11;
  valueOrderingDiagnostics: CspValueOrderingDiagnostics11;
  heuristicDiagnostics: {
    selectedMinimumDomainRate: number;
    mrvTieRate: number;
    degreeTieBreakUseRate: number;
  };
  bestProgressState: CspBestProgressState11 | null;
  instrumentation: {
    recordedEarlyDecisions: number;
    recordedCandidates: number;
    recordedWipeoutSamples: number;
    approximateRecords: number;
  };
};

type MutableSlotStats = Omit<
  CspSlotSearchStats11,
  "averageSelectedDepth" | "averageDomainSizeWhenSelected" | "averageValuesRemovedPerAssignment"
>;

type MutableEarlyDecisionStats = CspEarlyDecisionStats11;

type MutableCandidateStats = Omit<CspCandidateSearchStats11, "averageRemainingNeighborDomain"> & {
  remainingNeighborDomainSum: number;
  remainingNeighborDomainSamples: number;
};

type MutableOrdinalStats = {
  tried: number;
  solved: number;
  immediate: number;
  deep: number;
  descendantNodes: number;
  descendantSamples: number;
};

export type PreparedCandidate = CspCandidate & {
  answer: string;
};

export type PreparedCandidateDomains = {
  byLength: Map<number, PreparedCandidate[]>;
  domainsBySlotId: Map<string, PreparedCandidate[]>;
  candidatesByAnswer: Map<string, PreparedCandidate>;
};

export type CspFailureReason =
  | "invalid-pattern"
  | "empty-domain"
  | "initial-empty-domain"
  | "zero-intersection-compatibility"
  | "propagation-empty-domain"
  | "search-exhausted"
  | "node-limit"
  | "deadline"
  | "unsatisfiable";

export type CspRequiredLetterConstraint11 = {
  slotId: string;
  slotLength: number;
  position: number;
  requiredLetter: string;
  sourceSlotId: string;
  sourcePosition: number;
};

export type CspPropagationConflict11 = {
  emptiedSlotId: string;
  emptiedSlotLength: number;
  previousDomainSize: number;
  constraints: CspRequiredLetterConstraint11[];
  candidateCountBeforeEachConstraint: Array<{
    position: number;
    requiredLetter: string;
    before: number;
    after: number;
  }>;
  assignedSlots: Array<{
    slotId: string;
    answer: string;
  }>;
};

export type CspPropagationConflictSummaryItem11 = {
  slotLength: number;
  constrainedPositions: number[];
  requiredPattern: string;
  occurrences: number;
};

export type CspSolveReport = {
  result: CspBuildResult | null;
  failureReason: CspFailureReason | null;
  stats: CspBuildResult["stats"];
  issues: string[];
  emptyDomainStage?: "initial" | "propagation" | null;
  firstPropagationConflict?: CspPropagationConflict11 | null;
  deepestPropagationConflict?: CspPropagationConflict11 | null;
  propagationConflictSummary?: CspPropagationConflictSummaryItem11[];
  thematicEntryCount?: number;
  supportEntryCount?: number;
  thematicAnswers?: string[];
  supportAnswers?: string[];
  searchProfile?: CspSearchProfile11;
};

export const DEFAULT_CSP_PATTERN_11: string[] = Array.from({ length: 11 }, () => "...........");

const SIZE = 11;
const MIN_SLOT_LENGTH = 3;
const ANSWER_RE = /^[A-Z0-9]+$/;
const EARLY_DECISION_DEPTH = 5;
const CAUSALITY_LIMIT = {
  slots: 10,
  early: 15,
  candidates: 20,
  wipeouts: 25,
  branching: 20,
};

function normalizeCandidateAnswer(answer: string): string {
  return answer
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function cellKey(cell: CrosswordCell): string {
  return `${cell.row},${cell.col}`;
}

function cloneSlotWithoutIntersections(slot: Omit<CrosswordSlot, "intersections">): CrosswordSlot {
  return { ...slot, intersections: [] };
}

function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < SIZE && col >= 0 && col < SIZE;
}

function scanRuns(pattern: string[], direction: Direction) {
  const runs: Array<{ row: number; col: number; length: number; direction: Direction }> = [];

  for (let outer = 0; outer < SIZE; outer++) {
    let inner = 0;
    while (inner < SIZE) {
      const read = (offset: number) =>
        direction === "across" ? pattern[outer]?.[offset] : pattern[offset]?.[outer];

      while (inner < SIZE && read(inner) === "#") inner++;
      const start = inner;
      while (inner < SIZE && read(inner) === ".") inner++;

      const length = inner - start;
      if (length > 0) {
        runs.push({
          row: direction === "across" ? outer : start,
          col: direction === "across" ? start : outer,
          length,
          direction,
        });
      }
    }
  }

  return runs;
}

function addIntersections(slots: CrosswordSlot[]): CrosswordSlot[] {
  const byCell = new Map<string, Array<{ slotIndex: number; letterIndex: number }>>();

  slots.forEach((slot, slotIndex) => {
    slot.cells.forEach((cell, letterIndex) => {
      const key = cellKey(cell);
      const owners = byCell.get(key) ?? [];
      owners.push({ slotIndex, letterIndex });
      byCell.set(key, owners);
    });
  });

  for (const owners of byCell.values()) {
    if (owners.length < 2) continue;
    for (let a = 0; a < owners.length; a++) {
      for (let b = a + 1; b < owners.length; b++) {
        const first = owners[a];
        const second = owners[b];
        if (!first || !second) continue;
        const firstSlot = slots[first.slotIndex];
        const secondSlot = slots[second.slotIndex];
        if (!firstSlot || !secondSlot || firstSlot.direction === secondSlot.direction) continue;

        firstSlot.intersections.push({
          otherSlotId: secondSlot.id,
          ownIndex: first.letterIndex,
          otherIndex: second.letterIndex,
        });
        secondSlot.intersections.push({
          otherSlotId: firstSlot.id,
          ownIndex: second.letterIndex,
          otherIndex: first.letterIndex,
        });
      }
    }
  }

  for (const slot of slots) {
    slot.intersections.sort((a, b) => a.ownIndex - b.ownIndex || a.otherSlotId.localeCompare(b.otherSlotId));
  }

  return slots;
}

export function extractSlotsFromPattern11(pattern: string[]): CrosswordSlot[] {
  const slots: CrosswordSlot[] = [];
  let acrossCount = 0;
  let downCount = 0;

  for (const run of [...scanRuns(pattern, "across"), ...scanRuns(pattern, "down")]) {
    if (run.length < MIN_SLOT_LENGTH) continue;

    const id =
      run.direction === "across"
        ? `A${++acrossCount}`
        : `D${++downCount}`;
    const cells = Array.from({ length: run.length }, (_, index) => ({
      row: run.direction === "down" ? run.row + index : run.row,
      col: run.direction === "across" ? run.col + index : run.col,
    }));

    slots.push(
      cloneSlotWithoutIntersections({
        id,
        direction: run.direction,
        row: run.row,
        col: run.col,
        length: run.length,
        cells,
      })
    );
  }

  return addIntersections(slots);
}

export function validatePattern11(pattern: string[]): {
  valid: boolean;
  issues: string[];
  slots: CrosswordSlot[];
} {
  const issues: string[] = [];

  if (pattern.length !== SIZE) {
    issues.push(`Pattern must have exactly ${SIZE} rows.`);
  }

  pattern.forEach((row, rowIndex) => {
    if (row.length !== SIZE) {
      issues.push(`Row ${rowIndex} must have exactly ${SIZE} cells.`);
    }
    if (!/^[#.]+$/.test(row)) {
      issues.push(`Row ${rowIndex} contains characters other than "#" and ".".`);
    }
  });

  if (issues.length > 0) {
    return { valid: false, issues, slots: [] };
  }

  const slots = extractSlotsFromPattern11(pattern);
  const acrossRuns = scanRuns(pattern, "across");
  const downRuns = scanRuns(pattern, "down");
  const allRuns = [...acrossRuns, ...downRuns];

  for (const run of allRuns) {
    if (run.length > 0 && run.length < MIN_SLOT_LENGTH) {
      issues.push(
        `${run.direction} run at row ${run.row}, col ${run.col} has length ${run.length}.`
      );
    }
  }

  if (slots.length < 15) {
    issues.push(`Pattern has ${slots.length} slots; at least 15 are required.`);
  }

  if (!slots.some((slot) => slot.direction === "across")) {
    issues.push("Pattern has no across slots.");
  }

  if (!slots.some((slot) => slot.direction === "down")) {
    issues.push("Pattern has no down slots.");
  }

  for (const slot of slots) {
    if (slot.intersections.length < 2) {
      issues.push(
        `Slot ${slot.id} has ${slot.intersections.length} intersections; at least 2 are required.`
      );
    }
  }

  const slotCellKeys = new Set(slots.flatMap((slot) => slot.cells.map(cellKey)));
  const openCells: CrosswordCell[] = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      if (pattern[row]?.[col] !== ".") continue;
      const key = `${row},${col}`;
      openCells.push({ row, col });
      if (!slotCellKeys.has(key)) {
        issues.push(`Open cell at row ${row}, col ${col} does not belong to any slot.`);
      }
    }
  }

  if (!openCellsAreConnected(pattern, openCells)) {
    issues.push("Open cells are not a single connected component.");
  }

  const slotRunKeys = new Set(
    slots.map((slot) => `${slot.direction}:${slot.row}:${slot.col}:${slot.length}`)
  );
  for (const run of allRuns) {
    if (run.length >= MIN_SLOT_LENGTH) {
      const key = `${run.direction}:${run.row}:${run.col}:${run.length}`;
      if (!slotRunKeys.has(key)) {
        issues.push(
          `${run.direction} run at row ${run.row}, col ${run.col}, length ${run.length} is not represented by a slot.`
        );
      }
    }
  }

  return { valid: issues.length === 0, issues, slots };
}

function openCellsAreConnected(pattern: string[], openCells: CrosswordCell[]): boolean {
  if (openCells.length === 0) return false;

  const open = new Set(openCells.map(cellKey));
  const seen = new Set<string>();
  const stack = [openCells[0]];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const key = cellKey(current);
    if (seen.has(key)) continue;
    seen.add(key);

    for (const [dr, dc] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const next = { row: current.row + dr, col: current.col + dc };
      if (!inBounds(next.row, next.col)) continue;
      if (pattern[next.row]?.[next.col] !== ".") continue;
      const nextKey = cellKey(next);
      if (open.has(nextKey) && !seen.has(nextKey)) stack.push(next);
    }
  }

  return seen.size === open.size;
}

export function prepareCandidateDomains(
  slots: CrosswordSlot[],
  candidates: CspCandidate[]
): PreparedCandidateDomains {
  const neededLengths = new Set(slots.map((slot) => slot.length));
  const candidatesByAnswer = new Map<string, PreparedCandidate>();

  for (const candidate of candidates) {
    const answer = normalizeCandidateAnswer(candidate.answer);
    if (!answer || !ANSWER_RE.test(answer)) continue;
    if (!neededLengths.has(answer.length)) continue;

    const existing = candidatesByAnswer.get(answer);
    if (!existing) {
      candidatesByAnswer.set(answer, {
        answer,
        thematic: Boolean(candidate.thematic),
        source: candidate.source,
        kind: candidate.kind ?? (candidate.thematic ? "thematic" : "support"),
      });
      continue;
    }

    if (candidate.thematic && !existing.thematic) {
      candidatesByAnswer.set(answer, {
        ...existing,
        thematic: true,
        source: candidate.source ?? existing.source,
        kind: "thematic",
      });
    }
  }

  const byLength = new Map<number, PreparedCandidate[]>();
  for (const candidate of candidatesByAnswer.values()) {
    const bucket = byLength.get(candidate.answer.length) ?? [];
    bucket.push(candidate);
    byLength.set(candidate.answer.length, bucket);
  }

  for (const bucket of byLength.values()) {
    bucket.sort(compareCandidatesDeterministic);
  }

  const domainsBySlotId = new Map<string, PreparedCandidate[]>();
  for (const slot of slots) {
    domainsBySlotId.set(slot.id, [...(byLength.get(slot.length) ?? [])]);
  }

  return { byLength, domainsBySlotId, candidatesByAnswer };
}

export function solveCrosswordPattern11(opts: {
  pattern: string[];
  candidates: CspCandidate[];
  deadlineMs?: number;
  maxNodes?: number;
  seed?: number;
  minThematicEntries?: number;
  targetThematicEntries?: number;
}): CspBuildResult | null {
  return solveCrosswordPattern11WithReport(opts).result;
}

export function solveCrosswordPattern11WithReport(opts: {
  pattern: string[];
  candidates: CspCandidate[];
  deadlineMs?: number;
  maxNodes?: number;
  seed?: number;
  minThematicEntries?: number;
  targetThematicEntries?: number;
}): CspSolveReport {
  const startedAt = Date.now();
  const validation = validatePattern11(opts.pattern);
  const baseStats = () => ({
    nodesVisited: stats.nodesVisited,
    backtracks: stats.backtracks,
    elapsedMs: Date.now() - startedAt,
    solved: false,
    searchProfile: buildSearchProfile(false),
  });
  const stats = {
    nodesVisited: 0,
    backtracks: 0,
  };
  const profile = {
    domainCloneCount: 0,
    copiedDomainItems: 0,
    mrvCalls: 0,
    mrvElapsedMs: 0,
    valueOrderingCalls: 0,
    valueOrderingElapsedMs: 0,
    propagationCalls: 0,
    propagationElapsedMs: 0,
    constraintChecks: 0,
    domainValuesRemoved: 0,
    domainWipeouts: 0,
    rollbackCalls: 0,
    rollbackElapsedMs: 0,
    selectedDomainSizeTotal: 0,
    selectedDomainSizeSamples: 0,
    maxSelectedDomainSize: 0,
    branchingFactorTotal: 0,
    branchingFactorSamples: 0,
    maxDepth: 0,
    bestAssignedSlots: 0,
    bestThematicAssigned: 0,
    quotaPrunes: 0,
    quotaImpossibleAtDepth: null as number | null,
  };
  let stoppedBy: CspFailureReason | null = null;

  if (!validation.valid) {
    return {
      result: null,
      failureReason: "invalid-pattern",
      stats: baseStats(),
      issues: validation.issues,
    };
  }

  const slots = validation.slots;
  const slotById = new Map(slots.map((slot) => [slot.id, slot]));
  const prepared = prepareCandidateDomains(slots, opts.candidates);
  const maxNodes = opts.maxNodes ?? 250_000;
  const deadlineAt = opts.deadlineMs ? startedAt + opts.deadlineMs : Number.POSITIVE_INFINITY;
  const seed = opts.seed ?? 0;
  const minThematicEntries = opts.minThematicEntries ?? 0;
  let firstPropagationConflict: CspPropagationConflict11 | null = null;
  let deepestPropagationConflict: CspPropagationConflict11 | null = null;
  let deepestPropagationDepth = -1;
  const propagationConflictSamples: CspPropagationConflict11[] = [];
  const nodesByDepth = new Map<number, number>();
  const backtracksByDepth = new Map<number, number>();
  const wipeoutsByDepth = new Map<number, number>();
  const quotaPrunesByDepth = new Map<number, number>();
  const slotStatsById = new Map<string, MutableSlotStats>();
  const earlyDecisionStatsByKey = new Map<string, MutableEarlyDecisionStats>();
  const candidateStatsByAnswer = new Map<string, MutableCandidateStats>();
  const wipeoutCauses: CspWipeoutCause11[] = [];
  const wipeoutByReason = new Map<string, number>();
  const wipeoutByAssignedSlot = new Map<string, number>();
  const wipeoutByEmptiedSlot = new Map<string, number>();
  const wipeoutByIntersection = new Map<string, number>();
  const selectedDomainSizes: number[] = [];
  const selectedDomainSizeHistogram = new Map<number, number>();
  const branchingSelections: CspBranchingDiagnostics11["worstBranchingSelections"] = [];
  const valueOrdinalStats = new Map<number, MutableOrdinalStats>();
  let bestProgressState: CspBestProgressState11 | null = null;
  let mrvMinimumSelections = 0;
  let mrvTieSelections = 0;
  let mrvDegreeTieBreakUses = 0;

  if (slots.some((slot) => (prepared.domainsBySlotId.get(slot.id) ?? []).length === 0)) {
    return {
      result: null,
      failureReason: "initial-empty-domain",
      stats: baseStats(),
      issues: [],
      emptyDomainStage: "initial",
      firstPropagationConflict: null,
      deepestPropagationConflict: null,
      propagationConflictSummary: [],
    };
  }

  const solved = search({
    assignments: {},
    domains: prepared.domainsBySlotId,
    usedAnswers: new Set<string>(),
    thematicCount: 0,
    path: [],
  });

  if (!solved) {
    const failureReason = stoppedBy ?? (firstPropagationConflict ? "propagation-empty-domain" : "search-exhausted");
    return {
      result: null,
      failureReason,
      stats: baseStats(),
      issues: [],
      emptyDomainStage: firstPropagationConflict ? "propagation" : null,
      firstPropagationConflict,
      deepestPropagationConflict,
      propagationConflictSummary: summarizePropagationConflicts(propagationConflictSamples),
      searchProfile: buildSearchProfile(false),
    };
  }

  const grid = buildGridFromAssignments(opts.pattern, slots, solved.assignments);
  if (!grid) {
    return { result: null, failureReason: "unsatisfiable", stats: baseStats(), issues: [] };
  }

  if (!validateFinalGrid(grid, slots, solved.assignments)) {
    return { result: null, failureReason: "unsatisfiable", stats: baseStats(), issues: [] };
  }

  const result = {
    grid,
    assignments: solved.assignments,
    usedAnswers: Object.values(solved.assignments),
    slots,
    stats: {
      nodesVisited: stats.nodesVisited,
      backtracks: stats.backtracks,
      elapsedMs: Date.now() - startedAt,
      solved: true,
      searchProfile: buildSearchProfile(true),
    },
  };
  return {
    result,
    failureReason: null,
    stats: result.stats,
    issues: [],
    emptyDomainStage: null,
    firstPropagationConflict: null,
    deepestPropagationConflict: null,
    propagationConflictSummary: [],
    searchProfile: buildSearchProfile(true),
    ...countAssignedKinds(solved.assignments, prepared.candidatesByAnswer),
  };

  function search(state: {
    assignments: Record<string, string>;
    domains: Map<string, PreparedCandidate[]>;
    usedAnswers: Set<string>;
    thematicCount: number;
    path: CspBestProgressState11["decisionPath"];
  }): { assignments: Record<string, string> } | null {
    if (Date.now() > deadlineAt) {
      stoppedBy = "deadline";
      return null;
    }
    if (stats.nodesVisited >= maxNodes) {
      stoppedBy = "node-limit";
      return null;
    }
    stats.nodesVisited++;

    const assignedCount = Object.keys(state.assignments).length;
    incrementMap(nodesByDepth, assignedCount);
    profile.maxDepth = Math.max(profile.maxDepth, assignedCount);
    if (
      assignedCount > profile.bestAssignedSlots ||
      (assignedCount === profile.bestAssignedSlots && state.thematicCount > profile.bestThematicAssigned)
    ) {
      profile.bestAssignedSlots = assignedCount;
      profile.bestThematicAssigned = state.thematicCount;
      bestProgressState = captureBestProgressState(state, assignedCount);
    }
    const remainingSlots = slots.length - assignedCount;
    if (state.thematicCount + remainingSlots < minThematicEntries) {
      profile.quotaPrunes++;
      incrementMap(quotaPrunesByDepth, assignedCount);
      profile.quotaImpossibleAtDepth =
        profile.quotaImpossibleAtDepth === null
          ? assignedCount
          : Math.min(profile.quotaImpossibleAtDepth, assignedCount);
      bestProgressState = markBestProgressFailure(bestProgressState, {
        reason: "quota",
      });
      return null;
    }

    if (assignedCount === slots.length) {
      if (state.thematicCount < minThematicEntries) return null;
      return { assignments: state.assignments };
    }

    const mrvStart = Date.now();
    const selected = selectNextSlot(slots, slotById, state.assignments, state.domains, state.usedAnswers, profile);
    profile.mrvElapsedMs += Date.now() - mrvStart;
    if (!selected) {
      bestProgressState = markBestProgressFailure(bestProgressState, {
        reason: "slot-selection",
      });
      return null;
    }
    const selectedDomainSize = countCurrentCompatibleDomain(
      selected,
      state.assignments,
      state.domains,
      state.usedAnswers,
      slotById
    );
    recordSlotSelection(selected, assignedCount, selectedDomainSize);
    recordBranchingSelection(selected, assignedCount, selectedDomainSize, state.assignments, state.domains, state.usedAnswers);

    const orderingStart = Date.now();
    const values = orderValues(selected, state.assignments, state.domains, state.usedAnswers, seed, slotById, profile);
    profile.valueOrderingElapsedMs += Date.now() - orderingStart;
    profile.branchingFactorTotal += values.length;
    profile.branchingFactorSamples++;

    for (let ordinal = 0; ordinal < values.length; ordinal++) {
      const candidate = values[ordinal] as PreparedCandidate;
      const slotStat = getSlotStats(selected);
      const candidateStat = getCandidateStats(candidate);
      const earlyStat = assignedCount <= EARLY_DECISION_DEPTH
        ? getEarlyDecisionStats(assignedCount, selected, candidate, selectedDomainSize, state.assignments, state.domains)
        : null;
      const beforeNodes = stats.nodesVisited;
      const beforeBacktracks = stats.backtracks;
      const beforeMaxDepth = profile.maxDepth;
      slotStat.attemptedValues++;
      candidateStat.timesTried++;
      if (earlyStat) earlyStat.timesTried++;
      incrementOrdinal(ordinal, "tried");
      const checked = forwardCheck(selected, candidate, state.domains, state.assignments, state.usedAnswers, slotById, profile);
      if (!checked) {
        stats.backtracks++;
        incrementMap(backtracksByDepth, assignedCount);
        slotStat.failedAssignments++;
        candidateStat.immediateFailures++;
        incrementOrdinal(ordinal, "immediate");
        continue;
      }
      if ("conflict" in checked) {
        recordPropagationConflict(checked.conflict, Object.keys(state.assignments).length + 1);
        recordImmediateWipeout(selected, candidate, checked.conflict, assignedCount, slotStat, candidateStat, earlyStat, ordinal);
        stats.backtracks++;
        incrementMap(backtracksByDepth, assignedCount);
        continue;
      }
      const nextDomains = checked.domains;
      const removedFromNeighbors = countRemovedFromNeighborDomains(selected, state.domains, nextDomains);
      slotStat.successfulAssignments++;
      slotStat.totalValuesRemovedFromNeighbors += removedFromNeighbors;
      candidateStat.timesCommitted++;
      candidateStat.valuesRemovedFromNeighbors += removedFromNeighbors;
      candidateStat.remainingNeighborDomainSum += countRemainingNeighborDomain(selected, state.assignments, nextDomains);
      candidateStat.remainingNeighborDomainSamples++;

      const nextAssignments = { ...state.assignments, [selected.id]: candidate.answer };
      const nextUsed = new Set(state.usedAnswers);
      nextUsed.add(candidate.answer);
      const nextPath = [
        ...state.path,
        { depth: assignedCount, slotId: selected.id, answer: candidate.answer, thematic: candidate.thematic },
      ];

      const result = search({
        assignments: nextAssignments,
        domains: nextDomains,
        usedAnswers: nextUsed,
        thematicCount: state.thematicCount + (candidate.thematic ? 1 : 0),
        path: nextPath,
      });
      const descendantNodes = stats.nodesVisited - beforeNodes;
      const descendantBacktracks = stats.backtracks - beforeBacktracks;
      candidateStat.descendantNodes += descendantNodes;
      candidateStat.descendantBacktracks += descendantBacktracks;
      candidateStat.maxDepthReachedAfterUse = Math.max(candidateStat.maxDepthReachedAfterUse, profile.maxDepth);
      if (earlyStat) {
        earlyStat.totalDescendantNodes += descendantNodes;
        earlyStat.totalDescendantBacktracks += descendantBacktracks;
        earlyStat.deepestDepthReachedAfterDecision = Math.max(
          earlyStat.deepestDepthReachedAfterDecision,
          profile.maxDepth
        );
      }
      addOrdinalDescendants(ordinal, descendantNodes);
      if (result) {
        candidateStat.solutionUses++;
        incrementOrdinal(ordinal, "solved");
        if (earlyStat) earlyStat.branchesSolved++;
        return result;
      }

      profile.rollbackCalls++;
      stats.backtracks++;
      incrementMap(backtracksByDepth, assignedCount);
      slotStat.failedAssignments++;
      slotStat.causedDeepBacktracks++;
      candidateStat.deepFailures++;
      if (earlyStat) earlyStat.branchesFailed++;
      incrementOrdinal(ordinal, "deep");
      if (profile.maxDepth > beforeMaxDepth) {
        bestProgressState = markBestProgressFailure(bestProgressState, {
          reason: "deep-backtrack",
          slotId: selected.id,
          candidate: candidate.answer,
        });
      }
    }

    return null;
  }

  function recordPropagationConflict(conflict: CspPropagationConflict11, depth: number): void {
    if (!firstPropagationConflict) firstPropagationConflict = conflict;
    if (depth > deepestPropagationDepth) {
      deepestPropagationDepth = depth;
      deepestPropagationConflict = conflict;
    }
    if (propagationConflictSamples.length < 10) propagationConflictSamples.push(conflict);
  }

  function getSlotStats(slot: CrosswordSlot): MutableSlotStats {
    const existing = slotStatsById.get(slot.id);
    if (existing) return existing;
    const created: MutableSlotStats = {
      slotId: slot.id,
      length: slot.length,
      intersections: slot.intersections.length,
      selectedCount: 0,
      selectedAtDepthSum: 0,
      domainSizeWhenSelectedSum: 0,
      maxDomainSizeWhenSelected: 0,
      attemptedValues: 0,
      successfulAssignments: 0,
      failedAssignments: 0,
      causedImmediateWipeouts: 0,
      causedDeepBacktracks: 0,
      quotaPrunesAfterAssignment: 0,
      totalValuesRemovedFromNeighbors: 0,
    };
    slotStatsById.set(slot.id, created);
    return created;
  }

  function getCandidateStats(candidate: PreparedCandidate): MutableCandidateStats {
    const existing = candidateStatsByAnswer.get(candidate.answer);
    if (existing) return existing;
    const created: MutableCandidateStats = {
      answer: candidate.answer,
      thematic: candidate.thematic,
      length: candidate.answer.length,
      timesTried: 0,
      timesCommitted: 0,
      immediateFailures: 0,
      deepFailures: 0,
      solutionUses: 0,
      valuesRemovedFromNeighbors: 0,
      remainingNeighborDomainSum: 0,
      remainingNeighborDomainSamples: 0,
      maxDepthReachedAfterUse: 0,
      descendantNodes: 0,
      descendantBacktracks: 0,
    };
    candidateStatsByAnswer.set(candidate.answer, created);
    return created;
  }

  function getEarlyDecisionStats(
    depth: number,
    slot: CrosswordSlot,
    candidate: PreparedCandidate,
    domainSizeBefore: number,
    assignments: Record<string, string>,
    domains: Map<string, PreparedCandidate[]>
  ): MutableEarlyDecisionStats {
    const key = `${depth}:${slot.id}:${candidate.answer}`;
    const existing = earlyDecisionStatsByKey.get(key);
    if (existing) return existing;
    const created: MutableEarlyDecisionStats = {
      depth,
      slotId: slot.id,
      candidate: candidate.answer,
      thematic: candidate.thematic,
      domainSizeBefore,
      compatibleNeighborSupportBefore: countRemainingNeighborDomain(slot, assignments, domains),
      timesTried: 0,
      branchesSolved: 0,
      branchesFailed: 0,
      immediateWipeouts: 0,
      deepestDepthReachedAfterDecision: depth,
      totalDescendantNodes: 0,
      totalDescendantBacktracks: 0,
    };
    earlyDecisionStatsByKey.set(key, created);
    return created;
  }

  function recordSlotSelection(slot: CrosswordSlot, depth: number, domainSize: number): void {
    const slotStat = getSlotStats(slot);
    slotStat.selectedCount++;
    slotStat.selectedAtDepthSum += depth;
    slotStat.domainSizeWhenSelectedSum += domainSize;
    slotStat.maxDomainSizeWhenSelected = Math.max(slotStat.maxDomainSizeWhenSelected, domainSize);
    selectedDomainSizes.push(domainSize);
    incrementMap(selectedDomainSizeHistogram, domainSize);
  }

  function recordBranchingSelection(
    slot: CrosswordSlot,
    depth: number,
    domainSize: number,
    assignments: Record<string, string>,
    domains: Map<string, PreparedCandidate[]>,
    usedAnswers: Set<string>
  ): void {
    const neighborIds = [...new Set(slot.intersections.map((intersection) => intersection.otherSlotId))].filter(
      (slotId) => !assignments[slotId]
    );
    const neighborDomainSum = neighborIds.reduce((sum, slotId) => sum + (domains.get(slotId) ?? []).length, 0);
    const domain = domains.get(slot.id) ?? [];
    const selection = {
      depth,
      slotId: slot.id,
      domainSize,
      unassignedNeighbors: neighborIds.length,
      neighborDomainSum,
      thematicOptions: domain.filter((candidate) => candidate.thematic).length,
      supportOptions: domain.filter((candidate) => !candidate.thematic).length,
    };
    branchingSelections.push(selection);
    branchingSelections.sort(
      (a, b) =>
        b.domainSize * Math.max(1, b.neighborDomainSum) -
          a.domainSize * Math.max(1, a.neighborDomainSum) ||
        a.slotId.localeCompare(b.slotId)
    );
    if (branchingSelections.length > CAUSALITY_LIMIT.branching) branchingSelections.length = CAUSALITY_LIMIT.branching;

    const compatibleSizes = slots
      .filter((item) => !assignments[item.id])
      .map((item) => countCurrentCompatibleDomain(item, assignments, domains, usedAnswers, slotById));
    const minSize = compatibleSizes.length ? Math.min(...compatibleSizes) : domainSize;
    if (domainSize === minSize) mrvMinimumSelections++;
    if (compatibleSizes.filter((size) => size === minSize).length > 1) mrvTieSelections++;
    if (slot.intersections.filter((intersection) => !assignments[intersection.otherSlotId]).length > 0) {
      mrvDegreeTieBreakUses++;
    }
  }

  function recordImmediateWipeout(
    slot: CrosswordSlot,
    candidate: PreparedCandidate,
    conflict: CspPropagationConflict11,
    depth: number,
    slotStat: MutableSlotStats,
    candidateStat: MutableCandidateStats,
    earlyStat: MutableEarlyDecisionStats | null,
    ordinal: number
  ): void {
    slotStat.failedAssignments++;
    slotStat.causedImmediateWipeouts++;
    candidateStat.immediateFailures++;
    if (earlyStat) earlyStat.immediateWipeouts++;
    incrementOrdinal(ordinal, "immediate");
    incrementMap(wipeoutsByDepth, depth);
    const cause = buildWipeoutCause(slot, candidate, conflict, depth);
    if (wipeoutCauses.length < CAUSALITY_LIMIT.wipeouts) wipeoutCauses.push(cause);
    incrementMap(wipeoutByReason, cause.reason);
    incrementMap(wipeoutByAssignedSlot, cause.assignedSlotId);
    incrementMap(wipeoutByEmptiedSlot, cause.emptiedSlotId);
    if (cause.intersection) {
      incrementMap(
        wipeoutByIntersection,
        `${cause.assignedSlotId}[${cause.intersection.assignedIndex}]->${cause.emptiedSlotId}[${cause.intersection.emptiedIndex}]=${cause.intersection.requiredLetter}`
      );
    }
    bestProgressState = markBestProgressFailure(bestProgressState, {
      reason: "immediate-wipeout",
      slotId: slot.id,
      candidate: candidate.answer,
      emptiedSlotId: conflict.emptiedSlotId,
    });
  }

  function buildWipeoutCause(
    slot: CrosswordSlot,
    candidate: PreparedCandidate,
    conflict: CspPropagationConflict11,
    depth: number
  ): CspWipeoutCause11 {
    const directIntersection = slot.intersections.find((intersection) => intersection.otherSlotId === conflict.emptiedSlotId);
    const matchingReduction = conflict.candidateCountBeforeEachConstraint.find((reduction) => reduction.after === 0);
    return {
      depth,
      assignedSlotId: slot.id,
      assignedCandidate: candidate.answer,
      emptiedSlotId: conflict.emptiedSlotId,
      emptiedSlotLength: conflict.emptiedSlotLength,
      intersection:
        directIntersection && matchingReduction
          ? {
              assignedIndex: directIntersection.ownIndex,
              emptiedIndex: directIntersection.otherIndex,
              requiredLetter: matchingReduction.requiredLetter,
            }
          : undefined,
      domainSizeBefore: conflict.previousDomainSize,
      valuesRemoved: Math.max(0, conflict.previousDomainSize - (matchingReduction?.after ?? 0)),
      reason: directIntersection ? "crossing-incompatibility" : "arc-propagation",
    };
  }

  function captureBestProgressState(
    state: {
      assignments: Record<string, string>;
      domains: Map<string, PreparedCandidate[]>;
      thematicCount: number;
      path: CspBestProgressState11["decisionPath"];
    },
    depth: number
  ): CspBestProgressState11 {
    const remaining = slots
      .filter((slot) => !state.assignments[slot.id])
      .map((slot) => {
        const domain = state.domains.get(slot.id) ?? [];
        return {
          slotId: slot.id,
          size: domain.length,
          thematicOptions: domain.filter((candidate) => candidate.thematic).length,
          supportOptions: domain.filter((candidate) => !candidate.thematic).length,
        };
      })
      .sort((a, b) => a.size - b.size || a.slotId.localeCompare(b.slotId));
    return {
      assignedSlots: Object.keys(state.assignments).length,
      thematicAssigned: state.thematicCount,
      supportAssigned: Object.keys(state.assignments).length - state.thematicCount,
      depth,
      remainingDomainSizes: remaining.map(({ slotId, size }) => ({ slotId, size })),
      weakestRemainingSlots: remaining.slice(0, 10),
      decisionPath: state.path.slice(0, slots.length),
    };
  }

  function markBestProgressFailure(
    current: CspBestProgressState11 | null,
    failure: NonNullable<CspBestProgressState11["failureAfterBestState"]>
  ): CspBestProgressState11 | null {
    if (!current || current.failureAfterBestState) return current;
    return { ...current, failureAfterBestState: failure };
  }

  function incrementOrdinal(ordinal: number, kind: "tried" | "solved" | "immediate" | "deep"): void {
    const statsForOrdinal = valueOrdinalStats.get(ordinal) ?? {
      tried: 0,
      solved: 0,
      immediate: 0,
      deep: 0,
      descendantNodes: 0,
      descendantSamples: 0,
    };
    statsForOrdinal[kind]++;
    valueOrdinalStats.set(ordinal, statsForOrdinal);
  }

  function addOrdinalDescendants(ordinal: number, nodes: number): void {
    const statsForOrdinal = valueOrdinalStats.get(ordinal) ?? {
      tried: 0,
      solved: 0,
      immediate: 0,
      deep: 0,
      descendantNodes: 0,
      descendantSamples: 0,
    };
    statsForOrdinal.descendantNodes += nodes;
    statsForOrdinal.descendantSamples++;
    valueOrdinalStats.set(ordinal, statsForOrdinal);
  }

  function countRemovedFromNeighborDomains(
    slot: CrosswordSlot,
    before: Map<string, PreparedCandidate[]>,
    after: Map<string, PreparedCandidate[]>
  ): number {
    let removed = 0;
    for (const intersection of slot.intersections) {
      removed += Math.max(0, (before.get(intersection.otherSlotId) ?? []).length - (after.get(intersection.otherSlotId) ?? []).length);
    }
    return removed;
  }

  function countRemainingNeighborDomain(
    slot: CrosswordSlot,
    assignments: Record<string, string>,
    domains: Map<string, PreparedCandidate[]>
  ): number {
    return [...new Set(slot.intersections.map((intersection) => intersection.otherSlotId))]
      .filter((slotId) => !assignments[slotId])
      .reduce((sum, slotId) => sum + (domains.get(slotId) ?? []).length, 0);
  }

  function buildCausalityDiagnostics(solved: boolean): CspSearchCausalityDiagnostics11 {
    const depthProfile = buildDepthProfile(solved);
    const slotValues = [...slotStatsById.values()].map(finalizeSlotStats);
    const earlyValues = [...earlyDecisionStatsByKey.values()];
    const candidateValues = [...candidateStatsByAnswer.values()].map(finalizeCandidateStats);
    const branchingDiagnostics = buildBranchingDiagnostics();
    const valueOrderingDiagnostics = buildValueOrderingDiagnostics();
    const topIntersectionShare = topShare(wipeoutByIntersection);
    const lateBacktrackShare = stats.backtracks > 0
      ? [...backtracksByDepth.entries()]
          .filter(([depth]) => depth >= Math.max(0, profile.maxDepth - 3))
          .reduce((sum, [, count]) => sum + count, 0) / stats.backtracks
      : 0;
    const heuristicDiagnostics = {
      selectedMinimumDomainRate: profile.mrvCalls > 0 ? mrvMinimumSelections / profile.mrvCalls : 0,
      mrvTieRate: profile.mrvCalls > 0 ? mrvTieSelections / profile.mrvCalls : 0,
      degreeTieBreakUseRate: profile.mrvCalls > 0 ? mrvDegreeTieBreakUses / profile.mrvCalls : 0,
    };
    const summary = summarizeCspSearchCausality11({
      totalBacktracks: stats.backtracks,
      maxDepth: profile.maxDepth,
      depthWithMostBacktracks: depthProfile.depthWithMostBacktracks,
      percentageBacktracksTop3Depths: depthProfile.percentageBacktracksTop3Depths,
      earlyDecisionFailureRate: averageFailureRate(earlyValues),
      topCandidateFailureRate: valueOrderingDiagnostics.topCandidateFailureRate,
      firstThreeCandidatesFailureRate: valueOrderingDiagnostics.firstThreeCandidatesFailureRate,
      topWipeoutIntersectionShare: topIntersectionShare,
      p90SelectedDomainSize: branchingDiagnostics.p90SelectedDomainSize,
      quotaPrunes: profile.quotaPrunes,
      lateBacktrackShare,
      selectedMinimumDomainRate: heuristicDiagnostics.selectedMinimumDomainRate,
    });

    return {
      summary,
      depthProfile,
      slotRankings: {
        byFailedAssignments: topBy(slotValues, (item) => item.failedAssignments, CAUSALITY_LIMIT.slots),
        byImmediateWipeouts: topBy(slotValues, (item) => item.causedImmediateWipeouts, CAUSALITY_LIMIT.slots),
        byDeepBacktracks: topBy(slotValues, (item) => item.causedDeepBacktracks, CAUSALITY_LIMIT.slots),
        byAverageDomainSize: topBy(slotValues, (item) => item.averageDomainSizeWhenSelected, CAUSALITY_LIMIT.slots),
      },
      earlyDecisionRankings: {
        byDescendantBacktracks: topBy(earlyValues, (item) => item.totalDescendantBacktracks, CAUSALITY_LIMIT.early),
        byFailureRate: topBy(earlyValues, (item) => decisionFailureRate(item), CAUSALITY_LIMIT.early),
        byDeepestReach: topBy(earlyValues, (item) => item.deepestDepthReachedAfterDecision, CAUSALITY_LIMIT.early),
        solutionDecisions: earlyValues.filter((item) => item.branchesSolved > 0).slice(0, CAUSALITY_LIMIT.early),
      },
      candidateRankings: {
        byTimesTried: topBy(candidateValues, (item) => item.timesTried, CAUSALITY_LIMIT.candidates),
        byDeepFailures: topBy(candidateValues, (item) => item.deepFailures, CAUSALITY_LIMIT.candidates),
        byFailureRate: topBy(
          candidateValues.filter((item) => item.timesTried >= 3),
          (item) => (item.immediateFailures + item.deepFailures) / item.timesTried,
          CAUSALITY_LIMIT.candidates
        ),
        byNeighborElimination: topBy(candidateValues, (item) => item.valuesRemovedFromNeighbors, CAUSALITY_LIMIT.candidates),
        solutionCandidates: candidateValues.filter((item) => item.solutionUses > 0).slice(0, CAUSALITY_LIMIT.candidates),
      },
      wipeoutRankings: {
        byReason: mapToObject(wipeoutByReason),
        byAssignedSlot: topMap(wipeoutByAssignedSlot, CAUSALITY_LIMIT.slots),
        byEmptiedSlot: topMap(wipeoutByEmptiedSlot, CAUSALITY_LIMIT.slots),
        byIntersection: topMap(wipeoutByIntersection, CAUSALITY_LIMIT.slots),
        samples: wipeoutCauses.slice(0, CAUSALITY_LIMIT.wipeouts),
      },
      branchingDiagnostics,
      valueOrderingDiagnostics,
      heuristicDiagnostics,
      bestProgressState,
      instrumentation: {
        recordedEarlyDecisions: earlyDecisionStatsByKey.size,
        recordedCandidates: candidateStatsByAnswer.size,
        recordedWipeoutSamples: wipeoutCauses.length,
        approximateRecords:
          earlyDecisionStatsByKey.size +
          candidateStatsByAnswer.size +
          slotStatsById.size +
          wipeoutCauses.length +
          branchingSelections.length,
      },
    };
  }

  function buildDepthProfile(solved: boolean): CspBacktrackDepthProfile11 {
    const sortedBacktracks = [...backtracksByDepth.entries()].sort((a, b) => b[1] - a[1]);
    const top3 = sortedBacktracks.slice(0, 3).reduce((sum, [, count]) => sum + count, 0);
    return {
      backtracksByDepth: mapToObject(backtracksByDepth),
      nodesByDepth: mapToObject(nodesByDepth),
      wipeoutsByDepth: mapToObject(wipeoutsByDepth),
      quotaPrunesByDepth: mapToObject(quotaPrunesByDepth),
      maxDepthReached: solved ? slots.length : profile.maxDepth,
      depthWithMostBacktracks: sortedBacktracks[0]?.[0] ?? null,
      percentageBacktracksTop3Depths: stats.backtracks > 0 ? (top3 / stats.backtracks) * 100 : 0,
    };
  }

  function buildBranchingDiagnostics(): CspBranchingDiagnostics11 {
    const sortedSizes = [...selectedDomainSizes].sort((a, b) => a - b);
    const averageNeighborDomainSum =
      branchingSelections.length > 0
        ? branchingSelections.reduce((sum, item) => sum + item.neighborDomainSum, 0) / branchingSelections.length
        : 0;
    const averageUnassignedNeighborCount =
      branchingSelections.length > 0
        ? branchingSelections.reduce((sum, item) => sum + item.unassignedNeighbors, 0) / branchingSelections.length
        : 0;
    return {
      selectedDomainSizeHistogram: mapToObject(selectedDomainSizeHistogram),
      averageSelectedDomainSize:
        sortedSizes.length > 0 ? sortedSizes.reduce((sum, size) => sum + size, 0) / sortedSizes.length : 0,
      p50SelectedDomainSize: percentile(sortedSizes, 0.5),
      p75SelectedDomainSize: percentile(sortedSizes, 0.75),
      p90SelectedDomainSize: percentile(sortedSizes, 0.9),
      maxSelectedDomainSize: sortedSizes.at(-1) ?? 0,
      averageUnassignedNeighborCount,
      averageNeighborDomainSum,
      worstBranchingSelections: branchingSelections.slice(0, CAUSALITY_LIMIT.branching),
    };
  }

  function buildValueOrderingDiagnostics(): CspValueOrderingDiagnostics11 {
    const triedByOrdinal = new Map<number, number>();
    const solvedByOrdinal = new Map<number, number>();
    const immediateFailuresByOrdinal = new Map<number, number>();
    const deepFailuresByOrdinal = new Map<number, number>();
    const averageDescendantNodesByOrdinal = new Map<number, number>();
    const winningOrdinals: number[] = [];

    for (const [ordinal, item] of valueOrdinalStats) {
      triedByOrdinal.set(ordinal, item.tried);
      solvedByOrdinal.set(ordinal, item.solved);
      immediateFailuresByOrdinal.set(ordinal, item.immediate);
      deepFailuresByOrdinal.set(ordinal, item.deep);
      averageDescendantNodesByOrdinal.set(
        ordinal,
        item.descendantSamples > 0 ? item.descendantNodes / item.descendantSamples : 0
      );
      for (let index = 0; index < item.solved; index++) winningOrdinals.push(ordinal);
    }

    const top = valueOrdinalStats.get(0);
    const firstThree = [0, 1, 2].map((ordinal) => valueOrdinalStats.get(ordinal)).filter(Boolean) as MutableOrdinalStats[];
    const firstThreeTried = firstThree.reduce((sum, item) => sum + item.tried, 0);
    const firstThreeFailures = firstThree.reduce((sum, item) => sum + item.immediate + item.deep, 0);
    return {
      triedByOrdinal: limitedOrdinalObject(triedByOrdinal, 30),
      solvedByOrdinal: limitedOrdinalObject(solvedByOrdinal, 30),
      immediateFailuresByOrdinal: limitedOrdinalObject(immediateFailuresByOrdinal, 30),
      deepFailuresByOrdinal: limitedOrdinalObject(deepFailuresByOrdinal, 30),
      averageDescendantNodesByOrdinal: limitedOrdinalObject(averageDescendantNodesByOrdinal, 30),
      averageWinningOrdinal:
        winningOrdinals.length > 0
          ? winningOrdinals.reduce((sum, ordinal) => sum + ordinal, 0) / winningOrdinals.length
          : null,
      topCandidateFailureRate: top && top.tried > 0 ? (top.immediate + top.deep) / top.tried : 0,
      firstThreeCandidatesFailureRate: firstThreeTried > 0 ? firstThreeFailures / firstThreeTried : 0,
    };
  }

  function buildSearchProfile(solved: boolean): CspSearchProfile11 {
    const elapsedMs = Date.now() - startedAt;
    return {
      elapsedMs,
      nodesVisited: stats.nodesVisited,
      backtracks: stats.backtracks,
      nodesPerSecond: elapsedMs > 0 ? stats.nodesVisited / (elapsedMs / 1000) : stats.nodesVisited,
      maxDepth: solved ? slots.length : profile.maxDepth,
      bestAssignedSlots: solved ? slots.length : profile.bestAssignedSlots,
      bestThematicAssigned: profile.bestThematicAssigned,
      domainCloneCount: profile.domainCloneCount,
      copiedDomainItems: profile.copiedDomainItems,
      mrvCalls: profile.mrvCalls,
      mrvElapsedMs: profile.mrvElapsedMs,
      valueOrderingCalls: profile.valueOrderingCalls,
      valueOrderingElapsedMs: profile.valueOrderingElapsedMs,
      propagationCalls: profile.propagationCalls,
      propagationElapsedMs: profile.propagationElapsedMs,
      constraintChecks: profile.constraintChecks,
      domainValuesRemoved: profile.domainValuesRemoved,
      domainWipeouts: profile.domainWipeouts,
      rollbackCalls: profile.rollbackCalls,
      rollbackElapsedMs: profile.rollbackElapsedMs,
      averageSelectedDomainSize:
        profile.selectedDomainSizeSamples > 0
          ? profile.selectedDomainSizeTotal / profile.selectedDomainSizeSamples
          : 0,
      maxSelectedDomainSize: profile.maxSelectedDomainSize,
      averageBranchingFactor:
        profile.branchingFactorSamples > 0 ? profile.branchingFactorTotal / profile.branchingFactorSamples : 0,
      quotaPrunes: profile.quotaPrunes,
      quotaImpossibleAtDepth: profile.quotaImpossibleAtDepth,
      searchCausality: buildCausalityDiagnostics(solved),
    };
  }
}

export function buildCspCrossword11(opts: {
  pattern: string[];
  candidates: CspCandidate[];
  deadlineMs?: number;
  maxNodes?: number;
  seed?: number;
  minThematicEntries?: number;
  targetThematicEntries?: number;
}): CspBuildResult | null {
  return solveCrosswordPattern11(opts);
}

function compareCandidatesDeterministic(a: PreparedCandidate, b: PreparedCandidate): number {
  if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
  return a.answer.localeCompare(b.answer);
}

function compatibleWithAssignments(
  slot: CrosswordSlot,
  candidate: PreparedCandidate,
  assignments: Record<string, string>,
  slotById: Map<string, CrosswordSlot>
): boolean {
  for (const intersection of slot.intersections) {
    const otherAnswer = assignments[intersection.otherSlotId];
    if (!otherAnswer) continue;
    const otherSlot = slotById.get(intersection.otherSlotId);
    if (!otherSlot) return false;
    if (candidate.answer[intersection.ownIndex] !== otherAnswer[intersection.otherIndex]) {
      return false;
    }
  }
  return true;
}

function countCurrentCompatibleDomain(
  slot: CrosswordSlot,
  assignments: Record<string, string>,
  domains: Map<string, PreparedCandidate[]>,
  usedAnswers: Set<string>,
  slotById: Map<string, CrosswordSlot>
): number {
  return (domains.get(slot.id) ?? []).filter(
    (candidate) => !usedAnswers.has(candidate.answer) && compatibleWithAssignments(slot, candidate, assignments, slotById)
  ).length;
}

function selectNextSlot(
  slots: CrosswordSlot[],
  slotById: Map<string, CrosswordSlot>,
  assignments: Record<string, string>,
  domains: Map<string, PreparedCandidate[]>,
  usedAnswers: Set<string>,
  profile?: {
    mrvCalls: number;
    selectedDomainSizeTotal: number;
    selectedDomainSizeSamples: number;
    maxSelectedDomainSize: number;
    constraintChecks: number;
  }
): CrosswordSlot | null {
  let best: { slot: CrosswordSlot; domainSize: number; degree: number } | null = null;
  if (profile) profile.mrvCalls++;

  for (const slot of slots) {
    if (assignments[slot.id]) continue;

    const compatible = (domains.get(slot.id) ?? []).filter(
      (candidate) => {
        if (profile) profile.constraintChecks++;
        return !usedAnswers.has(candidate.answer) && compatibleWithAssignments(slot, candidate, assignments, slotById);
      }
    );

    if (compatible.length === 0) return null;

    const degree = slot.intersections.filter((intersection) => !assignments[intersection.otherSlotId]).length;
    if (
      !best ||
      compatible.length < best.domainSize ||
      (compatible.length === best.domainSize && degree > best.degree) ||
      (compatible.length === best.domainSize && degree === best.degree && slot.id.localeCompare(best.slot.id) < 0)
    ) {
      best = { slot, domainSize: compatible.length, degree };
    }
  }

  if (best) {
    if (profile) {
      profile.selectedDomainSizeTotal += best.domainSize;
      profile.selectedDomainSizeSamples++;
      profile.maxSelectedDomainSize = Math.max(profile.maxSelectedDomainSize, best.domainSize);
    }
  }

  return best?.slot ?? null;
}

function orderValues(
  slot: CrosswordSlot,
  assignments: Record<string, string>,
  domains: Map<string, PreparedCandidate[]>,
  usedAnswers: Set<string>,
  seed: number,
  slotById: Map<string, CrosswordSlot>,
  profile?: {
    valueOrderingCalls: number;
    constraintChecks: number;
  }
): PreparedCandidate[] {
  if (profile) profile.valueOrderingCalls++;
  return (domains.get(slot.id) ?? [])
    .filter(
      (candidate) => {
        if (profile) profile.constraintChecks++;
        return !usedAnswers.has(candidate.answer) && compatibleWithAssignments(slot, candidate, assignments, slotById);
      }
    )
    .map((candidate) => ({
      candidate,
      remainingOptions: estimateRemainingOptions(slot, candidate, assignments, domains, usedAnswers, slotById),
    }))
    .sort((a, b) => {
      if (a.remainingOptions !== b.remainingOptions) return b.remainingOptions - a.remainingOptions;
      if (a.candidate.thematic !== b.candidate.thematic) return a.candidate.thematic ? -1 : 1;
      const seeded = seededTieBreak(a.candidate.answer, seed) - seededTieBreak(b.candidate.answer, seed);
      if (seeded !== 0) return seeded;
      return a.candidate.answer.localeCompare(b.candidate.answer);
    })
    .map((item) => item.candidate);
}

function countAssignedKinds(
  assignments: Record<string, string>,
  byAnswer: Map<string, PreparedCandidate>
): Pick<CspSolveReport, "thematicEntryCount" | "supportEntryCount" | "thematicAnswers" | "supportAnswers"> {
  const thematicAnswers: string[] = [];
  const supportAnswers: string[] = [];
  for (const answer of Object.values(assignments)) {
    const candidate = byAnswer.get(answer);
    if (candidate?.thematic) thematicAnswers.push(answer);
    else supportAnswers.push(answer);
  }
  thematicAnswers.sort();
  supportAnswers.sort();
  return {
    thematicEntryCount: thematicAnswers.length,
    supportEntryCount: supportAnswers.length,
    thematicAnswers,
    supportAnswers,
  };
}

function estimateRemainingOptions(
  slot: CrosswordSlot,
  candidate: PreparedCandidate,
  assignments: Record<string, string>,
  domains: Map<string, PreparedCandidate[]>,
  usedAnswers: Set<string>,
  slotById: Map<string, CrosswordSlot>
): number {
  let total = 0;

  for (const intersection of slot.intersections) {
    if (assignments[intersection.otherSlotId]) continue;
    const otherSlot = slotById.get(intersection.otherSlotId);
    if (!otherSlot) continue;
    const needed = candidate.answer[intersection.ownIndex];
    total += (domains.get(otherSlot.id) ?? []).filter(
      (otherCandidate) =>
        otherCandidate.answer !== candidate.answer &&
        !usedAnswers.has(otherCandidate.answer) &&
        otherCandidate.answer[intersection.otherIndex] === needed &&
        compatibleWithAssignments(otherSlot, otherCandidate, assignments, slotById)
    ).length;
  }

  return total;
}

function seededTieBreak(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0;
  }
  return hash;
}

function forwardCheck(
  slot: CrosswordSlot,
  candidate: PreparedCandidate,
  domains: Map<string, PreparedCandidate[]>,
  assignments: Record<string, string>,
  usedAnswers: Set<string>,
  slotById: Map<string, CrosswordSlot>,
  localProfile?: {
    propagationCalls: number;
    propagationElapsedMs: number;
    domainCloneCount: number;
    copiedDomainItems: number;
    constraintChecks: number;
    domainValuesRemoved: number;
    domainWipeouts: number;
  }
): { domains: Map<string, PreparedCandidate[]> } | { conflict: CspPropagationConflict11 } | null {
  const propagationStart = Date.now();
  const nextDomains = new Map<string, PreparedCandidate[]>();
  for (const [slotId, domain] of domains) {
    nextDomains.set(slotId, domain);
  }
  if (localProfile) {
    localProfile.propagationCalls++;
    localProfile.domainCloneCount++;
    localProfile.copiedDomainItems += domains.size;
  }

  const affectedSlotIds = new Set(slot.intersections.map((intersection) => intersection.otherSlotId));
  for (const slotId of affectedSlotIds) {
    const domain = nextDomains.get(slotId) ?? [];
    if (slotId === slot.id) continue;
    if (assignments[slotId]) continue;

    let filtered = domain.filter((item) => {
      if (localProfile) localProfile.constraintChecks++;
      return item.answer !== candidate.answer && !usedAnswers.has(item.answer);
    });

    const otherSlot = slotById.get(slotId);
    if (!otherSlot) return null;

    const constraints = collectRequiredConstraintsForSlot(otherSlot, slot, candidate.answer, assignments, slotById);
    const reductions: CspPropagationConflict11["candidateCountBeforeEachConstraint"] = [];

    for (const intersection of slot.intersections) {
      if (intersection.otherSlotId !== slotId) continue;
      const needed = candidate.answer[intersection.ownIndex];
      const before = filtered.length;
      filtered = filtered.filter((item) => {
        if (localProfile) localProfile.constraintChecks++;
        return item.answer[intersection.otherIndex] === needed;
      });
      if (localProfile) localProfile.domainValuesRemoved += before - filtered.length;
      reductions.push({
        position: intersection.otherIndex,
        requiredLetter: needed,
        before,
        after: filtered.length,
      });
    }

    for (const intersection of otherSlot.intersections) {
      const otherAnswer = assignments[intersection.otherSlotId];
      if (!otherAnswer) continue;
      const needed = otherAnswer[intersection.otherIndex];
      const before = filtered.length;
      filtered = filtered.filter((item) => {
        if (localProfile) localProfile.constraintChecks++;
        return item.answer[intersection.ownIndex] === needed;
      });
      if (localProfile) localProfile.domainValuesRemoved += before - filtered.length;
      reductions.push({
        position: intersection.ownIndex,
        requiredLetter: needed,
        before,
        after: filtered.length,
      });
    }

    if (filtered.length === 0) {
      if (localProfile) {
        localProfile.domainWipeouts++;
        localProfile.propagationElapsedMs += Date.now() - propagationStart;
      }
      return {
        conflict: {
          emptiedSlotId: otherSlot.id,
          emptiedSlotLength: otherSlot.length,
          previousDomainSize: domain.length,
          constraints,
          candidateCountBeforeEachConstraint: reductions,
          assignedSlots: [
            ...Object.entries(assignments).map(([slotIdValue, answer]) => ({ slotId: slotIdValue, answer })),
            { slotId: slot.id, answer: candidate.answer },
          ].sort((a, b) => a.slotId.localeCompare(b.slotId)),
        },
      };
    }
    if (localProfile) localProfile.copiedDomainItems += filtered.length;
    nextDomains.set(slotId, filtered);
  }

  if (localProfile) localProfile.propagationElapsedMs += Date.now() - propagationStart;
  return { domains: nextDomains };
}

function collectRequiredConstraintsForSlot(
  targetSlot: CrosswordSlot,
  newSourceSlot: CrosswordSlot,
  newSourceAnswer: string,
  assignments: Record<string, string>,
  slotById: Map<string, CrosswordSlot>
): CspRequiredLetterConstraint11[] {
  const constraints: CspRequiredLetterConstraint11[] = [];

  for (const intersection of targetSlot.intersections) {
    if (intersection.otherSlotId === newSourceSlot.id) {
      constraints.push({
        slotId: targetSlot.id,
        slotLength: targetSlot.length,
        position: intersection.ownIndex,
        requiredLetter: newSourceAnswer[intersection.otherIndex] ?? "",
        sourceSlotId: newSourceSlot.id,
        sourcePosition: intersection.otherIndex,
      });
      continue;
    }

    const assignedAnswer = assignments[intersection.otherSlotId];
    if (!assignedAnswer) continue;
    const sourceSlot = slotById.get(intersection.otherSlotId);
    if (!sourceSlot) continue;
    constraints.push({
      slotId: targetSlot.id,
      slotLength: targetSlot.length,
      position: intersection.ownIndex,
      requiredLetter: assignedAnswer[intersection.otherIndex] ?? "",
      sourceSlotId: sourceSlot.id,
      sourcePosition: intersection.otherIndex,
    });
  }

  return constraints
    .filter((constraint) => Boolean(constraint.requiredLetter))
    .sort((a, b) => a.position - b.position || a.sourceSlotId.localeCompare(b.sourceSlotId));
}

function summarizePropagationConflicts(
  conflicts: CspPropagationConflict11[]
): CspPropagationConflictSummaryItem11[] {
  const grouped = new Map<string, CspPropagationConflictSummaryItem11>();

  for (const conflict of conflicts) {
    const pattern = Array.from({ length: conflict.emptiedSlotLength }, () => "_");
    const positions = new Set<number>();
    for (const constraint of conflict.constraints) {
      pattern[constraint.position] = constraint.requiredLetter;
      positions.add(constraint.position);
    }
    const requiredPattern = pattern.join("");
    const key = `${conflict.emptiedSlotLength}:${requiredPattern}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrences++;
    } else {
      grouped.set(key, {
        slotLength: conflict.emptiedSlotLength,
        constrainedPositions: [...positions].sort((a, b) => a - b),
        requiredPattern,
        occurrences: 1,
      });
    }
  }

  return [...grouped.values()].sort(
    (a, b) =>
      b.occurrences - a.occurrences ||
      a.slotLength - b.slotLength ||
      a.requiredPattern.localeCompare(b.requiredPattern)
  );
}

function buildGridFromAssignments(
  pattern: string[],
  slots: CrosswordSlot[],
  assignments: Record<string, string>
): string[][] | null {
  const grid: string[][] = pattern.map((row) => row.split("").map((cell) => (cell === "#" ? "#" : "")));

  for (const slot of slots) {
    const answer = assignments[slot.id];
    if (!answer || answer.length !== slot.length) return null;

    for (let index = 0; index < slot.cells.length; index++) {
      const cell = slot.cells[index];
      const letter = answer[index];
      if (!cell || !letter) return null;
      const current = grid[cell.row]?.[cell.col];
      if (current === "#") return null;
      if (current !== "" && current !== letter) return null;
      grid[cell.row][cell.col] = letter;
    }
  }

  if (grid.some((row) => row.some((cell) => cell === ""))) return null;
  return grid;
}

function deriveEntries(grid: string[][]): Array<{
  direction: Direction;
  row: number;
  col: number;
  answer: string;
}> {
  const entries: Array<{ direction: Direction; row: number; col: number; answer: string }> = [];

  for (const direction of ["across", "down"] as const) {
    for (let outer = 0; outer < SIZE; outer++) {
      let inner = 0;
      while (inner < SIZE) {
        const read = (offset: number) =>
          direction === "across" ? grid[outer]?.[offset] : grid[offset]?.[outer];

        while (inner < SIZE && read(inner) === "#") inner++;
        const start = inner;
        let answer = "";
        while (inner < SIZE && read(inner) !== "#") {
          answer += read(inner);
          inner++;
        }
        if (answer.length >= MIN_SLOT_LENGTH) {
          entries.push({
            direction,
            row: direction === "across" ? outer : start,
            col: direction === "across" ? start : outer,
            answer,
          });
        }
      }
    }
  }

  return entries;
}

function validateFinalGrid(
  grid: string[][],
  slots: CrosswordSlot[],
  assignments: Record<string, string>
): boolean {
  if (grid.length !== SIZE || grid.some((row) => row.length !== SIZE)) return false;
  if (slots.length < 15) return false;
  if (new Set(Object.values(assignments)).size !== Object.values(assignments).length) return false;
  if (slots.some((slot) => slot.intersections.length < 2)) return false;

  const derived = deriveEntries(grid);
  if (derived.length !== slots.length) return false;

  const slotByRun = new Map(
    slots.map((slot) => [`${slot.direction}:${slot.row}:${slot.col}:${slot.length}`, slot])
  );

  for (const entry of derived) {
    const slot = slotByRun.get(`${entry.direction}:${entry.row}:${entry.col}:${entry.answer.length}`);
    if (!slot) return false;
    if (assignments[slot.id] !== entry.answer) return false;
  }

  for (const slot of slots) {
    const answer = assignments[slot.id];
    if (!answer) return false;
    for (const intersection of slot.intersections) {
      const other = assignments[intersection.otherSlotId];
      if (!other) return false;
      if (answer[intersection.ownIndex] !== other[intersection.otherIndex]) return false;
    }
  }

  return true;
}

function incrementMap(map: Map<number, number>, key: number): void;
function incrementMap(map: Map<string, number>, key: string): void;
function incrementMap(map: Map<string | number, number>, key: string | number): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mapToObject(map: Map<number, number>): Record<number, number>;
function mapToObject(map: Map<string, number>): Record<string, number>;
function mapToObject(map: Map<string | number, number>): Record<string | number, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))));
}

function topMap(map: Map<string, number>, limit: number): Array<{ key: string; count: number }> {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function topShare(map: Map<string, number>): number {
  const total = [...map.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;
  return Math.max(...map.values()) / total;
}

function limitedOrdinalObject(map: Map<number, number>, limit: number): Record<number, number> {
  return Object.fromEntries(
    [...map.entries()]
      .sort(([a], [b]) => a - b)
      .slice(0, limit)
  );
}

function topBy<T>(items: T[], score: (item: T) => number, limit: number): T[] {
  return [...items]
    .sort((a, b) => score(b) - score(a) || JSON.stringify(a).localeCompare(JSON.stringify(b)))
    .slice(0, limit);
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * p) - 1));
  return sortedValues[index] ?? 0;
}

function finalizeSlotStats(stats: MutableSlotStats): CspSlotSearchStats11 {
  return {
    ...stats,
    averageSelectedDepth: stats.selectedCount > 0 ? stats.selectedAtDepthSum / stats.selectedCount : 0,
    averageDomainSizeWhenSelected:
      stats.selectedCount > 0 ? stats.domainSizeWhenSelectedSum / stats.selectedCount : 0,
    averageValuesRemovedPerAssignment:
      stats.successfulAssignments > 0 ? stats.totalValuesRemovedFromNeighbors / stats.successfulAssignments : 0,
  };
}

function finalizeCandidateStats(stats: MutableCandidateStats): CspCandidateSearchStats11 {
  return {
    answer: stats.answer,
    thematic: stats.thematic,
    length: stats.length,
    timesTried: stats.timesTried,
    timesCommitted: stats.timesCommitted,
    immediateFailures: stats.immediateFailures,
    deepFailures: stats.deepFailures,
    solutionUses: stats.solutionUses,
    valuesRemovedFromNeighbors: stats.valuesRemovedFromNeighbors,
    averageRemainingNeighborDomain:
      stats.remainingNeighborDomainSamples > 0
        ? stats.remainingNeighborDomainSum / stats.remainingNeighborDomainSamples
        : 0,
    maxDepthReachedAfterUse: stats.maxDepthReachedAfterUse,
    descendantNodes: stats.descendantNodes,
    descendantBacktracks: stats.descendantBacktracks,
  };
}

function decisionFailureRate(item: CspEarlyDecisionStats11): number {
  return item.timesTried > 0 ? (item.branchesFailed + item.immediateWipeouts) / item.timesTried : 0;
}

function averageFailureRate(items: CspEarlyDecisionStats11[]): number {
  if (items.length === 0) return 0;
  return items.reduce((sum, item) => sum + decisionFailureRate(item), 0) / items.length;
}
