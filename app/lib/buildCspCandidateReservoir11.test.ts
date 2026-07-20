import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCspCandidateReservoir11,
  cspRequiredLengthsFromPatterns11,
  type CspReservoirInputCandidate11,
} from "./buildCspCandidateReservoir11";
import { CROSSWORD_PATTERNS_11 } from "./crosswordPatterns11";

function candidate(
  answer: string,
  source: CspReservoirInputCandidate11["source"] = "model",
  thematic = true
): CspReservoirInputCandidate11 {
  return { answer, source, thematic };
}

test("reservoir excludes filler, support, the exact theme, and duplicates", () => {
  const thematicKeep = new Set(["ABLE", "BETA", "DELTA"]);
  const result = buildCspCandidateReservoir11({
    theme: "delta",
    thematicKeep,
    requiredLengths: [4, 5, 6, 7, 8],
    candidates: [
      candidate("ABLE"),
      candidate("ABLE"),
      candidate("BETA", "filler", false),
      candidate("ALOE", "support", true),
      candidate("DELTA"),
    ],
  });

  assert.deepEqual(result.candidates.map((item) => item.answer), ["ABLE"]);
  assert.equal(result.excluded.filter((item) => item.reason === "duplicate").length, 1);
  assert.equal(result.excluded.filter((item) => item.reason === "unsupported-source").length, 1);
  assert.equal(result.excluded.filter((item) => item.reason === "not-thematic").length, 1);
  assert.equal(result.excluded.filter((item) => item.reason === "exact-theme").length, 1);
});

test("reservoir conserves valid candidates across required lengths without a small global cap", () => {
  const candidates = Array.from({ length: 50 }, (_, index) => candidate(`A${String(index).padStart(3, "0")}`));
  const thematicKeep = new Set(candidates.map((item) => item.answer));
  const result = buildCspCandidateReservoir11({
    theme: "sample",
    thematicKeep,
    requiredLengths: [4],
    candidates,
  });

  assert.equal(result.candidates.length, 50);
  assert.equal(result.distributionByLength[4], 50);
  assert.equal(result.excluded.some((item) => item.reason === "per-length-cap"), false);
});

test("reservoir is deterministic and orders anchor before model, then length and alphabetically", () => {
  const result = buildCspCandidateReservoir11({
    theme: "sample",
    thematicKeep: new Set(["BRAVO", "ABLE", "BETA", "ALPHA"]),
    requiredLengths: [4, 5],
    candidates: [
      candidate("BRAVO"),
      candidate("BETA"),
      candidate("ALPHA", "anchor"),
      candidate("ABLE"),
    ],
  });

  assert.deepEqual(result.candidates.map((item) => item.answer), ["ALPHA", "ABLE", "BETA", "BRAVO"]);
});

test("reservoir reports exclusion reasons for invalid characters, lengths, and thematic keep", () => {
  const result = buildCspCandidateReservoir11({
    theme: "sample",
    thematicKeep: new Set(["GOOD"]),
    requiredLengths: [4],
    candidates: [
      candidate(""),
      candidate("AB"),
      candidate("ABCDEFGHIJKL"),
      candidate("THREE"),
      candidate("MISS"),
      candidate("GOOD"),
    ],
  });

  assert.deepEqual(result.candidates.map((item) => item.answer), ["GOOD"]);
  assert.equal(result.excluded.some((item) => item.reason === "empty"), true);
  assert.equal(result.excluded.some((item) => item.reason === "too-short"), true);
  assert.equal(result.excluded.some((item) => item.reason === "too-long"), true);
  assert.equal(result.excluded.some((item) => item.reason === "incompatible-length"), true);
  assert.equal(result.excluded.some((item) => item.reason === "not-in-thematic-keep"), true);
});

test("legacy pool losing length four does not affect the CSP reservoir", () => {
  const rawPool = [
    candidate("MOON"),
    candidate("MARS"),
    candidate("STAR"),
    candidate("ORBIT"),
    candidate("ROCKET"),
  ];
  const legacyPool = rawPool.filter((item) => item.answer.length !== 4);
  const reservoir = buildCspCandidateReservoir11({
    theme: "space exploration",
    thematicKeep: new Set(rawPool.map((item) => item.answer)),
    requiredLengths: [4, 5, 6],
    candidates: rawPool,
  });

  assert.equal(legacyPool.some((item) => item.answer.length === 4), false);
  assert.equal(reservoir.distributionByLength[4], 3);
});

test("top-up candidates can be appended to the reservoir input without legacy selection", () => {
  const initial = [candidate("ORBIT")];
  const topUp = [candidate("MOON"), candidate("MARS")];
  const result = buildCspCandidateReservoir11({
    theme: "space exploration",
    thematicKeep: new Set([...initial, ...topUp].map((item) => item.answer)),
    requiredLengths: [4, 5],
    candidates: [...initial, ...topUp],
  });

  assert.deepEqual(result.distributionByLength, { 4: 2, 5: 1 });
});

test("required lengths can be derived from the productive CSP patterns", () => {
  assert.deepEqual(cspRequiredLengthsFromPatterns11(CROSSWORD_PATTERNS_11), [4, 5, 6, 7, 8]);
});
