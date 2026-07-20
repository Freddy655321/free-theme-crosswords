import assert from "node:assert/strict";
import test from "node:test";

import { adaptCandidatesForCsp11, normalizeCspAnswer11 } from "./crosswordCspAdapter11";

test("adapter normalizes, deduplicates, blocks theme answer, and excludes filler", () => {
  const adapted = adaptCandidatesForCsp11({
    theme: "Test Theme",
    candidates: [
      { answer: " café ", thematic: true, source: "model" },
      { answer: "CAFE", thematic: false, source: "support" },
      { answer: "TESTTHEME", thematic: true, source: "model" },
      { answer: "AB", thematic: true, source: "model" },
      { answer: "FILL", thematic: false, source: "filler" },
      { answer: "TRAIL", thematic: false, source: "support" },
    ],
  });

  assert.deepEqual(adapted.candidates.map((candidate) => candidate.answer), ["CAFE", "TRAIL"]);
  assert.equal(adapted.candidates.find((candidate) => candidate.answer === "CAFE")?.thematic, true);
  assert.equal(adapted.stats.rejectedByReason["theme-answer"], 1);
  assert.equal(adapted.stats.rejectedByReason["incompatible-length"], 1);
  assert.equal(adapted.stats.rejectedByReason["generic-filler"], 1);
  assert.equal(adapted.stats.rejectedByReason.duplicate, 1);
});

test("adapter reports length statistics for thematic and support candidates", () => {
  const adapted = adaptCandidatesForCsp11({
    theme: "anything",
    candidates: [
      { answer: "ALPHA", thematic: true, source: "model" },
      { answer: "BETA", thematic: false, source: "support" },
      { answer: "GAMMA", thematic: false, source: "support" },
      { answer: "DELTA", thematic: true, source: "anchor" },
    ],
  });

  assert.equal(adapted.stats.totalByLength[4], 1);
  assert.equal(adapted.stats.totalByLength[5], 3);
  assert.equal(adapted.stats.thematicByLength[5], 2);
  assert.equal(adapted.stats.supportByLength[4], 1);
  assert.equal(adapted.stats.supportByLength[5], 1);
});

test("normalizeCspAnswer11 keeps only A-Z and digits", () => {
  assert.equal(normalizeCspAnswer11(" Río-42! "), "RIO42");
});
