import type { Crossword, DerivedEntry, Direction, WordCandidate } from "@/app/lib/crosswordTypes";
import { ASCII_A_TO_Z, inBounds, normalizeAnswer, safeJson } from "@/app/lib/crosswordUtils";
import {
  blockShortRunsOnly,
  checkedCellStats,
  crosswordDensityFromGrid,
  desiredPublishEntriesForSize,
  entryCrossingStats,
  hasShortLetterRuns,
  minEntryLenForSize,
  minPublishEntriesForSize,
} from "@/app/lib/gridValidation";
import {
  rebuildGridFromEntries,
  rebuildGridFromEntriesAllowingAllowedDerived,
} from "@/app/lib/gridReconstruction";
import type {
  OpenAiRepairChatClient,
  OpenAiRepairClueRequestItem,
  OpenAiRepairServicesDependencies,
} from "./openaiRepairTypes";

export async function generatePatternMatchedRepairWords(opts: {
  client: OpenAiRepairChatClient;
  theme: string;
  language: "es" | "en";
  grid: string[][];
  entries: DerivedEntry[];
  existingAnswers: string[];
  dependencies: OpenAiRepairServicesDependencies;
}) {
  const { client, theme, language, grid, entries, existingAnswers } = opts;
  const deps = opts.dependencies;
  const size = 11;
  const weakStats = entryCrossingStats(grid, entries, minEntryLenForSize(size));
  const weakAnswers = new Set(weakStats.weakEntries.map((entry) => entry.answer));
  const weakCells = new Set<string>();
  const cellEntries = new Map<string, Array<{ answer: string; direction: Direction }>>();
  for (const entry of entries) {
    for (let i = 0; i < entry.answer.length; i++) {
      const r = entry.direction === "down" ? entry.row + i : entry.row;
      const c = entry.direction === "across" ? entry.col + i : entry.col;
      const key = `${r},${c}`;
      const owners = cellEntries.get(key) ?? [];
      owners.push({ answer: entry.answer, direction: entry.direction });
      cellEntries.set(key, owners);
      if (weakAnswers.has(entry.answer)) weakCells.add(key);
    }
  }

  const patternScores = new Map<string, number>();
  for (const direction of ["across", "down"] as const) {
    for (let len = 3; len <= 8; len++) {
      const maxRow = direction === "down" ? size - len : size - 1;
      const maxCol = direction === "across" ? size - len : size - 1;
      for (let row = 0; row <= maxRow; row++) {
        for (let col = 0; col <= maxCol; col++) {
          let fixed = 0;
          let open = 0;
          let weakCrossings = 0;
          let pattern = "";
          let overlapsSameDirection = false;
          const crossedAnswers = new Set<string>();
          for (let i = 0; i < len; i++) {
            const r = direction === "down" ? row + i : row;
            const c = direction === "across" ? col + i : col;
            const cell = grid[r][c];
            if (cell === "#") {
              pattern += "?";
              open++;
            } else {
              pattern += cell;
              fixed++;
              const key = `${r},${c}`;
              const owners = cellEntries.get(key) ?? [];
              if (owners.some((owner) => owner.direction === direction)) {
                overlapsSameDirection = true;
                break;
              }
              for (const owner of owners) crossedAnswers.add(owner.answer);
              if (weakCells.has(key)) weakCrossings++;
            }
          }
          if (
            overlapsSameDirection ||
            fixed < 2 ||
            open < 1 ||
            weakCrossings < 1 ||
            crossedAnswers.size < 2
          ) {
            continue;
          }
          const score = weakCrossings * 1000 + fixed * 100 - open;
          patternScores.set(pattern, Math.max(patternScores.get(pattern) ?? 0, score));
        }
      }
    }
  }

  const patterns = Array.from(patternScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 32)
    .map(([pattern]) => pattern);
  if (patterns.length === 0) return [];

  const prompt = `
Return ONLY JSON:
{"matches":[{"pattern":"?U?T?","answers":["..."]}]}

For every PATTERN, propose up to 8 real crossword answers that match it exactly.
"?" means any single uppercase A-Z letter; fixed letters must stay in the same positions.

Rules:
- Answers must be complete, correctly spelled words or names.
- Prefer specific entries from THEME.
- Context words are allowed only when a concrete clue can explicitly connect them to THEME.
- No abbreviations, codes, fragments, clipped names, invented compounds, or altered titles.
- Do not return an answer already present in EXISTING.
- Return no answer that fails its exact pattern.

THEME: ${theme}
LANGUAGE: ${language === "es" ? "Spanish" : "English"}
PATTERNS: ${patterns.join(", ")}
EXISTING: ${existingAnswers.join(", ")}
`;
  const completion = await client.chat.completions.create({
    model: deps.answerbankSearchModel,
    temperature: 0.1,
    max_tokens: 2600,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. Match every character pattern exactly." },
      { role: "user", content: prompt },
    ],
  });
  const parsed = safeJson<{
    matches?: Array<{ pattern?: unknown; answers?: unknown }>;
  }>(completion.choices?.[0]?.message?.content ?? "");
  if (!parsed?.matches || !Array.isArray(parsed.matches)) return [];

  const existingSet = new Set(existingAnswers);
  const results = new Map<string, WordCandidate>();
  for (const match of parsed.matches) {
    const pattern = typeof match.pattern === "string" ? match.pattern.trim().toUpperCase() : "";
    if (!patterns.includes(pattern) || !Array.isArray(match.answers)) continue;
    const regex = new RegExp(`^${pattern.replace(/\?/g, "[A-Z]")}$`);
    for (const rawAnswer of match.answers) {
      const answer = normalizeAnswer(typeof rawAnswer === "string" ? rawAnswer : "");
      if (!regex.test(answer) || existingSet.has(answer)) continue;
      if (deps.isForbiddenPublishAnswer(answer)) continue;
      if (deps.isLikelyBadAnswer(answer) && !deps.alwaysAllowAnswers.has(answer)) continue;
      results.set(answer, { answer, thematic: true, source: "support" });
    }
  }

  deps.logger.warn("[pattern-repair-11] generated", {
    patterns: patterns.length,
    answers: results.size,
    sample: Array.from(results.keys()).slice(0, 20),
  });
  return Array.from(results.values());
}

export async function requestValidatedLayoutProposal(opts: {
  client: OpenAiRepairChatClient;
  theme: string;
  language: "es" | "en";
  size: number;
  pool: WordCandidate[];
  themeSet: Set<string>;
  dependencies: OpenAiRepairServicesDependencies;
}): Promise<{ grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null> {
  const { client, theme, language, size, pool, themeSet } = opts;
  const deps = opts.dependencies;
  if (size !== 11) return null;

  const minLen = minEntryLenForSize(size);
  const thematicCandidates = pool
    .filter((candidate) => candidate.source !== "filler")
    .filter((candidate) => candidate.answer.length >= minLen && candidate.answer.length <= size)
    .filter((candidate) => ASCII_A_TO_Z.test(candidate.answer))
    .filter((candidate) => !deps.isForbiddenPublishAnswer(candidate.answer))
    .filter((candidate) => !deps.isOverGenericThemeWordForTheme(theme, candidate.answer))
    .sort((a, b) => {
      if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
      const aTheme = themeSet.has(a.answer) ? 1 : 0;
      const bTheme = themeSet.has(b.answer) ? 1 : 0;
      if (aTheme !== bTheme) return bTheme - aTheme;
      return a.answer.length - b.answer.length || a.answer.localeCompare(b.answer);
    });
  const fillerCandidates = pool
    .filter((candidate) => candidate.source === "filler")
    .filter((candidate) => candidate.answer.length >= minLen && candidate.answer.length <= 8)
    .filter((candidate) => ASCII_A_TO_Z.test(candidate.answer))
    .filter((candidate) => !deps.isForbiddenPublishAnswer(candidate.answer))
    .filter((candidate) => !deps.isOverGenericThemeWordForTheme(theme, candidate.answer));
  const dictionaryFillerCandidates: WordCandidate[] = Array.from(
    new Set([
      ...(language === "en" ? deps.commonEnglishDictionaryWords : []),
      ...(language === "en" ? deps.frequencyEnglishDictionaryWords : deps.frequencySpanishDictionaryWords),
    ])
  )
    .filter((answer) => answer.length >= minLen && answer.length <= 8)
    .filter((answer) => ASCII_A_TO_Z.test(answer))
    .filter((answer) => !deps.isForbiddenPublishAnswer(answer))
    .filter((answer) => !deps.weakContextDictionaryWords.has(answer))
    .map((answer) => ({ answer, thematic: false, source: "filler" as const }));
  const allFillerCandidates = [...fillerCandidates, ...dictionaryFillerCandidates];
  const balancedFillerCandidates = [3, 4, 5, 6, 7, 8].flatMap((len) =>
    allFillerCandidates.filter((candidate) => candidate.answer.length === len).slice(0, 80)
  );
  const allowedCandidates = [...thematicCandidates, ...balancedFillerCandidates];

  const allowedAnswers = Array.from(new Set(allowedCandidates.map((candidate) => candidate.answer))).slice(0, 260);
  const thematicAnswers = Array.from(
    new Set(thematicCandidates.map((candidate) => candidate.answer))
  );
  if (allowedAnswers.length < minPublishEntriesForSize(size)) return null;

  const fixedPattern = [
    "#####....##",
    "####.....##",
    "####.....##",
    "###......##",
    "###......##",
    "#........##",
    "#........##",
    "#......####",
    "#....######",
    "###########",
    "###########",
  ];
  const fixedSlots = deps.extractPatternSlots(fixedPattern);
  const byLength = new Map<number, string[]>();
  for (const answer of allowedAnswers) {
    const list = byLength.get(answer.length) ?? [];
    list.push(answer);
    byLength.set(answer.length, list);
  }
  const hasFixedSupply = fixedSlots.every((slot) => (byLength.get(slot.len)?.length ?? 0) >= 2);

  if (hasFixedSupply) {
    type LocalFixedFill = {
      grid: string[][];
      usedAnswers: string[];
      thematicEntries: number;
      score: number;
    };

    const localFilled = ((): LocalFixedFill | null => {
      const candidatesByLen = new Map<number, string[]>();
      for (const candidate of allowedCandidates) {
        if (candidate.answer.length < minLen || candidate.answer.length > size) continue;
        const list = candidatesByLen.get(candidate.answer.length) ?? [];
        if (!list.includes(candidate.answer)) list.push(candidate.answer);
        candidatesByLen.set(candidate.answer.length, list);
      }
      for (const [len, list] of candidatesByLen) {
        list.sort((a, b) => {
          const at = themeSet.has(a) ? 1 : 0;
          const bt = themeSet.has(b) ? 1 : 0;
          if (at !== bt) return bt - at;
          return a.localeCompare(b);
        });
        candidatesByLen.set(len, list.slice(0, 90));
      }

      let nodes = 0;
      let best: LocalFixedFill | null = null;
      const startGrid = fixedPattern.map((row) => row.split(""));
      const used = new Set<string>();
      const filled = new Set<number>();

      const optionListForSlot = (slotIndex: number, grid: string[][]) => {
        const slot = fixedSlots[slotIndex];
        const source = candidatesByLen.get(slot.len) ?? [];
        const options: string[] = [];
        for (const answer of source) {
          if (used.has(answer)) continue;
          let ok = true;
          for (let i = 0; i < slot.cells.length; i++) {
            const { r, c } = slot.cells[i];
            const current = grid[r][c];
            if (current !== "." && current !== answer[i]) {
              ok = false;
              break;
            }
          }
          if (ok) options.push(answer);
          if (options.length >= 36) break;
        }
        return options;
      };

      const search = (grid: string[][]) => {
        nodes++;
        if (nodes > 180_000) return;

        if (filled.size === fixedSlots.length) {
          const derived = deps.deriveEntriesFromGrid(grid, minLen);
          const thematicEntries = derived.filter((entry) => themeSet.has(entry.answer)).length;
          const crossings = entryCrossingStats(grid, derived, minLen);
          if (
            derived.length === fixedSlots.length &&
            thematicEntries >= 10 &&
            crossings.weakEntries.length === 0 &&
            deps.isAcceptable(grid, derived, themeSet)
          ) {
            const score = thematicEntries * 1000 + derived.length * 10;
            if (!best || score > best.score) {
              best = {
                grid: grid.map((row) => row.slice()),
                usedAnswers: derived.map((entry) => entry.answer),
                thematicEntries,
                score,
              };
            }
          }
          return;
        }

        let nextSlotIndex = -1;
        let nextOptions: string[] = [];
        for (let i = 0; i < fixedSlots.length; i++) {
          if (filled.has(i)) continue;
          const options = optionListForSlot(i, grid);
          if (options.length === 0) return;
          if (nextSlotIndex < 0 || options.length < nextOptions.length) {
            nextSlotIndex = i;
            nextOptions = options;
          }
        }
        if (nextSlotIndex < 0) return;

        const slot = fixedSlots[nextSlotIndex];
        nextOptions.sort((a, b) => {
          const at = themeSet.has(a) ? 1 : 0;
          const bt = themeSet.has(b) ? 1 : 0;
          if (at !== bt) return bt - at;
          return a.localeCompare(b);
        });

        filled.add(nextSlotIndex);
        for (const answer of nextOptions) {
          const changed: Array<{ r: number; c: number }> = [];
          let ok = true;
          for (let i = 0; i < slot.cells.length; i++) {
            const { r, c } = slot.cells[i];
            const current = grid[r][c];
            if (current !== "." && current !== answer[i]) {
              ok = false;
              break;
            }
            if (current === ".") {
              grid[r][c] = answer[i];
              changed.push({ r, c });
            }
          }
          if (ok) {
            used.add(answer);
            search(grid);
            used.delete(answer);
          }
          for (const { r, c } of changed) grid[r][c] = ".";
          if (best && best.thematicEntries === fixedSlots.length) break;
        }
        filled.delete(nextSlotIndex);
      };

      search(startGrid);
      const result = best as LocalFixedFill | null;
      if (result) {
        deps.logger.warn("[model-layout-11] fixed pattern local solved", {
          nodes,
          thematicEntries: result.thematicEntries,
          answers: result.usedAnswers,
        });
      } else {
        deps.logger.warn("[model-layout-11] fixed pattern local no fill", { nodes });
      }
      return result;
    })();

    if (localFilled) {
      const crossings = entryCrossingStats(localFilled.grid, deps.deriveEntriesFromGrid(localFilled.grid, minLen), minLen);
      return {
        grid: localFilled.grid,
        usedAnswers: localFilled.usedAnswers,
        meta: {
          builder: "fixed-pattern-local-fill-11",
          acceptedEntries: localFilled.usedAnswers.length,
          thematicEntries: localFilled.thematicEntries,
          minEntryCheckedCells: crossings.minCheckedCells,
        },
      };
    }

    const slotLines = fixedSlots
      .map((slot, index) => {
        const options = (byLength.get(slot.len) ?? []).slice(0, 36).join(", ");
        return `${index + 1}. ${slot.direction.toUpperCase()} row=${slot.row} col=${slot.col} len=${slot.len}; allowed=${options}`;
      })
      .join("\n");

    try {
      const completion = await client.chat.completions.create({
        model: deps.answerbankSearchModel,
        temperature: 0.1,
        max_tokens: 2600,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "fixed_pattern_fill_11",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["fills"],
              properties: {
                fills: {
                  type: "array",
                  minItems: 17,
                  maxItems: 17,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["slot", "answer"],
                    properties: {
                      slot: { type: "integer", minimum: 1, maximum: 17 },
                      answer: { type: "string", pattern: "^[A-Z0-9]{3,11}$" },
                    },
                  },
                },
              },
            },
          },
        },
        messages: [
          { role: "system", content: "Return ONLY valid JSON. Choose only listed allowed answers." },
          {
            role: "user",
            content: `
Fill this exact 11x11 crossword pattern for THEME: ${theme}
LANGUAGE: ${language === "es" ? "Spanish" : "English"}

Pattern:
${fixedPattern.join("\n")}

Slots and allowed answers:
${slotLines}

Rules:
- Return exactly 17 fills, one per slot number.
- Each answer must be copied exactly from that slot's allowed list.
- Do not use an answer twice.
- Crossing letters must match. Check every crossing before returning.
- Prefer answers from THEMATIC_ANSWERS; use filler only when necessary to satisfy crossings.
- Use at least 10 answers from THEMATIC_ANSWERS.

THEMATIC_ANSWERS:
${thematicAnswers.join(", ")}
`,
          },
        ],
      });

      const parsed = safeJson<{ fills?: Array<{ slot?: number; answer?: string }> }>(
        completion.choices?.[0]?.message?.content ?? ""
      );
      const fills = parsed?.fills;
      if (Array.isArray(fills)) {
        const grid = fixedPattern.map((row) => row.split(""));
        const used = new Set<string>();
        const seenSlots = new Set<number>();
        let conflict: string | null = null;
        for (const fill of fills) {
          const slotNumber = Number(fill.slot);
          const slot = fixedSlots[slotNumber - 1];
          const answer = normalizeAnswer(fill.answer ?? "");
          const allowedForSlot = new Set(byLength.get(slot?.len ?? -1) ?? []);
          if (!slot || seenSlots.has(slotNumber) || used.has(answer) || !allowedForSlot.has(answer)) {
            conflict = `bad-fill:${slotNumber}:${answer}`;
            break;
          }
          seenSlots.add(slotNumber);
          used.add(answer);
          for (let i = 0; i < slot.cells.length; i++) {
            const { r, c } = slot.cells[i];
            const current = grid[r][c];
            const next = answer[i];
            if (current !== "." && current !== next) {
              conflict = `cross-conflict:${slotNumber}:${answer}`;
              break;
            }
            grid[r][c] = next;
          }
          if (conflict) break;
        }

        if (!conflict && seenSlots.size === fixedSlots.length) {
          const candidateDerived = deps.deriveEntriesFromGrid(grid, minLen);
          const thematicEntryCount = candidateDerived.filter((entry) =>
            themeSet.has(entry.answer)
          ).length;
          const crossings = entryCrossingStats(grid, candidateDerived, minLen);
          if (
            deps.isAcceptable(grid, candidateDerived, themeSet) &&
            thematicEntryCount >= 10 &&
            crossings.weakEntries.length === 0
          ) {
            return {
              grid,
              usedAnswers: Array.from(used),
              meta: {
                builder: "fixed-pattern-model-fill-11",
                acceptedEntries: candidateDerived.length,
                thematicEntries: thematicEntryCount,
                minEntryCheckedCells: crossings.minCheckedCells,
              },
            };
          }
          deps.logger.warn("[model-layout-11] fixed pattern reject", {
            reason: "not-acceptable",
            entries: candidateDerived.length,
            thematicEntries: thematicEntryCount,
            weakEntries: crossings.weakEntries,
            answers: candidateDerived.map((entry) => entry.answer),
          });
        } else {
          deps.logger.warn("[model-layout-11] fixed pattern reject", {
            reason: "fill-conflict",
            conflict,
            seenSlots: seenSlots.size,
            fills,
          });
        }
      }
    } catch (error: unknown) {
      deps.logger.warn("[model-layout-11] fixed pattern failed", { msg: deps.errorSummary(error) });
    }
  }

  const prompt = `
Return ONLY JSON:
{"layouts":[{"entries":[{"answer":"...","row":0,"col":0,"direction":"across"}]}]}

Build up to TWO different compact 11x11 crossword layout candidates using ONLY answers from ALLOWED_ANSWERS.

Rules:
- Each layout must use 15 to 17 entries. Prefer 16 when it fits cleanly.
- At least 10 entries in each layout must come from THEMATIC_ANSWERS.
- Use at least 6 across and at least 6 down entries.
- Every entry must cross at least TWO other entries.
- No answer may be used twice.
- Do not invent answers. Do not alter spelling.
- Coordinates are zero-based integers from 0 to 10.
- direction must be exactly "across" or "down".
- Entries must fit inside the 11x11 grid.
- Overlapping cells must have the same letter. Self-check every crossing before returning.
- Do not create adjacent unintended words: after placing the entries, every across/down run of 3+ letters must be one of the listed entries.
- Prefer a single compact interlocked cluster near the center, not isolated mini-puzzles.
- Prefer 4-8 letter answers because they are easier to cross densely in 11x11.
- Prefer the first, most thematic answers when possible, but every used answer must physically fit and cross at least twice.
- Black squares are implicit: only list placed answers.

THEME: ${theme}
LANGUAGE: ${language === "es" ? "Spanish" : "English"}
THEMATIC_ANSWERS:
${thematicAnswers.join(", ")}

ALLOWED_ANSWERS:
${allowedAnswers.join(", ")}
`;

  const completion = await client.chat.completions.create({
    model: deps.answerbankSearchModel,
    temperature: 0.1,
    max_tokens: 2600,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No extra text." },
      { role: "user", content: prompt },
    ],
  });

  const text = completion.choices?.[0]?.message?.content ?? "";
  const parsed = safeJson<{
    layouts?: Array<{
      entries?: Array<{
        answer?: unknown;
        row?: unknown;
        col?: unknown;
        direction?: unknown;
      }>;
    }>;
    entries?: Array<{
      answer?: unknown;
      row?: unknown;
      col?: unknown;
      direction?: unknown;
    }>;
  }>(text);
  if (!parsed) {
    deps.logger.warn("[model-layout-11] reject", { reason: "json-parse", textHead: text.slice(0, 240) });
    return null;
  }

  const rawLayouts =
    Array.isArray(parsed.layouts) && parsed.layouts.length > 0
      ? parsed.layouts
      : Array.isArray(parsed.entries)
      ? [{ entries: parsed.entries }]
      : [];
  if (rawLayouts.length === 0) {
    deps.logger.warn("[model-layout-11] reject", { reason: "no-layouts", textHead: text.slice(0, 240) });
    return null;
  }

  const allowedSet = new Set(allowedAnswers);
  for (let layoutIndex = 0; layoutIndex < rawLayouts.length; layoutIndex++) {
    const entries = rawLayouts[layoutIndex].entries;
    if (!Array.isArray(entries)) {
      deps.logger.warn("[model-layout-11] reject", { layoutIndex, reason: "entries-not-array" });
      continue;
    }

    const seen = new Set<string>();
    const proposed: DerivedEntry[] = [];
    for (const item of entries) {
      const answer = normalizeAnswer(typeof item.answer === "string" ? item.answer : "");
      const rowValue =
        typeof item.row === "number"
          ? item.row
          : typeof item.row === "string" && item.row.trim() !== ""
          ? Number(item.row)
          : NaN;
      const colValue =
        typeof item.col === "number"
          ? item.col
          : typeof item.col === "string" && item.col.trim() !== ""
          ? Number(item.col)
          : NaN;
      const rawDirection = typeof item.direction === "string" ? item.direction.toLowerCase().trim() : "";
      const direction =
        rawDirection === "across" || rawDirection === "horizontal"
          ? "across"
          : rawDirection === "down" || rawDirection === "vertical"
          ? "down"
          : null;
      const row = Number.isInteger(rowValue) ? rowValue : -1;
      const col = Number.isInteger(colValue) ? colValue : -1;
      if (!answer || !direction) continue;
      if (!allowedSet.has(answer)) continue;
      if (seen.has(answer)) continue;
      if (answer.length < minLen || answer.length > size) continue;
      if (!inBounds(size, row, col)) continue;
      seen.add(answer);
      proposed.push({
        number: proposed.length + 1,
        row,
        col,
        direction,
        answer,
      });
    }

    const minLayoutEntriesToRepair = Math.max(minLen, minPublishEntriesForSize(size) - 1);
    if (proposed.length < minLayoutEntriesToRepair) {
      deps.logger.warn("[model-layout-11] reject", {
        layoutIndex,
        reason: "proposed-count",
        proposed: proposed.length,
      });
      continue;
    }
    const rebuilt =
      rebuildGridFromEntries(size, proposed, minLen) ??
      rebuildGridFromEntriesAllowingAllowedDerived(size, proposed, minLen, allowedSet);
    if (!rebuilt) {
      deps.logger.warn("[model-layout-11] reject", {
        layoutIndex,
        reason: "rebuild-failed",
        proposed: proposed.length,
        answers: proposed.map((entry) => entry.answer),
      });
      continue;
    }

    let candidateGrid = rebuilt.grid;
    let candidateDerived = rebuilt.derived;
    if (candidateDerived.length < minPublishEntriesForSize(size)) {
      const augmented = deps.augmentNoShortGridWithCandidates(
        candidateGrid,
        allowedCandidates,
        minLen,
        minPublishEntriesForSize(size)
      );
      if (augmented) {
        candidateGrid = augmented.grid;
        candidateDerived = augmented.derived;
      }
    }

    if (!deps.isAcceptable(candidateGrid, candidateDerived, themeSet)) {
      const crossings = entryCrossingStats(candidateGrid, candidateDerived, minLen);
      deps.logger.warn("[model-layout-11] reject", {
        layoutIndex,
        reason: "not-acceptable",
        proposed: proposed.length,
        derived: candidateDerived.length,
        thematicEntries: candidateDerived.filter((entry) => themeSet.has(entry.answer)).length,
        weakEntries: crossings.weakEntries,
        checkedRatio: checkedCellStats(candidateGrid, minLen).ratio,
        density: crosswordDensityFromGrid(candidateGrid),
        answers: candidateDerived.map((entry) => entry.answer),
      });
      continue;
    }
    const thematicEntryCount = candidateDerived.filter((entry) =>
      themeSet.has(entry.answer)
    ).length;
    if (thematicEntryCount < 10) continue;
    const crossings = entryCrossingStats(candidateGrid, candidateDerived, minLen);
    if (crossings.weakEntries.length > 0) continue;

    return {
      grid: candidateGrid,
      usedAnswers: Array.from(new Set(candidateDerived.map((entry) => entry.answer))),
      meta: {
        builder: "validated-model-layout-11",
        layoutIndex,
        proposedEntries: proposed.length,
        acceptedEntries: candidateDerived.length,
        thematicEntries: thematicEntryCount,
        minEntryCheckedCells: crossings.minCheckedCells,
      },
    };
  }

  return null;
}

export async function requestDirectPlayableCrossword11(opts: {
  client: OpenAiRepairChatClient;
  theme: string;
  language: "es" | "en";
  attempt: number;
  dependencies: OpenAiRepairServicesDependencies;
}): Promise<Crossword | null> {
  const { client, theme, language, attempt } = opts;
  const deps = opts.dependencies;
  const size = 11;
  const minLen = minEntryLenForSize(size);
  const normalizedTheme = normalizeAnswer(theme);
  const pattern = [
    "###########",
    "#####....##",
    "#####....##",
    "###......##",
    "#........##",
    "........###",
    "........###",
    ".......####",
    ".......####",
    "###########",
    "###########",
  ];
  const slots = deps.extractPatternSlots(pattern)
    .map(
      (slot, index) =>
        `${index + 1}. ${slot.direction.toUpperCase()} row=${slot.row} col=${slot.col} len=${slot.len}`
    )
    .join("\n");

  for (let tryIndex = 0; tryIndex < 2; tryIndex++) {
    const completion = await client.chat.completions.create({
      model: deps.answerbankSearchModel,
      temperature: tryIndex === 0 ? 0.15 : 0.3,
      max_tokens: 5200,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "playable_crossword_11",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["fills"],
            properties: {
              fills: {
                type: "array",
                minItems: 17,
                maxItems: 17,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["slot", "answer", "clue", "relation"],
                  properties: {
                    slot: { type: "integer", minimum: 1, maximum: 17 },
                    answer: { type: "string", pattern: "^[A-Z0-9]{3,11}$" },
                    clue: { type: "string", minLength: 8, maxLength: 160 },
                    relation: { type: "string", minLength: 8, maxLength: 180 },
                  },
                },
              },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "Return exact JSON only. Fill the supplied crossword pattern; do not change its black squares.",
        },
        {
          role: "user",
          content:
            language === "es"
              ? `Rellena este patron de crucigrama tematico 11x11 sobre: ${theme}

Reglas obligatorias:
- Usa EXACTAMENTE este patron. # debe quedar #; cada . debe convertirse en una letra A-Z:
${pattern.join("\n")}
- Estos son los slots que debes rellenar; respeta largo, fila, columna y direccion:
${slots}
- Devuelve una lista fills con exactamente 17 objetos, uno por cada slot numerado.
- Cada answer debe tener exactamente el largo indicado para su slot.
- Las letras en los cruces deben coincidir entre slots. Verifica todos los cruces antes de responder.
- Todas las secuencias horizontales y verticales del patron ya son entradas; no agregues ni quites entradas.
- Cada entrada del patron cruza al menos dos celdas con entradas de la otra direccion.
- La respuesta exacta del tema (${normalizedTheme}) nunca puede aparecer como entrada.
- Cada respuesta debe ser real y defendible para el tema: persona, apellido, obra, lugar, termino tecnico, objeto, personaje, evento o palabra de dominio con relacion concreta.
- No uses palabras genericas si la pista no puede explicar una relacion concreta con ${theme}.
- No inventes, no recortes, no rellenes letras, no alteres plurales, no uses fragmentos.
- Las pistas deben ser concretas, no vagas, y no deben mencionar literalmente la respuesta.
- Evita afirmaciones temporales inestables como actual, ex, ultimo, hoy o desde.
- Si no hay suficientes respuestas tematicas exactas para todos los slots, usa palabras de dominio concretas del tema antes que relleno generico.

Devuelve solo fills. Cada fill debe traer slot, answer, clue y relation.`
              : `Fill this 11x11 themed crossword pattern about: ${theme}

Mandatory rules:
- Use EXACTLY this pattern. # must remain #; every . must become an A-Z letter:
${pattern.join("\n")}
- These are the slots to fill; respect length, row, column, and direction:
${slots}
- Return a fills list with exactly 17 objects, one for each numbered slot.
- Each answer must have exactly the length required by its slot.
- Crossing letters must match between slots. Check every crossing before answering.
- Every across/down run in the pattern is an entry; do not add or remove entries.
- Every entry in the pattern crosses at least two cells with entries in the other direction.
- The exact theme answer (${normalizedTheme}) must never appear as an entry.
- Every answer must be real and defensible for the theme: person, surname, work, place, technical term, object, character, event, or domain word with a concrete relation.
- Do not use generic words unless the clue states a concrete relationship to ${theme}.
- Do not invent, truncate, pad, respell, change plurals, or use fragments.
- Clues must be concrete, not vague, and must not literally mention the answer.
- Avoid unstable temporal claims such as current, former, latest, today, or since.
- If exact thematic identifiers are not enough for every slot, use concrete theme-domain words before generic filler.

Return only fills. Each fill must include slot, answer, clue, and relation.`,
        },
      ],
    });

    const parsed = safeJson<{
      fills?: Array<{ slot?: number; answer?: string; clue?: string; relation?: string }>;
    }>(completion.choices?.[0]?.message?.content ?? "");
    const fills = parsed?.fills;
    if (!Array.isArray(fills)) {
      deps.logger.warn("[direct-11] reject", { attempt, tryIndex, reason: "parse" });
      continue;
    }

    const slotByNumber = new Map(deps.extractPatternSlots(pattern).map((slot, index) => [index + 1, slot] as const));
    const grid = pattern.map((row) => row.split(""));
    if (hasShortLetterRuns(grid, minLen)) {
      deps.logger.warn("[direct-11] reject", { attempt, tryIndex, reason: "bad-pattern-short-runs" });
      continue;
    }

    const modelByAnswer = new Map<string, { clue: string; relation: string }>();
    const seenSlots = new Set<number>();
    let fillConflict: string | null = null;
    for (const item of fills) {
      const slotNumber = Number(item.slot);
      const slot = slotByNumber.get(slotNumber);
      const answer = normalizeAnswer(item.answer ?? "");
      const clue = deps.sanitizeModelClueText(String(item.clue ?? ""), language);
      const relation = String(item.relation ?? "").trim();
      if (!slot || seenSlots.has(slotNumber)) {
        fillConflict = `bad-slot:${slotNumber}`;
        break;
      }
      if (!answer || answer.length !== slot.len || !clue || !relation) {
        fillConflict = `bad-answer:${slotNumber}:${answer}`;
        break;
      }
      seenSlots.add(slotNumber);
      for (let i = 0; i < slot.cells.length; i++) {
        const { r, c } = slot.cells[i];
        const current = grid[r][c];
        const next = answer[i];
        if (current !== "." && current !== next) {
          fillConflict = `cross-conflict:${slotNumber}:${answer}`;
          break;
        }
        grid[r][c] = next;
      }
      if (fillConflict) break;
      if (!modelByAnswer.has(answer)) modelByAnswer.set(answer, { clue, relation });
    }
    if (fillConflict || seenSlots.size !== slotByNumber.size) {
      deps.logger.warn("[direct-11] reject", {
        attempt,
        tryIndex,
        reason: "fill-conflict",
        fillConflict,
        seenSlots: seenSlots.size,
        expectedSlots: slotByNumber.size,
        fills: fills.map((fill) => ({ slot: fill.slot, answer: fill.answer })),
      });
      continue;
    }
    const derived = deps.deriveEntriesFromGrid(grid, minLen);
    const derivedAnswers = derived.map((entry) => entry.answer);
    const uniqueDerivedAnswers = new Set(derivedAnswers);
    const missingMetadata = derivedAnswers.filter((answer) => !modelByAnswer.has(answer));
    const extraMetadata = Array.from(modelByAnswer.keys()).filter((answer) => !uniqueDerivedAnswers.has(answer));

    if (
      derived.length < minPublishEntriesForSize(size) ||
      derived.length > 19 ||
      uniqueDerivedAnswers.size !== derived.length ||
      missingMetadata.length > 0 ||
      extraMetadata.length > 0 ||
      derivedAnswers.includes(normalizedTheme)
    ) {
      deps.logger.warn("[direct-11] reject", {
        attempt,
        tryIndex,
        reason: "entry-mismatch",
        derived: derived.length,
        missingMetadata,
        extraMetadata,
        answers: derivedAnswers,
      });
      continue;
    }

    const crossing = entryCrossingStats(grid, derived, minLen);
    const checked = checkedCellStats(grid, minLen);
    if (crossing.weakEntries.length > 0 || checked.ratio < 0.25 || crosswordDensityFromGrid(grid) < 0.4) {
      deps.logger.warn("[direct-11] reject", {
        attempt,
        tryIndex,
        reason: "weak-structure",
        weakEntries: crossing.weakEntries,
        checkedRatio: checked.ratio,
        density: crosswordDensityFromGrid(grid),
      });
      continue;
    }

    const validated = await deps.validateThematicAnswers({
      client,
      theme,
      language,
      size,
      answers: derivedAnswers,
      attempt,
    });
    const thematicSet = new Set(validated);
    if (thematicSet.size < Math.max(10, Math.ceil(derived.length * 0.7))) {
      deps.logger.warn("[direct-11] reject", {
        attempt,
        tryIndex,
        reason: "weak-theme",
        thematic: thematicSet.size,
        entries: derived.length,
        rejected: derivedAnswers.filter((answer) => !thematicSet.has(answer)),
      });
      continue;
    }

    const notesByAnswer = new Map<string, string>();
    const directClues = new Map<string, string>();
    for (const answer of derivedAnswers) {
      const metadata = modelByAnswer.get(answer);
      if (!metadata) continue;
      notesByAnswer.set(answer, metadata.relation);
      if (
        !deps.isBadClue(metadata.clue) &&
        !deps.clueMentionsAnswer(metadata.clue, answer) &&
        !deps.clueMakesUnstableTemporalClaim(metadata.clue, language) &&
        !deps.clueMislabelsPartialPersonAnswer(answer, metadata.clue, language) &&
        !deps.clueMislabelsKnownPartialTitle(theme, answer, metadata.clue)
      ) {
        directClues.set(answer, metadata.clue);
      }
    }

    const clueItems: OpenAiRepairClueRequestItem[] = derivedAnswers.map((answer) => {
      const note = notesByAnswer.get(answer);
      return {
        answer,
        thematic: thematicSet.has(answer),
        note,
        hint: thematicSet.has(answer)
          ? deps.buildThematicClueRequestHint(theme, answer, language, note) ?? undefined
          : undefined,
      };
    });
    const modelClues = await deps.requestModelClues({ client, theme, language, items: clueItems });
    for (const [answer, clue] of modelClues.entries()) directClues.set(answer, clue);
    deps.reinforceThematicClues(theme, language, derivedAnswers, directClues, notesByAnswer, thematicSet);

    const entries = deps.repairPublishClues(deps.applyCluesAndOverrides(theme, language, derived, directClues), {
      theme,
      language,
      thematicSet,
      notesByAnswer,
    });
    const qualityIssue = deps.publishQualityIssue(
      entries,
      thematicSet,
      language,
      minPublishEntriesForSize(size),
      theme
    );
    if (qualityIssue) {
      deps.logger.warn("[direct-11] reject", {
        attempt,
        tryIndex,
        reason: "quality",
        qualityIssue,
        answers: entries.map((entry) => ({ answer: entry.answer, clue: entry.clue })),
      });
      continue;
    }

    return {
      theme,
      language,
      size,
      grid,
      entries,
      meta: {
        source: "direct-validated-model-11",
        attempt,
        tryIndex,
        coreThematicEntries: thematicSet.size,
        genericContextEntries: entries.length - thematicSet.size,
        checkedRatio: checked.ratio,
        minEntryCheckedCells: crossing.minCheckedCells,
      },
    };
  }

  return null;
}

export async function requestValidatedPatternAssignment11(opts: {
  client: OpenAiRepairChatClient;
  theme: string;
  language: "es" | "en";
  size: number;
  pool: WordCandidate[];
  themeSet: Set<string>;
  dependencies: OpenAiRepairServicesDependencies;
}): Promise<{ grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null> {
  const { client, theme, language, size, pool, themeSet } = opts;
  const deps = opts.dependencies;
  if (size !== 11) return null;

  const allowedCandidates = Array.from(
    new Map(
      pool
        .filter((candidate) => candidate.source !== "filler")
        .filter(
          (candidate) =>
            themeSet.has(candidate.answer) ||
            candidate.thematic ||
            candidate.source === "support"
        )
        .filter((candidate) => !deps.isForbiddenPublishAnswer(candidate.answer))
        .filter(
          (candidate) =>
            themeSet.has(candidate.answer) ||
            !deps.isOverGenericThemeWordForTheme(theme, candidate.answer)
        )
        .map((candidate) => [candidate.answer, candidate] as const)
    ).values()
  );
  const byLength = new Map<number, string[]>();
  for (const candidate of allowedCandidates) {
    const bucket = byLength.get(candidate.answer.length) ?? [];
    bucket.push(candidate.answer);
    byLength.set(candidate.answer.length, bucket);
  }

  const viablePatterns = deps.pattern11x11s
    .map((pattern, patternIndex) => {
      const slots = deps.extractPatternSlots(pattern);
      const needByLength = slots.reduce((counts, slot) => {
        counts.set(slot.len, (counts.get(slot.len) ?? 0) + 1);
        return counts;
      }, new Map<number, number>());
      const hasSupply = Array.from(needByLength).every(
        ([len, needed]) => (byLength.get(len)?.length ?? 0) >= needed
      );
      return { pattern, patternIndex, slots, needByLength, hasSupply };
    })
    .filter(
      (item) =>
        item.hasSupply &&
        item.slots.length >= minPublishEntriesForSize(size) &&
        item.slots.length <= desiredPublishEntriesForSize(size)
    )
    .slice(0, 3);

  if (viablePatterns.length === 0) return null;

  const requiredLengths = new Set(
    viablePatterns.flatMap((item) => item.slots.map((slot) => slot.len))
  );
  const candidateText = Array.from(requiredLengths)
    .sort((a, b) => a - b)
    .map((len) => `${len}: ${(byLength.get(len) ?? []).join(", ")}`)
    .join("\n");
  const patternText = viablePatterns
    .map((item) => {
      const slots = item.slots
        .map(
          (slot, slotIndex) =>
            `${slotIndex}: ${slot.direction}, row ${slot.row}, col ${slot.col}, length ${slot.len}`
        )
        .join("\n");
      return `PATTERN ${item.patternIndex}\n${item.pattern.join("\n")}\nSLOTS IN REQUIRED ANSWER ORDER:\n${slots}`;
    })
    .join("\n\n");

  const prompt = `
Return ONLY JSON:
{"fills":[{"patternIndex":number,"answers":["ANSWER_FOR_SLOT_0","ANSWER_FOR_SLOT_1"]}]}

Fill one of the supplied 11x11 crossword patterns using ONLY CANDIDATES.
The answers array must follow the exact slot order printed for that pattern.

Hard rules:
- Fill every slot. Use each answer at most once.
- Every answer must have exactly the slot length.
- At every across/down intersection, both answers must have the same letter.
- Do not invent, alter, shorten, or concatenate answers.
- Return up to five different complete fills if possible.
- Check every crossing before returning JSON.

THEME: ${theme}
LANGUAGE: ${language === "es" ? "Spanish" : "English"}

CANDIDATES GROUPED BY EXACT LENGTH:
${candidateText}

${patternText}
`;

  const completion = await client.chat.completions.create({
    model: deps.answerbankSearchModel,
    temperature: 0.1,
    max_tokens: 3600,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Solve the constrained crossword exactly. Return ONLY valid JSON.",
      },
      { role: "user", content: prompt },
    ],
  });
  const text = completion.choices?.[0]?.message?.content ?? "";
  const parsed = safeJson<{
    fills?: Array<{ patternIndex?: unknown; answers?: unknown }>;
  }>(text);
  if (!parsed?.fills || !Array.isArray(parsed.fills)) {
    deps.logger.warn("[pattern-assignment-11] reject", {
      reason: "json-parse",
      textHead: text.slice(0, 240),
    });
    return null;
  }

  const allowedSet = new Set(allowedCandidates.map((candidate) => candidate.answer));
  for (let fillIndex = 0; fillIndex < parsed.fills.length; fillIndex++) {
    const fill = parsed.fills[fillIndex];
    const patternIndex =
      typeof fill.patternIndex === "number" && Number.isInteger(fill.patternIndex)
        ? fill.patternIndex
        : -1;
    const selectedPattern = viablePatterns.find((item) => item.patternIndex === patternIndex);
    if (!selectedPattern || !Array.isArray(fill.answers)) continue;

    const answers = fill.answers.map((answer) =>
      normalizeAnswer(typeof answer === "string" ? answer : "")
    );
    if (answers.length !== selectedPattern.slots.length) continue;
    if (new Set(answers).size !== answers.length) continue;
    if (
      answers.some(
        (answer, slotIndex) =>
          !allowedSet.has(answer) || answer.length !== selectedPattern.slots[slotIndex].len
      )
    ) {
      continue;
    }
    const coreAnswerCount = answers.filter((answer) => themeSet.has(answer)).length;
    if (coreAnswerCount < 10 || answers.length - coreAnswerCount > 5) continue;

    const grid: string[][] = selectedPattern.pattern.map((row) =>
      row.split("").map((cell) => (cell === "#" ? "#" : ""))
    );
    let conflict = false;
    for (let slotIndex = 0; slotIndex < selectedPattern.slots.length && !conflict; slotIndex++) {
      const slot = selectedPattern.slots[slotIndex];
      const answer = answers[slotIndex];
      for (let letterIndex = 0; letterIndex < slot.cells.length; letterIndex++) {
        const cell = slot.cells[letterIndex];
        const existing = grid[cell.r][cell.c];
        const letter = answer[letterIndex];
        if (existing !== "" && existing !== letter) {
          conflict = true;
          break;
        }
        grid[cell.r][cell.c] = letter;
      }
    }
    if (conflict) continue;

    const finalGrid = grid.map((row) => row.map((cell) => (cell === "" ? "#" : cell)));
    const derived = deps.deriveEntriesFromGrid(finalGrid, minEntryLenForSize(size));
    const crossings = entryCrossingStats(finalGrid, derived, minEntryLenForSize(size));
    if (derived.length !== selectedPattern.slots.length) continue;
    if (crossings.weakEntries.length > 0) continue;
    if (derived.some((entry) => !allowedSet.has(entry.answer))) continue;

    deps.logger.warn("[pattern-assignment-11] accepted", {
      fillIndex,
      patternIndex,
      entries: derived.length,
      coreAnswerCount,
      contextualAnswerCount: answers.length - coreAnswerCount,
      minEntryCheckedCells: crossings.minCheckedCells,
    });
    return {
      grid: finalGrid,
      usedAnswers: answers,
      meta: {
        builder: "model-pattern-assignment-11x11",
        patternIndex,
        patternRows: selectedPattern.pattern,
        coreAnswerCount,
        contextualAnswerCount: answers.length - coreAnswerCount,
        minEntryCheckedCells: crossings.minCheckedCells,
      },
    };
  }

  deps.logger.warn("[pattern-assignment-11] reject", {
    reason: "no-valid-fill",
    fills: parsed.fills.length,
    viablePatterns: viablePatterns.map((item) => item.patternIndex),
    textHead: text.slice(0, 240),
  });
  return null;
}

export async function requestGeneratedPatternGrid11(opts: {
  client: OpenAiRepairChatClient;
  theme: string;
  language: "es" | "en";
  size: number;
  attempt: number;
  dependencies: OpenAiRepairServicesDependencies;
}): Promise<{
  grid: string[][];
  usedAnswers: string[];
  thematicAnswers: string[];
  notes: Map<string, string>;
  meta: Record<string, unknown>;
} | null> {
  const { client, theme, language, size, attempt } = opts;
  const deps = opts.dependencies;
  if (size !== 11) return null;

  const patternIndex = 0;
  const pattern = deps.pattern11x11s[patternIndex];
  const slots = deps.extractPatternSlots(pattern);
  const rowProperties = Object.fromEntries(
    pattern.map((row, index) => [
      `r${index}`,
      {
        type: "string",
        pattern: `^${Array.from(row)
          .map((cell) => (cell === "#" ? "#" : "[A-Z]"))
          .join("")}$`,
      },
    ])
  );
  const prompt = `
Return the exact structured object containing one completed grid.

Create one fully filled themed crossword using the exact 11x11 PATTERN below.

PATTERN:
${pattern.join("\n")}

Rules:
- Keep every # exactly where it is.
- Replace every . with one uppercase A-Z letter.
- Every horizontal or vertical run of 3+ letters must be a real, complete crossword answer.
- The finished pattern has exactly ${slots.length} entries. All ${slots.length} must be different.
- At least 10 entries must be specific named terms, people, works, places, objects, or identifiers from THEME.
- Up to 5 entries may be ordinary context words only when they have a direct factual relationship to THEME.
- Do not use the exact theme text as an answer.
- No abbreviations, initials, codes, fragments, clipped names, altered titles, invented spellings, or nonsense.
- Check every across and down answer after filling the rows.

THEME: ${theme}
LANGUAGE: ${language === "es" ? "Spanish" : "English"}
`;

  const completion = await client.chat.completions.create({
    model: deps.answerbankSearchModel,
    temperature: 0.2,
    max_tokens: 5200,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "fixed_crossword_grid_11",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["rows"],
          properties: {
            rows: {
              type: "object",
              additionalProperties: false,
              required: pattern.map((_, index) => `r${index}`),
              properties: rowProperties,
            },
          },
        },
      },
    },
    messages: [
      {
        role: "system",
        content: "Build exact crossword grids. Return ONLY valid JSON and self-check every row and crossing.",
      },
      { role: "user", content: prompt },
    ],
  });
  const text = completion.choices?.[0]?.message?.content ?? "";
  const parsed = safeJson<{
    rows?: Record<string, unknown>;
    grids?: Array<{
      rows?: unknown;
      notes?: Array<{ answer?: unknown; note?: unknown }>;
    }>;
  }>(text);
  const parsedRows =
    parsed?.rows && typeof parsed.rows === "object"
      ? pattern.map((_, index) => parsed.rows?.[`r${index}`])
      : null;
  const parsedGrids =
    parsedRows && parsedRows.length === size
      ? [{ rows: parsedRows, notes: [] }]
      : parsed?.grids;
  if (!parsedGrids || !Array.isArray(parsedGrids)) {
    deps.logger.warn("[generated-pattern-grid-11] reject", {
      reason: "json-parse",
      textHead: text.slice(0, 240),
    });
    return null;
  }

  const candidates: Array<{
    grid: string[][];
    answers: string[];
    notes: Map<string, string>;
    gridIndex: number;
  }> = [];
  const allAnswers = new Set<string>();
  const normalizedTheme = normalizeAnswer(theme);

  for (let gridIndex = 0; gridIndex < parsedGrids.length; gridIndex++) {
    const rawGrid = parsedGrids[gridIndex];
    if (!Array.isArray(rawGrid.rows) || rawGrid.rows.length !== size) continue;
    const rows = rawGrid.rows.map((row) =>
      typeof row === "string" ? row.trim().toUpperCase() : ""
    );
    if (rows.some((row) => row.length !== size || !/^[#A-Z]+$/.test(row))) continue;
    const shapeMatches = rows.every((row, r) =>
      Array.from(row).every((cell, c) =>
        pattern[r][c] === "#" ? cell === "#" : cell !== "#"
      )
    );
    if (!shapeMatches) continue;

    const grid = rows.map((row) => row.split(""));
    const derived = deps.deriveEntriesFromGrid(grid, minEntryLenForSize(size));
    if (derived.length !== slots.length) continue;
    const answers = derived.map((entry) => entry.answer);
    if (new Set(answers).size !== answers.length) continue;
    if (answers.includes(normalizedTheme)) continue;
    if (
      answers.some(
        (answer) =>
          deps.isForbiddenPublishAnswer(answer) ||
          (deps.isLikelyBadAnswer(answer) && !deps.alwaysAllowAnswers.has(answer))
      )
    ) {
      continue;
    }
    const crossings = entryCrossingStats(grid, derived, minEntryLenForSize(size));
    if (crossings.weakEntries.length > 0) continue;

    const notes = new Map<string, string>();
    for (const item of rawGrid.notes ?? []) {
      const answer = normalizeAnswer(typeof item.answer === "string" ? item.answer : "");
      const note = typeof item.note === "string" ? item.note.trim() : "";
      if (!answers.includes(answer) || note.length < 8 || deps.noteLooksWeakThematicContext(note, language)) {
        continue;
      }
      notes.set(answer, note);
    }
    for (const answer of answers) allAnswers.add(answer);
    candidates.push({ grid, answers, notes, gridIndex });
  }

  if (candidates.length === 0) {
    deps.logger.warn("[generated-pattern-grid-11] reject", {
      reason: "no-structurally-valid-grid",
      returned: parsedGrids.length,
      textHead: text.slice(0, 240),
    });
    return null;
  }

  const validated = await deps.validateThematicAnswers({
    client,
    theme,
    language,
    size,
    answers: Array.from(allAnswers),
    attempt,
  });
  const validatedSet = new Set(validated);

  for (const candidate of candidates) {
    const localDictionary = new Set(
      (language === "es" ? deps.spanishFillerWords : deps.fillerWords).map((answer) =>
        normalizeAnswer(answer)
      )
    );
    const supportedAnswers = candidate.answers.filter((answer) => {
      if (validatedSet.has(answer)) return true;
      if (localDictionary.has(answer)) return true;
      return deps.hasStrongThematicClueSupport({
        theme,
        answer,
        language,
        note: candidate.notes.get(answer),
      });
    });
    const validatedCount = candidate.answers.filter((answer) => validatedSet.has(answer)).length;
    if (validatedCount < 8 || supportedAnswers.length !== candidate.answers.length) continue;

    deps.logger.warn("[generated-pattern-grid-11] accepted", {
      gridIndex: candidate.gridIndex,
      entries: candidate.answers.length,
      validatedCount,
      contextualCount: candidate.answers.length - validatedCount,
    });
    return {
      grid: candidate.grid,
      usedAnswers: candidate.answers,
      thematicAnswers: supportedAnswers,
      notes: candidate.notes,
      meta: {
        builder: "generated-fixed-pattern-11x11",
        patternIndex,
        patternRows: pattern,
        validatedThematicEntries: validatedCount,
        contextualEntries: candidate.answers.length - validatedCount,
      },
    };
  }

  deps.logger.warn("[generated-pattern-grid-11] reject", {
    reason: "thematic-validation",
    structurallyValid: candidates.length,
    validated: validated.length,
  });
  return null;
}

export async function requestValidatedGridProposal(opts: {
  client: OpenAiRepairChatClient;
  theme: string;
  language: "es" | "en";
  size: number;
  pool: WordCandidate[];
  themeSet: Set<string>;
  dependencies: OpenAiRepairServicesDependencies;
}): Promise<{ grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null> {
  const { client, theme, language, size, pool, themeSet } = opts;
  const deps = opts.dependencies;
  if (size !== 11) return null;

  const minLen = minEntryLenForSize(size);
  const allowedCandidates = pool
    .filter((candidate) => candidate.source !== "filler")
    .filter((candidate) => candidate.answer.length >= minLen && candidate.answer.length <= size)
    .filter((candidate) => ASCII_A_TO_Z.test(candidate.answer))
    .filter((candidate) => !deps.isForbiddenPublishAnswer(candidate.answer))
    .filter((candidate) => !deps.isOverGenericThemeWordForTheme(theme, candidate.answer))
    .sort((a, b) => {
      if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
      const aTheme = themeSet.has(a.answer) ? 1 : 0;
      const bTheme = themeSet.has(b.answer) ? 1 : 0;
      if (aTheme !== bTheme) return bTheme - aTheme;
      const aLenScore = a.answer.length >= 4 && a.answer.length <= 8 ? 0 : 1;
      const bLenScore = b.answer.length >= 4 && b.answer.length <= 8 ? 0 : 1;
      return aLenScore - bLenScore || a.answer.length - b.answer.length || a.answer.localeCompare(b.answer);
    });

  const allowedAnswers = Array.from(new Set(allowedCandidates.map((candidate) => candidate.answer))).slice(0, 90);
  if (allowedAnswers.length < minPublishEntriesForSize(size)) return null;

  const prompt = `
Return ONLY JSON:
{"grids":[{"rows":["###########","###########","###########","###########","###########","###########","###########","###########","###########","###########","###########"]}]}

Build THREE candidate 11x11 crossword grids.

Hard rules:
- Each grid has exactly 11 rows and each row has exactly 11 characters.
- Use only uppercase A-Z, digits, and #.
- Every across/down entry of length 3 or more MUST be one exact answer from ALLOWED_ANSWERS.
- Use 15 to 17 total entries. Prefer 16 when it fits cleanly.
- Use at least 6 across and at least 6 down entries.
- Every entry must have at least TWO checked cells.
- No answer may appear twice, including singular/plural variants.
- Do not invent answers or alter spelling.
- Do not create any 2-letter across or down runs.
- Prefer a compact interlocked cluster near the center.
- Prefer the first, most thematic answers.

THEME: ${theme}
LANGUAGE: ${language === "es" ? "Spanish" : "English"}
ALLOWED_ANSWERS:
${allowedAnswers.join(", ")}
`;

  const completion = await client.chat.completions.create({
    model: deps.answerbankSearchModel,
    temperature: 0.1,
    max_tokens: 5200,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No extra text." },
      { role: "user", content: prompt },
    ],
  });

  const text = completion.choices?.[0]?.message?.content ?? "";
  const parsed = safeJson<{
    grids?: Array<{
      rows?: unknown;
    }>;
    rows?: unknown;
  }>(text);
  if (!parsed) return null;

  const rawGrids =
    Array.isArray(parsed.grids) && parsed.grids.length > 0
      ? parsed.grids
      : Array.isArray(parsed.rows)
      ? [{ rows: parsed.rows }]
      : [];
  const allowedSet = new Set(allowedAnswers);

  for (let gridIndex = 0; gridIndex < rawGrids.length; gridIndex++) {
    const rows = rawGrids[gridIndex].rows;
    if (!Array.isArray(rows)) {
      deps.logger.warn("[model-grid-11] reject", { gridIndex, reason: "rows-not-array" });
      continue;
    }
    if (rows.length !== size) {
      deps.logger.warn("[model-grid-11] reject", { gridIndex, reason: "wrong-row-count", rows: rows.length });
      continue;
    }

    let grid = rows.map((row) => {
      if (typeof row !== "string") return [];
      const cleaned = row
        .toUpperCase()
        .replace(/^\s*\d+\s*[:.)-]?\s*/, "")
        .replace(/[.\-_*·]/g, "#")
        .replace(/[^A-Z0-9#]/g, "");
      const exact =
        cleaned.length === size
          ? cleaned
          : cleaned.length > size
          ? cleaned.slice(0, size)
          : cleaned.length >= size - 2
          ? cleaned.padEnd(size, "#")
          : cleaned.match(/[A-Z0-9#]{11}/)?.[0] ?? "";
      return exact.split("").map((cell) => (/^[A-Z0-9]$/.test(cell) ? cell : "#"));
    });

    if (grid.some((row) => row.length !== size)) {
      deps.logger.warn("[model-grid-11] reject", { gridIndex, reason: "wrong-row-length", rows });
      continue;
    }
    if (hasShortLetterRuns(grid, minLen)) {
      const cleanedGrid = blockShortRunsOnly(grid, minLen);
      if (hasShortLetterRuns(cleanedGrid, minLen)) {
        deps.logger.warn("[model-grid-11] reject", { gridIndex, reason: "short-runs", rows });
        continue;
      }
      deps.logger.warn("[model-grid-11] repaired", { gridIndex, reason: "short-runs" });
      grid = cleanedGrid;
    }

    const derived = deps.deriveEntriesFromGrid(grid, minLen);
    if (derived.length < minPublishEntriesForSize(size) || derived.length > 17) {
      deps.logger.warn("[model-grid-11] reject", {
        gridIndex,
        reason: "entry-count",
        entries: derived.length,
        answers: derived.map((entry) => entry.answer),
      });
      continue;
    }
    const outOfBank = derived.filter((entry) => !allowedSet.has(entry.answer));
    if (outOfBank.length > 0) {
      deps.logger.warn("[model-grid-11] reject", {
        gridIndex,
        reason: "out-of-bank",
        entries: derived.length,
        outOfBank: outOfBank.map((entry) => entry.answer),
      });
      continue;
    }
    if (!deps.isAcceptable(grid, derived, themeSet)) {
      const crossings = entryCrossingStats(grid, derived, minLen);
      deps.logger.warn("[model-grid-11] reject", {
        gridIndex,
        reason: "not-acceptable",
        entries: derived.length,
        thematicEntries: derived.filter((entry) => themeSet.has(entry.answer)).length,
        across: derived.filter((entry) => entry.direction === "across").length,
        down: derived.filter((entry) => entry.direction === "down").length,
        weakEntries: crossings.weakEntries,
        checkedRatio: checkedCellStats(grid, minLen).ratio,
        density: crosswordDensityFromGrid(grid),
        answers: derived.map((entry) => entry.answer),
      });
      continue;
    }

    const crossings = entryCrossingStats(grid, derived, minLen);
    if (crossings.weakEntries.length > 0) continue;

    return {
      grid,
      usedAnswers: derived.map((entry) => entry.answer),
      meta: {
        builder: "validated-model-grid-11",
        gridIndex,
        acceptedEntries: derived.length,
        minEntryCheckedCells: crossings.minCheckedCells,
      },
    };
  }

  return null;
}
