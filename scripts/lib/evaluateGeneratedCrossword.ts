import type {
  AnswerMetrics,
  EndpointCrosswordResponse,
  GenerationCaseEvaluation,
  GenerationCaseIdentity,
  GenerationBaselineRunInfo,
  GenerationBaselineSummary,
  GridMetrics,
  PipelineMetrics,
  PublishMetrics,
} from "./generationBaselineTypes";

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeAnswerKey(answer: string): string {
  return answer.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function getMetaNumber(meta: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const direct = numberOrNull(meta[key]);
    if (direct !== null) return direct;
  }
  return null;
}

function getMetaStrings(meta: Record<string, unknown>, keys: string[]): string[] | null {
  for (const key of keys) {
    const direct = stringArrayOrNull(meta[key]);
    if (direct) return direct;
    const setLike = recordOrNull(meta[key]);
    if (setLike) {
      const values = Object.values(setLike).filter((value): value is string => typeof value === "string");
      if (values.length > 0) return values;
    }
  }
  return null;
}

function countGridCells(grid: string[][]): Pick<GridMetrics, "dimensions" | "openCells" | "blockCells" | "density"> {
  const rows = grid.length;
  const cols = Math.max(0, ...grid.map((row) => row.length));
  let openCells = 0;
  let blockCells = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (cell === "#") blockCells += 1;
      else openCells += 1;
    }
  }
  const total = openCells + blockCells;
  return {
    dimensions: { rows, cols },
    openCells,
    blockCells,
    density: total > 0 ? openCells / total : null,
  };
}

function isOpen(grid: string[][], row: number, col: number): boolean {
  return row >= 0 && row < grid.length && col >= 0 && col < (grid[row]?.length ?? 0) && grid[row][col] !== "#";
}

function countCrossingCells(grid: string[][]): { crossingCells: number; uncheckedCells: number; checkedCellRatio: number | null } {
  let crossingCells = 0;
  let uncheckedCells = 0;
  let openCells = 0;
  for (let row = 0; row < grid.length; row += 1) {
    for (let col = 0; col < grid[row].length; col += 1) {
      if (!isOpen(grid, row, col)) continue;
      openCells += 1;
      const across = isOpen(grid, row, col - 1) || isOpen(grid, row, col + 1);
      const down = isOpen(grid, row - 1, col) || isOpen(grid, row + 1, col);
      if (across && down) crossingCells += 1;
      else uncheckedCells += 1;
    }
  }
  return {
    crossingCells,
    uncheckedCells,
    checkedCellRatio: openCells > 0 ? crossingCells / openCells : null,
  };
}

function countConnectedComponents(grid: string[][]): number {
  const seen = new Set<string>();
  let components = 0;
  for (let row = 0; row < grid.length; row += 1) {
    for (let col = 0; col < grid[row].length; col += 1) {
      if (!isOpen(grid, row, col)) continue;
      const start = `${row},${col}`;
      if (seen.has(start)) continue;
      components += 1;
      const stack: Array<[number, number]> = [[row, col]];
      seen.add(start);
      while (stack.length > 0) {
        const [r, c] = stack.pop()!;
        for (const [nr, nc] of [
          [r - 1, c],
          [r + 1, c],
          [r, c - 1],
          [r, c + 1],
        ] as const) {
          const key = `${nr},${nc}`;
          if (seen.has(key) || !isOpen(grid, nr, nc)) continue;
          seen.add(key);
          stack.push([nr, nc]);
        }
      }
    }
  }
  return components;
}

function countShortRuns(grid: string[][]): number {
  let shortRuns = 0;
  for (const row of grid) {
    let run = 0;
    for (let col = 0; col <= row.length; col += 1) {
      if (col < row.length && row[col] !== "#") {
        run += 1;
      } else {
        if (run > 0 && run < 3) shortRuns += 1;
        run = 0;
      }
    }
  }
  const cols = Math.max(0, ...grid.map((row) => row.length));
  for (let col = 0; col < cols; col += 1) {
    let run = 0;
    for (let row = 0; row <= grid.length; row += 1) {
      if (row < grid.length && isOpen(grid, row, col)) {
        run += 1;
      } else {
        if (run > 0 && run < 3) shortRuns += 1;
        run = 0;
      }
    }
  }
  return shortRuns;
}

function evaluateGrid(response: EndpointCrosswordResponse): GridMetrics {
  const grid = response.grid;
  const entries = response.entries;
  if (!Array.isArray(grid)) {
    return {
      dimensions: null,
      openCells: null,
      blockCells: null,
      density: null,
      totalEntries: Array.isArray(entries) ? entries.length : null,
      acrossEntries: null,
      downEntries: null,
      crossingCells: null,
      checkedCellRatio: null,
      uncheckedCells: null,
      connectedComponents: null,
      shortRuns: null,
      validationAccepted: null,
      repairsApplied: response.meta?.repairsApplied ?? null,
    };
  }
  const counts = countGridCells(grid);
  const crossing = countCrossingCells(grid);
  return {
    ...counts,
    totalEntries: Array.isArray(entries) ? entries.length : null,
    acrossEntries: Array.isArray(entries) ? entries.filter((entry) => entry.direction === "across").length : null,
    downEntries: Array.isArray(entries) ? entries.filter((entry) => entry.direction === "down").length : null,
    crossingCells: crossing.crossingCells,
    checkedCellRatio: crossing.checkedCellRatio,
    uncheckedCells: crossing.uncheckedCells,
    connectedComponents: countConnectedComponents(grid),
    shortRuns: countShortRuns(grid),
    validationAccepted: booleanOrNull(response.meta?.validationAccepted ?? response.meta?.gridValidationAccepted),
    repairsApplied: response.meta?.repairsApplied ?? response.meta?.gridRepairs ?? null,
  };
}

function evaluateAnswers(response: EndpointCrosswordResponse): AnswerMetrics {
  const meta = response.meta ?? {};
  const entries = response.entries ?? [];
  const usedAnswers = entries.map((entry) => entry.answer);
  const thematicSet = new Set(
    (getMetaStrings(meta, ["thematicKeepSet", "broadThematicSet", "validatedAnswers", "thematicAnswers"]) ?? []).map(
      normalizeAnswerKey
    )
  );
  const supportSet = new Set((getMetaStrings(meta, ["supportAnswers", "fillerAnswers"]) ?? []).map(normalizeAnswerKey));
  const thematicUsedAnswers: string[] = [];
  const supportOrFillerUsedAnswers: string[] = [];
  const unknownUsedAnswers: string[] = [];
  for (const answer of usedAnswers) {
    const key = normalizeAnswerKey(answer);
    if (thematicSet.has(key)) thematicUsedAnswers.push(answer);
    else if (supportSet.has(key)) supportOrFillerUsedAnswers.push(answer);
    else unknownUsedAnswers.push(answer);
  }
  const lengths: Record<string, number> = {};
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const answer of usedAnswers) {
    lengths[String(answer.length)] = (lengths[String(answer.length)] ?? 0) + 1;
    const key = normalizeAnswerKey(answer);
    if (seen.has(key)) duplicates.push(answer);
    seen.add(key);
  }
  const knownClassification = thematicSet.size > 0 || supportSet.size > 0;
  const totalCells = usedAnswers.reduce((sum, answer) => sum + answer.length, 0);
  const thematicCells = thematicUsedAnswers.reduce((sum, answer) => sum + answer.length, 0);
  return {
    initialAnswerBankCount: getMetaNumber(meta, ["initialAnswerBankCount", "rawAnswerBankCount"]),
    sanitizedAnswerCount: getMetaNumber(meta, ["sanitizedAnswerCount", "cleanAnswerCount"]),
    mergedAnswerCount: getMetaNumber(meta, ["mergedAnswerCount", "normalizedAnswerBankCount"]),
    candidatePoolFinalCount: getMetaNumber(meta, ["candidatePoolFinalCount", "candidateCount"]),
    usedAnswers,
    thematicUsedAnswers,
    supportOrFillerUsedAnswers,
    unknownUsedAnswers,
    confirmedThematicRatio: knownClassification && usedAnswers.length > 0 ? thematicUsedAnswers.length / usedAnswers.length : null,
    confirmedSupportFillerRatio:
      knownClassification && usedAnswers.length > 0 ? supportOrFillerUsedAnswers.length / usedAnswers.length : null,
    unknownRatio: usedAnswers.length > 0 ? unknownUsedAnswers.length / usedAnswers.length : null,
    thematicCellRatio: knownClassification && totalCells > 0 ? thematicCells / totalCells : null,
    usedAnswerLengths: lengths,
    duplicates,
    rejectedByLanguageOrPolicy: getMetaNumber(meta, ["rejectedByLanguageOrPolicy", "languagePolicyRejected"]),
  };
}

function evaluatePipeline(response: EndpointCrosswordResponse): PipelineMetrics {
  const meta = response.meta ?? {};
  const attemptsByBuilder = recordOrNull(meta.attemptsByBuilder);
  return {
    builder: stringOrNull(meta.builder),
    strategiesAttempted: stringArrayOrNull(meta.strategiesAttempted),
    strategyOrder: stringArrayOrNull(meta.strategyOrder),
    attemptsByBuilder: attemptsByBuilder as Record<string, number> | null,
    deadlineExhausted: booleanOrNull(meta.deadlineExhausted),
    fallbackUsed: booleanOrNull(meta.fallbackUsed),
    answerBankSource: stringOrNull(meta.answerBankSource),
    openAiCallCount: getMetaNumber(meta, ["openAiCallCount", "openAICallCount"]),
    modelsUsed: stringArrayOrNull(meta.modelsUsed),
    tokenUsage: recordOrNull(meta.tokenUsage)
      ? {
          input: numberOrNull(recordOrNull(meta.tokenUsage)?.input),
          output: numberOrNull(recordOrNull(meta.tokenUsage)?.output),
        }
      : null,
    estimatedCost: numberOrNull(meta.estimatedCost),
  };
}

function evaluatePublish(response: EndpointCrosswordResponse): PublishMetrics {
  const entries = response.entries;
  const meta = response.meta ?? {};
  return {
    entriesWithClue: Array.isArray(entries) ? entries.filter((entry) => entry.clue.trim().length > 0).length : null,
    clueFallbacks: meta.clueFallbacks ?? null,
    editorialRepairs: meta.editorialRepairs ?? null,
    publishGateAccepted: booleanOrNull(meta.publishGateAccepted),
    finalWarnings: Array.isArray(meta.warnings) ? meta.warnings : [],
  };
}

function unavailableFor(evaluation: Omit<GenerationCaseEvaluation, "unavailableMetrics">): string[] {
  const unavailable: string[] = [];
  const visit = (prefix: string, value: unknown) => {
    if (value === null) unavailable.push(prefix);
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) visit(`${prefix}.${key}`, child);
    }
  };
  visit("pipeline", evaluation.pipeline);
  visit("grid", evaluation.grid);
  visit("answers", evaluation.answers);
  visit("publish", evaluation.publish);
  return unavailable;
}

export function evaluateGeneratedCrossword(input: {
  identity: GenerationCaseIdentity;
  status: number | null;
  durationMs: number;
  response?: EndpointCrosswordResponse;
  exception?: unknown;
}): GenerationCaseEvaluation {
  const response = input.response ?? {};
  const success = input.status !== null && input.status >= 200 && input.status < 300 && Array.isArray(response.entries);
  const error = input.exception instanceof Error ? input.exception : null;
  const evaluationWithoutUnavailable = {
    identity: input.identity,
    success,
    status: input.status,
    failureStage: stringOrNull(response.meta?.failureStage ?? response.diagnostic?.failureStage),
    failureReason: stringOrNull(response.error ?? response.meta?.reason ?? response.diagnostic?.failureReason),
    exceptionType: error ? error.name : input.exception ? typeof input.exception : null,
    exceptionMessage: error ? error.message : input.exception ? String(input.exception) : null,
    durationMs: input.durationMs,
    pipeline: evaluatePipeline(response),
    grid: evaluateGrid(response),
    answers: evaluateAnswers(response),
    publish: evaluatePublish(response),
    rawResponse: response,
  };
  return {
    ...evaluationWithoutUnavailable,
    unavailableMetrics: unavailableFor(evaluationWithoutUnavailable),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function increment(record: Record<string, number>, key: string | null): void {
  record[key ?? "unavailable"] = (record[key ?? "unavailable"] ?? 0) + 1;
}

export function summarizeGenerationBaseline(
  run: GenerationBaselineRunInfo,
  cases: GenerationCaseEvaluation[]
): GenerationBaselineSummary {
  const durations = cases.map((item) => item.durationMs);
  const entries = cases
    .map((item) => item.grid.totalEntries)
    .filter((item): item is number => typeof item === "number");
  const thematicRatios = cases
    .map((item) => item.answers.confirmedThematicRatio)
    .filter((item): item is number => typeof item === "number");
  const checkedRatios = cases
    .map((item) => item.grid.checkedCellRatio)
    .filter((item): item is number => typeof item === "number");
  const builderUsage: Record<string, number> = {};
  const fallbackUsage: Record<string, number> = {};
  const failuresByStageReason: Record<string, number> = {};
  const unavailableMetrics: Record<string, number> = {};
  for (const item of cases) {
    increment(builderUsage, item.pipeline.builder);
    increment(fallbackUsage, item.pipeline.fallbackUsed === null ? null : String(item.pipeline.fallbackUsed));
    if (!item.success) increment(failuresByStageReason, `${item.failureStage ?? "unknown"}:${item.failureReason ?? "unknown"}`);
    for (const metric of item.unavailableMetrics) increment(unavailableMetrics, metric);
  }
  const ranked = [...cases].sort((a, b) => {
    if (a.success !== b.success) return a.success ? -1 : 1;
    return (b.answers.confirmedThematicRatio ?? -1) - (a.answers.confirmedThematicRatio ?? -1);
  });
  return {
    run,
    successRate: cases.length > 0 ? cases.filter((item) => item.success).length / cases.length : 0,
    durationMedianMs: median(durations),
    durationP95Ms: percentile(durations, 95),
    under30SecondsRate: cases.length > 0 ? cases.filter((item) => item.durationMs < 30_000).length / cases.length : 0,
    builderUsage,
    fallbackUsage,
    averageEntries: average(entries),
    medianEntries: median(entries),
    averageConfirmedThematicRatio: average(thematicRatios),
    medianConfirmedThematicRatio: median(thematicRatios),
    averageCheckedCellRatio: average(checkedRatios),
    failuresByStageReason,
    bestCases: ranked.slice(0, 3).map((item) => item.identity.caseId),
    worstCases: ranked.slice(-3).map((item) => item.identity.caseId),
    unavailableMetrics,
    cases,
  };
}

export const generationBaselineStats = { median, percentile };
