import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { init, killThreads } from "z3-solver";
import { buildExactModel, classifyStatus, normalizeCandidates, type Placement, type Rules } from "./exactStructuralModel";
import { verifyExactStructure } from "./verifyExactStructure";

const apiPromise = init();
after(async () => { const api = await apiPromise; await killThreads(api.em); });
const square = ["ABC", "DEF", "GHI", "ADG", "BEH", "CFI"];
const small: Rules = { size: 3, minEntries: 6, maxEntries: 6, minAcross: 3, minDown: 3, minChecks: 2, densityPercent: 100, checkedPercent: 100 };
type Forced = [string, number, number, "across" | "down"];
async function solve(answers: string[], rules: Rules, force: Forced[] = [], only = false) {
  const built = await buildExactModel(await apiPromise, answers, rules, 10000);
  const chosen = new Set<number>();
  for (const [answer, row, col, direction] of force) {
    const i = built.placements.findIndex(p => p.answer === answer && p.row === row && p.col === col && p.direction === direction);
    assert.ok(i >= 0, "fixture placement exists"); chosen.add(i); built.solver.add(built.selected[i]);
  }
  if (only) built.selected.forEach((s, i) => { if (!chosen.has(i)) built.solver.add(s.not()); });
  const raw = await built.solver.check();
  let placements: Placement[] = [];
  if (raw === "sat") {
    const model = built.solver.model();
    placements = built.placements.filter((_, i) => built.ctx.isTrue(model.eval(built.selected[i], true)));
  }
  const verified = raw === "sat" ? verifyExactStructure(placements, answers, rules) : null;
  assert.notEqual(raw, "unknown", raw === "unknown" ? built.solver.reasonUnknown() : "");
  if (raw === "sat") assert.equal(verified?.valid, true, JSON.stringify(verified?.errors));
  return { raw, verified };
}
const loose: Rules = { size: 7, minEntries: 1, maxEntries: 42, minAcross: 0, minDown: 0, minChecks: 1, densityPercent: 0, checkedPercent: 0 };
test("known SAT jointly finds a topology and derives supplied entries", async () => {
  const result = await solve(square, small);
  assert.equal(result.raw, "sat"); assert.equal(result.verified?.entries.length, 6);
  assert.equal(result.verified?.crossings.weakEntries.length, 0);
});
test("known UNSAT has insufficient distinct candidates", async () => {
  assert.equal((await solve(square.slice(0, 5), small)).raw, "unsat");
});
test("incompatible crossing letters cannot coexist", async () => {
  assert.equal((await solve(["ABC", "XYZ"], loose, [["ABC", 2, 2, "across"], ["XYZ", 1, 3, "down"]])).raw, "unsat");
});
test("side touching without covering legal runs is rejected", async () => {
  assert.equal((await solve(["ABC", "ADE"], loose, [["ABC", 2, 1, "across"], ["ADE", 3, 1, "down"]])).raw, "unsat");
});
test("endpoints cannot continue into another entry", async () => {
  assert.equal((await solve(["ABC", "DEF"], loose, [["ABC", 2, 1, "across"], ["DEF", 1, 4, "down"]])).raw, "unsat");
});
test("normalization deduplicates and a candidate cannot occupy two slots", async () => {
  assert.deepEqual(normalizeCandidates([" á-b c ", "ABC", "DEF"], 7).answers, ["ABC", "DEF"]);
  assert.equal((await solve(["ABC", "DEF"], loose, [["ABC", 1, 1, "across"], ["ABC", 3, 1, "across"]])).raw, "unsat");
});
const fullSquare: Forced[] = [["ABC", 0, 0, "across"], ["DEF", 1, 0, "across"], ["GHI", 2, 0, "across"], ["ADG", 0, 0, "down"], ["BEH", 0, 1, "down"], ["CFI", 0, 2, "down"]];
test("every accidental additional maximal run must be selected and supplied", async () => {
  assert.equal((await solve(square, { ...small, minEntries: 3, minAcross: 0, minDown: 0, minChecks: 1 }, fullSquare.slice(0, 3), true)).raw, "unsat");
  assert.equal((await solve(square, small, fullSquare, true)).raw, "sat");
});
test("a single checked cell cannot satisfy two-check requirement", async () => {
  assert.equal((await solve(["ABCDE", "XCY"], { ...loose, minEntries: 2, maxEntries: 2, minChecks: 2 })).raw, "unsat");
  assert.equal((await solve(["ABCDE", "XCY"], { ...loose, minEntries: 2, maxEntries: 2 })).raw, "sat");
});
test("direction balance is encoded", async () => {
  assert.equal((await solve(square, { ...small, minAcross: 4 })).raw, "unsat");
});
test("density and checked ratio thresholds are independent hard constraints", async () => {
  const words = ["ABCDE", "XCY"], rules = { ...loose, minEntries: 2, maxEntries: 2 };
  assert.equal((await solve(words, rules)).raw, "sat");
  assert.equal((await solve(words, { ...rules, densityPercent: 15 })).raw, "unsat");
  assert.equal((await solve(words, { ...rules, checkedPercent: 15 })).raw, "unsat");
});
test("otherwise valid disconnected components are excluded by solver connectivity", async () => {
  const second = ["JKL", "MNO", "PQR", "JMP", "KNQ", "LOR"];
  const other: Forced[] = second.map((a, i) => [a, i < 3 ? 4 + i : 4, i < 3 ? 4 : 4 + i - 3, i < 3 ? "across" : "down"]);
  assert.equal((await solve([...square, ...second], { ...loose, minEntries: 12, minChecks: 2 }, [...fullSquare, ...other], true)).raw, "unsat");
});
test("timeout/unknown/errors and failed verification never become UNSAT or SAT", () => {
  for (const raw of ["unknown", "timeout", "interrupted", "error", "unsupported"]) assert.equal(classifyStatus(raw, false, true), "INCONCLUSIVE");
  assert.equal(classifyStatus("unsat", false, false), "INCONCLUSIVE");
  assert.equal(classifyStatus("sat", false, true), "INCONCLUSIVE");
  assert.equal(classifyStatus("sat", true, true), "SAT");
  assert.equal(classifyStatus("unsat", false, true), "UNSAT");
});
test("model has no fixed-pattern dependency or constructor seed", () => {
  const source = readFileSync("scripts/lib/exactStructuralModel.ts", "utf8");
  assert.doesNotMatch(source, /crosswordPatterns11|multiState11|crosswordCsp11/);
});
test("independent verifier rejects a vocabulary mismatch", async () => {
  const result = await solve(square, small);
  assert.ok(result.verified?.entries.every(e => square.includes(e.answer)));
  const fake: Placement[] = [{ answer: "ZZZ", candidate: 0, row: 0, col: 0, direction: "across", cells: [0, 1, 2] }];
  assert.ok(verifyExactStructure(fake, square, loose).errors.includes("unsupplied-answer"));
});
