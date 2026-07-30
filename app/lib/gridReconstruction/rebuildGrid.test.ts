import assert from "node:assert/strict";
import test from "node:test";
import type { DerivedEntry, Entry } from "@/app/lib/crosswordTypes";
import {
  rebuildExactFullyCheckedPublishableCrossword,
  rebuildExactPublishableCrossword,
  rebuildFullyCheckedPublishableCrossword,
  rebuildGridFromAllowedEntries,
  rebuildGridFromEntries,
  rebuildGridFromEntriesAllowingAllowedDerived,
  rebuildNoShortRunPublishableCrossword,
  rebuildPlayableCrossword,
  rebuildSanitizedFullyCheckedPublishableCrossword,
} from "./rebuildGrid";
import type { GridReconstructionPolicies } from "./gridReconstructionTypes";

const policies: GridReconstructionPolicies = {
  applyCluesAndOverrides: (_theme, _language, derived, clueByAnswer) =>
    derived.map((entry) => ({
      ...entry,
      clue: clueByAnswer.get(entry.answer) ?? `${entry.answer.toLowerCase()} clue`,
    })),
  isAlwaysAllowedAnswer: (answer) => answer === "ODD",
  isLikelyBadAnswer: (answer) => answer === "BAD",
  isOverGenericThemeWordForTheme: (_theme, answer) => answer === "GENERIC",
  isPlaceholderClue: (clue) => clue === "placeholder",
  specificThematicFallbackClue: (_theme, answer) => (answer === "THEME" ? "theme clue" : null),
};

function entry(
  number: number,
  row: number,
  col: number,
  direction: "across" | "down",
  answer: string,
  clue = `${answer.toLowerCase()} clue`
): Entry {
  return { number, row, col, direction, answer, clue };
}

function derived(
  number: number,
  row: number,
  col: number,
  direction: "across" | "down",
  answer: string
): DerivedEntry {
  return { number, row, col, direction, answer };
}

test("rebuildGridFromEntries rebuilds a valid crossed grid with stable order", () => {
  const input = [
    derived(1, 1, 0, "across", "CAT"),
    derived(2, 0, 1, "down", "BAT"),
  ];

  const result = rebuildGridFromEntries(5, input, 3);

  assert.deepEqual(result?.grid, [
    ["#", "B", "#", "#", "#"],
    ["C", "A", "T", "#", "#"],
    ["#", "T", "#", "#", "#"],
    ["#", "#", "#", "#", "#"],
    ["#", "#", "#", "#", "#"],
  ]);
  assert.deepEqual(result?.derived, input);
});

test("rebuildGridFromEntries returns null for empty, conflict, and out of bounds inputs", () => {
  assert.equal(rebuildGridFromEntries(5, [], 3), null);
  assert.equal(
    rebuildGridFromEntries(5, [
      derived(1, 1, 0, "across", "CAT"),
      derived(2, 0, 1, "down", "BIT"),
    ], 3),
    null
  );
  assert.equal(rebuildGridFromEntries(5, [derived(1, 0, 3, "across", "CAT")], 3), null);
});

test("rebuildGridFromAllowedEntries preserves allowlist semantics", () => {
  const grid = [
    ["#", "B", "#", "#", "#"],
    ["C", "A", "T", "#", "#"],
    ["#", "T", "#", "#", "#"],
    ["#", "#", "#", "#", "#"],
    ["#", "#", "#", "#", "#"],
  ];

  assert.deepEqual(rebuildGridFromAllowedEntries(grid, new Set(["CAT", "BAT"]), 3)?.derived, [
    derived(1, 1, 0, "across", "CAT"),
    derived(2, 0, 1, "down", "BAT"),
  ]);
  assert.equal(rebuildGridFromAllowedEntries(grid, new Set(["DOG"]), 3), null);
});

test("rebuildGridFromEntriesAllowingAllowedDerived accepts derived entries by answer", () => {
  const entries = [derived(1, 1, 0, "across", "CAT")];

  assert.deepEqual(
    rebuildGridFromEntriesAllowingAllowedDerived(5, entries, 3, new Set(["CAT"]))?.derived,
    entries
  );
  assert.equal(rebuildGridFromEntriesAllowingAllowedDerived(5, entries, 3, new Set(["DOG"])), null);
});

test("rebuilds across-only and down-only grids", () => {
  assert.deepEqual(rebuildGridFromEntries(5, [derived(1, 2, 1, "across", "DOG")], 3)?.derived, [
    derived(1, 2, 1, "across", "DOG"),
  ]);
  assert.deepEqual(rebuildGridFromEntries(5, [derived(1, 1, 2, "down", "DOG")], 3)?.derived, [
    derived(1, 1, 2, "down", "DOG"),
  ]);
});

test("input entries and returned snapshots are independent", () => {
  const input = [derived(1, 1, 0, "across", "CAT")];
  const before = structuredClone(input);
  const first = rebuildGridFromEntries(5, input, 3);
  const second = rebuildGridFromEntries(5, input, 3);

  assert.deepEqual(input, before);
  assert.deepEqual(first, second);
  if (!first || !second) throw new Error("expected rebuild result");
  first.grid[1][0] = "Z";
  assert.equal(second.grid[1][0], "C");
});

test("publishable rebuilds preserve clues and reject placeholder/generic answers", () => {
  const entries = [
    entry(1, 1, 0, "across", "CAT", "animal clue"),
    entry(2, 0, 1, "down", "BAT", "flying clue"),
    entry(3, 3, 0, "across", "GENERIC", "generic clue"),
    entry(4, 4, 0, "across", "DOG", "placeholder"),
  ];

  const playable = rebuildPlayableCrossword("theme", 7, entries, "en", new Set(["CAT", "BAT", "GENERIC", "DOG"]), policies);

  assert.deepEqual(playable?.entries.map((item) => [item.answer, item.clue]), [
    ["CAT", "animal clue"],
    ["BAT", "flying clue"],
  ]);
});

test("exact publishable rebuild drops entries until a valid subset remains", () => {
  const entries = [
    entry(1, 1, 0, "across", "CAT", "cat clue"),
    entry(2, 0, 1, "down", "BAT", "bat clue"),
    entry(3, 4, 0, "across", "DOG", "placeholder"),
  ];

  const result = rebuildExactPublishableCrossword("theme", 7, entries, "en", new Set(["CAT", "BAT", "DOG"]), policies, 2);

  assert.deepEqual(result?.entries.map((item) => item.answer), ["CAT", "BAT"]);
});

test("fully checked rebuild accepts checked grids and rejects unchecked grids", () => {
  const checkedGrid = [
    ["A", "B", "C", "#", "#"],
    ["D", "E", "F", "#", "#"],
    ["G", "H", "I", "#", "#"],
    ["#", "#", "#", "#", "#"],
    ["#", "#", "#", "#", "#"],
  ];
  const uncheckedGrid = [
    ["#", "#", "#", "#", "#"],
    ["C", "A", "T", "#", "#"],
    ["#", "#", "#", "#", "#"],
    ["#", "#", "#", "#", "#"],
    ["#", "#", "#", "#", "#"],
  ];
  const clueByAnswer = new Map([
    ["ABC", "abc clue"],
    ["DEF", "def clue"],
    ["GHI", "ghi clue"],
    ["ADG", "adg clue"],
    ["BEH", "beh clue"],
    ["CFI", "cfi clue"],
  ]);

  assert.deepEqual(
    rebuildFullyCheckedPublishableCrossword(
      "theme",
      5,
      checkedGrid,
      "en",
      new Set(["ABC", "DEF", "GHI", "ADG", "BEH", "CFI"]),
      clueByAnswer,
      policies,
      6
    )?.entries.map((item) => item.answer),
    ["ABC", "DEF", "GHI", "ADG", "BEH", "CFI"]
  );
  assert.equal(
    rebuildFullyCheckedPublishableCrossword("theme", 5, uncheckedGrid, "en", new Set(["CAT"]), clueByAnswer, policies, 1),
    null
  );
});

test("sanitized fully checked path uses sanitizeUncheckedGrid before rebuilding", () => {
  const grid = [
    ["A", "B", "C", "#", "#"],
    ["D", "E", "F", "#", "#"],
    ["G", "H", "I", "#", "#"],
    ["#", "#", "#", "#", "#"],
    ["#", "#", "#", "#", "#"],
  ];
  const result = rebuildSanitizedFullyCheckedPublishableCrossword(
    "theme",
    5,
    grid,
    "en",
    new Set(["ABC", "DEF", "GHI", "ADG", "BEH", "CFI"]),
    new Map([
      ["ABC", "abc clue"],
      ["DEF", "def clue"],
      ["GHI", "ghi clue"],
      ["ADG", "adg clue"],
      ["BEH", "beh clue"],
      ["CFI", "cfi clue"],
    ]),
    policies,
    6
  );

  assert.deepEqual(result?.entries.map((item) => item.answer), ["ABC", "DEF", "GHI", "ADG", "BEH", "CFI"]);
});

test("exact fully checked rebuild requires every letter to be checked", () => {
  const entries = [
    entry(1, 0, 0, "across", "ABC", "abc clue"),
    entry(2, 1, 0, "across", "DEF", "def clue"),
    entry(3, 2, 0, "across", "GHI", "ghi clue"),
    entry(4, 0, 0, "down", "ADG", "adg clue"),
    entry(5, 0, 1, "down", "BEH", "beh clue"),
    entry(6, 0, 2, "down", "CFI", "cfi clue"),
  ];

  assert.deepEqual(
    rebuildExactFullyCheckedPublishableCrossword(
      "theme",
      5,
      entries,
      "en",
      new Set(["ABC", "DEF", "GHI", "ADG", "BEH", "CFI"]),
      policies,
      6
    )?.entries.map((item) => item.answer),
    ["ABC", "DEF", "GHI", "ADG", "BEH", "CFI"]
  );
  assert.equal(
    rebuildExactFullyCheckedPublishableCrossword("theme", 5, [entry(1, 1, 0, "across", "CAT", "cat clue")], "en", new Set(["CAT"]), policies, 1),
    null
  );
});

test("no-short-run publishable rebuild is deterministic and rejects weak subsets", () => {
  const entries = [
    entry(1, 0, 0, "across", "ABC", "abc clue"),
    entry(2, 1, 0, "across", "DEF", "def clue"),
    entry(3, 2, 0, "across", "GHI", "ghi clue"),
    entry(4, 0, 0, "down", "ADG", "adg clue"),
    entry(5, 0, 1, "down", "BEH", "beh clue"),
    entry(6, 0, 2, "down", "CFI", "cfi clue"),
  ];
  const thematic = new Set(["ABC", "DEF", "GHI", "ADG", "BEH", "CFI"]);

  const first = rebuildNoShortRunPublishableCrossword("theme", 5, entries, "en", thematic, 6, 6, policies);
  const second = rebuildNoShortRunPublishableCrossword("theme", 5, entries, "en", thematic, 6, 6, policies);

  assert.deepEqual(first, second);
  assert.deepEqual(first?.entries.map((item) => item.answer), ["ABC", "DEF", "GHI", "ADG", "BEH", "CFI"]);
  assert.equal(rebuildNoShortRunPublishableCrossword("theme", 5, entries, "en", thematic, 7, 7, policies), null);
});

test("size 9, 11, and 13 rebuilds keep size behavior", () => {
  for (const size of [9, 11, 13]) {
    const result = rebuildGridFromEntries(size, [derived(1, 1, 1, "across", "ALPHA")], 3);
    assert.equal(result?.grid.length, size);
    assert.equal(result?.grid[0].length, size);
    assert.deepEqual(result?.derived, [derived(1, 1, 1, "across", "ALPHA")]);
  }
});
