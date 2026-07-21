import { normalizeAnswer } from "@/app/lib/crosswordUtils";
import type { CspBankAuditReport, SanitizeAuditPolicies } from "./answerPipelineTypes";

export function createCspBankAuditReport(theme: string, language: "es" | "en", size: number): CspBankAuditReport {
  return {
    theme,
    language,
    size,
    initialRawCount: 0,
    initialSanitizedCount: 0,
    validatedCount: 0,
    candidatePoolCount: 0,
    cspCandidateCount: 0,
    distributions: {},
    rejectedByStage: {},
    rejectedSamplesByStage: {},
    samplesByStage: {},
    cspMissingLengths: {},
    cspRequestedTopUpByLength: {},
    cspTopUpRawByLength: {},
    cspTopUpAcceptedByLength: {},
    cspTopUpRejectedByLength: {},
    cspAdapterRejectedByReason: {},
    cspDomainDiagnostics: [],
  };
}

export function cspBankAuditDistribution(values: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of values) {
    const answer = normalizeAnswer(raw);
    if (!answer) continue;
    out[String(answer.length)] = (out[String(answer.length)] ?? 0) + 1;
  }
  return out;
}

export function cspBankAuditCandidateDistribution(values: Iterable<{ answer: string }>): Record<string, number> {
  return cspBankAuditDistribution(Array.from(values, (value) => value.answer));
}

export function cspBankAuditSample(values: Iterable<string>, limit = 20): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const answer = normalizeAnswer(raw);
    if (!answer || seen.has(answer)) continue;
    seen.add(answer);
    out.push(answer);
    if (out.length >= limit) break;
  }
  return out;
}

export function cspBankAuditSetDistribution(
  report: CspBankAuditReport,
  stage: string,
  values: Iterable<string>,
  log?: (label: string, payload: Record<string, unknown>) => void
) {
  const sampleSource = Array.from(values);
  report.distributions[stage] = cspBankAuditDistribution(sampleSource);
  report.samplesByStage[stage] = cspBankAuditSample(sampleSource);
  log?.(stage, {
    count: sampleSource.length,
    byLength: report.distributions[stage],
    sample: report.samplesByStage[stage],
  });
}

export function cspBankAuditAddRejected(
  report: CspBankAuditReport,
  stage: string,
  reason: string,
  answer: string
) {
  const stageReasons = report.rejectedByStage[stage] ?? {};
  stageReasons[reason] = (stageReasons[reason] ?? 0) + 1;
  report.rejectedByStage[stage] = stageReasons;
  const samples = report.rejectedSamplesByStage[stage] ?? [];
  if (samples.length < 20) samples.push({ answer: normalizeAnswer(answer), reason });
  report.rejectedSamplesByStage[stage] = samples;
}

export function cspBankAuditMergeCounts(target: Record<string, number>, source: Record<string | number, number>) {
  for (const [key, value] of Object.entries(source)) {
    target[String(key)] = (target[String(key)] ?? 0) + value;
  }
}

export function cspBankAuditAnalyzeSanitize(
  raw: unknown,
  sanitized: string[],
  opts: {
    theme: string;
    maxLen: number;
    language: "es" | "en";
    report: CspBankAuditReport;
    policies: SanitizeAuditPolicies;
  }
) {
  if (!Array.isArray(raw)) {
    cspBankAuditAddRejected(opts.report, "sanitize", "other", "");
    return;
  }

  const accepted = new Set(sanitized.map(normalizeAnswer).filter(Boolean));
  const firstPass: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const answer = normalizeAnswer(String(item ?? ""));
    let reason: string | null = null;
    if (!answer) reason = "empty";
    else if (!opts.policies.asciiAnswerPattern.test(answer)) reason = "invalid-characters";
    else if (answer.length < 3) reason = "too-short";
    else if (answer.length > opts.maxLen) reason = "too-long";
    else if (opts.policies.bannedAnswers.has(answer)) reason = "banned-answer";
    else if (!opts.policies.answerLanguageLooksValidForPuzzle(answer, opts.language)) reason = "likely-bad-answer";
    else if (opts.policies.isLikelyBadAnswer(answer) && !opts.policies.alwaysAllowAnswers.has(answer)) {
      reason = "likely-bad-answer";
    } else if (seen.has(answer)) reason = "duplicate-after-normalization";

    if (reason) {
      cspBankAuditAddRejected(opts.report, "sanitize", reason, answer);
      continue;
    }

    seen.add(answer);
    firstPass.push(answer);
  }

  for (const answer of firstPass) {
    if (!accepted.has(answer)) cspBankAuditAddRejected(opts.report, "sanitize", "prefix-of-longer-answer", answer);
  }

  const themeNorm = normalizeAnswer(opts.theme);
  if (themeNorm && firstPass.includes(themeNorm) && !sanitized.includes(themeNorm)) {
    cspBankAuditAddRejected(opts.report, "post-sanitize-theme-filter", "exact-theme", themeNorm);
  }
}

export function cspBankAuditRejectedBySet(
  report: CspBankAuditReport,
  stage: string,
  input: string[],
  kept: string[],
  reason: string
) {
  const keptSet = new Set(kept.map(normalizeAnswer).filter(Boolean));
  for (const answer of input.map(normalizeAnswer).filter(Boolean)) {
    if (!keptSet.has(answer)) cspBankAuditAddRejected(report, stage, reason, answer);
  }
}
