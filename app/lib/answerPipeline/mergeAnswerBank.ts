import { normalizeAnswer } from "@/app/lib/crosswordUtils";
import type {
  AnswerBankStats,
  ApplyValidatedAnswersToCleanBankInput,
  ApplyValidatedAnswersToCleanBankResult,
  BuildPrePoolAnswerBankStateInput,
  BuildThematicKeepSetInput,
  MergeExpandedAnswersInput,
  PrePoolAnswerBankState,
} from "./answerPipelineTypes";

export function mergeExpandedAnswers(input: MergeExpandedAnswersInput): void {
  for (const expanded of input.expandAnswers(input.source as string[], input.size)) {
    if (input.acceptExpanded && !input.acceptExpanded(expanded)) continue;
    if (!input.target.includes(expanded)) input.target.push(expanded);
  }
}

export function buildAnswerBankStats(input: {
  cleanAnswers: readonly string[];
  validated: readonly string[];
  thematicKeepSet: ReadonlySet<string>;
}): AnswerBankStats {
  return {
    cleanCount: input.cleanAnswers.length,
    cleanSample: input.cleanAnswers.slice(0, 30),
    validatedCount: input.validated.length,
    validatedSample: input.validated.slice(0, 30),
    thematicKeepCount: input.thematicKeepSet.size,
    thematicKeepSample: Array.from(input.thematicKeepSet).slice(0, 30),
  };
}

export function buildThematicKeepSet(input: BuildThematicKeepSetInput): Set<string> {
  const thematicKeepSet = new Set(input.validated.map((answer) => normalizeAnswer(answer)).filter(Boolean));

  if (input.size === 11) {
    for (const answer of input.contextAnswers) {
      const note = input.notesByAnswer.get(answer);
      if (
        input.structuredTrustedSet.has(answer) &&
        note &&
        note.length >= 8 &&
        !input.policies.noteLooksWeakThematicContext(note, input.language)
      ) {
        thematicKeepSet.add(answer);
      }
    }
  }

  for (const expanded of input.expandAnswers(Array.from(thematicKeepSet), input.size)) {
    thematicKeepSet.add(expanded);
    if (!input.cleanAnswers.includes(expanded)) input.cleanAnswers.push(expanded);
  }

  return thematicKeepSet;
}

export function applyValidatedAnswersToCleanBank(
  input: ApplyValidatedAnswersToCleanBankInput
): ApplyValidatedAnswersToCleanBankResult {
  const minKeepToApply = Math.max(12, Math.floor(input.minClean * 0.5));

  if (input.validated.length < minKeepToApply) {
    return {
      applied: false,
      minKeepToApply,
      finalCount: input.cleanAnswers.length,
      cleanBefore: input.cleanAnswers.length,
    };
  }

  const next: string[] = [];
  const seen = new Set<string>();

  for (const answer of input.validated) {
    if (seen.has(answer)) continue;
    seen.add(answer);
    next.push(answer);
  }

  if (input.size !== 11 && next.length < input.minClean) {
    for (const answer of input.cleanAnswers) {
      if (next.length >= input.minClean) break;
      if (seen.has(answer)) continue;
      seen.add(answer);
      next.push(answer);
    }
  }

  if (input.size !== 11) {
    for (const answer of input.cleanAnswers) {
      if (next.length >= input.targetAnswers) break;
      if (seen.has(answer)) continue;
      seen.add(answer);
      next.push(answer);
    }
  }

  input.cleanAnswers.length = 0;
  for (const answer of next) input.cleanAnswers.push(answer);

  return {
    applied: true,
    minKeepToApply,
    finalCount: input.cleanAnswers.length,
  };
}

export function buildPrePoolAnswerBankState(input: BuildPrePoolAnswerBankStateInput): PrePoolAnswerBankState {
  const broadModelThematicSet = new Set<string>(
    input.cleanAnswers
      .map((answer) => normalizeAnswer(answer))
      .filter(Boolean)
      .filter((answer) => !input.policies.isExcludedFromBroadThematicSet(input.theme, answer))
      .filter((answer) => input.thematicKeepSet.has(answer) || !input.fillerWords.includes(answer))
  );
  const themeSetForAttempt =
    input.size === 11
      ? new Set<string>(input.thematicKeepSet)
      : new Set<string>([...broadModelThematicSet, ...input.thematicKeepSet]);
  const publishThemeSet = input.thematicKeepSet.size >= 10 ? input.thematicKeepSet : themeSetForAttempt;
  const placementThemeSet = themeSetForAttempt;

  return {
    normalizedAnswerBank: { answers: input.cleanAnswers },
    thematicSets: {
      broadModelThematicSet,
      themeSetForAttempt,
      publishThemeSet,
      placementThemeSet,
    },
    stats: buildAnswerBankStats({
      cleanAnswers: input.cleanAnswers,
      validated: input.validated,
      thematicKeepSet: input.thematicKeepSet,
    }),
  };
}
