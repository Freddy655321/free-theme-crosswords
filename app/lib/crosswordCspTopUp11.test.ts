import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCspLengthTopUpPrompt11,
  parseCspLengthTopUpResponse11,
  requestCspLengthTopUpAnswers11,
} from "./crosswordCspTopUp11";

test("top-up prompt requests exact grouped lengths generically", () => {
  const prompt = buildCspLengthTopUpPrompt11({
    theme: "any topic",
    language: "en",
    existingAnswers: ["ALPHA"],
    requestedByLength: { 4: 5, 7: 2 },
    attempt: 1,
  });

  assert.match(prompt, /"byLength"/);
  assert.match(prompt, /4: 5/);
  assert.match(prompt, /7: 2/);
  assert.match(prompt, /Works for any user theme/);
  assert.doesNotMatch(prompt.toLowerCase(), /megadeth|taylor swift|bariloche/);
});

test("top-up parser accepts only requested exact lengths and rejects duplicates/theme answer", () => {
  const parsed = parseCspLengthTopUpResponse11(
    JSON.stringify({
      byLength: {
        4: ["MOON", "TOOLONG", "MOON"],
        5: ["THEME", "RIVER"],
        7: ["IGNORED"],
      },
    }),
    {
      theme: "theme",
      language: "en",
      existingAnswers: ["MOON"],
      requestedByLength: { 4: 2, 5: 2 },
      attempt: 1,
    }
  );

  assert.deepEqual(parsed.candidates.map((candidate) => candidate.answer), ["RIVER"]);
  assert.equal(parsed.rejectedByReason.duplicate, 2);
  assert.equal(parsed.rejectedByReason["wrong-length"], 1);
  assert.equal(parsed.rejectedByReason["theme-answer"], 1);
  assert.equal(parsed.rejectedByReason["unrequested-length"], 1);
});

test("requestCspLengthTopUpAnswers11 uses injected completion callback", async () => {
  const parsed = await requestCspLengthTopUpAnswers11({
    theme: "topic",
    language: "en",
    existingAnswers: [],
    requestedByLength: { 4: 1 },
    attempt: 2,
    completeJson: async (prompt) => {
      assert.match(prompt, /Requested exact normalized lengths/);
      return JSON.stringify({ byLength: { 4: ["NODE"] } });
    },
  });

  assert.deepEqual(parsed.candidates, [{ answer: "NODE", thematic: true, source: "model" }]);
});
