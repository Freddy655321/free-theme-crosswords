import assert from "node:assert/strict";
import test from "node:test";

import {
  createCspBankAuditReport,
  cspBankAuditAddRejected,
  cspBankAuditAnalyzeSanitize,
  cspBankAuditCandidateDistribution,
  cspBankAuditDistribution,
  cspBankAuditMergeCounts,
  cspBankAuditRejectedBySet,
  cspBankAuditSample,
  cspBankAuditSetDistribution,
  parseUsableAnswerBankText,
  salvageAnswerStringsFromJson,
  type SanitizeAuditPolicies,
} from "./index";

const defaultPolicies: SanitizeAuditPolicies = {
  asciiAnswerPattern: /^[A-Z0-9]+$/,
  bannedAnswers: new Set(["BAN"]),
  alwaysAllowAnswers: new Set(["ALLOWBAD"]),
  answerLanguageLooksValidForPuzzle: () => true,
  isLikelyBadAnswer: (answer) => answer === "RISK",
};

test("parseUsableAnswerBankText parses valid answer bank JSON and preserves notes", () => {
  const parsed = parseUsableAnswerBankText(
    '{"answers":["ALPHA","BETA"],"notes":[{"answer":"ALPHA","note":"first note"}]}'
  );

  assert.deepEqual(parsed.salvagedAnswers, []);
  assert.deepEqual(parsed.usableParsedAnswers?.answers, ["ALPHA", "BETA"]);
  assert.deepEqual(parsed.usableParsedAnswers?.notes, [{ answer: "ALPHA", note: "first note" }]);
});

test("parseUsableAnswerBankText preserves safeJson behavior for fenced or surrounded JSON", () => {
  const fenced = parseUsableAnswerBankText('```json\n{"answers":["FENCE"]}\n```');
  const surrounded = parseUsableAnswerBankText('prefix {"answers":["WRAPPED"]} suffix');

  assert.deepEqual(fenced.usableParsedAnswers?.answers, ["FENCE"]);
  assert.deepEqual(surrounded.usableParsedAnswers?.answers, ["WRAPPED"]);
});

test("parseUsableAnswerBankText returns null for invalid JSON without recoverable answers", () => {
  const parsed = parseUsableAnswerBankText("{not json");

  assert.equal(parsed.parsedAnswers, null);
  assert.deepEqual(parsed.salvagedAnswers, []);
  assert.equal(parsed.usableParsedAnswers, null);
});

test("salvageAnswerStringsFromJson recovers strings from partial answers arrays in order", () => {
  const salvaged = salvageAnswerStringsFromJson('{"answers":["ONE","TWO","THREE"');

  assert.deepEqual(salvaged, ["ONE", "TWO", "THREE"]);
  assert.deepEqual(parseUsableAnswerBankText('{"answers":["ONE","TWO"').usableParsedAnswers?.answers, ["ONE", "TWO"]);
});

test("answer bank audit report starts empty and records distributions and samples", () => {
  const report = createCspBankAuditReport("theme", "en", 11);
  const logs: Array<{ label: string; payload: Record<string, unknown> }> = [];

  assert.deepEqual(report.distributions, {});
  assert.deepEqual(report.rejectedByStage, {});

  cspBankAuditSetDistribution(report, "stage", [" ab ", "CD-E", "canción", "AB"], (label, payload) => {
    logs.push({ label, payload });
  });

  assert.deepEqual(report.distributions.stage, { "2": 2, "3": 1, "7": 1 });
  assert.deepEqual(report.samplesByStage.stage, ["AB", "CDE", "CANCION"]);
  assert.equal(logs[0]?.label, "stage");
  assert.deepEqual(logs[0]?.payload.byLength, report.distributions.stage);
});

test("candidate distribution counts answers by normalized length without using source", () => {
  const candidates: Array<{ answer: string; source?: string }> = [
    { answer: "TREE", source: "model" },
    { answer: "LA-KE", source: "support" },
    { answer: "R1" },
  ];
  const distribution = cspBankAuditCandidateDistribution(candidates);

  assert.deepEqual(distribution, { "2": 1, "4": 2 });
});

test("rejection reasons keep count and sample order with a 20 item cap", () => {
  const report = createCspBankAuditReport("theme", "es", 11);

  for (let i = 0; i < 22; i++) {
    cspBankAuditAddRejected(report, "sanitize", "empty", `A${i}`);
  }

  assert.deepEqual(report.rejectedByStage.sanitize, { empty: 22 });
  assert.equal(report.rejectedSamplesByStage.sanitize.length, 20);
  assert.deepEqual(report.rejectedSamplesByStage.sanitize[0], { answer: "A0", reason: "empty" });
  assert.deepEqual(report.rejectedSamplesByStage.sanitize[19], { answer: "A19", reason: "empty" });
});

test("merge counts and rejected-by-set preserve existing audit behavior", () => {
  const report = createCspBankAuditReport("theme", "en", 11);
  const counts = { "4": 1 };

  cspBankAuditMergeCounts(counts, { 4: 2, 5: 3 });
  cspBankAuditRejectedBySet(report, "validate", ["ALPHA", "BETA", "ALPHA"], ["BETA"], "failed");

  assert.deepEqual(counts, { "4": 3, "5": 3 });
  assert.deepEqual(report.rejectedByStage.validate, { failed: 2 });
  assert.deepEqual(report.rejectedSamplesByStage.validate, [
    { answer: "ALPHA", reason: "failed" },
    { answer: "ALPHA", reason: "failed" },
  ]);
});

test("cspBankAuditAnalyzeSanitize reports current sanitize rejection reasons through injected policies", () => {
  const report = createCspBankAuditReport("theme", "en", 5);

  cspBankAuditAnalyzeSanitize(
    ["", "A_B", "AB", "VERYLONGWORD", "BAN", "LANG", "RISK", "ALPHA", "ALPHA", "THEME", "PREF"],
    ["ALPHA"],
    {
      theme: "theme",
      maxLen: 11,
      language: "en",
      report,
      policies: {
        ...defaultPolicies,
        answerLanguageLooksValidForPuzzle: (answer) => answer !== "LANG",
      },
    }
  );

  assert.deepEqual(report.rejectedByStage.sanitize, {
    empty: 1,
    "invalid-characters": 1,
    "too-short": 1,
    "too-long": 1,
    "banned-answer": 1,
    "likely-bad-answer": 2,
    "duplicate-after-normalization": 1,
    "prefix-of-longer-answer": 2,
  });
  assert.deepEqual(report.rejectedByStage["post-sanitize-theme-filter"], { "exact-theme": 1 });
});

test("cspBankAuditAnalyzeSanitize invokes policies in the same short-circuit order", () => {
  const report = createCspBankAuditReport("theme", "en", 11);
  const calls: string[] = [];

  cspBankAuditAnalyzeSanitize(["BADLANG", "BADLIKELY", "ALLOWBAD"], ["ALLOWBAD"], {
    theme: "theme",
    maxLen: 11,
    language: "en",
    report,
    policies: {
      asciiAnswerPattern: /^[A-Z0-9]+$/,
      bannedAnswers: new Set(),
      alwaysAllowAnswers: new Set(["ALLOWBAD"]),
      answerLanguageLooksValidForPuzzle: (answer) => {
        calls.push(`language:${answer}`);
        return answer !== "BADLANG";
      },
      isLikelyBadAnswer: (answer) => {
        calls.push(`likely:${answer}`);
        return answer === "BADLIKELY" || answer === "ALLOWBAD";
      },
    },
  });

  assert.deepEqual(calls, [
    "language:BADLANG",
    "language:BADLIKELY",
    "likely:BADLIKELY",
    "language:ALLOWBAD",
    "likely:ALLOWBAD",
  ]);
  assert.deepEqual(report.rejectedByStage.sanitize, { "likely-bad-answer": 2 });
});

test("audit helpers do not mutate sanitized inputs or perform additional sanitization", () => {
  const report = createCspBankAuditReport("theme", "en", 11);
  const sanitized = ["A_B"];
  const before = sanitized.slice();

  cspBankAuditAnalyzeSanitize(["A_B"], sanitized, {
    theme: "theme",
    maxLen: 11,
    language: "en",
    report,
    policies: defaultPolicies,
  });

  assert.deepEqual(sanitized, before);
  assert.deepEqual(cspBankAuditDistribution(sanitized), { "3": 1 });
  assert.deepEqual(cspBankAuditSample(["ONE", "ONE", "TWO"]), ["ONE", "TWO"]);
}
);
