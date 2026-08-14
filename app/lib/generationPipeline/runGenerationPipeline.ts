import type OpenAI from "openai";
import type { Crossword, DerivedEntry, Entry, RawClueBank, WordCandidate } from "@/app/lib/crosswordTypes";
import { ASCII_A_TO_Z, errorSummary, inBounds, normalizeAnswer, safeJson } from "@/app/lib/crosswordUtils";
import { cspBankAuditCandidateDistribution, cspBankAuditRejectedBySet } from "@/app/lib/answerPipeline";
import { cspBankAuditSetDistribution, prepareCspOrchestration, runCspOrchestration } from "@/app/lib/cspOrchestration";
import { validateThematicAnswers } from "@/app/lib/openaiGeneration";
import {
  CLUEBANK_PROMPT,
  CLUE_MODEL,
  clueLanguageLooksValid,
  clueMentionsAnswer,
  createPublishCleanupServices,
  deriveEntriesFromGrid,
  isBadClue,
  isPlaceholderClue,
  pruneMaskedDuplicateAnswers,
  sanitizeModelClueText,
} from "@/app/lib/publishPipeline";
import {
  generatePatternMatchedRepairWords as generatePatternMatchedRepairWordsWithDependencies,
  requestGeneratedPatternGrid11 as requestGeneratedPatternGrid11WithDependencies,
  requestValidatedGridProposal as requestValidatedGridProposalWithDependencies,
  requestValidatedLayoutProposal as requestValidatedLayoutProposalWithDependencies,
  requestValidatedPatternAssignment11 as requestValidatedPatternAssignment11WithDependencies,
} from "@/app/lib/openaiRepairServices";
import { runThemeFirstRescue } from "@/app/lib/themeFirstRescue";
import {
  createBestPartialCandidate,
  selectBetterBestPartial,
  shouldRejectBestPartialForStrict11,
  type BestPartial,
} from "@/app/lib/bestPartial";
import {
  blockShortRunsOnly,
  checkedCellStats,
  crossedEntryStats,
  crosswordDensityFromGrid,
  desiredPublishEntriesForSize,
  entryCrossingStats,
  hasShortLetterRuns,
  maxGenericContextEntriesForPublish,
  minCoreThematicEntriesForPublish,
  minCrossedEntriesForPublish,
  minCrossingsPerEntryForPublish,
  minEntryLenForSize,
  minPublishEntriesForSize,
  minThematicEntriesForPublish,
  pruneWeakEntriesPreservingCrosses,
  sanitizeUncheckedGrid,
} from "@/app/lib/gridValidation";
import {
  rebuildExactFullyCheckedPublishableCrossword as rebuildExactFullyCheckedPublishableCrosswordWithPolicies,
  rebuildExactPublishableCrossword as rebuildExactPublishableCrosswordWithPolicies,
  rebuildFullyCheckedPublishableCrossword as rebuildFullyCheckedPublishableCrosswordWithPolicies,
  rebuildGridFromAllowedEntries,
  rebuildGridFromEntries,
  rebuildNoShortRunPublishableCrossword as rebuildNoShortRunPublishableCrosswordWithPolicies,
  rebuildPlayableCrossword as rebuildPlayableCrosswordWithPolicies,
  rebuildSanitizedFullyCheckedPublishableCrossword as rebuildSanitizedFullyCheckedPublishableCrosswordWithPolicies,
} from "@/app/lib/gridReconstruction";
import {
  augmentNoShortGridWithCandidates as augmentNoShortGridWithCandidatesWithDependencies,
  densifyCleanGrid11 as densifyCleanGrid11WithDependencies,
  extendGridWithCrossedPair11 as extendGridWithCrossedPair11WithDependencies,
} from "@/app/lib/gridEnhancement";
import { runOpeningBuilder } from "@/app/lib/openingBuilder";
import { pickPoolForSize, runLegacyBuilder } from "@/app/lib/legacyBuilder";
import { runFreeformBuilder } from "@/app/lib/freeformBuilder";
import type { GenerationFailureKind, GenerationPipelineInput, GenerationPipelineResult } from "./generationPipelineTypes";
import type { ClueRequestItem } from "@/app/lib/publishPipeline";

export async function runGenerationPipeline(input: GenerationPipelineInput): Promise<GenerationPipelineResult> {
  const {
    client,
    theme,
    language,
    size: n,
    startedAtMs: t0,
    deadlineMs,
    firstAttemptDeadlineCheckMs,
    csp11Enabled,
    csp11DiagnosticOnly,
    csp11DiagnosticBudgetMs,
    csp11HybridDiagnostic,
    answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
    dependencies,
  } = input;
  const {
    prepareAttemptAnswers,
    requestModelClues,
    sanitizeAnswerList,
    freeformBuilderDependencies,
    legacyBuilderDependencies,
    openingBuilderDependencies,
    themeFirstRescueDependencies,
    gridEnhancementDependencies,
    openAiRepairServicesDependencies,
    gridReconstructionPolicies,
    applyCluesAndOverrides,
    buildCoreThematicSetFromPool,
    buildPublishThematicSetFromPool,
    buildThematicClueRequestHint,
    clueFromThemeNote,
    clueLooksOffTheme,
    fallbackClueForPublishRepair,
    hasStrongThematicClueSupport,
    isAcceptable,
    isCoreThematicCandidate,
    isForbiddenPublishAnswer,
    isLikelyBadAnswer,
    isOverGenericThemeWordForTheme,
    isPublishableAnswerForTheme,
    publishQualityIssue,
    reinforceThematicClues,
    repairPublishClues,
    specificThematicFallbackClue,
    alwaysAllowAnswers: ALWAYS_ALLOW_ANSWERS,
    bannedAnswers: BANNED_ANSWERS,
    contextualGenericAnswers: CONTEXTUAL_GENERIC_ANSWERS,
    contextualSupportAnswers: CONTEXTUAL_SUPPORT_ANSWERS,
    fillerWords: FILLER_WORDS,
    lowValueContextlessAnswers: LOW_VALUE_CONTEXTLESS_ANSWERS,
    modelFragmentAnswers: MODEL_FRAGMENT_ANSWERS,
    spanishFillerWords: SPANISH_FILLER_WORDS,
  } = dependencies;
  const { pruneForbiddenPublishAnswersIfPossible, blockForbiddenAnswerRuns } = createPublishCleanupServices({
    isForbiddenPublishAnswer,
  });
  let csp11Attempted = false;
  let lastCspAttemptMeta: Record<string, unknown> | null = null;
  const accepted = (crossword: Crossword): GenerationPipelineResult => ({ status: "accepted", crossword, lastCspAttemptMeta });
  const diagnostic = (responsePayload: unknown): GenerationPipelineResult => ({ status: "diagnostic", responsePayload, lastCspAttemptMeta });
  const failed = (meta: Record<string, unknown>, failureKind: GenerationFailureKind = "service-unavailable"): GenerationPipelineResult => ({
    status: "failed",
    failureKind,
    meta: {
      ...meta,
      ...(lastCspAttemptMeta && { cspAttempt: lastCspAttemptMeta }),
    },
    lastCspAttemptMeta,
  });
  async function tryOpeningDeterministic11(opts: {
    client: OpenAI;
    theme: string;
    language: "es" | "en";
    candidates: WordCandidate[];
    notesByAnswer: Map<string, string>;
    thematicSet: Set<string>;
    coreThematicSet: Set<string>;
    seed: number;
    targetEntries: number;
    deadlineMs: number;
    source: string;
    attempt: number;
    previousEntries?: number;
    fallbackScore?: number;
    extraMeta?: Record<string, unknown>;
  }): Promise<Crossword | null> {
    const {
      client,
      theme,
      language,
      candidates,
      notesByAnswer,
      thematicSet,
      coreThematicSet,
      seed,
      targetEntries,
      deadlineMs,
      source,
      attempt,
      previousEntries,
      fallbackScore,
      extraMeta,
    } = opts;

    const opening = runOpeningBuilder({ dependencies: openingBuilderDependencies,
      theme,
      candidates,
      seed,
      targetEntries,
      deadlineMs,
    });
    if (!opening) return null;

    const uniqueAnswers = Array.from(new Set(opening.derived.map((entry) => entry.answer)));
    const clueItems: ClueRequestItem[] = uniqueAnswers.map((answer) => {
      const note = notesByAnswer.get(answer);
      const thematic = thematicSet.has(answer);
      const hint = buildThematicClueRequestHint(theme, answer, language, note) ?? undefined;
      return {
        answer,
        thematic,
        note,
        hint: thematic ? hint : undefined,
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
      for (const [answer, clue] of modelClues.entries()) {
        clueByAnswer.set(answer, clue);
      }
    } catch (e: unknown) {
      console.warn("[generate-crossword] opening clue request failed", {
        attempt,
        source,
        name: e instanceof Error ? e.name : "unknown",
        msg: e instanceof Error ? e.message : String(e),
      });
    }

    reinforceThematicClues(theme, language, uniqueAnswers, clueByAnswer, notesByAnswer, thematicSet);

    const openingEntries = pruneForbiddenPublishAnswersIfPossible(
      pruneMaskedDuplicateAnswers(
        repairPublishClues(applyCluesAndOverrides(theme, language, opening.derived, clueByAnswer), {
          theme,
          language,
          thematicSet,
          notesByAnswer,
        })
      ).filter((entry) =>
        isPublishableAnswerForTheme({
          theme,
          answer: entry.answer,
          language,
          size: 11,
          note: notesByAnswer.get(entry.answer),
          allowContextualGeneric: thematicSet.has(entry.answer),
        })
      ),
      targetEntries
    );

    const minLen = minEntryLenForSize(11);
    const openingQualityIssue = publishQualityIssue(openingEntries, thematicSet, language, targetEntries);
    const openingCrossed = crossedEntryStats(opening.grid, openingEntries, minLen);
    const openingEntryCrossings = entryCrossingStats(opening.grid, openingEntries, minLen);
    const openingChecked = checkedCellStats(opening.grid, minLen);
    const openingDensity = crosswordDensityFromGrid(opening.grid);
    const openingThemeEntries = openingEntries.filter((entry) => thematicSet.has(entry.answer)).length;
    const openingCoreThematicEntries = openingEntries.filter((entry) =>
      coreThematicSet.has(entry.answer)
    ).length;
    const openingGenericContextEntries = openingEntries.filter(
      (entry) => thematicSet.has(entry.answer) && !coreThematicSet.has(entry.answer)
    ).length;
    const openingMinThemeEntries = minThematicEntriesForPublish(11, openingEntries.length);
    const openingMinCoreEntries = minCoreThematicEntriesForPublish(11, openingEntries.length);
    const openingMaxGenericEntries = maxGenericContextEntriesForPublish(11, openingEntries.length);
    const openingPlaceholderCount = openingEntries.filter((entry) =>
      isPlaceholderClue(entry.clue, language)
    ).length;
    const hasShortRuns = hasShortLetterRuns(opening.grid, minLen);

    if (
      openingEntries.length < targetEntries ||
      openingCrossed.crossed < openingEntries.length ||
      openingEntryCrossings.weakEntries.length > 0 ||
      openingDensity < 0.4 ||
      openingChecked.ratio < 0.25 ||
      openingThemeEntries < openingMinThemeEntries ||
      openingCoreThematicEntries < openingMinCoreEntries ||
      openingGenericContextEntries > openingMaxGenericEntries ||
      openingPlaceholderCount > 0 ||
      hasShortRuns ||
      openingQualityIssue
    ) {
      console.warn("[generate-crossword] opening deterministic rejected", {
        source,
        attempt,
        entries: openingEntries.length,
        answers: openingEntries.map((entry) => entry.answer),
        qualityIssue: openingQualityIssue,
        crossed: openingCrossed.crossed,
        weakEntries: openingEntryCrossings.weakEntries,
        density: openingDensity,
        checkedRatio: openingChecked.ratio,
        thematicEntries: openingThemeEntries,
        minThematicEntries: openingMinThemeEntries,
        coreThematicEntries: openingCoreThematicEntries,
        minCoreThematicEntries: openingMinCoreEntries,
        genericContextEntries: openingGenericContextEntries,
        maxGenericContextEntries: openingMaxGenericEntries,
        placeholderCount: openingPlaceholderCount,
        hasShortRuns,
        ...opening.meta,
      });
      return null;
    }

    console.warn("[generate-crossword] FALLBACK -> opening deterministic 11x11", {
      source,
      attempt,
      previousEntries,
      entries: openingEntries.length,
      thematicEntries: openingThemeEntries,
      coreThematicEntries: openingCoreThematicEntries,
      genericContextEntries: openingGenericContextEntries,
      density: openingDensity,
      checkedRatio: openingChecked.ratio,
      ...opening.meta,
    });

    return {
      theme,
      language,
      size: 11,
      grid: opening.grid,
      entries: openingEntries,
      meta: {
        source,
        attempt,
        fallbackScore,
        previousEntries,
        crossedEntries: openingCrossed.crossed,
        checkedRatio: openingChecked.ratio,
        thematicEntries: openingThemeEntries,
        minThematicEntries: openingMinThemeEntries,
        coreThematicEntries: openingCoreThematicEntries,
        minCoreThematicEntries: openingMinCoreEntries,
        genericContextEntries: openingGenericContextEntries,
        density: openingDensity,
        maxGenericContextEntries: openingMaxGenericEntries,
        minCrossingsPerEntry: minCrossingsPerEntryForPublish(11),
        minEntryCheckedCells: openingEntryCrossings.minCheckedCells,
        ...opening.meta,
        ...extraMeta,
      },
    };
  }


  const MAX_ATTEMPTS = n === 11 ? 2 : 1;
  const allowModelRescueFor11 = n === 11 && process.env.OPENAI_11X11_MODEL_RESCUE !== "0";
  let bestPartial: BestPartial | null = null;
  let lastAttemptPool: WordCandidate[] = [];
  let lastModelError: string | null = null;
  let lastAnswerbankIssue: string | null = null;
  let lastBuildIssue: Record<string, unknown> | null = null;
  let lastAnswerStats: Record<string, unknown> | null = null;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const attemptDeadlineCheckMs =
        attempt === 1 && firstAttemptDeadlineCheckMs !== undefined ? firstAttemptDeadlineCheckMs : Date.now();
      if (attemptDeadlineCheckMs > deadlineMs) break;
      console.warn("[generate-crossword] attempt start", { attempt, MAX_ATTEMPTS });

      const preparedAttempt = await prepareAttemptAnswers({ attempt });
      lastModelError = preparedAttempt.lastModelError;
      if (preparedAttempt.lastAnswerStats !== undefined) {
        lastAnswerStats = preparedAttempt.lastAnswerStats ?? null;
      }
      if (preparedAttempt.status === "continue") {
        continue;
      }
      if (preparedAttempt.status === "skip") {
        lastAnswerbankIssue = preparedAttempt.issue;
        continue;
      }

      const {
        cspBankAuditReport,
        notesByAnswer,
        thematicKeepSet,
        publishThemeSet,
        placementThemeSet,
        rawPool,
      } = preparedAttempt;
      lastAnswerStats = preparedAttempt.lastAnswerStats;
    const cspOrchestrationPrepared = prepareCspOrchestration({
      theme,
      language,
      attempt,
      rawPool,
      thematicKeepSet,
      cspBankAuditReport,
      hybridDiagnostic: csp11HybridDiagnostic,
    });

    const placementCoreThemeSet =
      n === 11 ? new Set(placementThemeSet) : placementThemeSet;
    const placementPool =
      n === 11
        ? rawPool.map((candidate) =>
            candidate.thematic && !placementCoreThemeSet.has(candidate.answer)
              ? {
                  ...candidate,
                  thematic: false,
                  source: candidate.source === "model" ? "support" : candidate.source,
                }
              : candidate
          )
        : rawPool;
    cspBankAuditSetDistribution(
      cspBankAuditReport,
      "pool-after-placement-thematic-remap",
      placementPool.map((candidate) => candidate.answer)
    );

    const byPriority = [...placementPool].sort((a, b) => {
      const at = placementCoreThemeSet.has(a.answer) ? 1 : 0;
      const bt = placementCoreThemeSet.has(b.answer) ? 1 : 0;
      if (at !== bt) return bt - at;
      return b.answer.length - a.answer.length;
    });

    const basePool = pickPoolForSize(byPriority, {
      size: n,
      placementCoreThemeSet,
      minEntryLenForSize,
    });
    cspBankAuditSetDistribution(
      cspBankAuditReport,
      "pool-after-pickPoolForSize",
      basePool.map((candidate) => candidate.answer)
    );
    cspBankAuditRejectedBySet(
      cspBankAuditReport,
      "pickPoolForSize",
      placementPool.map((candidate) => candidate.answer),
      basePool.map((candidate) => candidate.answer),
      "cap-or-pool-truncation"
    );

const pool =
  n === 11
    ? (() => {
        const thematic = basePool
          .filter((c) => placementCoreThemeSet.has(c.answer) && c.answer.length >= minEntryLenForSize(n))
          .slice()
          .sort((a, b) => {
            const band = (len: number) => {
              if (len >= 5 && len <= 7) return 500;
              if (len === 8) return 380;
              if (len === 4) return 340;
              if (len === 3) return 260;
              if (len === 9) return 180;
              if (len === 10) return 80;
              return 0;
            };

            const diff = band(b.answer.length) - band(a.answer.length);
            if (diff !== 0) return diff;

            return b.answer.length - a.answer.length;
          });

        const support = basePool
          .filter(
            (c) =>
              !placementCoreThemeSet.has(c.answer) &&
              c.source === "support" &&
              c.answer.length >= 4 &&
              c.answer.length <= 7 &&
              !isForbiddenPublishAnswer(c.answer)
          )
          .slice()
          .sort((a, b) => {
            const band = (len: number) => {
              if (len === 5) return 520;
              if (len === 4) return 500;
              if (len === 6) return 460;
              if (len === 7) return 360;
              return 0;
            };

            const diff = band(b.answer.length) - band(a.answer.length);
            if (diff !== 0) return diff;

            return a.answer.length - b.answer.length;
          });

        const out: typeof basePool = [];
        const used = new Set<string>();

        const pushUnique = (items: typeof basePool, limit: number) => {
          for (const item of items) {
            if (used.has(item.answer)) continue;
            out.push(item);
            used.add(item.answer);
            if (limit > 0 && out.length >= limit) break;
          }
        };

        pushUnique(thematic.filter((c) => c.answer.length >= 5 && c.answer.length <= 8), 38);
        pushUnique(thematic.filter((c) => c.answer.length === 4 || c.answer.length === 9), 56);
        pushUnique(thematic.filter((c) => c.answer.length === 3), 64);
        pushUnique(thematic.filter((c) => c.answer.length >= 10), 66);
        const supportLimit = out.length + Math.max(8, Math.floor(Math.max(1, thematic.length) / 2));
        pushUnique(support.filter((c) => c.answer.length >= 4 && c.answer.length <= 7), supportLimit);
        pushUnique(basePool.filter((c) => placementCoreThemeSet.has(c.answer) && c.answer.length >= 4), 84);
        pushUnique(
          basePool.filter(
            (c) =>
              c.source !== "filler" &&
              placementCoreThemeSet.has(c.answer) &&
              c.answer.length >= 4 &&
              !isOverGenericThemeWordForTheme(theme, c.answer)
          ),
          84
        );
        return out.slice(0, 180);
      })()
    : rawPool;
if (n === 11) {
  cspBankAuditRejectedBySet(
    cspBankAuditReport,
    "final-pool-selection",
    basePool.map((candidate) => candidate.answer),
    pool.map((candidate) => candidate.answer),
    "cap-or-pool-truncation"
  );
}
cspBankAuditSetDistribution(
  cspBankAuditReport,
  "pool-after-final-selection",
  pool.map((candidate) => candidate.answer)
);
cspBankAuditReport.distributions.legacyPoolDistribution =
  cspBankAuditCandidateDistribution(pool);

console.warn("[generate-crossword] ok: pool", {
  attempt,
  pool: pool.length,
  lenCount: Object.fromEntries(
    pool.reduce((acc, c) => {
      acc.set(c.answer.length, (acc.get(c.answer.length) ?? 0) + 1);
      return acc;
    }, new Map<number, number>())
  ),
      });
      lastAttemptPool = pool;
      const seed = (theme.length * 2654435761 + n * 1013 + attempt * 9176) >>> 0;
      let cspBuilt: { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null = null;
      const cspResult = await runCspOrchestration({
        size: n,
        theme,
        language,
        attempt,
        seed,
        startedAtMs: t0,
        deadlineMs,
        enabled: csp11Enabled,
        alreadyAttempted: csp11Attempted,
        diagnosticOnly: csp11DiagnosticOnly,
        diagnosticBudgetMs: csp11DiagnosticBudgetMs,
        hybridDiagnostic: csp11HybridDiagnostic,
        answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
        client,
        prepared: cspOrchestrationPrepared,
        cspBankAuditReport,
        thematicKeepSet,
        publishThemeSet,
        placementThemeSet,
        dependencies: {
          validateThematicAnswers: ({ theme, language, size, answers, attempt }) =>
            validateThematicAnswers({
              client: client,
              theme,
              language,
              size,
              answers,
              attempt,
              answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
              sanitizeAnswerList,
            }),
        },
      });
      if (cspResult.attempted) {
        csp11Attempted = true;
      }
      if (cspResult.status === "accepted") {
        lastCspAttemptMeta = cspResult.metadata.attemptMeta;
        cspBuilt = cspResult.crossword;
      } else if (cspResult.status === "rejected") {
        lastCspAttemptMeta = cspResult.metadata.attemptMeta;
      } else if (cspResult.status === "diagnostic") {
        lastCspAttemptMeta = cspResult.metadata.attemptMeta;
        return diagnostic(cspResult.diagnostics.responsePayload);
      }
      if (!cspBuilt && n === 11 && process.env.ENABLE_EARLY_OPENING_11 === "1") {
        const earlyOpeningThematicSet = new Set<string>();
        const earlyOpeningCoreThematicSet = new Set<string>();

        for (const candidate of pool) {
          if (candidate.source === "filler") continue;
          if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
          if (LOW_VALUE_CONTEXTLESS_ANSWERS.has(candidate.answer)) continue;

          const strong =
            placementCoreThemeSet.has(candidate.answer) ||
            thematicKeepSet.has(candidate.answer) ||
            hasStrongThematicClueSupport({
              theme,
              answer: candidate.answer,
              language,
              note: notesByAnswer.get(candidate.answer),
            });

          if (!strong && candidate.source === "support") continue;
          earlyOpeningThematicSet.add(candidate.answer);
          if (!CONTEXTUAL_SUPPORT_ANSWERS.has(candidate.answer)) {
            earlyOpeningCoreThematicSet.add(candidate.answer);
          }
        }

        const earlyOpening = await tryOpeningDeterministic11({
          client,
          theme,
          language,
          candidates: pool,
          notesByAnswer,
          thematicSet: earlyOpeningThematicSet,
          coreThematicSet: earlyOpeningCoreThematicSet,
          seed: (seed ^ 0x6d2b79f5) >>> 0,
          targetEntries: minPublishEntriesForSize(n),
          deadlineMs: Date.now() + 18_000,
          source: "fallback-fast-opening-deterministic-11",
          attempt,
          extraMeta: {
            reason: "Published from validated opening builder before expensive rescue passes.",
          },
        });

        if (earlyOpening) {
          return accepted(earlyOpening satisfies Crossword);
        }
      }
      const buildDeadlineMs = n === 11 ? Date.now() + 25_000 : Date.now() + 8_000;
      const localBuildDeadlineMs = n === 11 ? Date.now() + 25_000 : Date.now() + 8_000;

      const dictionaryPatternLayoutCandidate =
        !cspBuilt && n === 11 && process.env.ENABLE_DICTIONARY_PATTERN_11 === "1"
          ? runLegacyBuilder({ mode: "pattern-11", dependencies: legacyBuilderDependencies,
              theme,
              size: n,
              candidates: pool,
              seed: (seed ^ 0x13198a2e) >>> 0,
              deadlineMs: Math.min(deadlineMs - 5_000, Date.now() + 35_000),
            })
          : null;
      const dictionaryPatternThematicCount =
        typeof dictionaryPatternLayoutCandidate?.meta?.thematicCount === "number"
          ? dictionaryPatternLayoutCandidate.meta.thematicCount
          : 0;
      const dictionaryPatternLayout =
        dictionaryPatternLayoutCandidate &&
        dictionaryPatternThematicCount >= minCoreThematicEntriesForPublish(
          n,
          dictionaryPatternLayoutCandidate.usedAnswers.length
        )
          ? dictionaryPatternLayoutCandidate
          : null;
      if (dictionaryPatternLayoutCandidate && !dictionaryPatternLayout) {
        console.warn("[generate-crossword] conventional pattern rejected for weak theme coverage", {
          entries: dictionaryPatternLayoutCandidate.usedAnswers.length,
          thematicEntries: dictionaryPatternThematicCount,
        });
      }
      let earlyValidatedLayout: { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null =
        dictionaryPatternLayout;
      if (
        !cspBuilt &&
        n === 11 &&
        allowModelRescueFor11 &&
        process.env.OPENAI_EARLY_LAYOUT_11 !== "0" &&
        Date.now() < deadlineMs - 25_000
      ) {
        {
          try {
            const generatedFixedGrid = await requestGeneratedPatternGrid11WithDependencies({ dependencies: openAiRepairServicesDependencies,
              client,
              theme,
              language,
              size: n,
              attempt,
            });
            if (generatedFixedGrid) {
              for (const [answer, note] of generatedFixedGrid.notes) {
                notesByAnswer.set(answer, note);
              }
              for (const answer of generatedFixedGrid.thematicAnswers) {
                thematicKeepSet.add(answer);
                publishThemeSet.add(answer);
                placementThemeSet.add(answer);
              }
              earlyValidatedLayout = {
                grid: generatedFixedGrid.grid,
                usedAnswers: generatedFixedGrid.usedAnswers,
                meta: generatedFixedGrid.meta,
              };
            }
          } catch (error: unknown) {
            console.warn("[generate-crossword] generated fixed pattern failed; continuing local build", {
              attempt,
              msg: errorSummary(error),
            });
          }
        }

        if (!earlyValidatedLayout) {
          try {
            earlyValidatedLayout = await requestValidatedPatternAssignment11WithDependencies({ dependencies: openAiRepairServicesDependencies,
              client,
              theme,
              language,
              size: n,
              pool,
              themeSet: publishThemeSet,
            });
          } catch (error: unknown) {
            console.warn("[generate-crossword] early pattern assignment failed; continuing local build", {
              attempt,
              msg: errorSummary(error),
            });
          }
        }

        if (earlyValidatedLayout) {
          try {
            const contextualAnswers = earlyValidatedLayout.usedAnswers.filter(
              (answer) => !thematicKeepSet.has(answer)
            );
            if (contextualAnswers.length > 0) {
              const validatedContextual = await validateThematicAnswers({
                client,
                theme,
                language,
                size: n,
                answers: contextualAnswers,
                attempt,
                answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
                sanitizeAnswerList,
              });
              const validatedContextualSet = new Set(validatedContextual);
              if (contextualAnswers.some((answer) => !validatedContextualSet.has(answer))) {
                console.warn("[generate-crossword] pattern assignment contextual validation rejected", {
                  attempt,
                  contextualAnswers,
                  validatedContextual,
                });
                earlyValidatedLayout = null;
              } else {
                for (const answer of validatedContextual) {
                  thematicKeepSet.add(answer);
                  publishThemeSet.add(answer);
                  placementThemeSet.add(answer);
                }
              }
            }
          } catch (error: unknown) {
            console.warn("[generate-crossword] pattern contextual validation failed", {
              attempt,
              msg: errorSummary(error),
            });
            earlyValidatedLayout = null;
          }
        }

        if (!earlyValidatedLayout) {
          try {
            earlyValidatedLayout = await requestValidatedGridProposalWithDependencies({ dependencies: openAiRepairServicesDependencies,
              client,
              theme,
              language,
              size: n,
              pool,
              themeSet: publishThemeSet,
            });
          } catch (error: unknown) {
            console.warn("[generate-crossword] early validated grid proposal failed; continuing local build", {
              attempt,
              msg: errorSummary(error),
            });
          }
        }

        if (!earlyValidatedLayout) {
          try {
            earlyValidatedLayout = await requestValidatedLayoutProposalWithDependencies({ dependencies: openAiRepairServicesDependencies,
              client,
              theme,
              language,
              size: n,
              pool,
              themeSet: publishThemeSet,
            });
          } catch (error: unknown) {
            console.warn("[generate-crossword] early model layout failed; continuing local build", {
              attempt,
              msg: errorSummary(error),
            });
          }
        }
      }

      const compactBuildDeadlineMs = n === 11 ? Math.min(localBuildDeadlineMs, Date.now() + 15_000) : Date.now();
      const compactBuiltOptions =
        !cspBuilt && n === 11
          ? Array.from({ length: 2 }, (_, idx) => idx)
              .map((idx) => {
                if (Date.now() >= compactBuildDeadlineMs - 500) return null;
                const compactPool =
                  idx === 0
                    ? pool.filter((candidate) => candidate.source !== "filler")
                    : idx === 1
                    ? pool.filter(
                        (candidate) =>
                          candidate.thematic &&
                          publishThemeSet.has(candidate.answer) &&
                          candidate.source !== "support"
                      )
                    : idx === 2
                    ? pool.filter(
                        (candidate) =>
                          candidate.thematic &&
                          publishThemeSet.has(candidate.answer)
                      )
                    : idx === 3
                    ? pool.filter(
                        (candidate) =>
                          candidate.thematic ||
                          (candidate.source === "support" &&
                            hasStrongThematicClueSupport({
                              theme,
                              answer: candidate.answer,
                              language,
                              note: notesByAnswer.get(candidate.answer),
                            }))
                      )
                    : pool.filter((candidate) => candidate.source !== "filler");

                if (compactPool.length < minPublishEntriesForSize(n)) return null;
                return runLegacyBuilder({ mode: "compact-pattern-11", dependencies: legacyBuilderDependencies,
                  theme,
                  size: n,
                  seed: (seed ^ 0x7f4a7c15 ^ Math.imul(idx + 1, 0x9e3779b9)) >>> 0,
                  candidates: compactPool,
                  deadlineMs: Math.min(compactBuildDeadlineMs, Date.now() + 7_000),
                });
              })
              .filter((candidate): candidate is { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } =>
                Boolean(candidate)
              )
          : [];

      const strictBuilt =
        !cspBuilt && n === 11 && compactBuiltOptions.length === 0 && Date.now() < localBuildDeadlineMs - 1500
          ? runLegacyBuilder({ mode: "strict-11", dependencies: legacyBuilderDependencies,
              theme,
              size: n,
              seed,
              candidates: pool,
              deadlineMs: localBuildDeadlineMs,
            })
          : null;

      const freeformBuildDeadlineMs = Date.now() + (n === 11 ? 60_000 : 8_000);
      const corePublishThemeSet =
        n === 11
          ? buildCoreThematicSetFromPool({
              pool,
              trustedThematicSet: thematicKeepSet,
              theme,
              language,
              notesByAnswer,
            })
          : publishThemeSet;
      const freeformBuiltOptions =
        !cspBuilt && n === 11
          ? !strictBuilt && compactBuiltOptions.length === 0
            ? Array.from({ length: 8 }, (_, idx) => idx)
                .map((idx) => {
                  if (Date.now() >= freeformBuildDeadlineMs - 1500) return null;

                  const isCommonFreeformCandidate = (candidate: WordCandidate) => {
                    if (candidate.answer.length < minEntryLenForSize(n) || candidate.answer.length > n) return false;
                    if (!ASCII_A_TO_Z.test(candidate.answer)) return false;
                    if (isForbiddenPublishAnswer(candidate.answer)) return false;
                    if (
                      !isPublishableAnswerForTheme({
                        theme,
                        answer: candidate.answer,
                        language,
                        size: n,
                        note: notesByAnswer.get(candidate.answer),
                        allowContextualGeneric: candidate.source === "support" || candidate.thematic,
                      })
                    ) {
                      return false;
                    }
                    if (isOverGenericThemeWordForTheme(theme, candidate.answer)) return false;
                    return true;
                  };

                  const coreFreeformPool = pool.filter(
                    (candidate) =>
                      isCommonFreeformCandidate(candidate) &&
                      candidate.thematic &&
                      publishThemeSet.has(candidate.answer) &&
                      candidate.source !== "support"
                  );
                  const coreFreeformAnswerSet = new Set(coreFreeformPool.map((candidate) => candidate.answer));
                  const hybridFreeformPool = pool.filter(
                    (candidate) =>
                      isCommonFreeformCandidate(candidate) &&
                      (coreFreeformAnswerSet.has(candidate.answer) ||
                        (candidate.thematic &&
                          publishThemeSet.has(candidate.answer)) ||
                        (candidate.source === "support" &&
                          hasStrongThematicClueSupport({
                            theme,
                            answer: candidate.answer,
                            language,
                            note: notesByAnswer.get(candidate.answer),
                          })))
                  );
                  const broadFreeformPool = pool.filter(isCommonFreeformCandidate);
                  const freeformPool =
                    idx === 0 && broadFreeformPool.length >= minPublishEntriesForSize(n)
                      ? broadFreeformPool
                    : idx < 3 && hybridFreeformPool.length >= minPublishEntriesForSize(n)
                      ? hybridFreeformPool
                    : idx < 5 && coreFreeformPool.length >= minPublishEntriesForSize(n)
                      ? coreFreeformPool
                      : broadFreeformPool;

                  if (freeformPool.length < minPublishEntriesForSize(n)) return null;

                  return runFreeformBuilder({ dependencies: freeformBuilderDependencies,
                    size: n,
                    seed: (seed ^ 0x517cc1b7 ^ Math.imul(idx + 1, 0x85ebca6b)) >>> 0,
                    candidates: freeformPool,
                    deadlineMs: freeformBuildDeadlineMs,
                    maxPlacedWords: 42,
                    maxBuilds: 96,
                  });
                })
                .filter((candidate): candidate is { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } =>
                  Boolean(candidate)
                )
            : []
          : !strictBuilt
          ? Array.from({ length: 10 }, (_, idx) => idx)
              .map((idx) =>
                Date.now() < freeformBuildDeadlineMs - 1500
                  ? runFreeformBuilder({ dependencies: freeformBuilderDependencies,
                      size: n,
                      seed: (seed ^ 0x9e3779b9 ^ Math.imul(idx + 1, 0x85ebca6b)) >>> 0,
                      candidates: pool,
                      deadlineMs: freeformBuildDeadlineMs,
                      maxPlacedWords: 42,
                    })
                  : null
              )
              .filter((candidate): candidate is { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } =>
                Boolean(candidate)
              )
          : [];
      let built =
        n === 11
          ? cspBuilt ?? [earlyValidatedLayout, ...compactBuiltOptions, ...freeformBuiltOptions, strictBuilt]
              .filter((candidate): candidate is { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } =>
                Boolean(candidate)
              )
              .map((candidate) => {
                const pruned = pruneWeakEntriesPreservingCrosses(
                  candidate.grid,
                  minEntryLenForSize(n),
                  minPublishEntriesForSize(n)
                );
                if (!pruned) return candidate;
                return {
                  ...candidate,
                  grid: pruned.grid,
                  usedAnswers: Array.from(
                    new Set(pruned.derived.map((entry) => entry.answer))
                  ),
                  meta: {
                    ...candidate.meta,
                    weakEntriesPruned: true,
                    prunedEntryCount: pruned.derived.length,
                  },
                };
              })
              .sort((a, b) => {
                const score = (candidate: { grid: string[][]; usedAnswers: string[] }) => {
                  const scoreGrid = blockForbiddenAnswerRuns(
                    candidate.grid,
                    minEntryLenForSize(n)
                  );
                  const derived = deriveEntriesFromGrid(scoreGrid, minEntryLenForSize(n));
                  const crossed = crossedEntryStats(scoreGrid, derived, minEntryLenForSize(n));
                  const entryCrossings = entryCrossingStats(scoreGrid, derived, minEntryLenForSize(n));
                  const checked = checkedCellStats(scoreGrid, minEntryLenForSize(n));
                  const themeCount = derived.filter((entry) => publishThemeSet.has(entry.answer)).length;
                  const coreThemeCount = derived.filter((entry) => corePublishThemeSet.has(entry.answer)).length;
                  const nonThemeCount = derived.length - themeCount;
                  const genericContextCount = derived.length - coreThemeCount;
                  const genericAnyCount = derived.filter((entry) =>
                    isOverGenericThemeWordForTheme(theme, entry.answer)
                  ).length;
                  const invalidAnswers = derived.filter((entry) => {
                    if (MODEL_FRAGMENT_ANSWERS.has(entry.answer)) return true;
                    if (BANNED_ANSWERS.has(entry.answer) && !CONTEXTUAL_GENERIC_ANSWERS.has(entry.answer)) return true;
                    if (isLikelyBadAnswer(entry.answer) && !ALWAYS_ALLOW_ANSWERS.has(entry.answer)) return true;
                    return false;
                  }).length;
                  const shortRunPenalty = hasShortLetterRuns(scoreGrid, minEntryLenForSize(n)) ? 50000 : 0;
                  const hasPublishableEntryCount = derived.length >= minPublishEntriesForSize(n);
                  const hasPreferredEntryCount = derived.length >= desiredPublishEntriesForSize(n);
                  const structurallyClean =
                    invalidAnswers === 0 &&
                    shortRunPenalty === 0 &&
                    entryCrossings.weakEntries.length === 0 &&
                    checked.ratio >= 0.25;
                  return (
                    (hasPreferredEntryCount ? 3_000_000 : 0) +
                    (hasPublishableEntryCount ? 1_500_000 : 0) +
                    (hasPublishableEntryCount && structurallyClean ? 1_500_000 : 0) +
                    derived.length * 22000 +
                    Math.min(derived.length, desiredPublishEntriesForSize(n)) * 5000 +
                    coreThemeCount * 30000 +
                    themeCount * 9000 +
                    crossed.crossed * 4000 +
                    checked.ratio * 3000 -
                    nonThemeCount * 5000 -
                    genericContextCount * 9000 -
                    genericAnyCount * 4500 -
                    entryCrossings.weakEntries.length * (hasPublishableEntryCount ? 100000 : 10000) -
                    invalidAnswers * 120000 -
                    shortRunPenalty
                  );
                };
                return score(b) - score(a);
              })[0] ?? null
          : runFreeformBuilder({ dependencies: freeformBuilderDependencies,
              size: n,
              seed,
              candidates: pool,
              deadlineMs: buildDeadlineMs,
            });

      const allowModelLayoutGridUpgradeFor11 =
        !cspBuilt && n === 11 && allowModelRescueFor11 && process.env.OPENAI_11X11_MODEL_LAYOUT_GRID_UPGRADE === "1";

      if (allowModelLayoutGridUpgradeFor11 && built) {
        const builtDerivedForLayoutCheck = deriveEntriesFromGrid(
          built.grid,
          minEntryLenForSize(n)
        );
        const builtEntryCrossingsForLayoutCheck = entryCrossingStats(
          built.grid,
          builtDerivedForLayoutCheck,
          minEntryLenForSize(n)
        );
        if (
          builtDerivedForLayoutCheck.length < minPublishEntriesForSize(n) ||
          builtEntryCrossingsForLayoutCheck.weakEntries.length > 0
        ) {
          let layoutUpgrade: { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null = null;
          try {
            layoutUpgrade = await requestValidatedLayoutProposalWithDependencies({ dependencies: openAiRepairServicesDependencies,
              client,
              theme,
              language,
              size: n,
              pool,
              themeSet: publishThemeSet,
            });
          } catch (error: unknown) {
            console.warn("[generate-crossword] model layout upgrade failed; keeping local build", {
              attempt,
              entries: builtDerivedForLayoutCheck.length,
              msg: errorSummary(error),
            });
          }
          if (layoutUpgrade) {
            const layoutUpgradeDerived = deriveEntriesFromGrid(
              layoutUpgrade.grid,
              minEntryLenForSize(n)
            );
            if (layoutUpgradeDerived.length > builtDerivedForLayoutCheck.length) {
              built = {
                ...layoutUpgrade,
                meta: {
                  ...layoutUpgrade.meta,
                  upgradedWeakLocalBuild: true,
                  previousEntries: builtDerivedForLayoutCheck.length,
                },
              };
            }
          }

          if (builtDerivedForLayoutCheck.length < minPublishEntriesForSize(n)) {
            let gridUpgrade: { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null = null;
            try {
              gridUpgrade = await requestValidatedGridProposalWithDependencies({ dependencies: openAiRepairServicesDependencies,
                client,
                theme,
                language,
                size: n,
                pool,
                themeSet: publishThemeSet,
              });
            } catch (error: unknown) {
              console.warn("[generate-crossword] model grid upgrade failed; keeping local build", {
                attempt,
                entries: builtDerivedForLayoutCheck.length,
                msg: errorSummary(error),
              });
            }
            if (gridUpgrade) {
              const gridUpgradeDerived = deriveEntriesFromGrid(
                gridUpgrade.grid,
                minEntryLenForSize(n)
              );
              const currentDerived = deriveEntriesFromGrid(
                built.grid,
                minEntryLenForSize(n)
              );
              if (gridUpgradeDerived.length > currentDerived.length) {
                built = {
                  ...gridUpgrade,
                  meta: {
                    ...gridUpgrade.meta,
                    upgradedWeakLocalBuild: true,
                    previousEntries: currentDerived.length,
                  },
                };
              }
            }
          }
        }
      }

      if (!built) {
        let layoutProposal: { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null = null;
        if (allowModelLayoutGridUpgradeFor11) {
          try {
            layoutProposal = await requestValidatedLayoutProposalWithDependencies({ dependencies: openAiRepairServicesDependencies,
              client,
              theme,
              language,
              size: n,
              pool,
              themeSet: publishThemeSet,
            });
          } catch (error: unknown) {
            console.warn("[generate-crossword] model layout after null builder failed", {
              attempt,
              msg: errorSummary(error),
            });
          }
        }

        if (layoutProposal) {
          console.warn("[generate-crossword] accepted validated model layout after builder null", {
            attempt,
            entries: layoutProposal.usedAnswers.length,
            builder: layoutProposal.meta.builder,
          });
          built = {
            ...layoutProposal,
            meta: {
              ...layoutProposal.meta,
              recoveredFromNullBuilder: true,
            },
          };
        }

        if (!built) {
          let gridProposal: { grid: string[][]; usedAnswers: string[]; meta: Record<string, unknown> } | null = null;
          if (allowModelLayoutGridUpgradeFor11) {
            try {
              gridProposal = await requestValidatedGridProposalWithDependencies({ dependencies: openAiRepairServicesDependencies,
                client,
                theme,
                language,
                size: n,
                pool,
                themeSet: publishThemeSet,
              });
            } catch (error: unknown) {
              console.warn("[generate-crossword] model grid after null builder failed", {
                attempt,
                msg: errorSummary(error),
              });
            }
          }

          if (gridProposal) {
            console.warn("[generate-crossword] accepted validated model grid after builder null", {
              attempt,
              entries: gridProposal.usedAnswers.length,
              builder: gridProposal.meta.builder,
            });
            built = {
              ...gridProposal,
              meta: {
                ...gridProposal.meta,
                recoveredFromNullBuilder: true,
              },
            };
          }
        }
      }

      if (!built) {
        if (n === 11) {
          const trustedForNullBuilder = new Set(
            pool
              .filter((candidate) => thematicKeepSet.has(candidate.answer))
              .filter((candidate) => candidate.source !== "filler")
              .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
              .map((candidate) => candidate.answer)
          );
          const rescue = await runThemeFirstRescue({ dependencies: themeFirstRescueDependencies,
            client,
            theme,
            language,
            size: n,
            pool,
            notesByAnswer,
            trustedThematicSet: trustedForNullBuilder,
            seedBase: (seed ^ 0x7f4a7c15) >>> 0,
          });

          if (rescue) {
          console.warn("[generate-crossword] published null-builder theme-first rescue", {
            attempt,
            entries: rescue.entries.length,
            source: rescue.meta?.source,
          });
            return accepted(rescue);
          }
        }

        lastBuildIssue = {
          stage: "builder-null",
          attempt,
          pool: pool.length,
          builder: n === 11 ? "pattern/freeform-11x11" : "freeform",
        };
        console.warn("[generate-crossword] skip: builder returned null", {
          attempt,
          builder: n === 11 ? "pattern/freeform-11x11" : "freeform",
        });
        continue;
      }

      const selectedBuilder = typeof built.meta?.builder === "string" ? built.meta.builder : "";
      if (n === 11 && selectedBuilder.startsWith("freeform")) {
        const allowedAnswers = new Set(
          pool
            .filter((c) => c.source !== "filler" || c.answer.length >= 4)
            .map((c) => c.answer)
        );
        const cleaned = rebuildGridFromAllowedEntries(
          built.grid,
          allowedAnswers,
          minEntryLenForSize(n)
        );

        if (cleaned) {
          built.grid = cleaned.grid;
          built.usedAnswers = Array.from(new Set(cleaned.derived.map((e) => e.answer)));
          built.meta = {
            ...built.meta,
            cleanedFreeform11: true,
            cleanedEntryCount: cleaned.derived.length,
          };
        }
      }

      let letterCount =
        built.grid.flat().filter((ch) => ch && ch !== "#").length;

      console.log("[generate-crossword] built stats", {
        hasBuilt: true,
        letterCount,
        usedAnswers: built.usedAnswers?.length ?? 0,
        builder: built.meta?.builder ?? null,
      });

      let derived = deriveEntriesFromGrid(built.grid, minEntryLenForSize(n));
      let checkedStats = checkedCellStats(built.grid, minEntryLenForSize(n));
      let crossedStats = crossedEntryStats(built.grid, derived, minEntryLenForSize(n));
      let entryCrossingStatsForBuilt = entryCrossingStats(built.grid, derived, minEntryLenForSize(n));
      let thematicDerivedCount = derived.filter((e) => publishThemeSet.has(e.answer)).length;
      let coreThematicDerivedCount = derived.filter((e) => corePublishThemeSet.has(e.answer)).length;
      let genericNonThemeCount = derived.reduce(
        (acc, e) => acc + (!publishThemeSet.has(e.answer) && isOverGenericThemeWordForTheme(theme, e.answer) ? 1 : 0),
        0
      );
      let nonThemeCount = derived.reduce(
        (acc, e) => acc + (!publishThemeSet.has(e.answer) ? 1 : 0),
        0
      );
      let genericAnyCount = derived.reduce(
        (acc, e) => acc + (isOverGenericThemeWordForTheme(theme, e.answer) ? 1 : 0),
        0
      );

      const fallbackScore =
        derived.length * 10000 +
        Math.min(derived.length, desiredPublishEntriesForSize(n)) * 2500 +
        Math.max(0, derived.length - minPublishEntriesForSize(n)) * 4500 +
        coreThematicDerivedCount * 18000 +
        thematicDerivedCount * 8000 +
        checkedStats.ratio * 5000 +
        (built.usedAnswers?.length ?? 0) * 1000 +
        letterCount * 10 -
        nonThemeCount * 4500 -
        genericNonThemeCount * 4500 -
        genericAnyCount * 3200 -
        entryCrossingStatsForBuilt.weakEntries.length *
          (derived.length >= minPublishEntriesForSize(n) ? 140000 : 18000);

      bestPartial = selectBetterBestPartial(
        bestPartial,
        createBestPartialCandidate({
          built,
          derived,
          pool,
          notesByAnswer,
          thematicKeepSet,
          attempt,
          fallbackScore,
        }),
        minPublishEntriesForSize(n)
      );

      let acceptable = isAcceptable(built.grid, derived, publishThemeSet);

      if (
        !acceptable &&
        selectedBuilder !== "csp-pattern-11x11" &&
        n === 11 &&
        derived.length >= minPublishEntriesForSize(n) - 6
      ) {
        const densified = densifyCleanGrid11WithDependencies({ dependencies: gridEnhancementDependencies,
          theme,
          grid: built.grid,
          candidates: pool.filter((candidate) => candidate.source !== "filler"),
          targetEntries: minPublishEntriesForSize(n),
          seed: (seed ^ 0xa24baed5 ^ Math.imul(derived.length + 1, 0x9e3779b9)) >>> 0,
          deadlineMs: Math.min(deadlineMs - 1_000, Date.now() + 14_000),
          pruneWeakEntries: false,
        });

        if (densified && densified.derived.length > derived.length) {
          built = {
            ...built,
            grid: densified.grid,
            usedAnswers: Array.from(new Set(densified.derived.map((entry) => entry.answer))),
            meta: {
              ...built.meta,
              ...densified.meta,
              densifiedBeforeModelRecovery: true,
            },
          };
          letterCount = built.grid.flat().filter((ch) => ch && ch !== "#").length;
          derived = deriveEntriesFromGrid(built.grid, minEntryLenForSize(n));
          checkedStats = checkedCellStats(built.grid, minEntryLenForSize(n));
          crossedStats = crossedEntryStats(built.grid, derived, minEntryLenForSize(n));
          entryCrossingStatsForBuilt = entryCrossingStats(built.grid, derived, minEntryLenForSize(n));
          thematicDerivedCount = derived.filter((e) => publishThemeSet.has(e.answer)).length;
          coreThematicDerivedCount = derived.filter((e) => corePublishThemeSet.has(e.answer)).length;
          genericNonThemeCount = derived.reduce(
            (acc, e) =>
              acc + (!publishThemeSet.has(e.answer) && isOverGenericThemeWordForTheme(theme, e.answer) ? 1 : 0),
            0
          );
          nonThemeCount = derived.reduce((acc, e) => acc + (!publishThemeSet.has(e.answer) ? 1 : 0), 0);
          genericAnyCount = derived.reduce(
            (acc, e) => acc + (isOverGenericThemeWordForTheme(theme, e.answer) ? 1 : 0),
            0
          );
          acceptable = isAcceptable(built.grid, derived, publishThemeSet);
        }
      }

      if (!acceptable) {
        lastBuildIssue = {
          stage: "isAcceptable-failed",
          attempt,
          entries: derived.length,
          thematicEntries: thematicDerivedCount,
          crossedEntries: crossedStats.crossed,
          checkedRatio: checkedStats.ratio,
          density: crosswordDensityFromGrid(built.grid),
          across: derived.filter((e) => e.direction === "across").length,
          down: derived.filter((e) => e.direction === "down").length,
          minEntryCheckedCells: entryCrossingStatsForBuilt.minCheckedCells,
          weakEntries: entryCrossingStatsForBuilt.weakEntries,
          hasShortRuns: hasShortLetterRuns(built.grid, minEntryLenForSize(n)),
          genericAnyCount,
          genericNonThemeCount,
        };
        console.warn("[generate-crossword] skip: isAcceptable failed", {
          attempt,
          entries: derived.length,
          letterCount,
          checkedRatio: checkedStats.ratio,
        });
        continue;
      }

      const rebuiltAccepted = rebuildGridFromEntries(n, derived, minEntryLenForSize(n));
      const gridForAccepted = rebuiltAccepted?.grid ?? built.grid;
      const derivedForAccepted = rebuiltAccepted?.derived ?? derived;
      const uniqueAnswers = Array.from(new Set(derivedForAccepted.map((e) => e.answer)));

      // Phase 3: clues-only (anti-hallucination)
      const clueByAnswer = new Map<string, string>();
      const thematicSet = new Set(
        pool
          .filter((c) => thematicKeepSet.has(c.answer) && !isOverGenericThemeWordForTheme(theme, c.answer))
          .map((c) => c.answer)
      );
      const publishableThemeAdjacentSet = new Set(
        pool
          .filter((c) => c.source !== "filler")
          .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer))
          .filter((c) =>
            hasStrongThematicClueSupport({
              theme,
              answer: c.answer,
              language,
              note: notesByAnswer.get(c.answer),
            })
          )
          .map((c) => c.answer)
      );
      const contextualAcceptedThematicSet = new Set(
        uniqueAnswers.filter((a) => {
          if (publishableThemeAdjacentSet.has(a)) return true;
          if (thematicSet.has(a)) return true;
          if (specificThematicFallbackClue(theme, a, language)) return true;
          const note = notesByAnswer.get(a);
          if (note && clueFromThemeNote(theme, note, language)) return true;
          return false;
        })
      );
      const clueItems: ClueRequestItem[] = uniqueAnswers.map((a) => {
        const note = notesByAnswer.get(a);
        const hint =
          buildThematicClueRequestHint(theme, a, language, note) ??
          (selectedBuilder === "pattern-11x11"
            ? language === "es"
              ? `Relacion factual concreta entre ${a} y ${theme}; mencionar ${theme}`
              : `Concrete factual connection between ${a} and ${theme}; mention ${theme}`
            : undefined);
        return {
          answer: a,
          thematic: contextualAcceptedThematicSet.has(a),
          note,
          hint: contextualAcceptedThematicSet.has(a) ? hint : undefined,
        };
      });

      if (n === 11) {
        for (const item of clueItems) {
          const note = item.note;
          const fromHint =
            item.hint &&
            !(selectedBuilder === "pattern-11x11" && !note) &&
            !clueMentionsAnswer(item.hint, item.answer)
              ? item.hint
              : null;
          const fromNote = note ? clueFromThemeNote(theme, note, language) : null;
          const specific = specificThematicFallbackClue(theme, item.answer, language);
          const clue =
            fromHint ??
            fromNote ??
            specific ??
            (item.thematic
              ? language === "es"
                ? `Referencia asociada con ${theme}`
                : `Reference associated with ${theme}`
              : language === "es"
              ? `Entrada vinculada al contexto de ${theme}`
              : `Entry linked to the context of ${theme}`);
          clueByAnswer.set(item.answer, sanitizeModelClueText(clue, language));
        }
      }

      try {
        const modelClues = await requestModelClues({
          client,
          theme,
          language,
          items: clueItems,
        });
        for (const [a, clue] of modelClues.entries()) {
          if (
            selectedBuilder === "pattern-11x11" &&
            !clue.toLowerCase().includes(theme.toLowerCase())
          ) {
            continue;
          }
          if (
            selectedBuilder === "pattern-11x11" &&
            /\b(mentioned in .* context|in .* context|word .* lyrics|quality aspired|referenced in .* performances)\b/i.test(
              clue
            )
          ) {
            continue;
          }
          clueByAnswer.set(a, clue);
        }
      } catch (e: unknown) {
        console.warn("[generate-crossword] pre-clue request failed", {
          attempt,
          name: e instanceof Error ? e.name : "unknown",
          msg: e instanceof Error ? e.message : String(e),
        });
      }

      reinforceThematicClues(
        theme,
        language,
        uniqueAnswers,
        clueByAnswer,
        notesByAnswer,
        contextualAcceptedThematicSet
      );

      const pendingClueItems = clueItems.filter((item) => !clueByAnswer.has(item.answer));
      if (pendingClueItems.length > 0) {
      const itemsJson = JSON.stringify(pendingClueItems);

      const cluebankRequest =
        CLUEBANK_PROMPT
          .replace("${theme}", theme)
          .replace("${languageLabel}", language === "es" ? "Spanish" : "English")
          .replace("${itemsJson}", itemsJson) +
        "\n\n" +
        (language === "es"
          ? [
              "REGLAS CRÍTICAS (OBLIGATORIAS):",
              "- NO inventes hechos específicos ni afirmaciones dudosas.",
              "- NO uses comillas ni títulos entre comillas.",
              "- Si la categoría temática es clara y segura, podés usar pistas de categoría: 'canción de...', 'álbum de...', 'guitarrista de...', 'variedad de uva', 'ciudad de...', etc.",
              "- Generá pistas SEGURAS y concretas; evitá las pistas demasiado abstractas.",
              "- Si no estás 100% seguro, devolvé una pista neutra tipo: 'Entrada temática (N letras)' o 'Palabra (N letras)'.",
              "- Devolvé SOLO JSON válido con { clues: [{ answer, clue }] }.",
            ].join("\n")
          : [
              "CRITICAL RULES (MANDATORY):",
              "- Do NOT invent specific facts or doubtful claims.",
              "- Do NOT use quotes or claim a title is from something.",
              "- If the thematic category is clear and safe, you may use category clues like 'song title', 'album title', 'band member', 'grape variety', 'city in...', etc.",
              "- Produce SAFE and concrete crossword-style clues; avoid overly abstract clues.",
              "- If you are not 100% sure, return a neutral clue like: 'Themed entry (N letters)' or 'Word (N letters)'.",
              "- Return ONLY valid JSON with { clues: [{ answer, clue }] }.",
            ].join("\n"));

      try {
        const completionClues = await client.chat.completions.create({
          model: CLUE_MODEL,
          temperature: 0,
          max_tokens: 1600,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Return ONLY valid JSON. No extra text." },
            { role: "user", content: cluebankRequest },
          ],
        });

        const rawCluesText = completionClues.choices?.[0]?.message?.content ?? "";
        const parsedClues = safeJson<RawClueBank>(rawCluesText);

        const looksFactualOrRisky = (clue: string) => {
          const c = clue.toLowerCase();

          // Quotes often indicate specific titles/claims
          if (c.includes('"') || c.includes("'")) return true;

          // High-risk assertion triggers (hallucination surface)
          if (
            /\b(from|released|debut|year|in \d{4}|feat\.|featuring|track|single|lyrics|cover|tour|lineup|formed|included|includes)\b/i.test(
              c
            )
          ) {
            return true;
          }

          // Otherwise OK (including SAFE category wording like "album title", "song title", etc.)
          return false;
        };

        if (parsedClues?.clues && Array.isArray(parsedClues.clues)) {
          for (const item of parsedClues.clues) {
            const a = normalizeAnswer(item.answer ?? "");
            const clue = (item.clue ?? "").toString().trim();
            if (!a || !clue) continue;
            if (!ASCII_A_TO_Z.test(a)) continue;
            if (isBadClue(clue)) continue;
            if (clueMentionsAnswer(clue, a)) continue;
            if (looksFactualOrRisky(clue)) continue;
            if (clueLooksOffTheme(theme, clue)) continue;

            clueByAnswer.set(a, clue);
          }
        }
      } catch (e: unknown) {
        console.warn("[generate-crossword] model2 failed", {
          attempt,
          name: e instanceof Error ? e.name : "unknown",
          msg: e instanceof Error ? e.message : String(e),
        });
      }
      }

      // Fill missing clues with SAFE neutral fallbacks
      for (const a of uniqueAnswers) {
        if (clueByAnswer.has(a)) continue;

        const themed = contextualAcceptedThematicSet.has(a);
        if (language === "es") {
          if (themed) {
            const note = notesByAnswer.get(a);
            if (note) {
              const synthesized = clueFromThemeNote(theme, note, language);
              if (synthesized) {
                clueByAnswer.set(a, synthesized);
                continue;
              }
            }
          }

          const specific = themed ? specificThematicFallbackClue(theme, a, language) : null;
          clueByAnswer.set(
            a,
            specific ?? (themed ? `Referencia asociada con ${theme}` : "Entrada comun de crucigrama")
          );
        } else {
          if (themed) {
            const note = notesByAnswer.get(a);
            if (note) {
              const synthesized = clueFromThemeNote(theme, note, language);
              if (synthesized) {
                clueByAnswer.set(a, synthesized);
                continue;
              }

              const cleaned = note.replace(/\s{2,}/g, " ").trim().replace(/\.$/, "");
              if (cleaned.length >= 8) {
                clueByAnswer.set(a, cleaned);
                continue;
              }
            }
          }

          const specific = themed ? specificThematicFallbackClue(theme, a, language) : null;
          clueByAnswer.set(a, specific ?? `Common word (${a.length})`);
        }
      }

      const finalAcceptedThematicSet = new Set(
        uniqueAnswers.filter((a) => {
          if (isOverGenericThemeWordForTheme(theme, a)) return false;
          if (contextualAcceptedThematicSet.has(a)) return true;
          return thematicKeepSet.has(a);
        })
      );

      reinforceThematicClues(
        theme,
        language,
        uniqueAnswers,
        clueByAnswer,
        notesByAnswer,
        finalAcceptedThematicSet
      );

      const acceptedEntriesSource =
        selectedBuilder === "csp-pattern-11x11"
          ? derivedForAccepted
          : n === 11
          ? derivedForAccepted.filter((e) => finalAcceptedThematicSet.has(e.answer))
          : derivedForAccepted;
      const safeAcceptedEntriesSource =
        acceptedEntriesSource.length >= 4
          ? acceptedEntriesSource
          : derivedForAccepted;
      const rebuiltPlayableAccepted =
        selectedBuilder !== "csp-pattern-11x11" && safeAcceptedEntriesSource.length > 0
          ? rebuildGridFromEntries(n, safeAcceptedEntriesSource, minEntryLenForSize(n))
          : null;
      const finalAcceptedGrid = rebuiltPlayableAccepted?.grid ?? gridForAccepted;
      const finalAcceptedDerived = rebuiltPlayableAccepted?.derived ?? safeAcceptedEntriesSource;

      const entries = applyCluesAndOverrides(theme, language, finalAcceptedDerived, clueByAnswer);
      const fullyCheckedAccepted = rebuildFullyCheckedPublishableCrosswordWithPolicies(
        theme,
        n,
        finalAcceptedGrid,
        language,
        n === 11 ? finalAcceptedThematicSet : thematicSet,
        clueByAnswer,
        gridReconstructionPolicies,
        n === 11 ? minPublishEntriesForSize(n) : 4
      );
      const sanitizedFullyCheckedAccepted =
        n === 11 && !(fullyCheckedAccepted && fullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n))
          ? rebuildSanitizedFullyCheckedPublishableCrosswordWithPolicies(
            theme,
            n,
            finalAcceptedGrid,
            language,
            finalAcceptedThematicSet,
            clueByAnswer,
            gridReconstructionPolicies,
            minPublishEntriesForSize(n)
          )
          : null;
      const exactFullyCheckedAccepted = rebuildExactFullyCheckedPublishableCrosswordWithPolicies(
        theme,
        n,
        entries,
        language,
        n === 11 ? finalAcceptedThematicSet : thematicSet,
        gridReconstructionPolicies,
        n === 11 ? minPublishEntriesForSize(n) : 3
      );
      const directAcceptedCheckedStats = checkedCellStats(
        finalAcceptedGrid,
        minEntryLenForSize(n)
      );
      const directAcceptedCrossedStats = crossedEntryStats(
        finalAcceptedGrid,
        entries,
        minEntryLenForSize(n)
      );
      const directAcceptedThemeEntries = entries.filter((e) =>
        finalAcceptedThematicSet.has(e.answer)
      ).length;
      const directAccepted11Publishable =
        n === 11 &&
        entries.length >= minPublishEntriesForSize(n) &&
        !hasShortLetterRuns(finalAcceptedGrid, minEntryLenForSize(n)) &&
        directAcceptedCrossedStats.crossed >= minCrossedEntriesForPublish(n) &&
        directAcceptedCheckedStats.ratio >= 0.25 &&
        directAcceptedThemeEntries >= 7;

      if (
        n === 11 &&
        !directAccepted11Publishable &&
        !(fullyCheckedAccepted && fullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)) &&
        !(sanitizedFullyCheckedAccepted && sanitizedFullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)) &&
        !(exactFullyCheckedAccepted && exactFullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n))
      ) {
        console.warn("[generate-crossword] skip: no clean accepted 11x11 publication", {
          attempt,
          entries: entries.length,
          fullyCheckedAccepted: fullyCheckedAccepted?.entries.length ?? 0,
          sanitizedFullyCheckedAccepted: sanitizedFullyCheckedAccepted?.entries.length ?? 0,
          exactFullyCheckedAccepted: exactFullyCheckedAccepted?.entries.length ?? 0,
        });
        continue;
      }
      const acceptedEntriesForResponseRaw =
        n === 11 && fullyCheckedAccepted && fullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)
          ? fullyCheckedAccepted.entries
          : n === 11 && sanitizedFullyCheckedAccepted && sanitizedFullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)
          ? sanitizedFullyCheckedAccepted.entries
          : n === 11 && exactFullyCheckedAccepted && exactFullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)
          ? exactFullyCheckedAccepted.entries
          : entries;
      const acceptedEntriesAfterClueRepair = repairPublishClues(acceptedEntriesForResponseRaw, {
        theme,
        language,
        thematicSet: finalAcceptedThematicSet,
        notesByAnswer,
      });
      const acceptedEntriesPruned = pruneForbiddenPublishAnswersIfPossible(
        pruneMaskedDuplicateAnswers(acceptedEntriesAfterClueRepair),
        minPublishEntriesForSize(n)
      );
      const acceptedPrunedRebuild =
        selectedBuilder !== "csp-pattern-11x11" &&
        acceptedEntriesPruned.length !== acceptedEntriesAfterClueRepair.length &&
        acceptedEntriesPruned.length >= minPublishEntriesForSize(n)
          ? rebuildGridFromEntries(n, acceptedEntriesPruned, minEntryLenForSize(n))
          : null;
      const acceptedEntriesForResponse =
        acceptedPrunedRebuild?.derived && acceptedPrunedRebuild.derived.length > 0
          ? repairPublishClues(applyCluesAndOverrides(theme, language, acceptedPrunedRebuild.derived, clueByAnswer), {
              theme,
              language,
              thematicSet: finalAcceptedThematicSet,
              notesByAnswer,
            })
          : acceptedEntriesPruned;
      const acceptedGridForResponseRaw =
        selectedBuilder === "csp-pattern-11x11"
          ? finalAcceptedGrid
          : n === 11 && fullyCheckedAccepted && fullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)
          ? fullyCheckedAccepted.grid
          : n === 11 && sanitizedFullyCheckedAccepted && sanitizedFullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)
          ? sanitizedFullyCheckedAccepted.grid
          : n === 11 && exactFullyCheckedAccepted && exactFullyCheckedAccepted.entries.length >= minPublishEntriesForSize(n)
          ? exactFullyCheckedAccepted.grid
          : finalAcceptedGrid;
      const acceptedGridForResponse = acceptedPrunedRebuild?.grid ?? acceptedGridForResponseRaw;

      const blandText = language === "es" ? "Definición breve." : "Brief definition.";
      const bland = acceptedEntriesForResponse.filter((e) => e.clue === blandText).length;
      const placeholderCount = acceptedEntriesForResponse.filter((e) => isPlaceholderClue(e.clue, language)).length;
      const acceptedQualityIssue = publishQualityIssue(
        acceptedEntriesForResponse,
        finalAcceptedThematicSet,
        language,
        minPublishEntriesForSize(n)
      );

      if (n === 11 && (bland > 0 || placeholderCount > 0 || acceptedQualityIssue)) {
        console.warn("[generate-crossword] skip: clue quality failed", {
          attempt,
          bland,
          placeholderCount,
          entries: acceptedEntriesForResponse.length,
          acceptedQualityIssue,
        });
        continue;
      }

      const out: Crossword = {
        theme,
        language,
        size: n,
        grid: acceptedGridForResponse,
        entries: acceptedEntriesForResponse,
          meta: {
            source: "answers-then-freeform-grid-then-clues",
            ...(lastCspAttemptMeta && { cspAttempt: lastCspAttemptMeta }),
            attempt,
            answerCount: cspBankAuditReport.initialRawCount,
          poolCount: pool.length,
          clueCount: clueByAnswer.size,
          bland,
          placeholderCount,
          ...built.meta,
        },
      };

      return accepted(out);
    }

    if (bestPartial && shouldRejectBestPartialForStrict11(n)) {
      const bestForGate = bestPartial;
      const bestThematicSet = new Set(
        bestForGate.pool
          .filter((c) => bestForGate.trustedThematicSet.has(c.answer))
          .map((c) => c.answer)
      );
      const bestCheckedStats = checkedCellStats(
        bestForGate.built.grid,
        minEntryLenForSize(n)
      );
      const bestCrossedStats = crossedEntryStats(
        bestForGate.built.grid,
        bestForGate.derived,
        minEntryLenForSize(n)
      );
      const bestThematicEntries = bestForGate.derived.filter((e) => bestThematicSet.has(e.answer)).length;
      const bestNearPublishEntries =
        n === 11 && bestForGate.derived.length >= minPublishEntriesForSize(n);
      const bestMinThematicEntries = bestNearPublishEntries
        ? minThematicEntriesForPublish(n, bestForGate.derived.length)
        : minThematicEntriesForPublish(n, bestForGate.derived.length);
      const bestLooksPublishable =
        (bestForGate.derived.length >= minPublishEntriesForSize(n) || bestNearPublishEntries) &&
        bestThematicEntries >= 7 &&
        bestCrossedStats.crossed >= minCrossedEntriesForPublish(n) &&
        bestCheckedStats.ratio >= 0.25;
      if (bestLooksPublishable) {
        console.warn("[generate-crossword] bestPartial passes 11x11 thresholds; attempting direct publish before reconstruction", {
          bestEntries: bestPartial.derived.length,
          bestThematicEntries,
          bestCrossedEntries: bestCrossedStats.crossed,
          bestCheckedRatio: bestCheckedStats.ratio,
        });
      }

      const bestEntryCrossingStats = entryCrossingStats(
        bestForGate.built.grid,
        bestForGate.derived,
        minEntryLenForSize(n)
      );
      if (
        n === 11 &&
        bestNearPublishEntries &&
        bestThematicEntries >= bestMinThematicEntries &&
        !hasShortLetterRuns(bestForGate.built.grid, minEntryLenForSize(n)) &&
        bestCrossedStats.crossed >= bestForGate.derived.length &&
        bestEntryCrossingStats.weakEntries.length === 0 &&
        bestCheckedStats.ratio >= 0.25 &&
        !bestForGate.derived.some((entry) => isForbiddenPublishAnswer(entry.answer))
      ) {
        const clueByAnswer = new Map<string, string>();
        const broadThematicSet = buildPublishThematicSetFromPool({
          pool: bestForGate.pool,
          trustedThematicSet: bestForGate.trustedThematicSet,
          theme,
          language,
          notesByAnswer: bestForGate.notesByAnswer,
          clueByAnswer,
        });
        const directCoreThematicSet = buildCoreThematicSetFromPool({
          pool: bestForGate.pool,
          trustedThematicSet: bestForGate.trustedThematicSet,
          theme,
          language,
          notesByAnswer: bestForGate.notesByAnswer,
          clueByAnswer,
        });
        for (const entry of bestForGate.derived) {
          const note = bestForGate.notesByAnswer.get(entry.answer);
          const thematic = broadThematicSet.has(entry.answer);
          const repaired = fallbackClueForPublishRepair(theme, entry.answer, language, thematic, note);
          const fromNote = note ? clueFromThemeNote(theme, note, language) : null;
          const specific = specificThematicFallbackClue(theme, entry.answer, language);
          clueByAnswer.set(
            entry.answer,
            repaired ??
              fromNote ??
              specific ??
              (thematic
                ? language === "es"
                  ? `Dato temático vinculado a ${theme}`
                  : `Thematic fact linked to ${theme}`
                : language === "es"
                ? `Elemento asociado al contexto de ${theme}`
                : `Element associated with ${theme}`)
          );
        }
        reinforceThematicClues(
          theme,
          language,
          bestForGate.derived.map((entry) => entry.answer),
          clueByAnswer,
          bestForGate.notesByAnswer,
          broadThematicSet
        );
        const directEntries = repairPublishClues(
          applyCluesAndOverrides(theme, language, bestForGate.derived, clueByAnswer),
          {
            theme,
            language,
            thematicSet: broadThematicSet,
            notesByAnswer: bestForGate.notesByAnswer,
          }
        );
        const directGenericContextEntries = directEntries.filter(
          (entry) => broadThematicSet.has(entry.answer) && !directCoreThematicSet.has(entry.answer)
        ).length;
        const directPlaceholderCount = directEntries.filter((entry) =>
          isPlaceholderClue(entry.clue, language)
        ).length;
        const directQualityIssue = publishQualityIssue(
          directEntries,
          broadThematicSet,
          language,
          minPublishEntriesForSize(n)
        );
        const directCoreEntries = directEntries.filter((entry) =>
          directCoreThematicSet.has(entry.answer)
        ).length;

        if (
          directEntries.length >= minPublishEntriesForSize(n) &&
          directPlaceholderCount === 0 &&
          !directQualityIssue &&
          directCoreEntries >= minCoreThematicEntriesForPublish(n, directEntries.length) &&
          directGenericContextEntries <= maxGenericContextEntriesForPublish(n, directEntries.length) &&
          bestEntryCrossingStats.weakEntries.length === 0
        ) {
          return accepted(
            {
              theme,
              language,
              size: n,
              grid: bestForGate.built.grid,
              entries: directEntries,
              meta: {
                source: "best-partial-direct-11",
                reason: "Published clean thematic 11x11 candidate before expensive rescue.",
                targetEntries: minPublishEntriesForSize(n),
                desiredEntries: desiredPublishEntriesForSize(n),
                entries: directEntries.length,
                trustedThematicEntries: bestThematicEntries,
                broadThematicEntries: directEntries.filter((entry) => broadThematicSet.has(entry.answer)).length,
                coreThematicEntries: directCoreEntries,
                genericContextEntries: directGenericContextEntries,
                crossedEntries: bestCrossedStats.crossed,
                checkedRatio: bestCheckedStats.ratio,
                minEntryCheckedCells: bestEntryCrossingStats.minCheckedCells,
                ...bestForGate.built.meta,
              },
            } satisfies Crossword
          );
        } else {
          console.warn("[generate-crossword] best-partial emergency direct rejected", {
            entries: directEntries.length,
            placeholderCount: directPlaceholderCount,
            qualityIssue: directQualityIssue,
            coreThematicEntries: directCoreEntries,
            minCoreThematicEntries: minCoreThematicEntriesForPublish(n, directEntries.length),
            genericContextEntries: directGenericContextEntries,
            maxGenericContextEntries: maxGenericContextEntriesForPublish(n, directEntries.length),
            weakCrossingEntries: bestEntryCrossingStats.weakEntries,
            trustedThematicEntries: bestThematicEntries,
            answers: directEntries.map((entry) => entry.answer),
          });
        }
      }

      {
        const rescue = allowModelRescueFor11
          ? await runThemeFirstRescue({ dependencies: themeFirstRescueDependencies,
              client,
              theme,
              language,
              size: n,
              pool: bestForGate.pool,
              notesByAnswer: bestForGate.notesByAnswer,
              trustedThematicSet: bestForGate.trustedThematicSet,
              seedBase: (theme.length * 40503 + n * 9176 + bestForGate.attempt * 2654435761) >>> 0,
            })
          : null;

        if (rescue) {
          console.warn("[generate-crossword] published theme-first 11x11 rescue", {
            bestEntries: bestForGate.derived.length,
            rescueEntries: rescue.entries.length,
            source: rescue.meta?.source,
          });
          return accepted(rescue);
        }

        if (
          bestForGate.derived.length >= minPublishEntriesForSize(n) &&
          bestThematicEntries >= 11 &&
          bestThematicEntries / bestForGate.derived.length >= 0.6 &&
          !hasShortLetterRuns(bestForGate.built.grid, minEntryLenForSize(n)) &&
          bestCrossedStats.crossed >= minCrossedEntriesForPublish(n) &&
          bestCheckedStats.ratio >= 0.25 &&
          !bestForGate.derived.some((entry) => isLikelyBadAnswer(entry.answer) && !ALWAYS_ALLOW_ANSWERS.has(entry.answer))
        ) {
          const uniqueAnswers = Array.from(new Set(bestForGate.derived.map((entry) => entry.answer)));
          const clueByAnswer = new Map<string, string>();
          let broadThematicSet = buildPublishThematicSetFromPool({
            pool: bestForGate.pool,
            trustedThematicSet: bestForGate.trustedThematicSet,
            theme,
            language,
            notesByAnswer: bestForGate.notesByAnswer,
            clueByAnswer,
          });
          const clueItems: ClueRequestItem[] = uniqueAnswers.map((answer) => {
            const note = bestForGate.notesByAnswer.get(answer);
            const thematic = broadThematicSet.has(answer);
            return {
              answer,
              thematic,
              note,
              hint: thematic ? buildThematicClueRequestHint(theme, answer, language, note) ?? undefined : undefined,
            };
          });

          try {
            const modelClues = await requestModelClues({
              client,
              theme,
              language,
              items: clueItems,
            });
            for (const [answer, clue] of modelClues.entries()) clueByAnswer.set(answer, clue);
          } catch (error: unknown) {
            console.warn("[generate-crossword] best-partial direct clues failed", {
              name: error instanceof Error ? error.name : "unknown",
              msg: error instanceof Error ? error.message : String(error),
            });
          }

          for (const answer of uniqueAnswers) {
            if (clueByAnswer.has(answer)) continue;
            const note = bestForGate.notesByAnswer.get(answer);
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

          broadThematicSet = buildPublishThematicSetFromPool({
            pool: bestForGate.pool,
            trustedThematicSet: bestForGate.trustedThematicSet,
            theme,
            language,
            notesByAnswer: bestForGate.notesByAnswer,
            clueByAnswer,
          });

          reinforceThematicClues(
            theme,
            language,
            uniqueAnswers,
            clueByAnswer,
            bestForGate.notesByAnswer,
            broadThematicSet
          );

          const directEntries = repairPublishClues(
            applyCluesAndOverrides(theme, language, bestForGate.derived, clueByAnswer),
            {
              theme,
              language,
              thematicSet: broadThematicSet,
              notesByAnswer: bestForGate.notesByAnswer,
            }
          );
          const directCoreThematicSet = buildCoreThematicSetFromPool({
            pool: bestForGate.pool,
            trustedThematicSet: bestForGate.trustedThematicSet,
            theme,
            language,
            notesByAnswer: bestForGate.notesByAnswer,
            clueByAnswer,
          });
          const directPlaceholderCount = directEntries.filter((entry) =>
            isPlaceholderClue(entry.clue, language)
          ).length;
          const directQualityIssue = publishQualityIssue(
            directEntries,
            broadThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const directCoreEntries = directEntries.filter((entry) =>
            directCoreThematicSet.has(entry.answer)
          ).length;
          const directGenericContextEntries = directEntries.filter(
            (entry) => broadThematicSet.has(entry.answer) && !directCoreThematicSet.has(entry.answer)
          ).length;
          const directBlocksPublish =
            directEntries.length < minPublishEntriesForSize(n) ||
            directPlaceholderCount > 0 ||
            directQualityIssue ||
            directCoreEntries < minCoreThematicEntriesForPublish(n, directEntries.length) ||
            directGenericContextEntries > maxGenericContextEntriesForPublish(n, directEntries.length) ||
            bestCrossedStats.crossed < directEntries.length ||
            bestEntryCrossingStats.weakEntries.length > 0 ||
            bestCheckedStats.ratio < 0.25;

          if (directBlocksPublish) {
            const directPlayableDegraded =
              directEntries.length >= minPublishEntriesForSize(n) &&
              directPlaceholderCount === 0 &&
              !directQualityIssue &&
              directCoreEntries >= minCoreThematicEntriesForPublish(n, directEntries.length) &&
              directGenericContextEntries <= maxGenericContextEntriesForPublish(n, directEntries.length) &&
              bestCrossedStats.crossed >= Math.max(6, directEntries.length - 1) &&
              bestEntryCrossingStats.weakEntries.length === 0 &&
              bestCheckedStats.ratio >= 0.25 &&
              !hasShortLetterRuns(bestForGate.built.grid, minEntryLenForSize(n)) &&
              !directEntries.some((entry) => isForbiddenPublishAnswer(entry.answer));

            if (directPlayableDegraded) {
              console.warn("[generate-crossword] best-partial direct degraded accepted", {
                entries: directEntries.length,
                placeholderCount: directPlaceholderCount,
                qualityIssue: directQualityIssue,
                weakCrossingEntries: bestEntryCrossingStats.weakEntries,
                checkedRatio: bestCheckedStats.ratio,
              });

              return accepted({
                theme,
                language,
                size: n,
                grid: bestForGate.built.grid,
                entries: directEntries,
                meta: {
                  source: "best-partial-direct-degraded-11",
                  reason: "Published playable 11x11 best partial before destructive reconstruction.",
                  entries: directEntries.length,
                  broadThematicEntries: directEntries.filter((entry) => broadThematicSet.has(entry.answer)).length,
                  coreThematicEntries: directCoreEntries,
                  genericContextEntries: directGenericContextEntries,
                  trustedThematicEntries: bestThematicEntries,
                  trustedThematicRatio: bestThematicEntries / directEntries.length,
                  crossedEntries: bestCrossedStats.crossed,
                  checkedRatio: bestCheckedStats.ratio,
                  minEntryCheckedCells: bestEntryCrossingStats.minCheckedCells,
                  weakCrossingEntries: bestEntryCrossingStats.weakEntries,
                  placeholderCount: directPlaceholderCount,
                  qualityIssue: directQualityIssue,
                  nearThreshold: true,
                  degraded: true,
                  ...bestForGate.built.meta,
                },
              } satisfies Crossword);
            }

            console.warn("[generate-crossword] best-partial direct rejected by clue quality gate", {
              entries: directEntries.length,
              placeholderCount: directPlaceholderCount,
              qualityIssue: directQualityIssue,
              coreEntries: directCoreEntries,
              minCoreEntries: minCoreThematicEntriesForPublish(n, directEntries.length),
              genericContextEntries: directGenericContextEntries,
              maxGenericContextEntries: maxGenericContextEntriesForPublish(n, directEntries.length),
              crossedEntries: bestCrossedStats.crossed,
              checkedRatio: bestCheckedStats.ratio,
              weakCrossingEntries: bestEntryCrossingStats.weakEntries,
              answers: directEntries.map((entry) => entry.answer),
            });
          } else {
          const directOut: Crossword = {
            theme,
            language,
            size: n,
            grid: bestForGate.built.grid,
            entries: directEntries,
            meta: {
              source: "best-partial-direct-11",
              reason: "Published structurally valid 11x11 instead of returning threshold error.",
              entries: directEntries.length,
              broadThematicEntries: directEntries.filter((entry) => broadThematicSet.has(entry.answer)).length,
              coreThematicEntries: directCoreEntries,
              genericContextEntries: directGenericContextEntries,
              trustedThematicEntries: bestThematicEntries,
              trustedThematicRatio: bestThematicEntries / directEntries.length,
              crossedEntries: bestCrossedStats.crossed,
              checkedRatio: bestCheckedStats.ratio,
              clueCount: clueByAnswer.size,
            },
          };

          return accepted(directOut);
          }
        }

        console.warn("[generate-crossword] bestPartial below early publish gate; continuing to fallback reconstruction", {
          bestEntries: bestForGate.derived.length,
          bestThematicEntries,
          bestCrossedEntries: bestCrossedStats.crossed,
          bestCheckedRatio: bestCheckedStats.ratio,
          minEntries: minPublishEntriesForSize(n),
          fallbackScore: bestPartial.fallbackScore,
          lastAnswerStats,
        });
      }
    }

    if (bestPartial) {
      if (n === 11 && bestPartial.derived.length < minPublishEntriesForSize(n) - 3) {
        console.warn("[generate-crossword] bestPartial small; continuing rescue instead of returning 422", {
          finalEntries: bestPartial.derived.length,
          minEntries: minPublishEntriesForSize(n),
          lastAnswerStats,
          lastBuildIssue,
        });
      }

      if (n === 11 && Date.now() > deadlineMs - 45_000) {
        const cleanupBest = bestPartial;
        if (cleanupBest.derived.length >= minPublishEntriesForSize(n)) {
          const cleanupDeadlineMs = Math.min(deadlineMs - 1_000, Date.now() + 22_000);
          const cleanupPool = cleanupBest.pool.filter((candidate) => candidate.source !== "filler");
          const cleanedGrid = hasShortLetterRuns(cleanupBest.built.grid, minEntryLenForSize(n))
            ? blockShortRunsOnly(cleanupBest.built.grid, minEntryLenForSize(n))
            : cleanupBest.built.grid;
          const cleanedDerived = deriveEntriesFromGrid(cleanedGrid, minEntryLenForSize(n));
          const cleanupBase =
            cleanedDerived.length >= minPublishEntriesForSize(n) - 2
              ? { grid: cleanedGrid, derived: cleanedDerived, added: [] as string[], meta: {} as Record<string, unknown> }
              : null;
          const noPruneDensified = densifyCleanGrid11WithDependencies({ dependencies: gridEnhancementDependencies,
              theme,
              grid: cleanedGrid,
              candidates: cleanupPool,
              targetEntries: minPublishEntriesForSize(n),
              seed: (theme.length * 1103515245 + cleanupBest.attempt * 12345 + n) >>> 0,
              deadlineMs: Math.min(cleanupDeadlineMs, Date.now() + 11_000),
              pruneWeakEntries: false,
            });
          const noPruneWeakCount = noPruneDensified
            ? entryCrossingStats(noPruneDensified.grid, noPruneDensified.derived, minEntryLenForSize(n)).weakEntries.length
            : Number.POSITIVE_INFINITY;
          const pruneDensified =
            noPruneWeakCount === 0 || Date.now() > cleanupDeadlineMs - 2_000
              ? null
              : densifyCleanGrid11WithDependencies({ dependencies: gridEnhancementDependencies,
                  theme,
                  grid: cleanedGrid,
                  candidates: cleanupPool,
                  targetEntries: minPublishEntriesForSize(n),
                  seed: (theme.length * 1103515245 + cleanupBest.attempt * 12345 + n ^ 0x85ebca6b) >>> 0,
                  deadlineMs: cleanupDeadlineMs,
                });
          const cleanedOrDensified =
            [noPruneDensified, pruneDensified, cleanupBase]
              .filter((candidate): candidate is { grid: string[][]; derived: DerivedEntry[]; added: string[]; meta: Record<string, unknown> } =>
                Boolean(candidate)
              )
              .sort((a, b) => {
                const weakA = entryCrossingStats(a.grid, a.derived, minEntryLenForSize(n)).weakEntries.length;
                const weakB = entryCrossingStats(b.grid, b.derived, minEntryLenForSize(n)).weakEntries.length;
                if (weakA !== weakB) return weakA - weakB;
                return b.derived.length - a.derived.length;
              })[0] ?? null;

          if (cleanedOrDensified) {
            const clueByAnswer = new Map<string, string>();
            const thematicSet = buildPublishThematicSetFromPool({
              pool: cleanupBest.pool,
              trustedThematicSet: cleanupBest.trustedThematicSet,
              theme,
              language,
              notesByAnswer: cleanupBest.notesByAnswer,
              clueByAnswer,
            });
            const coreThematicSet = buildCoreThematicSetFromPool({
              pool: cleanupBest.pool,
              trustedThematicSet: cleanupBest.trustedThematicSet,
              theme,
              language,
              notesByAnswer: cleanupBest.notesByAnswer,
              clueByAnswer,
            });
            const cleanupEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(
                applyCluesAndOverrides(theme, language, cleanedOrDensified.derived, clueByAnswer),
                {
                  theme,
                  language,
                  thematicSet,
                  notesByAnswer: cleanupBest.notesByAnswer,
                }
              )
            ).filter((entry) =>
              isPublishableAnswerForTheme({
                theme,
                answer: entry.answer,
                language,
                size: n,
                note: cleanupBest.notesByAnswer.get(entry.answer),
                allowContextualGeneric: thematicSet.has(entry.answer),
              })
            );
            const cleanupCrossed = crossedEntryStats(
              cleanedOrDensified.grid,
              cleanupEntries,
              minEntryLenForSize(n)
            );
            const cleanupEntryCrossings = entryCrossingStats(
              cleanedOrDensified.grid,
              cleanupEntries,
              minEntryLenForSize(n)
            );
            const cleanupChecked = checkedCellStats(cleanedOrDensified.grid, minEntryLenForSize(n));
            const cleanupThemeEntries = cleanupEntries.filter((entry) => thematicSet.has(entry.answer)).length;
            const cleanupCoreEntries = cleanupEntries.filter((entry) => coreThematicSet.has(entry.answer)).length;
            const cleanupGenericContextEntries = cleanupEntries.filter(
              (entry) => thematicSet.has(entry.answer) && !coreThematicSet.has(entry.answer)
            ).length;
            const cleanupQualityIssue = publishQualityIssue(
              cleanupEntries,
              thematicSet,
              language,
              minPublishEntriesForSize(n)
            );

            if (
              cleanupEntries.length >= minPublishEntriesForSize(n) &&
              cleanupCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              cleanupEntryCrossings.weakEntries.length === 0 &&
              cleanupChecked.ratio >= 0.25 &&
              cleanupThemeEntries >= minThematicEntriesForPublish(n, cleanupEntries.length) &&
              cleanupCoreEntries >= minCoreThematicEntriesForPublish(n, cleanupEntries.length) &&
              cleanupGenericContextEntries <= maxGenericContextEntriesForPublish(n, cleanupEntries.length) &&
              !hasShortLetterRuns(cleanedOrDensified.grid, minEntryLenForSize(n)) &&
              !cleanupQualityIssue
            ) {
              return accepted({
                theme,
                language,
                size: n,
                grid: cleanedOrDensified.grid,
                entries: cleanupEntries,
                meta: {
                  source: "deadline-cleanup-11",
                  reason: "Cleaned a threshold candidate before returning timeout.",
                  attempt: cleanupBest.attempt,
                  entries: cleanupEntries.length,
                  thematicEntries: cleanupThemeEntries,
                  coreThematicEntries: cleanupCoreEntries,
                  genericContextEntries: cleanupGenericContextEntries,
                  crossedEntries: cleanupCrossed.crossed,
                  checkedRatio: cleanupChecked.ratio,
                  minEntryCheckedCells: cleanupEntryCrossings.minCheckedCells,
                  cleanupAdded: cleanedOrDensified.added,
                  ...cleanupBest.built.meta,
                  ...cleanedOrDensified.meta,
                },
              } satisfies Crossword);
            }

            lastBuildIssue = {
              ...(lastBuildIssue ?? {}),
              stage: "deadline-cleanup-rejected",
              cleanupEntries: cleanupEntries.length,
              cleanupWeakEntries: cleanupEntryCrossings.weakEntries,
              cleanupHasShortRuns: hasShortLetterRuns(cleanedOrDensified.grid, minEntryLenForSize(n)),
              cleanupQualityIssue,
            };
          }
        }

        return failed(
          {
            source: "generation-time-budget",
            reason: "Se agotó el tiempo de construcción antes de obtener un 11x11 completamente chequeado.",
            finalEntries: bestPartial.derived.length,
            minEntries: minPublishEntriesForSize(n),
            lastAnswerStats,
            lastBuildIssue,
          },
        "unprocessable"
      );
      }
      const boundedFallbackDeadline = (sliceMs: number, reserveMs = 1_000) =>
        Math.min(deadlineMs - reserveMs, Date.now() + sliceMs);
      const fallbackDeadlineMs =
        n === 11 ? boundedFallbackDeadline(8_000) : Date.now() + 20_000;
      if (n === 11 && fallbackDeadlineMs <= Date.now() + 500) {
        return failed(
          {
            source: "generation-time-budget",
            reason: "Se agotó el tiempo de construcción antes de iniciar el rescate final.",
            finalEntries: bestPartial.derived.length,
            minEntries: minPublishEntriesForSize(n),
            lastAnswerStats,
            lastBuildIssue,
          },
        "unprocessable"
      );
      }
      const best = bestPartial;
      let fallbackBuilt = bestPartial.built;
      let fallbackDerivedSeed: DerivedEntry[] = bestPartial.derived;
      let fallbackPool: WordCandidate[] = bestPartial.pool;
      const fallbackStrictSeed =
        (theme.length * 2246822519 + bestPartial.attempt * 3266489917 + n * 131) >>> 0;

      if (n === 11) {
        const strictRepackPool: WordCandidate[] = bestPartial.pool.filter(
          (c: WordCandidate) =>
            c.source !== "filler" &&
            !isOverGenericThemeWordForTheme(theme, c.answer) &&
            hasStrongThematicClueSupport({
              theme,
              answer: c.answer,
              language,
              note: best.notesByAnswer.get(c.answer),
            })
        );
        const broadStrictRepackPool: WordCandidate[] = bestPartial.pool.filter(
          (c: WordCandidate) => c.source !== "filler" && !isOverGenericThemeWordForTheme(theme, c.answer)
        );

        const strictRepacked =
          strictRepackPool.length >= 6
            ? runLegacyBuilder({ mode: "strict-11", dependencies: legacyBuilderDependencies,
                theme,
                size: n,
                seed: fallbackStrictSeed,
                candidates: strictRepackPool,
                deadlineMs: fallbackDeadlineMs,
              })
            : null;
        const broadStrictRepacked =
          !strictRepacked && broadStrictRepackPool.length >= 8
            ? runLegacyBuilder({ mode: "strict-11", dependencies: legacyBuilderDependencies,
                theme,
                size: n,
                seed: (fallbackStrictSeed ^ 0x9e3779b9) >>> 0,
                candidates: broadStrictRepackPool,
                deadlineMs: fallbackDeadlineMs,
              })
            : null;
        const strictFallbackCandidate = strictRepacked ?? broadStrictRepacked;

        if (strictFallbackCandidate) {
          const strictDerived = deriveEntriesFromGrid(strictFallbackCandidate.grid, minEntryLenForSize(n));
          if (strictDerived.length >= 3) {
            fallbackBuilt = strictFallbackCandidate;
            fallbackDerivedSeed = strictDerived;
            fallbackPool = strictFallbackCandidate === strictRepacked ? strictRepackPool : broadStrictRepackPool;
          }
        }
      }

      const strictFallbackAllowedAnswers: Set<string> = new Set<string>(
        fallbackPool
          .filter((c) => c.source !== "filler")
          .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer))
          .filter((c) =>
            hasStrongThematicClueSupport({
              theme,
              answer: c.answer,
              language,
              note: best.notesByAnswer.get(c.answer),
            })
          )
          .map((c) => c.answer)
      );
      const broadFallbackAllowedAnswers: Set<string> = new Set<string>(
        fallbackPool
          .filter((c) => c.source !== "filler")
          .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer))
          .map((c) => c.answer)
      );
      const fallbackAllowedAnswers: Set<string> =
        n === 11
          ? broadFallbackAllowedAnswers
          : strictFallbackAllowedAnswers.size >= Math.max(4, Math.floor(fallbackDerivedSeed.length * 0.35))
          ? strictFallbackAllowedAnswers
          : broadFallbackAllowedAnswers;

      const trimmed = rebuildGridFromAllowedEntries(
        fallbackBuilt.grid,
        fallbackAllowedAnswers,
        minEntryLenForSize(n)
      );

      const baseGrid = trimmed?.grid ?? fallbackBuilt.grid;
      const baseDerived =
        trimmed?.derived && trimmed.derived.length >= Math.max(4, Math.floor(fallbackDerivedSeed.length * 0.35))
          ? trimmed.derived
          : fallbackDerivedSeed;

      const sanitizedGrid = sanitizeUncheckedGrid(baseGrid, minEntryLenForSize(n));
      const sanitizedDerived = deriveEntriesFromGrid(sanitizedGrid, minEntryLenForSize(n)).filter(
        (e) => fallbackAllowedAnswers.size === 0 || fallbackAllowedAnswers.has(e.answer)
      );
      const sanitizedChecked = checkedCellStats(sanitizedGrid, minEntryLenForSize(n));
      const originalChecked = checkedCellStats(baseGrid, minEntryLenForSize(n));

      const gridForFallback =
        sanitizedDerived.length >= Math.max(4, Math.floor(baseDerived.length * 0.6)) &&
        sanitizedChecked.ratio >= originalChecked.ratio
          ? sanitizedGrid
          : baseGrid;
      const derivedForFallback =
        gridForFallback === sanitizedGrid
          ? sanitizedDerived
          : baseDerived.filter((e) => fallbackAllowedAnswers.size === 0 || fallbackAllowedAnswers.has(e.answer));

      const safeDerivedForFallback =
        derivedForFallback.length >= Math.max(4, Math.floor(fallbackDerivedSeed.length * 0.35))
          ? derivedForFallback
          : fallbackDerivedSeed;

      const rebuiltFallback = rebuildGridFromEntries(n, safeDerivedForFallback, minEntryLenForSize(n));
      let finalFallbackGrid =
        rebuiltFallback?.derived && rebuiltFallback.derived.length > 0
          ? rebuiltFallback.grid
          : fallbackBuilt.grid;
      let finalFallbackDerived =
        rebuiltFallback?.derived && rebuiltFallback.derived.length > 0
          ? rebuiltFallback.derived
          : fallbackDerivedSeed;

      const densifiedFallback =
        n === 11 && finalFallbackDerived.length < minPublishEntriesForSize(n)
          ? densifyCleanGrid11WithDependencies({ dependencies: gridEnhancementDependencies,
              theme,
              grid: finalFallbackGrid,
              candidates: fallbackPool,
              targetEntries: minPublishEntriesForSize(n),
              seed: (fallbackStrictSeed ^ 0x510e527f) >>> 0,
              deadlineMs: fallbackDeadlineMs,
            })
          : null;

      if (densifiedFallback && densifiedFallback.derived.length > finalFallbackDerived.length) {
        finalFallbackGrid = densifiedFallback.grid;
        finalFallbackDerived = densifiedFallback.derived;
        fallbackBuilt = {
          ...fallbackBuilt,
          grid: densifiedFallback.grid,
          usedAnswers: Array.from(new Set(densifiedFallback.derived.map((entry) => entry.answer))),
          meta: {
            ...fallbackBuilt.meta,
            ...densifiedFallback.meta,
          },
        };
        fallbackDerivedSeed = densifiedFallback.derived;
      }

      const clueByAnswer = new Map<string, string>();
      const fallbackNotesByAnswer = best.notesByAnswer;
      const thematicSet = new Set(
        bestPartial.pool
          .filter((c) => fallbackAllowedAnswers.size === 0 || fallbackAllowedAnswers.has(c.answer))
          .filter((c) => best.trustedThematicSet.has(c.answer))
          .filter((c) =>
            hasStrongThematicClueSupport({
              theme,
              answer: c.answer,
              language,
              note: fallbackNotesByAnswer.get(c.answer),
            })
          )
          .map((c) => c.answer)
      );
      const strongThematicSet = new Set(
        bestPartial.pool
          .filter((c) => fallbackAllowedAnswers.size === 0 || fallbackAllowedAnswers.has(c.answer))
          .filter((c) => c.source !== "filler")
          .filter((c) => !(n === 11 && c.source === "support"))
          .filter((c) => !isOverGenericThemeWordForTheme(theme, c.answer))
          .filter((c) =>
            hasStrongThematicClueSupport({
              theme,
              answer: c.answer,
              language,
              note: fallbackNotesByAnswer.get(c.answer),
            })
          )
          .map((c) => c.answer)
      );
      const contextualFallbackThematicSet: Set<string> = new Set<string>(
        Array.from(new Set<string>(finalFallbackDerived.map((e) => e.answer))).filter((a) => {
          if (strongThematicSet.has(a)) return true;
          if (thematicSet.has(a)) return true;
          if (specificThematicFallbackClue(theme, a, language)) return true;
          const note = fallbackNotesByAnswer.get(a);
          if (note && clueFromThemeNote(theme, note, language)) return true;
          return false;
        })
      );

      const fallbackClueItems: ClueRequestItem[] = Array.from(
        new Set<string>(finalFallbackDerived.map((e) => e.answer))
      ).map((a) => {
        const note = fallbackNotesByAnswer.get(a);
        const hint = buildThematicClueRequestHint(theme, a, language, note) ?? undefined;
        return {
          answer: a,
          thematic: contextualFallbackThematicSet.has(a),
          note,
          hint: contextualFallbackThematicSet.has(a) ? hint : undefined,
        };
      });

      if (n !== 11) try {
        const modelClues = await requestModelClues({
          client,
          theme,
          language,
          items: fallbackClueItems,
        });
        for (const [a, clue] of modelClues.entries()) {
          clueByAnswer.set(a, clue);
        }
      } catch (e: unknown) {
        console.warn("[generate-crossword] fallback pre-clue request failed", {
          attempt: best.attempt,
          name: e instanceof Error ? e.name : "unknown",
          msg: e instanceof Error ? e.message : String(e),
        });
      }

      reinforceThematicClues(
        theme,
        language,
        Array.from(new Set(finalFallbackDerived.map((e) => e.answer))),
        clueByAnswer,
        fallbackNotesByAnswer,
        contextualFallbackThematicSet
      );

      for (const a of Array.from(new Set(finalFallbackDerived.map((e) => e.answer)))) {
        if (clueByAnswer.has(a)) continue;

        const themed = contextualFallbackThematicSet.has(a);
        if (language === "es") {
          if (themed) {
            const note = bestPartial.notesByAnswer.get(a);
            if (note) {
              const synthesized = clueFromThemeNote(theme, note, language);
              if (synthesized) {
                clueByAnswer.set(a, synthesized);
                continue;
              }
            }
          }

        const specific = themed ? specificThematicFallbackClue(theme, a, language) : null;
        clueByAnswer.set(
          a,
          specific ?? (themed ? `Referencia asociada con ${theme}` : "Entrada comun de crucigrama")
        );
          continue;
        }

        const note = bestPartial.notesByAnswer.get(a);
        if (themed && note) {
          const synthesized = clueFromThemeNote(theme, note, language);
          if (synthesized) {
            clueByAnswer.set(a, synthesized);
            continue;
          }

          const cleaned = note.replace(/\s{2,}/g, " ").trim().replace(/\.$/, "");
          if (cleaned.length >= 8) {
            clueByAnswer.set(a, cleaned);
            continue;
          }
        }

        const specific = themed ? specificThematicFallbackClue(theme, a, language) : null;
        clueByAnswer.set(
          a,
          specific ??
            (themed
              ? `Named thematic item from ${theme}`
              : `Supporting term for the ${theme} puzzle`)
        );
      }

      const finalFallbackThematicSet = new Set(
        Array.from(new Set(finalFallbackDerived.map((e) => e.answer))).filter((a) => {
          if (contextualFallbackThematicSet.has(a)) return true;
          return best.trustedThematicSet.has(a);
        })
      );
      const finalFallbackCoreThematicSet = buildCoreThematicSetFromPool({
        pool: bestPartial.pool,
        trustedThematicSet: best.trustedThematicSet,
        theme,
        language,
        notesByAnswer: fallbackNotesByAnswer,
        clueByAnswer,
      });
      for (const entry of finalFallbackDerived) {
        if (CONTEXTUAL_SUPPORT_ANSWERS.has(entry.answer)) {
          finalFallbackThematicSet.add(entry.answer);
        }
      }
      for (const candidate of fallbackPool) {
        if (candidate.source === "filler") continue;
        if (n === 11 && candidate.source === "support") continue;
        if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
        if (LOW_VALUE_CONTEXTLESS_ANSWERS.has(candidate.answer)) continue;
        if (
          n === 11 &&
          !isCoreThematicCandidate({
            candidate,
            trustedThematicSet: best.trustedThematicSet,
            theme,
            language,
            notesByAnswer: fallbackNotesByAnswer,
            clueByAnswer,
          })
        ) {
          continue;
        }
        finalFallbackThematicSet.add(candidate.answer);
        finalFallbackCoreThematicSet.add(candidate.answer);
      }

      reinforceThematicClues(
        theme,
        language,
        Array.from(new Set(finalFallbackDerived.map((e) => e.answer))),
        clueByAnswer,
        fallbackNotesByAnswer,
        finalFallbackThematicSet
      );

      const safeFinalFallbackGrid =
        finalFallbackDerived.length > 0 ? finalFallbackGrid : bestPartial.built.grid;
      const safeFinalFallbackDerived =
        finalFallbackDerived.length > 0 ? finalFallbackDerived : bestPartial.derived;

      const filteredFallbackDerived =
        n === 11
          ? safeFinalFallbackDerived.filter((e) => finalFallbackThematicSet.has(e.answer))
          : safeFinalFallbackDerived.filter(
              (e) => finalFallbackThematicSet.has(e.answer) || !isOverGenericThemeWordForTheme(theme, e.answer)
            );
      const finalEntriesSource =
        filteredFallbackDerived.length >= (n === 11 ? 3 : 4)
          ? filteredFallbackDerived
          : safeFinalFallbackDerived;

      const rebuiltRenderedFallback = rebuildGridFromEntries(n, finalEntriesSource, minEntryLenForSize(n));
      const renderedFallbackDerived =
        rebuiltRenderedFallback?.derived && rebuiltRenderedFallback.derived.length > 0
          ? rebuiltRenderedFallback.derived
          : finalEntriesSource;

      const clueableFallbackEntries = renderedFallbackDerived.filter((entry) => {
        const answer = entry.answer;
        if (!finalFallbackThematicSet.has(answer)) return n !== 11;
        const existingClue = clueByAnswer.get(answer);
        if (existingClue && !isPlaceholderClue(existingClue, language)) return true;
        const note = fallbackNotesByAnswer.get(answer);
        if (note && clueFromThemeNote(theme, note, language)) return true;
        if (specificThematicFallbackClue(theme, answer, language)) return true;
        return false;
      });

      const finalRenderedFallback =
        clueableFallbackEntries.length >= 3
          ? clueableFallbackEntries
          : renderedFallbackDerived;

      const rebuiltClueableFallback = rebuildGridFromEntries(n, finalRenderedFallback, minEntryLenForSize(n));
      const minimumFallbackEntries = Math.max(3, Math.floor(bestPartial.derived.length * 0.25));
      const fallbackResponseSource =
        rebuiltClueableFallback?.derived && rebuiltClueableFallback.derived.length >= minimumFallbackEntries
          ? rebuiltClueableFallback.derived
          : finalRenderedFallback.length >= minimumFallbackEntries
            ? finalRenderedFallback
            : renderedFallbackDerived.length >= minimumFallbackEntries
              ? renderedFallbackDerived
              : safeFinalFallbackDerived.length >= minimumFallbackEntries
              ? safeFinalFallbackDerived
              : bestPartial.derived;

      const rebuiltFinalResponse = rebuildGridFromEntries(n, fallbackResponseSource, minEntryLenForSize(n));
      const fallbackBasePair =
        safeFinalFallbackDerived.length > 0
          ? { grid: safeFinalFallbackGrid, derived: safeFinalFallbackDerived }
          : { grid: fallbackBuilt.grid, derived: fallbackDerivedSeed };
      const finalFallbackPair =
        rebuiltFinalResponse?.derived && rebuiltFinalResponse.derived.length >= minimumFallbackEntries
          ? { grid: rebuiltFinalResponse.grid, derived: rebuiltFinalResponse.derived }
          : fallbackBasePair;
      const thematicFallbackEntriesForResponse =
        n === 11
          ? finalFallbackPair.derived.filter((e) => finalFallbackThematicSet.has(e.answer))
          : finalFallbackPair.derived;
      const safeThematicFallbackEntriesForResponse =
        thematicFallbackEntriesForResponse.length >= (n === 11 ? 3 : 4)
          ? thematicFallbackEntriesForResponse
          : finalFallbackPair.derived;
      const rebuiltThematicFallback =
        safeThematicFallbackEntriesForResponse.length > 0
          ? rebuildGridFromEntries(n, safeThematicFallbackEntriesForResponse, minEntryLenForSize(n))
          : null;
      const finalFallbackGridForResponse =
        rebuiltThematicFallback?.derived && rebuiltThematicFallback.derived.length > 0
          ? rebuiltThematicFallback.grid
          : finalFallbackPair.derived.length > 0
            ? finalFallbackPair.grid
            : bestPartial.built.grid;
      const finalFallbackEntriesForResponse =
        rebuiltThematicFallback?.derived && rebuiltThematicFallback.derived.length > 0
          ? rebuiltThematicFallback.derived
          : finalFallbackPair.derived.length > 0
            ? finalFallbackPair.derived
            : fallbackDerivedSeed;

      const entries = applyCluesAndOverrides(theme, language, finalFallbackEntriesForResponse, clueByAnswer);
      if (n === 11) {
        const buildFastPublishCandidate = (grid: string[][], derived: DerivedEntry[], source: string) => {
          const publishEntries = pruneForbiddenPublishAnswersIfPossible(
            pruneMaskedDuplicateAnswers(
              repairPublishClues(applyCluesAndOverrides(theme, language, derived, clueByAnswer), {
                theme,
                language,
                thematicSet: finalFallbackThematicSet,
                notesByAnswer: fallbackNotesByAnswer,
              })
            ),
            minPublishEntriesForSize(n)
          ).filter((entry) =>
            isPublishableAnswerForTheme({
              theme,
              answer: entry.answer,
              language,
              size: n,
              note: fallbackNotesByAnswer.get(entry.answer),
              allowContextualGeneric: finalFallbackThematicSet.has(entry.answer),
            })
          );
          const entryCrossings = entryCrossingStats(grid, publishEntries, minEntryLenForSize(n));
          const checked = checkedCellStats(grid, minEntryLenForSize(n));
          const crossed = crossedEntryStats(grid, publishEntries, minEntryLenForSize(n));
          const thematicEntries = publishEntries.filter((entry) =>
            finalFallbackThematicSet.has(entry.answer)
          ).length;
          const coreThematicEntries = publishEntries.filter((entry) =>
            finalFallbackCoreThematicSet.has(entry.answer)
          ).length;
          const genericContextEntries = publishEntries.filter(
            (entry) => finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
          ).length;
          const qualityIssue = publishQualityIssue(
            publishEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const hasShortRuns = hasShortLetterRuns(grid, minEntryLenForSize(n));

          return {
            source,
            grid,
            entries: publishEntries,
            entryCrossings,
            checked,
            crossed,
            thematicEntries,
            coreThematicEntries,
            genericContextEntries,
            qualityIssue,
            hasShortRuns,
            valid:
              publishEntries.length >= minPublishEntriesForSize(n) &&
              crossed.crossed >= minCrossedEntriesForPublish(n) &&
              entryCrossings.weakEntries.length === 0 &&
              checked.ratio >= 0.25 &&
              thematicEntries >= minThematicEntriesForPublish(n, publishEntries.length) &&
              coreThematicEntries >= minCoreThematicEntriesForPublish(n, publishEntries.length) &&
              genericContextEntries <= maxGenericContextEntriesForPublish(n, publishEntries.length) &&
              !hasShortRuns &&
              !qualityIssue,
          };
        };

        const fastBaseGrid = hasShortLetterRuns(finalFallbackGridForResponse, minEntryLenForSize(n))
          ? blockShortRunsOnly(finalFallbackGridForResponse, minEntryLenForSize(n))
          : finalFallbackGridForResponse;
        const fastBaseDerived = deriveEntriesFromGrid(fastBaseGrid, minEntryLenForSize(n));
        const fastBaseEntries =
          fastBaseDerived.length >= Math.max(minPublishEntriesForSize(n) - 3, finalFallbackEntriesForResponse.length - 3)
            ? fastBaseDerived
            : finalFallbackEntriesForResponse;
        const fastBaseGridForEntries = fastBaseEntries === fastBaseDerived ? fastBaseGrid : finalFallbackGridForResponse;

        let fastCandidate = buildFastPublishCandidate(
          fastBaseGridForEntries,
          fastBaseEntries,
          "fallback-fast-best-11"
        );

        if (
          !fastCandidate.valid &&
          fastCandidate.entries.length >= minPublishEntriesForSize(n) - 3 &&
          (fastCandidate.entries.length < minPublishEntriesForSize(n) ||
            fastCandidate.entryCrossings.weakEntries.length > 0 ||
            fastCandidate.hasShortRuns) &&
          fastCandidate.entryCrossings.weakEntries.length <= 4 &&
          Date.now() < deadlineMs - 8_000
        ) {
          const fastRepaired = densifyCleanGrid11WithDependencies({ dependencies: gridEnhancementDependencies,
            theme,
            grid: fastBaseGridForEntries,
            candidates: fallbackPool,
            targetEntries: minPublishEntriesForSize(n),
            seed: (fallbackStrictSeed ^ 0x7f4a7c15 ^ Math.imul(fastCandidate.entries.length + 1, 257)) >>> 0,
            deadlineMs: Math.min(deadlineMs - 1_000, Date.now() + 7_000),
            pruneWeakEntries: false,
          });

          if (fastRepaired) {
            const repairedCandidate = buildFastPublishCandidate(
              fastRepaired.grid,
              fastRepaired.derived,
              "fallback-fast-repaired-11"
            );
            if (
              repairedCandidate.valid ||
              repairedCandidate.entryCrossings.weakEntries.length < fastCandidate.entryCrossings.weakEntries.length
            ) {
              fastCandidate = repairedCandidate;
            }
          }
        }

        if (fastCandidate.valid) {
          console.warn("[generate-crossword] FALLBACK -> fast publish 11x11", {
            source: fastCandidate.source,
            entries: fastCandidate.entries.length,
            thematicEntries: fastCandidate.thematicEntries,
            coreThematicEntries: fastCandidate.coreThematicEntries,
            genericContextEntries: fastCandidate.genericContextEntries,
            checkedRatio: fastCandidate.checked.ratio,
          });

          return accepted(
            {
              theme,
              language,
              size: n,
              grid: fastCandidate.grid,
              entries: fastCandidate.entries,
              meta: {
                source: fastCandidate.source,
                targetEntries: minPublishEntriesForSize(n),
                entries: fastCandidate.entries.length,
                thematicEntries: fastCandidate.thematicEntries,
                coreThematicEntries: fastCandidate.coreThematicEntries,
                genericContextEntries: fastCandidate.genericContextEntries,
                crossedEntries: fastCandidate.crossed.crossed,
                checkedRatio: fastCandidate.checked.ratio,
                minEntryCheckedCells: fastCandidate.entryCrossings.minCheckedCells,
                weakCrossingEntries: fastCandidate.entryCrossings.weakEntries,
                ...fallbackBuilt.meta,
              },
            } satisfies Crossword
          );
        }

        if (Date.now() > deadlineMs - 12_000) {
          return failed(
            {
              source: "generation-time-budget",
              reason: "Se agoto el tiempo de construccion antes de obtener un 11x11 completamente chequeado.",
              finalEntries: fastCandidate.entries.length,
              minEntries: minPublishEntriesForSize(n),
              finalThematicEntries: fastCandidate.thematicEntries,
              finalCoreThematicEntries: fastCandidate.coreThematicEntries,
              finalGenericContextEntries: fastCandidate.genericContextEntries,
              minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
              weakCrossingEntries: fastCandidate.entryCrossings.weakEntries,
              finalHasShortRuns: fastCandidate.hasShortRuns,
              finalQualityIssue: fastCandidate.qualityIssue,
              checkedRatio: fastCandidate.checked.ratio,
              lastAnswerStats,
              lastBuildIssue,
            },
        "unprocessable"
      );
        }
      }
      const cluedFallbackAnswerSet = new Set(
        Array.from(new Set(entries.map((e) => e.answer))).filter((a) => {
          if (isOverGenericThemeWordForTheme(theme, a)) return false;
          return hasStrongThematicClueSupport({
            theme,
            answer: a,
            language,
            note: fallbackNotesByAnswer.get(a),
            clue: clueByAnswer.get(a),
          });
        })
      );
      const publishableFallbackAnswerSet: Set<string> =
        n === 11
          ? new Set<string>([...finalFallbackThematicSet, ...cluedFallbackAnswerSet])
          : new Set<string>(
              bestPartial.pool
                .filter((c) => c.source !== "filler" && !isOverGenericThemeWordForTheme(theme, c.answer))
                .map((c) => c.answer)
            );
      const broadPublishableFallbackAnswerSet: Set<string> =
        n === 11
          ? publishableFallbackAnswerSet
          : publishableFallbackAnswerSet;
      const fullyCheckedFallback = rebuildFullyCheckedPublishableCrosswordWithPolicies(
        theme,
        n,
        finalFallbackGridForResponse,
        language,
        publishableFallbackAnswerSet,
        clueByAnswer,
        gridReconstructionPolicies,
        n === 11 ? 6 : 4
      );
      const sanitizedFullyCheckedFallback =
        n === 11 && !(fullyCheckedFallback && fullyCheckedFallback.entries.length >= 6)
          ? rebuildSanitizedFullyCheckedPublishableCrosswordWithPolicies(
              theme,
              n,
              finalFallbackGridForResponse,
              language,
              publishableFallbackAnswerSet,
              clueByAnswer,
              gridReconstructionPolicies,
              4
            )
          : null;
      const minimalFullyCheckedFallback =
        n === 11 && !(fullyCheckedFallback && fullyCheckedFallback.entries.length >= 6)
          ? rebuildFullyCheckedPublishableCrosswordWithPolicies(
              theme,
              n,
              finalFallbackGridForResponse,
              language,
              publishableFallbackAnswerSet,
              clueByAnswer,
              gridReconstructionPolicies,
              2
            )
          : null;
      const minimalSanitizedFullyCheckedFallback =
        n === 11 &&
        !(sanitizedFullyCheckedFallback && sanitizedFullyCheckedFallback.entries.length >= 4)
          ? rebuildSanitizedFullyCheckedPublishableCrosswordWithPolicies(
              theme,
              n,
              finalFallbackGridForResponse,
              language,
              publishableFallbackAnswerSet,
              clueByAnswer,
              gridReconstructionPolicies,
              2
            )
          : null;
      const playableFallback = rebuildPlayableCrosswordWithPolicies(
        theme,
        n,
        entries,
        language,
        n === 11 ? strongThematicSet : thematicSet,
        gridReconstructionPolicies
      );
      const exactFullyCheckedFallback = rebuildExactFullyCheckedPublishableCrosswordWithPolicies(
        theme,
        n,
        entries,
        language,
        publishableFallbackAnswerSet,
        gridReconstructionPolicies,
        n === 11 ? 4 : 3
      );
      const exactPublishableFallback = rebuildExactPublishableCrosswordWithPolicies(
        theme,
        n,
        entries,
        language,
        publishableFallbackAnswerSet,
        gridReconstructionPolicies
      );
      const cluedExactPublishableFallback =
        n === 11 && !exactPublishableFallback
          ? rebuildExactPublishableCrosswordWithPolicies(
              theme,
              n,
              entries,
              language,
              cluedFallbackAnswerSet,
              gridReconstructionPolicies,
              2
            )
          : null;
      const minimalExactPublishableFallback =
        n === 11 && !exactPublishableFallback && !cluedExactPublishableFallback
          ? rebuildExactPublishableCrosswordWithPolicies(
              theme,
              n,
              entries,
              language,
              publishableFallbackAnswerSet,
              gridReconstructionPolicies,
              2
            )
          : null;
      const minimalExactFullyCheckedFallback =
        n === 11 &&
        !(exactFullyCheckedFallback && exactFullyCheckedFallback.entries.length >= 4)
          ? rebuildExactFullyCheckedPublishableCrosswordWithPolicies(
              theme,
              n,
              entries,
              language,
              publishableFallbackAnswerSet,
              gridReconstructionPolicies,
              2
            )
          : null;
      const broadMinimalExactFullyCheckedFallback =
        n === 11 &&
        !(minimalExactFullyCheckedFallback && minimalExactFullyCheckedFallback.entries.length >= 2)
          ? rebuildExactFullyCheckedPublishableCrosswordWithPolicies(
              theme,
              n,
              entries,
              language,
              broadPublishableFallbackAnswerSet,
              gridReconstructionPolicies,
              2
            )
          : null;
      const broadMinimalFullyCheckedFallback =
        n === 11 &&
        !(minimalFullyCheckedFallback && minimalFullyCheckedFallback.entries.length >= 2)
          ? rebuildFullyCheckedPublishableCrosswordWithPolicies(
              theme,
              n,
              finalFallbackGridForResponse,
              language,
              broadPublishableFallbackAnswerSet,
              clueByAnswer,
              gridReconstructionPolicies,
              2
            )
          : null;
      if (
        n === 11 &&
        !(fullyCheckedFallback && fullyCheckedFallback.entries.length >= 6) &&
        !(sanitizedFullyCheckedFallback && sanitizedFullyCheckedFallback.entries.length >= 4) &&
        !(exactFullyCheckedFallback && exactFullyCheckedFallback.entries.length >= 4) &&
        !(minimalFullyCheckedFallback && minimalFullyCheckedFallback.entries.length >= 2) &&
        !(minimalSanitizedFullyCheckedFallback && minimalSanitizedFullyCheckedFallback.entries.length >= 2) &&
        !(minimalExactFullyCheckedFallback && minimalExactFullyCheckedFallback.entries.length >= 2) &&
        !(broadMinimalFullyCheckedFallback && broadMinimalFullyCheckedFallback.entries.length >= 2) &&
        !(broadMinimalExactFullyCheckedFallback && broadMinimalExactFullyCheckedFallback.entries.length >= 2) &&
        !exactPublishableFallback &&
        !(cluedExactPublishableFallback && cluedExactPublishableFallback.entries.length >= 2) &&
        !minimalExactPublishableFallback &&
        !(playableFallback && playableFallback.entries.length >= 3)
      ) {
        if (sanitizedFullyCheckedFallback && sanitizedFullyCheckedFallback.entries.length >= 3) {
          const sanitizedPlaceholderCount = sanitizedFullyCheckedFallback.entries.filter((e) =>
            isPlaceholderClue(e.clue, language)
          ).length;
          const sanitizedCheckedStats = checkedCellStats(
            sanitizedFullyCheckedFallback.grid,
            minEntryLenForSize(n)
          );

          console.warn("[generate-crossword] FALLBACK -> sanitized bestPartial", {
            attempt: bestPartial.attempt,
            entries: sanitizedFullyCheckedFallback.entries.length,
            checkedRatio: sanitizedCheckedStats.ratio,
            fallbackScore: bestPartial.fallbackScore,
            placeholderCount: sanitizedPlaceholderCount,
            builder: fallbackBuilt.meta?.builder ?? null,
          });

          return accepted(
            {
              theme,
              language,
              size: n,
              grid: sanitizedFullyCheckedFallback.grid,
              entries: sanitizedFullyCheckedFallback.entries,
              meta: {
                source: "fallback-best-built-sanitized",
                attempt: best.attempt,
                fallbackScore: best.fallbackScore,
                checkedRatio: sanitizedCheckedStats.ratio,
                placeholderCount: sanitizedPlaceholderCount,
                ...fallbackBuilt.meta,
              },
            } satisfies Crossword
          );
        }

        const strictRepackRescuePools: WordCandidate[][] = [
          fallbackPool.filter(
            (c) => c.source !== "filler" && broadPublishableFallbackAnswerSet.has(c.answer)
          ),
          fallbackPool.filter(
            (c) => c.source !== "filler" && broadFallbackAllowedAnswers.has(c.answer)
          ),
        ];
        const strictRepackSeeds: number[] = Array.from({ length: n === 11 ? 2 : 8 }, (_, idx) =>
          (fallbackStrictSeed ^ Math.imul(idx + 1, 0x9e3779b9)) >>> 0
        );

        let checkedStrictRepackFallback:
          | { grid: string[][]; entries: Entry[]; meta: Record<string, unknown> }
          | null = null;

        for (const candidatePool of strictRepackRescuePools) {
          if (checkedStrictRepackFallback) break;
          if (Date.now() >= fallbackDeadlineMs - 300) break;
          if (candidatePool.length < 6) continue;

          for (const seed of strictRepackSeeds) {
            if (Date.now() >= fallbackDeadlineMs - 300) break;
            const repacked = runLegacyBuilder({ mode: "strict-11", dependencies: legacyBuilderDependencies,
              theme,
              size: n,
              seed,
              candidates: candidatePool,
              deadlineMs: fallbackDeadlineMs,
            });
            if (!repacked) continue;

            const repackedDerived = deriveEntriesFromGrid(
              repacked.grid,
              minEntryLenForSize(n)
            );
            if (repackedDerived.length < 2) continue;

            const repackedEntries = applyCluesAndOverrides(
              theme,
              language,
              repackedDerived,
              clueByAnswer
            );
            const repackedAllowedAnswers: Set<string> = new Set<string>(
              repackedEntries
                .filter((e) => !isPlaceholderClue(e.clue, language))
                .map((e) => e.answer)
                .filter((a) => !isOverGenericThemeWordForTheme(theme, a))
            );
            if (repackedAllowedAnswers.size < 2) continue;

            const exactChecked = rebuildExactFullyCheckedPublishableCrosswordWithPolicies(
              theme,
              n,
              repackedEntries,
              language,
              repackedAllowedAnswers,
              gridReconstructionPolicies,
              2
            );
            if (!exactChecked) continue;

            checkedStrictRepackFallback = {
              grid: exactChecked.grid,
              entries: exactChecked.entries,
              meta: {
                source: "fallback-best-built-strict-repack",
                seed,
                candidatePool: candidatePool.length,
                builder: repacked.meta?.builder ?? "pattern-11x11-strict",
              },
            };
            break;
          }
        }

        if (checkedStrictRepackFallback) {
          const strictRepackStats = checkedCellStats(
            checkedStrictRepackFallback.grid,
            minEntryLenForSize(n)
          );
          const strictRepackPlaceholderCount = checkedStrictRepackFallback.entries.filter((e) =>
            isPlaceholderClue(e.clue, language)
          ).length;
          const strictRepackQualityIssue = publishQualityIssue(
            checkedStrictRepackFallback.entries,
            broadPublishableFallbackAnswerSet,
            language,
            minPublishEntriesForSize(n)
          );
          if (!strictRepackQualityIssue) {
          console.warn("[generate-crossword] FALLBACK -> strict repack checked", {
            attempt: bestPartial.attempt,
            entries: checkedStrictRepackFallback.entries.length,
            checkedRatio: strictRepackStats.ratio,
            fallbackScore: bestPartial.fallbackScore,
            ...checkedStrictRepackFallback.meta,
          });

          return accepted(
            {
              theme,
              language,
              size: n,
              grid: checkedStrictRepackFallback.grid,
              entries: checkedStrictRepackFallback.entries,
              meta: {
                attempt: best.attempt,
                fallbackScore: best.fallbackScore,
                checkedRatio: strictRepackStats.ratio,
                placeholderCount: strictRepackPlaceholderCount,
                ...fallbackBuilt.meta,
                ...checkedStrictRepackFallback.meta,
              },
            } satisfies Crossword
          );
          }
        }

        const finalStrictRescuePoolMap = new Map<string, WordCandidate>();
        for (const candidate of [...fallbackPool, ...lastAttemptPool]) {
          if (candidate.source === "filler") continue;
          if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
          if (!finalStrictRescuePoolMap.has(candidate.answer)) {
            finalStrictRescuePoolMap.set(candidate.answer, candidate);
          }
        }
        const finalStrictRescuePool = Array.from(finalStrictRescuePoolMap.values());
        const finalStrictRescueSeeds: number[] = Array.from({ length: n === 11 ? 2 : 16 }, (_, idx) =>
          (fallbackStrictSeed ^ Math.imul(idx + 1, 0x85ebca6b)) >>> 0
        );

        let checkedFinalStrictRescue:
          | { grid: string[][]; entries: Entry[]; meta: Record<string, unknown> }
          | null = null;

        if (finalStrictRescuePool.length >= 6) {
          for (const seed of finalStrictRescueSeeds) {
            if (Date.now() >= fallbackDeadlineMs - 300) break;
            const repacked = runLegacyBuilder({ mode: "strict-11", dependencies: legacyBuilderDependencies,
              theme,
              size: n,
              seed,
              candidates: finalStrictRescuePool,
              deadlineMs: fallbackDeadlineMs,
            });
            if (!repacked) continue;

            const repackedDerived = deriveEntriesFromGrid(
              repacked.grid,
              minEntryLenForSize(n)
            );
            if (repackedDerived.length < 2) continue;

            const repackedEntries = applyCluesAndOverrides(
              theme,
              language,
              repackedDerived,
              clueByAnswer
            );
            const repackedAllowedAnswers: Set<string> = new Set<string>(
              repackedEntries
                .filter((e) => !isPlaceholderClue(e.clue, language))
                .map((e) => e.answer)
                .filter((a) => !isOverGenericThemeWordForTheme(theme, a))
            );
            if (repackedAllowedAnswers.size < 2) continue;

            const exactChecked =
              rebuildExactFullyCheckedPublishableCrosswordWithPolicies(
                theme,
                n,
                repackedEntries,
                language,
                repackedAllowedAnswers,
                gridReconstructionPolicies,
                2
              ) ??
              rebuildFullyCheckedPublishableCrosswordWithPolicies(
                theme,
                n,
                repacked.grid,
                language,
                repackedAllowedAnswers,
                clueByAnswer,
                gridReconstructionPolicies,
                2
              );
            if (!exactChecked) continue;

            checkedFinalStrictRescue = {
              grid: exactChecked.grid,
              entries: exactChecked.entries,
              meta: {
                source: "fallback-best-built-final-strict",
                seed,
                candidatePool: finalStrictRescuePool.length,
                builder: repacked.meta?.builder ?? "pattern-11x11-strict",
              },
            };
            break;
          }
        }

        if (checkedFinalStrictRescue) {
          const finalStrictStats = checkedCellStats(
            checkedFinalStrictRescue.grid,
            minEntryLenForSize(n)
          );
          const finalStrictPlaceholderCount = checkedFinalStrictRescue.entries.filter((e) =>
            isPlaceholderClue(e.clue, language)
          ).length;
          const finalStrictQualityIssue = publishQualityIssue(
            checkedFinalStrictRescue.entries,
            new Set(finalStrictRescuePoolMap.keys()),
            language,
            minPublishEntriesForSize(n)
          );
          if (!finalStrictQualityIssue) {
          console.warn("[generate-crossword] FALLBACK -> final strict checked rescue", {
            attempt: bestPartial.attempt,
            entries: checkedFinalStrictRescue.entries.length,
            checkedRatio: finalStrictStats.ratio,
            fallbackScore: bestPartial.fallbackScore,
            ...checkedFinalStrictRescue.meta,
          });

          return accepted(
            {
              theme,
              language,
              size: n,
              grid: checkedFinalStrictRescue.grid,
              entries: checkedFinalStrictRescue.entries,
              meta: {
                attempt: best.attempt,
                fallbackScore: best.fallbackScore,
                checkedRatio: finalStrictStats.ratio,
                placeholderCount: finalStrictPlaceholderCount,
                ...fallbackBuilt.meta,
                ...checkedFinalStrictRescue.meta,
              },
            } satisfies Crossword
          );
          }
        }

      }
      const checkedFallbackForResponse =
        n === 11 && fullyCheckedFallback && fullyCheckedFallback.entries.length >= minPublishEntriesForSize(n)
          ? fullyCheckedFallback
          : n === 11 && sanitizedFullyCheckedFallback && sanitizedFullyCheckedFallback.entries.length >= minPublishEntriesForSize(n)
          ? sanitizedFullyCheckedFallback
          : n === 11 && exactFullyCheckedFallback && exactFullyCheckedFallback.entries.length >= minPublishEntriesForSize(n)
          ? exactFullyCheckedFallback
          : null;

      if (n === 11) {
        if (!checkedFallbackForResponse) {
          const directCandidateOptions: Array<{ grid: string[][]; derived: DerivedEntry[] }> = [];
          const minLenForFallback = minEntryLenForSize(n);

          const rebuiltFromEntries = rebuildGridFromEntries(n, entries, minLenForFallback);
          if (rebuiltFromEntries) {
            const cleaned = blockForbiddenAnswerRuns(rebuiltFromEntries.grid, minLenForFallback);
            const cleanedDerived = deriveEntriesFromGrid(cleaned, minLenForFallback);
            directCandidateOptions.push({
              grid: cleanedDerived.length > 0 ? cleaned : rebuiltFromEntries.grid,
              derived: cleanedDerived.length > 0 ? cleanedDerived : rebuiltFromEntries.derived,
            });
          }

          const augmented = augmentNoShortGridWithCandidatesWithDependencies(
            finalFallbackGridForResponse,
            bestPartial.pool,
            minLenForFallback,
            desiredPublishEntriesForSize(n),
            minPublishEntriesForSize(n),
            gridEnhancementDependencies
          ) ?? augmentNoShortGridWithCandidatesWithDependencies(
            finalFallbackGridForResponse,
            bestPartial.pool,
            minLenForFallback,
            minPublishEntriesForSize(n),
            undefined,
            gridEnhancementDependencies
          );
          if (augmented) {
            const cleaned = blockForbiddenAnswerRuns(augmented.grid, minLenForFallback);
            const cleanedDerived = deriveEntriesFromGrid(cleaned, minLenForFallback);
            directCandidateOptions.push({
              grid: cleanedDerived.length > 0 ? cleaned : augmented.grid,
              derived: cleanedDerived.length > 0 ? cleanedDerived : augmented.derived,
            });
          }

          if (hasShortLetterRuns(finalFallbackGridForResponse, minLenForFallback)) {
            const lightlyBlocked = blockShortRunsOnly(finalFallbackGridForResponse, minLenForFallback);
            directCandidateOptions.push({
              grid: lightlyBlocked,
              derived: deriveEntriesFromGrid(lightlyBlocked, minLenForFallback),
            });

            const sanitized = sanitizeUncheckedGrid(finalFallbackGridForResponse, minLenForFallback);
            const cleanedSanitized = blockForbiddenAnswerRuns(sanitized, minLenForFallback);
            const cleanedSanitizedDerived = deriveEntriesFromGrid(cleanedSanitized, minLenForFallback);
            directCandidateOptions.push({
              grid: cleanedSanitizedDerived.length > 0 ? cleanedSanitized : sanitized,
              derived:
                cleanedSanitizedDerived.length > 0
                  ? cleanedSanitizedDerived
                  : deriveEntriesFromGrid(sanitized, minLenForFallback),
            });
          }

          const cleanedFinalFallback = blockForbiddenAnswerRuns(finalFallbackGridForResponse, minLenForFallback);
          const cleanedFinalFallbackDerived = deriveEntriesFromGrid(cleanedFinalFallback, minLenForFallback);
          directCandidateOptions.push({
            grid: cleanedFinalFallbackDerived.length > 0 ? cleanedFinalFallback : finalFallbackGridForResponse,
            derived:
              cleanedFinalFallbackDerived.length > 0
                ? cleanedFinalFallbackDerived
                : deriveEntriesFromGrid(finalFallbackGridForResponse, minLenForFallback),
          });

          const rankedDirectCandidateOptions = directCandidateOptions
            .slice()
            .sort((a, b) => {
              const score = (candidate: { grid: string[][]; derived: DerivedEntry[] }) => {
                const checked = checkedCellStats(candidate.grid, minLenForFallback);
                const crossed = crossedEntryStats(candidate.grid, candidate.derived, minLenForFallback);
                const entryCrossings = entryCrossingStats(candidate.grid, candidate.derived, minLenForFallback);
                const shortPenalty = hasShortLetterRuns(candidate.grid, minLenForFallback) ? 100000 : 0;
                const forbiddenPenalty = candidate.derived.filter((entry) =>
                  isForbiddenPublishAnswer(entry.answer)
                ).length * 120000;
                const weakCrossingPenalty = entryCrossings.weakEntries.length * 80000;
                const themeCount = candidate.derived.filter((entry) =>
                  finalFallbackThematicSet.has(entry.answer)
                ).length;
                const coreThemeCount = candidate.derived.filter((entry) =>
                  finalFallbackCoreThematicSet.has(entry.answer)
                ).length;
                return (
                  candidate.derived.length * 10000 +
                  Math.min(candidate.derived.length, desiredPublishEntriesForSize(n)) * 3000 +
                  Math.max(0, candidate.derived.length - minPublishEntriesForSize(n)) * 6000 +
                  themeCount * 4500 +
                  coreThemeCount * 9000 +
                  crossed.crossed * 1500 +
                  checked.ratio * 1000 -
                  weakCrossingPenalty -
                  forbiddenPenalty -
                  shortPenalty
                );
              };
              return score(b) - score(a);
            });

          const hasPublishableShape = (candidate: { grid: string[][]; derived: DerivedEntry[] }) => {
            if (candidate.derived.length < minPublishEntriesForSize(n)) return false;
            if (hasShortLetterRuns(candidate.grid, minLenForFallback)) return false;
            if (candidate.derived.some((entry) => isForbiddenPublishAnswer(entry.answer))) return false;
            if (
              entryCrossingStats(candidate.grid, candidate.derived, minLenForFallback).weakEntries.length > 0
            ) {
              return false;
            }

            const themeCount = candidate.derived.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const coreThemeCount = candidate.derived.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const genericContextCount = candidate.derived.filter(
              (entry) => finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const minTheme = minThematicEntriesForPublish(n, candidate.derived.length);
            const minCore = minCoreThematicEntriesForPublish(n, candidate.derived.length);
            const maxGeneric = maxGenericContextEntriesForPublish(n, candidate.derived.length);

            return (
              themeCount >= minTheme &&
              coreThemeCount >= minCore &&
              genericContextCount <= maxGeneric
            );
          };

          const directCandidateOptionsWithoutForbidden = rankedDirectCandidateOptions.filter(
            (candidate) =>
              !candidate.derived.some(
                (entry) =>
                  isForbiddenPublishAnswer(entry.answer) ||
                  (isLikelyBadAnswer(entry.answer) && !ALWAYS_ALLOW_ANSWERS.has(entry.answer))
              )
          );
          const directCandidateSelectionOptions =
            directCandidateOptionsWithoutForbidden.length > 0
              ? directCandidateOptionsWithoutForbidden
              : rankedDirectCandidateOptions;

          const directCandidate =
            directCandidateSelectionOptions.find(
              (candidate) =>
                candidate.derived.length >= desiredPublishEntriesForSize(n) &&
                hasPublishableShape(candidate)
            ) ??
            directCandidateSelectionOptions.find(hasPublishableShape) ??
            directCandidateSelectionOptions.find(
              (candidate) =>
                candidate.derived.length >= desiredPublishEntriesForSize(n) &&
                !hasShortLetterRuns(candidate.grid, minLenForFallback)
            ) ??
            directCandidateSelectionOptions.find(
              (candidate) =>
                candidate.derived.length >= minPublishEntriesForSize(n) &&
                !hasShortLetterRuns(candidate.grid, minLenForFallback)
            ) ??
            directCandidateSelectionOptions.find((candidate) => candidate.derived.length >= minPublishEntriesForSize(n)) ??
            directCandidateSelectionOptions.find((candidate) => candidate.derived.length > 0) ??
            {
              grid: finalFallbackGridForResponse,
              derived: entries.map((entry) => ({
                number: entry.number,
                row: entry.row,
                col: entry.col,
                direction: entry.direction,
                answer: entry.answer,
              })),
            };

          const directFallbackGridCandidate = directCandidate.grid;
          const directFallbackDerivedCandidate = deriveEntriesFromGrid(
            directFallbackGridCandidate,
            minLenForFallback
          );
          const directFallbackEntryByKey = new Map(
            entries.map((entry) => [
              `${entry.direction}:${entry.row}:${entry.col}:${entry.answer}`,
              entry,
            ])
          );
          const directFallbackEntriesCandidateRaw = directFallbackDerivedCandidate.map((derived) => {
            const key = `${derived.direction}:${derived.row}:${derived.col}:${derived.answer}`;
            return directFallbackEntryByKey.get(key) ?? { ...derived, clue: clueByAnswer.get(derived.answer) ?? "" };
          });
          const directFallbackEntriesCandidate = pruneForbiddenPublishAnswersIfPossible(
            pruneMaskedDuplicateAnswers(
              repairPublishClues(directFallbackEntriesCandidateRaw, {
                theme,
                language,
                thematicSet: finalFallbackThematicSet,
                notesByAnswer: fallbackNotesByAnswer,
              })
            ),
            minPublishEntriesForSize(n)
          );
          const directFallbackRawQualityIssue = publishQualityIssue(
            directFallbackEntriesCandidate,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const directFallbackNeedsRebuild =
            Boolean(directFallbackRawQualityIssue) ||
            directFallbackEntriesCandidate.length !== directFallbackEntriesCandidateRaw.length;
          const directFallbackFilteredEntries = directFallbackEntriesCandidate.filter((entry) => {
            if (MODEL_FRAGMENT_ANSWERS.has(entry.answer)) return false;
            if (BANNED_ANSWERS.has(entry.answer) && !CONTEXTUAL_GENERIC_ANSWERS.has(entry.answer)) return false;
            if (
              !isPublishableAnswerForTheme({
                theme,
                answer: entry.answer,
                language,
                size: n,
                note: fallbackNotesByAnswer.get(entry.answer),
                allowContextualGeneric: finalFallbackThematicSet.has(entry.answer),
              })
            ) {
              return false;
            }
            if (!finalFallbackThematicSet.has(entry.answer) && LOW_VALUE_CONTEXTLESS_ANSWERS.has(entry.answer)) return false;
            if (n === 11 && !finalFallbackThematicSet.has(entry.answer)) return false;
            if (isPlaceholderClue(entry.clue, language) || isBadClue(entry.clue)) return false;
            if (!clueLanguageLooksValid(entry.clue, language)) return false;
            if (clueMentionsAnswer(entry.clue, entry.answer)) return false;
            return true;
          });
          const directFallbackAllowedAnswers = new Set(directFallbackFilteredEntries.map((entry) => entry.answer));
          const directFallbackExactFiltered =
            directFallbackNeedsRebuild && directFallbackFilteredEntries.length >= minPublishEntriesForSize(n)
              ? rebuildExactPublishableCrosswordWithPolicies(
                  theme,
                  n,
                  directFallbackFilteredEntries,
                  language,
                  directFallbackAllowedAnswers,
                  gridReconstructionPolicies,
                  minPublishEntriesForSize(n)
                )
              : null;
          const directFallbackRebuiltFiltered =
            directFallbackNeedsRebuild && !directFallbackExactFiltered && directFallbackFilteredEntries.length >= minPublishEntriesForSize(n)
              ? rebuildGridFromEntries(n, directFallbackFilteredEntries, minLenForFallback) ??
                rebuildGridFromAllowedEntries(directFallbackGridCandidate, directFallbackAllowedAnswers, minLenForFallback)
              : null;
          const directFallbackRebuiltEntries =
            directFallbackRebuiltFiltered?.derived && directFallbackRebuiltFiltered.derived.length > 0
              ? repairPublishClues(
                  applyCluesAndOverrides(theme, language, directFallbackRebuiltFiltered.derived, clueByAnswer),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              : null;
          const replacementDirectFallbackCandidates: Array<{ grid: string[][]; entries: Entry[] }> = [];
          if (directFallbackExactFiltered) {
            replacementDirectFallbackCandidates.push({
              grid: directFallbackExactFiltered.grid,
              entries: directFallbackExactFiltered.entries,
            });
          }
          if (directFallbackRebuiltFiltered && directFallbackRebuiltEntries) {
            replacementDirectFallbackCandidates.push({
              grid: directFallbackRebuiltFiltered.grid,
              entries: directFallbackRebuiltEntries,
            });
          }

          let directFallbackPublishGrid = directFallbackGridCandidate;
          let directFallbackPublishEntries = directFallbackEntriesCandidate;
          for (const candidate of replacementDirectFallbackCandidates) {
            const candidateChecked = checkedCellStats(candidate.grid, minEntryLenForSize(n));
            const candidateCrossed = crossedEntryStats(candidate.grid, candidate.entries, minEntryLenForSize(n));
            const candidateQualityIssue = publishQualityIssue(
              candidate.entries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );

            if (
              candidate.entries.length >= minPublishEntriesForSize(n) &&
              candidateCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              candidateChecked.ratio >= 0.25 &&
              !hasShortLetterRuns(candidate.grid, minEntryLenForSize(n)) &&
              !candidateQualityIssue
            ) {
              directFallbackPublishGrid = candidate.grid;
              directFallbackPublishEntries = candidate.entries;
              break;
            }
          }

          const directFallbackPreAugmentQualityIssue = publishQualityIssue(
            directFallbackPublishEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );

          if (
            directFallbackPublishEntries.length < desiredPublishEntriesForSize(n) ||
            directFallbackPreAugmentQualityIssue
          ) {
            const cleanBaseRebuild =
              directFallbackFilteredEntries.length > 0 &&
              directFallbackFilteredEntries.length < directFallbackPublishEntries.length
                ? rebuildGridFromEntries(n, directFallbackFilteredEntries, minLenForFallback) ??
                  rebuildGridFromAllowedEntries(
                    directFallbackPublishGrid,
                    directFallbackAllowedAnswers,
                    minLenForFallback
                  )
                : null;
            const augmentBaseGrid =
              cleanBaseRebuild?.grid ??
              (directFallbackPreAugmentQualityIssue ? null : directFallbackPublishGrid);
            const augmentedAfterPrune = augmentBaseGrid
                ? augmentNoShortGridWithCandidatesWithDependencies(
                  augmentBaseGrid,
                  fallbackPool.filter((candidate) => candidate.source !== "filler"),
                  minLenForFallback,
                  desiredPublishEntriesForSize(n),
                  minPublishEntriesForSize(n),
                  gridEnhancementDependencies
                ) ?? augmentNoShortGridWithCandidatesWithDependencies(
                  augmentBaseGrid,
                  fallbackPool.filter((candidate) => candidate.source !== "filler"),
                  minLenForFallback,
                  minPublishEntriesForSize(n),
                  undefined,
                  gridEnhancementDependencies
                )
              : null;

            if (augmentedAfterPrune) {
              const augmentedEntries = pruneMaskedDuplicateAnswers(
                repairPublishClues(
                  applyCluesAndOverrides(theme, language, augmentedAfterPrune.derived, clueByAnswer),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              );
              const augmentedQualityIssue = publishQualityIssue(
                augmentedEntries,
                finalFallbackThematicSet,
                language,
                minPublishEntriesForSize(n)
              );
              const augmentedCrossed = crossedEntryStats(
                augmentedAfterPrune.grid,
                augmentedEntries,
                minEntryLenForSize(n)
              );
              const augmentedChecked = checkedCellStats(augmentedAfterPrune.grid, minEntryLenForSize(n));

              if (
                augmentedEntries.length >= minPublishEntriesForSize(n) &&
                augmentedCrossed.crossed >= minCrossedEntriesForPublish(n) &&
                augmentedChecked.ratio >= 0.25 &&
                !hasShortLetterRuns(augmentedAfterPrune.grid, minEntryLenForSize(n)) &&
                !augmentedQualityIssue
              ) {
                directFallbackPublishGrid = augmentedAfterPrune.grid;
                directFallbackPublishEntries = augmentedEntries;
              }
            }
          }

          const cleanedPublishGrid = blockForbiddenAnswerRuns(
            directFallbackPublishGrid,
            minEntryLenForSize(n)
          );
          const cleanedPublishDerived = deriveEntriesFromGrid(
            cleanedPublishGrid,
            minEntryLenForSize(n)
          );
          if (cleanedPublishDerived.length >= minPublishEntriesForSize(n)) {
            const cleanedPublishEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(
                applyCluesAndOverrides(theme, language, cleanedPublishDerived, clueByAnswer),
                {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                }
              )
            );
            const cleanedPublishCrossed = crossedEntryStats(
              cleanedPublishGrid,
              cleanedPublishEntries,
              minEntryLenForSize(n)
            );
            const cleanedPublishChecked = checkedCellStats(cleanedPublishGrid, minEntryLenForSize(n));

            if (
              cleanedPublishEntries.length >= minPublishEntriesForSize(n) &&
              cleanedPublishCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              cleanedPublishChecked.ratio >= 0.25 &&
              !hasShortLetterRuns(cleanedPublishGrid, minEntryLenForSize(n))
            ) {
              directFallbackPublishGrid = cleanedPublishGrid;
              directFallbackPublishEntries = cleanedPublishEntries;
            }
          }
          const directFallbackWeakBeforeDensify = entryCrossingStats(
            directFallbackPublishGrid,
            directFallbackPublishEntries,
            minEntryLenForSize(n)
          ).weakEntries;
          if (n === 11 && directFallbackWeakBeforeDensify.length > 0) {
            const weakAnswers = new Set(directFallbackWeakBeforeDensify.map((entry) => entry.answer));
            const weakPrunedGrid = directFallbackPublishGrid.map((row) => row.slice());
            for (const entry of directFallbackPublishEntries) {
              if (!weakAnswers.has(entry.answer)) continue;
              for (let i = 0; i < entry.answer.length; i++) {
                const r = entry.direction === "down" ? entry.row + i : entry.row;
                const c = entry.direction === "across" ? entry.col + i : entry.col;
                if (inBounds(n, r, c)) weakPrunedGrid[r][c] = "#";
              }
            }

            const weakCleanGrid = blockShortRunsOnly(weakPrunedGrid, minEntryLenForSize(n));
            const weakCleanDerived = deriveEntriesFromGrid(weakCleanGrid, minEntryLenForSize(n));
            if (weakCleanDerived.length >= minPublishEntriesForSize(n) - 2) {
              directFallbackPublishGrid = weakCleanGrid;
              directFallbackPublishEntries = pruneMaskedDuplicateAnswers(
                repairPublishClues(
                  applyCluesAndOverrides(theme, language, weakCleanDerived, clueByAnswer),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              );
              fallbackBuilt = {
                ...fallbackBuilt,
                grid: weakCleanGrid,
                usedAnswers: Array.from(new Set(weakCleanDerived.map((entry) => entry.answer))),
                meta: {
                  ...fallbackBuilt.meta,
                  weakEntriesPrunedBeforeDensify: Array.from(weakAnswers),
                },
              };
            }
          }

          const directFallbackFinalQualityBeforeDensify = publishQualityIssue(
            directFallbackPublishEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const finalDensifierBaseGrid =
            directFallbackFinalQualityBeforeDensify &&
            cleanedPublishDerived.length > 0 &&
            cleanedPublishDerived.length < directFallbackPublishEntries.length &&
            cleanedPublishDerived.length >=
              Math.max(minPublishEntriesForSize(n) - 2, directFallbackPublishEntries.length - 2)
              ? cleanedPublishGrid
              : directFallbackPublishGrid;
          const finalDensifierBaseEntries = deriveEntriesFromGrid(
            finalDensifierBaseGrid,
            minEntryLenForSize(n)
          );
          const finalDensifiedDirectFallback =
            directFallbackPublishEntries.length < minPublishEntriesForSize(n) ||
            directFallbackPublishEntries.length < desiredPublishEntriesForSize(n) ||
            Boolean(directFallbackFinalQualityBeforeDensify)
              ? densifyCleanGrid11WithDependencies({ dependencies: gridEnhancementDependencies,
                  theme,
                  grid: finalDensifierBaseGrid,
                  candidates: fallbackPool,
                  targetEntries: desiredPublishEntriesForSize(n),
                  seed:
                    (fallbackStrictSeed ^
                      Math.imul(directFallbackPublishEntries.length + 1, 0x9e3779b9) ^
                      0x6a09e667) >>>
                    0,
                  deadlineMs: fallbackDeadlineMs,
                })
              : null;

          if (finalDensifiedDirectFallback) {
            const finalDensifiedEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(
                applyCluesAndOverrides(theme, language, finalDensifiedDirectFallback.derived, clueByAnswer),
                {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                }
              )
            );
            const finalDensifiedQualityIssue = publishQualityIssue(
              finalDensifiedEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );

            const shouldUseFinalDensified =
              finalDensifiedEntries.length >= minPublishEntriesForSize(n) &&
              !finalDensifiedQualityIssue &&
              (finalDensifiedEntries.length > directFallbackPublishEntries.length ||
                Boolean(directFallbackFinalQualityBeforeDensify) ||
                finalDensifiedDirectFallback.derived.length > finalDensifierBaseEntries.length);

            if (shouldUseFinalDensified) {
            directFallbackPublishGrid = finalDensifiedDirectFallback.grid;
            directFallbackPublishEntries = finalDensifiedEntries;
            fallbackBuilt = {
              ...fallbackBuilt,
              grid: finalDensifiedDirectFallback.grid,
              usedAnswers: Array.from(new Set(finalDensifiedDirectFallback.derived.map((entry) => entry.answer))),
              meta: {
                ...fallbackBuilt.meta,
                ...finalDensifiedDirectFallback.meta,
                finalDirectDensified: true,
              },
            };
            }
          }
          const directFallbackQualityAfterDensify = publishQualityIssue(
            directFallbackPublishEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const finalAugmentedDirectFallback =
            directFallbackPublishEntries.length < minPublishEntriesForSize(n) ||
            directFallbackPublishEntries.length < desiredPublishEntriesForSize(n) ||
            Boolean(directFallbackQualityAfterDensify)
              ? augmentNoShortGridWithCandidatesWithDependencies(
                  directFallbackPublishGrid,
                  fallbackPool.filter((candidate) => candidate.source !== "filler"),
                  minEntryLenForSize(n),
                  desiredPublishEntriesForSize(n),
                  minPublishEntriesForSize(n),
                  gridEnhancementDependencies
                )
              : null;

          if (finalAugmentedDirectFallback) {
            const finalAugmentedEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(
                applyCluesAndOverrides(theme, language, finalAugmentedDirectFallback.derived, clueByAnswer),
                {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                }
              )
            );
            const finalAugmentedQualityIssue = publishQualityIssue(
              finalAugmentedEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );

            if (
              finalAugmentedEntries.length >= minPublishEntriesForSize(n) &&
              !finalAugmentedQualityIssue
            ) {
              directFallbackPublishGrid = finalAugmentedDirectFallback.grid;
              directFallbackPublishEntries = finalAugmentedEntries;
              fallbackBuilt = {
                ...fallbackBuilt,
                grid: finalAugmentedDirectFallback.grid,
                usedAnswers: Array.from(new Set(finalAugmentedDirectFallback.derived.map((entry) => entry.answer))),
                meta: {
                  ...fallbackBuilt.meta,
                  finalDirectAugmented: true,
                },
              };
            }
          }
          let directFallbackQualityAfterAugment = publishQualityIssue(
            directFallbackPublishEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          if (directFallbackQualityAfterAugment) {
            const cleanedAfterAugmentGrid = blockForbiddenAnswerRuns(
              directFallbackPublishGrid,
              minEntryLenForSize(n)
            );
            const cleanedAfterAugmentDerived = deriveEntriesFromGrid(
              cleanedAfterAugmentGrid,
              minEntryLenForSize(n)
            );
            if (cleanedAfterAugmentDerived.length >= minPublishEntriesForSize(n) - 2) {
              const cleanedAfterAugmentEntries = pruneMaskedDuplicateAnswers(
                repairPublishClues(
                  applyCluesAndOverrides(theme, language, cleanedAfterAugmentDerived, clueByAnswer),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              );
              directFallbackPublishGrid = cleanedAfterAugmentGrid;
              directFallbackPublishEntries = cleanedAfterAugmentEntries;
              directFallbackQualityAfterAugment = publishQualityIssue(
                directFallbackPublishEntries,
                finalFallbackThematicSet,
                language,
                minPublishEntriesForSize(n)
              );
            }
          }
          const shouldRunStructuralRescue =
            n === 11 &&
            (directFallbackPublishEntries.length < minPublishEntriesForSize(n) ||
              hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)) ||
              entryCrossingStats(
                directFallbackPublishGrid,
                directFallbackPublishEntries,
                minEntryLenForSize(n)
              ).weakEntries.length > 0 ||
              Boolean(
                publishQualityIssue(
                  directFallbackPublishEntries,
                  finalFallbackThematicSet,
                  language,
                  minPublishEntriesForSize(n)
                )
              ));

          if (shouldRunStructuralRescue) {
            console.warn("[generate-crossword] direct fallback structural-rescue start", {
              entries: directFallbackPublishEntries.length,
              hasShortRuns: hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)),
              weakEntries: entryCrossingStats(
                directFallbackPublishGrid,
                directFallbackPublishEntries,
                minEntryLenForSize(n)
              ).weakEntries,
              qualityIssue: publishQualityIssue(
                directFallbackPublishEntries,
                finalFallbackThematicSet,
                language,
                minPublishEntriesForSize(n)
              ),
            });
            const pairExtended = extendGridWithCrossedPair11WithDependencies({ dependencies: gridEnhancementDependencies,
              grid: directFallbackPublishGrid,
              candidates: fallbackPool,
              targetEntries: minPublishEntriesForSize(n),
              seed: (fallbackStrictSeed ^ 0x51f15e0d ^ Math.imul(directFallbackPublishEntries.length + 1, 131)) >>> 0,
            });
            if (pairExtended) {
              const pairExtendedEntries = pruneForbiddenPublishAnswersIfPossible(
                pruneMaskedDuplicateAnswers(
                  repairPublishClues(
                    applyCluesAndOverrides(theme, language, pairExtended.derived, clueByAnswer),
                    {
                      theme,
                      language,
                      thematicSet: finalFallbackThematicSet,
                      notesByAnswer: fallbackNotesByAnswer,
                    }
                  )
                ),
                minPublishEntriesForSize(n)
              );
              directFallbackPublishGrid = pairExtended.grid;
              directFallbackPublishEntries = pairExtendedEntries;
              console.warn("[generate-crossword] direct fallback pair-extended", {
                fromEntries: directFallbackPublishEntries.length,
                addedAnswers: pairExtended.addedAnswers,
                derivedEntries: pairExtended.derived.length,
              });
            }
          }

          if (shouldRunStructuralRescue) {
            const structuralRescuePoolByAnswer = new Map<string, WordCandidate>(
              [...best.pool, ...lastAttemptPool]
                .filter((candidate) => candidate.answer.length >= minEntryLenForSize(n))
                .filter((candidate) => candidate.answer.length <= n)
                .filter((candidate) => ASCII_A_TO_Z.test(candidate.answer))
                .filter((candidate) => !isForbiddenPublishAnswer(candidate.answer))
                .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
                .map((candidate) => [candidate.answer, candidate] as const)
            );
            const structuralFillersByLength = new Map<number, string[]>();
            for (const word of language === "es" ? SPANISH_FILLER_WORDS : FILLER_WORDS) {
              const answer = normalizeAnswer(word);
              if (answer.length < minEntryLenForSize(n) || answer.length > 8) continue;
              if (!ASCII_A_TO_Z.test(answer)) continue;
              if (isForbiddenPublishAnswer(answer)) continue;
              const bucket = structuralFillersByLength.get(answer.length) ?? [];
              if (bucket.length < 100 && !bucket.includes(answer)) bucket.push(answer);
              structuralFillersByLength.set(answer.length, bucket);
            }
            const structuralFillers = Array.from(structuralFillersByLength)
              .sort(([a], [b]) => a - b)
              .flatMap(([, words]) => words)
              .map((word) => normalizeAnswer(word))
              .filter(Boolean);
            for (const answer of structuralFillers) {
              if (structuralRescuePoolByAnswer.has(answer)) continue;
              structuralRescuePoolByAnswer.set(answer, {
                answer,
                thematic: false,
                source: "filler",
              });
            }
            const structuralRescuePool: WordCandidate[] = Array.from(
              new Map(
                Array.from(structuralRescuePoolByAnswer.values()).map((candidate) => [
                  candidate.answer,
                  candidate,
                ] as const)
              ).values()
            );
            if (process.env.OPENAI_PATTERN_REPAIR_11 === "1") {
              try {
                const patternRepairWords = await generatePatternMatchedRepairWordsWithDependencies({ dependencies: openAiRepairServicesDependencies,
                  client,
                  theme,
                  language,
                  grid: directFallbackPublishGrid,
                  entries: deriveEntriesFromGrid(
                    directFallbackPublishGrid,
                    minEntryLenForSize(n)
                  ),
                  existingAnswers: structuralRescuePool.map((candidate) => candidate.answer),
                });
                for (const candidate of patternRepairWords) {
                  if (structuralRescuePoolByAnswer.has(candidate.answer)) continue;
                  structuralRescuePoolByAnswer.set(candidate.answer, candidate);
                  structuralRescuePool.push(candidate);
                  finalFallbackThematicSet.add(candidate.answer);
                }
              } catch (error: unknown) {
                console.warn("[pattern-repair-11] request failed", {
                  msg: errorSummary(error),
                });
              }
            }

            for (const candidate of structuralRescuePool) {
              const strongSupport = hasStrongThematicClueSupport({
                theme,
                answer: candidate.answer,
                language,
                note: fallbackNotesByAnswer.get(candidate.answer),
              });
              if (candidate.thematic || strongSupport) finalFallbackThematicSet.add(candidate.answer);
              if (
                candidate.source !== "support" &&
                candidate.source !== "filler" &&
                (candidate.thematic || strongSupport)
              ) {
                finalFallbackCoreThematicSet.add(candidate.answer);
              }
            }

            const structuralFreeform = runFreeformBuilder({ dependencies: freeformBuilderDependencies,
              size: n,
              seed: (fallbackStrictSeed ^ 0x6a09e667) >>> 0,
              candidates: structuralRescuePool.slice().sort((a, b) => {
                if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
                const aSource = a.source === "anchor" ? 3 : a.source === "model" ? 2 : 1;
                const bSource = b.source === "anchor" ? 3 : b.source === "model" ? 2 : 1;
                if (aSource !== bSource) return bSource - aSource;
                return b.answer.length - a.answer.length;
              }),
                  deadlineMs: boundedFallbackDeadline(9_000),
              maxPlacedWords: 50,
              maxBuilds: 32,
            });
            if (structuralFreeform) {
              const structuralPruned = pruneWeakEntriesPreservingCrosses(
                structuralFreeform.grid,
                minEntryLenForSize(n),
                minPublishEntriesForSize(n)
              );
              const structuralGrid = structuralPruned?.grid ?? structuralFreeform.grid;
              const structuralFreeformDerived = deriveEntriesFromGrid(
                structuralGrid,
                minEntryLenForSize(n)
              );
              const currentDerived = deriveEntriesFromGrid(
                directFallbackPublishGrid,
                minEntryLenForSize(n)
              );
              if (
                structuralFreeformDerived.length > currentDerived.length &&
                !structuralFreeformDerived.some((entry) =>
                  isForbiddenPublishAnswer(entry.answer)
                )
              ) {
                directFallbackPublishGrid = structuralGrid;
                directFallbackPublishEntries = pruneForbiddenPublishAnswersIfPossible(
                  pruneMaskedDuplicateAnswers(
                    repairPublishClues(
                      applyCluesAndOverrides(
                        theme,
                        language,
                        structuralFreeformDerived,
                        clueByAnswer
                      ),
                      {
                        theme,
                        language,
                        thematicSet: finalFallbackThematicSet,
                        notesByAnswer: fallbackNotesByAnswer,
                      }
                    )
                  ),
                  minPublishEntriesForSize(n)
                );
                console.warn("[generate-crossword] structural freeform improved fallback", {
                  fromEntries: currentDerived.length,
                  toEntries: structuralFreeformDerived.length,
                });
              }
            }

            const nearCompleteDerived = deriveEntriesFromGrid(
              directFallbackPublishGrid,
              minEntryLenForSize(n)
            );
            const nearCompleteWeak = entryCrossingStats(
              directFallbackPublishGrid,
              nearCompleteDerived,
              minEntryLenForSize(n)
            ).weakEntries;
            if (
              process.env.OPENAI_PATTERN_REPAIR_11 === "1" &&
              nearCompleteDerived.length >= minPublishEntriesForSize(n) &&
              nearCompleteWeak.length > 0 &&
              nearCompleteWeak.length <= 3
            ) {
              try {
                const targetedRepairWords = await generatePatternMatchedRepairWordsWithDependencies({ dependencies: openAiRepairServicesDependencies,
                  client,
                  theme,
                  language,
                  grid: directFallbackPublishGrid,
                  entries: nearCompleteDerived,
                  existingAnswers: structuralRescuePool.map((candidate) => candidate.answer),
                });
                for (const candidate of targetedRepairWords) {
                  if (structuralRescuePoolByAnswer.has(candidate.answer)) continue;
                  structuralRescuePoolByAnswer.set(candidate.answer, candidate);
                  structuralRescuePool.push(candidate);
                  finalFallbackThematicSet.add(candidate.answer);
                }
                console.warn("[generate-crossword] targeted weak-entry repair pool", {
                  entries: nearCompleteDerived.length,
                  weakEntries: nearCompleteWeak,
                  addedCandidates: targetedRepairWords.length,
                });
              } catch (error: unknown) {
                console.warn("[pattern-repair-11] targeted request failed", {
                  msg: errorSummary(error),
                });
              }
            }

            if (hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n))) {
              const shortCleanGrid = blockShortRunsOnly(directFallbackPublishGrid, minEntryLenForSize(n));
              const shortCleanDerived = deriveEntriesFromGrid(shortCleanGrid, minEntryLenForSize(n));
              if (
                shortCleanDerived.length >= minPublishEntriesForSize(n) - 2 &&
                shortCleanDerived.length >= directFallbackPublishEntries.length - 2
              ) {
                directFallbackPublishGrid = shortCleanGrid;
                directFallbackPublishEntries = pruneForbiddenPublishAnswersIfPossible(
                  pruneMaskedDuplicateAnswers(
                    repairPublishClues(
                      applyCluesAndOverrides(theme, language, shortCleanDerived, clueByAnswer),
                      {
                        theme,
                        language,
                        thematicSet: finalFallbackThematicSet,
                        notesByAnswer: fallbackNotesByAnswer,
                      }
                    )
                  ),
                  minPublishEntriesForSize(n)
                );
              }
            }

            const structuralDensifyBaseGrid = directFallbackPublishGrid;
            const structuralDensifyBaseDerived = deriveEntriesFromGrid(
              structuralDensifyBaseGrid,
              minEntryLenForSize(n)
            );
            const structuralDensifyBaseWeakEntries = entryCrossingStats(
              structuralDensifyBaseGrid,
              structuralDensifyBaseDerived,
              minEntryLenForSize(n)
            ).weakEntries.length;
            const structuralDensifyBaseHasShortRuns = hasShortLetterRuns(
              structuralDensifyBaseGrid,
              minEntryLenForSize(n)
            );
            if (structuralDensifyBaseDerived.length >= Math.max(8, directFallbackPublishEntries.length - 5)) {
              const structuralDensified = densifyCleanGrid11WithDependencies({ dependencies: gridEnhancementDependencies,
                theme,
                grid: structuralDensifyBaseGrid,
                candidates: structuralRescuePool,
                targetEntries: minPublishEntriesForSize(n),
                seed: (fallbackStrictSeed ^ 0x94d049bb ^ Math.imul(structuralDensifyBaseDerived.length + 1, 137)) >>> 0,
                deadlineMs: boundedFallbackDeadline(14_000),
              });
              if (structuralDensified) {
                const newRepairAnswers = structuralDensified.added.filter(
                  (answer) => !clueByAnswer.has(answer)
                );
                if (newRepairAnswers.length > 0) {
                  try {
                    const repairClues = await requestModelClues({
                      client,
                      theme,
                      language,
                      items: newRepairAnswers.map((answer) => ({
                        answer,
                        thematic: true,
                        hint:
                          language === "es"
                            ? `Da una pista concreta que vincule ${answer} con ${theme}.`
                            : `Give a concrete clue linking ${answer} to ${theme}.`,
                      })),
                    });
                    for (const [answer, clue] of repairClues) {
                      clueByAnswer.set(answer, clue);
                    }
                  } catch (error: unknown) {
                    console.warn("[pattern-repair-11] clue request failed", {
                      msg: errorSummary(error),
                    });
                  }
                }
                const structuralDensifiedEntries = pruneForbiddenPublishAnswersIfPossible(
                  pruneMaskedDuplicateAnswers(
                    repairPublishClues(
                      applyCluesAndOverrides(theme, language, structuralDensified.derived, clueByAnswer),
                      {
                        theme,
                        language,
                        thematicSet: finalFallbackThematicSet,
                        notesByAnswer: fallbackNotesByAnswer,
                      }
                    )
                  ),
                  minPublishEntriesForSize(n)
                );
                const structuralDensifiedWeak = entryCrossingStats(
                  structuralDensified.grid,
                  structuralDensifiedEntries,
                  minEntryLenForSize(n)
                ).weakEntries.length;
                const structuralDensifiedHasShortRuns = hasShortLetterRuns(
                  structuralDensified.grid,
                  minEntryLenForSize(n)
                );
                const shouldUseStructuralDensified =
                  structuralDensifiedEntries.length >= minPublishEntriesForSize(n) &&
                  structuralDensifiedWeak === 0 &&
                  !structuralDensifiedHasShortRuns &&
                  !publishQualityIssue(
                    structuralDensifiedEntries,
                    finalFallbackThematicSet,
                    language,
                    minPublishEntriesForSize(n)
                  );

                if (shouldUseStructuralDensified) {
                  directFallbackPublishGrid = structuralDensified.grid;
                  directFallbackPublishEntries = structuralDensifiedEntries;
                  fallbackBuilt = {
                    ...fallbackBuilt,
                    grid: structuralDensified.grid,
                    usedAnswers: Array.from(new Set(structuralDensified.derived.map((entry) => entry.answer))),
                    meta: {
                      ...fallbackBuilt.meta,
                      structuralDensified: true,
                    },
                  };
                  console.warn("[generate-crossword] direct fallback structural densified", {
                    entries: structuralDensifiedEntries.length,
                    weakEntries: structuralDensifiedWeak,
                    added: structuralDensified.added,
                    acceptedForPublish: shouldUseStructuralDensified,
                  });
                } else {
                  const improvesWeakEntries =
                    structuralDensifiedWeak < structuralDensifyBaseWeakEntries;
                  const fixesShortRuns =
                    structuralDensifyBaseHasShortRuns && !structuralDensifiedHasShortRuns;
                  const keepsEnoughEntries =
                    structuralDensifiedEntries.length >=
                    Math.max(10, minPublishEntriesForSize(n) - 3);

                  if (keepsEnoughEntries && (improvesWeakEntries || fixesShortRuns)) {
                    directFallbackPublishGrid = structuralDensified.grid;
                    directFallbackPublishEntries = structuralDensifiedEntries;
                    fallbackBuilt = {
                      ...fallbackBuilt,
                      grid: structuralDensified.grid,
                      usedAnswers: Array.from(new Set(structuralDensified.derived.map((entry) => entry.answer))),
                      meta: {
                        ...fallbackBuilt.meta,
                        structuralDensifiedIntermediate: true,
                      },
                    };
                    console.warn("[generate-crossword] direct fallback structural densified intermediate", {
                      entries: structuralDensifiedEntries.length,
                      baseWeakEntries: structuralDensifyBaseWeakEntries,
                      weakEntries: structuralDensifiedWeak,
                      baseHasShortRuns: structuralDensifyBaseHasShortRuns,
                      hasShortRuns: structuralDensifiedHasShortRuns,
                      added: structuralDensified.added,
                    });
                  }
                }
              }
            }

            for (let round = 0; round < 4; round++) {
              if (directFallbackPublishEntries.length >= minPublishEntriesForSize(n)) break;
              const beforeEntries = directFallbackPublishEntries.length;
              const pairExtended = extendGridWithCrossedPair11WithDependencies({ dependencies: gridEnhancementDependencies,
                grid: directFallbackPublishGrid,
                candidates: structuralRescuePool,
                targetEntries: minPublishEntriesForSize(n),
                seed:
                  (fallbackStrictSeed ^
                    0x7f4a7c15 ^
                    Math.imul(round + 1, 2654435761) ^
                    Math.imul(beforeEntries + 1, 2246822519)) >>>
                  0,
              });
              if (!pairExtended || pairExtended.derived.length <= beforeEntries) break;
              const pairExtendedEntries = pruneForbiddenPublishAnswersIfPossible(
                pruneMaskedDuplicateAnswers(
                  repairPublishClues(
                    applyCluesAndOverrides(theme, language, pairExtended.derived, clueByAnswer),
                    {
                      theme,
                      language,
                      thematicSet: finalFallbackThematicSet,
                      notesByAnswer: fallbackNotesByAnswer,
                    }
                  )
                ),
                minPublishEntriesForSize(n)
              );
              directFallbackPublishGrid = pairExtended.grid;
              directFallbackPublishEntries = pairExtendedEntries;
              console.warn("[generate-crossword] direct fallback structural pair extension", {
                round,
                beforeEntries,
                afterEntries: directFallbackPublishEntries.length,
                addedAnswers: pairExtended.addedAnswers,
              });
            }

            const structuralRescueDeadlineMs = boundedFallbackDeadline(14_000);
            const structuralRescueBuilt =
              structuralRescuePool.length >= minPublishEntriesForSize(n)
                ? runLegacyBuilder({ mode: "pattern-11", dependencies: legacyBuilderDependencies,
                    theme,
                    size: n,
                    seed: (fallbackStrictSeed ^ 0x3c6ef372) >>> 0,
                    candidates: structuralRescuePool,
                    deadlineMs: structuralRescueDeadlineMs,
                  }) ??
                  runLegacyBuilder({ mode: "compact-pattern-11", dependencies: legacyBuilderDependencies,
                    theme,
                    size: n,
                    seed: (fallbackStrictSeed ^ 0xa5a5a5a5) >>> 0,
                    candidates: structuralRescuePool,
                    deadlineMs: structuralRescueDeadlineMs,
                  }) ??
                  runOpeningBuilder({ dependencies: openingBuilderDependencies,
                    theme,
                    candidates: structuralRescuePool,
                    seed: (fallbackStrictSeed ^ 0xbb67ae85) >>> 0,
                    targetEntries: minPublishEntriesForSize(n),
                    deadlineMs: structuralRescueDeadlineMs,
                  })
                : null;

            if (structuralRescueBuilt) {
              const structuralRescueDerived = deriveEntriesFromGrid(
                structuralRescueBuilt.grid,
                minEntryLenForSize(n)
              );
              for (const entry of structuralRescueDerived) {
                if (clueByAnswer.has(entry.answer)) continue;
                const note = fallbackNotesByAnswer.get(entry.answer);
                const noteClue = note ? clueFromThemeNote(theme, note, language) : null;
                const specificClue = specificThematicFallbackClue(theme, entry.answer, language);
                if (noteClue || specificClue) {
                  clueByAnswer.set(entry.answer, noteClue ?? specificClue ?? "");
                }
              }

              const structuralRescueEntries = pruneForbiddenPublishAnswersIfPossible(
                pruneMaskedDuplicateAnswers(
                  repairPublishClues(
                    applyCluesAndOverrides(theme, language, structuralRescueDerived, clueByAnswer),
                    {
                      theme,
                      language,
                      thematicSet: finalFallbackThematicSet,
                      notesByAnswer: fallbackNotesByAnswer,
                    }
                  )
                ),
                minPublishEntriesForSize(n)
              );
              const structuralRescueChecked = checkedCellStats(
                structuralRescueBuilt.grid,
                minEntryLenForSize(n)
              );
              const structuralRescueCrossed = crossedEntryStats(
                structuralRescueBuilt.grid,
                structuralRescueEntries,
                minEntryLenForSize(n)
              );
              const structuralRescueEntryCrossings = entryCrossingStats(
                structuralRescueBuilt.grid,
                structuralRescueEntries,
                minEntryLenForSize(n)
              );
              const structuralRescueThemeEntries = structuralRescueEntries.filter((entry) =>
                finalFallbackThematicSet.has(entry.answer)
              ).length;
              const structuralRescueCoreEntries = structuralRescueEntries.filter((entry) =>
                finalFallbackCoreThematicSet.has(entry.answer)
              ).length;
              const structuralRescueGenericEntries = structuralRescueEntries.filter(
                (entry) => finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
              ).length;
              const structuralRescuePlaceholderCount = structuralRescueEntries.filter((entry) =>
                isPlaceholderClue(entry.clue, language)
              ).length;
              const structuralRescueQualityIssue = publishQualityIssue(
                structuralRescueEntries,
                finalFallbackThematicSet,
                language,
                minPublishEntriesForSize(n)
              );

              if (
                structuralRescueEntries.length >= minPublishEntriesForSize(n) &&
                structuralRescueCrossed.crossed >= structuralRescueEntries.length &&
                structuralRescueEntryCrossings.weakEntries.length === 0 &&
                structuralRescueChecked.ratio >= 0.25 &&
                structuralRescueThemeEntries >= minThematicEntriesForPublish(n, structuralRescueEntries.length) &&
                structuralRescueCoreEntries >= minCoreThematicEntriesForPublish(n, structuralRescueEntries.length) &&
                structuralRescueGenericEntries <= maxGenericContextEntriesForPublish(n, structuralRescueEntries.length) &&
                structuralRescuePlaceholderCount === 0 &&
                !hasShortLetterRuns(structuralRescueBuilt.grid, minEntryLenForSize(n)) &&
                !structuralRescueQualityIssue
              ) {
                directFallbackPublishGrid = structuralRescueBuilt.grid;
                directFallbackPublishEntries = structuralRescueEntries;
                fallbackBuilt = {
                  ...fallbackBuilt,
                  grid: structuralRescueBuilt.grid,
                  usedAnswers: Array.from(new Set(structuralRescueDerived.map((entry) => entry.answer))),
                  meta: {
                    ...fallbackBuilt.meta,
                    ...structuralRescueBuilt.meta,
                    structuralRescue: true,
                  },
                };
                console.warn("[generate-crossword] direct fallback structural-rescue accepted", {
                  entries: structuralRescueEntries.length,
                  thematicEntries: structuralRescueThemeEntries,
                  coreThematicEntries: structuralRescueCoreEntries,
                  genericContextEntries: structuralRescueGenericEntries,
                  checkedRatio: structuralRescueChecked.ratio,
                  builder: structuralRescueBuilt.meta?.builder ?? null,
                });
              } else {
                console.warn("[generate-crossword] direct fallback structural-rescue rejected", {
                  entries: structuralRescueEntries.length,
                  thematicEntries: structuralRescueThemeEntries,
                  coreThematicEntries: structuralRescueCoreEntries,
                  genericContextEntries: structuralRescueGenericEntries,
                  crossedEntries: structuralRescueCrossed.crossed,
                  weakEntries: structuralRescueEntryCrossings.weakEntries,
                  checkedRatio: structuralRescueChecked.ratio,
                  placeholderCount: structuralRescuePlaceholderCount,
                  qualityIssue: structuralRescueQualityIssue,
                  hasShortRuns: hasShortLetterRuns(structuralRescueBuilt.grid, minEntryLenForSize(n)),
                  builder: structuralRescueBuilt.meta?.builder ?? null,
                  answers: structuralRescueEntries.map((entry) => entry.answer),
                });
              }
            } else {
              const structuralLenCount = structuralRescuePool.reduce((acc, candidate) => {
                acc.set(candidate.answer.length, (acc.get(candidate.answer.length) ?? 0) + 1);
                return acc;
              }, new Map<number, number>());
              console.warn("[generate-crossword] direct fallback structural-rescue unavailable", {
                candidatePool: structuralRescuePool.length,
                lenCount: Object.fromEntries(structuralLenCount),
                targetEntries: minPublishEntriesForSize(n),
              });
            }
          }
          const weakBeforePrune = entryCrossingStats(
            directFallbackPublishGrid,
            directFallbackPublishEntries,
            minEntryLenForSize(n)
          ).weakEntries;
          if (
            directFallbackPublishEntries.length > minPublishEntriesForSize(n) &&
            weakBeforePrune.length > 0
          ) {
            for (const weakEntry of weakBeforePrune) {
              const survivors = directFallbackPublishEntries.filter(
                (entry) => entry.answer !== weakEntry.answer
              );
              if (survivors.length < minPublishEntriesForSize(n)) continue;
              const rebuiltWithoutWeak = rebuildGridFromEntries(
                n,
                survivors,
                minEntryLenForSize(n)
              );
              if (!rebuiltWithoutWeak) continue;
              const crossingsWithoutWeak = entryCrossingStats(
                rebuiltWithoutWeak.grid,
                rebuiltWithoutWeak.derived,
                minEntryLenForSize(n)
              );
              if (rebuiltWithoutWeak.derived.length < minPublishEntriesForSize(n)) continue;
              if (crossingsWithoutWeak.weakEntries.length > 0) continue;
              if (hasShortLetterRuns(rebuiltWithoutWeak.grid, minEntryLenForSize(n))) continue;

              directFallbackPublishGrid = rebuiltWithoutWeak.grid;
              directFallbackPublishEntries = repairPublishClues(
                applyCluesAndOverrides(
                  theme,
                  language,
                  rebuiltWithoutWeak.derived,
                  clueByAnswer
                ),
                {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                }
              );
              console.warn("[generate-crossword] pruned weak surplus entry", {
                removed: weakEntry.answer,
                entries: directFallbackPublishEntries.length,
                minEntryCheckedCells: crossingsWithoutWeak.minCheckedCells,
              });
              break;
            }
          }

          if (
            directFallbackPublishEntries.length >= minPublishEntriesForSize(n) - 2 &&
            directFallbackPublishEntries.length < minPublishEntriesForSize(n)
          ) {
            const oneWordAugment = augmentNoShortGridWithCandidatesWithDependencies(
              directFallbackPublishGrid,
              fallbackPool,
              minEntryLenForSize(n),
              minPublishEntriesForSize(n),
              minPublishEntriesForSize(n),
              gridEnhancementDependencies
            );
            if (oneWordAugment) {
              directFallbackPublishGrid = oneWordAugment.grid;
              directFallbackPublishEntries = pruneMaskedDuplicateAnswers(
                repairPublishClues(
                  applyCluesAndOverrides(
                    theme,
                    language,
                    oneWordAugment.derived,
                    clueByAnswer
                  ),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              );
              console.warn("[generate-crossword] one-word final augment accepted", {
                entries: directFallbackPublishEntries.length,
              });
            }
          }

          const finalStructuralPrune = pruneWeakEntriesPreservingCrosses(
            directFallbackPublishGrid,
            minEntryLenForSize(n),
            minPublishEntriesForSize(n)
          );
          if (finalStructuralPrune) {
            directFallbackPublishGrid = finalStructuralPrune.grid;
            directFallbackPublishEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(
                applyCluesAndOverrides(
                  theme,
                  language,
                  finalStructuralPrune.derived,
                  clueByAnswer
                ),
                {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                }
              )
            );
            console.warn("[generate-crossword] final structural prune accepted", {
              entries: directFallbackPublishEntries.length,
              minEntryCheckedCells: entryCrossingStats(
                directFallbackPublishGrid,
                directFallbackPublishEntries,
                minEntryLenForSize(n)
              ).minCheckedCells,
            });
          }

          const directFallbackCheckedStats = checkedCellStats(
            directFallbackPublishGrid,
            minEntryLenForSize(n)
          );
          const directFallbackCrossedStats = crossedEntryStats(
            directFallbackPublishGrid,
            directFallbackPublishEntries,
            minEntryLenForSize(n)
          );
          const directFallbackEntryCrossingStats = entryCrossingStats(
            directFallbackPublishGrid,
            directFallbackPublishEntries,
            minEntryLenForSize(n)
          );
          const directFallbackThemeEntries = directFallbackPublishEntries.filter((e) =>
            finalFallbackThematicSet.has(e.answer)
          ).length;
          const directFallbackCoreThematicEntries = directFallbackPublishEntries.filter((e) =>
            finalFallbackCoreThematicSet.has(e.answer)
          ).length;
          const directFallbackMinCoreThematicEntries = minCoreThematicEntriesForPublish(
            n,
            directFallbackPublishEntries.length
          );
          const directFallbackGenericContextEntries = directFallbackPublishEntries.filter((e) =>
            finalFallbackThematicSet.has(e.answer) && !finalFallbackCoreThematicSet.has(e.answer)
          ).length;
          const directFallbackMaxGenericContextEntries = maxGenericContextEntriesForPublish(
            n,
            directFallbackPublishEntries.length
          );
          const directFallbackMinThemeEntries = minThematicEntriesForPublish(
            n,
            directFallbackPublishEntries.length
          );
          const directFallbackPlaceholderCount = directFallbackPublishEntries.filter((e) =>
            isPlaceholderClue(e.clue, language)
          ).length;
          const directFallbackQualityIssue = publishQualityIssue(
            directFallbackPublishEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const directFallbackNearMinEntries =
            n === 11 ? 10 : minPublishEntriesForSize(n);
          const directFallbackUnsupportedEntries = directFallbackPublishEntries.filter(
            (entry) =>
              !isPublishableAnswerForTheme({
                theme,
                answer: entry.answer,
                language,
                size: n,
                note: fallbackNotesByAnswer.get(entry.answer),
                allowContextualGeneric: finalFallbackThematicSet.has(entry.answer),
              })
          );
          if (
            directFallbackPublishEntries.length >= minPublishEntriesForSize(n) &&
            !hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)) &&
            !directFallbackPublishEntries.some((entry) => isForbiddenPublishAnswer(entry.answer)) &&
            directFallbackUnsupportedEntries.length === 0 &&
            directFallbackCrossedStats.crossed >= minCrossedEntriesForPublish(n) &&
            directFallbackEntryCrossingStats.weakEntries.length === 0 &&
            directFallbackCheckedStats.ratio >= 0.25 &&
            directFallbackThemeEntries >= directFallbackMinThemeEntries &&
            directFallbackCoreThematicEntries >= directFallbackMinCoreThematicEntries &&
            directFallbackGenericContextEntries <= directFallbackMaxGenericContextEntries &&
            directFallbackPlaceholderCount === 0 &&
            !directFallbackQualityIssue
          ) {
            console.warn("[generate-crossword] FALLBACK -> direct 11x11 reconstructed", {
              attempt: bestPartial.attempt,
              entries: directFallbackPublishEntries.length,
              thematicEntries: directFallbackThemeEntries,
              coreThematicEntries: directFallbackCoreThematicEntries,
              genericContextEntries: directFallbackGenericContextEntries,
              crossedEntries: directFallbackCrossedStats.crossed,
              checkedRatio: directFallbackCheckedStats.ratio,
              fallbackScore: bestPartial.fallbackScore,
              builder: fallbackBuilt.meta?.builder ?? null,
            });

            return accepted(
              {
                theme,
                language,
                size: n,
                grid: directFallbackPublishGrid,
                entries: directFallbackPublishEntries,
                meta: {
                  source: "fallback-best-built-direct-11",
                  attempt: best.attempt,
                  fallbackScore: best.fallbackScore,
                  checkedRatio: directFallbackCheckedStats.ratio,
                  crossedEntries: directFallbackCrossedStats.crossed,
                  thematicEntries: directFallbackThemeEntries,
                  minThematicEntries: directFallbackMinThemeEntries,
                  coreThematicEntries: directFallbackCoreThematicEntries,
                  minCoreThematicEntries: directFallbackMinCoreThematicEntries,
                  genericContextEntries: directFallbackGenericContextEntries,
                  maxGenericContextEntries: directFallbackMaxGenericContextEntries,
                  placeholderCount: directFallbackPlaceholderCount,
                  minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                  minEntryCheckedCells: directFallbackEntryCrossingStats.minCheckedCells,
                  hasShortRuns: false,
                  ...fallbackBuilt.meta,
                },
              } satisfies Crossword
            );
          }

          if (
            n === 11 &&
            directFallbackPublishEntries.length >= directFallbackNearMinEntries &&
            directFallbackThemeEntries === directFallbackPublishEntries.length &&
            !hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)) &&
            !directFallbackPublishEntries.some((entry) => isForbiddenPublishAnswer(entry.answer)) &&
            directFallbackUnsupportedEntries.length === 0 &&
            directFallbackCrossedStats.crossed >= Math.max(6, directFallbackPublishEntries.length - 1) &&
            directFallbackEntryCrossingStats.weakEntries.length === 0 &&
            directFallbackCheckedStats.ratio >= 0.25 &&
            directFallbackPlaceholderCount === 0 &&
            !directFallbackQualityIssue
          ) {
            console.warn("[generate-crossword] FALLBACK -> near-threshold clean 11x11", {
              attempt: bestPartial.attempt,
              entries: directFallbackPublishEntries.length,
              thematicEntries: directFallbackThemeEntries,
              crossedEntries: directFallbackCrossedStats.crossed,
              checkedRatio: directFallbackCheckedStats.ratio,
              fallbackScore: bestPartial.fallbackScore,
              builder: fallbackBuilt.meta?.builder ?? null,
            });

            return accepted(
              {
                theme,
                language,
                size: n,
                grid: directFallbackPublishGrid,
                entries: directFallbackPublishEntries,
                meta: {
                  source: "fallback-best-built-near-threshold-11",
                  attempt: best.attempt,
                  fallbackScore: best.fallbackScore,
                  checkedRatio: directFallbackCheckedStats.ratio,
                  crossedEntries: directFallbackCrossedStats.crossed,
                  thematicEntries: directFallbackThemeEntries,
                  minThematicEntries: directFallbackMinThemeEntries,
                  coreThematicEntries: directFallbackCoreThematicEntries,
                  minCoreThematicEntries: directFallbackMinCoreThematicEntries,
                  genericContextEntries: directFallbackGenericContextEntries,
                  maxGenericContextEntries: directFallbackMaxGenericContextEntries,
                  placeholderCount: directFallbackPlaceholderCount,
                  nearThreshold: true,
                  targetEntries: minPublishEntriesForSize(n),
                  acceptedMinEntries: directFallbackNearMinEntries,
                  weakCrossingEntries: directFallbackEntryCrossingStats.weakEntries,
                  hasShortRuns: hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)),
                  ...fallbackBuilt.meta,
                },
              } satisfies Crossword
            );
          }

          const directFallbackEmergencyMinEntries = minPublishEntriesForSize(n);
          const directFallbackEmergencyQualityIssue = publishQualityIssue(
            directFallbackPublishEntries,
            finalFallbackThematicSet,
            language,
            directFallbackEmergencyMinEntries
          );

          if (
            n === 11 &&
            directFallbackPublishEntries.length >= directFallbackEmergencyMinEntries &&
            directFallbackThemeEntries === directFallbackPublishEntries.length &&
            !hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)) &&
            !directFallbackPublishEntries.some((entry) => isForbiddenPublishAnswer(entry.answer)) &&
            directFallbackUnsupportedEntries.length === 0 &&
            directFallbackCrossedStats.crossed >= directFallbackPublishEntries.length &&
            directFallbackEntryCrossingStats.weakEntries.length === 0 &&
            directFallbackCheckedStats.ratio >= 0.25 &&
            directFallbackPlaceholderCount === 0 &&
            !directFallbackEmergencyQualityIssue
          ) {
            console.warn("[generate-crossword] FALLBACK -> emergency clean 11x11", {
              attempt: bestPartial.attempt,
              entries: directFallbackPublishEntries.length,
              thematicEntries: directFallbackThemeEntries,
              coreThematicEntries: directFallbackCoreThematicEntries,
              genericContextEntries: directFallbackGenericContextEntries,
              crossedEntries: directFallbackCrossedStats.crossed,
              checkedRatio: directFallbackCheckedStats.ratio,
              targetEntries: minPublishEntriesForSize(n),
              builder: fallbackBuilt.meta?.builder ?? null,
            });

            return accepted(
              {
                theme,
                language,
                size: n,
                grid: directFallbackPublishGrid,
                entries: directFallbackPublishEntries,
                meta: {
                  source: "fallback-emergency-clean-11",
                  attempt: best.attempt,
                  fallbackScore: best.fallbackScore,
                  checkedRatio: directFallbackCheckedStats.ratio,
                  crossedEntries: directFallbackCrossedStats.crossed,
                  thematicEntries: directFallbackThemeEntries,
                  minThematicEntries: directFallbackMinThemeEntries,
                  coreThematicEntries: directFallbackCoreThematicEntries,
                  minCoreThematicEntries: directFallbackMinCoreThematicEntries,
                  genericContextEntries: directFallbackGenericContextEntries,
                  maxGenericContextEntries: directFallbackMaxGenericContextEntries,
                  placeholderCount: directFallbackPlaceholderCount,
                  emergencyMinEntries: directFallbackEmergencyMinEntries,
                  targetEntries: minPublishEntriesForSize(n),
                  desiredEntries: desiredPublishEntriesForSize(n),
                  hasShortRuns: false,
                  ...fallbackBuilt.meta,
                },
              } satisfies Crossword
            );
          }

          const noShortRunFallback = rebuildNoShortRunPublishableCrosswordWithPolicies(
            theme,
            n,
            directFallbackEntriesCandidate,
            language,
            finalFallbackThematicSet,
            minPublishEntriesForSize(n),
            9,
            gridReconstructionPolicies
          );

          if (noShortRunFallback) {
            const noShortEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(noShortRunFallback.entries, {
                theme,
                language,
                thematicSet: finalFallbackThematicSet,
                notesByAnswer: fallbackNotesByAnswer,
              })
            );
            const noShortStats = checkedCellStats(noShortRunFallback.grid, minEntryLenForSize(n));
            const noShortCrossed = crossedEntryStats(
              noShortRunFallback.grid,
              noShortEntries,
              minEntryLenForSize(n)
            );
            const noShortEntryCrossingStats = entryCrossingStats(
              noShortRunFallback.grid,
              noShortEntries,
              minEntryLenForSize(n)
            );
            const noShortThemeEntries = noShortEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const noShortCoreThematicEntries = noShortEntries.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const noShortMinCoreThematicEntries = minCoreThematicEntriesForPublish(
              n,
              noShortEntries.length
            );
            const noShortGenericContextEntries = noShortEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const noShortMaxGenericContextEntries = maxGenericContextEntriesForPublish(
              n,
              noShortEntries.length
            );
            const noShortMinThemeEntries = minThematicEntriesForPublish(n, noShortEntries.length);
            const noShortQualityIssue = publishQualityIssue(
              noShortEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );

            if (
              noShortEntries.length >= minPublishEntriesForSize(n) &&
              noShortCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              noShortEntryCrossingStats.weakEntries.length === 0 &&
              noShortStats.ratio >= 0.25 &&
              noShortThemeEntries >= noShortMinThemeEntries &&
              noShortCoreThematicEntries >= noShortMinCoreThematicEntries &&
              noShortGenericContextEntries <= noShortMaxGenericContextEntries &&
              !hasShortLetterRuns(noShortRunFallback.grid, minEntryLenForSize(n)) &&
              !noShortQualityIssue
            ) {
              console.warn("[generate-crossword] FALLBACK -> no-short-run reconstructed", {
                attempt: bestPartial.attempt,
                entries: noShortEntries.length,
                thematicEntries: noShortThemeEntries,
                coreThematicEntries: noShortCoreThematicEntries,
                genericContextEntries: noShortGenericContextEntries,
                crossedEntries: noShortCrossed.crossed,
                checkedRatio: noShortStats.ratio,
                fallbackScore: bestPartial.fallbackScore,
                builder: fallbackBuilt.meta?.builder ?? null,
              });

              return accepted(
                {
                  theme,
                  language,
                  size: n,
                  grid: noShortRunFallback.grid,
                  entries: noShortEntries,
                  meta: {
                    source: "fallback-best-built-no-short-runs",
                    attempt: best.attempt,
                    fallbackScore: best.fallbackScore,
                    checkedRatio: noShortStats.ratio,
                    crossedEntries: noShortCrossed.crossed,
                    thematicEntries: noShortThemeEntries,
                    minThematicEntries: noShortMinThemeEntries,
                    coreThematicEntries: noShortCoreThematicEntries,
                    minCoreThematicEntries: noShortMinCoreThematicEntries,
                    genericContextEntries: noShortGenericContextEntries,
                    maxGenericContextEntries: noShortMaxGenericContextEntries,
                    minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                    minEntryCheckedCells: noShortEntryCrossingStats.minCheckedCells,
                    placeholderCount: 0,
                    ...fallbackBuilt.meta,
                  },
                } satisfies Crossword
              );
            }
          }

          const lateThemeFirstTrustedSet = new Set<string>([
            ...best.trustedThematicSet,
            ...lastAttemptPool
              .filter((candidate) => candidate.thematic && candidate.source !== "filler")
              .filter((candidate) => !isOverGenericThemeWordForTheme(theme, candidate.answer))
              .filter((candidate) =>
                hasStrongThematicClueSupport({
                  theme,
                  answer: candidate.answer,
                  language,
                  note: fallbackNotesByAnswer.get(candidate.answer),
                })
              )
              .map((candidate) => candidate.answer),
          ]);
          const lateThemeFirstPoolByAnswer = new Map<string, WordCandidate>();
          for (const candidate of [...fallbackPool, ...lastAttemptPool]) {
            if (candidate.source === "filler") continue;
            if (lateThemeFirstPoolByAnswer.has(candidate.answer)) continue;
            lateThemeFirstPoolByAnswer.set(candidate.answer, candidate);
          }
          const lateThemeFirstRescue =
            Date.now() < deadlineMs - 7_000
              ? await runThemeFirstRescue({ dependencies: themeFirstRescueDependencies,
                  client,
                  theme,
                  language,
                  size: n,
                  pool: Array.from(lateThemeFirstPoolByAnswer.values()),
                  notesByAnswer: fallbackNotesByAnswer,
                  trustedThematicSet: lateThemeFirstTrustedSet,
                  seedBase:
                    (fallbackStrictSeed ^
                      Math.imul(directFallbackPublishEntries.length + 1, 0x9e3779b9) ^
                      Math.imul(directFallbackThemeEntries + 1, 0x85ebca6b)) >>>
                    0,
                })
              : null;

          if (lateThemeFirstRescue) {
            console.warn("[generate-crossword] FALLBACK -> late theme-first rescue", {
              attempt: bestPartial.attempt,
              previousEntries: directFallbackPublishEntries.length,
              previousThematicEntries: directFallbackThemeEntries,
              rescueEntries: lateThemeFirstRescue.entries.length,
              source: lateThemeFirstRescue.meta?.source,
            });
            return accepted(lateThemeFirstRescue);
          }

          const lateLayoutPoolByAnswer = new Map<string, WordCandidate>();
          for (const candidate of [
            ...Array.from(lateThemeFirstPoolByAnswer.values()),
            ...best.pool,
            ...lastAttemptPool,
          ]) {
            if (candidate.source === "filler") continue;
            if (lateLayoutPoolByAnswer.has(candidate.answer)) continue;
            if (candidate.answer.length < minEntryLenForSize(n) || candidate.answer.length > n) continue;
            if (!ASCII_A_TO_Z.test(candidate.answer)) continue;
            if (isForbiddenPublishAnswer(candidate.answer)) continue;
            if (isOverGenericThemeWordForTheme(theme, candidate.answer)) continue;
            lateLayoutPoolByAnswer.set(candidate.answer, {
              ...candidate,
              thematic:
                lateThemeFirstTrustedSet.has(candidate.answer) ||
                finalFallbackThematicSet.has(candidate.answer) ||
              candidate.thematic,
            });
          }

          const earlyOpeningFallback =
            n === 11
              ? runOpeningBuilder({ dependencies: openingBuilderDependencies,
                  theme,
                  candidates: Array.from(lateLayoutPoolByAnswer.values()),
                  seed:
                    (fallbackStrictSeed ^
                      0x38ad11c7 ^
                      Math.imul(directFallbackPublishEntries.length + 1, 193)) >>>
                    0,
                  targetEntries: minPublishEntriesForSize(n),
                  deadlineMs: boundedFallbackDeadline(18_000),
                })
              : null;

          if (earlyOpeningFallback) {
            const openingItems: ClueRequestItem[] = earlyOpeningFallback.derived.map((entry) => ({
              answer: entry.answer,
              thematic: finalFallbackThematicSet.has(entry.answer),
              hint: buildThematicClueRequestHint(
                theme,
                entry.answer,
                language,
                fallbackNotesByAnswer.get(entry.answer)
              ) ?? undefined,
              note: fallbackNotesByAnswer.get(entry.answer),
            }));
            const openingModelClues = await requestModelClues({
              client,
              theme,
              language,
              items: openingItems,
            });
            for (const [answer, clue] of openingModelClues) {
              clueByAnswer.set(answer, clue);
            }

            const openingEntries = pruneForbiddenPublishAnswersIfPossible(
              pruneMaskedDuplicateAnswers(
                repairPublishClues(
                  applyCluesAndOverrides(theme, language, earlyOpeningFallback.derived, clueByAnswer),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              ),
              minPublishEntriesForSize(n)
            );
            const openingQualityIssue = publishQualityIssue(
              openingEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );
            const openingCrossed = crossedEntryStats(
              earlyOpeningFallback.grid,
              openingEntries,
              minEntryLenForSize(n)
            );
            const openingEntryCrossings = entryCrossingStats(
              earlyOpeningFallback.grid,
              openingEntries,
              minEntryLenForSize(n)
            );
            const openingChecked = checkedCellStats(earlyOpeningFallback.grid, minEntryLenForSize(n));
            const openingDensity = crosswordDensityFromGrid(earlyOpeningFallback.grid);
            const openingThemeEntries = openingEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const openingCoreThematicEntries = openingEntries.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const openingGenericContextEntries = openingEntries.filter(
              (entry) => finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const openingMinThemeEntries = minThematicEntriesForPublish(n, openingEntries.length);
            const openingMinCoreEntries = minCoreThematicEntriesForPublish(n, openingEntries.length);
            const openingMaxGenericEntries = maxGenericContextEntriesForPublish(n, openingEntries.length);
            const openingPlaceholderCount = openingEntries.filter((entry) =>
              isPlaceholderClue(entry.clue, language)
            ).length;

            if (
              openingEntries.length >= minPublishEntriesForSize(n) &&
              openingCrossed.crossed >= openingEntries.length &&
              openingEntryCrossings.weakEntries.length === 0 &&
              openingDensity >= 0.4 &&
              openingChecked.ratio >= 0.25 &&
              openingThemeEntries >= openingMinThemeEntries &&
              openingCoreThematicEntries >= openingMinCoreEntries &&
              openingGenericContextEntries <= openingMaxGenericEntries &&
              openingPlaceholderCount === 0 &&
              !hasShortLetterRuns(earlyOpeningFallback.grid, minEntryLenForSize(n)) &&
              !openingQualityIssue
            ) {
              console.warn("[generate-crossword] FALLBACK -> early opening deterministic 11x11", {
                attempt: bestPartial.attempt,
                previousEntries: directFallbackPublishEntries.length,
                entries: openingEntries.length,
                thematicEntries: openingThemeEntries,
                coreThematicEntries: openingCoreThematicEntries,
                genericContextEntries: openingGenericContextEntries,
                density: openingDensity,
                checkedRatio: openingChecked.ratio,
                ...earlyOpeningFallback.meta,
              });

              return accepted(
                {
                  theme,
                  language,
                  size: n,
                  grid: earlyOpeningFallback.grid,
                  entries: openingEntries,
                  meta: {
                    source: "fallback-early-opening-deterministic-11",
                    attempt: best.attempt,
                    fallbackScore: best.fallbackScore,
                    previousEntries: directFallbackPublishEntries.length,
                    crossedEntries: openingCrossed.crossed,
                    checkedRatio: openingChecked.ratio,
                    thematicEntries: openingThemeEntries,
                    minThematicEntries: openingMinThemeEntries,
                    coreThematicEntries: openingCoreThematicEntries,
                    minCoreThematicEntries: openingMinCoreEntries,
                    genericContextEntries: openingGenericContextEntries,
                    density: openingDensity,
                    maxGenericContextEntries: openingMaxGenericEntries,
                    minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                    minEntryCheckedCells: openingEntryCrossings.minCheckedCells,
                    ...earlyOpeningFallback.meta,
                  },
                } satisfies Crossword
              );
            }

            console.warn("[generate-crossword] early opening deterministic rejected", {
              entries: openingEntries.length,
              answers: openingEntries.map((entry) => entry.answer),
              qualityIssue: openingQualityIssue,
              crossed: openingCrossed.crossed,
              weakEntries: openingEntryCrossings.weakEntries,
              density: openingDensity,
              checkedRatio: openingChecked.ratio,
              thematicEntries: openingThemeEntries,
              minThematicEntries: openingMinThemeEntries,
              coreThematicEntries: openingCoreThematicEntries,
              minCoreThematicEntries: openingMinCoreEntries,
              genericContextEntries: openingGenericContextEntries,
              maxGenericContextEntries: openingMaxGenericEntries,
              placeholderCount: openingPlaceholderCount,
              hasShortRuns: hasShortLetterRuns(earlyOpeningFallback.grid, minEntryLenForSize(n)),
              ...earlyOpeningFallback.meta,
            });
          }

          const lateValidatedLayout =
            allowModelRescueFor11 &&
            lateLayoutPoolByAnswer.size >= minPublishEntriesForSize(n) &&
            Date.now() < deadlineMs - 8_000
              ? await requestValidatedLayoutProposalWithDependencies({ dependencies: openAiRepairServicesDependencies,
                  client,
                  theme,
                  language,
                  size: n,
                  pool: Array.from(lateLayoutPoolByAnswer.values()),
                  themeSet: finalFallbackThematicSet,
                })
              : null;

          if (lateValidatedLayout) {
            const lateLayoutDerived = deriveEntriesFromGrid(
              lateValidatedLayout.grid,
              minEntryLenForSize(n)
            );
            const lateLayoutEntries = pruneForbiddenPublishAnswersIfPossible(
              pruneMaskedDuplicateAnswers(
                repairPublishClues(applyCluesAndOverrides(theme, language, lateLayoutDerived, clueByAnswer), {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                })
              ),
              minPublishEntriesForSize(n)
            );
            const lateLayoutEntryCrossings = entryCrossingStats(
              lateValidatedLayout.grid,
              lateLayoutEntries,
              minEntryLenForSize(n)
            );
            const lateLayoutCrossed = crossedEntryStats(
              lateValidatedLayout.grid,
              lateLayoutEntries,
              minEntryLenForSize(n)
            );
            const lateLayoutQualityIssue = publishQualityIssue(
              lateLayoutEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );
            const lateLayoutThemeEntries = lateLayoutEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const lateLayoutCoreEntries = lateLayoutEntries.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const lateLayoutGenericContextEntries = lateLayoutEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const lateLayoutMinThemeEntries = minThematicEntriesForPublish(n, lateLayoutEntries.length);
            const lateLayoutMinCoreEntries = minCoreThematicEntriesForPublish(n, lateLayoutEntries.length);
            const lateLayoutMaxGenericEntries = maxGenericContextEntriesForPublish(n, lateLayoutEntries.length);

            if (
              lateLayoutEntries.length >= minPublishEntriesForSize(n) &&
              lateLayoutCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              lateLayoutEntryCrossings.weakEntries.length === 0 &&
              lateLayoutThemeEntries >= lateLayoutMinThemeEntries &&
              lateLayoutCoreEntries >= lateLayoutMinCoreEntries &&
              lateLayoutGenericContextEntries <= lateLayoutMaxGenericEntries &&
              !hasShortLetterRuns(lateValidatedLayout.grid, minEntryLenForSize(n)) &&
              !lateLayoutQualityIssue
            ) {
              console.warn("[generate-crossword] FALLBACK -> late validated model layout", {
                attempt: bestPartial.attempt,
                previousEntries: directFallbackPublishEntries.length,
                layoutEntries: lateLayoutEntries.length,
                thematicEntries: lateLayoutThemeEntries,
                coreThematicEntries: lateLayoutCoreEntries,
                genericContextEntries: lateLayoutGenericContextEntries,
                builder: lateValidatedLayout.meta.builder,
              });

              return accepted(
                {
                  theme,
                  language,
                  size: n,
                  grid: lateValidatedLayout.grid,
                  entries: lateLayoutEntries,
                  meta: {
                    source: "fallback-late-validated-model-layout-11",
                    attempt: best.attempt,
                    previousEntries: directFallbackPublishEntries.length,
                    thematicEntries: lateLayoutThemeEntries,
                    minThematicEntries: lateLayoutMinThemeEntries,
                    coreThematicEntries: lateLayoutCoreEntries,
                    minCoreThematicEntries: lateLayoutMinCoreEntries,
                    genericContextEntries: lateLayoutGenericContextEntries,
                    maxGenericContextEntries: lateLayoutMaxGenericEntries,
                    crossedEntries: lateLayoutCrossed.crossed,
                    minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                    minEntryCheckedCells: lateLayoutEntryCrossings.minCheckedCells,
                    ...lateValidatedLayout.meta,
                  },
                } satisfies Crossword
              );
            }
          }

          const lateValidatedGrid =
            allowModelRescueFor11 &&
            lateLayoutPoolByAnswer.size >= minPublishEntriesForSize(n) &&
            Date.now() < deadlineMs - 8_000
              ? await requestValidatedGridProposalWithDependencies({ dependencies: openAiRepairServicesDependencies,
                  client,
                  theme,
                  language,
                  size: n,
                  pool: Array.from(lateLayoutPoolByAnswer.values()),
                  themeSet: finalFallbackThematicSet,
                })
              : null;

          if (lateValidatedGrid) {
            const lateGridDerived = deriveEntriesFromGrid(lateValidatedGrid.grid, minEntryLenForSize(n));
            const lateGridEntries = pruneForbiddenPublishAnswersIfPossible(
              pruneMaskedDuplicateAnswers(
                repairPublishClues(applyCluesAndOverrides(theme, language, lateGridDerived, clueByAnswer), {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                })
              ),
              minPublishEntriesForSize(n)
            );
            const lateGridEntryCrossings = entryCrossingStats(
              lateValidatedGrid.grid,
              lateGridEntries,
              minEntryLenForSize(n)
            );
            const lateGridCrossed = crossedEntryStats(
              lateValidatedGrid.grid,
              lateGridEntries,
              minEntryLenForSize(n)
            );
            const lateGridQualityIssue = publishQualityIssue(
              lateGridEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );
            const lateGridThemeEntries = lateGridEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const lateGridCoreEntries = lateGridEntries.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const lateGridGenericContextEntries = lateGridEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const lateGridMinThemeEntries = minThematicEntriesForPublish(n, lateGridEntries.length);
            const lateGridMinCoreEntries = minCoreThematicEntriesForPublish(n, lateGridEntries.length);
            const lateGridMaxGenericEntries = maxGenericContextEntriesForPublish(n, lateGridEntries.length);

            if (
              lateGridEntries.length >= minPublishEntriesForSize(n) &&
              lateGridCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              lateGridEntryCrossings.weakEntries.length === 0 &&
              lateGridThemeEntries >= lateGridMinThemeEntries &&
              lateGridCoreEntries >= lateGridMinCoreEntries &&
              lateGridGenericContextEntries <= lateGridMaxGenericEntries &&
              !hasShortLetterRuns(lateValidatedGrid.grid, minEntryLenForSize(n)) &&
              !lateGridQualityIssue
            ) {
              console.warn("[generate-crossword] FALLBACK -> late validated model grid", {
                attempt: bestPartial.attempt,
                previousEntries: directFallbackPublishEntries.length,
                gridEntries: lateGridEntries.length,
                thematicEntries: lateGridThemeEntries,
                coreThematicEntries: lateGridCoreEntries,
                genericContextEntries: lateGridGenericContextEntries,
                builder: lateValidatedGrid.meta.builder,
              });

              return accepted(
                {
                  theme,
                  language,
                  size: n,
                  grid: lateValidatedGrid.grid,
                  entries: lateGridEntries,
                  meta: {
                    source: "fallback-late-validated-model-grid-11",
                    attempt: best.attempt,
                    previousEntries: directFallbackPublishEntries.length,
                    thematicEntries: lateGridThemeEntries,
                    minThematicEntries: lateGridMinThemeEntries,
                    coreThematicEntries: lateGridCoreEntries,
                    minCoreThematicEntries: lateGridMinCoreEntries,
                    genericContextEntries: lateGridGenericContextEntries,
                    maxGenericContextEntries: lateGridMaxGenericEntries,
                    crossedEntries: lateGridCrossed.crossed,
                    minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                    minEntryCheckedCells: lateGridEntryCrossings.minCheckedCells,
                    ...lateValidatedGrid.meta,
                  },
                } satisfies Crossword
              );
            }
          }

          const cleanDegradedEntries = directFallbackPublishEntries.filter(
            (entry) => !isForbiddenPublishAnswer(entry.answer)
          );
          const cleanDegradedRebuild =
            cleanDegradedEntries.length >= 10
              ? rebuildGridFromEntries(
                  n,
                  cleanDegradedEntries.map((entry) => ({
                    number: entry.number,
                    row: entry.row,
                    col: entry.col,
                    direction: entry.direction,
                    answer: entry.answer,
                  })),
                  minEntryLenForSize(n)
                )
              : null;
          if (cleanDegradedRebuild && !hasShortLetterRuns(cleanDegradedRebuild.grid, minEntryLenForSize(n))) {
            const rebuiltKeyMap = new Map(
              cleanDegradedEntries.map((entry) => [
                `${entry.direction}:${entry.row}:${entry.col}:${entry.answer}`,
                entry,
              ])
            );
            const cleanDegradedResponseEntries = pruneMaskedDuplicateAnswers(
              repairPublishClues(
                cleanDegradedRebuild.derived.map((derived) => {
                  const key = `${derived.direction}:${derived.row}:${derived.col}:${derived.answer}`;
                  return rebuiltKeyMap.get(key) ?? { ...derived, clue: clueByAnswer.get(derived.answer) ?? "" };
                }),
                {
                  theme,
                  language,
                  thematicSet: finalFallbackThematicSet,
                  notesByAnswer: fallbackNotesByAnswer,
                }
              )
            );
            const cleanDegradedCrossed = crossedEntryStats(
              cleanDegradedRebuild.grid,
              cleanDegradedResponseEntries,
              minEntryLenForSize(n)
            );
            const cleanDegradedEntryCrossingStats = entryCrossingStats(
              cleanDegradedRebuild.grid,
              cleanDegradedResponseEntries,
              minEntryLenForSize(n)
            );
            const cleanDegradedThemeEntries = cleanDegradedResponseEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const cleanDegradedCoreThematicEntries = cleanDegradedResponseEntries.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const cleanDegradedMinCoreThematicEntries = minCoreThematicEntriesForPublish(
              n,
              cleanDegradedResponseEntries.length
            );
            const cleanDegradedGenericContextEntries = cleanDegradedResponseEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const cleanDegradedMaxGenericContextEntries = maxGenericContextEntriesForPublish(
              n,
              cleanDegradedResponseEntries.length
            );
            const cleanDegradedMinThemeEntries = minThematicEntriesForPublish(
              n,
              cleanDegradedResponseEntries.length
            );
            const cleanDegradedQuality = publishQualityIssue(
              cleanDegradedResponseEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );

            if (
              cleanDegradedResponseEntries.length >= minPublishEntriesForSize(n) &&
              cleanDegradedCrossed.crossed >= minCrossedEntriesForPublish(n) &&
              cleanDegradedEntryCrossingStats.weakEntries.length === 0 &&
              cleanDegradedThemeEntries >= cleanDegradedMinThemeEntries &&
              cleanDegradedCoreThematicEntries >= cleanDegradedMinCoreThematicEntries &&
              cleanDegradedGenericContextEntries <= cleanDegradedMaxGenericContextEntries &&
              !cleanDegradedQuality
            ) {
              return accepted(
                {
                  theme,
                  language,
                  size: n,
                  grid: cleanDegradedRebuild.grid,
                  entries: cleanDegradedResponseEntries,
                  meta: {
                    source: "fallback-clean-degraded-11",
                    attempt: best.attempt,
                    crossedEntries: cleanDegradedCrossed.crossed,
                    thematicEntries: cleanDegradedThemeEntries,
                    minThematicEntries: cleanDegradedMinThemeEntries,
                    coreThematicEntries: cleanDegradedCoreThematicEntries,
                    minCoreThematicEntries: cleanDegradedMinCoreThematicEntries,
                    genericContextEntries: cleanDegradedGenericContextEntries,
                    maxGenericContextEntries: cleanDegradedMaxGenericContextEntries,
                    minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                    minEntryCheckedCells: cleanDegradedEntryCrossingStats.minCheckedCells,
                    targetEntries: minPublishEntriesForSize(n),
                    degraded: true,
                    ...fallbackBuilt.meta,
                  },
                } satisfies Crossword
              );
            }
          }

          const openingFallback =
            n === 11
              ? runOpeningBuilder({ dependencies: openingBuilderDependencies,
                  theme,
                  candidates: fallbackPool,
                  seed: (fallbackStrictSeed ^ 0x7f4a7c15 ^ Math.imul(directFallbackPublishEntries.length + 1, 97)) >>> 0,
                  targetEntries: minPublishEntriesForSize(n),
                  deadlineMs: boundedFallbackDeadline(18_000),
                })
              : null;

          if (openingFallback) {
            const openingEntries = pruneForbiddenPublishAnswersIfPossible(
              pruneMaskedDuplicateAnswers(
                repairPublishClues(
                  applyCluesAndOverrides(theme, language, openingFallback.derived, clueByAnswer),
                  {
                    theme,
                    language,
                    thematicSet: finalFallbackThematicSet,
                    notesByAnswer: fallbackNotesByAnswer,
                  }
                )
              ),
              minPublishEntriesForSize(n)
            );
            const openingQualityIssue = publishQualityIssue(
              openingEntries,
              finalFallbackThematicSet,
              language,
              minPublishEntriesForSize(n)
            );
            const openingCrossed = crossedEntryStats(
              openingFallback.grid,
              openingEntries,
              minEntryLenForSize(n)
            );
            const openingEntryCrossings = entryCrossingStats(
              openingFallback.grid,
              openingEntries,
              minEntryLenForSize(n)
            );
            const openingChecked = checkedCellStats(openingFallback.grid, minEntryLenForSize(n));
            const openingDensity = crosswordDensityFromGrid(openingFallback.grid);
            const openingThemeEntries = openingEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer)
            ).length;
            const openingCoreThematicEntries = openingEntries.filter((entry) =>
              finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const openingGenericContextEntries = openingEntries.filter((entry) =>
              finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
            ).length;
            const openingMinThemeEntries = minThematicEntriesForPublish(n, openingEntries.length);
            const openingMinCoreEntries = minCoreThematicEntriesForPublish(n, openingEntries.length);
            const openingMaxGenericEntries = maxGenericContextEntriesForPublish(n, openingEntries.length);
            const openingPlaceholderCount = openingEntries.filter((entry) =>
              isPlaceholderClue(entry.clue, language)
            ).length;

            if (
              openingEntries.length >= minPublishEntriesForSize(n) &&
              openingCrossed.crossed >= openingEntries.length &&
              openingEntryCrossings.weakEntries.length === 0 &&
              openingDensity >= 0.4 &&
              openingChecked.ratio >= 0.25 &&
              openingThemeEntries >= openingMinThemeEntries &&
              openingCoreThematicEntries >= openingMinCoreEntries &&
              openingGenericContextEntries <= openingMaxGenericEntries &&
              openingPlaceholderCount === 0 &&
              !hasShortLetterRuns(openingFallback.grid, minEntryLenForSize(n)) &&
              !openingQualityIssue
            ) {
              console.warn("[generate-crossword] FALLBACK -> opening deterministic 11x11", {
                attempt: bestPartial.attempt,
                previousEntries: directFallbackPublishEntries.length,
                entries: openingEntries.length,
                thematicEntries: openingThemeEntries,
                coreThematicEntries: openingCoreThematicEntries,
                genericContextEntries: openingGenericContextEntries,
                density: openingDensity,
                checkedRatio: openingChecked.ratio,
                ...openingFallback.meta,
              });

              return accepted(
                {
                  theme,
                  language,
                  size: n,
                  grid: openingFallback.grid,
                  entries: openingEntries,
                  meta: {
                    source: "fallback-opening-deterministic-11",
                    attempt: best.attempt,
                    fallbackScore: best.fallbackScore,
                    previousEntries: directFallbackPublishEntries.length,
                    crossedEntries: openingCrossed.crossed,
                    checkedRatio: openingChecked.ratio,
                    thematicEntries: openingThemeEntries,
                    minThematicEntries: openingMinThemeEntries,
                    coreThematicEntries: openingCoreThematicEntries,
                    minCoreThematicEntries: openingMinCoreEntries,
                    genericContextEntries: openingGenericContextEntries,
                    density: openingDensity,
                    maxGenericContextEntries: openingMaxGenericEntries,
                    minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                    minEntryCheckedCells: openingEntryCrossings.minCheckedCells,
                    ...openingFallback.meta,
                  },
                } satisfies Crossword
              );
            }

            console.warn("[generate-crossword] opening deterministic rejected", {
              entries: openingEntries.length,
              answers: openingEntries.map((entry) => entry.answer),
              qualityIssue: openingQualityIssue,
              crossed: openingCrossed.crossed,
              weakEntries: openingEntryCrossings.weakEntries,
              density: openingDensity,
              checkedRatio: openingChecked.ratio,
              thematicEntries: openingThemeEntries,
              minThematicEntries: openingMinThemeEntries,
              coreThematicEntries: openingCoreThematicEntries,
              minCoreThematicEntries: openingMinCoreEntries,
              genericContextEntries: openingGenericContextEntries,
              maxGenericContextEntries: openingMaxGenericEntries,
              placeholderCount: openingPlaceholderCount,
              hasShortRuns: hasShortLetterRuns(openingFallback.grid, minEntryLenForSize(n)),
              ...openingFallback.meta,
            });
          } else {
            console.warn("[generate-crossword] opening deterministic unavailable", {
              candidatePool: fallbackPool.length,
              targetEntries: minPublishEntriesForSize(n),
            });
          }

          const directFallbackNearThreshold =
            n === 11 &&
            directFallbackPublishEntries.length >= Math.max(10, minPublishEntriesForSize(n) - 1) &&
            (!directFallbackQualityIssue || directFallbackQualityIssue === "too-few-entries") &&
            directFallbackThemeEntries >= minThematicEntriesForPublish(n, directFallbackPublishEntries.length) &&
            directFallbackCoreThematicEntries >= directFallbackMinCoreThematicEntries &&
            directFallbackGenericContextEntries <= directFallbackMaxGenericContextEntries &&
            directFallbackCrossedStats.crossed >= Math.max(6, directFallbackPublishEntries.length - 1) &&
            directFallbackEntryCrossingStats.weakEntries.length === 0 &&
            directFallbackPlaceholderCount === 0 &&
            !hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n));

          if (directFallbackNearThreshold) {
            console.warn("[generate-crossword] FALLBACK -> near-threshold clean 11x11", {
              entries: directFallbackPublishEntries.length,
              thematicEntries: directFallbackThemeEntries,
              coreThematicEntries: directFallbackCoreThematicEntries,
              genericContextEntries: directFallbackGenericContextEntries,
              checkedRatio: directFallbackCheckedStats.ratio,
            });

            return accepted(
              {
                theme,
                language,
                size: n,
                grid: directFallbackPublishGrid,
                entries: directFallbackPublishEntries,
                meta: {
                  source: "fallback-near-threshold-clean-11",
                  reason: "Published a clean 11x11 candidate one entry below target instead of returning 422.",
                  targetEntries: minPublishEntriesForSize(n),
                  entries: directFallbackPublishEntries.length,
                  thematicEntries: directFallbackThemeEntries,
                  minThematicEntries: minThematicEntriesForPublish(n, directFallbackPublishEntries.length),
                  coreThematicEntries: directFallbackCoreThematicEntries,
                  minCoreThematicEntries: directFallbackMinCoreThematicEntries,
                  genericContextEntries: directFallbackGenericContextEntries,
                  maxGenericContextEntries: directFallbackMaxGenericContextEntries,
                  crossedEntries: directFallbackCrossedStats.crossed,
                  checkedRatio: directFallbackCheckedStats.ratio,
                  minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                  minEntryCheckedCells: directFallbackEntryCrossingStats.minCheckedCells,
                  nearThreshold: true,
                  ...fallbackBuilt.meta,
                },
              } satisfies Crossword
            );
          }

          const directFallbackPlayableDegraded =
            n === 11 &&
            directFallbackPublishEntries.length >= minPublishEntriesForSize(n) &&
            directFallbackThemeEntries >= minThematicEntriesForPublish(n, directFallbackPublishEntries.length) &&
            directFallbackCoreThematicEntries >= directFallbackMinCoreThematicEntries &&
            directFallbackGenericContextEntries <= directFallbackMaxGenericContextEntries &&
            !directFallbackPublishEntries.some((entry) => isForbiddenPublishAnswer(entry.answer)) &&
            directFallbackUnsupportedEntries.length === 0 &&
            directFallbackCrossedStats.crossed >= Math.max(6, directFallbackPublishEntries.length - 1) &&
            directFallbackEntryCrossingStats.weakEntries.length === 0 &&
            directFallbackCheckedStats.ratio >= 0.25 &&
            !hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)) &&
            directFallbackPlaceholderCount === 0 &&
            !directFallbackQualityIssue;

          if (directFallbackPlayableDegraded) {
            console.warn("[generate-crossword] FALLBACK -> playable degraded 11x11", {
              entries: directFallbackPublishEntries.length,
              thematicEntries: directFallbackThemeEntries,
              coreThematicEntries: directFallbackCoreThematicEntries,
              genericContextEntries: directFallbackGenericContextEntries,
              weakEntries: directFallbackEntryCrossingStats.weakEntries,
              checkedRatio: directFallbackCheckedStats.ratio,
              qualityIssue: directFallbackQualityIssue,
              hasShortRuns: hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)),
            });

            return accepted(
              {
                theme,
                language,
                size: n,
                grid: directFallbackPublishGrid,
                entries: directFallbackPublishEntries,
                meta: {
                  source: "fallback-playable-degraded-11",
                  reason: "Published a playable 11x11 candidate instead of returning 422.",
                  targetEntries: minPublishEntriesForSize(n),
                  entries: directFallbackPublishEntries.length,
                  thematicEntries: directFallbackThemeEntries,
                  minThematicEntries: minThematicEntriesForPublish(n, directFallbackPublishEntries.length),
                  coreThematicEntries: directFallbackCoreThematicEntries,
                  minCoreThematicEntries: directFallbackMinCoreThematicEntries,
                  genericContextEntries: directFallbackGenericContextEntries,
                  maxGenericContextEntries: directFallbackMaxGenericContextEntries,
                  crossedEntries: directFallbackCrossedStats.crossed,
                  checkedRatio: directFallbackCheckedStats.ratio,
                  minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
                  minEntryCheckedCells: directFallbackEntryCrossingStats.minCheckedCells,
                  weakCrossingEntries: directFallbackEntryCrossingStats.weakEntries,
                  nearThreshold: true,
                  degraded: true,
                  qualityIssue: directFallbackQualityIssue,
                  hasShortRuns: hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)),
                  ...fallbackBuilt.meta,
                },
              } satisfies Crossword
            );
          }

          const noShortFallbackGrid = blockShortRunsOnly(
            directFallbackPublishGrid,
            minEntryLenForSize(n)
          );
          const noShortFallbackDerived = deriveEntriesFromGrid(
            noShortFallbackGrid,
            minEntryLenForSize(n)
          );
          const noShortFallbackAllowed = new Set(
            directFallbackPublishEntries.map((entry) => entry.answer)
          );
          const noShortFallbackEntries = repairPublishClues(
            applyCluesAndOverrides(
              theme,
              language,
              noShortFallbackDerived,
              clueByAnswer
            ).filter((entry) => noShortFallbackAllowed.has(entry.answer)),
            {
              theme,
              language,
              thematicSet: finalFallbackThematicSet,
              notesByAnswer: fallbackNotesByAnswer,
            }
          );
          const noShortFallbackUnsupported = noShortFallbackEntries.filter(
            (entry) =>
              !isPublishableAnswerForTheme({
                theme,
                answer: entry.answer,
                language,
                size: n,
                note: fallbackNotesByAnswer.get(entry.answer),
                allowContextualGeneric: finalFallbackThematicSet.has(entry.answer),
              })
          );
          const noShortFallbackQuality = publishQualityIssue(
            noShortFallbackEntries,
            finalFallbackThematicSet,
            language,
            minPublishEntriesForSize(n)
          );
          const noShortFallbackCrossed = crossedEntryStats(
            noShortFallbackGrid,
            noShortFallbackEntries,
            minEntryLenForSize(n)
          );
          const noShortFallbackEntryCrossings = entryCrossingStats(
            noShortFallbackGrid,
            noShortFallbackEntries,
            minEntryLenForSize(n)
          );
          const noShortFallbackChecked = checkedCellStats(
            noShortFallbackGrid,
            minEntryLenForSize(n)
          );
          const noShortFallbackThemeEntries = noShortFallbackEntries.filter((entry) =>
            finalFallbackThematicSet.has(entry.answer)
          ).length;
          const noShortFallbackCoreEntries = noShortFallbackEntries.filter((entry) =>
            finalFallbackCoreThematicSet.has(entry.answer)
          ).length;
          const noShortFallbackGenericContextEntries = noShortFallbackEntries.filter(
            (entry) => finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
          ).length;

          if (
            n === 11 &&
            noShortFallbackEntries.length >= minPublishEntriesForSize(n) &&
            !hasShortLetterRuns(noShortFallbackGrid, minEntryLenForSize(n)) &&
            noShortFallbackUnsupported.length === 0 &&
            noShortFallbackCrossed.crossed >= Math.max(6, noShortFallbackEntries.length - 1) &&
            noShortFallbackEntryCrossings.weakEntries.length === 0 &&
            noShortFallbackChecked.ratio >= 0.25 &&
            noShortFallbackThemeEntries >= minThematicEntriesForPublish(n, noShortFallbackEntries.length) &&
            noShortFallbackCoreEntries >= minCoreThematicEntriesForPublish(n, noShortFallbackEntries.length) &&
            noShortFallbackGenericContextEntries <= maxGenericContextEntriesForPublish(n, noShortFallbackEntries.length) &&
            !noShortFallbackQuality
          ) {
            console.warn("[generate-crossword] FALLBACK -> no-short-run repaired 11x11", {
              entries: noShortFallbackEntries.length,
              thematicEntries: noShortFallbackThemeEntries,
              coreThematicEntries: noShortFallbackCoreEntries,
              genericContextEntries: noShortFallbackGenericContextEntries,
              weakEntries: noShortFallbackEntryCrossings.weakEntries,
              checkedRatio: noShortFallbackChecked.ratio,
            });

            return accepted(
              {
                theme,
                language,
                size: n,
                grid: noShortFallbackGrid,
                entries: noShortFallbackEntries,
                meta: {
                  source: "fallback-no-short-run-repaired-11",
                  reason: "Removed invalid short letter runs before publishing.",
                  targetEntries: minPublishEntriesForSize(n),
                  entries: noShortFallbackEntries.length,
                  thematicEntries: noShortFallbackThemeEntries,
                  coreThematicEntries: noShortFallbackCoreEntries,
                  genericContextEntries: noShortFallbackGenericContextEntries,
                  crossedEntries: noShortFallbackCrossed.crossed,
                  checkedRatio: noShortFallbackChecked.ratio,
                  minEntryCheckedCells: noShortFallbackEntryCrossings.minCheckedCells,
                  weakCrossingEntries: noShortFallbackEntryCrossings.weakEntries,
                  repairedShortRuns: true,
                  nearThreshold: true,
                  ...fallbackBuilt.meta,
                },
              } satisfies Crossword
            );
          }

          if (n === 11 && noShortFallbackEntries.length >= minPublishEntriesForSize(n) - 2) {
            const lastChanceDensified = densifyCleanGrid11WithDependencies({ dependencies: gridEnhancementDependencies,
              theme,
              grid: noShortFallbackGrid,
              candidates: fallbackPool,
              targetEntries: minPublishEntriesForSize(n),
              seed: (fallbackStrictSeed ^ 0xd1b54a35 ^ Math.imul(noShortFallbackEntries.length + 1, 193)) >>> 0,
              deadlineMs: boundedFallbackDeadline(16_000),
            });

            if (lastChanceDensified) {
              const lastChanceEntries = pruneForbiddenPublishAnswersIfPossible(
                pruneMaskedDuplicateAnswers(
                  repairPublishClues(
                    applyCluesAndOverrides(theme, language, lastChanceDensified.derived, clueByAnswer),
                    {
                      theme,
                      language,
                      thematicSet: finalFallbackThematicSet,
                      notesByAnswer: fallbackNotesByAnswer,
                    }
                  )
                ),
                minPublishEntriesForSize(n)
              ).filter((entry) =>
                isPublishableAnswerForTheme({
                  theme,
                  answer: entry.answer,
                  language,
                  size: n,
                  note: fallbackNotesByAnswer.get(entry.answer),
                  allowContextualGeneric: finalFallbackThematicSet.has(entry.answer),
                })
              );
              const lastChanceQuality = publishQualityIssue(
                lastChanceEntries,
                finalFallbackThematicSet,
                language,
                minPublishEntriesForSize(n)
              );
              const lastChanceEntryCrossings = entryCrossingStats(
                lastChanceDensified.grid,
                lastChanceEntries,
                minEntryLenForSize(n)
              );
              const lastChanceChecked = checkedCellStats(
                lastChanceDensified.grid,
                minEntryLenForSize(n)
              );
              const lastChanceCrossed = crossedEntryStats(
                lastChanceDensified.grid,
                lastChanceEntries,
                minEntryLenForSize(n)
              );
              const lastChanceThemeEntries = lastChanceEntries.filter((entry) =>
                finalFallbackThematicSet.has(entry.answer)
              ).length;
              const lastChanceCoreEntries = lastChanceEntries.filter((entry) =>
                finalFallbackCoreThematicSet.has(entry.answer)
              ).length;
              const lastChanceGenericContextEntries = lastChanceEntries.filter(
                (entry) => finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
              ).length;

              if (
                lastChanceEntries.length >= minPublishEntriesForSize(n) &&
                lastChanceCrossed.crossed >= minCrossedEntriesForPublish(n) &&
                lastChanceEntryCrossings.weakEntries.length === 0 &&
                lastChanceChecked.ratio >= 0.25 &&
                lastChanceThemeEntries >= minThematicEntriesForPublish(n, lastChanceEntries.length) &&
                lastChanceCoreEntries >= minCoreThematicEntriesForPublish(n, lastChanceEntries.length) &&
                lastChanceGenericContextEntries <= maxGenericContextEntriesForPublish(n, lastChanceEntries.length) &&
                !hasShortLetterRuns(lastChanceDensified.grid, minEntryLenForSize(n)) &&
                !lastChanceQuality
              ) {
                console.warn("[generate-crossword] FALLBACK -> last-chance weak repair 11x11", {
                  entries: lastChanceEntries.length,
                  thematicEntries: lastChanceThemeEntries,
                  coreThematicEntries: lastChanceCoreEntries,
                  genericContextEntries: lastChanceGenericContextEntries,
                  weakEntries: lastChanceEntryCrossings.weakEntries,
                  checkedRatio: lastChanceChecked.ratio,
                  added: lastChanceDensified.added,
                });

                return accepted(
                  {
                    theme,
                    language,
                    size: n,
                    grid: lastChanceDensified.grid,
                    entries: lastChanceEntries,
                    meta: {
                      source: "fallback-last-chance-weak-repair-11",
                      reason: "Pruned weak entries and densified before returning 422.",
                      targetEntries: minPublishEntriesForSize(n),
                      entries: lastChanceEntries.length,
                      thematicEntries: lastChanceThemeEntries,
                      coreThematicEntries: lastChanceCoreEntries,
                      genericContextEntries: lastChanceGenericContextEntries,
                      crossedEntries: lastChanceCrossed.crossed,
                      checkedRatio: lastChanceChecked.ratio,
                      minEntryCheckedCells: lastChanceEntryCrossings.minCheckedCells,
                      weakCrossingEntries: lastChanceEntryCrossings.weakEntries,
                      repairedWeakEntries: true,
                      added: lastChanceDensified.added,
                      ...fallbackBuilt.meta,
                    },
                  } satisfies Crossword
                );
              }

              console.warn("[generate-crossword] last-chance weak repair rejected", {
                entries: lastChanceEntries.length,
                thematicEntries: lastChanceThemeEntries,
                coreThematicEntries: lastChanceCoreEntries,
                genericContextEntries: lastChanceGenericContextEntries,
                weakEntries: lastChanceEntryCrossings.weakEntries,
                checkedRatio: lastChanceChecked.ratio,
                qualityIssue: lastChanceQuality,
                hasShortRuns: hasShortLetterRuns(lastChanceDensified.grid, minEntryLenForSize(n)),
                added: lastChanceDensified.added,
                answers: lastChanceEntries.map((entry) => entry.answer),
              });
            }
          }

          return failed(
            {
              source: "generation-error",
              reason: "No se pudo reconstruir un 11x11 completamente chequeado.",
              finalEntries: directFallbackPublishEntries.length,
              finalThematicEntries: directFallbackThemeEntries,
              finalCrossedEntries: directFallbackCrossedStats.crossed,
              minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
              weakCrossingEntries: directFallbackEntryCrossingStats.weakEntries,
              finalCheckedRatio: directFallbackCheckedStats.ratio,
              finalPlaceholderCount: directFallbackPlaceholderCount,
              finalQualityIssue: directFallbackQualityIssue,
              finalUnsupportedAnswers: directFallbackUnsupportedEntries.map((entry) => entry.answer),
              finalHasShortRuns: hasShortLetterRuns(directFallbackPublishGrid, minEntryLenForSize(n)),
              finalAnswers: directFallbackPublishEntries.map((entry) => entry.answer),
              lastAnswerStats,
              lastBuildIssue,
              lastPoolSample: lastAttemptPool.slice(0, 40).map((candidate) => ({
                answer: candidate.answer,
                source: candidate.source,
                thematic: candidate.thematic,
              })),
            },
        "unprocessable"
      );
        }

        const placeholderCount = checkedFallbackForResponse.entries.filter((e) =>
          isPlaceholderClue(e.clue, language)
        ).length;
        const repairedCheckedFallbackEntriesRaw = pruneForbiddenPublishAnswersIfPossible(
          pruneMaskedDuplicateAnswers(
            repairPublishClues(checkedFallbackForResponse.entries, {
              theme,
              language,
              thematicSet: broadPublishableFallbackAnswerSet,
              notesByAnswer: fallbackNotesByAnswer,
            })
          ),
          minPublishEntriesForSize(n)
        );
        const repairedCheckedFallbackEntries = repairedCheckedFallbackEntriesRaw.filter((entry) =>
          isPublishableAnswerForTheme({
            theme,
            answer: entry.answer,
            language,
            size: n,
            note: fallbackNotesByAnswer.get(entry.answer),
            allowContextualGeneric: broadPublishableFallbackAnswerSet.has(entry.answer),
          })
        );
        const checkedFallbackQualityIssue = publishQualityIssue(
          repairedCheckedFallbackEntries,
          broadPublishableFallbackAnswerSet,
          language,
          minPublishEntriesForSize(n)
        );
        const checkedStats = checkedCellStats(
          checkedFallbackForResponse.grid,
          minEntryLenForSize(n)
        );
        const checkedEntryCrossingStats = entryCrossingStats(
          checkedFallbackForResponse.grid,
          repairedCheckedFallbackEntries,
          minEntryLenForSize(n)
        );
        const checkedThemeEntries = repairedCheckedFallbackEntries.filter((entry) =>
          broadPublishableFallbackAnswerSet.has(entry.answer)
        ).length;
        const checkedCoreThematicEntries = repairedCheckedFallbackEntries.filter((entry) =>
          finalFallbackCoreThematicSet.has(entry.answer)
        ).length;
        const checkedMinCoreThematicEntries = minCoreThematicEntriesForPublish(
          n,
          repairedCheckedFallbackEntries.length
        );
        const checkedGenericContextEntries = repairedCheckedFallbackEntries.filter((entry) =>
          broadPublishableFallbackAnswerSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
        ).length;
        const checkedMaxGenericContextEntries = maxGenericContextEntriesForPublish(
          n,
          repairedCheckedFallbackEntries.length
        );
        const checkedMinThemeEntries = minThematicEntriesForPublish(
          n,
          repairedCheckedFallbackEntries.length
        );

        if (
          hasShortLetterRuns(checkedFallbackForResponse.grid, minEntryLenForSize(n)) ||
          checkedFallbackQualityIssue ||
          (n === 11 &&
            (repairedCheckedFallbackEntries.length < minPublishEntriesForSize(n) ||
              checkedThemeEntries < checkedMinThemeEntries ||
              checkedCoreThematicEntries < checkedMinCoreThematicEntries ||
              checkedGenericContextEntries > checkedMaxGenericContextEntries ||
              checkedEntryCrossingStats.weakEntries.length > 0))
        ) {
          return failed(
            {
              source: "generation-error",
              reason:
                checkedFallbackQualityIssue ??
                (checkedCoreThematicEntries < checkedMinCoreThematicEntries
                  ? "La grilla final no alcanzo suficientes entradas tematicas reales."
                  : "La grilla final contenia secuencias demasiado cortas."),
              finalEntries: repairedCheckedFallbackEntries.length,
              finalThematicEntries: checkedThemeEntries,
              minThematicEntries: checkedMinThemeEntries,
              finalCoreThematicEntries: checkedCoreThematicEntries,
              minCoreThematicEntries: checkedMinCoreThematicEntries,
              finalGenericContextEntries: checkedGenericContextEntries,
              maxGenericContextEntries: checkedMaxGenericContextEntries,
              minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
              weakCrossingEntries: checkedEntryCrossingStats.weakEntries,
            },
        "unprocessable"
      );
        }

        console.warn("[generate-crossword] FALLBACK -> bestPartial fully checked", {
          attempt: bestPartial.attempt,
          entries: checkedFallbackForResponse.entries.length,
          usedAnswers: fallbackBuilt.usedAnswers.length,
          checkedRatio: checkedStats.ratio,
          thematicEntries: checkedThemeEntries,
          coreThematicEntries: checkedCoreThematicEntries,
          genericContextEntries: checkedGenericContextEntries,
          fallbackScore: bestPartial.fallbackScore,
          placeholderCount,
          builder: fallbackBuilt.meta?.builder ?? null,
        });

        return accepted(
          {
            theme,
            language,
            size: n,
            grid: checkedFallbackForResponse.grid,
            entries: repairedCheckedFallbackEntries,
            meta: {
              source: "fallback-best-built-fully-checked",
              attempt: best.attempt,
              fallbackScore: best.fallbackScore,
              checkedRatio: checkedStats.ratio,
              thematicEntries: checkedThemeEntries,
              minThematicEntries: checkedMinThemeEntries,
              coreThematicEntries: checkedCoreThematicEntries,
              minCoreThematicEntries: checkedMinCoreThematicEntries,
              genericContextEntries: checkedGenericContextEntries,
              maxGenericContextEntries: checkedMaxGenericContextEntries,
              minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
              minEntryCheckedCells: checkedEntryCrossingStats.minCheckedCells,
              placeholderCount,
              ...fallbackBuilt.meta,
            },
          } satisfies Crossword
        );
      }

      const fallbackEntriesForResponse =
        n === 11 && fullyCheckedFallback && fullyCheckedFallback.entries.length >= 6
          ? fullyCheckedFallback.entries
          : n === 11 && sanitizedFullyCheckedFallback && sanitizedFullyCheckedFallback.entries.length >= 4
          ? sanitizedFullyCheckedFallback.entries
          : n === 11 && exactFullyCheckedFallback && exactFullyCheckedFallback.entries.length >= 4
          ? exactFullyCheckedFallback.entries
          : n === 11 && exactPublishableFallback && exactPublishableFallback.entries.length >= 3
          ? exactPublishableFallback.entries
          : n === 11 && cluedExactPublishableFallback && cluedExactPublishableFallback.entries.length >= 2
          ? cluedExactPublishableFallback.entries
          : n === 11 && minimalExactPublishableFallback && minimalExactPublishableFallback.entries.length >= 2
          ? minimalExactPublishableFallback.entries
          : n === 11 && playableFallback && playableFallback.entries.length >= 3
          ? playableFallback.entries
          : entries;
      const fallbackGridForResponse =
        n === 11 && fullyCheckedFallback && fullyCheckedFallback.entries.length >= 6
          ? fullyCheckedFallback.grid
          : n === 11 && sanitizedFullyCheckedFallback && sanitizedFullyCheckedFallback.entries.length >= 4
          ? sanitizedFullyCheckedFallback.grid
          : n === 11 && exactFullyCheckedFallback && exactFullyCheckedFallback.entries.length >= 4
          ? exactFullyCheckedFallback.grid
          : n === 11 && exactPublishableFallback && exactPublishableFallback.entries.length >= 3
          ? exactPublishableFallback.grid
          : n === 11 && cluedExactPublishableFallback && cluedExactPublishableFallback.entries.length >= 2
          ? cluedExactPublishableFallback.grid
          : n === 11 && minimalExactPublishableFallback && minimalExactPublishableFallback.entries.length >= 2
          ? minimalExactPublishableFallback.grid
          : n === 11 && playableFallback && playableFallback.entries.length >= 3
          ? playableFallback.grid
          : finalFallbackGridForResponse;
      const repairedFallbackEntriesForResponseRaw = pruneForbiddenPublishAnswersIfPossible(
        pruneMaskedDuplicateAnswers(
          repairPublishClues(fallbackEntriesForResponse, {
            theme,
            language,
            thematicSet: finalFallbackThematicSet,
            notesByAnswer: fallbackNotesByAnswer,
          })
        ),
        minPublishEntriesForSize(n)
      );
      const repairedFallbackEntriesForResponse = repairedFallbackEntriesForResponseRaw.filter((entry) =>
        isPublishableAnswerForTheme({
          theme,
          answer: entry.answer,
          language,
          size: n,
          note: fallbackNotesByAnswer.get(entry.answer),
          allowContextualGeneric: finalFallbackThematicSet.has(entry.answer),
        })
      );
      const placeholderCount = repairedFallbackEntriesForResponse.filter((e) =>
        isPlaceholderClue(e.clue, language)
      ).length;
      const checkedStats = checkedCellStats(fallbackGridForResponse, minEntryLenForSize(n));
      const fallbackEntryCrossingStats = entryCrossingStats(
        fallbackGridForResponse,
        repairedFallbackEntriesForResponse,
        minEntryLenForSize(n)
      );
      const fallbackThemeEntries = repairedFallbackEntriesForResponse.filter((entry) =>
        finalFallbackThematicSet.has(entry.answer)
      ).length;
      const fallbackCoreThematicEntries = repairedFallbackEntriesForResponse.filter((entry) =>
        finalFallbackCoreThematicSet.has(entry.answer)
      ).length;
      const fallbackMinCoreThematicEntries = minCoreThematicEntriesForPublish(
        n,
        repairedFallbackEntriesForResponse.length
      );
      const fallbackGenericContextEntries = repairedFallbackEntriesForResponse.filter((entry) =>
        finalFallbackThematicSet.has(entry.answer) && !finalFallbackCoreThematicSet.has(entry.answer)
      ).length;
      const fallbackMaxGenericContextEntries = maxGenericContextEntriesForPublish(
        n,
        repairedFallbackEntriesForResponse.length
      );
      const fallbackMinThemeEntries = minThematicEntriesForPublish(
        n,
        repairedFallbackEntriesForResponse.length
      );
      const fallbackQualityIssue = publishQualityIssue(
        repairedFallbackEntriesForResponse,
        finalFallbackThematicSet,
        language,
        minPublishEntriesForSize(n)
      );
      const fallbackStructurallyPublishable =
        n === 11 &&
        repairedFallbackEntriesForResponse.length >= minPublishEntriesForSize(n) &&
        fallbackThemeEntries >= fallbackMinThemeEntries &&
        placeholderCount === 0 &&
        fallbackEntryCrossingStats.weakEntries.length === 0 &&
        !hasShortLetterRuns(fallbackGridForResponse, minEntryLenForSize(n)) &&
        !fallbackQualityIssue;
      const allowRelaxedCoreFallback = process.env.ALLOW_RELAXED_CORE_11 === "1";
      const fallbackNearCoreEnough =
        fallbackCoreThematicEntries >= fallbackMinCoreThematicEntries &&
        fallbackGenericContextEntries <= fallbackMaxGenericContextEntries;

      if (
        n === 11 &&
        (repairedFallbackEntriesForResponse.length < minPublishEntriesForSize(n) ||
          fallbackThemeEntries < fallbackMinThemeEntries ||
          fallbackCoreThematicEntries < fallbackMinCoreThematicEntries ||
          fallbackGenericContextEntries > fallbackMaxGenericContextEntries ||
          fallbackEntryCrossingStats.weakEntries.length > 0 ||
          placeholderCount > 0 ||
          hasShortLetterRuns(fallbackGridForResponse, minEntryLenForSize(n)) ||
          fallbackQualityIssue)
      ) {
        if (allowRelaxedCoreFallback && fallbackStructurallyPublishable && fallbackNearCoreEnough) {
          console.warn("[generate-crossword] FALLBACK -> relaxed core gate", {
            attempt: bestPartial.attempt,
            entries: repairedFallbackEntriesForResponse.length,
            thematicEntries: fallbackThemeEntries,
            coreThematicEntries: fallbackCoreThematicEntries,
            minCoreThematicEntries: fallbackMinCoreThematicEntries,
            genericContextEntries: fallbackGenericContextEntries,
            maxGenericContextEntries: fallbackMaxGenericContextEntries,
            checkedRatio: checkedStats.ratio,
            builder: fallbackBuilt.meta?.builder ?? null,
          });

          return accepted(
            {
              theme,
              language,
              size: n,
              grid: fallbackGridForResponse,
              entries: repairedFallbackEntriesForResponse,
              meta: {
                source: "fallback-best-built-relaxed-core",
                attempt: best.attempt,
                fallbackScore: best.fallbackScore,
                checkedRatio: checkedStats.ratio,
                thematicEntries: fallbackThemeEntries,
                minThematicEntries: fallbackMinThemeEntries,
                coreThematicEntries: fallbackCoreThematicEntries,
                minCoreThematicEntries: fallbackMinCoreThematicEntries,
                genericContextEntries: fallbackGenericContextEntries,
                maxGenericContextEntries: fallbackMaxGenericContextEntries,
                placeholderCount,
                relaxedCoreGate: true,
                ...fallbackBuilt.meta,
              },
            } satisfies Crossword
          );
        }

        return failed(
          {
            source: "generation-error",
            reason:
              fallbackQualityIssue ??
              (fallbackCoreThematicEntries < fallbackMinCoreThematicEntries
                ? "La grilla final no alcanzo suficientes entradas tematicas reales."
                : "No se pudo reconstruir un 11x11 completamente chequeado."),
            finalEntries: repairedFallbackEntriesForResponse.length,
            finalThematicEntries: fallbackThemeEntries,
            minThematicEntries: fallbackMinThemeEntries,
            finalCoreThematicEntries: fallbackCoreThematicEntries,
            minCoreThematicEntries: fallbackMinCoreThematicEntries,
            finalGenericContextEntries: fallbackGenericContextEntries,
            maxGenericContextEntries: fallbackMaxGenericContextEntries,
            minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
            weakCrossingEntries: fallbackEntryCrossingStats.weakEntries,
            finalPlaceholderCount: placeholderCount,
            finalHasShortRuns: hasShortLetterRuns(fallbackGridForResponse, minEntryLenForSize(n)),
            finalQualityIssue: fallbackQualityIssue,
          },
        "unprocessable"
      );
      }

      console.warn("[generate-crossword] FALLBACK -> bestPartial", {
        attempt: bestPartial.attempt,
        entries: repairedFallbackEntriesForResponse.length,
        usedAnswers: fallbackBuilt.usedAnswers.length,
        checkedRatio: checkedStats.ratio,
        thematicEntries: fallbackThemeEntries,
        coreThematicEntries: fallbackCoreThematicEntries,
        genericContextEntries: fallbackGenericContextEntries,
        fallbackScore: bestPartial.fallbackScore,
        placeholderCount,
        builder: fallbackBuilt.meta?.builder ?? null,
      });

      return accepted(
        {
          theme,
          language,
          size: n,
          grid: fallbackGridForResponse,
          entries: repairedFallbackEntriesForResponse,
          meta: {
            source: "fallback-best-built",
            attempt: best.attempt,
            fallbackScore: best.fallbackScore,
            checkedRatio: checkedStats.ratio,
            thematicEntries: fallbackThemeEntries,
            minThematicEntries: fallbackMinThemeEntries,
            coreThematicEntries: fallbackCoreThematicEntries,
            minCoreThematicEntries: fallbackMinCoreThematicEntries,
            genericContextEntries: fallbackGenericContextEntries,
            maxGenericContextEntries: fallbackMaxGenericContextEntries,
            minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
            minEntryCheckedCells: fallbackEntryCrossingStats.minCheckedCells,
            placeholderCount,
            ...fallbackBuilt.meta,
          },
        } satisfies Crossword
      );
    }

    if (lastAttemptPool.length === 0 && lastModelError) {
      return failed(
        {
          source: "openai-error",
          reason: "No se pudo obtener el banco inicial de respuestas tematicas desde OpenAI.",
          lastModelError,
          lastAnswerbankIssue,
        },
        "service-unavailable"
      );
    }

    if (n === 11) {
      return failed(
        {
          source: "generation-error",
          reason: "No 11x11 candidate reached the publication threshold.",
          minEntries: minPublishEntriesForSize(n),
          lastAttemptPool: lastAttemptPool.length,
          lastModelError,
          lastAnswerbankIssue,
          lastBuildIssue,
          lastAnswerStats,
        },
        "unprocessable"
      );
    }

    return failed(
      {
        source: "generation-error",
        reason: "No se pudo generar un crucigrama aceptable.",
        minEntries: minPublishEntriesForSize(n),
        lastModelError,
        lastAnswerbankIssue,
        lastBuildIssue,
        lastAnswerStats,
      },
        "unprocessable"
      );
  } catch (err: unknown) {
    return failed(
      {
        source: "generation-error",
        reason: err instanceof Error ? err.message : "unknown error",
      },
      "internal"
    );
  }
}
