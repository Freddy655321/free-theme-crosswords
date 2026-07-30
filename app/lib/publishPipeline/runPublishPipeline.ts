import type { Entry } from "@/app/lib/crosswordTypes";
import { normalizeAnswer } from "@/app/lib/crosswordUtils";
import { deriveEntriesFromGrid } from "./deriveEntries";
import type {
  ApplyCluesPolicies,
  PublishPipelineResult,
  PublishQualityPolicies,
  RepairPublishCluesPolicies,
  RunPublishPipelineInput,
  PublishPipelineLanguage,
} from "./publishPipelineTypes";
import { sanitizeModelClueText } from "./clueGeneration";

export function applyCluesAndOverridesWithPolicies(
  theme: string,
  language: PublishPipelineLanguage,
  derived: Omit<Entry, "clue">[],
  clueByAnswer: Map<string, string>,
  policies: ApplyCluesPolicies
): Entry[] {
  const overrides = policies.getThemeClueOverrides(theme);

  return derived.map((e) => {
    const ov = overrides[e.answer];
    const specific = policies.specificThematicFallbackClue(theme, e.answer, language);
    let clue = ov ? (language === "es" ? ov.es : ov.en) : (specific ?? clueByAnswer.get(e.answer) ?? "");
    clue = sanitizeModelClueText(clue, language);

    if (!clue) clue = language === "es" ? "DefiniciÃ³n breve." : "Brief definition.";

    if (policies.isBadClue(clue) || policies.clueMentionsAnswer(clue, e.answer)) {
      const ov2 = overrides[e.answer];
      clue = ov2 ? (language === "es" ? ov2.es : ov2.en) : (specific ?? clue);
      clue = sanitizeModelClueText(clue, language);
      if (policies.isBadClue(clue) || policies.clueMentionsAnswer(clue, e.answer)) {
        clue = language === "es" ? "DefiniciÃ³n breve." : "Brief definition.";
      }
    }

    return { ...e, clue };
  });
}

export function repairPublishCluesWithPolicies(
  entries: Entry[],
  opts: {
    theme: string;
    language: PublishPipelineLanguage;
    thematicSet: Set<string>;
    notesByAnswer: Map<string, string>;
  },
  policies: RepairPublishCluesPolicies
): Entry[] {
  return entries.map((entry) => {
    const thematic = opts.thematicSet.has(entry.answer);
    const needsContextualClue = thematic || policies.contextualSupportAnswers.has(entry.answer);
    const contextualFallback = policies.fallbackClueForPublishRepair(
      opts.theme,
      entry.answer,
      opts.language,
      needsContextualClue,
      opts.notesByAnswer.get(entry.answer)
    );
    const bad =
      policies.isPlaceholderClue(entry.clue, opts.language) ||
      policies.isBadClue(entry.clue) ||
      (needsContextualClue && policies.clueLooksTooGenericForThematic(entry.clue, opts.language)) ||
      policies.clueLooksWeakGeneratedFallback(entry.clue, opts.language) ||
      policies.clueMakesUnstableTemporalClaim(entry.clue, opts.language) ||
      policies.clueMislabelsPartialPersonAnswer(entry.answer, entry.clue, opts.language) ||
      policies.clueMislabelsKnownPartialTitle(opts.theme, entry.answer, entry.clue) ||
      !policies.clueLanguageLooksValid(entry.clue, opts.language) ||
      policies.clueLooksOffTheme(opts.theme, entry.clue) ||
      policies.clueMentionsAnswer(entry.clue, entry.answer) ||
      (entry.answer !== "TOBOGAN" && /tobog[aÃ¡]n alpino/i.test(entry.clue)) ||
      (entry.answer === "PLAYA" && /\bmar\b/i.test(entry.clue));

    if (!bad) return entry;

    return contextualFallback ? { ...entry, clue: contextualFallback } : entry;
  });
}

export function publishQualityIssueWithPolicies(
  entries: Entry[],
  thematicSet: Set<string>,
  language: PublishPipelineLanguage,
  minEntries: number,
  theme: string,
  policies: PublishQualityPolicies
): string | null {
  if (entries.length < minEntries) return "too-few-entries";

  const answers = new Set(entries.map((entry) => entry.answer));
  for (const answer of answers) {
    if (answer.length > 3 && answer.endsWith("S") && answers.has(answer.slice(0, -1))) {
      return `duplicate-variant:${answer.slice(0, -1)}/${answer}`;
    }
  }

  for (const entry of entries) {
    if (!policies.answerLanguageLooksValidForPuzzle(entry.answer, language)) return `wrong-language-answer:${entry.answer}`;
    if (policies.isLikelyBadAnswer(entry.answer) && !policies.alwaysAllowAnswers.has(entry.answer)) return `bad-answer:${entry.answer}`;
    if (policies.modelFragmentAnswers.has(entry.answer)) return `fragment:${entry.answer}`;
    if (policies.bannedAnswers.has(entry.answer) && !policies.contextualGenericAnswers.has(entry.answer)) return `fragment:${entry.answer}`;
    if (policies.isPlaceholderClue(entry.clue, language) || policies.isBadClue(entry.clue)) return `bad-clue:${entry.answer}`;
    if (policies.clueMakesUnstableTemporalClaim(entry.clue, language)) return `temporal-clue:${entry.answer}`;
    if (policies.clueMislabelsPartialPersonAnswer(entry.answer, entry.clue, language)) {
      return `partial-name-clue:${entry.answer}`;
    }
    if (policies.clueMislabelsKnownPartialTitle(theme, entry.answer, entry.clue)) {
      return `partial-title-clue:${entry.answer}`;
    }
    const needsContextualClue =
      thematicSet.has(entry.answer) || policies.contextualSupportAnswers.has(entry.answer);
    if (needsContextualClue && policies.clueLooksTooGenericForThematic(entry.clue, language)) {
      return `generic-thematic-clue:${entry.answer}`;
    }
    if (entry.answer !== "TOBOGAN" && /tobog[aÃ¡]n alpino/i.test(entry.clue)) return `bad-clue:${entry.answer}`;
    if (!policies.clueLanguageLooksValid(entry.clue, language)) return `wrong-language-clue:${entry.answer}`;
    if (policies.clueMentionsAnswer(entry.clue, entry.answer)) return `answer-in-clue:${entry.answer}`;
    if (!thematicSet.has(entry.answer) && policies.lowValueContextlessAnswers.has(entry.answer)) {
      return `unsupported-generic:${entry.answer}`;
    }
    if (
      policies.lowValueContextlessAnswers.has(entry.answer) &&
      (policies.clueLooksTooGenericForThematic(entry.clue, language) ||
        policies.clueLooksWeakGeneratedFallback(entry.clue, language))
    ) {
      return `unsupported-generic:${entry.answer}`;
    }
  }

  const weakGeneratedFallbackCount = entries.filter((entry) =>
    policies.clueLooksWeakGeneratedFallback(entry.clue, language)
  ).length;
  if (weakGeneratedFallbackCount > 0) return `weak-generated-clue:${weakGeneratedFallbackCount}`;

  const thematicCount = entries.filter((entry) => thematicSet.has(entry.answer)).length;
  const nonThematicCount = entries.length - thematicCount;

  if (entries.length < policies.minEntriesForSize(11) && nonThematicCount > 6) {
    return `too-many-nonthematic:${nonThematicCount}`;
  }

  const unsupportedGeneric = entries.find((entry) => {
    if (thematicSet.has(entry.answer)) return false;
    return policies.bannedAnswers.has(entry.answer) && !policies.contextualGenericAnswers.has(entry.answer);
  });
  if (unsupportedGeneric) return `unsupported-generic:${unsupportedGeneric.answer}`;

  return null;
}

export async function runPublishPipeline(input: RunPublishPipelineInput): Promise<PublishPipelineResult> {
  const minLen = input.minEntryLenForSize(input.size);
  const derived = deriveEntriesFromGrid(input.grid, minLen);
  const uniqueAnswers = Array.from(new Set(derived.map((entry) => entry.answer)));
  const clueItems = uniqueAnswers.map((answer) => {
    const note = input.notesByAnswer.get(answer);
    const thematic = input.thematicSet.has(answer);
    const hint = input.buildThematicClueRequestHint(input.theme, answer, input.language, note) ?? undefined;
    return {
      answer,
      thematic,
      note,
      hint: thematic ? hint : undefined,
    };
  });

  const clueByAnswer = new Map<string, string>();
  if (input.client && input.requestModelClues) {
    const modelClues = await input.requestModelClues({
      client: input.client,
      theme: input.theme,
      language: input.language,
      items: clueItems,
    });
    for (const [answer, clue] of modelClues.entries()) {
      clueByAnswer.set(normalizeAnswer(answer), clue);
    }
  }

  input.reinforceThematicClues(
    input.theme,
    input.language,
    uniqueAnswers,
    clueByAnswer,
    input.notesByAnswer,
    input.thematicSet
  );

  const entries = input.repairPublishClues(
    input.applyCluesAndOverrides(input.theme, input.language, derived, clueByAnswer),
    {
      theme: input.theme,
      language: input.language,
      thematicSet: input.thematicSet,
      notesByAnswer: input.notesByAnswer,
    }
  );

  return {
    clueByAnswer,
    crossword: {
      theme: input.theme,
      language: input.language,
      size: input.size,
      grid: input.grid,
      entries,
      meta: {
        source: input.source ?? "publish-pipeline",
        ...input.meta,
      },
    },
  };
}
