import test from "node:test";
import assert from "node:assert/strict";
import type { Cell, WordCandidate } from "@/app/lib/crosswordTypes";
import {
  maybeEmitPruneBoundaryCaptureForDiagnostics,
  runFreeformBuilder,
  shouldAdmitFreeformFillScratch,
  shouldAdmitRepairDensifyPlacement,
} from "./runFreeformBuilder";
import type { FreeformBuilderDependencies } from "./freeformBuilderTypes";
import { pruneDanglingRuns } from "../gridValidation";
import type { PruneDanglingRunsTraceOptions } from "../gridValidation";
import { deriveEntriesFromGrid } from "../publishPipeline";
import { gridToStrings } from "../gridValidation";

test("freeform fill admission rejects raw short runs even when fallback answer checks pass", () => {
  const working: Cell[][] = Array.from({ length: 11 }, () => Array<Cell>(11).fill(""));
  working[3].splice(3, 3, ..."CAT");
  const original = working.map((row) => row.slice());
  const scratch = working.map((row) => row.slice());
  scratch[4].splice(3, 3, ..."DOG");
  const entries = deriveEntriesFromGrid(gridToStrings(scratch), 3);
  const allowed = new Set(["CAT", "DOG"]);

  // The null-evaluation fallback's existing membership/presence checks pass.
  assert.equal(entries.some((entry) => !allowed.has(entry.answer)), false);
  assert.equal(entries.some((entry) => entry.answer === "DOG"), true);
  assert.equal(shouldAdmitFreeformFillScratch(11, scratch), false);
  assert.deepEqual(working, original);
  assert.equal(scratch[4][3], "D");
});

test("freeform fill admission preserves comparable valid scratch grids without mutation", () => {
  const scratch: Cell[][] = Array.from({ length: 11 }, () => Array<Cell>(11).fill(""));
  scratch[3].splice(3, 3, ..."CAT");
  scratch[5].splice(3, 3, ..."DOG");
  const original = scratch.map((row) => row.slice());
  const entries = deriveEntriesFromGrid(gridToStrings(scratch), 3);
  assert.deepEqual(entries.map((entry) => entry.answer), ["CAT", "DOG"]);
  assert.equal(shouldAdmitFreeformFillScratch(11, scratch), true);
  assert.deepEqual(scratch, original);
});

test("freeform fill admission also rejects across short runs", () => {
  const scratch: Cell[][] = Array.from({ length: 11 }, () => Array<Cell>(11).fill("#"));
  scratch[3].splice(3, 2, ..."AT");
  assert.equal(shouldAdmitFreeformFillScratch(11, scratch), false);
});

test("freeform fill admission leaves other grid sizes unchanged", () => {
  for (const size of [9, 13]) {
    const scratch: Cell[][] = Array.from({ length: size }, () => Array<Cell>(size).fill(""));
    scratch[3].splice(3, 2, ..."AT");
    assert.equal(shouldAdmitFreeformFillScratch(size, scratch), true);
  }
});

const baseDependencies: FreeformBuilderDependencies = {
  isForbiddenPublishAnswer: () => false,
};

const candidates: WordCandidate[] = [
  "PLANETS",
  "PLASTER",
  "PAINTER",
  "TRAINER",
  "STONE",
  "STORE",
  "ROUTE",
  "TONE",
  "NOTE",
  "LINE",
  "LATE",
  "EAST",
  "STAR",
  "ART",
  "RAT",
].map((answer, index) => ({
  answer,
  thematic: index < 8,
  source: index < 8 ? "model" : "filler",
}));

function withMutedWarnings<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

test("runFreeformBuilder is deterministic for the same seed", () => {
  const input = {
    size: 11,
    candidates,
    seed: 12345,
    maxBuilds: 3,
    dependencies: baseDependencies,
  };

  const first = withMutedWarnings(() => runFreeformBuilder(input));
  const second = withMutedWarnings(() => runFreeformBuilder(input));

  assert.deepEqual(second, first);
});

test("repair densify rejects weak-preserving entry gains", () => {
  assert.equal(
    shouldAdmitRepairDensifyPlacement({
      currentWeakCount: 4,
      afterWeakCount: 4,
      entryGain: 1,
    }),
    false
  );

  assert.equal(
    shouldAdmitRepairDensifyPlacement({
      currentWeakCount: 4,
      afterWeakCount: 5,
      entryGain: 1,
    }),
    false
  );
});

test("repair densify still admits actual weak-entry improvement", () => {
  assert.equal(
    shouldAdmitRepairDensifyPlacement({
      currentWeakCount: 4,
      afterWeakCount: 3,
      entryGain: 0,
    }),
    true
  );

  assert.equal(
    shouldAdmitRepairDensifyPlacement({
      currentWeakCount: 0,
      afterWeakCount: 0,
      entryGain: 1,
    }),
    true
  );

  assert.equal(
    shouldAdmitRepairDensifyPlacement({
      currentWeakCount: 0,
      afterWeakCount: 1,
      entryGain: 1,
    }),
    false
  );
});

test("runFreeformBuilder returns null for an empty usable pool", () => {
  assert.equal(
    withMutedWarnings(() => runFreeformBuilder({
      size: 11,
      candidates: [{ answer: "NO", thematic: true, source: "model" }],
      seed: 1,
      dependencies: baseDependencies,
    })),
    null
  );
});

test("runFreeformBuilder preserves result shape and used answers", () => {
  const result = withMutedWarnings(() => runFreeformBuilder({
    size: 11,
    candidates,
    seed: 42,
    maxBuilds: 2,
    dependencies: baseDependencies,
  }));

  assert.ok(result);
  assert.equal(result.grid.length, 11);
  assert.ok(result.usedAnswers.length > 0);
  assert.equal(result.meta.algorithm, "freeform-crossing-then-blocks");
  assert.equal(result.meta.candidatesCount, candidates.length);
  assert.equal(result.meta.rounds, 28);
});

test("runFreeformBuilder honors exhausted deadlines", () => {
  assert.equal(
    withMutedWarnings(() => runFreeformBuilder({
      size: 11,
      candidates,
      seed: 1,
      deadlineMs: Date.now() - 1,
      dependencies: baseDependencies,
    })),
    null
  );
});

test("runFreeformBuilder preserves maxPlacedWords as an upper bound", () => {
  const result = withMutedWarnings(() => runFreeformBuilder({
    size: 11,
    candidates,
    seed: 42,
    maxBuilds: 1,
    maxPlacedWords: 1,
    dependencies: baseDependencies,
  }));

  assert.equal(result, null);
});

test("runFreeformBuilder dedupes normalized-equivalent candidates by first value", () => {
  const duplicated = [
    candidates[0],
    { ...candidates[0], source: "support" as const },
    ...candidates.slice(1),
  ];

  const result = withMutedWarnings(() => runFreeformBuilder({
    size: 11,
    candidates: duplicated,
    seed: 42,
    maxBuilds: 2,
    dependencies: baseDependencies,
  }));

  assert.ok(result);
  assert.equal(result.meta.candidatesCount, duplicated.length);
  assert.equal(new Set(result.usedAnswers).size, result.usedAnswers.length);
});

test("runFreeformBuilder supports size 9 and size 13 parameter branches", () => {
  const size9 = withMutedWarnings(() => runFreeformBuilder({
    size: 9,
    candidates,
    seed: 7,
    maxBuilds: 1,
    dependencies: baseDependencies,
  }));
  const size13 = withMutedWarnings(() => runFreeformBuilder({
    size: 13,
    candidates: [...candidates, { answer: "CROSSWORD", thematic: true, source: "model" }],
    seed: 7,
    maxBuilds: 1,
    dependencies: baseDependencies,
  }));

  assert.equal(size9?.meta.rounds ?? 4, 4);
  assert.equal(size13?.meta.rounds ?? 6, 6);
});

test("runFreeformBuilder does not mutate candidate input", () => {
  const inputCandidates = candidates.map((candidate) => ({ ...candidate }));
  const before = structuredClone(inputCandidates);

  withMutedWarnings(() => runFreeformBuilder({
    size: 11,
    candidates: inputCandidates,
    seed: 99,
    maxBuilds: 1,
    dependencies: baseDependencies,
  }));

  assert.deepEqual(inputCandidates, before);
});

test("runFreeformBuilder uses injected forbidden-answer policy", () => {
  let forbiddenChecks = 0;
  const result = withMutedWarnings(() => runFreeformBuilder({
    size: 11,
    candidates: candidates.slice(0, 3),
    seed: 11,
    maxBuilds: 1,
    dependencies: {
      ...baseDependencies,
      isForbiddenPublishAnswer: () => {
        forbiddenChecks++;
        return true;
      },
    },
  }));

  assert.equal(result, null);
  assert.ok(forbiddenChecks > 0);
});

test("runFreeformBuilder reports null when no crossings can be committed", () => {
  const result = withMutedWarnings(() => runFreeformBuilder({
    size: 11,
    candidates: [
      { answer: "ABCDEFG", thematic: true, source: "model" },
      { answer: "HIJKLMN", thematic: true, source: "model" },
      { answer: "OPQRSTU", thematic: true, source: "model" },
    ],
    seed: 123,
    maxBuilds: 1,
    dependencies: baseDependencies,
  }));

  assert.equal(result, null);
});

test("prune-boundary capture emits once for high-placement prune damage", () => {
  const beforeGrid = [
    "AAA#BBB#CCC",
    "D###E###F##",
    "D###E###F##",
    "D###E###F##",
    "GGG#HHH#III",
    "J###K###L##",
    "J###K###L##",
    "J###K###L##",
    "MMM#NNN#OOO",
    "###########",
    "###########",
  ].map((row) => row.split(""));
  const afterGrid = beforeGrid.map((row) => row.slice());
  for (const [r, c] of [
    [0, 0],
    [0, 1],
    [0, 2],
    [4, 0],
    [4, 1],
    [4, 2],
    [8, 0],
    [8, 1],
    [8, 2],
  ]) {
    afterGrid[r][c] = "#";
  }

  const beforeEntries = Array.from({ length: 15 }, (_, index) => ({
    answer: `WORD${index}`,
    direction: index % 2 === 0 ? "across" as const : "down" as const,
    row: index % 11,
    col: Math.floor(index / 2) % 11,
  }));
  const afterEntries = beforeEntries.slice(3);
  const events: Array<{ prefix: unknown; payload: Record<string, unknown> }> = [];
  const original = console.warn;
  console.warn = (prefix: unknown, payload: Record<string, unknown>) => {
    events.push({ prefix, payload });
  };
  try {
    const emitted = maybeEmitPruneBoundaryCaptureForDiagnostics({
      alreadyEmitted: false,
      size: 11,
      startIndex: 2,
      localSeed: 123,
      placedCount: 15,
      candidateCount: 85,
      minLen: 3,
      beforeGrid,
      afterGrid,
      beforeEntries,
      afterEntries,
      pruneIterations: [
        {
          iteration: 0,
          cells: [
            {
              r: 0,
              c: 0,
              value: "A",
              reasons: [{ direction: "across", runLength: 2 }],
            },
          ],
        },
      ],
    });
    const second = maybeEmitPruneBoundaryCaptureForDiagnostics({
      alreadyEmitted: emitted,
      size: 11,
      startIndex: 3,
      localSeed: 456,
      placedCount: 16,
      candidateCount: 85,
      minLen: 3,
      beforeGrid,
      afterGrid,
      beforeEntries,
      afterEntries,
      pruneIterations: [],
    });

    assert.equal(emitted, true);
    assert.equal(second, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].prefix, "[m1-construction-diag] prune-boundary-capture");
    assert.equal(events[0].payload.beforeCount, 15);
    assert.equal(events[0].payload.afterCount, 12);
    assert.equal((events[0].payload.lostEntries as unknown[]).length, 3);
    assert.equal((events[0].payload.pruneIterations as unknown[]).length, 1);
  } finally {
    console.warn = original;
  }
});

test("pruneDanglingRuns trace records removed cells without changing output", () => {
  const grid = [
    "ABC##",
    "####D",
    "####E",
    "#####",
    "#####",
  ].map((row) => row.split(""));
  const trace: PruneDanglingRunsTraceOptions = { iterations: [] };

  const traced = pruneDanglingRuns(grid, 3, trace);
  const untraced = pruneDanglingRuns(grid, 3);

  assert.deepEqual(traced, untraced);
  assert.equal(trace.iterations?.length, 1);
  assert.deepEqual(
    trace.iterations?.[0].cells.map((cell) => ({
      r: cell.r,
      c: cell.c,
      value: cell.value,
      reasons: cell.reasons,
    })),
    [
      { r: 1, c: 4, value: "D", reasons: [{ direction: "down", runLength: 2 }] },
      { r: 2, c: 4, value: "E", reasons: [{ direction: "down", runLength: 2 }] },
    ]
  );
  assert.equal(grid[1][4], "D");
});
