import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CSP_PATTERN_11, type CspCandidate } from "./crosswordCsp11";
import { analyzeCspCompatibility11 } from "./analyzeCspCompatibility11";
import type { CrosswordPattern11 } from "./crosswordPatterns11";

const pattern: CrosswordPattern11 = { id: "default-open", rows: DEFAULT_CSP_PATTERN_11 };

function candidatesWithFixedPositions(position0: string, position5: string): CspCandidate[] {
  return Array.from({ length: 6 }, (_, index) => ({
    answer: `${position0}${String.fromCharCode(67 + index)}DEF${position5}GHIJK`,
    thematic: true,
    source: "test",
  }));
}

test("detects intersections with zero compatible pairs", () => {
  const analysis = analyzeCspCompatibility11({
    pattern,
    candidates: candidatesWithFixedPositions("B", "A"),
  });

  assert.ok(analysis.zeroCompatibilityIntersections.length > 0);
  assert.ok(
    analysis.zeroCompatibilityIntersections.some(
      (intersection) =>
        (intersection.positionA === 5 && intersection.positionB === 0) ||
        (intersection.positionA === 0 && intersection.positionB === 5)
    )
  );
});

test("calculates shared letters and compatible pair counts deterministically", () => {
  const first = analyzeCspCompatibility11({
    pattern,
    candidates: [
      { answer: "ABCDEAABCDE", thematic: true },
      { answer: "BBCDEAABCDF", thematic: true },
      { answer: "CBCDEAABCDG", thematic: true },
    ],
  });
  const second = analyzeCspCompatibility11({
    pattern,
    candidates: [
      { answer: "CBCDEAABCDG", thematic: true },
      { answer: "ABCDEAABCDE", thematic: true },
      { answer: "BBCDEAABCDF", thematic: true },
    ],
  });

  const target = first.intersections.find(
    (intersection) => intersection.positionA === 5 && intersection.positionB === 0
  );
  assert.ok(target);
  assert.ok(target.compatiblePairCount > 0);
  assert.deepEqual(target.lettersInCommon, ["A"]);
  assert.deepEqual(first.zeroCompatibilityIntersections, second.zeroCompatibilityIntersections);
  assert.equal(first.patternCompatibilityScore, second.patternCompatibilityScore);
});

test("reports letter coverage by position", () => {
  const analysis = analyzeCspCompatibility11({
    pattern,
    candidates: [
      { answer: "ABCDEAABCDE", thematic: true },
      { answer: "BBCDEAABCDF", thematic: true },
    ],
  });
  const a1 = analysis.slots.find((slot) => slot.slotId === "A1");

  assert.ok(a1);
  assert.deepEqual(a1.letterCoverageByPosition[0], { A: 1, B: 1 });
  assert.deepEqual(a1.letterCoverageByPosition[5], { A: 2 });
});
