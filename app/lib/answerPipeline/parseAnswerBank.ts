import type { RawAnswerBank } from "@/app/lib/crosswordTypes";
import { safeJson } from "@/app/lib/crosswordUtils";

export type ParsedUsableAnswerBankText = {
  parsedAnswers: RawAnswerBank | null;
  salvagedAnswers: string[];
  usableParsedAnswers: RawAnswerBank | null;
};

export function salvageAnswerStringsFromJson(text: string): string[] {
  const keyIndex = text.search(/"answers"\s*:/);
  if (keyIndex < 0) return [];

  const start = text.indexOf("[", keyIndex);
  if (start < 0) return [];

  const out: string[] = [];
  let i = start + 1;
  while (i < text.length) {
    const quote = text.indexOf('"', i);
    if (quote < 0) break;

    let j = quote + 1;
    let value = "";
    let escaped = false;
    while (j < text.length) {
      const ch = text[j];
      if (escaped) {
        value += ch;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        break;
      } else {
        value += ch;
      }
      j++;
    }

    if (j >= text.length) break;
    if (value && value !== "answers" && value !== "notes") out.push(value);
    i = j + 1;
  }

  return out;
}

export function parseUsableAnswerBankText(rawAnswersText: string): ParsedUsableAnswerBankText {
  const parsedAnswers = safeJson<RawAnswerBank>(rawAnswersText);
  const salvagedAnswers =
    !parsedAnswers || !Array.isArray(parsedAnswers.answers)
      ? salvageAnswerStringsFromJson(rawAnswersText)
      : [];
  const usableParsedAnswers: RawAnswerBank | null =
    parsedAnswers && Array.isArray(parsedAnswers.answers)
      ? parsedAnswers
      : salvagedAnswers.length > 0
        ? { answers: salvagedAnswers }
        : null;

  return {
    parsedAnswers,
    salvagedAnswers,
    usableParsedAnswers,
  };
}
