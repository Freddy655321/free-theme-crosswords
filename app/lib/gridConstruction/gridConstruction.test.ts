import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canPlaceWord,
  extractPatternSlots,
  makeEmptyWorkingGrid,
  placeWordWithPolicies,
} from "./gridConstruction";

const policies = {
  isForbiddenPublishAnswer: () => false,
};

describe("gridConstruction", () => {
  it("creates an empty mutable working grid", () => {
    const grid = makeEmptyWorkingGrid(3);

    assert.deepEqual(grid, [
      ["", "", ""],
      ["", "", ""],
      ["", "", ""],
    ]);

    grid[0][0] = "A";
    assert.equal(grid[0][0], "A");
    assert.equal(grid[1][0], "");
  });

  it("places a valid word and reports changed cells", () => {
    const grid = makeEmptyWorkingGrid(5);
    const changes = placeWordWithPolicies(grid, "ALPHA", 0, 0, "across", policies);

    assert.deepEqual(grid[0], ["A", "L", "P", "H", "A"]);
    assert.deepEqual(changes, [
      { r: 0, c: 0, prev: "" },
      { r: 0, c: 1, prev: "" },
      { r: 0, c: 2, prev: "" },
      { r: 0, c: 3, prev: "" },
      { r: 0, c: 4, prev: "" },
    ]);
  });

  it("rejects conflicts before mutating", () => {
    const grid = makeEmptyWorkingGrid(5);
    grid[0][0] = "B";

    assert.deepEqual(canPlaceWord(grid, "ALPHA", 0, 0, "across"), {
      ok: false,
      crossings: 0,
      reason: "letter_conflict",
    });
    assert.equal(placeWordWithPolicies(grid, "ALPHA", 0, 0, "across", policies), null);
    assert.equal(grid[0][0], "B");
  });

  it("rejects forbidden derived answers and rolls back", () => {
    const grid = makeEmptyWorkingGrid(5);
    const changes = placeWordWithPolicies(grid, "ALPHA", 0, 0, "across", {
      isForbiddenPublishAnswer: (answer) => answer === "ALPHA",
    });

    assert.equal(changes, null);
    assert.deepEqual(grid[0], ["", "", "", "", ""]);
  });

  it("extracts across slots before down slots with current length thresholds", () => {
    const pattern = [
      ".....",
      "##.##",
      ".....",
      "##.##",
      ".....",
    ];

    assert.deepEqual(extractPatternSlots(pattern), [
      {
        row: 0,
        col: 0,
        direction: "across",
        len: 5,
        cells: Array.from({ length: 5 }, (_, c) => ({ r: 0, c })),
      },
      {
        row: 2,
        col: 0,
        direction: "across",
        len: 5,
        cells: Array.from({ length: 5 }, (_, c) => ({ r: 2, c })),
      },
      {
        row: 4,
        col: 0,
        direction: "across",
        len: 5,
        cells: Array.from({ length: 5 }, (_, c) => ({ r: 4, c })),
      },
      {
        row: 0,
        col: 2,
        direction: "down",
        len: 5,
        cells: Array.from({ length: 5 }, (_, r) => ({ r, c: 2 })),
      },
    ]);
  });
});
