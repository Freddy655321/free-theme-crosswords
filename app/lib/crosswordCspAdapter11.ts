import { CROSSWORD_PATTERNS_11 } from "./crosswordPatterns11";
import { extractSlotsFromPattern11, type CspCandidate } from "./crosswordCsp11";

export type CspAdapterInputCandidate = {
  answer: string;
  thematic: boolean;
  source?: string;
  kind?: "thematic" | "support";
};

export type CspAdapterStats11 = {
  totalByLength: Record<number, number>;
  thematicByLength: Record<number, number>;
  supportByLength: Record<number, number>;
  rejectedByReason: Record<string, number>;
};

export type AdaptedCspCandidates11 = {
  candidates: CspCandidate[];
  stats: CspAdapterStats11;
  compatibleLengths: number[];
};

const ANSWER_RE = /^[A-Z0-9]+$/;

export function normalizeCspAnswer11(answer: string): string {
  return answer
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function compatibleCspLengths11(patterns = CROSSWORD_PATTERNS_11): number[] {
  return Array.from(
    new Set(patterns.flatMap((pattern) => extractSlotsFromPattern11(pattern.rows).map((slot) => slot.length)))
  ).sort((a, b) => a - b);
}

export function adaptCandidatesForCsp11(opts: {
  theme: string;
  candidates: CspAdapterInputCandidate[];
  patterns?: typeof CROSSWORD_PATTERNS_11;
}): AdaptedCspCandidates11 {
  const compatibleLengths = compatibleCspLengths11(opts.patterns ?? CROSSWORD_PATTERNS_11);
  const compatibleLengthSet = new Set(compatibleLengths);
  const themeNorm = normalizeCspAnswer11(opts.theme);
  const byAnswer = new Map<string, CspCandidate>();
  const rejectedByReason: Record<string, number> = {};

  const reject = (reason: string) => {
    rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1;
  };

  for (const candidate of opts.candidates) {
    const answer = normalizeCspAnswer11(candidate.answer);
    if (!answer) {
      reject("empty");
      continue;
    }
    if (!ANSWER_RE.test(answer)) {
      reject("invalid-characters");
      continue;
    }
    if (answer === themeNorm) {
      reject("theme-answer");
      continue;
    }
    if (!compatibleLengthSet.has(answer.length)) {
      reject("incompatible-length");
      continue;
    }
    if (candidate.source === "filler") {
      reject("generic-filler");
      continue;
    }

    const existing = byAnswer.get(answer);
    if (existing) {
      reject("duplicate");
      if (candidate.thematic && !existing.thematic) {
        byAnswer.set(answer, {
          ...existing,
          thematic: true,
          source: candidate.source ?? existing.source,
          kind: "thematic",
        });
      }
      continue;
    }

    byAnswer.set(answer, {
      answer,
      thematic: Boolean(candidate.thematic),
      source: candidate.source,
      kind: candidate.kind ?? (candidate.thematic ? "thematic" : "support"),
    });
  }

  const candidates = Array.from(byAnswer.values()).sort((a, b) => a.answer.localeCompare(b.answer));
  const stats: CspAdapterStats11 = {
    totalByLength: {},
    thematicByLength: {},
    supportByLength: {},
    rejectedByReason,
  };

  for (const candidate of candidates) {
    const length = candidate.answer.length;
    stats.totalByLength[length] = (stats.totalByLength[length] ?? 0) + 1;
    if (candidate.thematic) {
      stats.thematicByLength[length] = (stats.thematicByLength[length] ?? 0) + 1;
    } else {
      stats.supportByLength[length] = (stats.supportByLength[length] ?? 0) + 1;
    }
  }

  return { candidates, stats, compatibleLengths };
}
