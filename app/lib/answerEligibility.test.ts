import assert from "node:assert/strict";
import test from "node:test";
import { ANSWER_ELIGIBILITY_POLICY_VERSION, evaluateAnswerEligibility, filterEligibleAnswerCandidates } from "./answerEligibility";
import { CspCandidateIndex } from "./cspCandidateDomains";
import { normalizeCspAnswer11 } from "./crosswordCspAdapter11";
import { runJointCrosswordSearch11, validateJointTerminal } from "./jointCrosswordSearch11";
import { emptyJointState, type JointCandidate } from "./jointPlacementDomains11";
import { DEFAULT_JOINT_QUALITY_POLICY } from "./jointSearchQuality11";
import * as placementModule from "./jointPlacementDomains11";
import * as validationModule from "./gridValidation/validateGrid";

const prohibited = ["RETARD", "DIKE", "CATPISS"];
const policies = { isForbiddenPublishAnswer: () => false, isOverGenericThemeWord: () => false };

test("explicit exclusions use canonical grid normalization, exact equality and versioned reasons", () => {
  for (const answer of prohibited) {
    for (const variant of [answer, answer.toLowerCase(), answer.split("").join(" -_' ."), ` ${answer}\t`,
      answer.replace("A", "\u00e1").replace("I", "i\u0301")]) {
      const decision = evaluateAnswerEligibility(variant);
      assert.equal(decision.normalizedAnswer, normalizeCspAnswer11(variant));
      assert.equal(decision.normalizedAnswer, answer);
      assert.equal(decision.eligible, false);
      assert.ok(decision.reason?.startsWith("Explicit product exclusion:"));
      assert.equal(decision.policyVersion, ANSWER_ELIGIBILITY_POLICY_VERSION);
    }
  }
  for (const answer of ["RETARDANT", "DIKES", "CATPISSX", "GAYICON", "TRANS", "QUEER", "CO2", "13TH", "MP3J", "IRENE", "GOOGLEFU"]) {
    assert.equal(evaluateAnswerEligibility(answer).eligible, true, answer);
  }
});

test("filter reports source and eligible inventories without mutating records or losing eligible overlap metadata", () => {
  const source: JointCandidate[] = [
    ...prohibited.flatMap(answer => [
      { answer, thematic: false, source: "filler" as const, score: 100 },
      { answer: answer.toLowerCase(), thematic: true, source: "model" as const, score: 100 },
    ]),
    { answer: "gay icon", thematic: false, source: "filler", score: 0 },
    { answer: "GAYICON", thematic: true, source: "model", score: 0 },
    { answer: "CO2", thematic: false, source: "filler", score: 0 },
  ];
  const before = JSON.stringify(source);
  const filtered = filterEligibleAnswerCandidates(source);
  assert.equal(filtered.inventory.sourceCandidateCount, 9);
  assert.equal(filtered.inventory.eligibleCandidateCount, 3);
  assert.equal(filtered.inventory.sourceInventorySize, 5);
  assert.equal(filtered.inventory.eligibleInventorySize, 2);
  assert.deepEqual(filtered.inventory.exclusions.map(x => [x.answer, x.occurrences]), prohibited.map(x => [x, 2]));
  const index = new CspCandidateIndex(filtered.candidates, normalizeCspAnswer11);
  assert.equal(index.size, 2);
  for (const answer of prohibited) assert.equal(index.id(answer), undefined);
  assert.equal(index.candidate(index.id("GAYICON")!).thematic, true);
  assert.equal(index.candidate(index.id("CO2")!).score, 0);
  assert.equal(JSON.stringify(source), before);
});

test("mandatory ingestion removes all prohibited identities regardless of source order or quality settings", () => {
  for (const reverse of [false, true]) for (const qualityPolicy of [undefined, DEFAULT_JOINT_QUALITY_POLICY]) {
    const candidates: JointCandidate[] = prohibited.flatMap(answer => [
      { answer, thematic: true, source: "model" as const, score: 100 },
      { answer: answer.toLowerCase().split("").join("-"), thematic: false, source: "filler" as const, score: 100 },
    ]);
    if (reverse) candidates.reverse();
    const report = runJointCrosswordSearch11({ candidates, policies, qualityPolicy,
      targetThematicEntries: 1, maxNodes: 100, deadlineMs: 3000, seed: 1 });
    assert.equal(report.indexSize, 0);
    assert.equal(report.eligibilityInventory?.sourceInventorySize, 3);
    assert.equal(report.eligibilityInventory?.eligibleInventorySize, 0);
    assert.equal(report.metrics.alternativesConsidered, 0);
    assert.equal(report.bestState.placed.length, 0);
    assert.equal(report.result, null);
  }
});

test("poisoned external terminal cannot pass even when structural validation accepts and quality is optional", context => {
  const validate = validationModule.runGridValidation;
  // Isolate the content boundary from minimum-entry/density checks on this tiny fixture.
  context.mock.method(validationModule, "runGridValidation", (input: Parameters<typeof validate>[0]) =>
    ({ ...validate(input), accepted: true, issue: null }));
  for (const answer of [...prohibited, "GAYICON"]) for (const thematic of [true, false]) {
    const index = new CspCandidateIndex<JointCandidate>([{ answer, thematic, source: thematic ? "model" : "filler", score: 100 }], normalizeCspAnswer11);
    const state = emptyJointState();
    [...answer].forEach((letter, col) => { state.grid[0][col] = letter; state.ownership[0][col] = 1; });
    state.placed.push({ candidateId: 0, word: answer, row: 0, col: 0, dir: "across" });
    state.usedIds = new Set([0]); state.thematicCount = Number(thematic);
    const terminal = validateJointTerminal(state, index, 0, policies);
    assert.equal(terminal.derivationAgrees, true);
    assert.equal(terminal.validation.accepted, true);
    assert.equal(terminal.accepted, answer === "GAYICON");
    assert.equal(terminal.reason, answer === "GAYICON" ? null : "answer-ineligible");
    assert.equal(terminal.eligibility.policyVersion, ANSWER_ELIGIBILITY_POLICY_VERSION);
    assert.equal(terminal.eligibility.exclusions.length, answer === "GAYICON" ? 0 : 1);
  }
});

test("eligible search ordering, general fallback, closure and backtracking survive contaminated input unchanged", context => {
  const records: JointCandidate[] = ["CATS", "BAR", "RAT", "CAR", "BAT", "TAR", "ART"].map((answer, i) =>
    ({ answer, thematic: i % 2 === 0, source: i % 2 === 0 ? "model" : "filler", score: 90 }));
  const commit = placementModule.commitJointPlacement;
  const seen = new Set<string>();
  context.mock.method(placementModule, "commitJointPlacement", (...args: Parameters<typeof commit>) => {
    const answer = args[1].candidate(args[2]).answer;
    assert.equal(evaluateAnswerEligibility(answer).eligible, true);
    seen.add(answer);
    return commit(...args);
  });
  for (const qualityPolicy of [undefined, DEFAULT_JOINT_QUALITY_POLICY]) {
    const config = { policies, qualityPolicy, targetThematicEntries: 2, maxNodes: 1000, deadlineMs: 3000, seed: 1 };
    const original = runJointCrosswordSearch11({ ...config, candidates: records });
    const contaminated = runJointCrosswordSearch11({ ...config, candidates: [
      ...prohibited.map(answer => ({ answer, thematic: true, source: "model" as const, score: 100 })),
      ...records,
      ...prohibited.map(answer => ({ answer: answer.toLowerCase(), thematic: false, source: "filler" as const, score: 100 })),
    ] });
    assert.equal(original.termination, "node-limit");
    assert.equal(contaminated.termination, original.termination);
    assert.deepEqual(contaminated.metrics, original.metrics);
    assert.deepEqual(contaminated.bestState, original.bestState);
    assert.equal(contaminated.indexSize, records.length);
    assert.ok(contaminated.metrics.closureBranches > 0 && contaminated.metrics.backtracks > 0);
    assert.ok(contaminated.metrics.generalPlacementsBeforeTarget > 0);
  }
  assert.ok(seen.has("BAR"));
});
