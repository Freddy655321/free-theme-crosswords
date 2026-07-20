import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHybridCspCandidateReservoir11,
  loadLocalSupportCandidates11,
} from "./buildHybridCspCandidateReservoir11";

test("hybrid reservoir keeps thematic and support candidates explicitly separated", () => {
  const result = buildHybridCspCandidateReservoir11({
    theme: "sample",
    requiredLengths: [4, 5],
    thematicCandidates: [
      { answer: "ALPHA", thematic: true, source: "model" },
      { answer: "SAMPLE", thematic: true, source: "model" },
      { answer: "BETA", thematic: false, source: "model" },
    ],
    supportCandidates: [
      { answer: "ABLE", thematic: false, source: "local-support" },
      { answer: "ALPHA", thematic: false, source: "local-support" },
      { answer: "WITH", thematic: false, source: "local-support" },
      { answer: "STONE", thematic: false, source: "local-support" },
    ],
  });

  const alpha = result.candidates.find((candidate) => candidate.answer === "ALPHA");
  const able = result.candidates.find((candidate) => candidate.answer === "ABLE");
  assert.equal(alpha?.kind, "thematic");
  assert.equal(alpha?.thematic, true);
  assert.equal(able?.kind, "support");
  assert.equal(able?.thematic, false);
  assert.equal(result.candidates.some((candidate) => candidate.answer === "SAMPLE"), false);
  assert.equal(result.candidates.some((candidate) => candidate.answer === "BETA"), false);
  assert.ok((result.excludedSupportByReason["duplicate-or-thematic"] ?? 0) >= 1);
  assert.ok((result.excludedSupportByReason["weak-or-invalid-support"] ?? 0) >= 1);
});

test("local support candidates come only from authorized local dictionaries and required lengths", () => {
  const support = loadLocalSupportCandidates11({
    language: "en",
    requiredLengths: [4, 5],
    limitPerLength: 5,
  });

  assert.ok(support.length > 0);
  assert.ok(support.every((candidate) => candidate.kind === "support"));
  assert.ok(support.every((candidate) => candidate.thematic === false));
  assert.ok(support.every((candidate) => candidate.source === "local-frequency-en"));
  assert.ok(support.every((candidate) => candidate.answer.length === 4 || candidate.answer.length === 5));
});
