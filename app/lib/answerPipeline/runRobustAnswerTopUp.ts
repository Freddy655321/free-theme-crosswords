import type { RunRobustAnswerTopUpInput } from "./answerPipelineTypes";

export async function runRobustAnswerTopUp(input: RunRobustAnswerTopUpInput): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>(input.existing.map((answer) => input.normalizeKey(answer)));

  let chunk = Math.min(input.size === 11 ? 18 : 24, input.need);
  const maxTries = input.size === 11 ? 4 : 4;
  for (let tries = 0; tries < maxTries && out.length < input.need; tries++) {
    const want = Math.min(chunk, input.need - out.length);

    const more = await input.requestBatch({
      existing: Array.from(seen),
      need: want,
      tryIndex: tries,
    });

    if (more.length === 0) {
      chunk = Math.max(5, Math.floor(chunk / 2));
      continue;
    }

    for (const answer of more) {
      const norm = input.normalizeKey(answer);
      if (!norm) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
      if (out.length >= input.need) break;
    }
  }

  return out;
}
