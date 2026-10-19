import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, relative, isAbsolute } from "node:path";
import { init, killThreads } from "z3-solver";
import { buildExactModel, classifyStatus, EXACTNESS, normalizeCandidates, PRODUCTION_RULES, SOLVE_TIMEOUT_MS } from "./lib/exactStructuralModel";
import { verifyExactStructure } from "./lib/verifyExactStructure";

async function main() {
  const [inputArg, outArg] = process.argv.slice(2);
  if (!inputArg || !outArg) throw Error("Usage: npm run feasibility -- <capture.json> <artifact-directory>");
  const inputPath = resolve(inputArg), out = resolve(outArg), rel = relative(process.cwd(), out);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw Error("Artifacts must be outside the repository");
  if (existsSync(join(out, "started.json"))) throw Error("Refusing repeated solve in this artifact directory");
  const raw = readFileSync(inputPath);
  const capture = JSON.parse(raw.toString("utf8")) as { size: number; candidates: Array<{ answer: string; thematic: boolean; source: string }>; maxPlacedWords: number; forbiddenAnswers: string[]; seed: number; maxBuilds: number };
  if (capture.size !== 11 || capture.maxPlacedWords !== 42 || !Array.isArray(capture.candidates) || !capture.candidates.every(c => typeof c.answer === "string") || !Array.isArray(capture.forbiddenAnswers) || capture.forbiddenAnswers.length) throw Error("Unsupported capture contract; requires 11x11, maximum 42 and empty forbidden set");
  const normalized = normalizeCandidates(capture.candidates.map(c => c.answer), 11);
  const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
  const metadata = { inputPath, inputSha256: hash(raw), normalizedSha256: hash(JSON.stringify(normalized.answers)), inputCount: capture.candidates.length, normalizedCount: normalized.answers.length, normalized, rules: PRODUCTION_RULES, rulesSha256: hash(JSON.stringify(PRODUCTION_RULES)), solverTimeoutMs: SOLVE_TIMEOUT_MS, node: process.version, seedIgnored: capture.seed, maxBuildsIgnored: capture.maxBuilds, deadlineIgnored: true, exactness: EXACTNESS };
  mkdirSync(out, { recursive: true });
  const save = (file: string, value: unknown) => writeFileSync(join(out, file), JSON.stringify(value, null, 2));
  const log = (event: string, details: unknown) => { const line = JSON.stringify({ event, details }); appendFileSync(join(out, "events.jsonl"), line + "\n"); console.log(line); };
  writeFileSync(join(out, "started.json"), JSON.stringify(metadata, null, 2), { flag: "wx" });
  save("normalized-candidates.json", normalized);
  copyFileSync(inputPath, join(out, "input-capture.json"));
  const sources = ["scripts/exact-structural-feasibility.ts", "scripts/run-structural-feasibility.mjs", "scripts/lib/exactStructuralModel.ts", "scripts/lib/verifyExactStructure.ts", "scripts/lib/exactStructuralModel.test.ts", "package.json", "package-lock.json"];
  const sourceHashes: Record<string, string> = {};
  for (const source of sources) {
    const sourceBytes = readFileSync(source); sourceHashes[source] = hash(sourceBytes);
    writeFileSync(join(out, source.replaceAll("/", "__")), sourceBytes);
  }
  save("source-hashes.json", sourceHashes);
  // A crash/termination leaves an explicit INCONCLUSIVE result, never an inferred UNSAT.
  save("result.json", { ...metadata, status: "INCONCLUSIVE", reason: "not-completed", modelComplete: false });
  let api: Awaited<ReturnType<typeof init>> | undefined;
  const started = performance.now();
  try {
    api = await init();
    const solverVersion = { package: JSON.parse(readFileSync(require.resolve("z3-solver/package.json"), "utf8")).version as string, engine: api.getVersionString() };
    log("model-building", solverVersion);
    const built = await buildExactModel(api, normalized.answers, PRODUCTION_RULES);
    const buildMs = Math.round(performance.now() - started);
    const smt = built.solver.toString();
    writeFileSync(join(out, "model.smt2"), smt + "\n(check-sat)\n");
    save("model-summary.json", { ...metadata, solverVersion, buildMs, ...built.summary, smtSha256: hash(smt) });
    log("solve-started", { solverTimeoutMs: SOLVE_TIMEOUT_MS, ...built.summary, buildMs });
    const solveStart = performance.now();
    const rawStatus = await built.solver.check(); // Exactly one real check; no retry or alternate configuration.
    const solveMs = Math.round(performance.now() - solveStart);
    const statistics = Object.fromEntries(built.solver.statistics().entries().map(s => [s.key, s.value]));
    let verification: ReturnType<typeof verifyExactStructure> | null = null;
    let selectedPlacements: typeof built.placements | null = null;
    if (rawStatus === "sat") {
      const assignment = built.solver.model();
      selectedPlacements = built.placements.filter((_, i) => built.ctx.isTrue(assignment.eval(built.selected[i], true)));
      verification = verifyExactStructure(selectedPlacements, normalized.answers, PRODUCTION_RULES);
    }
    const status = classifyStatus(rawStatus, verification?.valid === true, true);
    const result = { ...metadata, solverVersion, status, rawStatus, reasonUnknown: rawStatus === "unknown" ? built.solver.reasonUnknown() : null, modelComplete: true, buildMs, solveMs, elapsedMs: Math.round(performance.now() - started), statistics, modelSummary: built.summary, selectedPlacements, verification };
    save("result.json", result);
    log("completed", { status, rawStatus, solveMs, entries: verification?.entries.length, reasonUnknown: result.reasonUnknown });
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    save("result.json", { ...metadata, status: "INCONCLUSIVE", reason, elapsedMs: Math.round(performance.now() - started), modelComplete: false });
    log("error", reason);
    process.exitCode = 1;
  } finally {
    if (api) await killThreads(api.em);
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
