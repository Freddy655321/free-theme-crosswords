import assert from "node:assert/strict";
import test from "node:test";

import { requestAnswerTopUp, type RequestAnswerTopUpInput, type RequestAnswerTopUpRequestArgs } from "./index";

const requestArgs: RequestAnswerTopUpRequestArgs = {
  model: "test-model",
  temperature: 0.2,
  max_tokens: 123,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: "system message" },
    { role: "user", content: "user message" },
  ],
};

function makeClient(rawText: string) {
  const calls: RequestAnswerTopUpRequestArgs[] = [];
  return {
    calls,
    client: {
      chat: {
        completions: {
          create: async (request: RequestAnswerTopUpRequestArgs) => {
            calls.push(request);
            return { choices: [{ message: { content: rawText } }] };
          },
        },
      },
    },
  };
}

function makeInput(
  overrides: Partial<RequestAnswerTopUpInput> & { rawText?: string } = {}
): RequestAnswerTopUpInput & { calls: RequestAnswerTopUpRequestArgs[]; sanitizedInputs: unknown[] } {
  const { rawText = '{"answers":["ALPHA","BETA"]}', ...rest } = overrides;
  const { client, calls } = makeClient(rawText);
  const sanitizedInputs: unknown[] = [];
  return {
    client,
    request: requestArgs,
    parseMode: "answers-with-salvage",
    maxLen: 11,
    language: "en",
    sanitize: (raw) => {
      sanitizedInputs.push(raw);
      return Array.isArray(raw) ? raw.map(String) : [];
    },
    calls,
    sanitizedInputs,
    ...rest,
  };
}

test("requestAnswerTopUp returns sanitized answers for valid JSON", async () => {
  const input = makeInput();

  const result = await requestAnswerTopUp(input);

  assert.deepEqual(result.cleanedAnswers, ["ALPHA", "BETA"]);
  assert.deepEqual(result.parsedAnswers, ["ALPHA", "BETA"]);
  assert.deepEqual(result.salvagedAnswers, []);
});

test("requestAnswerTopUp returns empty answers for an empty response", async () => {
  const input = makeInput({ rawText: "" });

  const result = await requestAnswerTopUp(input);

  assert.deepEqual(result.cleanedAnswers, []);
  assert.deepEqual(input.sanitizedInputs, [[]]);
});

test("requestAnswerTopUp does not salvage invalid JSON when salvage is disabled", async () => {
  const input = makeInput({
    rawText: '{"answers":["ONE","TWO"',
    parseMode: "answers-no-salvage",
  });

  const result = await requestAnswerTopUp(input);

  assert.deepEqual(result.cleanedAnswers, []);
  assert.deepEqual(result.salvagedAnswers, []);
  assert.deepEqual(input.sanitizedInputs, [undefined]);
});

test("requestAnswerTopUp salvages invalid JSON when salvage is enabled", async () => {
  const input = makeInput({ rawText: '{"answers":["ONE","TWO"' });

  const result = await requestAnswerTopUp(input);

  assert.deepEqual(result.salvagedAnswers, ["ONE", "TWO"]);
  assert.deepEqual(result.cleanedAnswers, ["ONE", "TWO"]);
});

test("requestAnswerTopUp records empty salvage when no answer strings can be recovered", async () => {
  const input = makeInput({ rawText: "{not json" });

  const result = await requestAnswerTopUp(input);

  assert.deepEqual(result.salvagedAnswers, []);
  assert.deepEqual(result.cleanedAnswers, []);
});

test("requestAnswerTopUp preserves parsed answer order", async () => {
  const input = makeInput({ rawText: '{"answers":["THREE","ONE","TWO"]}' });

  const result = await requestAnswerTopUp(input);

  assert.deepEqual(result.cleanedAnswers, ["THREE", "ONE", "TWO"]);
});

test("requestAnswerTopUp invokes sanitizer exactly once", async () => {
  let calls = 0;
  const input = makeInput({
    sanitize: (raw) => {
      calls++;
      return Array.isArray(raw) ? raw.map(String) : [];
    },
  });

  await requestAnswerTopUp(input);

  assert.equal(calls, 1);
});

test("requestAnswerTopUp passes max length and language to sanitizer", async () => {
  const received: Array<{ maxLen: number; language: string }> = [];
  const input = makeInput({
    maxLen: 8,
    language: "es",
    sanitize: (_raw, maxLen, language) => {
      received.push({ maxLen, language });
      return [];
    },
  });

  await requestAnswerTopUp(input);

  assert.deepEqual(received, [{ maxLen: 8, language: "es" }]);
});

test("requestAnswerTopUp returns an empty sanitizer result as-is", async () => {
  const input = makeInput({ sanitize: () => [] });

  const result = await requestAnswerTopUp(input);

  assert.deepEqual(result.cleanedAnswers, []);
});

test("requestAnswerTopUp propagates sanitizer exceptions after logging raw text", async () => {
  const logs: unknown[] = [];
  const input = makeInput({
    logger: (payload) => logs.push(payload),
    sanitize: () => {
      throw new Error("sanitize failed");
    },
  });

  await assert.rejects(() => requestAnswerTopUp(input), /sanitize failed/);
  assert.equal(logs.length, 1);
});

test("requestAnswerTopUp propagates request exceptions without logging", async () => {
  const logs: unknown[] = [];
  const input = makeInput({
    client: {
      chat: {
        completions: {
          create: async () => {
            throw new Error("request failed");
          },
        },
      },
    },
    logger: (payload) => logs.push(payload),
  });

  await assert.rejects(() => requestAnswerTopUp(input), /request failed/);
  assert.deepEqual(logs, []);
});

test("requestAnswerTopUp logger receives raw success payload", async () => {
  const logs: unknown[] = [];
  const input = makeInput({
    rawText: '{"answers":["ALPHA"]}',
    logger: (payload) => logs.push(payload),
  });

  await requestAnswerTopUp(input);

  assert.deepEqual(logs, [
    {
      rawText: '{"answers":["ALPHA"]}',
      rawText_len: 21,
      rawText_head: '{"answers":["ALPHA"]}',
      rawText_tail: '{"answers":["ALPHA"]}',
    },
  ]);
});

test("requestAnswerTopUp logger receives raw payload even when parse later fails", async () => {
  const logs: unknown[] = [];
  const input = makeInput({
    rawText: "{not json",
    logger: (payload) => logs.push(payload),
  });

  await requestAnswerTopUp(input);

  assert.equal(logs.length, 1);
});

test("requestAnswerTopUp passes request args through by reference", async () => {
  const input = makeInput();

  await requestAnswerTopUp(input);

  assert.equal(input.calls[0], requestArgs);
});

test("requestAnswerTopUp preserves model and payload fields", async () => {
  const input = makeInput();

  await requestAnswerTopUp(input);

  assert.equal(input.calls[0]?.model, "test-model");
  assert.equal(input.calls[0]?.temperature, 0.2);
  assert.equal(input.calls[0]?.max_tokens, 123);
});

test("requestAnswerTopUp preserves response_format", async () => {
  const input = makeInput();

  await requestAnswerTopUp(input);

  assert.deepEqual(input.calls[0]?.response_format, { type: "json_object" });
});

test("requestAnswerTopUp does not mutate request args", async () => {
  const input = makeInput();
  const before = JSON.stringify(input.request);

  await requestAnswerTopUp(input);

  assert.equal(JSON.stringify(input.request), before);
});

test("requestAnswerTopUp performs no internal retries", async () => {
  const input = makeInput({ rawText: "" });

  await requestAnswerTopUp(input);

  assert.equal(input.calls.length, 1);
});

test("requestAnswerTopUp performs no deadline checks", async () => {
  const input = makeInput();

  await requestAnswerTopUp(input);

  assert.equal(input.calls.length, 1);
});

test("requestAnswerTopUp distinguishes salvage enabled and disabled modes", async () => {
  const rawText = '{"answers":["ONE"';
  const enabled = await requestAnswerTopUp(makeInput({ rawText, parseMode: "answers-with-salvage" }));
  const disabled = await requestAnswerTopUp(makeInput({ rawText, parseMode: "answers-no-salvage" }));

  assert.deepEqual(enabled.cleanedAnswers, ["ONE"]);
  assert.deepEqual(disabled.cleanedAnswers, []);
});

test("requestAnswerTopUp does not salvage a valid empty answers array", async () => {
  const input = makeInput({
    rawText: '{"answers":[]} "ALPHA"',
    parseMode: "answers-with-salvage",
  });

  const result = await requestAnswerTopUp(input);

  assert.deepEqual(result.parsedAnswers, []);
  assert.deepEqual(result.salvagedAnswers, []);
  assert.deepEqual(result.cleanedAnswers, []);
  assert.deepEqual(input.sanitizedInputs, [[]]);
});

test("requestAnswerTopUp ignores notes metadata for answer-only top-up batches", async () => {
  const input = makeInput({
    rawText: '{"answers":["ALPHA"],"notes":[{"answer":"ALPHA","note":"specific note"}]}',
  });

  const result = await requestAnswerTopUp(input);

  assert.deepEqual(result.cleanedAnswers, ["ALPHA"]);
});

test("requestAnswerTopUp supports custom sanitizer output", async () => {
  const input = makeInput({ sanitize: () => ["CUSTOM"] });

  const result = await requestAnswerTopUp(input);

  assert.deepEqual(result.cleanedAnswers, ["CUSTOM"]);
});

test("requestAnswerTopUp allows an omitted logger", async () => {
  const input = makeInput({ logger: undefined });

  const result = await requestAnswerTopUp(input);

  assert.deepEqual(result.cleanedAnswers, ["ALPHA", "BETA"]);
});

test("requestAnswerTopUp returns the raw text in its structured result", async () => {
  const input = makeInput({ rawText: '{"answers":["RAW"]}' });

  const result = await requestAnswerTopUp(input);

  assert.equal(result.rawText, '{"answers":["RAW"]}');
});

test("requestAnswerTopUp does not apply thematic filtering internally", async () => {
  const input = makeInput({
    rawText: '{"answers":["THEMEWORD","GENERIC"]}',
  });

  const result = await requestAnswerTopUp(input);

  assert.deepEqual(result.cleanedAnswers, ["THEMEWORD", "GENERIC"]);
});

test("requestAnswerTopUp sends messages unchanged", async () => {
  const input = makeInput();

  await requestAnswerTopUp(input);

  assert.deepEqual(input.calls[0]?.messages, requestArgs.messages);
});

test("requestAnswerTopUp sanitizes parsed arrays before considering salvage", async () => {
  const input = makeInput({
    rawText: '{"answers":["PARSED"],"extra":["IGNORED"]}',
  });

  const result = await requestAnswerTopUp(input);

  assert.deepEqual(result.parsedAnswers, ["PARSED"]);
  assert.deepEqual(result.salvagedAnswers, []);
});

test("requestAnswerTopUp treats null message content as an empty response", async () => {
  const calls: RequestAnswerTopUpRequestArgs[] = [];
  const input = makeInput({
    client: {
      chat: {
        completions: {
          create: async (request) => {
            calls.push(request);
            return { choices: [{ message: { content: null } }] };
          },
        },
      },
    },
  });

  const result = await requestAnswerTopUp(input);

  assert.equal(result.rawText, "");
  assert.deepEqual(result.cleanedAnswers, []);
});
