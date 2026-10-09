import type { RawAnswerBank } from "@/app/lib/crosswordTypes";
import { safeJson } from "@/app/lib/crosswordUtils";
import { salvageAnswerStringsFromJson } from "./parseAnswerBank";
import type { RequestAnswerTopUpInput, RequestAnswerTopUpResult } from "./answerPipelineTypes";

// Conservatively accept only the requested top-level {"answers":[... prefix.
// Stop at the first invalid token; never search ahead into unrelated fields.
function salvageSupportAnswers(text: string): string[] {
  let i = 0;
  const whitespace = () => {
    while (i < text.length && /[\t\n\r ]/.test(text[i])) i++;
  };
  const consume = (token: string) => {
    whitespace();
    if (text[i] !== token) return false;
    i++;
    return true;
  };
  const readString = (): string | undefined => {
    whitespace();
    if (text[i] !== '"') return undefined;
    const start = i++;
    while (i < text.length) {
      const ch = text[i++];
      if (ch === "\\") {
        i++; // Skip the escaped character; JSON.parse validates the escape.
      } else if (ch === '"') {
        try {
          return JSON.parse(text.slice(start, i)) as string;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  };

  if (!consume("{") || readString() !== "answers" || !consume(":") || !consume("[")) return [];
  const answers: string[] = [];
  while (i < text.length) {
    const answer = readString();
    if (answer === undefined) break;
    whitespace();
    // A closing quote alone is complete at EOF, but junk following it is not.
    if (i < text.length && text[i] !== "," && text[i] !== "]") break;
    answers.push(answer);
    if (!consume(",")) break;
  }
  return answers;
}

export async function requestAnswerTopUp(input: RequestAnswerTopUpInput): Promise<RequestAnswerTopUpResult> {
  const completion = await input.client.chat.completions.create(input.request);
  const rawText = completion.choices?.[0]?.message?.content ?? "";

  input.logger?.({
    rawText,
    rawText_len: rawText.length,
    rawText_head: rawText.slice(0, 200),
    rawText_tail: rawText.slice(-150),
  });

  const parsed = safeJson<RawAnswerBank>(rawText);
  const hasParsedAnswerArray = parsed !== null && Array.isArray(parsed.answers);
  const parsedAnswers = hasParsedAnswerArray ? (parsed.answers ?? []) : [];
  const salvagedAnswers =
    input.parseMode === "answers-with-salvage" && !hasParsedAnswerArray
      ? salvageAnswerStringsFromJson(rawText)
      : input.parseMode === "support-complete-items" && parsed === null
        ? salvageSupportAnswers(rawText)
        : [];
  const rawForSanitizer =
    hasParsedAnswerArray
      ? parsedAnswers
      : input.parseMode === "answers-with-salvage" || (input.parseMode === "support-complete-items" && parsed === null)
        ? salvagedAnswers
        : undefined;

  return {
    rawText,
    parsedAnswers,
    salvagedAnswers,
    cleanedAnswers: input.sanitize(rawForSanitizer, input.maxLen, input.language),
  };
}
