import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConstraintTopUpRequestsFromConflicts11,
  buildCspConstraintTopUpPrompt11,
  parseCspConstraintTopUpResponse11,
  requestCspConstraintTopUpAnswers11,
} from "./crosswordCspConstraintTopUp11";
import type { CspPropagationConflict11 } from "./crosswordCsp11";

function conflict(patternLetters: Array<[number, string]>): CspPropagationConflict11 {
  return {
    emptiedSlotId: "D4",
    emptiedSlotLength: 6,
    previousDomainSize: 12,
    constraints: patternLetters.map(([position, requiredLetter], index) => ({
      slotId: "D4",
      slotLength: 6,
      position,
      requiredLetter,
      sourceSlotId: `A${index + 1}`,
      sourcePosition: index,
    })),
    candidateCountBeforeEachConstraint: patternLetters.map(([position, requiredLetter], index) => ({
      position,
      requiredLetter,
      before: 12 - index * 2,
      after: Math.max(0, 8 - index * 4),
    })),
    assignedSlots: [{ slotId: "A1", answer: "ABCDEF" }],
  };
}

test("builds constrained requests from propagation conflicts and limits fixed letters", () => {
  const requests = buildConstraintTopUpRequestsFromConflicts11({
    conflicts: [conflict([[0, "A"], [1, "B"], [2, "C"], [3, "D"]])],
    maxRequests: 3,
    maxFixedLetters: 3,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.length, 6);
  assert.equal(requests[0]?.constraints.length, 3);
  assert.ok(requests[0]?.requestId.startsWith("len6-"));
});

test("groups repeated conflicts deterministically", () => {
  const requests = buildConstraintTopUpRequestsFromConflicts11({
    conflicts: [
      conflict([[1, "A"], [4, "R"]]),
      conflict([[1, "A"], [4, "R"]]),
      conflict([[2, "E"]]),
    ],
    maxRequests: 1,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.requestId, "len6-p1A-p4R");
});

test("prompt is generic and describes zero-based positions", () => {
  const prompt = buildCspConstraintTopUpPrompt11({
    theme: "any topic",
    language: "en",
    excludedAnswers: ["ALPHA"],
    attempt: 1,
    requests: [{ requestId: "len6-p1A", length: 6, constraints: [{ position: 1, requiredLetter: "A" }], count: 8 }],
  });

  assert.match(prompt, /zero-based/);
  assert.match(prompt, /len6-p1A/);
  assert.match(prompt, /Works for any user theme/);
  assert.doesNotMatch(prompt.toLowerCase(), /megadeth|taylor swift|bariloche/);
});

test("parser validates exact positions, lengths, duplicates, and theme answers", () => {
  const parsed = parseCspConstraintTopUpResponse11(
    JSON.stringify({
      groups: [
        {
          requestId: "len6-p1A",
          answers: ["BARELY", "WRONG", "BANANA", "THEME1", "BARELY"],
        },
      ],
    }),
    {
      theme: "theme1",
      language: "en",
      excludedAnswers: [],
      attempt: 1,
      requests: [{ requestId: "len6-p1A", length: 6, constraints: [{ position: 1, requiredLetter: "A" }], count: 8 }],
    }
  );

  assert.deepEqual(parsed.candidates.map((candidate) => candidate.answer), ["BARELY", "BANANA"]);
  assert.equal(parsed.rejectedByReason["wrong-length"], 1);
  assert.equal(parsed.rejectedByReason["theme-answer"], 1);
  assert.equal(parsed.rejectedByReason.duplicate, 1);
});

test("parser validates allowed letters at exact positions", () => {
  const parsed = parseCspConstraintTopUpResponse11(
    JSON.stringify({
      groups: [{ requestId: "len4-p2D", answers: ["NODE", "NOXE"] }],
    }),
    {
      theme: "topic",
      language: "en",
      excludedAnswers: [],
      attempt: 1,
      requests: [{ requestId: "len4-p2D", length: 4, constraints: [{ position: 2, allowedLetters: ["D"] }], count: 4 }],
    }
  );

  assert.deepEqual(parsed.candidates.map((candidate) => candidate.answer), ["NODE"]);
  assert.equal(parsed.rejectedByReason["position-mismatch"], 1);
});

test("requestCspConstraintTopUpAnswers11 uses injected completion callback", async () => {
  const parsed = await requestCspConstraintTopUpAnswers11({
    theme: "topic",
    language: "en",
    excludedAnswers: [],
    attempt: 2,
    requests: [{ requestId: "len4-p0N", length: 4, constraints: [{ position: 0, requiredLetter: "N" }], count: 4 }],
    completeJson: async (prompt) => {
      assert.match(prompt, /len4-p0N/);
      return JSON.stringify({ groups: [{ requestId: "len4-p0N", answers: ["NODE"] }] });
    },
  });

  assert.deepEqual(parsed.candidates, [{ answer: "NODE", thematic: true, source: "model" }]);
});
