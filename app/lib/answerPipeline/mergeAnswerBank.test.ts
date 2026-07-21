import assert from "node:assert/strict";
import test from "node:test";

import {
  applyValidatedAnswersToCleanBank,
  buildPrePoolAnswerBankState,
  buildThematicKeepSet,
  mergeExpandedAnswers,
} from "./index";

function expandFixture(answers: string[], maxLen: number) {
  const out: string[] = [];
  for (const answer of answers) {
    if (answer === "LAGONORTE" && maxLen >= 5) out.push("LAGO", "NORTE");
    if (answer === "RIOSUR" && maxLen >= 3) out.push("RIO", "SUR");
  }
  return Array.from(new Set(out));
}

test("mergeExpandedAnswers handles empty target and preserves expansion order", () => {
  const target: string[] = [];

  mergeExpandedAnswers({
    target,
    source: ["LAGONORTE"],
    size: 11,
    expandAnswers: expandFixture,
  });

  assert.deepEqual(target, ["LAGO", "NORTE"]);
});

test("mergeExpandedAnswers leaves target unchanged when new collection expands empty", () => {
  const target = ["ALPHA"];

  mergeExpandedAnswers({
    target,
    source: [],
    size: 11,
    expandAnswers: expandFixture,
  });

  assert.deepEqual(target, ["ALPHA"]);
});

test("mergeExpandedAnswers deduplicates by exact answer and keeps the first existing value", () => {
  const target = ["LAGO"];

  mergeExpandedAnswers({
    target,
    source: ["LAGONORTE"],
    size: 11,
    expandAnswers: expandFixture,
  });

  assert.deepEqual(target, ["LAGO", "NORTE"]);
});

test("mergeExpandedAnswers uses injected acceptance policy without internal theme logic", () => {
  const target: string[] = [];
  const calls: string[] = [];

  mergeExpandedAnswers({
    target,
    source: ["LAGONORTE"],
    size: 11,
    expandAnswers: expandFixture,
    acceptExpanded: (answer) => {
      calls.push(answer);
      return answer !== "LAGO";
    },
  });

  assert.deepEqual(calls, ["LAGO", "NORTE"]);
  assert.deepEqual(target, ["NORTE"]);
});

test("mergeExpandedAnswers passes the source reference to the injected expander", () => {
  const target: string[] = [];
  const source = ["LAGONORTE"];
  let received: string[] | null = null;

  mergeExpandedAnswers({
    target,
    source,
    size: 11,
    expandAnswers: (answers, maxLen) => {
      received = answers;
      assert.equal(maxLen, 11);
      return [];
    },
  });

  assert.equal(received, source);
});

test("mergeExpandedAnswers can preserve the route's second-pass behavior without acceptance policy", () => {
  const target: string[] = [];

  mergeExpandedAnswers({
    target,
    source: ["RIOSUR"],
    size: 11,
    expandAnswers: () => ["RIO", "SUR"],
    acceptExpanded: undefined,
  });

  assert.deepEqual(target, ["RIO", "SUR"]);
});

test("buildThematicKeepSet normalizes validated answers and preserves set insertion order", () => {
  const cleanAnswers = ["ALPHA"];
  const thematicKeepSet = buildThematicKeepSet({
    validated: [" beta ", "ALPHA", "BETA"],
    contextAnswers: [],
    structuredTrustedSet: new Set(),
    notesByAnswer: new Map(),
    language: "en",
    size: 11,
    cleanAnswers,
    expandAnswers: expandFixture,
    policies: { noteLooksWeakThematicContext: () => false },
  });

  assert.deepEqual(Array.from(thematicKeepSet), ["BETA", "ALPHA"]);
  assert.deepEqual(cleanAnswers, ["ALPHA"]);
});

test("buildThematicKeepSet admits trusted noted context answers for 11x11", () => {
  const thematicKeepSet = buildThematicKeepSet({
    validated: ["ALPHA"],
    contextAnswers: ["CONTEXT", "UNTRUSTED", "WEAKNOTE", "SHORTNOTE"],
    structuredTrustedSet: new Set(["CONTEXT", "WEAKNOTE", "SHORTNOTE"]),
    notesByAnswer: new Map([
      ["CONTEXT", "useful note"],
      ["UNTRUSTED", "useful note"],
      ["WEAKNOTE", "weak note"],
      ["SHORTNOTE", "short"],
    ]),
    language: "en",
    size: 11,
    cleanAnswers: [],
    expandAnswers: expandFixture,
    policies: { noteLooksWeakThematicContext: (note) => note === "weak note" },
  });

  assert.deepEqual(Array.from(thematicKeepSet), ["ALPHA", "CONTEXT"]);
});

test("buildThematicKeepSet does not admit trusted context answers for non-11 grids", () => {
  const thematicKeepSet = buildThematicKeepSet({
    validated: ["ALPHA"],
    contextAnswers: ["CONTEXT"],
    structuredTrustedSet: new Set(["CONTEXT"]),
    notesByAnswer: new Map([["CONTEXT", "useful note"]]),
    language: "en",
    size: 9,
    cleanAnswers: [],
    expandAnswers: expandFixture,
    policies: { noteLooksWeakThematicContext: () => false },
  });

  assert.deepEqual(Array.from(thematicKeepSet), ["ALPHA"]);
});

test("buildThematicKeepSet expands thematic answers and appends missing clean answers", () => {
  const cleanAnswers = ["LAGONORTE"];
  const thematicKeepSet = buildThematicKeepSet({
    validated: ["LAGONORTE"],
    contextAnswers: [],
    structuredTrustedSet: new Set(),
    notesByAnswer: new Map(),
    language: "en",
    size: 11,
    cleanAnswers,
    expandAnswers: expandFixture,
    policies: { noteLooksWeakThematicContext: () => false },
  });

  assert.deepEqual(Array.from(thematicKeepSet), ["LAGONORTE", "LAGO", "NORTE"]);
  assert.deepEqual(cleanAnswers, ["LAGONORTE", "LAGO", "NORTE"]);
});

test("buildThematicKeepSet keeps unknown notes out of trusted context answers", () => {
  const thematicKeepSet = buildThematicKeepSet({
    validated: ["ALPHA"],
    contextAnswers: ["CONTEXT"],
    structuredTrustedSet: new Set(["CONTEXT"]),
    notesByAnswer: new Map(),
    language: "en",
    size: 11,
    cleanAnswers: [],
    expandAnswers: expandFixture,
    policies: { noteLooksWeakThematicContext: () => false },
  });

  assert.deepEqual(Array.from(thematicKeepSet), ["ALPHA"]);
});

test("buildThematicKeepSet preserves the first normalized validated value when duplicates collide", () => {
  const thematicKeepSet = buildThematicKeepSet({
    validated: ["al-pha", "ALPHA"],
    contextAnswers: [],
    structuredTrustedSet: new Set(),
    notesByAnswer: new Map(),
    language: "en",
    size: 11,
    cleanAnswers: [],
    expandAnswers: expandFixture,
    policies: { noteLooksWeakThematicContext: () => false },
  });

  assert.deepEqual(Array.from(thematicKeepSet), ["ALPHA"]);
});

test("buildThematicKeepSet keeps distinct normalized answers separate", () => {
  const thematicKeepSet = buildThematicKeepSet({
    validated: ["ALPHA", "ALPHAS"],
    contextAnswers: [],
    structuredTrustedSet: new Set(),
    notesByAnswer: new Map(),
    language: "en",
    size: 11,
    cleanAnswers: [],
    expandAnswers: expandFixture,
    policies: { noteLooksWeakThematicContext: () => false },
  });

  assert.deepEqual(Array.from(thematicKeepSet), ["ALPHA", "ALPHAS"]);
});

test("applyValidatedAnswersToCleanBank skips prune when keep count is too small", () => {
  const cleanAnswers = ["A1", "A2", "A3"];
  const result = applyValidatedAnswersToCleanBank({
    cleanAnswers,
    validated: ["A1"],
    size: 11,
    minClean: 26,
    targetAnswers: 60,
  });

  assert.deepEqual(result, {
    applied: false,
    minKeepToApply: 13,
    finalCount: 3,
    cleanBefore: 3,
  });
  assert.deepEqual(cleanAnswers, ["A1", "A2", "A3"]);
});

test("applyValidatedAnswersToCleanBank applies unique validated answers for 11x11 only", () => {
  const cleanAnswers = ["V1", "V2", "RAW"];
  const validated = Array.from({ length: 12 }, (_, index) => `V${index + 1}`);
  const result = applyValidatedAnswersToCleanBank({
    cleanAnswers,
    validated: [...validated, "V1"],
    size: 11,
    minClean: 24,
    targetAnswers: 90,
  });

  assert.equal(result.applied, true);
  assert.equal(result.minKeepToApply, 12);
  assert.deepEqual(cleanAnswers, validated);
});

test("applyValidatedAnswersToCleanBank re-adds clean answers for non-11 grids up to target", () => {
  const cleanAnswers = ["V1", "RAW1", "RAW2", "RAW3"];
  const validated = Array.from({ length: 12 }, (_, index) => `V${index + 1}`);

  applyValidatedAnswersToCleanBank({
    cleanAnswers,
    validated,
    size: 9,
    minClean: 14,
    targetAnswers: 15,
  });

  assert.deepEqual(cleanAnswers, [...validated, "RAW1", "RAW2", "RAW3"]);
});

test("applyValidatedAnswersToCleanBank preserves validated order when duplicates have different positions", () => {
  const cleanAnswers = ["RAW"];
  const validated = ["A", "B", "A", "C", "B", "D", "E", "F", "G", "H", "I", "J"];

  applyValidatedAnswersToCleanBank({
    cleanAnswers,
    validated,
    size: 11,
    minClean: 24,
    targetAnswers: 90,
  });

  assert.deepEqual(cleanAnswers, ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
});

test("applyValidatedAnswersToCleanBank mutates the original cleanAnswers array instead of replacing it", () => {
  const cleanAnswers = Array.from({ length: 12 }, (_, index) => `V${index}`);
  const originalReference = cleanAnswers;

  applyValidatedAnswersToCleanBank({
    cleanAnswers,
    validated: cleanAnswers,
    size: 11,
    minClean: 24,
    targetAnswers: 90,
  });

  assert.equal(cleanAnswers, originalReference);
});

test("buildPrePoolAnswerBankState constructs normalized bank, stats, and sets", () => {
  const thematicKeepSet = new Set(["ALPHA", "BETA"]);
  const state = buildPrePoolAnswerBankState({
    cleanAnswers: ["ALPHA", "BETA", "FILL", "GENERIC", "SUPPORT"],
    validated: ["ALPHA", "BETA"],
    thematicKeepSet,
    theme: "neutral theme",
    language: "en",
    size: 11,
    fillerWords: ["FILL"],
    policies: { isExcludedFromBroadThematicSet: (_theme, answer) => answer === "GENERIC" },
  });

  assert.deepEqual(state.normalizedAnswerBank.answers, ["ALPHA", "BETA", "FILL", "GENERIC", "SUPPORT"]);
  assert.deepEqual(Array.from(state.thematicSets.broadModelThematicSet), ["ALPHA", "BETA", "SUPPORT"]);
  assert.deepEqual(Array.from(state.thematicSets.themeSetForAttempt), ["ALPHA", "BETA"]);
  assert.equal(state.thematicSets.publishThemeSet, state.thematicSets.themeSetForAttempt);
  assert.equal(state.thematicSets.placementThemeSet, state.thematicSets.themeSetForAttempt);
  assert.deepEqual(state.stats.cleanSample, ["ALPHA", "BETA", "FILL", "GENERIC", "SUPPORT"]);
});

test("buildPrePoolAnswerBankState keeps normalizedAnswerBank aliased to cleanAnswers", () => {
  const cleanAnswers = ["ALPHA"];
  const state = buildPrePoolAnswerBankState({
    cleanAnswers,
    validated: ["ALPHA"],
    thematicKeepSet: new Set(["ALPHA"]),
    theme: "neutral theme",
    language: "en",
    size: 11,
    fillerWords: [],
    policies: { isExcludedFromBroadThematicSet: () => false },
  });

  assert.equal(state.normalizedAnswerBank.answers, cleanAnswers);
});

test("buildPrePoolAnswerBankState includes filler answers only when thematic", () => {
  const state = buildPrePoolAnswerBankState({
    cleanAnswers: ["THEME", "FILL"],
    validated: ["THEME"],
    thematicKeepSet: new Set(["THEME", "FILL"]),
    theme: "neutral theme",
    language: "en",
    size: 11,
    fillerWords: ["FILL"],
    policies: { isExcludedFromBroadThematicSet: () => false },
  });

  assert.deepEqual(Array.from(state.thematicSets.broadModelThematicSet), ["THEME", "FILL"]);
});

test("buildPrePoolAnswerBankState expands non-11 theme set with broad model answers", () => {
  const state = buildPrePoolAnswerBankState({
    cleanAnswers: ["THEME", "MODEL"],
    validated: ["THEME"],
    thematicKeepSet: new Set(["THEME"]),
    theme: "neutral theme",
    language: "en",
    size: 9,
    fillerWords: [],
    policies: { isExcludedFromBroadThematicSet: () => false },
  });

  assert.deepEqual(Array.from(state.thematicSets.themeSetForAttempt), ["THEME", "MODEL"]);
});

test("buildPrePoolAnswerBankState keeps 11x11 theme set restricted to thematicKeepSet", () => {
  const state = buildPrePoolAnswerBankState({
    cleanAnswers: ["THEME", "MODEL"],
    validated: ["THEME"],
    thematicKeepSet: new Set(["THEME"]),
    theme: "neutral theme",
    language: "en",
    size: 11,
    fillerWords: [],
    policies: { isExcludedFromBroadThematicSet: () => false },
  });

  assert.deepEqual(Array.from(state.thematicSets.themeSetForAttempt), ["THEME"]);
});

test("buildPrePoolAnswerBankState samples are capped at 30 items", () => {
  const cleanAnswers = Array.from({ length: 40 }, (_, index) => `C${index}`);
  const validated = Array.from({ length: 35 }, (_, index) => `V${index}`);
  const thematicKeepSet = new Set(Array.from({ length: 34 }, (_, index) => `T${index}`));
  const state = buildPrePoolAnswerBankState({
    cleanAnswers,
    validated,
    thematicKeepSet,
    theme: "neutral theme",
    language: "en",
    size: 11,
    fillerWords: [],
    policies: { isExcludedFromBroadThematicSet: () => false },
  });

  assert.equal(state.stats.cleanSample.length, 30);
  assert.equal(state.stats.validatedSample.length, 30);
  assert.equal(state.stats.thematicKeepSample.length, 30);
});

test("buildPrePoolAnswerBankState preserves publishThemeSet alias to thematicKeepSet when large enough", () => {
  const thematicKeepSet = new Set(Array.from({ length: 10 }, (_, index) => `T${index}`));
  const state = buildPrePoolAnswerBankState({
    cleanAnswers: Array.from(thematicKeepSet),
    validated: Array.from(thematicKeepSet),
    thematicKeepSet,
    theme: "neutral theme",
    language: "en",
    size: 11,
    fillerWords: [],
    policies: { isExcludedFromBroadThematicSet: () => false },
  });

  assert.equal(state.thematicSets.publishThemeSet, thematicKeepSet);
});
