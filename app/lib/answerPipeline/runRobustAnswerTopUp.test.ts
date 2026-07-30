import assert from "node:assert/strict";
import test from "node:test";

import { runRobustAnswerTopUp, type RobustAnswerTopUpBatchRequest } from "./index";

const identity = (answer: string) => answer;

function upperKey(answer: string) {
  return answer.trim().toUpperCase();
}

test("runRobustAnswerTopUp returns empty without requests when need is zero or negative", async () => {
  let calls = 0;

  assert.deepEqual(
    await runRobustAnswerTopUp({
      existing: [],
      need: 0,
      size: 11,
      normalizeKey: identity,
      requestBatch: async () => {
        calls++;
        return ["ALPHA"];
      },
    }),
    []
  );
  assert.deepEqual(
    await runRobustAnswerTopUp({
      existing: [],
      need: -2,
      size: 11,
      normalizeKey: identity,
      requestBatch: async () => {
        calls++;
        return ["ALPHA"];
      },
    }),
    []
  );
  assert.equal(calls, 0);
});

test("runRobustAnswerTopUp succeeds on the first attempt", async () => {
  const calls: RobustAnswerTopUpBatchRequest[] = [];
  const result = await runRobustAnswerTopUp({
    existing: [],
    need: 2,
    size: 11,
    normalizeKey: identity,
    requestBatch: async (request) => {
      calls.push(request);
      return ["ALPHA", "BETA"];
    },
  });

  assert.deepEqual(result, ["ALPHA", "BETA"]);
  assert.deepEqual(calls, [{ existing: [], need: 2, tryIndex: 0 }]);
});

test("runRobustAnswerTopUp succeeds on the second attempt after an empty response", async () => {
  const calls: RobustAnswerTopUpBatchRequest[] = [];
  const result = await runRobustAnswerTopUp({
    existing: [],
    need: 8,
    size: 11,
    normalizeKey: identity,
    requestBatch: async (request) => {
      calls.push(request);
      return calls.length === 1 ? [] : ["A", "B", "C"];
    },
  });

  assert.deepEqual(result, ["A", "B", "C"]);
  assert.deepEqual(calls.map((call) => call.need), [8, 5, 5, 5]);
  assert.deepEqual(calls.map((call) => call.tryIndex), [0, 1, 2, 3]);
});

test("runRobustAnswerTopUp exhausts four attempts and returns accumulated answers", async () => {
  const calls: RobustAnswerTopUpBatchRequest[] = [];
  const result = await runRobustAnswerTopUp({
    existing: [],
    need: 4,
    size: 11,
    normalizeKey: identity,
    requestBatch: async (request) => {
      calls.push(request);
      return calls.length === 3 ? ["ONLY"] : [];
    },
  });

  assert.deepEqual(result, ["ONLY"]);
  assert.equal(calls.length, 4);
});

test("runRobustAnswerTopUp backs off repeatedly after empty responses", async () => {
  const requested: number[] = [];
  await runRobustAnswerTopUp({
    existing: [],
    need: 40,
    size: 11,
    normalizeKey: identity,
    requestBatch: async (request) => {
      requested.push(request.need);
      return [];
    },
  });

  assert.deepEqual(requested, [18, 9, 5, 5]);
});

test("runRobustAnswerTopUp does not back off when a batch has results", async () => {
  const requested: number[] = [];
  await runRobustAnswerTopUp({
    existing: ["ALPHA"],
    need: 3,
    size: 11,
    normalizeKey: identity,
    requestBatch: async (request) => {
      requested.push(request.need);
      return ["ALPHA"];
    },
  });

  assert.deepEqual(requested, [3, 3, 3, 3]);
});

test("runRobustAnswerTopUp uses the current initial chunk for 11x11", async () => {
  const requested: number[] = [];
  await runRobustAnswerTopUp({
    existing: [],
    need: 30,
    size: 11,
    normalizeKey: identity,
    requestBatch: async (request) => {
      requested.push(request.need);
      return [];
    },
  });

  assert.equal(requested[0], 18);
});

test("runRobustAnswerTopUp uses the current initial chunk for non-11 grids", async () => {
  const requested: number[] = [];
  await runRobustAnswerTopUp({
    existing: [],
    need: 30,
    size: 13,
    normalizeKey: identity,
    requestBatch: async (request) => {
      requested.push(request.need);
      return [];
    },
  });

  assert.equal(requested[0], 24);
});

test("runRobustAnswerTopUp limits the first chunk by need", async () => {
  const requested: number[] = [];
  await runRobustAnswerTopUp({
    existing: [],
    need: 7,
    size: 13,
    normalizeKey: identity,
    requestBatch: async (request) => {
      requested.push(request.need);
      return [];
    },
  });

  assert.equal(requested[0], 7);
});

test("runRobustAnswerTopUp deduplicates within a batch and keeps the first normalized value", async () => {
  const result = await runRobustAnswerTopUp({
    existing: [],
    need: 4,
    size: 11,
    normalizeKey: upperKey,
    requestBatch: async () => [" alpha ", "ALPHA", "Beta"],
  });

  assert.deepEqual(result, ["ALPHA", "BETA"]);
});

test("runRobustAnswerTopUp deduplicates across batches", async () => {
  let call = 0;
  const result = await runRobustAnswerTopUp({
    existing: [],
    need: 3,
    size: 11,
    normalizeKey: upperKey,
    requestBatch: async () => {
      call++;
      return call === 1 ? ["ALPHA"] : ["alpha", "BETA"];
    },
  });

  assert.deepEqual(result, ["ALPHA", "BETA"]);
});

test("runRobustAnswerTopUp preserves insertion order", async () => {
  const result = await runRobustAnswerTopUp({
    existing: [],
    need: 3,
    size: 11,
    normalizeKey: identity,
    requestBatch: async () => ["THREE", "ONE", "TWO"],
  });

  assert.deepEqual(result, ["THREE", "ONE", "TWO"]);
});

test("runRobustAnswerTopUp stops when need is reached and avoids extra calls", async () => {
  let calls = 0;
  const result = await runRobustAnswerTopUp({
    existing: [],
    need: 2,
    size: 11,
    normalizeKey: identity,
    requestBatch: async () => {
      calls++;
      return ["ALPHA", "BETA"];
    },
  });

  assert.deepEqual(result, ["ALPHA", "BETA"]);
  assert.equal(calls, 1);
});

test("runRobustAnswerTopUp returns partial answers after max tries", async () => {
  const result = await runRobustAnswerTopUp({
    existing: [],
    need: 3,
    size: 11,
    normalizeKey: identity,
    requestBatch: async () => ["ALPHA"],
  });

  assert.deepEqual(result, ["ALPHA"]);
});

test("runRobustAnswerTopUp passes updated existing values in set insertion order", async () => {
  const seenExisting: string[][] = [];
  let call = 0;
  await runRobustAnswerTopUp({
    existing: [" seed ", "ROOT"],
    need: 2,
    size: 11,
    normalizeKey: upperKey,
    requestBatch: async (request) => {
      seenExisting.push(request.existing);
      call++;
      return call === 1 ? ["ALPHA"] : ["BETA"];
    },
  });

  assert.deepEqual(seenExisting, [
    ["SEED", "ROOT"],
    ["SEED", "ROOT", "ALPHA"],
  ]);
});

test("runRobustAnswerTopUp propagates an error on the first attempt", async () => {
  await assert.rejects(
    () =>
      runRobustAnswerTopUp({
        existing: [],
        need: 2,
        size: 11,
        normalizeKey: identity,
        requestBatch: async () => {
          throw new Error("request failed");
        },
      }),
    /request failed/
  );
});

test("runRobustAnswerTopUp propagates an error after partial success", async () => {
  let call = 0;
  await assert.rejects(
    () =>
      runRobustAnswerTopUp({
        existing: [],
        need: 2,
        size: 11,
        normalizeKey: identity,
        requestBatch: async () => {
          call++;
          if (call === 1) return ["ALPHA"];
          throw new Error("second failed");
        },
      }),
    /second failed/
  );
});

test("runRobustAnswerTopUp invokes the injected normalizeKey for existing and returned answers", async () => {
  const normalized: string[] = [];
  await runRobustAnswerTopUp({
    existing: ["seed"],
    need: 1,
    size: 11,
    normalizeKey: (answer) => {
      normalized.push(answer);
      return answer.toUpperCase();
    },
    requestBatch: async () => ["alpha"],
  });

  assert.deepEqual(normalized, ["seed", "alpha"]);
});

test("runRobustAnswerTopUp does not mutate batches returned by requestBatch", async () => {
  const batch = ["ALPHA", "BETA"];
  await runRobustAnswerTopUp({
    existing: [],
    need: 1,
    size: 11,
    normalizeKey: identity,
    requestBatch: async () => batch,
  });

  assert.deepEqual(batch, ["ALPHA", "BETA"]);
});

test("runRobustAnswerTopUp does not use timers, deadlines, or logs", async () => {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalWarn = console.warn;
  Date.now = () => {
    throw new Error("Date.now should not be called");
  };
  globalThis.setTimeout = (() => {
    throw new Error("setTimeout should not be called");
  }) as unknown as typeof setTimeout;
  console.warn = () => {
    throw new Error("console.warn should not be called");
  };
  try {
    const result = await runRobustAnswerTopUp({
      existing: [],
      need: 1,
      size: 11,
      normalizeKey: identity,
      requestBatch: async () => ["ALPHA"],
    });
    assert.deepEqual(result, ["ALPHA"]);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    console.warn = originalWarn;
  }
});

test("runRobustAnswerTopUp performs only the outer robust retry loop", async () => {
  let calls = 0;
  await runRobustAnswerTopUp({
    existing: [],
    need: 10,
    size: 11,
    normalizeKey: identity,
    requestBatch: async () => {
      calls++;
      return [];
    },
  });

  assert.equal(calls, 4);
});

test("runRobustAnswerTopUp contains no thematic behavior in observable output", async () => {
  const result = await runRobustAnswerTopUp({
    existing: [],
    need: 2,
    size: 11,
    normalizeKey: identity,
    requestBatch: async () => ["THEMEWORD", "GENERIC"],
  });

  assert.deepEqual(result, ["THEMEWORD", "GENERIC"]);
});

test("runRobustAnswerTopUp trims an oversized batch to need", async () => {
  const result = await runRobustAnswerTopUp({
    existing: [],
    need: 2,
    size: 11,
    normalizeKey: identity,
    requestBatch: async () => ["ONE", "TWO", "THREE"],
  });

  assert.deepEqual(result, ["ONE", "TWO"]);
});

test("runRobustAnswerTopUp discards empty normalized answers", async () => {
  const result = await runRobustAnswerTopUp({
    existing: [],
    need: 2,
    size: 11,
    normalizeKey: (answer) => answer.trim(),
    requestBatch: async () => ["", "   ", "ALPHA"],
  });

  assert.deepEqual(result, ["ALPHA"]);
});

test("runRobustAnswerTopUp invokes callbacks sequentially", async () => {
  const events: string[] = [];
  await runRobustAnswerTopUp({
    existing: [],
    need: 2,
    size: 11,
    normalizeKey: identity,
    requestBatch: async (request) => {
      events.push(`start-${request.tryIndex}`);
      events.push(`end-${request.tryIndex}`);
      return request.tryIndex === 0 ? ["ALPHA"] : ["BETA"];
    },
  });

  assert.deepEqual(events, ["start-0", "end-0", "start-1", "end-1"]);
});
