import assert from "node:assert/strict";
import test from "node:test";
import {
  createCspBankAuditReport,
  parseUsableAnswerBankText,
  sanitizeAnswerListWithPolicies,
  sanitizeInitialAnswerBank,
  type AnswerSanitizationPolicies,
  type CspBankAuditReport,
} from "./index";

function makePolicies(overrides: Partial<AnswerSanitizationPolicies> = {}): AnswerSanitizationPolicies {
  return {
    asciiAnswerPattern: /^[A-Z0-9]+$/,
    bannedAnswers: new Set<string>(),
    alwaysAllowAnswers: new Set<string>(),
    answerLanguageLooksValidForPuzzle: () => true,
    isLikelyBadAnswer: () => false,
    noteLooksWeakThematicContext: () => false,
    minEntryLenForSize: () => 3,
    ...overrides,
  };
}

function sanitizeInitial(input: {
  answers: unknown[];
  notes?: unknown;
  theme?: string;
  policies?: Partial<AnswerSanitizationPolicies>;
  report?: CspBankAuditReport;
}) {
  const report = input.report ?? createCspBankAuditReport(input.theme ?? "garden tools", "en", 11);
  const distributions: Array<{ stage: string; values: string[] }> = [];
  const result = sanitizeInitialAnswerBank({
    parsedBank: { answers: input.answers as string[], notes: input.notes as never },
    theme: input.theme ?? "garden tools",
    language: "en",
    size: 11,
    report,
    policies: makePolicies(input.policies),
    recordDistribution: (auditReport, stage, values) => {
      const sample = Array.from(values);
      distributions.push({ stage, values: sample });
      auditReport.distributions[stage] = sample.reduce<Record<string, number>>((counts, answer) => {
        counts[String(answer.length)] = (counts[String(answer.length)] ?? 0) + 1;
        return counts;
      }, {});
    },
  });
  return { result, report, distributions };
}

test("sanitizeAnswerListWithPolicies normalizes answers and preserves accepted order", () => {
  const out = sanitizeAnswerListWithPolicies([" beta ", "AL-PHA", "42"], 11, "en", makePolicies());

  assert.deepEqual(out, ["BETA", "ALPHA"]);
});

test("sanitizeAnswerListWithPolicies deduplicates by normalized key and keeps the first duplicate", () => {
  const out = sanitizeAnswerListWithPolicies(["Gamma", "GAM-MA", "Beta"], 11, "en", makePolicies());

  assert.deepEqual(out, ["GAMMA", "BETA"]);
});

test("sanitizeInitialAnswerBank preserves notes and lets the last valid duplicate note win", () => {
  const { result } = sanitizeInitial({
    answers: ["ALPHA"],
    notes: [
      { answer: "alpha", note: "first useful note" },
      { answer: "AL-PHA", note: "second useful note" },
    ],
  });

  assert.equal(result.notesByAnswer.get("ALPHA"), "second useful note");
});

test("sanitizeInitialAnswerBank propagates notes for geographic compound prefixes", () => {
  const { result } = sanitizeInitial({
    answers: ["LagoNorte"],
    notes: [{ answer: "LagoNorte", note: "specific compound note" }],
  });

  assert.equal(result.notesByAnswer.get("LAGONORTE"), "specific compound note");
  assert.equal(result.notesByAnswer.get("LAGO"), "specific compound note");
  assert.equal(result.notesByAnswer.get("NORTE"), "specific compound note");
});

test("sanitizeInitialAnswerBank excludes only the exact normalized theme answer", () => {
  const { result, report } = sanitizeInitial({
    theme: "ocean",
    answers: ["Ocean", "Ocean Lab"],
    notes: [
      { answer: "Ocean", note: "theme note" },
      { answer: "Ocean Lab", note: "partial but distinct note" },
    ],
  });

  assert.deepEqual(result.cleanAnswers, ["OCEANLAB"]);
  assert.equal(result.normalizedThemeAnswer, "OCEAN");
  assert.equal(result.notesByAnswer.has("OCEAN"), false);
  assert.equal(result.notesByAnswer.has("OCEANLAB"), true);
  assert.equal(report.rejectedByStage["post-sanitize-theme-filter"]?.["exact-theme"], 1);
});

test("sanitizeAnswerListWithPolicies rejects invalid characters, invalid lengths, banned, language, and bad answers", () => {
  const out = sanitizeAnswerListWithPolicies(
    ["OKAY", "A!", "NO", "TOOLONGANSWER", "BANNED", "LANG", "BAD"],
    11,
    "en",
    makePolicies({
      bannedAnswers: new Set(["BANNED"]),
      answerLanguageLooksValidForPuzzle: (answer) => answer !== "LANG",
      isLikelyBadAnswer: (answer) => answer === "BAD",
    })
  );

  assert.deepEqual(out, ["OKAY"]);
});

test("sanitizeAnswerListWithPolicies honors always-allow after bad-answer policy", () => {
  const out = sanitizeAnswerListWithPolicies(
    ["BAD", "BANNED"],
    11,
    "en",
    makePolicies({
      bannedAnswers: new Set(["BANNED"]),
      alwaysAllowAnswers: new Set(["BAD"]),
      isLikelyBadAnswer: (answer) => answer === "BAD",
    })
  );

  assert.deepEqual(out, ["BAD"]);
});

test("sanitizeInitialAnswerBank filters weak thematic notes", () => {
  const { result } = sanitizeInitial({
    answers: ["ALPHA", "BETA"],
    notes: [
      { answer: "ALPHA", note: "weak" },
      { answer: "BETA", note: "useful" },
    ],
    policies: {
      noteLooksWeakThematicContext: (note) => note === "weak",
    },
  });

  assert.equal(result.notesByAnswer.has("ALPHA"), false);
  assert.equal(result.notesByAnswer.get("BETA"), "useful");
});

test("sanitizeAnswerListWithPolicies invokes policies in the current order", () => {
  const calls: string[] = [];
  sanitizeAnswerListWithPolicies(
    ["BANNED", "LANG", "BAD", "GOOD"],
    11,
    "en",
    makePolicies({
      bannedAnswers: new Set(["BANNED"]),
      answerLanguageLooksValidForPuzzle: (answer) => {
        calls.push(`language:${answer}`);
        return answer !== "LANG";
      },
      isLikelyBadAnswer: (answer) => {
        calls.push(`bad:${answer}`);
        return answer === "BAD";
      },
    })
  );

  assert.deepEqual(calls, ["language:LANG", "language:BAD", "bad:BAD", "language:GOOD", "bad:GOOD"]);
});

test("sanitizeInitialAnswerBank records rejection reasons, sample cap, counters, and distributions", () => {
  const report = createCspBankAuditReport("theme", "en", 11);
  const answers = ["", "NO", "A_A", "TOOLONGANSWER", "BANNED", ...Array.from({ length: 25 }, (_, index) => `BAD${index}`)];
  const { result } = sanitizeInitial({
    answers,
    report,
    policies: {
      bannedAnswers: new Set(["BANNED"]),
      isLikelyBadAnswer: (answer) => answer.startsWith("BAD"),
    },
  });

  assert.deepEqual(result.cleanAnswers, []);
  assert.equal(report.initialSanitizedCount, 0);
  assert.equal(report.rejectedByStage.sanitize.empty, 1);
  assert.equal(report.rejectedByStage.sanitize["too-short"], 1);
  assert.equal(report.rejectedByStage.sanitize["invalid-characters"], 1);
  assert.equal(report.rejectedByStage.sanitize["too-long"], 1);
  assert.equal(report.rejectedByStage.sanitize["banned-answer"], 1);
  assert.equal(report.rejectedByStage.sanitize["likely-bad-answer"], 25);
  assert.equal(report.rejectedSamplesByStage.sanitize.length, 20);
  assert.deepEqual(report.distributions["after-sanitizeAnswerList"], {});
});

test("sanitizeAnswerListWithPolicies removes exact prefixes of longer answers", () => {
  const out = sanitizeAnswerListWithPolicies(["MAL", "MALIBU", "BETA"], 11, "en", makePolicies());

  assert.deepEqual(out, ["MALIBU", "BETA"]);
});

test("sanitizeInitialAnswerBank does not mutate input arrays", () => {
  const answers = ["Alpha", "Beta"];
  const notes = [{ answer: "Alpha", note: "useful note" }];
  sanitizeInitial({ answers, notes });

  assert.deepEqual(answers, ["Alpha", "Beta"]);
  assert.deepEqual(notes, [{ answer: "Alpha", note: "useful note" }]);
});

test("sanitizeInitialAnswerBank returns empty results for empty inputs", () => {
  const { result } = sanitizeInitial({ answers: [] });

  assert.deepEqual(result.cleanAnswers, []);
  assert.deepEqual(result.rawNormalizedAnswers, []);
  assert.equal(result.notesByAnswer.size, 0);
});

test("sanitizeAnswerListWithPolicies uses injected policies without internal topic rules", () => {
  const out = sanitizeAnswerListWithPolicies(
    ["TOPICONE", "TOPICTWO", "REGIONX", "ARTISTY"],
    11,
    "en",
    makePolicies()
  );

  assert.deepEqual(out, ["TOPICONE", "TOPICTWO", "REGIONX", "ARTISTY"]);
});

test("sanitizeInitialAnswerBank accepts parseUsableAnswerBankText output", () => {
  const parsed = parseUsableAnswerBankText(
    JSON.stringify({
      answers: ["Alpha", "Beta"],
      notes: [{ answer: "Alpha", note: "useful note" }],
    })
  );
  assert.ok(parsed.usableParsedAnswers);

  const result = sanitizeInitialAnswerBank({
    parsedBank: parsed.usableParsedAnswers,
    theme: "garden tools",
    language: "en",
    size: 11,
    report: createCspBankAuditReport("garden tools", "en", 11),
    policies: makePolicies(),
    recordDistribution: () => undefined,
  });

  assert.deepEqual(result.cleanAnswers, ["ALPHA", "BETA"]);
  assert.equal(result.notesByAnswer.get("ALPHA"), "useful note");
});

test("sanitizeAnswerListWithPolicies preserves policy exceptions", () => {
  assert.throws(
    () =>
      sanitizeAnswerListWithPolicies(
        ["ALPHA"],
        11,
        "en",
        makePolicies({
          answerLanguageLooksValidForPuzzle: () => {
            throw new Error("policy failed");
          },
        })
      ),
    /policy failed/
  );
});

test("sanitizeInitialAnswerBank does not manipulate source or classification fields", () => {
  const raw = ["Model"];
  const { result } = sanitizeInitial({
    answers: raw,
    notes: [{ answer: "Model", note: "keeps unrelated metadata out of this stage", source: "model", thematic: true }],
  });

  assert.deepEqual(result.cleanAnswers, ["MODEL"]);
  assert.equal(result.notesByAnswer.get("MODEL"), "keeps unrelated metadata out of this stage");
});
