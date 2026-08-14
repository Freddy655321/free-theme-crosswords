import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WordCandidate } from "@/app/lib/crosswordTypes";
import { deriveEntriesFromGrid } from "@/app/lib/publishPipeline";
import {
  augmentNoShortGridWithCandidates,
  densifyCleanGrid11,
  extendGridWithCrossedPair11,
} from "./gridEnhancement";
import type { GridEnhancementDependencies } from "./gridEnhancementTypes";

function cloneGrid(grid: string[][]): string[][] {
  return grid.map((row) => row.slice());
}

function emptyGrid(size = 11): string[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => "#"));
}

function withAcross(grid: string[][], row: number, col: number, word: string): string[][] {
  const next = cloneGrid(grid);
  for (let i = 0; i < word.length; i++) next[row][col + i] = word[i];
  return next;
}

function withDown(grid: string[][], row: number, col: number, word: string): string[][] {
  const next = cloneGrid(grid);
  for (let i = 0; i < word.length; i++) next[row + i][col] = word[i];
  return next;
}

function makeDependencies(forbidden = new Set<string>()): GridEnhancementDependencies & {
  logs: unknown[][];
} {
  const logs: unknown[][] = [];
  return {
    isForbiddenPublishAnswer: (answer) => forbidden.has(answer),
    isOverGenericThemeWordForTheme: (_theme, answer) => answer === "GENERIC",
    logger: {
      warn: (...args: unknown[]) => {
        logs.push(args);
      },
    },
    logs,
  };
}

function candidates(answers: Array<[string, boolean?, WordCandidate["source"]?]>): WordCandidate[] {
  return answers.map(([answer, thematic = true, source = "model"]) => ({
    answer,
    thematic,
    source,
  }));
}

describe("gridEnhancement", () => {
  it("densifies a weak grid with a crossing candidate", () => {
    const deps = makeDependencies();
    const grid = withAcross(emptyGrid(), 5, 3, "ABCDE");
    const result = densifyCleanGrid11({
      theme: "Neutral",
      grid,
      candidates: candidates([["XCY"]]),
      targetEntries: 2,
      seed: 123,
      pruneWeakEntries: false,
      dependencies: deps,
    });

    assert.ok(result);
    assert.deepEqual(result.added, ["XCY"]);
    assert.equal(result.meta.densifier, "clean-grid-11");
    assert.equal(grid[4][5], "#");
    assert.equal(result.grid[4][5], "X");
    assert.equal(deps.logs.at(-1)?.[0], "[densify-11] completed");
  });

  it("densify returns null for no-op candidate sets", () => {
    const result = densifyCleanGrid11({
      theme: "Neutral",
      grid: withAcross(emptyGrid(), 5, 3, "ABCDE"),
      candidates: [],
      targetEntries: 2,
      seed: 123,
      dependencies: makeDependencies(),
    });

    assert.equal(result, null);
  });

  it("densify preserves deterministic results for the same seed", () => {
    const grid = withAcross(emptyGrid(), 5, 3, "ABCDE");
    const input = {
      theme: "Neutral",
      grid,
      candidates: candidates([["XCY"], ["ZCW"]]),
      targetEntries: 2,
      pruneWeakEntries: false,
    };

    const one = densifyCleanGrid11({ ...input, seed: 999, dependencies: makeDependencies() });
    const two = densifyCleanGrid11({ ...input, seed: 999, dependencies: makeDependencies() });

    assert.deepEqual(one, two);
  });

  it("densify keeps second-seed behavior deterministic", () => {
    const grid = withAcross(emptyGrid(), 5, 3, "ABCDE");
    const result = densifyCleanGrid11({
      theme: "Neutral",
      grid,
      candidates: candidates([["XCY"], ["ZCW"]]),
      targetEntries: 2,
      seed: 1000,
      pruneWeakEntries: false,
      dependencies: makeDependencies(),
    });

    assert.ok(result === null || Array.isArray(result.added));
  });

  it("uses the existing expired-deadline fallback behavior", () => {
    const result = densifyCleanGrid11({
      theme: "Neutral",
      grid: withAcross(emptyGrid(), 5, 3, "ABCDE"),
      candidates: candidates([["XCY"]]),
      targetEntries: 2,
      seed: 123,
      deadlineMs: 1,
      pruneWeakEntries: false,
      dependencies: makeDependencies(),
    });

    assert.ok(result);
  });

  it("augment returns an already valid grid", () => {
    const deps = makeDependencies();
    const grid = [
      ["A", "B", "C"],
      ["D", "E", "F"],
      ["G", "H", "I"],
    ];

    const result = augmentNoShortGridWithCandidates(grid, candidates([["XYZ"]]), 3, 6, 6, deps);

    assert.ok(result);
    assert.deepEqual(result.grid, grid);
    assert.equal(result.derived.length, 6);
  });

  it("augment returns null for no-op empty candidates", () => {
    const result = augmentNoShortGridWithCandidates(emptyGrid(5), [], 3, 2, 2, makeDependencies());

    assert.equal(result, null);
  });

  it("augment rejects short-run outcomes", () => {
    const grid = withAcross(emptyGrid(5), 2, 1, "CAT");
    const result = augmentNoShortGridWithCandidates(
      grid,
      candidates([["A"]]),
      3,
      2,
      2,
      makeDependencies()
    );

    assert.equal(result, null);
  });

  it("augment rejects conflicting placements", () => {
    const grid = withAcross(emptyGrid(5), 2, 1, "CAT");
    const result = augmentNoShortGridWithCandidates(
      grid,
      candidates([["DOG"]]),
      3,
      2,
      2,
      makeDependencies()
    );

    assert.equal(result, null);
  });

  it("augment honors dependency injection for forbidden answers", () => {
    const grid = [
      ["A", "B", "C"],
      ["D", "E", "F"],
      ["G", "H", "I"],
    ];
    const result = augmentNoShortGridWithCandidates(grid, [], 3, 6, 6, makeDependencies(new Set(["ABC"])));

    assert.equal(result, null);
  });

  it("crossed-pair returns null when target is already reached", () => {
    const grid = withAcross(emptyGrid(), 5, 3, "ABCDE");
    const result = extendGridWithCrossedPair11({
      grid,
      candidates: candidates([["BMX"], ["QMR"]]),
      targetEntries: 1,
      seed: 1,
      dependencies: makeDependencies(),
    });

    assert.equal(result, null);
  });

  it("crossed-pair returns null when no pair can be placed", () => {
    const result = extendGridWithCrossedPair11({
      grid: withAcross(emptyGrid(), 5, 3, "ABCDE"),
      candidates: candidates([["XYZ"], ["PQR"]]),
      targetEntries: 3,
      seed: 1,
      dependencies: makeDependencies(),
    });

    assert.equal(result, null);
  });

  it("crossed-pair adds a deterministic crossing pair", () => {
    let grid = emptyGrid();
    grid = withAcross(grid, 1, 1, "ABC");
    grid = withAcross(grid, 3, 1, "DEF");
    grid = withAcross(grid, 5, 1, "GHI");
    grid = withDown(grid, 1, 1, "ADG");
    grid = withDown(grid, 1, 2, "BEH");
    const before = cloneGrid(grid);

    const result = extendGridWithCrossedPair11({
      grid,
      candidates: candidates([
        ["ABC"],
        ["DEF"],
        ["GHI"],
        ["ADG"],
        ["BEH"],
        ["CFI"],
        ["AEI"],
        ["CEG"],
        ["ABA"],
        ["BAB"],
        ["CAC"],
        ["DAD"],
        ["EAE"],
        ["FAF"],
        ["GAG"],
        ["HAH"],
        ["IAI"],
        ["AXA"],
        ["XBX"],
        ["CXC"],
        ["DXD"],
        ["XEX"],
        ["FXF"],
        ["GXG"],
        ["HXH"],
        ["IXI"],
        ["JKL"],
        ["JXJ"],
        ["KXK"],
        ["LXL"],
        ["MNO"],
        ["MXM"],
        ["NXN"],
        ["OXO"],
      ]),
      targetEntries: 7,
      seed: 1,
      dependencies: makeDependencies(),
    });

    assert.ok(result);
    assert.deepEqual(result.addedAnswers, ["AXA", "HAH"]);
    assert.deepEqual(result.derived.map((entry) => entry.answer), [
      "ABC",
      "GHF",
      "AXA",
      "GHI",
      "GXG",
      "HAH",
    ]);
    assert.deepEqual(grid, before);
    assert.notDeepEqual(result.grid, before);
  });

  it("crossed-pair rejects conflicting pair placement", () => {
    let grid = withAcross(emptyGrid(), 5, 3, "ABCDE");
    grid = withDown(grid, 4, 5, "ZCZ");
    const result = extendGridWithCrossedPair11({
      grid,
      candidates: candidates([["XCY"], ["ZCW"]]),
      targetEntries: 5,
      seed: 42,
      dependencies: makeDependencies(),
    });

    assert.equal(result, null);
  });

  it("crossed-pair is deterministic for the same seed", () => {
    const grid = withAcross(emptyGrid(), 5, 3, "ABCDE");
    const input = {
      grid,
      candidates: candidates([["XCY"], ["ZCW"], ["YCD"]]),
      targetEntries: 3,
    };

    const one = extendGridWithCrossedPair11({ ...input, seed: 55, dependencies: makeDependencies() });
    const two = extendGridWithCrossedPair11({ ...input, seed: 55, dependencies: makeDependencies() });

    assert.deepEqual(one, two);
  });

  it("does not mutate input grid snapshots", () => {
    const grid = withAcross(emptyGrid(), 5, 3, "ABCDE");
    const before = cloneGrid(grid);
    const result = densifyCleanGrid11({
      theme: "Neutral",
      grid,
      candidates: candidates([["XCY"]]),
      targetEntries: 2,
      seed: 123,
      pruneWeakEntries: false,
      dependencies: makeDependencies(),
    });

    assert.deepEqual(grid, before);
    assert.ok(result);
    const resultGrid = cloneGrid(result.grid);
    densifyCleanGrid11({
      theme: "Neutral",
      grid,
      candidates: candidates([["ZCW"]]),
      targetEntries: 2,
      seed: 124,
      pruneWeakEntries: false,
      dependencies: makeDependencies(),
    });
    assert.deepEqual(result.grid, resultGrid);
  });

  it("does not expose external-service dependencies or strategy orchestration", () => {
    assert.equal(deriveEntriesFromGrid(withAcross(emptyGrid(), 5, 3, "ABCDE"), 3).length, 1);
  });
});
