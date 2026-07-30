import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { evaluateGeneratedCrossword, summarizeGenerationBaseline } from "./lib/evaluateGeneratedCrossword";
import type {
  BaselineLanguage,
  BenchmarkCase,
  EndpointCrosswordResponse,
  GenerationBaselineOptions,
  GenerationBaselineRunInfo,
} from "./lib/generationBaselineTypes";
import {
  compareGenerationBaselineSummaries,
  readGenerationBaselineSummary,
  renderBaselineComparisonMarkdown,
  writeGenerationBaselineReport,
} from "./lib/writeGenerationBaselineReport";

export const GENERATION_BASELINE_CASES: BenchmarkCase[] = [
  { id: "taylor-swift", theme: "Taylor Swift", category: "popular", defaultLanguage: "en", defaultSize: 11, seed: "gb-001" },
  { id: "the-beatles", theme: "The Beatles", category: "popular", defaultLanguage: "en", defaultSize: 11, seed: "gb-002" },
  { id: "star-wars", theme: "Star Wars", category: "popular", defaultLanguage: "en", defaultSize: 11, seed: "gb-003" },
  { id: "argentina", theme: "Argentina", category: "geographic", defaultLanguage: "en", defaultSize: 11, seed: "gb-004" },
  { id: "new-york-city", theme: "New York City", category: "geographic", defaultLanguage: "en", defaultSize: 11, seed: "gb-005" },
  { id: "japanese-cuisine", theme: "Japanese cuisine", category: "geographic", defaultLanguage: "en", defaultSize: 11, seed: "gb-006" },
  { id: "ancient-egypt", theme: "Ancient Egypt", category: "cultural", defaultLanguage: "en", defaultSize: 11, seed: "gb-007" },
  { id: "greek-mythology", theme: "Greek mythology", category: "cultural", defaultLanguage: "en", defaultSize: 11, seed: "gb-008" },
  { id: "the-renaissance", theme: "The Renaissance", category: "cultural", defaultLanguage: "en", defaultSize: 11, seed: "gb-009" },
  { id: "astronomy", theme: "Astronomy", category: "broad", defaultLanguage: "en", defaultSize: 11, seed: "gb-010" },
  { id: "dogs", theme: "Dogs", category: "broad", defaultLanguage: "en", defaultSize: 11, seed: "gb-011" },
  { id: "classical-music", theme: "Classical music", category: "broad", defaultLanguage: "en", defaultSize: 11, seed: "gb-012" },
];

type RouteModule = {
  POST: (request: Request) => Promise<{ status: number; json: () => Promise<unknown> }>;
};

function usage(): string {
  return [
    "Usage:",
    "  node .tmp-contract-tests/scripts/run-generation-baseline.js --dry-run",
    "  node .tmp-contract-tests/scripts/run-generation-baseline.js --execute --case astronomy",
    "  node .tmp-contract-tests/scripts/run-generation-baseline.js --execute --repeat 3",
    "  node .tmp-contract-tests/scripts/run-generation-baseline.js --compare <run-a> <run-b>",
  ].join("\n");
}

function parseLanguage(value: string): BaselineLanguage {
  if (value !== "en" && value !== "es") throw new Error(`Unsupported language: ${value}`);
  return value;
}

export function parseGenerationBaselineArgs(argv: string[]): GenerationBaselineOptions {
  let execute = false;
  let repeat = 1;
  let language: BaselineLanguage = "en";
  let size = 11;
  let outputDir = "outputs/generation-baseline";
  let timeoutMs = 300_000;
  let caseFilter: string | null = null;
  let compare: [string, string] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };
    if (arg === "--execute") execute = true;
    else if (arg === "--dry-run") execute = false;
    else if (arg === "--case") caseFilter = next();
    else if (arg === "--repeat") repeat = Number(next());
    else if (arg === "--language") language = parseLanguage(next());
    else if (arg === "--size") size = Number(next());
    else if (arg === "--output-dir") outputDir = next();
    else if (arg === "--timeout-ms") timeoutMs = Number(next());
    else if (arg === "--compare") compare = [next(), next()];
    else if (arg === "--help" || arg === "-h") throw new Error(usage());
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a positive integer");
  if (!Number.isInteger(size) || size < 3) throw new Error("--size must be a positive integer >= 3");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("--timeout-ms must be at least 1000");

  const normalizedFilter = caseFilter?.toLowerCase();
  const cases = normalizedFilter
    ? GENERATION_BASELINE_CASES.filter(
        (item) => item.id === normalizedFilter || item.theme.toLowerCase() === normalizedFilter
      )
    : GENERATION_BASELINE_CASES;
  if (cases.length === 0) throw new Error(`No benchmark case matched: ${caseFilter}`);

  return {
    execute,
    dryRun: !execute,
    cases,
    repeat,
    language,
    size,
    outputDir,
    timeoutMs,
    compare,
  };
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function makeRunId(timestamp = new Date().toISOString()): string {
  return `generation-baseline-${timestamp.replace(/[:.]/g, "-")}`;
}

function createRunInfo(options: GenerationBaselineOptions): GenerationBaselineRunInfo {
  return {
    benchmarkRunId: makeRunId(),
    timestamp: new Date().toISOString(),
    gitCommit: gitCommit(),
    execute: options.execute,
    dryRun: options.dryRun,
    repeat: options.repeat,
    language: options.language,
    size: options.size,
    timeoutMs: options.timeoutMs,
    caseCount: options.cases.length,
    plannedGenerations: options.cases.length * options.repeat,
  };
}

async function invokeEndpoint(
  route: RouteModule,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await route.POST(
      new Request("http://generation-baseline.local/api/generate-crossword", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function runExecute(options: GenerationBaselineOptions, run: GenerationBaselineRunInfo) {
  const route = (await import("../app/api/generate-crossword/route")) as unknown as RouteModule;
  const results = [];
  for (const benchmarkCase of options.cases) {
    for (let attemptIndex = 0; attemptIndex < options.repeat; attemptIndex += 1) {
      const seed = `${benchmarkCase.seed}-${attemptIndex + 1}`;
      const started = Date.now();
      try {
        const response = await invokeEndpoint(
          route,
          { theme: benchmarkCase.theme, language: options.language, size: options.size, seed },
          options.timeoutMs
        );
        const json = (await response.json().catch(() => ({}))) as EndpointCrosswordResponse;
        results.push(
          evaluateGeneratedCrossword({
            identity: {
              benchmarkRunId: run.benchmarkRunId,
              timestamp: new Date().toISOString(),
              gitCommit: run.gitCommit,
              caseId: benchmarkCase.id,
              theme: benchmarkCase.theme,
              language: options.language,
              size: options.size,
              seed,
              attemptIndex,
            },
            status: response.status,
            durationMs: Date.now() - started,
            response: json,
          })
        );
      } catch (error) {
        results.push(
          evaluateGeneratedCrossword({
            identity: {
              benchmarkRunId: run.benchmarkRunId,
              timestamp: new Date().toISOString(),
              gitCommit: run.gitCommit,
              caseId: benchmarkCase.id,
              theme: benchmarkCase.theme,
              language: options.language,
              size: options.size,
              seed,
              attemptIndex,
            },
            status: null,
            durationMs: Date.now() - started,
            exception: error,
          })
        );
      }
    }
  }
  return results;
}

async function runDry(options: GenerationBaselineOptions, run: GenerationBaselineRunInfo) {
  return options.cases.flatMap((benchmarkCase) =>
    Array.from({ length: options.repeat }, (_, attemptIndex) =>
      evaluateGeneratedCrossword({
        identity: {
          benchmarkRunId: run.benchmarkRunId,
          timestamp: run.timestamp,
          gitCommit: run.gitCommit,
          caseId: benchmarkCase.id,
          theme: benchmarkCase.theme,
          language: options.language,
          size: options.size,
          seed: `${benchmarkCase.seed}-${attemptIndex + 1}`,
          attemptIndex,
        },
        status: null,
        durationMs: 0,
        response: { meta: { failureStage: "dry-run", reason: "execution disabled" } },
      })
    )
  );
}

export async function runGenerationBaseline(options: GenerationBaselineOptions) {
  if (options.compare) {
    const previous = await readGenerationBaselineSummary(options.compare[0]);
    const current = await readGenerationBaselineSummary(options.compare[1]);
    const comparison = compareGenerationBaselineSummaries(previous, current);
    const outDir = resolve(options.outputDir, `comparison-${Date.now()}`);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
    await writeFile(join(outDir, "comparison.md"), renderBaselineComparisonMarkdown(comparison), "utf8");
    return { comparison, outputDir: outDir };
  }

  const run = createRunInfo(options);
  const cases = options.execute ? await runExecute(options, run) : await runDry(options, run);
  const summary = summarizeGenerationBaseline(run, cases);
  await writeGenerationBaselineReport(resolve(options.outputDir), summary);
  return { summary, outputDir: join(resolve(options.outputDir), run.benchmarkRunId) };
}

async function main(): Promise<void> {
  const options = parseGenerationBaselineArgs(process.argv.slice(2));
  const result = await runGenerationBaseline(options);
  if ("summary" in result && result.summary) {
    const summary = result.summary;
    console.log(
      JSON.stringify(
        {
          outputDir: result.outputDir,
          execute: summary.run.execute,
          dryRun: summary.run.dryRun,
          plannedGenerations: summary.run.plannedGenerations,
          cases: summary.run.caseCount,
          successRate: summary.successRate,
        },
        null,
        2
      )
    );
    if (!summary.run.execute) {
      console.log("Dry-run only: no endpoint invocation, no OpenAI call, no Supabase call.");
    }
  } else if ("comparison" in result) {
    console.log(JSON.stringify({ outputDir: result.outputDir, comparison: result.comparison }, null, 2));
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
