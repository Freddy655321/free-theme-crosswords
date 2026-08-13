import assert from "node:assert/strict";
import test from "node:test";

import { pickPoolForSize } from "./pickPoolForSize";
import type { WordCandidate } from "@/app/lib/crosswordTypes";

function candidate(answer: string): WordCandidate {
  return { answer, source: "model", thematic: true };
}

test("pickPoolForSize returns the original array for non-11 sizes", () => {
  const items = [candidate("ALPHA"), candidate("BRAVO")];
  const out = pickPoolForSize(items, {
    size: 9,
    placementCoreThemeSet: new Set(["ALPHA"]),
    minEntryLenForSize: () => 3,
  });

  assert.equal(out, items);
});

test("pickPoolForSize preserves current 11x11 length-band ordering and cap", () => {
  const items = [
    candidate("AAA"),
    candidate("BBBB"),
    candidate("CCCCC"),
    candidate("DDDDDD"),
    candidate("EEEEEEE"),
    candidate("FFFFFFFF"),
    candidate("GGGGGGGGG"),
    candidate("HHHHHHHHHH"),
    candidate("IIIIIIIIIII"),
    candidate("JJJJ"),
  ];
  const placementCoreThemeSet = new Set(items.map((item) => item.answer));

  const out = pickPoolForSize(items, {
    size: 11,
    placementCoreThemeSet,
    minEntryLenForSize: () => 3,
  });

  assert.deepEqual(
    out.map((item) => item.answer),
    [
      "IIIIIIIIIII",
      "HHHHHHHHHH",
      "GGGGGGGGG",
      "FFFFFFFF",
      "EEEEEEE",
      "DDDDDD",
      "CCCCC",
      "BBBB",
      "JJJJ",
      "AAA",
    ]
  );
});

test("pickPoolForSize filters to thematic core answers for 11x11", () => {
  const items = [candidate("ALPHA"), candidate("BRAVO"), candidate("CHARLIE")];
  const out = pickPoolForSize(items, {
    size: 11,
    placementCoreThemeSet: new Set(["BRAVO"]),
    minEntryLenForSize: () => 3,
  });

  assert.deepEqual(out.map((item) => item.answer), ["BRAVO"]);
});
