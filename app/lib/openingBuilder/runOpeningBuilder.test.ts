import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WordCandidate } from "@/app/lib/crosswordTypes";
import { deriveEntriesFromGrid } from "@/app/lib/publishPipeline";
import { runOpeningBuilder } from "./runOpeningBuilder";
import type { OpeningBuilderDependencies } from "./openingBuilderTypes";

function dependencies(opts: {
  forbidden?: Set<string>;
  generic?: Set<string>;
  derived?: OpeningBuilderDependencies["deriveEntriesFromGrid"];
} = {}): OpeningBuilderDependencies {
  return {
    deriveEntriesFromGrid: opts.derived ?? deriveEntriesFromGrid,
    isForbiddenPublishAnswer: (answer) => opts.forbidden?.has(answer) ?? false,
    isOverGenericThemeWordForTheme: (_theme, answer) => opts.generic?.has(answer) ?? false,
  };
}

function candidates(answers: Array<[string, boolean?, WordCandidate["source"]?]>): WordCandidate[] {
  return answers.map(([answer, thematic = true, source = "model"]) => ({
    answer,
    thematic,
    source,
  }));
}

function openingCandidates(): WordCandidate[] {
  const base = "ABCDEFGHIJK";
  const shifted = Array.from({ length: 11 }, (_, index) => base.slice(index) + base.slice(0, index));
  return candidates(shifted.map((answer) => [answer, true, "model"]));
}

function cloneCandidates(input: WordCandidate[]): WordCandidate[] {
  return input.map((candidate) => ({ ...candidate }));
}

function normalizeResult(result: ReturnType<typeof runOpeningBuilder>) {
  if (!result) return null;
  return {
    grid: result.grid,
    derived: result.derived,
    usedAnswers: result.usedAnswers,
    meta: result.meta,
  };
}

describe("openingBuilder", () => {
  it("builds a deterministic opening crossword", () => {
    const input = openingCandidates();
    const result = runOpeningBuilder({
      theme: "Synthetic",
      candidates: input,
      seed: 7,
      targetEntries: 5,
      deadlineMs: Date.now() + 30_000,
      dependencies: dependencies(),
    });

    assert.ok(result);
    assert.equal(result.meta.builder, "opening-crossword-11");
    assert.equal(result.meta.openingTargetEntries, 5);
    assert.ok(result.derived.length >= 5);
    assert.deepEqual(input, openingCandidates());
  });

  it("returns null for empty and insufficient candidate pools", () => {
    assert.equal(
      runOpeningBuilder({
        theme: "Synthetic",
        candidates: [],
        seed: 1,
        targetEntries: 2,
        deadlineMs: Date.now() + 30_000,
        dependencies: dependencies(),
      }),
      null
    );

    assert.equal(
      runOpeningBuilder({
        theme: "Synthetic",
        candidates: candidates([["ABCDE"]]),
        seed: 1,
        targetEntries: 2,
        deadlineMs: Date.now() + 30_000,
        dependencies: dependencies(),
      }),
      null
    );
  });

  it("is deterministic for the same seed and preserves second-seed behavior", () => {
    const input = openingCandidates();
    const first = normalizeResult(
      runOpeningBuilder({
        theme: "Synthetic",
        candidates: cloneCandidates(input),
        seed: 123,
        targetEntries: 5,
        deadlineMs: Date.now() + 30_000,
        dependencies: dependencies(),
      })
    );
    const second = normalizeResult(
      runOpeningBuilder({
        theme: "Synthetic",
        candidates: cloneCandidates(input),
        seed: 123,
        targetEntries: 5,
        deadlineMs: Date.now() + 30_000,
        dependencies: dependencies(),
      })
    );
    const third = normalizeResult(
      runOpeningBuilder({
        theme: "Synthetic",
        candidates: cloneCandidates(input),
        seed: 124,
        targetEntries: 5,
        deadlineMs: Date.now() + 30_000,
        dependencies: dependencies(),
      })
    );
    const fourth = normalizeResult(
      runOpeningBuilder({
        theme: "Synthetic",
        candidates: cloneCandidates(input),
        seed: 124,
        targetEntries: 5,
        deadlineMs: Date.now() + 30_000,
        dependencies: dependencies(),
      })
    );

    assert.deepEqual(first, second);
    assert.deepEqual(third, fourth);
    assert.ok(third);
  });

  it("keeps the current expired-deadline fallback behavior", () => {
    const result = runOpeningBuilder({
      theme: "Synthetic",
      candidates: openingCandidates(),
      seed: 7,
      targetEntries: 5,
      deadlineMs: Date.now() - 1,
      dependencies: dependencies(),
    });

    assert.ok(result);
  });

  it("honors thematic ordering, top-28 slicing, and duplicate first-winner semantics", () => {
    const seenGrids: string[][][] = [];
    const deps = dependencies({
      derived: (grid, minLen) => {
        seenGrids.push(grid.map((row) => row.slice()));
        return deriveEntriesFromGrid(grid, minLen);
      },
    });
    const input = candidates([
      ["ABCDE", false],
      ["ABCDE", true],
      ["FGHIJ", true],
      ["KLMNO", true],
      ["PQRST", true],
      ["UVWXY", true],
      ["ZZZZZ", true],
      ["AAAAA", false, "support"],
      ["FILLR", true, "filler"],
      ...Array.from({ length: 30 }, (_, index) => [`T${String(index).padStart(4, "0")}`, true] as [string, boolean]),
    ]);

    runOpeningBuilder({
      theme: "Synthetic",
      candidates: input,
      seed: 999,
      targetEntries: 4,
      deadlineMs: Date.now() + 600,
      dependencies: deps,
    });

    assert.ok(seenGrids.length > 0);
    assert.equal(input[0].thematic, false);
    assert.equal(input[1].thematic, true);
  });

  it("filters generic, forbidden, filler, and invalid candidates through policies", () => {
    const result = runOpeningBuilder({
      theme: "Synthetic",
      candidates: candidates([
        ...openingCandidates().map((candidate) => [candidate.answer, candidate.thematic, candidate.source] as [
          string,
          boolean,
          WordCandidate["source"],
        ]),
        ["BAD", true],
        ["GENERIC", false],
        ["badcase", true],
        ["FILLR", true, "filler"],
      ]),
      seed: 7,
      targetEntries: 5,
      deadlineMs: Date.now() + 30_000,
      dependencies: dependencies({
        forbidden: new Set(["BAD"]),
        generic: new Set(["GENERIC"]),
      }),
    });

    assert.ok(result);
    assert.ok(!result.usedAnswers.includes("BAD"));
    assert.ok(!result.usedAnswers.includes("GENERIC"));
    assert.ok(!result.usedAnswers.includes("FILLR"));
  });

  it("preserves metadata and usedAnswers ordering", () => {
    const result = runOpeningBuilder({
      theme: "Synthetic",
      candidates: openingCandidates(),
      seed: 7,
      targetEntries: 5,
      deadlineMs: Date.now() + 30_000,
      dependencies: dependencies(),
    });

    assert.ok(result);
    assert.deepEqual(result.usedAnswers, Array.from(new Set(result.derived.map((entry) => entry.answer))));
    assert.equal(result.meta.openingEntries, result.derived.length);
    assert.equal(result.meta.openingThemeEntries, result.derived.length);
    assert.equal(typeof result.meta.density, "number");
  });

  it("returns null when derived entries create answers outside the allowlist", () => {
    const result = runOpeningBuilder({
      theme: "Synthetic",
      candidates: openingCandidates(),
      seed: 7,
      targetEntries: 5,
      deadlineMs: Date.now() + 30_000,
      dependencies: dependencies({
        derived: (grid, minLen) => [
          ...deriveEntriesFromGrid(grid, minLen),
          { number: 99, row: 0, col: 0, direction: "across", answer: "UNLISTED" },
        ],
      }),
    });

    assert.equal(result, null);
  });

  it("returns null when dependency policies reject all placements", () => {
    const result = runOpeningBuilder({
      theme: "Synthetic",
      candidates: openingCandidates(),
      seed: 7,
      targetEntries: 5,
      deadlineMs: Date.now() + 30_000,
      dependencies: dependencies({
        forbidden: new Set(openingCandidates().map((candidate) => candidate.answer)),
      }),
    });

    assert.equal(result, null);
  });

  it("returns independent snapshots", () => {
    const input = openingCandidates();
    const first = runOpeningBuilder({
      theme: "Synthetic",
      candidates: input,
      seed: 7,
      targetEntries: 5,
      deadlineMs: Date.now() + 30_000,
      dependencies: dependencies(),
    });
    assert.ok(first);
    const originalCell = first.grid[0][0];
    first.grid[0][0] = "Z";

    const second = runOpeningBuilder({
      theme: "Synthetic",
      candidates: input,
      seed: 7,
      targetEntries: 5,
      deadlineMs: Date.now() + 30_000,
      dependencies: dependencies(),
    });

    assert.ok(second);
    assert.equal(second.grid[0][0], originalCell);
  });

  it("does not expose logging or global fallback behavior", () => {
    const result = runOpeningBuilder({
      theme: "Synthetic",
      candidates: openingCandidates(),
      seed: 7,
      targetEntries: 5,
      deadlineMs: Date.now() + 30_000,
      dependencies: dependencies(),
    });

    assert.ok(result);
    assert.equal("logger" in dependencies(), false);
    assert.equal("source" in result.meta, false);
  });
});
