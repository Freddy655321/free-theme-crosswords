import type { RawAnswerBank } from "@/app/lib/crosswordTypes";
import { safeJson } from "@/app/lib/crosswordUtils";
import { salvageAnswerStringsFromJson } from "./parseAnswerBank";
import type { RequestAnswerTopUpInput, RequestAnswerTopUpResult } from "./answerPipelineTypes";

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
      : [];
  const rawForSanitizer =
    hasParsedAnswerArray
      ? parsedAnswers
      : input.parseMode === "answers-with-salvage"
        ? salvagedAnswers
        : undefined;

  return {
    rawText,
    parsedAnswers,
    salvagedAnswers,
    cleanedAnswers: input.sanitize(rawForSanitizer, input.maxLen, input.language),
  };
}
