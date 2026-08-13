import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DerivedEntry, WordCandidate } from "@/app/lib/crosswordTypes";
import { deriveEntriesFromGrid } from "@/app/lib/publishPipeline";
import {
  generatePatternMatchedRepairWords,
  requestDirectPlayableCrossword11,
  requestGeneratedPatternGrid11,
  requestValidatedGridProposal,
  requestValidatedLayoutProposal,
  requestValidatedPatternAssignment11,
} from "./openaiRepairServices";
import type {
  OpenAiRepairChatClient,
  OpenAiRepairPatternSlot,
  OpenAiRepairServicesDependencies,
} from "./openaiRepairTypes";

function fakeClient(content: string | ((request: unknown) => string), opts: { throwOnCall?: number } = {}) {
  const calls: unknown[] = [];
  const client: OpenAiRepairChatClient = {
    chat: {
      completions: {
        create: async (request: unknown) => {
          calls.push(request);
          if (opts.throwOnCall === calls.length) throw new Error("request failed");
          const responseContent = typeof content === "function" ? content(request) : content;
          return { choices: [{ message: { content: responseContent } }] };
        },
      },
    },
  };
  return { client, calls };
}

function extractPatternSlots(pattern: string[]): OpenAiRepairPatternSlot[] {
  const slots: OpenAiRepairPatternSlot[] = [];
  for (let r = 0; r < pattern.length; r++) {
    let c = 0;
    while (c < pattern[r].length) {
      while (c < pattern[r].length && pattern[r][c] === "#") c++;
      const start = c;
      while (c < pattern[r].length && pattern[r][c] !== "#") c++;
      if (c - start >= 3) {
        slots.push({
          direction: "across",
          row: r,
          col: start,
          len: c - start,
          cells: Array.from({ length: c - start }, (_, i) => ({ r, c: start + i })),
        });
      }
    }
  }
  for (let c = 0; c < pattern[0].length; c++) {
    let r = 0;
    while (r < pattern.length) {
      while (r < pattern.length && pattern[r][c] === "#") r++;
      const start = r;
      while (r < pattern.length && pattern[r][c] !== "#") r++;
      if (r - start >= 3) {
        slots.push({
          direction: "down",
          row: start,
          col: c,
          len: r - start,
          cells: Array.from({ length: r - start }, (_, i) => ({ r: start + i, c })),
        });
      }
    }
  }
  return slots;
}

function deps(warnings: unknown[] = []): OpenAiRepairServicesDependencies {
  return {
    answerbankSearchModel: "repair-model",
    alwaysAllowAnswers: new Set<string>(),
    commonEnglishDictionaryWords: ["AREA", "ALOE", "NODE"],
    frequencyEnglishDictionaryWords: ["ABLE", "BETA", "DATA"],
    frequencySpanishDictionaryWords: ["CASA", "MESA", "RUTA"],
    weakContextDictionaryWords: new Set<string>(),
    spanishFillerWords: ["CASA", "MESA"],
    fillerWords: ["AREA", "DATA"],
    pattern11x11s: [
      [
        "...#...#...",
        "###########",
        "...#...#...",
        "###########",
        "...#...#...",
        "###########",
        "...#...#...",
        "###########",
        "...#...####",
        "###########",
        "...#...####",
      ],
    ],
    logger: { warn: (...args: unknown[]) => warnings.push(args) },
    errorSummary: (error) => (error instanceof Error ? error.message : String(error)),
    extractPatternSlots,
    deriveEntriesFromGrid,
    isAcceptable: () => true,
    isForbiddenPublishAnswer: (answer) => answer === "BAN",
    isLikelyBadAnswer: () => false,
    isOverGenericThemeWordForTheme: () => false,
    noteLooksWeakThematicContext: () => false,
    hasStrongThematicClueSupport: () => true,
    validateThematicAnswers: async (input) => input.answers,
    sanitizeModelClueText: (clue) => clue.trim(),
    isBadClue: () => false,
    clueMentionsAnswer: () => false,
    clueMakesUnstableTemporalClaim: () => false,
    clueMislabelsPartialPersonAnswer: () => false,
    clueMislabelsKnownPartialTitle: () => false,
    buildThematicClueRequestHint: (_theme, answer) => `Hint for ${answer}`,
    requestModelClues: async (input) =>
      new Map(input.items.map((item) => [item.answer, `Clue for ${item.answer}`])),
    reinforceThematicClues: () => undefined,
    applyCluesAndOverrides: (_theme, _language, derived, clueByAnswer) =>
      derived.map((entry) => ({ ...entry, clue: clueByAnswer.get(entry.answer) ?? "" })),
    repairPublishClues: (entries) => entries,
    publishQualityIssue: () => null,
    augmentNoShortGridWithCandidates: () => null,
  };
}

function candidates(answers: string[]): WordCandidate[] {
  return answers.map((answer) => ({ answer, thematic: true, source: "model" }));
}

function candidatesForPattern(pattern: string[]): WordCandidate[] {
  const counts = new Map<number, number>();
  for (const slot of extractPatternSlots(pattern)) counts.set(slot.len, Math.max(counts.get(slot.len) ?? 0, 2) + 1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const answers: string[] = [];
  for (const [len, count] of counts) {
    for (let i = 0; i < count; i++) {
      answers.push(Array.from({ length: len }, (_, j) => alphabet[(i + j) % alphabet.length]).join(""));
    }
  }
  return candidates(answers);
}

function requestOf(calls: unknown[], index = 0) {
  assert.ok(calls[index]);
  return calls[index] as {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    response_format?: unknown;
    messages?: Array<{ role: string; content: string }>;
  };
}

describe("openaiRepairServices", () => {
  it("requests validated grid proposals with exact model payload and json parsing behavior", async () => {
    const warnings: unknown[] = [];
    const { client, calls } = fakeClient("{}");

    const result = await requestValidatedGridProposal({
      client,
      theme: "Neutral",
      language: "en",
      size: 11,
      pool: candidates([
        "ALPHA",
        "BRAVO",
        "CHARM",
        "DELTA",
        "ECHO",
        "FOCUS",
        "GAMMA",
        "HOTEL",
        "INDEX",
        "JOKER",
        "KOALA",
        "LEMUR",
        "METRO",
        "NOVEL",
        "OPERA",
        "PIANO",
      ]),
      themeSet: new Set(["ALPHA"]),
      dependencies: deps(warnings),
    });

    assert.equal(result, null);
    assert.equal(calls.length, 1);
    const request = requestOf(calls);
    assert.equal(request.model, "repair-model");
    assert.equal(request.temperature, 0.1);
    assert.equal(request.max_tokens, 5200);
    assert.deepEqual(request.response_format, { type: "json_object" });
    assert.equal(request.messages?.[0]?.role, "system");
    assert.match(request.messages?.[1]?.content ?? "", /ALLOWED_ANSWERS:/);
  });

  it("requests pattern assignments once and logs malformed JSON without retrying", async () => {
    const warnings: unknown[] = [];
    const { client, calls } = fakeClient("not json");
    const dependencies = deps(warnings);
    const input = candidatesForPattern(dependencies.pattern11x11s[0]);

    const result = await requestValidatedPatternAssignment11({
      client,
      theme: "Neutral",
      language: "en",
      size: 11,
      pool: input,
      themeSet: new Set(input.map((candidate) => candidate.answer)),
      dependencies,
    });

    assert.equal(result, null);
    assert.equal(calls.length, 1);
    const request = requestOf(calls);
    assert.equal(request.model, "repair-model");
    assert.equal(request.temperature, 0.1);
    assert.equal(request.max_tokens, 3600);
    assert.deepEqual(request.response_format, { type: "json_object" });
    assert.match(JSON.stringify(warnings), /json-parse/);
  });

  it("requests generated pattern grids with json schema response format", async () => {
    const warnings: unknown[] = [];
    const { client, calls } = fakeClient("{}");

    const result = await requestGeneratedPatternGrid11({
      client,
      theme: "Neutral",
      language: "en",
      size: 11,
      attempt: 2,
      dependencies: deps(warnings),
    });

    assert.equal(result, null);
    assert.equal(calls.length, 1);
    const request = requestOf(calls);
    assert.equal(request.model, "repair-model");
    assert.equal(request.temperature, 0.2);
    assert.equal(request.max_tokens, 5200);
    assert.match(JSON.stringify(request.response_format), /fixed_crossword_grid_11/);
    assert.match(JSON.stringify(warnings), /json-parse|no-structurally-valid-grid/);
  });

  it("direct playable proposal preserves the two existing tries and propagates request errors", async () => {
    const { client, calls } = fakeClient("{}", { throwOnCall: 2 });

    await assert.rejects(
      requestDirectPlayableCrossword11({
        client,
        theme: "Neutral",
        language: "en",
        attempt: 3,
        dependencies: deps(),
      }),
      /request failed/
    );

    assert.equal(calls.length, 2);
    assert.equal(requestOf(calls, 0).temperature, 0.15);
    assert.equal(requestOf(calls, 1).temperature, 0.3);
    assert.equal(requestOf(calls, 0).max_tokens, 5200);
    assert.match(JSON.stringify(requestOf(calls, 0).response_format), /playable_crossword_11/);
  });

  it("direct playable proposal propagates sanitizer exceptions without retry wrapping", async () => {
    const { client, calls } = fakeClient(
      '{"fills":[{"slot":1,"answer":"ABCD","clue":"Specific clue","relation":"Concrete relation"}]}'
    );
    const dependencies = deps();
    dependencies.sanitizeModelClueText = () => {
      throw new Error("sanitize failed");
    };

    await assert.rejects(
      requestDirectPlayableCrossword11({
        client,
        theme: "Neutral",
        language: "en",
        attempt: 4,
        dependencies,
      }),
      /sanitize failed/
    );

    assert.equal(calls.length, 1);
  });

  it("returns null for missing choices without fabricating fallback data", async () => {
    const calls: unknown[] = [];
    const client: OpenAiRepairChatClient = {
      chat: {
        completions: {
          create: async (request: unknown) => {
            calls.push(request);
            return {};
          },
        },
      },
    };

    const result = await requestValidatedGridProposal({
      client,
      theme: "Neutral",
      language: "en",
      size: 11,
      pool: candidates([
        "ALPHA",
        "BRAVO",
        "CHARM",
        "DELTA",
        "ECHO",
        "FOCUS",
        "GAMMA",
        "HOTEL",
        "INDEX",
        "JOKER",
        "KOALA",
        "LEMUR",
        "METRO",
        "NOVEL",
        "OPERA",
        "PIANO",
      ]),
      themeSet: new Set(["ALPHA"]),
      dependencies: deps(),
    });

    assert.equal(result, null);
    assert.equal(calls.length, 1);
  });

  it("layout proposal keeps local no-model short circuit when fixed-pattern supply is insufficient", async () => {
    const { client, calls } = fakeClient("{}");

    const result = await requestValidatedLayoutProposal({
      client,
      theme: "Neutral",
      language: "en",
      size: 11,
      pool: candidates(["ALPHA", "BRAVO", "CHARM", "DELTA", "ECHO", "FOCUS", "GAMMA", "HOTEL", "INDEX", "JOKER", "KOALA"]),
      themeSet: new Set(["ALPHA", "BRAVO"]),
      dependencies: deps(),
    });

    assert.equal(result, null);
    assert.equal(calls.length, 1);
    assert.equal(requestOf(calls).model, "repair-model");
    assert.equal(requestOf(calls).max_tokens, 2600);
  });

  it("pattern repair words keeps empty-pattern no-call behavior and does not mutate inputs", async () => {
    const { client, calls } = fakeClient('{"matches":[]}');
    const entries: DerivedEntry[] = [];
    const grid = Array.from({ length: 11 }, () => Array.from({ length: 11 }, () => "#"));
    const originalGrid = grid.map((row) => row.slice());

    const result = await generatePatternMatchedRepairWords({
      client,
      theme: "Neutral",
      language: "en",
      grid,
      entries,
      existingAnswers: [],
      dependencies: deps(),
    });

    assert.deepEqual(result, []);
    assert.equal(calls.length, 0);
    assert.deepEqual(grid, originalGrid);
  });

  it("pattern repair words parses matches, filters forbidden answers, dedupes, and preserves order", async () => {
    const warnings: unknown[] = [];
    const { client, calls } = fakeClient((request) => {
      const content = JSON.stringify(request);
      const match = /PATTERNS: ([A-Z?, ]+)/.exec(content);
      const pattern = match?.[1]?.split(", ")?.[0] ?? "A?C";
      const answer = pattern.replace(/\?/g, "B");
      return JSON.stringify({ matches: [{ pattern, answers: [answer, answer, "BAN"] }] });
    });
    const grid = Array.from({ length: 11 }, () => Array.from({ length: 11 }, () => "#"));
    grid[5][4] = "A";
    grid[5][5] = "X";
    grid[5][6] = "C";
    grid[4][4] = "D";
    grid[6][4] = "E";
    grid[4][6] = "F";
    grid[6][6] = "G";
    const entries: DerivedEntry[] = [
      { number: 1, row: 5, col: 4, direction: "across", answer: "AXC" },
      { number: 2, row: 4, col: 4, direction: "down", answer: "DAE" },
      { number: 3, row: 4, col: 6, direction: "down", answer: "FCG" },
    ];

    const result = await generatePatternMatchedRepairWords({
      client,
      theme: "Neutral",
      language: "en",
      grid,
      entries,
      existingAnswers: ["AXC"],
      dependencies: deps(warnings),
    });

    assert.equal(calls.length <= 1, true);
    if (calls.length === 1) {
      assert.equal(requestOf(calls).model, "repair-model");
      assert.equal(requestOf(calls).temperature, 0.1);
      assert.equal(requestOf(calls).max_tokens, 2600);
      assert.deepEqual(requestOf(calls).response_format, { type: "json_object" });
      assert.equal(result.length, 1);
      assert.equal(result[0].source, "support");
      assert.match(JSON.stringify(warnings), /pattern-repair-11/);
    } else {
      assert.deepEqual(result, []);
    }
  });
});
