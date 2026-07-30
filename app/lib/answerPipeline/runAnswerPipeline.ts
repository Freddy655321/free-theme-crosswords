import type { RawAnswerBank } from "@/app/lib/crosswordTypes";
import {
  createCspBankAuditReport,
  cspBankAuditCandidateDistribution,
  cspBankAuditRejectedBySet,
} from "./answerBankAudit";
import {
  applyValidatedAnswersToCleanBank,
  buildPrePoolAnswerBankState,
  buildThematicKeepSet,
  mergeExpandedAnswers,
} from "./mergeAnswerBank";
import { parseUsableAnswerBankText } from "./parseAnswerBank";
import { sanitizeInitialAnswerBank } from "./sanitizeAnswers";
import type {
  RunAnswerPipelineInput,
  RunAnswerPipelineResult,
} from "./answerPipelineTypes";

export async function runAnswerPipeline(input: RunAnswerPipelineInput): Promise<RunAnswerPipelineResult> {
  const {
    answerbankTextResult,
    theme,
    language,
    size,
    attempt,
    deadlineMs,
    targetAnswers,
    enableSemanticSupport11,
    fillerWords,
    policies,
    dependencies,
  } = input;
  const rawAnswersText = answerbankTextResult.text;

  dependencies.warn("[generate-crossword] answerbank raw", {
    attempt,
    model: answerbankTextResult.model,
    finish_reason: answerbankTextResult.finishReason,
    usedWebSearch: answerbankTextResult.usedWebSearch,
    rawText_len: rawAnswersText.length,
    rawText_head: rawAnswersText.slice(0, 250),
    rawText_tail: rawAnswersText.slice(-200),
  });

  const { usableParsedAnswers } = parseUsableAnswerBankText(rawAnswersText);

  if (!usableParsedAnswers || !Array.isArray(usableParsedAnswers.answers)) {
    const issue = `answerbank parse failed; chars=${rawAnswersText.length}; finish=${answerbankTextResult.finishReason ?? "unknown"}`;
    dependencies.warn("[generate-crossword] skip: answerbank parse failed", { attempt });
    return {
      status: "skip",
      reason: "answerbank-parse-failed",
      issue,
    };
  }

  const cspBankAuditReport = createCspBankAuditReport(theme, language, size);
  cspBankAuditReport.initialRawCount = usableParsedAnswers.answers.length;
  dependencies.recordAuditDistribution(
    cspBankAuditReport,
    "raw-openai-answers",
    usableParsedAnswers.answers.map((answer) => String(answer ?? ""))
  );

  const {
    notesByAnswer,
    rawNormalizedAnswers,
    cleanAnswers,
  } = sanitizeInitialAnswerBank({
    parsedBank: usableParsedAnswers,
    theme,
    language,
    size,
    report: cspBankAuditReport,
    policies,
    recordDistribution: dependencies.recordAuditDistribution,
  });

  mergeExpandedAnswers({
    target: cleanAnswers,
    source: rawNormalizedAnswers,
    size,
    expandAnswers: dependencies.expandGeographicCompoundAnswers,
    acceptExpanded: (answer) => {
      if (!policies.answerLanguageLooksValidForPuzzle(answer, language)) return false;
      if (policies.isLikelyBadAnswer(answer) && !policies.alwaysAllowAnswers.has(answer)) return false;
      return true;
    },
  });

  const topUpTarget =
    size === 11
      ? Math.max(cleanAnswers.length, 90)
      : targetAnswers;
  const topUpRounds =
    size === 11
      ? 0
      : cleanAnswers.length < 40
        ? 1
        : 0;
  for (let t = 0; t < topUpRounds && cleanAnswers.length < topUpTarget; t++) {
    const need = Math.min(size === 11 ? 45 : 18, topUpTarget - cleanAnswers.length);
    const more = await dependencies.topUpAnswers({
      existing: cleanAnswers,
      need,
    });

    for (const answer of more) {
      if (cleanAnswers.length >= topUpTarget) break;
      if (!cleanAnswers.includes(answer)) {
        cleanAnswers.push(answer);
      }
    }
  }

  mergeExpandedAnswers({
    target: cleanAnswers,
    source: cleanAnswers,
    size,
    expandAnswers: dependencies.expandGeographicCompoundAnswers,
  });
  dependencies.recordAuditDistribution(cspBankAuditReport, "after-general-topups", cleanAnswers);

  const minClean = size === 9 ? 16 : size === 11 ? dependencies.minPublishEntriesForSize(size) : 26;

  let validated: string[];
  const structuredTrustedSet = new Set(answerbankTextResult.trustedAnswers ?? []);
  if (size === 11) {
    try {
      dependencies.recordAuditDistribution(cspBankAuditReport, "sent-to-validateThematicAnswers", cleanAnswers);
      const modelValidated = await dependencies.validateThematicAnswers({ answers: cleanAnswers });
      cspBankAuditRejectedBySet(
        cspBankAuditReport,
        "validateThematicAnswers",
        cleanAnswers,
        modelValidated,
        "failed-thematic-validation"
      );
      validated = modelValidated.filter((answer) =>
        policies.isPublishableAnswerForTheme({
          theme,
          answer,
          language,
          size,
          note: notesByAnswer.get(answer),
          allowContextualGeneric: false,
        })
      );
      cspBankAuditRejectedBySet(
        cspBankAuditReport,
        "post-thematic-publishable-filter",
        modelValidated,
        validated,
        "likely-bad-answer"
      );
    } catch (error: unknown) {
      dependencies.warn("[generate-crossword] validate failed; falling back to local theme filter", {
        attempt,
        name: error instanceof Error ? error.name : "unknown",
        msg: error instanceof Error ? error.message : String(error),
      });
      validated = cleanAnswers.filter((answer) => {
        if (
          !policies.isPublishableAnswerForTheme({
            theme,
            answer,
            language,
            size,
            note: notesByAnswer.get(answer),
            allowContextualGeneric: false,
          })
        ) {
          return false;
        }
        if (policies.isForbiddenPublishAnswer(answer)) return false;
        if (policies.isOverGenericThemeWordForTheme(theme, answer)) return false;
        const note = notesByAnswer.get(answer);
        const usefulNote = Boolean(
          note && note.trim().length >= 8 && !policies.noteLooksWeakThematicContext(note, language)
        );
        return usefulNote || policies.isThemeCoreWord(theme, answer);
      });
      cspBankAuditRejectedBySet(
        cspBankAuditReport,
        "validateThematicAnswers",
        cleanAnswers,
        validated,
        "other"
      );
    }
  } else {
    try {
      dependencies.recordAuditDistribution(cspBankAuditReport, "sent-to-validateThematicAnswers", cleanAnswers);
      validated = await dependencies.validateThematicAnswers({ answers: cleanAnswers });
      cspBankAuditRejectedBySet(
        cspBankAuditReport,
        "validateThematicAnswers",
        cleanAnswers,
        validated,
        "failed-thematic-validation"
      );
    } catch (error: unknown) {
      dependencies.warn("[generate-crossword] validate failed; falling back to local theme filter", {
        attempt,
        name: error instanceof Error ? error.name : "unknown",
        msg: error instanceof Error ? error.message : String(error),
      });
      validated = cleanAnswers.filter((answer) => {
        if (policies.isForbiddenPublishAnswer(answer)) return false;
        if (policies.isOverGenericThemeWordForTheme(theme, answer)) return false;
        const note = notesByAnswer.get(answer);
        const usefulNote = Boolean(
          note && note.trim().length >= 8 && !policies.noteLooksWeakThematicContext(note, language)
        );
        return usefulNote || policies.isThemeCoreWord(theme, answer);
      });
      cspBankAuditRejectedBySet(
        cspBankAuditReport,
        "validateThematicAnswers",
        cleanAnswers,
        validated,
        "other"
      );
    }
  }
  dependencies.recordAuditDistribution(cspBankAuditReport, "accepted-by-validateThematicAnswers", validated);
  cspBankAuditReport.validatedCount = validated.length;

  if (
    size === 11 &&
    answerbankTextResult.finishReason !== "structured-length-buckets" &&
    cleanAnswers.length < 70 &&
    dependencies.now() < deadlineMs - 20_000
  ) {
    const targetByLength = new Map<number, number>([
      [3, 4],
      [4, 10],
      [5, 12],
      [6, 10],
      [7, 12],
      [8, 10],
    ]);
    const validatedCountByLength = validated.reduce((counts, answer) => {
      counts.set(answer.length, (counts.get(answer.length) ?? 0) + 1);
      return counts;
    }, new Map<number, number>());
    const desiredByLength = new Map<number, number>();
    for (const [len, target] of targetByLength) {
      const deficit = Math.max(0, target - (validatedCountByLength.get(len) ?? 0));
      if (deficit > 0) desiredByLength.set(len, Math.min(deficit + 3, 14));
    }

    if (desiredByLength.size > 0) {
      try {
        const balancedAnswers = await dependencies.generateLengthBalancedThematicAnswers({
          existing: cleanAnswers,
          desiredByLength,
        });
        const balancedValidated =
          balancedAnswers.length > 0
            ? await dependencies.validateThematicAnswers({ answers: balancedAnswers })
            : [];
        const publishableBalanced = balancedValidated.filter((answer) =>
          policies.isPublishableAnswerForTheme({
            theme,
            answer,
            language,
            size,
            note: notesByAnswer.get(answer),
            allowContextualGeneric: false,
          })
        );

        for (const answer of balancedAnswers) {
          if (!cleanAnswers.includes(answer)) cleanAnswers.push(answer);
        }
        validated = Array.from(new Set([...validated, ...publishableBalanced]));
        dependencies.recordAuditDistribution(cspBankAuditReport, "length-balanced-topup-raw", balancedAnswers);
        cspBankAuditRejectedBySet(
          cspBankAuditReport,
          "length-balanced-topup-validation",
          balancedAnswers,
          publishableBalanced,
          "failed-thematic-validation"
        );
        dependencies.recordAuditDistribution(cspBankAuditReport, "after-length-balanced-topup", validated);

        dependencies.warn("[generate-crossword] length-balanced topup validated", {
          attempt,
          generated: balancedAnswers.length,
          kept: publishableBalanced.length,
          validatedByLength: Object.fromEntries(
            validated.reduce((counts, answer) => {
              counts.set(answer.length, (counts.get(answer.length) ?? 0) + 1);
              return counts;
            }, new Map<number, number>())
          ),
        });
      } catch (error: unknown) {
        dependencies.warn("[generate-crossword] length-balanced topup failed", {
          attempt,
          name: error instanceof Error ? error.name : "unknown",
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const validationTarget = size === 11 ? 60 : 36;
  const validationTopUpRounds = size === 11 ? 0 : 1;
  for (
    let validationRound = 0;
    validationRound < validationTopUpRounds &&
    validated.length < validationTarget &&
    dependencies.now() < deadlineMs - 25_000;
    validationRound++
  ) {
    const extraNeed = Math.min(size === 11 ? 40 : 48, validationTarget - validated.length);
    const extraAnswers = await dependencies.topUpAnswers({
      existing: cleanAnswers,
      need: extraNeed,
    });

    const appended: string[] = [];
    for (const answer of extraAnswers) {
      if (validated.includes(answer)) continue;
      if (!cleanAnswers.includes(answer)) cleanAnswers.push(answer);
      appended.push(answer);
    }

    if (appended.length > 0) {
      const extraValidated = await dependencies.validateThematicAnswers({ answers: appended });
      validated = Array.from(new Set([...validated, ...extraValidated])).filter((answer) =>
        policies.isPublishableAnswerForTheme({
          theme,
          answer,
          language,
          size,
          note: notesByAnswer.get(answer),
          allowContextualGeneric: false,
        })
      );
      dependencies.warn("[generate-crossword] validate: post-validation topup", {
        attempt,
        validationRound,
        appended: appended.length,
        extraValidated: extraValidated.length,
        validated: validated.length,
      });
    }
    if (appended.length === 0) break;
  }

  dependencies.recordAuditDistribution(cspBankAuditReport, "after-all-general-and-validation-topups", validated);

  const thematicKeepSet = buildThematicKeepSet({
    validated,
    contextAnswers: answerbankTextResult.contextAnswers ?? [],
    structuredTrustedSet,
    notesByAnswer,
    language,
    size,
    cleanAnswers,
    expandAnswers: dependencies.expandGeographicCompoundAnswers,
    policies: { noteLooksWeakThematicContext: policies.noteLooksWeakThematicContext },
  });
  const lastAnswerStats = {
    cleanCount: cleanAnswers.length,
    cleanSample: cleanAnswers.slice(0, 30),
    validatedCount: validated.length,
    validatedSample: validated.slice(0, 30),
    thematicKeepCount: thematicKeepSet.size,
    thematicKeepSample: Array.from(thematicKeepSet).slice(0, 30),
  };

  const validationApplyResult = applyValidatedAnswersToCleanBank({
    cleanAnswers,
    validated,
    size,
    minClean,
    targetAnswers,
  });
  if (validationApplyResult.applied) {
    dependencies.warn("[generate-crossword] validate: applied", {
      attempt,
      keep: validated.length,
      finalCount: validationApplyResult.finalCount,
      minClean,
      minKeepToApply: validationApplyResult.minKeepToApply,
    });
  } else {
    dependencies.warn("[generate-crossword] validate: keep too small, skipping prune", {
      attempt,
      keep: validated.length,
      minKeepToApply: validationApplyResult.minKeepToApply,
      cleanBefore: validationApplyResult.cleanBefore,
    });
  }

  if (cleanAnswers.length < minClean) {
    const issue = `not enough clean answers after sanitize/topup; clean=${cleanAnswers.length}; min=${minClean}`;
    dependencies.warn("[generate-crossword] skip: not enough clean answers after sanitize/topup", {
      attempt,
      cleanCount: cleanAnswers.length,
      minClean,
    });
    return {
      status: "skip",
      reason: "not-enough-clean-answers",
      issue,
      cspBankAuditReport,
    };
  }

  let supportWords: string[] =
    size === 11
      ? (answerbankTextResult.contextAnswers ?? []).filter((answer) =>
          structuredTrustedSet.has(answer)
        )
      : [];

  if (dependencies.now() < deadlineMs - (size === 11 ? 35_000 : 2_500)) {
    try {
      supportWords = (await dependencies.generateSupportWords({
        existing: cleanAnswers,
      })).filter(
        (answer) =>
          !policies.isLikelyBadAnswer(answer) &&
          !policies.isForbiddenPublishAnswer(answer)
      );
    } catch (error: unknown) {
      dependencies.warn("[generate-crossword] support generation failed", {
        attempt,
        name: error instanceof Error ? error.name : "unknown",
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (size === 11 && supportWords.length > 0) {
    for (const answer of supportWords) {
      if (policies.isForbiddenPublishAnswer(answer)) continue;
      if (policies.isLikelyBadAnswer(answer) && !policies.alwaysAllowAnswers.has(answer)) continue;
      if (!policies.answerLanguageLooksValidForPuzzle(answer, language)) continue;
      if (!notesByAnswer.has(answer)) {
        notesByAnswer.set(
          answer,
          language === "es"
            ? `Vocabulario concreto del dominio tematico de ${theme}.`
            : `Concrete domain vocabulary for the theme ${theme}.`
        );
      }
      thematicKeepSet.add(answer);
    }
    dependencies.warn("[generate-crossword] contextual support admitted", {
      attempt,
      count: supportWords.length,
      sample: supportWords.slice(0, 30),
    });
  }

  if (size === 11 && supportWords.length > 0) {
    try {
      const validatedSupportWords = (
        await dependencies.validateThematicAnswers({
          answers: supportWords.slice(0, 60),
        })
      ).filter((answer) =>
        policies.isPublishableAnswerForTheme({
          theme,
          answer,
          language,
          size,
          note: notesByAnswer.get(answer),
          allowContextualGeneric: true,
        })
      );
      for (const answer of validatedSupportWords) {
        thematicKeepSet.add(answer);
      }
      dependencies.warn("[generate-crossword] validated contextual support", {
        attempt,
        requested: Math.min(supportWords.length, 60),
        kept: validatedSupportWords.length,
        byLength: Object.fromEntries(
          validatedSupportWords.reduce((counts, answer) => {
            counts.set(answer.length, (counts.get(answer.length) ?? 0) + 1);
            return counts;
          }, new Map<number, number>())
        ),
      });
    } catch (error: unknown) {
      dependencies.warn("[generate-crossword] contextual support validation failed", {
        attempt,
        msg: dependencies.errorSummary(error),
      });
    }
  }

  const localSupportWords = dependencies.inferLocalSupportWords(theme, size, notesByAnswer);
  if (
    size === 11 &&
    enableSemanticSupport11 &&
    dependencies.now() < deadlineMs - 25_000
  ) {
    try {
      const semanticSupport = await dependencies.rankSemanticSupportWords();
      for (const answer of semanticSupport) {
        localSupportWords.push({ answer, thematic: false });
      }
      dependencies.warn("[generate-crossword] semantic support ranked", {
        count: semanticSupport.length,
        sample: semanticSupport.slice(0, 30),
      });
    } catch (error: unknown) {
      dependencies.warn("[generate-crossword] semantic support failed", {
        msg: dependencies.errorSummary(error),
      });
    }
  }

  const prePoolAnswerBankState = buildPrePoolAnswerBankState({
    cleanAnswers,
    validated,
    thematicKeepSet,
    theme,
    language,
    size,
    fillerWords,
    policies: { isExcludedFromBroadThematicSet: policies.isOverGenericThemeWordForTheme },
  });
  const publishThemeSet = prePoolAnswerBankState.thematicSets.publishThemeSet;
  const placementThemeSet = prePoolAnswerBankState.thematicSets.placementThemeSet;
  const normalizedAnswerBank: RawAnswerBank = prePoolAnswerBankState.normalizedAnswerBank;

  const rawPool = dependencies.buildCandidatePoolFromAnswers({
    theme,
    normalizedAnswerBank,
    size,
    placementThemeSet,
    supportWords,
    localSupportWords,
    language,
  });
  cspBankAuditReport.candidatePoolCount = rawPool.length;
  dependencies.recordAuditDistribution(
    cspBankAuditReport,
    "pool-produced-by-buildCandidatePoolFromAnswers",
    rawPool.map((candidate) => candidate.answer)
  );
  cspBankAuditReport.distributions.rawPoolDistribution =
    cspBankAuditCandidateDistribution(rawPool);

  return {
    status: "ok",
    cspBankAuditReport,
    notesByAnswer,
    cleanAnswers,
    validated,
    thematicKeepSet,
    publishThemeSet,
    placementThemeSet,
    normalizedAnswerBank,
    rawPool,
    supportWords,
    localSupportWords,
    lastAnswerStats,
  };
}
