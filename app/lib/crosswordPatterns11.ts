import {
  extractSlotsFromPattern11,
  prepareCandidateDomains,
  solveCrosswordPattern11WithReport,
  validatePattern11,
  type CspCandidate,
  type CspFailureReason,
} from "./crosswordCsp11";

export type CrosswordPattern11 = {
  id: string;
  rows: string[];
  metadata?: {
    slotCount?: number;
    acrossCount?: number;
    downCount?: number;
    lengths?: Record<number, number>;
  };
};

export type PatternAnalysis11 = {
  valid: boolean;
  issues: string[];
  slotCount: number;
  acrossCount: number;
  downCount: number;
  lengthCounts: Record<number, number>;
  minIntersections: number;
  maxIntersections: number;
  averageIntersections: number;
  openCellCount: number;
  blockCount: number;
  openDensity: number;
  openCellsTopRow: number;
  openCellsBottomRow: number;
  openCellsLeftColumn: number;
  openCellsRightColumn: number;
  usedRows: number;
  usedColumns: number;
  openBoundingBox: {
    minRow: number;
    maxRow: number;
    minCol: number;
    maxCol: number;
    height: number;
    width: number;
  };
  boundingBoxCoverage: number;
};

export type PatternRank11 = {
  pattern: CrosswordPattern11;
  score: number;
  missingByLength: Record<number, number>;
  availableByLength: Record<number, number>;
  requiredByLength: Record<number, number>;
};

export type PatternBenchmarkScenario11 = {
  id: string;
  candidatesByPatternId: Record<string, CspCandidate[]>;
};

export type PatternBenchmark11 = {
  pattern: CrosswordPattern11;
  scenarioId: string;
  solved: boolean;
  nodesVisited: number;
  backtracks: number;
  elapsedMs: number;
  slotCount: number;
  lengthCounts: Record<number, number>;
  averageInitialDomainSize: number;
  minimumInitialDomainSize: number;
  failureReason: CspFailureReason | null;
};

export const CROSSWORD_PATTERNS_11: CrosswordPattern11[] = [
  {
    id: "csp11-wide-01",
    rows: [
      "#######....",
      "######.....",
      "#####......",
      "####.......",
      "###.......#",
      "###.....###",
      "#.......###",
      ".......####",
      "......#####",
      ".....######",
      "....#######",
    ],
    metadata: {
      slotCount: 22,
      acrossCount: 11,
      downCount: 11,
      lengths: { 4: 4, 5: 7, 6: 2, 7: 9 },
    },
  },
  {
    id: "csp11-wide-02",
    rows: [
      "#######....",
      "######.....",
      "#####......",
      "####.......",
      "####......#",
      "###.....###",
      "#......####",
      ".......####",
      "......#####",
      ".....######",
      "....#######",
    ],
    metadata: {
      slotCount: 22,
      acrossCount: 11,
      downCount: 11,
      lengths: { 4: 4, 5: 7, 6: 6, 7: 5 },
    },
  },
  {
    id: "csp11-wide-03",
    rows: [
      "#######....",
      "######.....",
      "#####......",
      "####.......",
      "###......##",
      "###.....###",
      "##......###",
      ".......####",
      "......#####",
      ".....######",
      "....#######",
    ],
    metadata: {
      slotCount: 22,
      acrossCount: 11,
      downCount: 11,
      lengths: { 4: 6, 5: 5, 6: 4, 7: 7 },
    },
  },
  {
    id: "csp11-wide-04",
    rows: [
      "#######....",
      "######.....",
      "#####......",
      "###........",
      "###.......#",
      "###.....###",
      "#.......###",
      "........###",
      "......#####",
      ".....######",
      "....#######",
    ],
    metadata: {
      slotCount: 22,
      acrossCount: 11,
      downCount: 11,
      lengths: { 4: 4, 5: 7, 6: 2, 7: 5, 8: 4 },
    },
  },
];

export function analyzePattern11(rows: string[]): PatternAnalysis11 {
  const validation = validatePattern11(rows);
  const slots = validation.slots.length > 0 ? validation.slots : extractSlotsFromPattern11(rows);
  const lengthCounts: Record<number, number> = {};

  for (const slot of slots) {
    lengthCounts[slot.length] = (lengthCounts[slot.length] ?? 0) + 1;
  }

  const intersections = slots.map((slot) => slot.intersections.length);
  const openCells: Array<{ row: number; col: number }> = [];
  for (let row = 0; row < rows.length; row++) {
    for (let col = 0; col < (rows[row]?.length ?? 0); col++) {
      if (rows[row]?.[col] === ".") openCells.push({ row, col });
    }
  }

  const totalCells = 11 * 11;
  const usedRows = new Set(openCells.map((cell) => cell.row)).size;
  const usedColumns = new Set(openCells.map((cell) => cell.col)).size;
  const minRow = openCells.length > 0 ? Math.min(...openCells.map((cell) => cell.row)) : -1;
  const maxRow = openCells.length > 0 ? Math.max(...openCells.map((cell) => cell.row)) : -1;
  const minCol = openCells.length > 0 ? Math.min(...openCells.map((cell) => cell.col)) : -1;
  const maxCol = openCells.length > 0 ? Math.max(...openCells.map((cell) => cell.col)) : -1;
  const height = openCells.length > 0 ? maxRow - minRow + 1 : 0;
  const width = openCells.length > 0 ? maxCol - minCol + 1 : 0;

  return {
    valid: validation.valid,
    issues: validation.issues,
    slotCount: slots.length,
    acrossCount: slots.filter((slot) => slot.direction === "across").length,
    downCount: slots.filter((slot) => slot.direction === "down").length,
    lengthCounts,
    minIntersections: intersections.length > 0 ? Math.min(...intersections) : 0,
    maxIntersections: intersections.length > 0 ? Math.max(...intersections) : 0,
    averageIntersections:
      intersections.length > 0
        ? intersections.reduce((sum, count) => sum + count, 0) / intersections.length
        : 0,
    openCellCount: openCells.length,
    blockCount: totalCells - openCells.length,
    openDensity: openCells.length / totalCells,
    openCellsTopRow: countOpenInRow(rows, 0),
    openCellsBottomRow: countOpenInRow(rows, 10),
    openCellsLeftColumn: countOpenInColumn(rows, 0),
    openCellsRightColumn: countOpenInColumn(rows, 10),
    usedRows,
    usedColumns,
    openBoundingBox: { minRow, maxRow, minCol, maxCol, height, width },
    boundingBoxCoverage: (height * width) / totalCells,
  };
}

export function rankPatternsForCandidates11(
  patterns: CrosswordPattern11[],
  candidates: CspCandidate[]
): PatternRank11[] {
  const availableByLength = countUniqueCandidatesByLength(candidates);

  return patterns
    .map((pattern) => {
      const analysis = analyzePattern11(pattern.rows);
      const requiredByLength = analysis.lengthCounts;
      const missingByLength: Record<number, number> = {};
      let missingTotal = 0;
      let marginScore = 0;
      let lengthCoverageScore = 0;

      for (const [lengthKey, required] of Object.entries(requiredByLength)) {
        const length = Number(lengthKey);
        const available = availableByLength[length] ?? 0;
        const missing = Math.max(0, required - available);
        if (missing > 0) missingByLength[length] = missing;
        missingTotal += missing;
        marginScore += Math.min(Math.max(0, available - required), required * 3);
        if (available >= required) lengthCoverageScore += 1;
      }

      const score =
        (analysis.valid ? 10_000 : -100_000) -
        missingTotal * 25_000 +
        marginScore * 120 +
        lengthCoverageScore * 350 +
        analysis.slotCount * 25 -
        countLongSlots(requiredByLength) * 180 +
        analysis.openDensity * 250;

      return {
        pattern,
        score,
        missingByLength,
        availableByLength: { ...availableByLength },
        requiredByLength: { ...requiredByLength },
      };
    })
    .sort((a, b) => b.score - a.score || a.pattern.id.localeCompare(b.pattern.id));
}

export function benchmarkPatterns11(opts: {
  patterns: CrosswordPattern11[];
  candidatesByPatternId?: Record<string, CspCandidate[]>;
  scenarios?: PatternBenchmarkScenario11[];
  runsPerPattern?: number;
  maxNodes?: number;
  deadlineMs?: number;
  seed?: number;
}): PatternBenchmark11[] {
  const runsPerPattern = opts.runsPerPattern ?? 1;
  const scenarios =
    opts.scenarios ??
    (opts.candidatesByPatternId
      ? [{ id: "default", candidatesByPatternId: opts.candidatesByPatternId }]
      : []);
  const out: PatternBenchmark11[] = [];

  for (const scenario of scenarios) {
    for (const pattern of opts.patterns) {
      let lastReport = solveCrosswordPattern11WithReport({
        pattern: pattern.rows,
        candidates: scenario.candidatesByPatternId[pattern.id] ?? [],
        maxNodes: opts.maxNodes,
        deadlineMs: opts.deadlineMs,
        seed: opts.seed ?? 0,
      });

      for (let run = 1; run < runsPerPattern; run++) {
        lastReport = solveCrosswordPattern11WithReport({
          pattern: pattern.rows,
          candidates: scenario.candidatesByPatternId[pattern.id] ?? [],
          maxNodes: opts.maxNodes,
          deadlineMs: opts.deadlineMs,
          seed: (opts.seed ?? 0) + run,
        });
      }

      const analysis = analyzePattern11(pattern.rows);
      const domains = prepareCandidateDomains(extractSlotsFromPattern11(pattern.rows), scenario.candidatesByPatternId[pattern.id] ?? []);
      const sizes = Array.from(domains.domainsBySlotId.values()).map((domain) => domain.length);
      out.push({
        pattern,
        scenarioId: scenario.id,
        solved: Boolean(lastReport.result),
        nodesVisited: lastReport.stats.nodesVisited,
        backtracks: lastReport.stats.backtracks,
        elapsedMs: lastReport.stats.elapsedMs,
        slotCount: analysis.slotCount,
        lengthCounts: analysis.lengthCounts,
        averageInitialDomainSize:
          sizes.length > 0 ? sizes.reduce((sum, size) => sum + size, 0) / sizes.length : 0,
        minimumInitialDomainSize: sizes.length > 0 ? Math.min(...sizes) : 0,
        failureReason: lastReport.failureReason,
      });
    }
  }

  return out;
}

function countOpenInRow(rows: string[], row: number): number {
  return Array.from(rows[row] ?? "").filter((cell) => cell === ".").length;
}

function countOpenInColumn(rows: string[], col: number): number {
  return rows.reduce((sum, row) => sum + (row[col] === "." ? 1 : 0), 0);
}

function countUniqueCandidatesByLength(candidates: CspCandidate[]): Record<number, number> {
  const byLength = new Map<number, Set<string>>();

  for (const candidate of candidates) {
    const answer = normalizeAnswer(candidate.answer);
    if (!answer) continue;
    const bucket = byLength.get(answer.length) ?? new Set<string>();
    bucket.add(answer);
    byLength.set(answer.length, bucket);
  }

  return Object.fromEntries(Array.from(byLength.entries()).map(([length, answers]) => [length, answers.size]));
}

function normalizeAnswer(answer: string): string {
  return answer
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function countLongSlots(requiredByLength: Record<number, number>): number {
  return Object.entries(requiredByLength).reduce(
    (sum, [length, count]) => sum + (Number(length) >= 9 ? count : 0),
    0
  );
}
