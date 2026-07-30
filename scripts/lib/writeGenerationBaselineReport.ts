import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BaselineComparison,
  BaselineComparisonMetric,
  GenerationBaselineSummary,
} from "./generationBaselineTypes";

function formatPercent(value: number | null): string {
  return value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number | null): string {
  return value === null ? "unavailable" : value.toFixed(2);
}

function compareNumber(previous: number | null, current: number | null, lowerIsBetter = false): BaselineComparisonMetric {
  if (previous === null || current === null) return { previous, current, status: "unavailable" };
  if (previous === current) return { previous, current, status: "unchanged" };
  const improved = lowerIsBetter ? current < previous : current > previous;
  return { previous, current, status: improved ? "improvement" : "regression" };
}

function compareRecord(previous: Record<string, number>, current: Record<string, number>): BaselineComparisonMetric {
  const previousText = JSON.stringify(previous);
  const currentText = JSON.stringify(current);
  return {
    previous: previousText,
    current: currentText,
    status: previousText === currentText ? "unchanged" : "unavailable",
  };
}

export function renderGenerationBaselineSummaryMarkdown(summary: GenerationBaselineSummary): string {
  const lines = [
    `# Generation Baseline ${summary.run.benchmarkRunId}`,
    "",
    "## Run",
    "",
    `- timestamp: ${summary.run.timestamp}`,
    `- git commit: ${summary.run.gitCommit ?? "unavailable"}`,
    `- execute: ${summary.run.execute}`,
    `- dryRun: ${summary.run.dryRun}`,
    `- cases: ${summary.run.caseCount}`,
    `- planned generations: ${summary.run.plannedGenerations}`,
    "",
    "## Summary",
    "",
    `- success rate: ${formatPercent(summary.successRate)}`,
    `- duration median ms: ${formatNumber(summary.durationMedianMs)}`,
    `- duration p95 ms: ${formatNumber(summary.durationP95Ms)}`,
    `- under 30 seconds: ${formatPercent(summary.under30SecondsRate)}`,
    `- average entries: ${formatNumber(summary.averageEntries)}`,
    `- median entries: ${formatNumber(summary.medianEntries)}`,
    `- average confirmed thematic ratio: ${formatPercent(summary.averageConfirmedThematicRatio)}`,
    `- median confirmed thematic ratio: ${formatPercent(summary.medianConfirmedThematicRatio)}`,
    `- average checked-cell ratio: ${formatPercent(summary.averageCheckedCellRatio)}`,
    "",
    "## Builder Usage",
    "",
    ...Object.entries(summary.builderUsage).map(([builder, count]) => `- ${builder}: ${count}`),
    "",
    "## Fallback Usage",
    "",
    ...Object.entries(summary.fallbackUsage).map(([fallback, count]) => `- ${fallback}: ${count}`),
    "",
    "## Failures",
    "",
    ...(Object.keys(summary.failuresByStageReason).length === 0
      ? ["- none"]
      : Object.entries(summary.failuresByStageReason).map(([reason, count]) => `- ${reason}: ${count}`)),
    "",
    "## Cases",
    "",
    "| case | success | duration ms | builder | entries | thematic | checked | failure |",
    "| --- | --- | ---: | --- | ---: | ---: | ---: | --- |",
    ...summary.cases.map((item) =>
      [
        item.identity.caseId,
        String(item.success),
        String(item.durationMs),
        item.pipeline.builder ?? "unavailable",
        item.grid.totalEntries === null ? "unavailable" : String(item.grid.totalEntries),
        formatPercent(item.answers.confirmedThematicRatio),
        formatPercent(item.grid.checkedCellRatio),
        item.failureReason ?? "",
      ].join(" | ")
    ).map((row) => `| ${row} |`),
    "",
    "## Best Cases",
    "",
    ...summary.bestCases.map((item) => `- ${item}`),
    "",
    "## Worst Cases",
    "",
    ...summary.worstCases.map((item) => `- ${item}`),
    "",
    "## Unavailable Metrics",
    "",
    ...(Object.keys(summary.unavailableMetrics).length === 0
      ? ["- none"]
      : Object.entries(summary.unavailableMetrics)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([metric, count]) => `- ${metric}: ${count}`)),
    "",
    "## Observations",
    "",
    "- This report records observed outputs only. It does not infer unavailable pipeline internals.",
  ];
  return `${lines.join("\n")}\n`;
}

export async function writeGenerationBaselineReport(
  outputDir: string,
  summary: GenerationBaselineSummary
): Promise<void> {
  const runDir = join(outputDir, summary.run.benchmarkRunId);
  const casesDir = join(runDir, "cases");
  await mkdir(casesDir, { recursive: true });
  await writeFile(join(runDir, "run.json"), `${JSON.stringify(summary.run, null, 2)}\n`, "utf8");
  await writeFile(
    join(runDir, "cases.jsonl"),
    `${summary.cases.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8"
  );
  await writeFile(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(join(runDir, "summary.md"), renderGenerationBaselineSummaryMarkdown(summary), "utf8");
  for (const item of summary.cases) {
    await writeFile(join(casesDir, `${item.identity.caseId}.json`), `${JSON.stringify(item, null, 2)}\n`, "utf8");
  }
}

export async function readGenerationBaselineSummary(runDir: string): Promise<GenerationBaselineSummary> {
  return JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as GenerationBaselineSummary;
}

export function compareGenerationBaselineSummaries(
  previous: GenerationBaselineSummary,
  current: GenerationBaselineSummary
): BaselineComparison {
  return {
    previousRunId: previous.run.benchmarkRunId,
    currentRunId: current.run.benchmarkRunId,
    metrics: {
      successRate: compareNumber(previous.successRate, current.successRate),
      durationMedianMs: compareNumber(previous.durationMedianMs, current.durationMedianMs, true),
      durationP95Ms: compareNumber(previous.durationP95Ms, current.durationP95Ms, true),
      confirmedThematicRatio: compareNumber(
        previous.averageConfirmedThematicRatio,
        current.averageConfirmedThematicRatio
      ),
      averageEntries: compareNumber(previous.averageEntries, current.averageEntries),
      checkedCellRatio: compareNumber(previous.averageCheckedCellRatio, current.averageCheckedCellRatio),
      builderUsage: compareRecord(previous.builderUsage, current.builderUsage),
      fallbackUsage: compareRecord(previous.fallbackUsage, current.fallbackUsage),
      failureReasons: compareRecord(previous.failuresByStageReason, current.failuresByStageReason),
    },
  };
}

export function renderBaselineComparisonMarkdown(comparison: BaselineComparison): string {
  const rows = Object.entries(comparison.metrics).map(
    ([metric, value]) => `| ${metric} | ${value.previous ?? "unavailable"} | ${value.current ?? "unavailable"} | ${value.status} |`
  );
  return [
    `# Generation Baseline Comparison`,
    "",
    `- previous: ${comparison.previousRunId ?? "unavailable"}`,
    `- current: ${comparison.currentRunId ?? "unavailable"}`,
    "",
    "| metric | previous | current | status |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "Small samples are descriptive only; this report does not claim statistical significance.",
    "",
  ].join("\n");
}
