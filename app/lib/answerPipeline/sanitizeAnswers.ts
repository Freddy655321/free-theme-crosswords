import type { RawAnswerBank } from "@/app/lib/crosswordTypes";
import { normalizeAnswer } from "@/app/lib/crosswordUtils";
import { cspBankAuditAnalyzeSanitize } from "./answerBankAudit";
import type {
  AnswerLanguage,
  AnswerSanitizationPolicies,
  CspBankAuditReport,
  NoteItem,
  SanitizedInitialAnswerBankResult,
  SanitizeAnswerListPolicies,
} from "./answerPipelineTypes";

const GEOGRAPHIC_COMPOUND_PREFIXES = [
  "CERRO",
  "LAGO",
  "RIO",
  "ISLA",
  "PUERTO",
  "VILLA",
  "COLONIA",
  "RUTA",
  "PARQUE",
  "MONTE",
];

export function sanitizeAnswerListWithPolicies(
  raw: unknown,
  maxLen: number,
  language: AnswerLanguage | undefined,
  policies: SanitizeAnswerListPolicies
) {
  const out: string[] = [];
  const seen = new Set<string>();

  if (!Array.isArray(raw)) return out;

  for (const item of raw) {
    const a = normalizeAnswer(String(item ?? ""));
    if (!a) continue;

    // A-Z0-9 only
    if (!policies.asciiAnswerPattern.test(a)) continue;

    // length 3..maxLen
    if (a.length < 3 || a.length > maxLen) continue;

    // ban obvious junk
    if (policies.bannedAnswers.has(a)) continue;
    if (language && !policies.answerLanguageLooksValidForPuzzle(a, language)) continue;
    if (policies.isLikelyBadAnswer(a) && !policies.alwaysAllowAnswers.has(a)) continue;

    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }

  // Remove entries that are exact prefixes of a longer entry also present.
  // Example: MAL vs MALIBU, FRES vs FRESNO, SIL vs SILICON.
  const filtered = out.filter((a) => {
    return !out.some((b) => b !== a && b.length > a.length && b.startsWith(a));
  });

  return filtered;
}

function buildNotesByAnswer(
  rawNotes: unknown,
  language: AnswerLanguage,
  policies: Pick<AnswerSanitizationPolicies, "noteLooksWeakThematicContext">
) {
  const notesByAnswer = new Map<string, string>();
  const notesArr: NoteItem[] = Array.isArray(rawNotes) ? (rawNotes as NoteItem[]) : [];

  for (const n0 of notesArr) {
    const a = typeof n0.answer === "string" ? normalizeAnswer(n0.answer) : "";
    const note = typeof n0.note === "string" ? n0.note.trim() : "";
    if (a && note && !policies.noteLooksWeakThematicContext(note, language)) notesByAnswer.set(a, note);
  }

  return notesByAnswer;
}

function normalizeRawAnswers(rawAnswers: unknown) {
  return Array.isArray(rawAnswers)
    ? rawAnswers.map((answer) => normalizeAnswer(String(answer ?? ""))).filter(Boolean)
    : [];
}

function propagateGeographicCompoundNotes(
  rawNormalizedAnswers: string[],
  notesByAnswer: Map<string, string>,
  size: number,
  policies: Pick<AnswerSanitizationPolicies, "minEntryLenForSize">
) {
  for (const answer of rawNormalizedAnswers) {
    const note = notesByAnswer.get(answer);
    if (!note) continue;
    for (const prefix of GEOGRAPHIC_COMPOUND_PREFIXES) {
      if (!answer.startsWith(prefix)) continue;
      const suffix = answer.slice(prefix.length);
      if (suffix.length >= policies.minEntryLenForSize(size) && suffix.length <= size && !notesByAnswer.has(suffix)) {
        notesByAnswer.set(suffix, note);
      }
      if (prefix.length >= policies.minEntryLenForSize(size) && prefix.length <= size && !notesByAnswer.has(prefix)) {
        notesByAnswer.set(prefix, note);
      }
    }
  }
}

export function sanitizeInitialAnswerBank(input: {
  parsedBank: RawAnswerBank;
  theme: string;
  language: AnswerLanguage;
  size: number;
  report: CspBankAuditReport;
  policies: AnswerSanitizationPolicies;
  recordDistribution: (report: CspBankAuditReport, stage: string, values: Iterable<string>) => void;
}): SanitizedInitialAnswerBankResult {
  const rawNotes = (input.parsedBank as unknown as { notes?: unknown }).notes;
  const notesByAnswer = buildNotesByAnswer(rawNotes, input.language, input.policies);

  const rawNormalizedAnswers = normalizeRawAnswers(input.parsedBank.answers);
  input.recordDistribution(input.report, "after-normalizeAnswer", rawNormalizedAnswers);

  propagateGeographicCompoundNotes(rawNormalizedAnswers, notesByAnswer, input.size, input.policies);

  const cleanAnswers = sanitizeAnswerListWithPolicies(
    input.parsedBank.answers,
    input.size,
    input.language,
    input.policies
  );
  const normalizedThemeAnswer = normalizeAnswer(input.theme);
  for (let i = cleanAnswers.length - 1; i >= 0; i--) {
    if (cleanAnswers[i] === normalizedThemeAnswer) cleanAnswers.splice(i, 1);
  }

  input.report.initialSanitizedCount = cleanAnswers.length;
  cspBankAuditAnalyzeSanitize(input.parsedBank.answers, cleanAnswers, {
    theme: input.theme,
    maxLen: input.size,
    language: input.language,
    report: input.report,
    policies: input.policies,
  });
  input.recordDistribution(input.report, "after-sanitizeAnswerList", cleanAnswers);
  notesByAnswer.delete(normalizedThemeAnswer);

  return {
    notesByAnswer,
    rawNormalizedAnswers,
    cleanAnswers,
    normalizedThemeAnswer,
  };
}
