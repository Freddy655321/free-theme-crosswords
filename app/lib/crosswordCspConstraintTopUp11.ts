import { normalizeCspAnswer11, type CspAdapterInputCandidate } from "./crosswordCspAdapter11";
import type { CspPropagationConflict11, CspPropagationConflictSummaryItem11 } from "./crosswordCsp11";

export type CspConstraintTopUpConstraint11 = {
  position: number;
  allowedLetters?: string[];
  requiredLetter?: string;
};

export type CspConstraintTopUpRequest11 = {
  requestId: string;
  length: number;
  constraints: CspConstraintTopUpConstraint11[];
  count: number;
};

export type CspConstraintTopUpRequestInput11 = {
  theme: string;
  language: "es" | "en";
  requests: CspConstraintTopUpRequest11[];
  excludedAnswers: string[];
  attempt: number;
};

export type CspConstraintTopUpParsed11 = {
  candidates: CspAdapterInputCandidate[];
  rejectedByReason: Record<string, number>;
  acceptedByRequestId: Record<string, string[]>;
};

type RawConstraintTopUpResponse = {
  groups?: unknown;
};

export function buildConstraintTopUpRequestsFromConflicts11(opts: {
  conflicts: CspPropagationConflict11[];
  summaries?: CspPropagationConflictSummaryItem11[];
  maxRequests?: number;
  maxFixedLetters?: number;
  countPerRequest?: number;
}): CspConstraintTopUpRequest11[] {
  const maxRequests = opts.maxRequests ?? 3;
  const maxFixedLetters = opts.maxFixedLetters ?? 3;
  const countPerRequest = opts.countPerRequest ?? 8;
  const byPattern = new Map<string, { conflict: CspPropagationConflict11; occurrences: number }>();

  for (const conflict of opts.conflicts) {
    const key = conflictKey(conflict);
    const current = byPattern.get(key);
    if (current) current.occurrences++;
    else byPattern.set(key, { conflict, occurrences: 1 });
  }

  for (const summary of opts.summaries ?? []) {
    const existing = [...byPattern.values()].find(
      (item) =>
        item.conflict.emptiedSlotLength === summary.slotLength &&
        requiredPatternForConflict(item.conflict) === summary.requiredPattern
    );
    if (existing) existing.occurrences += summary.occurrences;
  }

  return [...byPattern.values()]
    .sort((a, b) => b.occurrences - a.occurrences || a.conflict.emptiedSlotLength - b.conflict.emptiedSlotLength)
    .slice(0, maxRequests)
    .map(({ conflict }) => {
      const constraints = mostInformativeConstraints(conflict, maxFixedLetters).map((constraint) => ({
        position: constraint.position,
        requiredLetter: constraint.requiredLetter,
      }));
      return {
        requestId: requestIdFor(conflict.emptiedSlotLength, constraints),
        length: conflict.emptiedSlotLength,
        constraints,
        count: countPerRequest,
      };
    });
}

export function buildCspConstraintTopUpPrompt11(opts: CspConstraintTopUpRequestInput11): string {
  const languageLabel = opts.language === "es" ? "Spanish" : "English";
  const requests = opts.requests.map((request) => ({
    requestId: request.requestId,
    length: request.length,
    count: request.count,
    constraints: request.constraints.map((constraint) => ({
      position: constraint.position,
      requiredLetter: constraint.requiredLetter,
      allowedLetters: constraint.allowedLetters,
    })),
  }));

  return [
    'Return ONLY JSON shaped as {"groups":[{"requestId":"len6-p1A","answers":["ANSWER"]}]}.',
    "",
    "Generate constrained crossword answers for a fixed 11x11 themed crossword.",
    `Theme: ${opts.theme}`,
    `Language: ${languageLabel}`,
    "Positions are zero-based indexes: position 0 is the first character.",
    `Requests: ${JSON.stringify(requests)}`,
    "",
    "Hard rules:",
    "- Works for any user theme; do not assume a domain.",
    "- Every answer must be real, complete, standalone, and directly specific to the theme.",
    "- Every answer must have exactly the requested normalized length.",
    "- Every required letter must appear at the exact zero-based position requested.",
    "- Every answer must already be uppercase A-Z or digits only.",
    "- No spaces, hyphens, accents, punctuation, abbreviations, initials, fragments, truncations, or invented compounds.",
    "- Do not include the full theme as an answer.",
    "- Do not repeat any excluded answer.",
    "- Do not invent terms to satisfy a constraint; return fewer if necessary.",
    "- Preserve requestId in each response group.",
    "- No extra keys, notes, clues, or explanations.",
    "",
    `Excluded answers: ${opts.excludedAnswers.map(normalizeCspAnswer11).filter(Boolean).join(", ")}`,
    `Top-up attempt: ${opts.attempt}`,
  ].join("\n");
}

export function parseCspConstraintTopUpResponse11(
  rawText: string,
  opts: CspConstraintTopUpRequestInput11
): CspConstraintTopUpParsed11 {
  const requestById = new Map(opts.requests.map((request) => [request.requestId, request]));
  const existing = new Set(opts.excludedAnswers.map(normalizeCspAnswer11).filter(Boolean));
  const themeNorm = normalizeCspAnswer11(opts.theme);
  const seen = new Set(existing);
  const rejectedByReason: Record<string, number> = {};
  const acceptedByRequestId: Record<string, string[]> = {};
  const candidates: CspAdapterInputCandidate[] = [];
  const parsed = safeJson<RawConstraintTopUpResponse>(rawText);

  const reject = (reason: string) => {
    rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1;
  };

  if (!parsed || !Array.isArray(parsed.groups)) {
    reject("parse-failed");
    return { candidates, rejectedByReason, acceptedByRequestId };
  }

  for (const group of parsed.groups) {
    if (!group || typeof group !== "object") {
      reject("invalid-group");
      continue;
    }
    const requestId = String((group as { requestId?: unknown }).requestId ?? "");
    const request = requestById.get(requestId);
    const answers = (group as { answers?: unknown }).answers;
    if (!request || !Array.isArray(answers)) {
      reject("unknown-request");
      continue;
    }

    for (const rawAnswer of answers) {
      const answer = normalizeCspAnswer11(String(rawAnswer ?? ""));
      const issue = validateConstrainedAnswer11(answer, request, themeNorm, seen);
      if (issue) {
        reject(issue);
        continue;
      }
      seen.add(answer);
      candidates.push({ answer, thematic: true, source: "model" });
      const accepted = acceptedByRequestId[request.requestId] ?? [];
      accepted.push(answer);
      acceptedByRequestId[request.requestId] = accepted;
    }
  }

  return { candidates, rejectedByReason, acceptedByRequestId };
}

export async function requestCspConstraintTopUpAnswers11(
  opts: CspConstraintTopUpRequestInput11 & {
    completeJson: (prompt: string) => Promise<string>;
  }
): Promise<CspConstraintTopUpParsed11> {
  const prompt = buildCspConstraintTopUpPrompt11(opts);
  const rawText = await opts.completeJson(prompt);
  return parseCspConstraintTopUpResponse11(rawText, opts);
}

export function validateConstrainedAnswer11(
  answer: string,
  request: CspConstraintTopUpRequest11,
  themeNorm: string,
  seenAnswers: Set<string>
): string | null {
  if (!answer) return "empty";
  if (answer.length !== request.length) return "wrong-length";
  if (answer === themeNorm) return "theme-answer";
  if (seenAnswers.has(answer)) return "duplicate";
  for (const constraint of request.constraints) {
    const letter = answer[constraint.position];
    if (constraint.requiredLetter && letter !== constraint.requiredLetter) return "position-mismatch";
    if (constraint.allowedLetters && !constraint.allowedLetters.includes(letter ?? "")) return "position-mismatch";
  }
  return null;
}

function mostInformativeConstraints(
  conflict: CspPropagationConflict11,
  maxFixedLetters: number
): Array<{ position: number; requiredLetter: string; score: number }> {
  const byPosition = new Map<number, { position: number; requiredLetter: string; score: number }>();

  for (const constraint of conflict.constraints) {
    const reductions = conflict.candidateCountBeforeEachConstraint.filter(
      (item) => item.position === constraint.position && item.requiredLetter === constraint.requiredLetter
    );
    const score =
      reductions.reduce((sum, item) => sum + Math.max(0, item.before - item.after), 0) +
      reductions.reduce((sum, item) => sum + (item.after === 0 ? 1000 : 0), 0);
    const current = byPosition.get(constraint.position);
    if (!current || score > current.score) {
      byPosition.set(constraint.position, {
        position: constraint.position,
        requiredLetter: constraint.requiredLetter,
        score,
      });
    }
  }

  return [...byPosition.values()]
    .sort((a, b) => b.score - a.score || a.position - b.position || a.requiredLetter.localeCompare(b.requiredLetter))
    .slice(0, maxFixedLetters)
    .sort((a, b) => a.position - b.position);
}

function requestIdFor(
  length: number,
  constraints: Array<{ position: number; requiredLetter?: string; allowedLetters?: string[] }>
): string {
  const suffix = constraints
    .map((constraint) => {
      const letters = constraint.requiredLetter ?? constraint.allowedLetters?.join("") ?? "";
      return `p${constraint.position}${letters}`;
    })
    .join("-");
  return `len${length}${suffix ? `-${suffix}` : ""}`;
}

function conflictKey(conflict: CspPropagationConflict11): string {
  return `${conflict.emptiedSlotLength}:${requiredPatternForConflict(conflict)}`;
}

function requiredPatternForConflict(conflict: CspPropagationConflict11): string {
  const pattern = Array.from({ length: conflict.emptiedSlotLength }, () => "_");
  for (const constraint of conflict.constraints) pattern[constraint.position] = constraint.requiredLetter;
  return pattern.join("");
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
