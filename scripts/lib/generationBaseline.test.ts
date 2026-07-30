import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateGeneratedCrossword, generationBaselineStats, summarizeGenerationBaseline } from "./evaluateGeneratedCrossword";
import type { GenerationBaselineRunInfo } from "./generationBaselineTypes";
import {
  compareGenerationBaselineSummaries,
  readGenerationBaselineSummary,
  writeGenerationBaselineReport,
} from "./writeGenerationBaselineReport";
import { GENERATION_BASELINE_CASES, parseGenerationBaselineArgs, runGenerationBaseline } from "../run-generation-baseline";

const run: GenerationBaselineRunInfo = {
  benchmarkRunId: "test-run",
  timestamp: "2026-07-30T00:00:00.000Z",
  gitCommit: "abc123",
  execute: false,
  dryRun: true,
  repeat: 1,
  language: "en",
  size: 11,
  timeoutMs: 300_000,
  caseCount: 1,
  plannedGenerations: 1,
};

test("baseline matrix contains the twelve versioned neutral evaluation fixtures", () => {
  assert.equal(GENERATION_BASELINE_CASES.length, 12);
  assert.deepEqual(
    GENERATION_BASELINE_CASES.map((item) => item.theme),
    [
      "Taylor Swift",
      "The Beatles",
      "Star Wars",
      "Argentina",
      "New York City",
      "Japanese cuisine",
      "Ancient Egypt",
      "Greek mythology",
      "The Renaissance",
      "Astronomy",
      "Dogs",
      "Classical music",
    ]
  );
});

test("CLI defaults to dry-run and supports filters without execution", () => {
  const options = parseGenerationBaselineArgs(["--case", "astronomy", "--repeat", "3", "--language", "en", "--size", "11"]);
  assert.equal(options.execute, false);
  assert.equal(options.dryRun, true);
  assert.equal(options.repeat, 3);
  assert.equal(options.cases.length, 1);
  assert.equal(options.cases[0].id, "astronomy");
});

test("evaluateGeneratedCrossword computes grid and provenance-based thematic metrics", () => {
  const evaluation = evaluateGeneratedCrossword({
    identity: {
      benchmarkRunId: "test-run",
      timestamp: run.timestamp,
      gitCommit: run.gitCommit,
      caseId: "synthetic",
      theme: "Neutral topic",
      language: "en",
      size: 5,
      seed: "seed",
      attemptIndex: 0,
    },
    status: 200,
    durationMs: 1234,
    response: {
      grid: [
        ["A", "B", "C", "#", "D"],
        ["E", "#", "F", "#", "O"],
        ["G", "H", "I", "J", "G"],
        ["#", "#", "K", "#", "S"],
        ["L", "M", "N", "O", "P"],
      ],
      entries: [
        { number: 1, row: 0, col: 0, direction: "across", answer: "ABC", clue: "Synthetic clue" },
        { number: 2, row: 0, col: 4, direction: "down", answer: "DOGS", clue: "Synthetic clue" },
        { number: 3, row: 4, col: 0, direction: "across", answer: "LMNOP", clue: "Synthetic clue" },
      ],
      meta: {
        builder: "synthetic-builder",
        thematicKeepSet: ["ABC"],
        supportAnswers: ["DOGS"],
        candidatePoolFinalCount: 7,
      },
    },
  });
  assert.equal(evaluation.success, true);
  assert.equal(evaluation.grid.totalEntries, 3);
  assert.equal(evaluation.grid.acrossEntries, 2);
  assert.equal(evaluation.grid.downEntries, 1);
  assert.equal(evaluation.answers.confirmedThematicRatio, 1 / 3);
  assert.equal(evaluation.answers.confirmedSupportFillerRatio, 1 / 3);
  assert.equal(evaluation.answers.unknownRatio, 1 / 3);
  assert.deepEqual(evaluation.answers.usedAnswerLengths, { "3": 1, "4": 1, "5": 1 });
});

test("unavailable metrics remain null instead of being silently estimated", () => {
  const evaluation = evaluateGeneratedCrossword({
    identity: {
      benchmarkRunId: "test-run",
      timestamp: run.timestamp,
      gitCommit: run.gitCommit,
      caseId: "empty",
      theme: "Neutral topic",
      language: "en",
      size: 11,
      seed: "seed",
      attemptIndex: 0,
    },
    status: 503,
    durationMs: 10,
    response: { error: "failed" },
  });
  assert.equal(evaluation.grid.density, null);
  assert.equal(evaluation.pipeline.openAiCallCount, null);
  assert.ok(evaluation.unavailableMetrics.includes("grid.density"));
  assert.ok(evaluation.unavailableMetrics.includes("pipeline.openAiCallCount"));
});

test("summary aggregates median, p95, failures, builders, and unavailable fields", () => {
  const success = evaluateGeneratedCrossword({
    identity: {
      benchmarkRunId: "test-run",
      timestamp: run.timestamp,
      gitCommit: run.gitCommit,
      caseId: "ok",
      theme: "Neutral topic",
      language: "en",
      size: 3,
      seed: "seed",
      attemptIndex: 0,
    },
    status: 200,
    durationMs: 20_000,
    response: {
      grid: [
        ["A", "B", "C"],
        ["D", "E", "F"],
        ["G", "H", "I"],
      ],
      entries: [{ number: 1, row: 0, col: 0, direction: "across", answer: "ABC", clue: "Clue" }],
      meta: { builder: "builder-a", thematicKeepSet: ["ABC"] },
    },
  });
  const failed = evaluateGeneratedCrossword({
    identity: { ...success.identity, caseId: "failed" },
    status: 422,
    durationMs: 40_000,
    response: { error: "bad-grid", meta: { failureStage: "grid" } },
  });
  const summary = summarizeGenerationBaseline({ ...run, plannedGenerations: 2, caseCount: 2 }, [success, failed]);
  assert.equal(summary.successRate, 0.5);
  assert.equal(summary.durationMedianMs, 30_000);
  assert.equal(summary.durationP95Ms, 40_000);
  assert.equal(summary.under30SecondsRate, 0.5);
  assert.equal(summary.builderUsage["builder-a"], 1);
  assert.equal(summary.failuresByStageReason["grid:bad-grid"], 1);
});

test("dry-run writes artifacts and does not invoke the endpoint", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "generation-baseline-"));
  try {
    const result = await runGenerationBaseline({
      execute: false,
      dryRun: true,
      cases: [GENERATION_BASELINE_CASES[0]],
      repeat: 1,
      language: "en",
      size: 11,
      outputDir,
      timeoutMs: 10_000,
    });
    assert.ok("summary" in result && result.summary);
    assert.equal(result.summary.run.dryRun, true);
    assert.equal(result.summary.cases.length, 1);
    const runJson = await readFile(join(result.outputDir, "run.json"), "utf8");
    assert.match(runJson, /"dryRun": true/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("report serialization and comparison between two runs are deterministic", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "generation-baseline-report-"));
  try {
    const caseA = evaluateGeneratedCrossword({
      identity: {
        benchmarkRunId: "previous",
        timestamp: run.timestamp,
        gitCommit: run.gitCommit,
        caseId: "ok",
        theme: "Neutral topic",
        language: "en",
        size: 3,
        seed: "seed",
        attemptIndex: 0,
      },
      status: 200,
      durationMs: 100,
      response: {
        grid: [["A", "B", "C"]],
        entries: [{ number: 1, row: 0, col: 0, direction: "across", answer: "ABC", clue: "Clue" }],
        meta: { thematicKeepSet: ["ABC"] },
      },
    });
    const previous = summarizeGenerationBaseline({ ...run, benchmarkRunId: "previous" }, [caseA]);
    const current = summarizeGenerationBaseline({ ...run, benchmarkRunId: "current" }, [{ ...caseA, durationMs: 50 }]);
    await writeGenerationBaselineReport(outputDir, previous);
    await writeGenerationBaselineReport(outputDir, current);
    const loaded = await readGenerationBaselineSummary(join(outputDir, "previous"));
    const comparison = compareGenerationBaselineSummaries(loaded, current);
    assert.equal(comparison.metrics.durationMedianMs.status, "improvement");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("p50 and p95 helpers are stable for small samples", () => {
  assert.equal(generationBaselineStats.median([3, 1, 2]), 2);
  assert.equal(generationBaselineStats.percentile([10, 20, 30, 40], 95), 40);
});
