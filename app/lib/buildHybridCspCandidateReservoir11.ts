import { readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeCspAnswer11, type CspAdapterInputCandidate } from "./crosswordCspAdapter11";

export type CspCandidateKind11 = "thematic" | "support";

export type HybridCspCandidate11 = CspAdapterInputCandidate & {
  kind: CspCandidateKind11;
  source: string;
};

export type HybridCspCandidateReservoir11 = {
  candidates: HybridCspCandidate11[];
  thematicCountsByLength: Record<number, number>;
  supportCountsByLength: Record<number, number>;
  totalCountsByLength: Record<number, number>;
  excludedSupportByReason: Record<string, number>;
};

const SUPPORT_RE = /^[A-Z]+$/;
const DEFAULT_SUPPORT_LIMIT_PER_LENGTH = 400;
const WEAK_SUPPORT_WORDS = new Set([
  "ABOUT",
  "AFTER",
  "AGAIN",
  "ALSO",
  "BEEN",
  "BEFORE",
  "COULD",
  "DOES",
  "DONE",
  "EVERY",
  "FROM",
  "HAVE",
  "INTO",
  "MORE",
  "OTHER",
  "OVER",
  "THAN",
  "THAT",
  "THEIR",
  "THERE",
  "THESE",
  "THIS",
  "THOSE",
  "WITH",
  "WOULD",
]);

export function loadLocalSupportCandidates11(opts: {
  language: "es" | "en";
  requiredLengths: number[];
  limitPerLength?: number;
}): HybridCspCandidate11[] {
  const filename = opts.language === "es" ? "frequency-es-50k.txt" : "frequency-en-50k.txt";
  const requiredLengths = new Set(opts.requiredLengths.filter((length) => length >= 4 && length <= 8));
  const limitPerLength = opts.limitPerLength ?? DEFAULT_SUPPORT_LIMIT_PER_LENGTH;
  const counts = new Map<number, number>();
  const out: HybridCspCandidate11[] = [];
  const seen = new Set<string>();

  for (const raw of readLocalWords(filename)) {
    const answer = normalizeCspAnswer11(raw.trim().split(/\s+/)[0] ?? "");
    if (!answer || seen.has(answer)) continue;
    if (!requiredLengths.has(answer.length)) continue;
    if (!isAllowedSupportAnswer11(answer)) continue;
    const current = counts.get(answer.length) ?? 0;
    if (current >= limitPerLength) continue;
    seen.add(answer);
    counts.set(answer.length, current + 1);
    out.push({
      answer,
      thematic: false,
      kind: "support",
      source: `local-frequency-${opts.language}`,
    });
  }

  return out.sort(compareHybridCandidates11);
}

export function buildHybridCspCandidateReservoir11(opts: {
  thematicCandidates: CspAdapterInputCandidate[];
  supportCandidates: CspAdapterInputCandidate[];
  theme: string;
  requiredLengths: number[];
  supportLimitPerLength?: number;
}): HybridCspCandidateReservoir11 {
  const requiredLengths = new Set(opts.requiredLengths.filter((length) => length >= 4 && length <= 8));
  const themeNorm = normalizeCspAnswer11(opts.theme);
  const byAnswer = new Map<string, HybridCspCandidate11>();
  const supportCounts = new Map<number, number>();
  const supportLimitPerLength = opts.supportLimitPerLength ?? DEFAULT_SUPPORT_LIMIT_PER_LENGTH;
  const excludedSupportByReason: Record<string, number> = {};

  const rejectSupport = (reason: string) => {
    excludedSupportByReason[reason] = (excludedSupportByReason[reason] ?? 0) + 1;
  };

  for (const candidate of opts.thematicCandidates) {
    const answer = normalizeCspAnswer11(candidate.answer);
    if (!answer || answer === themeNorm || !requiredLengths.has(answer.length)) continue;
    if (!candidate.thematic) continue;
    byAnswer.set(answer, {
      answer,
      thematic: true,
      kind: "thematic",
      source: candidate.source ?? "thematic",
    });
  }

  for (const candidate of opts.supportCandidates) {
    const answer = normalizeCspAnswer11(candidate.answer);
    if (!answer) {
      rejectSupport("empty");
      continue;
    }
    if (answer === themeNorm) {
      rejectSupport("exact-theme");
      continue;
    }
    if (!requiredLengths.has(answer.length)) {
      rejectSupport("incompatible-length");
      continue;
    }
    if (!isAllowedSupportAnswer11(answer)) {
      rejectSupport("weak-or-invalid-support");
      continue;
    }
    if (byAnswer.has(answer)) {
      rejectSupport("duplicate-or-thematic");
      continue;
    }
    const count = supportCounts.get(answer.length) ?? 0;
    if (count >= supportLimitPerLength) {
      rejectSupport("per-length-cap");
      continue;
    }
    supportCounts.set(answer.length, count + 1);
    byAnswer.set(answer, {
      answer,
      thematic: false,
      kind: "support",
      source: candidate.source ?? "local-support",
    });
  }

  const candidates = Array.from(byAnswer.values()).sort(compareHybridCandidates11);
  return {
    candidates,
    thematicCountsByLength: countByLength(candidates.filter((candidate) => candidate.kind === "thematic")),
    supportCountsByLength: countByLength(candidates.filter((candidate) => candidate.kind === "support")),
    totalCountsByLength: countByLength(candidates),
    excludedSupportByReason,
  };
}

function readLocalWords(filename: string): string[] {
  try {
    return readFileSync(join(process.cwd(), "data", filename), "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function isAllowedSupportAnswer11(answer: string): boolean {
  if (answer.length < 4 || answer.length > 8) return false;
  if (!SUPPORT_RE.test(answer)) return false;
  if (WEAK_SUPPORT_WORDS.has(answer)) return false;
  if (!/[AEIOU]/.test(answer)) return false;
  if (/[BCDFGHJKLMNPQRSTVWXYZ]{4,}/.test(answer)) return false;
  if (/(.)\1\1/.test(answer)) return false;
  return true;
}

function compareHybridCandidates11(a: HybridCspCandidate11, b: HybridCspCandidate11): number {
  if (a.kind !== b.kind) return a.kind === "thematic" ? -1 : 1;
  if (a.answer.length !== b.answer.length) return a.answer.length - b.answer.length;
  return a.answer.localeCompare(b.answer);
}

function countByLength(candidates: Array<{ answer: string }>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const candidate of candidates) {
    out[candidate.answer.length] = (out[candidate.answer.length] ?? 0) + 1;
  }
  return out;
}
