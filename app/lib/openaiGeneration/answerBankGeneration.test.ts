import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnswerbankPrompt,
  buildAnswerbankRequest,
  extractResponseOutputText,
  generateLengthBalancedThematicAnswers,
  generateSupportWords,
  requestAnswerbankText,
  requestCompactAnswerbankText,
  requestLengthBucketedAnswerbankText,
  topUpAnswers,
  type OpenAiGenerationCompletion,
  type OpenAiGenerationClient,
} from "./index";

function makeClient(contents: Array<string | OpenAiGenerationCompletion>): {
  client: OpenAiGenerationClient;
  chatRequests: unknown[];
  responseRequests: unknown[];
} {
  const queue = [...contents];
  const chatRequests: unknown[] = [];
  const responseRequests: unknown[] = [];
  const client: OpenAiGenerationClient = {
    chat: {
      completions: {
        create: async (args) => {
          chatRequests.push(args);
          const next = queue.shift() ?? "";
          if (typeof next !== "string") return next;
          return {
            model: String(args.model),
            choices: [{ finish_reason: "stop", message: { content: next } }],
          };
        },
      },
    },
    responses: {
      create: async (args) => {
        responseRequests.push(args);
        const next = queue.shift() ?? "";
        if (typeof next !== "string") return next;
        return { output_text: next };
      },
    },
  };
  return { client, chatRequests, responseRequests };
}

const sanitize = (raw: unknown, maxLen: number) =>
  Array.isArray(raw)
    ? raw
        .map((answer) => String(answer).trim().toUpperCase())
        .filter((answer) => answer.length >= 3 && answer.length <= maxLen)
    : [];

test("buildAnswerbankPrompt and buildAnswerbankRequest preserve target, theme, language, size, and anchors", () => {
  const prompt = buildAnswerbankPrompt(70);
  const request = buildAnswerbankRequest({
    theme: "ocean science",
    language: "en",
    size: 11,
    targetAnswers: 70,
    getThemeAnchors: () => ["kelp forest", "reef"],
    normalizeAnswer: (answer) => answer.replace(/[^A-Za-z]/g, "").toUpperCase(),
  });

  assert.match(prompt, /Generate EXACTLY 70 answers/);
  assert.match(request, /THEME: ocean science/);
  assert.match(request, /LANGUAGE: English/);
  assert.match(request, /SIZE: 11/);
  assert.match(request, /KELPFOREST, REEF/);
});

test("extractResponseOutputText preserves direct and chunked response extraction", () => {
  assert.equal(extractResponseOutputText({ output_text: "direct" }), "direct");
  assert.equal(
    extractResponseOutputText({
      output: [
        { content: [{ text: "one" }, { text: "two" }] },
        { content: [{ text: "three" }] },
      ],
    }),
    "one\ntwo\nthree"
  );
  assert.equal(extractResponseOutputText({}), "");
});

test("requestAnswerbankText sends the existing chat payload when web search is disabled", async () => {
  const { client, chatRequests, responseRequests } = makeClient(['{"answers":["REEF"]}']);
  const result = await requestAnswerbankText({
    client,
    prompt: "PROMPT",
    models: { answerbankModel: "answer-model", answerbankSearchModel: "search-model" },
    allowWebSearch: false,
  });

  assert.equal(result.text, '{"answers":["REEF"]}');
  assert.equal(result.model, "answer-model");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usedWebSearch, false);
  assert.equal(responseRequests.length, 0);
  assert.deepEqual(chatRequests[0], {
    model: "answer-model",
    temperature: 0.2,
    max_tokens: 6000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No extra text." },
      { role: "user", content: "PROMPT" },
    ],
  });
});

test("requestAnswerbankText uses web search when allowed and falls back on invalid JSON", async () => {
  const { client, chatRequests, responseRequests } = makeClient(["not json", '{"answers":["VALID"]}']);
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const result = await requestAnswerbankText({
      client,
      prompt: "PROMPT",
      models: { answerbankModel: "answer-model", answerbankSearchModel: "search-model" },
      allowWebSearch: true,
    });

    assert.equal(result.usedWebSearch, false);
    assert.equal(result.text, '{"answers":["VALID"]}');
    assert.equal(responseRequests.length, 1);
    assert.equal(chatRequests.length, 1);
    assert.match(String((warnings[0] as unknown[])[0]), /answerbank web search returned non-json/);
  } finally {
    console.warn = originalWarn;
  }
});

test("requestCompactAnswerbankText preserves compact chat payload and max token override", async () => {
  const { client, chatRequests } = makeClient(['{"answers":["REEF"],"notes":[]}']);
  const result = await requestCompactAnswerbankText({
    client,
    theme: "ocean science",
    language: "en",
    size: 11,
    models: { compactAnswerbankModel: "compact-model", answerbankSearchModel: "search-model" },
    allowWebSearch: false,
    target: 12,
    maxTokens: 1234,
  });

  assert.equal(result.model, "compact-model");
  assert.equal(result.usedWebSearch, false);
  assert.deepEqual((chatRequests[0] as { model: string; temperature: number; max_tokens: number }).model, "compact-model");
  assert.deepEqual((chatRequests[0] as { temperature: number }).temperature, 0.1);
  assert.deepEqual((chatRequests[0] as { max_tokens: number }).max_tokens, 1234);
  assert.match(JSON.stringify(chatRequests[0]), /Generate EXACTLY 12 crossword answers/);
});

test("requestLengthBucketedAnswerbankText sends one core structured request and preserves parsed order", async () => {
  const { client, chatRequests } = makeClient([
    JSON.stringify({
      entries: [
        { answer: "REEF", canonical: "REEF", relation: "Core ocean structure", kind: "exact" },
        { answer: "KELP", canonical: "KELP", relation: "Marine forest organism", kind: "exact" },
      ],
    }),
  ]);
  const result = await requestLengthBucketedAnswerbankText({
    client,
    theme: "ocean science",
    language: "en",
    size: 11,
    answerbankSearchModel: "search-model",
    fillerWords: ["tide"],
    spanishFillerWords: [],
    normalizeAnswer: (answer) => answer.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
    isValidAnswerCharacters: (answer) => /^[A-Z0-9]+$/.test(answer),
  });

  assert.deepEqual(result.coreAnswers, ["REEF", "KELP"]);
  assert.equal(result.finishReason, "structured-length-buckets");
  assert.equal(chatRequests.length, 1);
  assert.equal((chatRequests[0] as { model: string }).model, "search-model");
  assert.equal((chatRequests[0] as { temperature: number }).temperature, 0.15);
  assert.equal((chatRequests[0] as { max_tokens: number }).max_tokens, 5200);
});

test("topUpAnswers preserves payload, salvage mode, sanitizer, and logging", async () => {
  const { client, chatRequests } = makeClient(['prefix {"answers":["reef","kelp"]} suffix']);
  const logs: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    const result = await topUpAnswers({
      client,
      theme: "ocean science",
      language: "en",
      size: 11,
      existing: ["WAVE"],
      need: 2,
      attempt: 3,
      answerbankModel: "answer-model",
      answerbankSearchModel: "search-model",
      sanitizeAnswerList: sanitize,
    });

    assert.deepEqual(result, ["REEF", "KELP"]);
    assert.equal((chatRequests[0] as { model: string }).model, "search-model");
    assert.equal((chatRequests[0] as { temperature: number }).temperature, 0.2);
    assert.equal((chatRequests[0] as { max_tokens: number }).max_tokens, 880);
    assert.match(String((logs[0] as unknown[])[0]), /answerbank topup raw/);
  } finally {
    console.warn = originalWarn;
  }
});

test("generateLengthBalancedThematicAnswers preserves exact-length payload and dedupe order", async () => {
  const { client, chatRequests } = makeClient([
    '{"answers":["REEF","WAVE"]}',
    '{"answers":["ALGAE","REEF"]}',
  ]);
  const result = await generateLengthBalancedThematicAnswers({
    client,
    theme: "ocean science",
    language: "en",
    size: 11,
    existing: ["WAVE"],
    desiredByLength: new Map([
      [4, 2],
      [5, 1],
    ]),
    attempt: 1,
    answerbankSearchModel: "search-model",
    sanitizeAnswerList: sanitize,
    normalizeAnswer: (answer) => answer.toUpperCase(),
  });

  assert.deepEqual(result, ["REEF", "ALGAE"]);
  assert.equal(chatRequests.length, 2);
  assert.equal((chatRequests[0] as { model: string }).model, "search-model");
  assert.equal((chatRequests[0] as { temperature: number }).temperature, 0.1);
  assert.equal((chatRequests[0] as { max_tokens: number }).max_tokens, 900);
});

test("generateSupportWords keeps no-salvage behavior and filters short sanitized answers", async () => {
  const { client, chatRequests } = makeClient(["reef kelp"]);
  const result = await generateSupportWords({
    client,
    theme: "ocean science",
    language: "en",
    size: 11,
    existing: [],
    attempt: 1,
    answerbankSearchModel: "search-model",
    sanitizeAnswerList: sanitize,
  });

  assert.deepEqual(result, []);
  assert.equal((chatRequests[0] as { model: string }).model, "search-model");
  assert.equal((chatRequests[0] as { temperature: number }).temperature, 0.2);
  assert.equal((chatRequests[0] as { max_tokens: number }).max_tokens, 2200);
});

test("OpenAI generation services propagate request and sanitizer exceptions without retries", async () => {
  let calls = 0;
  const client: OpenAiGenerationClient = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          throw new Error("request failed");
        },
      },
    },
  };

  await assert.rejects(
    () =>
      topUpAnswers({
        client,
        theme: "ocean science",
        language: "en",
        size: 11,
        existing: [],
        need: 2,
        attempt: 1,
        answerbankModel: "answer-model",
        answerbankSearchModel: "search-model",
        sanitizeAnswerList: sanitize,
      }),
    /request failed/
  );
  assert.equal(calls, 1);

  const { client: sanitizerClient } = makeClient(['{"answers":["REEF"]}']);
  await assert.rejects(
    () =>
      topUpAnswers({
        client: sanitizerClient,
        theme: "ocean science",
        language: "en",
        size: 11,
        existing: [],
        need: 2,
        attempt: 1,
        answerbankModel: "answer-model",
        answerbankSearchModel: "search-model",
        sanitizeAnswerList: () => {
          throw new Error("sanitize failed");
        },
      }),
    /sanitize failed/
  );
});
