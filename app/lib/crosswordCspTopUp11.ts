import { normalizeCspAnswer11, type CspAdapterInputCandidate } from "./crosswordCspAdapter11";

export type CspLengthTopUpRequest11 = {
  theme: string;
  language: "es" | "en";
  existingAnswers: string[];
  requestedByLength: Record<number, number>;
  attempt: number;
};

export type CspLengthTopUpParsed11 = {
  candidates: CspAdapterInputCandidate[];
  rejectedByReason: Record<string, number>;
  requestedByLength: Record<number, number>;
};

type RawTopUpResponse = {
  byLength?: Record<string, unknown>;
  answers?: unknown;
};

export function buildCspLengthTopUpPrompt11(opts: CspLengthTopUpRequest11): string {
  const requested = Object.entries(opts.requestedByLength)
    .map(([length, count]) => `${length}: ${count}`)
    .join(", ");
  const languageLabel = opts.language === "es" ? "Spanish" : "English";

  return [
    'Return ONLY JSON shaped as {"byLength":{"4":["WORD"],"5":["WORDS"]}}.',
    "",
    "Generate new crossword answers for a fixed 11x11 themed crossword.",
    `Theme: ${opts.theme}`,
    `Language: ${languageLabel}`,
    `Requested exact normalized lengths: ${requested}`,
    "",
    "Hard rules:",
    "- Works for any user theme; do not assume a domain.",
    "- Every answer must be real, complete, standalone, and directly specific to the theme.",
    "- Every answer must already be uppercase A-Z or digits only.",
    "- No spaces, hyphens, accents, punctuation, abbreviations, initials, fragments, truncations, or invented compounds.",
    "- Do not include the full theme as an answer.",
    "- Do not repeat any existing answer.",
    "- Do not invent terms to satisfy a length; return fewer if necessary.",
    "- Group each answer under its exact requested length key.",
    "- No extra keys, notes, clues, or explanations.",
    "",
    `Existing answers: ${opts.existingAnswers.map(normalizeCspAnswer11).filter(Boolean).join(", ")}`,
    `Top-up attempt: ${opts.attempt}`,
  ].join("\n");
}

export function parseCspLengthTopUpResponse11(
  rawText: string,
  opts: CspLengthTopUpRequest11
): CspLengthTopUpParsed11 {
  const requestedByLength = normalizeRequestedByLength(opts.requestedByLength);
  const requestedLengths = new Set(Object.keys(requestedByLength).map(Number));
  const existing = new Set(opts.existingAnswers.map(normalizeCspAnswer11).filter(Boolean));
  const themeNorm = normalizeCspAnswer11(opts.theme);
  const seen = new Set(existing);
  const rejectedByReason: Record<string, number> = {};
  const candidates: CspAdapterInputCandidate[] = [];

  const reject = (reason: string) => {
    rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1;
  };

  const parsed = safeJson<RawTopUpResponse>(rawText);
  const valuesByLength = new Map<number, unknown[]>();

  if (parsed?.byLength && typeof parsed.byLength === "object") {
    for (const [lengthKey, value] of Object.entries(parsed.byLength)) {
      const length = Number(lengthKey);
      if (!Number.isInteger(length)) continue;
      valuesByLength.set(length, Array.isArray(value) ? value : []);
    }
  } else if (Array.isArray(parsed?.answers)) {
    valuesByLength.set(0, parsed.answers);
  } else {
    reject("parse-failed");
  }

  for (const [declaredLength, values] of valuesByLength) {
    for (const value of values) {
      const answer = normalizeCspAnswer11(String(value ?? ""));
      const length = declaredLength > 0 ? declaredLength : answer.length;
      if (!answer) {
        reject("empty");
        continue;
      }
      if (!requestedLengths.has(length)) {
        reject("unrequested-length");
        continue;
      }
      if (answer.length !== length) {
        reject("wrong-length");
        continue;
      }
      if (answer === themeNorm) {
        reject("theme-answer");
        continue;
      }
      if (seen.has(answer)) {
        reject("duplicate");
        continue;
      }
      seen.add(answer);
      candidates.push({ answer, thematic: true, source: "model" });
    }
  }

  return { candidates, rejectedByReason, requestedByLength };
}

export async function requestCspLengthTopUpAnswers11(opts: CspLengthTopUpRequest11 & {
  completeJson: (prompt: string) => Promise<string>;
}): Promise<CspLengthTopUpParsed11> {
  const prompt = buildCspLengthTopUpPrompt11(opts);
  const rawText = await opts.completeJson(prompt);
  return parseCspLengthTopUpResponse11(rawText, opts);
}

function normalizeRequestedByLength(requestedByLength: Record<number, number>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [lengthKey, count] of Object.entries(requestedByLength)) {
    const length = Number(lengthKey);
    if (!Number.isInteger(length) || length < 3 || count <= 0) continue;
    out[length] = Math.ceil(count);
  }
  return out;
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
