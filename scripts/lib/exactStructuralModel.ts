import { init, type Bool } from "z3-solver";
import { ASCII_A_TO_Z, normalizeAnswer } from "../../app/lib/crosswordUtils";

export type Rules = { size: number; minEntries: number; maxEntries: number; minAcross: number; minDown: number; minChecks: number; densityPercent: number; checkedPercent: number };
export const PRODUCTION_RULES: Rules = { size: 11, minEntries: 15, maxEntries: 42, minAcross: 6, minDown: 6, minChecks: 2, densityPercent: 40, checkedPercent: 20 };
export const SOLVE_TIMEOUT_MS = 180_000;
export type Placement = { answer: string; candidate: number; row: number; col: number; direction: "across" | "down"; cells: number[] };
export type ExactStatus = "SAT" | "UNSAT" | "INCONCLUSIVE";
export function classifyStatus(raw: string, verified: boolean, complete: boolean): ExactStatus {
  if (raw === "sat" && verified && complete) return "SAT";
  if (raw === "unsat" && complete) return "UNSAT";
  return "INCONCLUSIVE";
}
export function normalizeCandidates(raw: string[], size: number) {
  const seen = new Set<string>(), answers: string[] = [];
  const excluded: Array<{ index: number; answer: string; reason: string }> = [];
  raw.forEach((value, index) => {
    const answer = normalizeAnswer(value);
    const reason = !ASCII_A_TO_Z.test(answer) ? "alphabet" : answer.length < 3 || answer.length > size ? "length" : seen.has(answer) ? "duplicate" : null;
    if (reason) excluded.push({ index, answer, reason });
    else { seen.add(answer); answers.push(answer); }
  });
  return { answers, excluded };
}
export function placementUniverse(answers: string[], size: number): Placement[] {
  const placements: Placement[] = [];
  answers.forEach((answer, candidate) => {
    for (const direction of ["across", "down"] as const) {
      for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
        if (row + (direction === "down" ? answer.length : 1) > size || col + (direction === "across" ? answer.length : 1) > size) continue;
        placements.push({ answer, candidate, row, col, direction, cells: Array.from({ length: answer.length }, (_, i) => (row + (direction === "down" ? i : 0)) * size + col + (direction === "across" ? i : 0)) });
      }
    }
  });
  return placements;
}

export const EXACTNESS = {
  object: "Final maximal runs, not the reachable states of a particular heuristic constructor.",
  encoded: ["all in-bounds placements of every structurally eligible supplied answer", "at most one placement per normalized answer", "at most one owner per cell and orientation", "matching cell characters", "empty endpoints", "every adjacent occupied pair covered by a selected run", "occupied cells are exactly placement union", "entry count and direction cardinalities", "per-entry checked cells", "density and checked ratio using integer inequalities", "connected occupied-cell graph by strict descending ranks to one root"],
  consequences: ["selected placements equal ALL maximal runs of length >=3", "no length-two or accidental unsupplied runs", "no coincident or contained same-direction placements", "cell connectivity equals entry-intersection connectivity under run coverage", "all entries crossed when minChecks>=1"],
  overlap: "A fully checked maximal run is legitimate. The retained heuristic's rejection of insertions adding zero new cells is search-history dependent, not a ban on fully checked final entries. Redundant overlapping placement records are excluded by orientation ownership and maximal-run equivalence.",
  excluded: ["seed, build count, deadline and heuristic reachability", "clue and semantic publication gates"],
  verification: "Production derivation/crossing metrics, independent run/ownership/connectivity checks, and production structural validation for the real run. Any disagreement is INCONCLUSIVE, never UNSAT.",
  completeness: "Every connected legal final grid using these distinct answers maps to its maximal-run placement selection. Connectivity ranks exist via BFS. No pattern, fixed root location, seed placement, vocabulary ordering, or heuristic pruning constrains that mapping.",
};

export async function buildExactModel(api: Awaited<ReturnType<typeof init>>, answers: string[], rules: Rules, timeoutMs = SOLVE_TIMEOUT_MS) {
  if (!Number.isInteger(rules.size) || rules.size < 3 || rules.size > 11 || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw Error("Invalid model bounds");
  if (Object.values(rules).some(v => !Number.isInteger(v) || v < 0) || rules.minChecks < 1 || rules.minEntries < 1 || rules.maxEntries < rules.minEntries || rules.densityPercent > 100 || rules.checkedPercent > 100) throw Error("Invalid structural thresholds");
  if (new Set(answers).size !== answers.length || answers.some(a => a !== normalizeAnswer(a) || !ASCII_A_TO_Z.test(a) || a.length < 3 || a.length > rules.size)) throw Error("Candidates must be normalized and deduplicated");
  const ctx = new api.Context("feasibility");
  const { Bool: B, Int, And, Or, Not, Implies, If, Sum } = ctx;
  const solver = new ctx.Solver();
  solver.set("timeout", timeoutMs);
  const n = rules.size, count = n * n;
  const placements = placementUniverse(answers, n);
  const selected = placements.map((_, i) => B.const(`p${i}`));
  const horizontal = Array.from({ length: count }, (_, i) => B.const(`h${i}`));
  const vertical = Array.from({ length: count }, (_, i) => B.const(`v${i}`));
  const occupied = Array.from({ length: count }, (_, i) => B.const(`o${i}`));
  const checked = occupied.map((_, i) => And(horizontal[i], vertical[i]));
  const letters = occupied.map((_, i) => Int.const(`letter${i}`));
  const ranks = occupied.map((_, i) => Int.const(`rank${i}`));
  const owners = Array.from({ length: count }, () => ({ across: [] as number[], down: [] as number[] }));
  const pairs = new Map<string, number[]>();
  const byAnswer = answers.map(() => [] as number[]);
  const sum = (bs: Bool<"feasibility">[]) => Sum(Int.val(0), ...bs.map(b => If(b, Int.val(1), Int.val(0))));
  let assertions = 0;
  const add = (...constraints: Bool<"feasibility">[]) => { assertions += constraints.length; solver.add(...constraints); };
  const atMost = (bs: Bool<"feasibility">[], k: number) => bs.length ? ctx.AtMost(bs as [Bool<"feasibility">, ...Bool<"feasibility">[]], k) : B.val(k >= 0);
  const atLeast = (bs: Bool<"feasibility">[], k: number) => bs.length ? ctx.AtLeast(bs as [Bool<"feasibility">, ...Bool<"feasibility">[]], k) : B.val(k <= 0);
  placements.forEach((p, i) => {
    byAnswer[p.candidate].push(i);
    p.cells.forEach(c => owners[c][p.direction].push(i));
    p.cells.slice(1).forEach((c, j) => { const key = `${p.cells[j]}:${c}`; const list = pairs.get(key) ?? []; list.push(i); pairs.set(key, list); });
    const before = p.direction === "across" ? (p.col > 0 ? p.cells[0] - 1 : -1) : p.cells[0] - n;
    const after = p.direction === "across" ? (p.col + p.answer.length < n ? p.cells.at(-1)! + 1 : -1) : p.cells.at(-1)! + n;
    const constraints = p.cells.map((c, j) => letters[c].eq(p.answer.charCodeAt(j)));
    if (before >= 0) constraints.push(Not(occupied[before]));
    if (after >= 0 && after < count) constraints.push(Not(occupied[after]));
    constraints.push(atLeast(p.cells.map(c => checked[c]), rules.minChecks));
    add(Implies(selected[i], And(...constraints)));
  });
  for (const list of byAnswer) add(atMost(list.map(i => selected[i]), 1));
  for (let c = 0; c < count; c++) {
    const h = owners[c].across.map(i => selected[i]), v = owners[c].down.map(i => selected[i]);
    add(horizontal[c].eq(Or(...h)), vertical[c].eq(Or(...v)), occupied[c].eq(Or(horizontal[c], vertical[c])), atMost(h, 1), atMost(v, 1));
    // Every touching pair MUST belong to one selected maximal run. This covers
    // side touch and accidental runs without banning legitimate adjacent crossings.
    for (const next of [c % n < n - 1 ? c + 1 : -1, c + n < count ? c + n : -1]) {
      if (next >= 0) add(Implies(And(occupied[c], occupied[next]), Or(...(pairs.get(`${c}:${next}`) ?? []).map(i => selected[i]))));
    }
    const neighbors = [c % n > 0 ? c - 1 : -1, c % n < n - 1 ? c + 1 : -1, c - n, c + n].filter(x => x >= 0 && x < count);
    add(Implies(occupied[c], And(ranks[c].ge(0), ranks[c].lt(count), Or(ranks[c].eq(0), ...neighbors.map(j => And(occupied[j], ranks[j].lt(ranks[c])))))), Implies(Not(occupied[c]), ranks[c].eq(-1)));
  }
  add(sum(occupied.map((o, i) => And(o, ranks[i].eq(0)))).eq(1));
  add(atLeast(selected, rules.minEntries), atMost(selected, rules.maxEntries));
  add(atLeast(selected.filter((_, i) => placements[i].direction === "across"), rules.minAcross), atLeast(selected.filter((_, i) => placements[i].direction === "down"), rules.minDown));
  add(sum(occupied).mul(100).ge(count * rules.densityPercent), sum(checked).mul(100).ge(sum(occupied).mul(rules.checkedPercent)));
  return { ctx, solver, selected, placements, occupied, rules, summary: { placements: placements.length, candidateCount: answers.length, booleans: placements.length + 3 * count, integers: 2 * count, assertions, candidateLengths: answers.reduce<Record<string, number>>((a, w) => { a[w.length] = (a[w.length] ?? 0) + 1; return a; }, {}) } };
}
