export type CspReservoirInputCandidate11 = {
  answer: string;
  thematic: boolean;
  source: "anchor" | "model" | "support" | "filler";
};

export type CspCandidateReservoirExcluded11 = {
  answer: string;
  reason:
    | "empty"
    | "invalid-characters"
    | "too-short"
    | "too-long"
    | "duplicate"
    | "exact-theme"
    | "incompatible-length"
    | "not-thematic"
    | "unsupported-source"
    | "not-in-thematic-keep"
    | "per-length-cap";
};

export type CspCandidateReservoir11 = {
  candidates: CspReservoirInputCandidate11[];
  distributionByLength: Record<number, number>;
  excluded: CspCandidateReservoirExcluded11[];
};

const ANSWER_RE = /^[A-Z0-9]+$/;
const DEFAULT_PER_LENGTH_LIMIT = 80;

export function normalizeCspReservoirAnswer11(answer: string | null | undefined): string {
  if (!answer) return "";
  return answer
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function buildCspCandidateReservoir11(opts: {
  candidates: CspReservoirInputCandidate11[];
  thematicKeep: Set<string>;
  theme: string;
  requiredLengths: number[];
  perLengthLimit?: number;
}): CspCandidateReservoir11 {
  const requiredLengths = new Set(opts.requiredLengths.filter((length) => length >= 3 && length <= 11));
  const themeNorm = normalizeCspReservoirAnswer11(opts.theme);
  const thematicKeep = new Set(Array.from(opts.thematicKeep, normalizeCspReservoirAnswer11).filter(Boolean));
  const perLengthLimit = opts.perLengthLimit ?? DEFAULT_PER_LENGTH_LIMIT;
  const acceptedByAnswer = new Map<string, CspReservoirInputCandidate11>();
  const acceptedCountByLength = new Map<number, number>();
  const excluded: CspCandidateReservoirExcluded11[] = [];

  const reject = (answer: string, reason: CspCandidateReservoirExcluded11["reason"]) => {
    excluded.push({ answer, reason });
  };

  for (const candidate of opts.candidates) {
    const answer = normalizeCspReservoirAnswer11(candidate.answer);
    if (!answer) {
      reject(answer, "empty");
      continue;
    }
    if (!ANSWER_RE.test(answer)) {
      reject(answer, "invalid-characters");
      continue;
    }
    if (answer.length < 3) {
      reject(answer, "too-short");
      continue;
    }
    if (answer.length > 11) {
      reject(answer, "too-long");
      continue;
    }
    if (answer === themeNorm) {
      reject(answer, "exact-theme");
      continue;
    }
    if (!requiredLengths.has(answer.length)) {
      reject(answer, "incompatible-length");
      continue;
    }
    if (!candidate.thematic) {
      reject(answer, "not-thematic");
      continue;
    }
    if (candidate.source !== "anchor" && candidate.source !== "model") {
      reject(answer, "unsupported-source");
      continue;
    }
    if (candidate.source !== "anchor" && !thematicKeep.has(answer)) {
      reject(answer, "not-in-thematic-keep");
      continue;
    }

    const existing = acceptedByAnswer.get(answer);
    if (existing) {
      reject(answer, "duplicate");
      if (sourceRank(candidate.source) < sourceRank(existing.source)) {
        acceptedByAnswer.set(answer, {
          answer,
          thematic: true,
          source: candidate.source,
        });
      }
      continue;
    }

    const countForLength = acceptedCountByLength.get(answer.length) ?? 0;
    if (countForLength >= perLengthLimit) {
      reject(answer, "per-length-cap");
      continue;
    }

    acceptedByAnswer.set(answer, {
      answer,
      thematic: true,
      source: candidate.source,
    });
    acceptedCountByLength.set(answer.length, countForLength + 1);
  }

  const candidates = Array.from(acceptedByAnswer.values()).sort(compareReservoirCandidates);
  return {
    candidates,
    distributionByLength: countByLength(candidates),
    excluded,
  };
}

export function cspRequiredLengthsFromPatterns11(
  patterns: Array<{ rows: string[]; metadata?: { lengths?: Record<number, number> } }>
): number[] {
  const lengths = new Set<number>();
  for (const pattern of patterns) {
    if (pattern.metadata?.lengths) {
      for (const lengthKey of Object.keys(pattern.metadata.lengths)) {
        const length = Number(lengthKey);
        if (Number.isInteger(length)) lengths.add(length);
      }
      continue;
    }
    for (const row of pattern.rows) {
      for (const run of row.split("#")) {
        if (run.length >= 3) lengths.add(run.length);
      }
    }
  }
  return Array.from(lengths).sort((a, b) => a - b);
}

function compareReservoirCandidates(a: CspReservoirInputCandidate11, b: CspReservoirInputCandidate11): number {
  const sourceDiff = sourceRank(a.source) - sourceRank(b.source);
  if (sourceDiff !== 0) return sourceDiff;
  if (a.thematic !== b.thematic) return a.thematic ? -1 : 1;
  if (a.answer.length !== b.answer.length) return a.answer.length - b.answer.length;
  return a.answer.localeCompare(b.answer);
}

function sourceRank(source: CspReservoirInputCandidate11["source"]): number {
  if (source === "anchor") return 0;
  if (source === "model") return 1;
  if (source === "support") return 2;
  return 3;
}

function countByLength(candidates: CspReservoirInputCandidate11[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const candidate of candidates) {
    out[candidate.answer.length] = (out[candidate.answer.length] ?? 0) + 1;
  }
  return out;
}
