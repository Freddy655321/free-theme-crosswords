import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DerivedEntry, Entry, WordCandidate } from "@/app/lib/crosswordTypes";
import type { LegacyBuilderInputBase, LegacyBuilderResult } from "@/app/lib/legacyBuilder";
import type { ClueRequestItem } from "@/app/lib/publishPipeline";
import { runThemeFirstRescue } from "./runThemeFirstRescue";
import type { ThemeFirstRescueDependencies } from "./themeFirstRescueTypes";

type BuilderName = "compact" | "pattern" | "beam";

type BuilderCall = {
  builder: BuilderName;
  seed: number;
  deadlineMs?: number;
  candidates: WordCandidate[];
};

type ClueCall = {
  theme: string;
  language: "es" | "en";
  items: ClueRequestItem[];
};

type TestDependencies = ThemeFirstRescueDependencies & {
  builderCalls: BuilderCall[];
  clueCalls: ClueCall[];
  warnings: Array<{ message: string; payload: unknown }>;
};

const client = {} as Parameters<ThemeFirstRescueDependencies["requestModelClues"]>[0]["client"];

function candidates(answers: Array<[string, WordCandidate["source"]?, boolean?]>): WordCandidate[] {
  return answers.map(([answer, source = "model", thematic = true]) => ({
    answer,
    source,
    thematic,
  }));
}

function entries(answers: string[]): DerivedEntry[] {
  return answers.map((answer, index) => ({
    number: index + 1,
    row: index,
    col: 0,
    direction: "across",
    answer,
  }));
}

function grid(size = 11): string[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => "#"));
}

function cloneCandidates(input: WordCandidate[]): WordCandidate[] {
  return input.map((candidate) => ({ ...candidate }));
}

function makeDependencies(opts: {
  builderResults?: Partial<Record<BuilderName, LegacyBuilderResult | null>>;
  derived?: DerivedEntry[];
  minEntries?: number;
  nowValues?: number[];
  clueMode?: "success" | "throw" | "fallback" | "bland";
  generic?: Set<string>;
  strongNotes?: Set<string>;
} = {}): TestDependencies {
  const builderCalls: BuilderCall[] = [];
  const clueCalls: ClueCall[] = [];
  const warnings: Array<{ message: string; payload: unknown }> = [];
  const derived = opts.derived ?? entries(defaultAnswers());
  const built: LegacyBuilderResult = {
    grid: grid(),
    usedAnswers: derived.map((entry) => entry.answer),
    meta: { builder: "fake" },
  };
  const builderResults = opts.builderResults ?? { compact: built };
  const nowValues = opts.nowValues ? [...opts.nowValues] : [];

  function takeNow(): number {
    return nowValues.length > 0 ? nowValues.shift() ?? 0 : 1_000;
  }

  function builder(name: BuilderName) {
    return (input: LegacyBuilderInputBase): LegacyBuilderResult | null => {
      builderCalls.push({
        builder: name,
        seed: input.seed,
        deadlineMs: input.deadlineMs,
        candidates: input.candidates.map((candidate) => ({ ...candidate })),
      });
      return builderResults[name] === undefined ? null : builderResults[name] ?? null;
    };
  }

  return {
    builderCalls,
    clueCalls,
    warnings,
    buildBeamCrossword11: builder("beam"),
    buildCompactPatternCrossword11: builder("compact"),
    buildPatternCrossword11: builder("pattern"),
    rebuildGridFromAllowedEntries: (inputGrid, allowedAnswers) => {
      const allowedDerived = derived.filter((entry) => allowedAnswers.has(entry.answer));
      return {
        grid: inputGrid.map((row) => row.slice()),
        derived: allowedDerived,
      };
    },
    deriveEntriesFromGrid: () => derived,
    checkedCellStats: () => ({ checked: 20, total: 40, ratio: 0.5 }),
    crossedEntryStats: () => ({ crossed: derived.length, total: derived.length }),
    entryCrossingStats: () => ({ weakEntries: [], minCheckedCells: 2 }),
    crosswordDensityFromGrid: () => 0.42,
    minEntryLenForSize: () => 3,
    minPublishEntriesForSize: () => opts.minEntries ?? 10,
    minCrossingsPerEntryForPublish: () => 2,
    isOverGenericThemeWordForTheme: (_theme, answer) => opts.generic?.has(answer) ?? false,
    hasStrongThematicClueSupport: ({ answer }) => opts.strongNotes?.has(answer) ?? true,
    buildThematicClueRequestHint: (theme, answer, language, note) =>
      note ? `${theme}:${language}:${answer}:${note}` : null,
    requestModelClues: async ({ theme, language, items }) => {
      clueCalls.push({ theme, language, items: items.map((item) => ({ ...item })) });
      if (opts.clueMode === "throw") throw new Error("clue failure");
      if (opts.clueMode === "fallback" || opts.clueMode === "bland") return new Map();
      return new Map(items.map((item) => [item.answer, `Model clue ${item.answer}`]));
    },
    clueFromThemeNote: (_theme, note) => (opts.clueMode === "bland" ? "Brief definition." : `Note ${note}`),
    specificThematicFallbackClue: (_theme, answer) => `Specific ${answer}`,
    reinforceThematicClues: () => undefined,
    applyCluesAndOverrides: (_theme, _language, derivedEntries, clueByAnswer) =>
      derivedEntries.map(
        (entry): Entry => ({
          ...entry,
          clue: clueByAnswer.get(entry.answer) ?? "Brief definition.",
        })
      ),
    isPlaceholderClue: (clue) => clue === "PLACEHOLDER",
    now: takeNow,
    warn: (message, payload) => {
      warnings.push({ message, payload });
    },
  };
}

function defaultAnswers(): string[] {
  return ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT", "GOLF", "HOTEL", "INDIA", "JULIET"];
}

function defaultCandidates(): WordCandidate[] {
  return candidates(defaultAnswers().map((answer) => [answer, "model", true]));
}

async function runWith(
  deps: TestDependencies,
  opts: Partial<Parameters<typeof runThemeFirstRescue>[0]> = {}
) {
  const pool = opts.pool ?? defaultCandidates();
  return runThemeFirstRescue({
    client,
    theme: "Synthetic",
    language: "en",
    size: 11,
    pool,
    notesByAnswer: new Map(pool.map((candidate) => [candidate.answer, `note ${candidate.answer}`])),
    trustedThematicSet: new Set(pool.map((candidate) => candidate.answer)),
    seedBase: 123,
    dependencies: deps,
    ...opts,
  });
}

describe("themeFirstRescue", () => {
  it("builds a successful Theme-First rescue and preserves metadata", async () => {
    const deps = makeDependencies();
    const result = await runWith(deps);

    assert.ok(result);
    assert.equal(result.meta?.source, "theme-first-rescue-11");
    assert.equal(result.meta?.poolCount, 10);
    assert.equal(result.meta?.rescuePoolCount, 10);
    assert.equal(result.meta?.thematicEntries, 10);
    assert.equal(result.meta?.crossedEntries, 10);
    assert.equal(result.meta?.minCrossingsPerEntry, 2);
    assert.equal(result.meta?.minEntryCheckedCells, 2);
    assert.equal(result.meta?.checkedRatio, 0.5);
    assert.equal(result.meta?.clueCount, 10);
    assert.equal(deps.clueCalls.length, 1);
  });

  it("returns null for empty, insufficient, and non-11 inputs", async () => {
    assert.equal(await runWith(makeDependencies(), { pool: [], trustedThematicSet: new Set() }), null);
    assert.equal(
      await runWith(makeDependencies({ minEntries: 10 }), {
        pool: candidates([["ALPHA"], ["BRAVO"]]),
        trustedThematicSet: new Set(["ALPHA", "BRAVO"]),
      }),
      null
    );
    assert.equal(await runWith(makeDependencies(), { size: 9 }), null);
  });

  it("preserves candidate ordering, trusted priority, support/filler handling, and Map overwrite semantics", async () => {
    const input = candidates([
      ["SAME", "support", true],
      ["ALPHA", "model", true],
      ["FILLER", "filler", true],
      ["SAME", "anchor", true],
      ["CHARLIE", "support", true],
      ["BRAVO", "model", true],
      ["DELTA", "model", true],
      ["ECHO", "model", true],
      ["FOXTROT", "model", true],
      ["GOLF", "model", true],
      ["HOTEL", "model", true],
      ["INDIA", "model", true],
      ["JULIET", "model", true],
    ]);
    const deps = makeDependencies({
      derived: entries(["SAME", "ALPHA", "CHARLIE", "BRAVO", "DELTA", "ECHO", "FOXTROT", "GOLF", "HOTEL", "INDIA"]),
    });

    await runWith(deps, {
      pool: input,
      trustedThematicSet: new Set(input.map((candidate) => candidate.answer)),
    });

    const ordered = deps.builderCalls[0].candidates;
    assert.deepEqual(
      ordered.map((candidate) => candidate.answer),
      ["CHARLIE", "FOXTROT", "JULIET", "ALPHA", "BRAVO", "DELTA", "HOTEL", "INDIA", "ECHO", "GOLF", "SAME"]
    );
    assert.equal(ordered.find((candidate) => candidate.answer === "SAME")?.source, "anchor");
    assert.ok(!ordered.some((candidate) => candidate.answer === "FILLER"));
    assert.deepEqual(input, candidates([
      ["SAME", "support", true],
      ["ALPHA", "model", true],
      ["FILLER", "filler", true],
      ["SAME", "anchor", true],
      ["CHARLIE", "support", true],
      ["BRAVO", "model", true],
      ["DELTA", "model", true],
      ["ECHO", "model", true],
      ["FOXTROT", "model", true],
      ["GOLF", "model", true],
      ["HOTEL", "model", true],
      ["INDIA", "model", true],
      ["JULIET", "model", true],
    ]));
  });

  it("preserves builder order, short-circuiting, and seed derivation", async () => {
    const deps = makeDependencies({
      builderResults: {
        compact: null,
        pattern: {
          grid: grid(),
          usedAnswers: defaultAnswers(),
          meta: { builder: "pattern" },
        },
      },
    });

    await runWith(deps, { seedBase: 99 });

    assert.deepEqual(deps.builderCalls.slice(0, 2).map((call) => call.builder), ["compact", "pattern"]);
    assert.ok(!deps.builderCalls.some((call) => call.builder === "beam"));
    assert.deepEqual(deps.builderCalls.slice(0, 2).map((call) => call.seed), [99, 99]);
    assert.equal(deps.builderCalls.length, 24);
    assert.ok(deps.builderCalls.every((call) => call.deadlineMs === 10_000));
  });

  it("tries beam only for variant zero and returns null when all builders fail", async () => {
    const deps = makeDependencies({
      builderResults: { compact: null, pattern: null, beam: null },
      nowValues: [1_000, 1_100, 9_600],
    });

    assert.equal(await runWith(deps), null);
    assert.deepEqual(
      deps.builderCalls.map((call) => call.builder),
      ["compact", "pattern", "beam"]
    );
  });

  it("honors deadline exhausted and deadline during loop behavior", async () => {
    const exhausted = makeDependencies({ nowValues: [1_000, 9_500] });
    assert.equal(await runWith(exhausted), null);
    assert.equal(exhausted.builderCalls.length, 0);

    const during = makeDependencies({
      builderResults: { compact: null, pattern: null, beam: null },
      nowValues: [1_000, 1_100, 9_500],
    });
    assert.equal(await runWith(during), null);
    assert.equal(during.builderCalls.length, 3);
  });

  it("preserves clue success, clue fallback, and clue exception warning behavior", async () => {
    const success = makeDependencies();
    const successResult = await runWith(success);
    assert.ok(successResult);
    assert.ok(successResult.entries.every((entry) => entry.clue.startsWith("Model clue ")));

    const fallback = makeDependencies({ clueMode: "fallback" });
    const fallbackResult = await runWith(fallback);
    assert.ok(fallbackResult);
    assert.ok(fallbackResult.entries.every((entry) => entry.clue.startsWith("Note note ")));

    const throwing = makeDependencies({ clueMode: "throw" });
    const throwingResult = await runWith(throwing);
    assert.ok(throwingResult);
    assert.equal(throwing.warnings.length, 1);
    assert.equal(throwing.warnings[0].message, "[generate-crossword] theme-first rescue clues failed");
  });

  it("rejects bland clue fallback and does not mutate trusted sets or notes", async () => {
    const pool = defaultCandidates();
    const trusted = new Set(pool.map((candidate) => candidate.answer));
    const notes = new Map(pool.map((candidate) => [candidate.answer, `note ${candidate.answer}`]));
    const deps = makeDependencies({ clueMode: "bland" });

    assert.equal(
      await runWith(deps, {
        pool,
        trustedThematicSet: trusted,
        notesByAnswer: notes,
      }),
      null
    );
    assert.deepEqual(pool, defaultCandidates());
    assert.deepEqual(Array.from(trusted), defaultAnswers());
    assert.deepEqual(Array.from(notes.keys()), defaultAnswers());
  });

  it("returns stable snapshots for repeated identical input", async () => {
    const first = await runWith(makeDependencies(), { pool: cloneCandidates(defaultCandidates()) });
    const second = await runWith(makeDependencies(), { pool: cloneCandidates(defaultCandidates()) });

    assert.deepEqual(first, second);
    assert.ok(first);
    const before = first.grid.map((row) => row.slice());
    await runWith(makeDependencies(), { pool: cloneCandidates(defaultCandidates()) });
    assert.deepEqual(first.grid, before);
  });

  it("does not own BestPartial, fallback sequencing, HTTP, OpenAI calls, or Supabase calls", async () => {
    const deps = makeDependencies();
    const result = await runWith(deps);

    assert.ok(result);
    assert.equal(deps.clueCalls.length, 1);
    assert.ok(!("bestPartial" in result));
    assert.ok(!("status" in result));
  });
});
