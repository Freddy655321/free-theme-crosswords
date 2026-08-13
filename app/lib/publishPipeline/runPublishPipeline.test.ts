import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCluesAndOverridesWithPolicies,
  blockForbiddenAnswerRuns,
  clueLanguageLooksValid,
  clueMentionsAnswer,
  createRequestModelCluesService,
  deriveEntriesFromGrid,
  isPlaceholderClue,
  pruneForbiddenPublishAnswersIfPossible,
  pruneMaskedDuplicateAnswers,
  publishQualityIssueWithPolicies,
  repairPublishCluesWithPolicies,
  requestModelCluesWithPolicies,
  runPublishPipeline,
  sanitizeModelClueText,
  type ClueGenerationClient,
} from "./index";
import type { Entry } from "@/app/lib/crosswordTypes";

const okPolicies = {
  isBadClue: (clue: string) => clue.length < 3,
  clueMentionsAnswer: (clue: string, answer: string) =>
    answer.length > 3 && clue.toLowerCase().includes(answer.toLowerCase()),
  clueMakesUnstableTemporalClaim: () => false,
  clueMislabelsPartialPersonAnswer: () => false,
  clueMislabelsKnownPartialTitle: () => false,
  clueLooksOffTheme: () => false,
  warnClueRetryFailed: () => undefined,
};

function fakeClient(content: string): ClueGenerationClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    chat: {
      completions: {
        async create(args) {
          calls.push(args);
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

test("deriveEntriesFromGrid derives across/down entries with stable numbering and coordinates", () => {
  const grid = [
    ["C", "A", "T", "#", "#"],
    ["A", "#", "O", "#", "#"],
    ["R", "#", "O", "#", "#"],
    ["#", "#", "L", "A", "B"],
    ["#", "#", "#", "#", "#"],
  ];

  assert.deepEqual(deriveEntriesFromGrid(grid, 3), [
    { number: 1, row: 0, col: 0, direction: "across", answer: "CAT" },
    { number: 2, row: 3, col: 2, direction: "across", answer: "LAB" },
    { number: 3, row: 0, col: 0, direction: "down", answer: "CAR" },
    { number: 4, row: 0, col: 2, direction: "down", answer: "TOOL" },
  ]);
});

test("requestModelCluesWithPolicies preserves payload and parses valid clues", async () => {
  const client = fakeClient(JSON.stringify({ clues: [{ answer: "OCEAN", clue: "Theme-safe clue" }] }));
  const clues = await requestModelCluesWithPolicies({
    client,
    theme: "ocean science",
    language: "en",
    items: [{ answer: "OCEAN", thematic: true, hint: "hint" }],
    cluebankPrompt: "THEME: ${theme}\nLANGUAGE: ${languageLabel}\nITEMS:\n${itemsJson}",
    answerbankSearchModel: "search-model",
    clueModel: "clue-model",
    policies: okPolicies,
  });

  assert.equal(clues.get("OCEAN"), "Theme-safe clue");
  assert.equal(client.calls.length, 1);
  assert.deepEqual((client.calls[0] as { model: string; temperature: number; max_tokens: number }).model, "search-model");
  assert.equal((client.calls[0] as { temperature: number }).temperature, 0);
  assert.equal((client.calls[0] as { max_tokens: number }).max_tokens, 1600);
});

test("createRequestModelCluesService binds prompt, models, policies, and preserves call count", async () => {
  const client = fakeClient(JSON.stringify({ clues: [{ answer: "OCEAN", clue: "Theme-safe clue" }] }));
  const requestModelClues = createRequestModelCluesService({
    answerbankSearchModel: "search-model",
    clueModel: "clue-model",
    policies: okPolicies,
  });

  const clues = await requestModelClues({
    client,
    theme: "ocean science",
    language: "en",
    items: [{ answer: "OCEAN", thematic: true }],
  });

  assert.equal(clues.get("OCEAN"), "Theme-safe clue");
  assert.equal(client.calls.length, 1);
  const call = client.calls[0] as {
    model: string;
    temperature: number;
    max_tokens: number;
    response_format: { type: string };
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(call.model, "search-model");
  assert.equal(call.temperature, 0);
  assert.equal(call.max_tokens, 1600);
  assert.deepEqual(call.response_format, { type: "json_object" });
  assert.equal(call.messages[0].role, "system");
  assert.equal(call.messages[1].role, "user");
  assert.match(call.messages[1].content, /You are a crossword editor\./);
});

test("requestModelCluesWithPolicies retries missing clues and logs retry failures", async () => {
  const warnings: unknown[] = [];
  let call = 0;
  const client: ClueGenerationClient = {
    chat: {
      completions: {
        async create() {
          call++;
          if (call === 1) return { choices: [{ message: { content: JSON.stringify({ clues: [] }) } }] };
          throw new Error("retry failed");
        },
      },
    },
  };

  const clues = await requestModelCluesWithPolicies({
    client,
    theme: "garden tools",
    language: "en",
    items: [{ answer: "SPADE", thematic: true }],
    cluebankPrompt: "THEME: ${theme}\nLANGUAGE: ${languageLabel}\nITEMS:\n${itemsJson}",
    answerbankSearchModel: "search-model",
    clueModel: "clue-model",
    policies: { ...okPolicies, warnClueRetryFailed: (payload) => warnings.push(payload) },
  });

  assert.equal(clues.size, 0);
  assert.equal(call, 2);
  assert.deepEqual(warnings, [{ name: "Error", msg: "retry failed" }]);
});

test("sanitizeModelClueText strips generated context prefix only for matching language", () => {
  assert.equal(sanitizeModelClueText("Theme context for topic: Concrete clue", "en"), "Concrete clue");
  assert.equal(
    sanitizeModelClueText("contexto temÃ¡tico para tema: Pista concreta", "es"),
    "contexto temÃ¡tico para tema: Pista concreta"
  );
});

test("clue hygiene helpers preserve placeholder, mention, and language rules", () => {
  assert.equal(isPlaceholderClue("Themed entry", "en"), true);
  assert.equal(isPlaceholderClue("Word (5 letters)", "en"), true);
  assert.equal(isPlaceholderClue("Entrada tematica", "es"), true);
  assert.equal(isPlaceholderClue("Concrete clue", "en"), false);
  assert.equal(clueMentionsAnswer("A strong OCEAN clue", "OCEAN"), true);
  assert.equal(clueMentionsAnswer("A strong sea clue", "SEA"), false);
  assert.equal(clueLanguageLooksValid("known hiking lake", "es"), false);
  assert.equal(clueLanguageLooksValid("cerro popular", "en"), false);
});

test("applyCluesAndOverridesWithPolicies maps clues and falls back when invalid", () => {
  const derived = [{ number: 1, row: 0, col: 0, direction: "across" as const, answer: "SPADE" }];
  const out = applyCluesAndOverridesWithPolicies(
    "garden tools",
    "en",
    derived,
    new Map([["SPADE", "SPADE literal"]]),
    {
      getThemeClueOverrides: () => ({}),
      specificThematicFallbackClue: () => "Digging tool",
      isBadClue: () => false,
      clueMentionsAnswer: (clue, answer) => clue.toLowerCase().includes(answer.toLowerCase()),
    }
  );

  assert.deepEqual(out, [{ ...derived[0], clue: "Digging tool" }]);
});

test("repairPublishCluesWithPolicies replaces only bad publish clues", () => {
  const entries: Entry[] = [
    { number: 1, row: 0, col: 0, direction: "across", answer: "SPADE", clue: "bad" },
    { number: 2, row: 1, col: 0, direction: "across", answer: "RAKE", clue: "Garden tool" },
  ];
  const repaired = repairPublishCluesWithPolicies(
    entries,
    { theme: "garden tools", language: "en", thematicSet: new Set(["SPADE"]), notesByAnswer: new Map() },
    {
      contextualSupportAnswers: new Set(),
      fallbackClueForPublishRepair: () => "Digging tool",
      isPlaceholderClue: () => false,
      isBadClue: (clue) => clue === "bad",
      clueLooksTooGenericForThematic: () => false,
      clueLooksWeakGeneratedFallback: () => false,
      clueMakesUnstableTemporalClaim: () => false,
      clueMislabelsPartialPersonAnswer: () => false,
      clueMislabelsKnownPartialTitle: () => false,
      clueLanguageLooksValid: () => true,
      clueLooksOffTheme: () => false,
      clueMentionsAnswer: () => false,
    }
  );

  assert.equal(repaired[0].clue, "Digging tool");
  assert.equal(repaired[1], entries[1]);
});

test("publishQualityIssueWithPolicies preserves publication rejection reasons", () => {
  const entries: Entry[] = [
    { number: 1, row: 0, col: 0, direction: "across", answer: "ITEM", clue: "Useful object" },
  ];
  const policies = {
    answerLanguageLooksValidForPuzzle: () => true,
    isLikelyBadAnswer: () => false,
    alwaysAllowAnswers: new Set<string>(),
    modelFragmentAnswers: new Set<string>(),
    bannedAnswers: new Set<string>(),
    contextualGenericAnswers: new Set<string>(),
    contextualSupportAnswers: new Set<string>(),
    isPlaceholderClue: () => false,
    isBadClue: () => false,
    clueMakesUnstableTemporalClaim: () => false,
    clueMislabelsPartialPersonAnswer: () => false,
    clueMislabelsKnownPartialTitle: () => false,
    clueLooksTooGenericForThematic: () => false,
    clueLanguageLooksValid: () => true,
    clueMentionsAnswer: () => false,
    lowValueContextlessAnswers: new Set<string>(),
    clueLooksWeakGeneratedFallback: () => false,
    minEntriesForSize: () => 15,
  };

  assert.equal(publishQualityIssueWithPolicies(entries, new Set(), "en", 2, "", policies), "too-few-entries");
  assert.equal(
    publishQualityIssueWithPolicies([...entries, { ...entries[0], answer: "ITEMS" }], new Set(), "en", 1, "", policies),
    "duplicate-variant:ITEM/ITEMS"
  );
});

test("publish cleanup prunes duplicates, preserves minimum entries, and blocks forbidden runs", () => {
  const entries: Entry[] = [
    { number: 1, row: 0, col: 0, direction: "across", answer: "ITEM", clue: "Useful object" },
    { number: 2, row: 1, col: 0, direction: "across", answer: "ITEMS", clue: "Useful objects" },
    { number: 3, row: 2, col: 0, direction: "across", answer: "KEEP", clue: "Retain" },
  ];

  assert.deepEqual(pruneMaskedDuplicateAnswers(entries).map((entry) => entry.answer), ["ITEM", "KEEP"]);
  assert.equal(
    pruneForbiddenPublishAnswersIfPossible(entries, 3, {
      isForbiddenPublishAnswer: (answer) => answer === "ITEMS",
    }),
    entries
  );
  assert.deepEqual(
    pruneForbiddenPublishAnswersIfPossible(entries, 2, {
      isForbiddenPublishAnswer: (answer) => answer === "ITEMS",
    }).map((entry) => entry.answer),
    ["ITEM", "KEEP"]
  );

  const grid = [
    ["B", "A", "D"],
    ["#", "#", "#"],
    ["O", "K", "A"],
  ];
  const cleaned = blockForbiddenAnswerRuns(grid, 3, {
    isForbiddenPublishAnswer: (answer) => answer === "BAD",
  });
  assert.deepEqual(cleaned[0], ["#", "#", "#"]);
  assert.notEqual(cleaned, grid);
});

test("runPublishPipeline derives, requests clues, repairs entries, and returns final crossword metadata", async () => {
  const grid = [
    ["S", "P", "A", "D", "E"],
    ["#", "#", "#", "#", "#"],
    ["R", "A", "K", "E", "#"],
    ["#", "#", "#", "#", "#"],
    ["#", "#", "#", "#", "#"],
  ];
  const result = await runPublishPipeline({
    theme: "garden tools",
    language: "en",
    size: 5,
    grid,
    notesByAnswer: new Map(),
    thematicSet: new Set(["SPADE"]),
    source: "unit",
    client: fakeClient(JSON.stringify({ clues: [] })),
    answerbankSearchModel: "search",
    clueModel: "clue",
    minEntryLenForSize: () => 3,
    buildThematicClueRequestHint: () => "hint",
    reinforceThematicClues: () => undefined,
    requestModelClues: async () => new Map([["SPADE", "Digging tool"]]),
    applyCluesAndOverrides: (_theme, _language, derived, clues) =>
      derived.map((entry) => ({ ...entry, clue: clues.get(entry.answer) ?? "Brief definition." })),
    repairPublishClues: (entries) => entries,
  });

  assert.equal(result.crossword.meta.source, "unit");
  assert.deepEqual(result.crossword.entries.map((entry) => entry.answer), ["SPADE", "RAKE"]);
  assert.equal(result.crossword.entries[0].clue, "Digging tool");
});
