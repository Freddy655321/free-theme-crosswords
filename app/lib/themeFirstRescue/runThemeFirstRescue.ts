import type { DerivedEntry, WordCandidate } from "@/app/lib/crosswordTypes";
import type { ClueRequestItem } from "@/app/lib/publishPipeline";
import type { ThemeFirstRescueInput, ThemeFirstRescueResult } from "./themeFirstRescueTypes";

export async function runThemeFirstRescue(input: ThemeFirstRescueInput): Promise<ThemeFirstRescueResult> {
  const {
    client,
    theme,
    language,
    size,
    pool,
    notesByAnswer,
    trustedThematicSet,
    seedBase,
    dependencies,
  } = input;
  const {
    buildBeamCrossword11,
    buildCompactPatternCrossword11,
    buildPatternCrossword11,
    buildThematicClueRequestHint,
    checkedCellStats,
    clueFromThemeNote,
    crossedEntryStats,
    crosswordDensityFromGrid,
    deriveEntriesFromGrid,
    entryCrossingStats,
    hasStrongThematicClueSupport,
    isOverGenericThemeWordForTheme,
    isPlaceholderClue,
    minCrossingsPerEntryForPublish,
    minEntryLenForSize,
    minPublishEntriesForSize,
    now,
    rebuildGridFromAllowedEntries,
    reinforceThematicClues,
    requestModelClues,
    specificThematicFallbackClue,
    applyCluesAndOverrides,
    warn,
  } = dependencies;
  if (size !== 11) return null;

  const minLen = minEntryLenForSize(size);
  const minEntries = minPublishEntriesForSize(size);
  const rescueByAnswer = new Map<string, WordCandidate>();

  for (const candidate of pool) {
    if (!trustedThematicSet.has(candidate.answer)) continue;
    if (candidate.source === "filler") continue;
    if (candidate.answer.length < minLen || candidate.answer.length > size) continue;
    if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
    rescueByAnswer.set(candidate.answer, {
      ...candidate,
      thematic: true,
      source: candidate.source === "support" ? "model" : candidate.source,
    });
  }

  if (rescueByAnswer.size < minEntries) {
    for (const candidate of pool) {
      if (rescueByAnswer.size >= minEntries + 12) break;
      if (candidate.source === "filler") continue;
      if (candidate.answer.length < minLen || candidate.answer.length > size) continue;
      if (rescueByAnswer.has(candidate.answer)) continue;
      if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
      if (
        !hasStrongThematicClueSupport({
          theme,
          answer: candidate.answer,
          language,
          note: notesByAnswer.get(candidate.answer),
        })
      ) {
        continue;
      }
      rescueByAnswer.set(candidate.answer, { ...candidate, thematic: true });
    }
  }

  if (rescueByAnswer.size < minEntries + 8) {
    for (const candidate of pool) {
      if (rescueByAnswer.size >= minEntries + 16) break;
      if (candidate.source === "filler") continue;
      if (candidate.answer.length < minLen || candidate.answer.length > size) continue;
      if (rescueByAnswer.has(candidate.answer)) continue;
      if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
      rescueByAnswer.set(candidate.answer, { ...candidate, thematic: true });
    }
  }

  const rescuePool = Array.from(rescueByAnswer.values()).sort((a, b) => {
    if (a.answer.length !== b.answer.length) return b.answer.length - a.answer.length;
    return a.answer.localeCompare(b.answer);
  });

  if (rescuePool.length < minEntries) return null;

  let best:
    | {
        grid: string[][];
        derived: DerivedEntry[];
        score: number;
        thematicEntries: number;
        crossedEntries: number;
        minEntryCheckedCells: number;
        weakEntryCount: number;
        checkedRatio: number;
      }
    | null = null;

  const rescueDeadlineMs = now() + 9000;
  const allowedAnswers = new Set(rescuePool.map((c) => c.answer));

  for (let variant = 0; variant < 12 && now() < rescueDeadlineMs - 500; variant++) {
    const variantSeed = (seedBase ^ (variant * 0x9e3779b9)) >>> 0;
    const built =
      buildCompactPatternCrossword11({
        theme,
        size,
        seed: variantSeed,
        candidates: rescuePool,
        deadlineMs: rescueDeadlineMs,
      }) ??
      buildPatternCrossword11({
        theme,
        size,
        seed: variantSeed,
        candidates: rescuePool,
        deadlineMs: rescueDeadlineMs,
      }) ??
      (variant === 0
        ? buildBeamCrossword11({
            theme,
            size,
            seed: variantSeed,
            candidates: rescuePool,
            deadlineMs: rescueDeadlineMs,
          })
        : null);
    if (!built) continue;

    const cleaned = rebuildGridFromAllowedEntries(built.grid, allowedAnswers, minLen);
    const grid = cleaned?.grid ?? built.grid;
    const derived = cleaned?.derived ?? deriveEntriesFromGrid(grid, minLen);
    if (derived.some((entry) => !allowedAnswers.has(entry.answer))) continue;

    const checked = checkedCellStats(grid, minLen);
    const crossed = crossedEntryStats(grid, derived, minLen);
    const entryCrossings = entryCrossingStats(grid, derived, minLen);
    const thematicEntries = derived.filter((entry) => allowedAnswers.has(entry.answer)).length;
    const score =
      thematicEntries * 12000 +
      crossed.crossed * 5000 +
      derived.length * 3000 +
      checked.ratio * 2000 +
      crosswordDensityFromGrid(grid) * 1000 -
      entryCrossings.weakEntries.length * 90000;

    if (!best || score > best.score) {
      best = {
        grid,
        derived,
        score,
        thematicEntries,
        crossedEntries: crossed.crossed,
        minEntryCheckedCells: entryCrossings.minCheckedCells,
        weakEntryCount: entryCrossings.weakEntries.length,
        checkedRatio: checked.ratio,
      };
    }
  }

  if (
    !best ||
    best.derived.length < minEntries ||
    best.crossedEntries < minEntries ||
    best.weakEntryCount > 0 ||
    best.thematicEntries < 10 ||
    best.checkedRatio < 0.25
  ) {
    return null;
  }

  const uniqueAnswers = Array.from(new Set(best.derived.map((entry) => entry.answer)));
  const rescueThematicSet = new Set(uniqueAnswers.filter((answer) => allowedAnswers.has(answer)));
  const clueItems: ClueRequestItem[] = uniqueAnswers.map((answer) => {
    const note = notesByAnswer.get(answer);
    return {
      answer,
      thematic: rescueThematicSet.has(answer),
      note,
      hint: rescueThematicSet.has(answer)
        ? buildThematicClueRequestHint(theme, answer, language, note) ?? undefined
        : undefined,
    };
  });

  const clueByAnswer = new Map<string, string>();
  try {
    const modelClues = await requestModelClues({
      client,
      theme,
      language,
      items: clueItems,
    });
    for (const [answer, clue] of modelClues.entries()) clueByAnswer.set(answer, clue);
  } catch (error: unknown) {
    warn("[generate-crossword] theme-first rescue clues failed", {
      name: error instanceof Error ? error.name : "unknown",
      msg: error instanceof Error ? error.message : String(error),
    });
  }

  for (const answer of uniqueAnswers) {
    if (clueByAnswer.has(answer)) continue;
    const note = notesByAnswer.get(answer);
    const fromNote = note ? clueFromThemeNote(theme, note, language) : null;
    const specific = specificThematicFallbackClue(theme, answer, language);
    clueByAnswer.set(
      answer,
      fromNote ??
        specific ??
        (language === "es"
          ? `Referencia concreta asociada con ${theme}`
          : `Concrete reference associated with ${theme}`)
    );
  }

  reinforceThematicClues(theme, language, uniqueAnswers, clueByAnswer, notesByAnswer, rescueThematicSet);

  const entries = applyCluesAndOverrides(theme, language, best.derived, clueByAnswer);
  const placeholderCount = entries.filter((entry) => isPlaceholderClue(entry.clue, language)).length;
  const blandText = language === "es" ? "DefiniciÃ³n breve." : "Brief definition.";
  const bland = entries.filter((entry) => entry.clue === blandText).length;

  if (placeholderCount > 0 || bland > 0 || entries.length < minEntries) return null;

  return {
    theme,
    language,
    size,
    grid: best.grid,
    entries,
    meta: {
      source: "theme-first-rescue-11",
      poolCount: pool.length,
      rescuePoolCount: rescuePool.length,
      thematicEntries: best.thematicEntries,
      crossedEntries: best.crossedEntries,
      minCrossingsPerEntry: minCrossingsPerEntryForPublish(size),
      minEntryCheckedCells: best.minEntryCheckedCells,
      checkedRatio: best.checkedRatio,
      clueCount: clueByAnswer.size,
    },
  };
}
