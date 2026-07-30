import type { Cell, DerivedEntry, Direction, Placement, WordCandidate } from "@/app/lib/crosswordTypes";
import type { LegacyBuilderInput, LegacyBuilderResult } from "./legacyBuilderTypes";

type PatternSlot = {
  row: number;
  col: number;
  direction: Direction;
  len: number;
  cells: Array<{ r: number; c: number }>;
};

type LegacyBuilderRunOptions = Omit<LegacyBuilderInput, "mode">;

function constructPatternCrossword11(opts: LegacyBuilderRunOptions): LegacyBuilderResult | null {
  const { theme, size, candidates, seed, deadlineMs, dependencies } = opts;
  const {
    alwaysAllowAnswers: ALWAYS_ALLOW_ANSWERS,
    asciiAnswerPattern: ASCII_A_TO_Z,
    commonEnglishDictionaryWords: COMMON_ENGLISH_DICTIONARY_WORDS,
    deriveEntriesFromGrid,
    extractPatternSlots,
    fillerWords: FILLER_WORDS,
    frequencyEnglishDictionaryWords: FREQUENCY_ENGLISH_DICTIONARY_WORDS,
    frequencySpanishDictionaryWords: FREQUENCY_SPANISH_DICTIONARY_WORDS,
    isLikelyBadAnswer,
    isOverGenericThemeWordForTheme,
    makeSeededRng,
    minEntryLenForSize,
    minPublishEntriesForSize,
    patterns11: PATTERN_11X11S,
    shuffleInPlace,
    spanishFillerWords: SPANISH_FILLER_WORDS,
    weakContextDictionaryWords: WEAK_CONTEXT_DICTIONARY_WORDS,
  } = dependencies;
  if (size !== 11) return null;

  const nowOk = () => !deadlineMs || Date.now() <= deadlineMs;
  const spanishFillerCount = candidates.filter((candidate) =>
    SPANISH_FILLER_WORDS.includes(candidate.answer)
  ).length;
  const englishFillerCount = candidates.filter((candidate) =>
    FILLER_WORDS.includes(candidate.answer)
  ).length;
  const frequencyDictionary =
    spanishFillerCount > englishFillerCount
      ? FREQUENCY_SPANISH_DICTIONARY_WORDS
      : FREQUENCY_ENGLISH_DICTIONARY_WORDS;
  const dictionaryCandidates: WordCandidate[] = Array.from(
    new Set([
      ...(spanishFillerCount > englishFillerCount
        ? []
        : COMMON_ENGLISH_DICTIONARY_WORDS),
      ...frequencyDictionary,
    ])
  ).map(
    (answer) => ({
      answer,
      thematic: false,
      source: "filler" as const,
    })
  ).filter((candidate) =>
    (candidate.answer.length > 3 || FILLER_WORDS.includes(candidate.answer)) &&
    !WEAK_CONTEXT_DICTIONARY_WORDS.has(candidate.answer)
  );
  const candidatesByAnswer = new Map<string, WordCandidate>();
  for (const candidate of [...candidates, ...dictionaryCandidates]) {
    if (!candidatesByAnswer.has(candidate.answer)) {
      candidatesByAnswer.set(candidate.answer, candidate);
    }
  }
  const usable = Array.from(candidatesByAnswer.values())
    .filter((c) => size === 11 || c.source !== "filler")
    .filter((c) => c.answer.length >= 3 && c.answer.length <= 11)
    .filter((c) => ASCII_A_TO_Z.test(c.answer))
    .filter(
      (c) =>
        c.source !== "filler" ||
        !isLikelyBadAnswer(c.answer) ||
        ALWAYS_ALLOW_ANSWERS.has(c.answer)
    )
    .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer));

  const totalByLen = new Map<number, WordCandidate[]>();
  const thematicByLen = new Map<number, WordCandidate[]>();

  for (const cand of usable) {
    const bucket = totalByLen.get(cand.answer.length) ?? [];
    bucket.push(cand);
    totalByLen.set(cand.answer.length, bucket);

    if (cand.thematic) {
      const tBucket = thematicByLen.get(cand.answer.length) ?? [];
      tBucket.push(cand);
      thematicByLen.set(cand.answer.length, tBucket);
    }
  }

  const scorePattern = (pattern: string[]) => {
    const slots = extractPatternSlots(pattern);
    const needByLen = new Map<number, number>();

    for (const slot of slots) {
      needByLen.set(slot.len, (needByLen.get(slot.len) ?? 0) + 1);
    }

    let shortages = 0;
    let supportNeed = 0;
    let shortCount = 0;
    let longCount = 0;

    for (const [len, need] of needByLen) {
      const total = totalByLen.get(len)?.length ?? 0;
      const thematic = thematicByLen.get(len)?.length ?? 0;
      if (total < need) shortages += need - total;
      if (thematic < need) supportNeed += Math.max(0, Math.min(need, total) - thematic);
      if (len <= 4) shortCount += need;
      if (len >= 9) longCount += need;
    }

    return {
      slots,
      score: shortages * 10000 + supportNeed * 250 + shortCount * 55 + longCount * 25 + slots.length * 2,
      shortages,
    };
  };

  const preferredPatterns = [
    PATTERN_11X11S[0],
    ...PATTERN_11X11S.filter((_, index) => index !== 0),
  ];
  const rankedPatterns = preferredPatterns
    .map((pattern) => ({ pattern, ...scorePattern(pattern) }))
    .filter((item) => item.shortages === 0)
    .sort((a, b) => {
      const aPreferred = a.pattern === PATTERN_11X11S[0] ? 0 : 1;
      const bPreferred = b.pattern === PATTERN_11X11S[0] ? 0 : 1;
      return aPreferred - bPreferred || a.score - b.score;
    });

  if (rankedPatterns.length === 0) return null;

  for (const ranked of rankedPatterns) {
    if (!nowOk()) break;

    const { pattern, slots } = ranked;
    let bestForPattern:
      | {
          grid: string[][];
          usedAnswers: string[];
          thematicCount: number;
          patternVariant: number;
        }
      | null = null;
    const slotIntersections = slots.map((slot, idx) => {
      let count = 0;
      for (let j = 0; j < slots.length; j++) {
        if (j === idx) continue;
        if (slots[j].direction === slot.direction) continue;
        if (slot.cells.some((cell) => slots[j].cells.some((other) => other.r === cell.r && other.c === cell.c))) {
          count++;
        }
      }
      return count;
    });

    const patternAttempts = 14;
    for (let variant = 0; variant < patternAttempts; variant++) {
      if (!nowOk()) break;

      const rng = makeSeededRng((seed + ranked.score * 17 + variant * 104729) >>> 0);
      const baseGrid = pattern.map((row) => row.split("").map((ch) => (ch === "#" ? "#" : "")));

      const candidatePoolByLen = new Map<number, WordCandidate[]>();
      const candidateIndex = new Map<string, WordCandidate[]>();
      for (const [len, items] of totalByLen) {
        const ordered = items
          .slice()
          .sort((a, b) => {
            if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
            const aSource = a.source === "anchor" ? 3 : a.source === "model" ? 2 : 1;
            const bSource = b.source === "anchor" ? 3 : b.source === "model" ? 2 : 1;
            if (aSource !== bSource) return bSource - aSource;
            return a.answer.localeCompare(b.answer);
          });
        shuffleInPlace(ordered, rng);
        ordered.sort((a, b) => {
          if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
          const aSource = a.source === "anchor" ? 3 : a.source === "model" ? 2 : 1;
          const bSource = b.source === "anchor" ? 3 : b.source === "model" ? 2 : 1;
          if (aSource !== bSource) return bSource - aSource;
          return 0;
        });
        candidatePoolByLen.set(len, ordered);
        for (const candidate of ordered) {
          for (let position = 0; position < candidate.answer.length; position++) {
            const key = `${len}:${position}:${candidate.answer[position]}`;
            const indexed = candidateIndex.get(key) ?? [];
            indexed.push(candidate);
            candidateIndex.set(key, indexed);
          }
        }
      }

      const search = (
        grid: Cell[][],
        assignments: Array<string | null>,
        used: Set<string>,
        thematicCount: number
      ): { grid: Cell[][]; assignments: Array<string | null> } | null => {
        if (!nowOk()) return null;
        searchStates++;
        if (searchStates > 2_000_000) return null;

        let bestSlotIndex = -1;
        let bestWords: WordCandidate[] = [];

        for (let i = 0; i < slots.length; i++) {
          if (assignments[i]) continue;

          const slot = slots[i];
          const poolForLen = candidatePoolByLen.get(slot.len) ?? [];
          const constrainedPools = slot.cells
            .map((cell, position) => {
              const current = grid[cell.r][cell.c];
              return current === ""
                ? null
                : candidateIndex.get(`${slot.len}:${position}:${current}`) ?? [];
            })
            .filter((pool): pool is WordCandidate[] => pool !== null);
          const basePool =
            constrainedPools.length > 0
              ? constrainedPools.slice().sort((a, b) => a.length - b.length)[0]
              : poolForLen;
          const viable = basePool.filter((cand) => {
            if (used.has(cand.answer)) return false;

            for (let j = 0; j < slot.cells.length; j++) {
              const cell = slot.cells[j];
              const cur = grid[cell.r][cell.c];
              if (cur !== "" && cur !== cand.answer[j]) return false;
            }
            return true;
          });

          if (viable.length === 0) return null;

          viable.sort((a, b) => {
            if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
            const aSource = a.source === "anchor" ? 3 : a.source === "model" ? 2 : 1;
            const bSource = b.source === "anchor" ? 3 : b.source === "model" ? 2 : 1;
            if (aSource !== bSource) return bSource - aSource;
            return 0;
          });

          if (
            bestSlotIndex === -1 ||
            viable.length < bestWords.length ||
            (viable.length === bestWords.length && slotIntersections[i] > slotIntersections[bestSlotIndex])
          ) {
            bestSlotIndex = i;
            bestWords = viable;
          }
        }

        if (bestSlotIndex === -1) {
          return { grid, assignments };
        }

        const slot = slots[bestSlotIndex];
        const thematicChoices = bestWords.filter((candidate) => candidate.thematic).slice(0, 40);
        const fillerChoices = bestWords.filter((candidate) => !candidate.thematic).slice(0, 240);
        const candidatesToTry = [...thematicChoices, ...fillerChoices];

        for (const cand of candidatesToTry) {
          const nextGrid = grid.map((row) => row.slice());
          for (let j = 0; j < slot.cells.length; j++) {
            const cell = slot.cells[j];
            nextGrid[cell.r][cell.c] = cand.answer[j];
          }

          const nextAssignments = assignments.slice();
          nextAssignments[bestSlotIndex] = cand.answer;
          const nextUsed = new Set(used);
          nextUsed.add(cand.answer);

          const solved = search(
            nextGrid,
            nextAssignments,
            nextUsed,
            thematicCount + (cand.thematic ? 1 : 0)
          );
          if (solved) return solved;
        }

        return null;
      };

      let searchStates = 0;
      const solved = search(
        baseGrid as Cell[][],
        Array(slots.length).fill(null),
        new Set<string>(),
        0
      );

      if (!solved) continue;

      const finalGrid = solved.grid.map((row) =>
        row.map((cell) => {
          if (cell === "#") return "#";
          return typeof cell === "string" && cell.length === 1 ? cell : "#";
        })
      );
      const derived = deriveEntriesFromGrid(finalGrid, minEntryLenForSize(size));

      if (derived.length !== slots.length) continue;
      if (derived.length < minPublishEntriesForSize(size)) continue;

      const assignedAnswers = solved.assignments.filter((a): a is string => Boolean(a));
      const thematicCount = assignedAnswers.filter((answer) =>
        usable.find((candidate) => candidate.answer === answer)?.thematic
      ).length;
      console.warn("[pattern-11x11] solved", {
        slots: slots.length,
        thematic: thematicCount,
        lengths: Object.fromEntries(
          assignedAnswers.reduce((counts, answer) => {
            counts.set(answer.length, (counts.get(answer.length) ?? 0) + 1);
            return counts;
          }, new Map<number, number>())
        ),
      });
      if (!bestForPattern || thematicCount > bestForPattern.thematicCount) {
        bestForPattern = {
          grid: finalGrid,
          usedAnswers: assignedAnswers,
          thematicCount,
          patternVariant: variant,
        };
      }
    }
    if (bestForPattern) {
      return {
        grid: bestForPattern.grid,
        usedAnswers: bestForPattern.usedAnswers,
        meta: {
          builder: "pattern-11x11",
          slotCount: slots.length,
          patternRows: pattern,
          patternVariant: bestForPattern.patternVariant,
          thematicCount: bestForPattern.thematicCount,
        },
      };
    }
  }

  console.warn("[pattern-11x11] no fill", {
    candidates: usable.length,
    patterns: rankedPatterns.length,
    byLength: Object.fromEntries(
      Array.from(totalByLen.entries()).map(([length, words]) => [length, words.length])
    ),
  });
  return null;
}

function constructCompactPatternCrossword11(opts: LegacyBuilderRunOptions): LegacyBuilderResult | null {
  const { theme, size, candidates, seed, deadlineMs, dependencies } = opts;
  const {
    asciiAnswerPattern: ASCII_A_TO_Z,
    deriveEntriesFromGrid,
    entryCrossingStats,
    extractPatternSlots,
    hasShortLetterRuns,
    isForbiddenPublishAnswer,
    isOverGenericThemeWordForTheme,
    makeSeededRng,
    minCrossingsPerEntryForPublish,
    minEntryLenForSize,
    minPublishEntriesForSize,
    patterns11: PATTERN_11X11S,
    shuffleInPlace,
  } = dependencies;
  if (size !== 11) return null;

  const minLen = minEntryLenForSize(size);
  const nowOk = () => !deadlineMs || Date.now() <= deadlineMs;
  const usable = candidates
    .filter((c) => c.answer.length >= minLen && c.answer.length <= size)
    .filter((c) => ASCII_A_TO_Z.test(c.answer))
    .filter((c) => !isForbiddenPublishAnswer(c.answer))
    .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer));

  if (usable.length < minPublishEntriesForSize(size)) return null;

  const totalByLen = new Map<number, WordCandidate[]>();
  const thematicByLen = new Map<number, WordCandidate[]>();
  for (const cand of usable) {
    const total = totalByLen.get(cand.answer.length) ?? [];
    total.push(cand);
    totalByLen.set(cand.answer.length, total);
    if (cand.thematic) {
      const thematic = thematicByLen.get(cand.answer.length) ?? [];
      thematic.push(cand);
      thematicByLen.set(cand.answer.length, thematic);
    }
  }

  console.warn("[compact-pattern-11] start", {
    candidates: usable.length,
    thematic: usable.filter((candidate) => candidate.thematic).length,
    lenCount: Object.fromEntries(
      Array.from(totalByLen.entries()).map(([len, items]) => [len, items.length])
    ),
    minEntries: minPublishEntriesForSize(size),
    minCrossings: minCrossingsPerEntryForPublish(size),
  });

  const sourceRank = (candidate: WordCandidate) =>
    candidate.source === "anchor" ? 4 : candidate.source === "model" ? 3 : candidate.source === "support" ? -2 : 1;

  const wordRank = (candidate: WordCandidate) =>
    (candidate.thematic ? 40000 : 0) + sourceRank(candidate) * 1000 + Math.min(candidate.answer.length, 11);

  for (const [len, items] of totalByLen) {
    totalByLen.set(
      len,
      items.slice().sort((a, b) => wordRank(b) - wordRank(a) || a.answer.localeCompare(b.answer))
    );
  }

  const slotCrossCount = (slots: PatternSlot[], slotIndex: number, selected: Set<number>) => {
    const slot = slots[slotIndex];
    let count = 0;
    for (const otherIndex of selected) {
      if (otherIndex === slotIndex) continue;
      const other = slots[otherIndex];
      if (!other || other.direction === slot.direction) continue;
      if (slot.cells.some((cell) => other.cells.some((otherCell) => otherCell.r === cell.r && otherCell.c === cell.c))) {
        count++;
      }
    }
    return count;
  };

  const slotDegree = (slots: PatternSlot[], slotIndex: number) => {
    const all = new Set(slots.map((_, i) => i).filter((i) => i !== slotIndex));
    return slotCrossCount(slots, slotIndex, all);
  };

  const buildMaskPattern = (slots: PatternSlot[], selected: Set<number>) => {
    const mask = Array.from({ length: size }, () => Array(size).fill("#"));
    for (const idx of selected) {
      for (const cell of slots[idx].cells) mask[cell.r][cell.c] = ".";
    }
    return mask.map((row) => row.join(""));
  };

  const candidatePoolForSlots = (slots: PatternSlot[], rng: () => number) => {
    const byLen = new Map<number, WordCandidate[]>();
    for (const slot of slots) {
      if (byLen.has(slot.len)) continue;
      const ordered = (totalByLen.get(slot.len) ?? []).slice();
      shuffleInPlace(ordered, rng);
      ordered.sort((a, b) => wordRank(b) - wordRank(a) || a.answer.localeCompare(b.answer));
      byLen.set(slot.len, ordered);
    }
    return byLen;
  };

  const solveSlots = (
    slots: PatternSlot[],
    patternRows: string[],
    candidateByLen: Map<number, WordCandidate[]>
  ): { grid: string[][]; assignments: Array<string | null> } | null => {
    const baseGrid = patternRows.map((row) => row.split("").map((ch) => (ch === "#" ? "#" : ""))) as Cell[][];
    const slotIntersections = slots.map((slot, idx) => {
      const selected = new Set(slots.map((_, i) => i).filter((i) => i !== idx));
      return slotCrossCount(slots, idx, selected);
    });

    const search = (
      grid: Cell[][],
      assignments: Array<string | null>,
      used: Set<string>,
      states: { count: number }
    ): { grid: Cell[][]; assignments: Array<string | null> } | null => {
      if (!nowOk()) return null;
      states.count++;
      if (states.count > 900000) return null;

      let bestSlotIndex = -1;
      let bestWords: WordCandidate[] = [];

      for (let i = 0; i < slots.length; i++) {
        if (assignments[i]) continue;
        const slot = slots[i];
        const viable = (candidateByLen.get(slot.len) ?? []).filter((cand) => {
          if (used.has(cand.answer)) return false;
          for (let j = 0; j < slot.cells.length; j++) {
            const cell = slot.cells[j];
            const cur = grid[cell.r][cell.c];
            if (cur !== "" && cur !== cand.answer[j]) return false;
          }
          return true;
        });

        if (viable.length === 0) return null;
        if (
          bestSlotIndex === -1 ||
          viable.length < bestWords.length ||
          (viable.length === bestWords.length && slotIntersections[i] > slotIntersections[bestSlotIndex])
        ) {
          bestSlotIndex = i;
          bestWords = viable;
        }
      }

      if (bestSlotIndex === -1) {
        return {
          grid: grid.map((row) => row.map((cell) => (cell === "#" ? "#" : String(cell)))) as string[][],
          assignments,
        };
      }

      const slot = slots[bestSlotIndex];
        for (const cand of bestWords.slice(0, 260)) {
        const nextGrid = grid.map((row) => row.slice());
        for (let j = 0; j < slot.cells.length; j++) {
          const cell = slot.cells[j];
          nextGrid[cell.r][cell.c] = cand.answer[j];
        }
        const nextAssignments = assignments.slice();
        nextAssignments[bestSlotIndex] = cand.answer;
        const nextUsed = new Set(used);
        nextUsed.add(cand.answer);
        const solved = search(nextGrid, nextAssignments, nextUsed, states);
        if (solved) return solved;
      }

      return null;
    };

    return search(baseGrid, Array(slots.length).fill(null), new Set<string>(), { count: 0 });
  };

  const slotFitScore = (slot: PatternSlot) => {
    const total = totalByLen.get(slot.len)?.length ?? 0;
    const thematic = thematicByLen.get(slot.len)?.length ?? 0;
    const lengthFit =
      slot.len >= 4 && slot.len <= 7
        ? 6000
        : slot.len === 8
        ? 3200
        : slot.len === 3
        ? 1500
        : -4500;
    return lengthFit + Math.min(thematic, 14) * 260 + Math.min(total, 28) * 80;
  };

  const targetCounts = [15, 16, 17, 18];
  let masksWithEnoughSlots = 0;
  let masksWithCrossings = 0;
  let masksWithLengthSupply = 0;
  let solvedAttempts = 0;
  let firstLengthCompatibleMask: { rows: string[]; lengths: Record<number, number> } | null = null;
  for (const targetSlotCount of targetCounts) {
    for (let patternIdx = 0; patternIdx < PATTERN_11X11S.length; patternIdx++) {
      if (!nowOk()) return null;
      const pattern = PATTERN_11X11S[patternIdx];
      const fullSlots = extractPatternSlots(pattern);
      const availableSlotIndexes = fullSlots
        .map((slot, idx) => ({ slot, idx }))
        .filter(({ slot }) => (totalByLen.get(slot.len)?.length ?? 0) > 0)
        .map(({ idx }) => idx);

      if (availableSlotIndexes.length < targetSlotCount) continue;

      for (let variant = 0; variant < 360; variant++) {
        if (!nowOk()) return null;
        const rng = makeSeededRng((seed + targetSlotCount * 1009 + patternIdx * 104729 + variant * 2654435761) >>> 0);
        const selected = new Set<number>();
        const orderedSeeds = availableSlotIndexes
          .slice()
          .sort((a, b) => slotFitScore(fullSlots[b]) - slotFitScore(fullSlots[a]) || slotDegree(fullSlots, b) - slotDegree(fullSlots, a));
        shuffleInPlace(orderedSeeds, rng);
        orderedSeeds.sort((a, b) => slotFitScore(fullSlots[b]) - slotFitScore(fullSlots[a]) || slotDegree(fullSlots, b) - slotDegree(fullSlots, a));
        selected.add(orderedSeeds[0]);

        while (selected.size < targetSlotCount) {
          const choices = availableSlotIndexes.filter((idx) => !selected.has(idx));
          if (choices.length === 0) break;
          const ranked = choices
            .map((idx) => {
              const crosses = slotCrossCount(fullSlots, idx, selected);
              const thematic = thematicByLen.get(fullSlots[idx].len)?.length ?? 0;
              const total = totalByLen.get(fullSlots[idx].len)?.length ?? 0;
              return {
                idx,
                score:
                  crosses * 10000 +
                  slotFitScore(fullSlots[idx]) +
                  Math.min(thematic, 12) * 250 +
                  Math.min(total, 20) * 60 +
                  slotDegree(fullSlots, idx) * 120 +
                  rng(),
              };
            })
            .sort((a, b) => b.score - a.score);
          selected.add(ranked[0].idx);
        }

        for (let repair = 0; repair < 6; repair++) {
          const weak = Array.from(selected).filter(
            (idx) => slotCrossCount(fullSlots, idx, selected) < minCrossingsPerEntryForPublish(size)
          );
          if (weak.length === 0) break;
          const additions = availableSlotIndexes
            .filter((idx) => !selected.has(idx))
            .map((idx) => ({
              idx,
              score:
                weak.filter((weakIdx) => {
                  const probe = new Set(selected);
                  probe.add(idx);
                  return slotCrossCount(fullSlots, weakIdx, probe) > slotCrossCount(fullSlots, weakIdx, selected);
                }).length *
                  10000 +
                slotCrossCount(fullSlots, idx, selected) * 1000 +
                (thematicByLen.get(fullSlots[idx].len)?.length ?? 0) * 50,
            }))
            .sort((a, b) => b.score - a.score);
          if (additions.length === 0 || additions[0].score <= 0 || selected.size >= 18) break;
          selected.add(additions[0].idx);
        }

        if (selected.size < targetSlotCount || selected.size > 18) continue;
        masksWithEnoughSlots++;
        if (
          Array.from(selected).some(
            (idx) => slotCrossCount(fullSlots, idx, selected) < minCrossingsPerEntryForPublish(size)
          )
        ) {
          continue;
        }
        masksWithCrossings++;

        const maskPattern = buildMaskPattern(fullSlots, selected);
        if (hasShortLetterRuns(maskPattern.map((row) => row.split("")), minLen)) continue;
        const compactSlots = extractPatternSlots(maskPattern);
        if (compactSlots.length < minPublishEntriesForSize(size) || compactSlots.length > 18) continue;
        const allCompactSlotsCrossed = compactSlots.every((_, idx) => {
          const others = new Set(compactSlots.map((__, i) => i).filter((i) => i !== idx));
          return slotCrossCount(compactSlots, idx, others) >= minCrossingsPerEntryForPublish(size);
        });
        if (!allCompactSlotsCrossed) continue;

        const candidateByLen = candidatePoolForSlots(compactSlots, rng);
        if (compactSlots.some((slot) => (candidateByLen.get(slot.len)?.length ?? 0) === 0)) continue;
        const needByLen = new Map<number, number>();
        for (const slot of compactSlots) {
          needByLen.set(slot.len, (needByLen.get(slot.len) ?? 0) + 1);
        }
        if (
          Array.from(needByLen).some(
            ([len, need]) => (candidateByLen.get(len)?.length ?? 0) < need
          )
        ) {
          continue;
        }
        masksWithLengthSupply++;
        if (!firstLengthCompatibleMask) {
          firstLengthCompatibleMask = {
            rows: maskPattern,
            lengths: Object.fromEntries(needByLen),
          };
          console.warn("[compact-pattern-11] first length-compatible mask", firstLengthCompatibleMask);
        }

        const solved = solveSlots(compactSlots, maskPattern, candidateByLen);
        if (!solved) continue;
        solvedAttempts++;

        const finalGrid = solved.grid.map((row) =>
          row.map((cell) => (cell === "#" ? "#" : typeof cell === "string" && cell.length === 1 ? cell : "#"))
        );
        const derived = deriveEntriesFromGrid(finalGrid, minLen);
        if (derived.length < minPublishEntriesForSize(size) || derived.length > 18) continue;
        if (hasShortLetterRuns(finalGrid, minLen)) continue;
        const crossings = entryCrossingStats(finalGrid, derived, minLen);
        if (crossings.weakEntries.length > 0) continue;

        const assignedAnswers = solved.assignments.filter((answer): answer is string => Boolean(answer));
        return {
          grid: finalGrid,
          usedAnswers: assignedAnswers,
          meta: {
            builder: "compact-pattern-11x11",
            slotCount: compactSlots.length,
            targetSlotCount,
            patternVariant: variant,
            patternRows: maskPattern,
            minEntryCheckedCells: crossings.minCheckedCells,
          },
        };
      }
    }
  }

  console.warn("[compact-pattern-11] exhausted", {
    candidates: usable.length,
    lenCount: Object.fromEntries(
      Array.from(totalByLen.entries()).map(([len, items]) => [len, items.length])
    ),
    masksWithEnoughSlots,
    masksWithCrossings,
    masksWithLengthSupply,
    solvedAttempts,
    firstLengthCompatibleMask,
  });
  return null;
}

function constructBeamCrossword11(opts: LegacyBuilderRunOptions): LegacyBuilderResult | null {
  const { theme, size, seed, deadlineMs, dependencies } = opts;
  const {
    asciiAnswerPattern: ASCII_A_TO_Z,
    canPlaceWord,
    crosswordDensityFromGrid,
    deriveEntriesFromGrid,
    entryCrossingStats,
    gridToStrings,
    hasShortLetterRuns,
    isAcceptable,
    isForbiddenPublishAnswer,
    isOverGenericThemeWordForTheme,
    makeEmptyWorkingGrid,
    makeSeededRng,
    minCoreThematicEntriesForPublish,
    minEntryLenForSize,
    minPublishEntriesForSize,
    paintBlocks,
    placeWord,
    shuffleInPlace,
  } = dependencies;
  if (size !== 11) return null;

  const minLen = minEntryLenForSize(size);
  const nowOk = () => !deadlineMs || Date.now() <= deadlineMs;
  const rng = makeSeededRng(seed);
  const sourceRank = (candidate: WordCandidate) =>
    candidate.source === "anchor" ? 4 : candidate.source === "model" ? 3 : candidate.source === "support" ? -2 : 1;
  const wordRank = (candidate: WordCandidate) => {
    const len = candidate.answer.length;
    const lengthScore = len >= 4 && len <= 8 ? 80 - Math.abs(6 - len) * 6 : 40 - Math.abs(7 - len);
    return (candidate.thematic ? 40000 : 0) + sourceRank(candidate) * 800 + lengthScore;
  };

  const candidates = Array.from(
    new Map(
      opts.candidates
        .filter((c) => c.answer.length >= minLen && c.answer.length <= size)
        .filter((c) => ASCII_A_TO_Z.test(c.answer))
        .filter((c) => !isForbiddenPublishAnswer(c.answer))
        .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer))
        .sort((a, b) => wordRank(b) - wordRank(a) || a.answer.localeCompare(b.answer))
        .map((c) => [c.answer, c] as const)
    ).values()
  ).slice(0, 130);

  const themeSet = new Set(candidates.filter((c) => c.thematic).map((c) => c.answer));
  const allowedSet = new Set(candidates.map((c) => c.answer));
  if (themeSet.size < minCoreThematicEntriesForPublish(size, minPublishEntriesForSize(size))) {
    console.warn("[beam-11x11] skip: not enough thematic candidates", {
      candidates: candidates.length,
      thematic: themeSet.size,
    });
    return null;
  }

  type BeamState = {
    grid: Cell[][];
    placed: Placement[];
    used: Set<string>;
    score: number;
  };

  const cellsForPlacement = (placement: Placement) =>
    Array.from({ length: placement.word.length }, (_, i) => ({
      r: placement.dir === "across" ? placement.row : placement.row + i,
      c: placement.dir === "across" ? placement.col + i : placement.col,
    }));

  const overlapsSameDirection = (placement: Placement, placed: Placement[]) => {
    const cells = new Set(cellsForPlacement(placement).map((cell) => `${cell.r},${cell.c}`));
    return placed.some((existing) => {
      if (existing.dir !== placement.dir) return false;
      return cellsForPlacement(existing).some((cell) => cells.has(`${cell.r},${cell.c}`));
    });
  };

  const cloneGrid = (grid: Cell[][]) => grid.map((row) => row.slice()) as Cell[][];

  const finalFromState = (state: BeamState) => {
    const finalGrid = gridToStrings(paintBlocks(state.grid) as (string | null)[][]);
    const derived = deriveEntriesFromGrid(finalGrid, minLen);
    return { finalGrid, derived };
  };

  const finalScore = (state: BeamState) => {
    const { finalGrid, derived } = finalFromState(state);
    const invalidEntries = derived.filter(
      (entry) => !allowedSet.has(entry.answer) || isForbiddenPublishAnswer(entry.answer)
    ).length;
    const shortRunPenalty = hasShortLetterRuns(finalGrid, minLen) ? 50000 : 0;

    const crossings = entryCrossingStats(finalGrid, derived, minLen);
    const themed = derived.filter((entry) => themeSet.has(entry.answer)).length;
    const across = derived.filter((entry) => entry.direction === "across").length;
    const down = derived.length - across;
    const density = crosswordDensityFromGrid(finalGrid);
    const weakPenalty =
      crossings.weakEntries.length *
      (derived.length >= minPublishEntriesForSize(size) ? 100000 : 1800);

    return (
      derived.length * 14500 +
      state.placed.length * 4200 +
      Math.min(themed, derived.length) * 18000 +
      Math.min(across, down) * 4500 +
      density * 8000 +
      crossings.minCheckedCells * 3000 -
      weakPenalty -
      invalidEntries * 35000 -
      shortRunPenalty
    );
  };

  const buildSeedStates = () => {
    const seedWords = candidates
      .filter((c) => c.thematic)
      .filter((c) => c.answer.length >= 5 && c.answer.length <= 9)
      .slice(0, 24);
    const states: BeamState[] = [];

    for (const candidate of seedWords) {
      for (const dir of ["across", "down"] as Direction[]) {
        const row = dir === "across" ? Math.floor(size / 2) : Math.floor((size - candidate.answer.length) / 2);
        const col = dir === "across" ? Math.floor((size - candidate.answer.length) / 2) : Math.floor(size / 2);
        const grid = makeEmptyWorkingGrid(size);
        const wrote = placeWord(grid, candidate.answer, row, col, dir);
        if (!wrote) continue;
        states.push({
          grid,
          placed: [{ word: candidate.answer, row, col, dir }],
          used: new Set([candidate.answer]),
          score: wordRank(candidate),
        });
      }
    }

    shuffleInPlace(states, rng);
    return states.slice(0, 22);
  };

  const candidatePlacements = (state: BeamState) => {
    const out: Array<{ candidate: WordCandidate; placement: Placement; crossings: number; score: number }> = [];

    for (const candidate of candidates) {
      if (state.used.has(candidate.answer)) continue;
      for (const existing of state.placed) {
        const dir: Direction = existing.dir === "across" ? "down" : "across";
        for (let existingIndex = 0; existingIndex < existing.word.length; existingIndex++) {
          const ch = existing.word[existingIndex];
          const crossR = existing.dir === "across" ? existing.row : existing.row + existingIndex;
          const crossC = existing.dir === "across" ? existing.col + existingIndex : existing.col;
          for (let candidateIndex = 0; candidateIndex < candidate.answer.length; candidateIndex++) {
            if (candidate.answer[candidateIndex] !== ch) continue;
            const row = dir === "across" ? crossR : crossR - candidateIndex;
            const col = dir === "across" ? crossC - candidateIndex : crossC;
            const placement = { word: candidate.answer, row, col, dir };
            if (overlapsSameDirection(placement, state.placed)) continue;
            const check = canPlaceWord(state.grid, candidate.answer, row, col, dir);
            if (!check.ok || check.crossings < 1) continue;

            const mid = (size - 1) / 2;
            const centerR = dir === "down" ? row + (candidate.answer.length - 1) / 2 : row;
            const centerC = dir === "across" ? col + (candidate.answer.length - 1) / 2 : col;
            const centerPenalty = Math.abs(centerR - mid) + Math.abs(centerC - mid);
            const score =
              wordRank(candidate) +
              check.crossings * 5200 +
              (candidate.answer.length >= 4 && candidate.answer.length <= 8 ? 1700 : 0) -
              centerPenalty * 90;
            out.push({ candidate, placement, crossings: check.crossings, score });
          }
        }
      }
    }

    out.sort((a, b) => b.score - a.score || b.crossings - a.crossings);
    return out.slice(0, 420);
  };

  let beam = buildSeedStates();
  console.warn("[beam-11x11] start", {
    candidates: candidates.length,
    thematic: themeSet.size,
    seeds: beam.length,
  });
  let best: BeamState | null = null;
  let bestScore = -Infinity;
  let expanded = 0;
  const beamWidth = 260;
  const maxExpanded = 12000;

  for (let depth = 1; depth < 20 && beam.length > 0 && nowOk(); depth++) {
    const next: BeamState[] = [];

    for (const state of beam) {
      if (!nowOk() || expanded >= maxExpanded) break;
      expanded++;

      const score = finalScore(state);
      if (score > bestScore) {
        bestScore = score;
        best = state;
      }

      for (const option of candidatePlacements(state)) {
        const nextGrid = cloneGrid(state.grid);
        const wrote = placeWord(nextGrid, option.candidate.answer, option.placement.row, option.placement.col, option.placement.dir);
        if (!wrote) continue;
        const nextUsed = new Set(state.used);
        nextUsed.add(option.candidate.answer);
        next.push({
          grid: nextGrid,
          placed: state.placed.concat(option.placement),
          used: nextUsed,
          score: state.score + option.score,
        });
      }
    }

    next.sort((a, b) => {
      const finalDiff = finalScore(b) - finalScore(a);
      if (finalDiff !== 0) return finalDiff;
      return b.score - a.score;
    });
    beam = next.slice(0, beamWidth);
  }

  const finalists = best ? [best, ...beam] : beam;
  finalists.sort((a, b) => finalScore(b) - finalScore(a));

  for (const state of finalists.slice(0, 90)) {
    const { finalGrid, derived } = finalFromState(state);
    if (derived.some((entry) => !allowedSet.has(entry.answer))) continue;
    if (derived.some((entry) => isForbiddenPublishAnswer(entry.answer))) continue;
    if (!isAcceptable(finalGrid, derived, themeSet)) continue;
    const crossings = entryCrossingStats(finalGrid, derived, minLen);
    const usedAnswers = derived.map((entry) => entry.answer);
    return {
      grid: finalGrid,
      usedAnswers,
      meta: {
        builder: "beam-11x11",
        placedWords: state.placed.length,
        expanded,
        minEntryCheckedCells: crossings.minCheckedCells,
      },
    };
  }

  if (best) {
    const { finalGrid, derived } = finalFromState(best);
    const crossings = entryCrossingStats(finalGrid, derived, minLen);
    console.warn("[beam-11x11] no acceptable finalist", {
      expanded,
      finalists: finalists.length,
      bestEntries: derived.length,
      bestThematic: derived.filter((entry) => themeSet.has(entry.answer)).length,
      bestWeakEntries: crossings.weakEntries.length,
      bestDensity: crosswordDensityFromGrid(finalGrid),
      bestAnswers: derived.map((entry) => entry.answer),
    });
  } else {
    console.warn("[beam-11x11] no states expanded", { expanded });
  }

  return null;
}

function constructStrictCrossword11(opts: LegacyBuilderRunOptions): LegacyBuilderResult | null {
  const { theme, size, candidates, seed, deadlineMs, dependencies } = opts;
  const {
    deriveEntriesFromGrid,
    isOverGenericThemeWordForTheme,
    minEntryLenForSize,
    minPublishEntriesForSize,
  } = dependencies;
  if (size !== 11) return null;

  const cleanCandidates = candidates.filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer));
  const thematicCore = cleanCandidates.filter((c) => c.thematic);
  const limitedShortSupport = cleanCandidates
    .filter(
      (c) =>
        !c.thematic &&
        c.source === "support" &&
        c.answer.length >= minEntryLenForSize(size) + 1 &&
        c.answer.length <= 7
    )
    .slice(0, Math.max(3, Math.floor(thematicCore.length / 4)));
  const thematicCoreWithLimitedSupport = [...thematicCore, ...limitedShortSupport];
  const thematicPlusSupport = cleanCandidates.filter(
    (c) => c.thematic || c.source === "support" || c.source === "anchor" || c.source === "model"
  );

  const candidatePools = [
    thematicCore,
    thematicCoreWithLimitedSupport,
    thematicPlusSupport,
    cleanCandidates,
  ].filter((pool, idx, arr) => pool.length > 0 && arr.findIndex((other) => other === pool) === idx);

  const preferredPatternDeadlineMs = deadlineMs
    ? Math.min(deadlineMs, Date.now() + 20_000)
    : Date.now() + 20_000;
  const preferredPattern = constructPatternCrossword11({
    theme,
    size,
    candidates: cleanCandidates,
    seed: (seed ^ 0x243f6a88) >>> 0,
    deadlineMs: preferredPatternDeadlineMs,
    dependencies,
  });
  if (preferredPattern) return preferredPattern;

  const seedVariants = 4;
  const childDeadline = (sliceMs: number) => {
    const localDeadline = Date.now() + sliceMs;
    return deadlineMs ? Math.min(deadlineMs, localDeadline) : localDeadline;
  };
  const hasTimeFor = (sliceMs: number) => !deadlineMs || Date.now() < deadlineMs - sliceMs;

  for (let poolIdx = 0; poolIdx < candidatePools.length; poolIdx++) {
    const pool = candidatePools[poolIdx];
    for (let variant = 0; variant < seedVariants; variant++) {
      if (!hasTimeFor(500)) return null;
      const variantSeed = (seed + variant * 2654435761 + poolIdx * 104729) >>> 0;
      const compactDeadlineMs = childDeadline(4_500);
      const compactBuilt =
        Date.now() < compactDeadlineMs - 100
          ? constructCompactPatternCrossword11({
              theme,
              size,
              candidates: pool,
              seed: variantSeed,
              deadlineMs: compactDeadlineMs,
              dependencies,
            })
          : null;

      const beamDeadlineMs = childDeadline(4_500);
      const beamBuilt =
        !compactBuilt && variant === 0 && Date.now() < beamDeadlineMs - 100
          ? constructBeamCrossword11({
              theme,
              size,
              candidates: pool,
              seed: variantSeed,
              deadlineMs: beamDeadlineMs,
              dependencies,
            })
          : null;

      const patternDeadlineMs = childDeadline(3_000);
      const patternBuilt =
        !compactBuilt && !beamBuilt && Date.now() < patternDeadlineMs - 100
          ? constructPatternCrossword11({
              theme,
              size,
              candidates: pool,
              seed: variantSeed,
              deadlineMs: patternDeadlineMs,
              dependencies,
            })
          : null;

      const greedyDeadlineMs = childDeadline(3_500);
      const greedyBuilt =
        !compactBuilt && !beamBuilt && !patternBuilt && Date.now() < greedyDeadlineMs - 100
          ? constructGreedyCheckedCrossword11({
              theme,
              size,
              candidates: pool,
              seed: variantSeed,
              deadlineMs: greedyDeadlineMs,
              dependencies,
            })
          : null;

      const built =
        compactBuilt ?? beamBuilt ?? patternBuilt ?? greedyBuilt;
      if (!built) continue;
      const builtDerived = deriveEntriesFromGrid(built.grid, minEntryLenForSize(size));
      if (builtDerived.length < minPublishEntriesForSize(size)) continue;

      return {
        ...built,
        meta: {
          ...built.meta,
          builder: "pattern-11x11-strict",
          strictPoolVariant: poolIdx,
          strictSeedVariant: variant,
        },
      };
    }
  }

  return null;
}

function constructGreedyCheckedCrossword11(opts: LegacyBuilderRunOptions): LegacyBuilderResult | null {
  const { theme, size, seed, deadlineMs, dependencies } = opts;
  const {
    asciiAnswerPattern: ASCII_A_TO_Z,
    checkedCellStats,
    deriveEntriesFromGrid,
    desiredPublishEntriesForSize,
    entryCrossingStats,
    hasShortLetterRuns,
    inBounds,
    isForbiddenPublishAnswer,
    isOverGenericThemeWordForTheme,
    makeSeededRng,
    minEntryLenForSize,
    minPublishEntriesForSize,
    shuffleInPlace,
  } = dependencies;
  if (size !== 11) return null;

  const minLen = minEntryLenForSize(size);
  const allowed = new Set(
    opts.candidates
      .filter((candidate) => candidate.source !== "filler")
      .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
      .filter((candidate) => candidate.answer.length >= minLen && candidate.answer.length <= size)
      .filter((candidate) => ASCII_A_TO_Z.test(candidate.answer))
      .filter((candidate) => !isForbiddenPublishAnswer(candidate.answer))
      .map((candidate) => candidate.answer)
  );
  const byAnswer = new Map(opts.candidates.map((candidate) => [candidate.answer, candidate]));
  const words = Array.from(allowed).sort((a, b) => {
    const ca = byAnswer.get(a);
    const cb = byAnswer.get(b);
    const themeDelta = Number(Boolean(cb?.thematic)) - Number(Boolean(ca?.thematic));
    if (themeDelta !== 0) return themeDelta;
    return b.length - a.length;
  });

  if (words.length < minPublishEntriesForSize(size)) return null;

  type Placed = { answer: string; row: number; col: number; direction: Direction };
  type Placement = Placed & { score: number; crossings: number };

  const directions: Direction[] = ["across", "down"];
  const nowOk = (reserveMs = 0) => !deadlineMs || Date.now() < deadlineMs - reserveMs;

  const buildFinalGrid = (grid: (string | null)[][]): string[][] =>
    grid.map((row) => row.map((cell) => cell ?? "#"));

  const canPlace = (
    grid: (string | null)[][],
    answer: string,
    row: number,
    col: number,
    direction: Direction,
    requireCrossing: boolean
  ): { ok: boolean; crossings: number; crossedAnswers: Set<string> } => {
    const dr = direction === "down" ? 1 : 0;
    const dc = direction === "across" ? 1 : 0;
    const beforeR = row - dr;
    const beforeC = col - dc;
    const afterR = row + dr * answer.length;
    const afterC = col + dc * answer.length;

    if (!inBounds(size, row, col)) return { ok: false, crossings: 0, crossedAnswers: new Set() };
    if (!inBounds(size, row + dr * (answer.length - 1), col + dc * (answer.length - 1))) {
      return { ok: false, crossings: 0, crossedAnswers: new Set() };
    }
    if (inBounds(size, beforeR, beforeC) && grid[beforeR][beforeC]) {
      return { ok: false, crossings: 0, crossedAnswers: new Set() };
    }
    if (inBounds(size, afterR, afterC) && grid[afterR][afterC]) {
      return { ok: false, crossings: 0, crossedAnswers: new Set() };
    }

    let crossings = 0;
    const crossedAnswers = new Set<string>();

    for (let i = 0; i < answer.length; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      const existing = grid[r][c];
      const ch = answer[i];

      if (existing && existing !== ch) return { ok: false, crossings: 0, crossedAnswers };

      if (existing === ch) {
        crossings++;
        continue;
      }

      const side1R = r + (direction === "across" ? -1 : 0);
      const side1C = c + (direction === "down" ? -1 : 0);
      const side2R = r + (direction === "across" ? 1 : 0);
      const side2C = c + (direction === "down" ? 1 : 0);
      if (inBounds(size, side1R, side1C) && grid[side1R][side1C]) {
        return { ok: false, crossings: 0, crossedAnswers };
      }
      if (inBounds(size, side2R, side2C) && grid[side2R][side2C]) {
        return { ok: false, crossings: 0, crossedAnswers };
      }
    }

    if (requireCrossing && crossings === 0) return { ok: false, crossings: 0, crossedAnswers };
    return { ok: true, crossings, crossedAnswers };
  };

  const place = (grid: (string | null)[][], placed: Placed[], placement: Placed) => {
    const dr = placement.direction === "down" ? 1 : 0;
    const dc = placement.direction === "across" ? 1 : 0;
    for (let i = 0; i < placement.answer.length; i++) {
      grid[placement.row + dr * i][placement.col + dc * i] = placement.answer[i];
    }
    placed.push(placement);
  };

  let best:
    | {
        grid: string[][];
        derived: DerivedEntry[];
        score: number;
        usedAnswers: string[];
        weakEntries: number;
      }
    | null = null;

  const seedAttempts = Math.min(18, words.length);
  for (let attempt = 0; attempt < seedAttempts && nowOk(250); attempt++) {
    const rng = makeSeededRng((seed ^ Math.imul(attempt + 1, 0x9e3779b9)) >>> 0);
    const grid: (string | null)[][] = Array.from({ length: size }, () => Array<string | null>(size).fill(null));
    const placed: Placed[] = [];
    const used = new Set<string>();
    const starts = words.slice(0, Math.min(24, words.length));
    shuffleInPlace(starts, rng);
    const first = starts[0];
    if (!first) continue;

    const firstDirection: Direction = attempt % 2 === 0 ? "across" : "down";
    const firstRow = firstDirection === "across" ? Math.floor(size / 2) : Math.floor((size - first.length) / 2);
    const firstCol = firstDirection === "across" ? Math.floor((size - first.length) / 2) : Math.floor(size / 2);
    place(grid, placed, { answer: first, row: firstRow, col: firstCol, direction: firstDirection });
    used.add(first);

    for (let step = 0; step < 80 && placed.length < desiredPublishEntriesForSize(size) && nowOk(100); step++) {
      const placements: Placement[] = [];
      const ordered = words.filter((word) => !used.has(word));
      shuffleInPlace(ordered, rng);

      for (const answer of ordered.slice(0, 70)) {
        for (let r = 0; r < size; r++) {
          for (let c = 0; c < size; c++) {
            if (!grid[r][c]) continue;
            for (let i = 0; i < answer.length; i++) {
              if (answer[i] !== grid[r][c]) continue;
              for (const direction of directions) {
                const row = direction === "down" ? r - i : r;
                const col = direction === "across" ? c - i : c;
                const result = canPlace(grid, answer, row, col, direction, true);
                if (!result.ok) continue;
                const candidate = byAnswer.get(answer);
                const score =
                  result.crossings * 2400 +
                  (candidate?.thematic ? 900 : 0) +
                  Math.min(answer.length, 8) * 120 +
                  rng() * 50;
                placements.push({ answer, row, col, direction, score, crossings: result.crossings });
              }
            }
          }
        }
      }

      if (placements.length === 0) break;
      placements.sort((a, b) => b.score - a.score);
      const chosen = placements[Math.floor(rng() * Math.min(8, placements.length))];
      const confirm = canPlace(grid, chosen.answer, chosen.row, chosen.col, chosen.direction, true);
      if (!confirm.ok) continue;
      place(grid, placed, chosen);
      used.add(chosen.answer);
    }

    const finalGrid = buildFinalGrid(grid);
    const derived = deriveEntriesFromGrid(finalGrid, minLen);
    if (derived.some((entry) => !allowed.has(entry.answer))) continue;
    if (hasShortLetterRuns(finalGrid, minLen)) continue;
    const entryCrossings = entryCrossingStats(finalGrid, derived, minLen);
    const checked = checkedCellStats(finalGrid, minLen);
    const thematicEntries = derived.filter((entry) => byAnswer.get(entry.answer)?.thematic).length;
    const weakEntries = entryCrossings.weakEntries.length;
    const score =
      derived.length * 7000 +
      thematicEntries * 1300 +
      checked.ratio * 4000 -
      weakEntries * 25000;

    if (!best || score > best.score) {
      best = {
        grid: finalGrid,
        derived,
        score,
        usedAnswers: derived.map((entry) => entry.answer),
        weakEntries,
      };
    }

    if (derived.length >= minPublishEntriesForSize(size) && weakEntries === 0) {
      return {
        grid: finalGrid,
        usedAnswers: derived.map((entry) => entry.answer),
        meta: {
          builder: "greedy-checked-11",
          attempts: attempt + 1,
          checkedRatio: checked.ratio,
          minEntryCheckedCells: entryCrossings.minCheckedCells,
        },
      };
    }
  }

  if (best) {
    console.warn("[greedy-checked-11] no acceptable finalist", {
      bestEntries: best.derived.length,
      bestWeakEntries: best.weakEntries,
      bestAnswers: best.usedAnswers,
    });
  }

  return null;
}


export function runLegacyBuilder(input: LegacyBuilderInput): LegacyBuilderResult | null {
  switch (input.mode) {
    case "pattern-11":
      return constructPatternCrossword11(input);
    case "compact-pattern-11":
      return constructCompactPatternCrossword11(input);
    case "beam-11":
      return constructBeamCrossword11(input);
    case "strict-11":
      return constructStrictCrossword11(input);
    case "greedy-checked-11":
      return constructGreedyCheckedCrossword11(input);
    default: {
      const exhaustive: never = input.mode;
      return exhaustive;
    }
  }
}
