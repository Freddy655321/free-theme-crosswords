import type { RawClueBank } from "@/app/lib/crosswordTypes";
import { ASCII_A_TO_Z, normalizeAnswer, safeJson } from "@/app/lib/crosswordUtils";
import type {
  RequestModelCluesInput,
  PublishPipelineLanguage,
} from "./publishPipelineTypes";

export function sanitizeModelClueText(clue: string, language: PublishPipelineLanguage): string {
  let cleaned = clue.replace(/\s+/g, " ").trim();
  if (language === "es") {
    cleaned = cleaned.replace(/^contexto tem[aÃ¡]tico para [^:]+:\s*/i, "").trim();
  } else {
    cleaned = cleaned.replace(/^theme context for [^:]+:\s*/i, "").trim();
  }
  return cleaned;
}

export async function requestModelCluesWithPolicies(opts: RequestModelCluesInput): Promise<Map<string, string>> {
  const { client, theme, language, items, policies } = opts;
  const clueByAnswer = new Map<string, string>();
  const itemsJson = JSON.stringify(items);

  const cluebankRequest =
    opts.cluebankPrompt
      .replace("${theme}", theme)
      .replace("${languageLabel}", language === "es" ? "Spanish" : "English")
      .replace("${itemsJson}", itemsJson) +
    "\n\n" +
    (language === "es"
      ? [
          "REGLAS CRITICAS (OBLIGATORIAS):",
          "- El TEMA elegido es obligatorio y debe influir en TODAS las pistas de los items con thematic:true.",
          "- Si un item incluye un campo hint, ese hint marca la lectura tematica correcta y NO debes degradarla a una lectura generica.",
          "- Si un item incluye un campo note, tomalo como contexto tematico adicional para elegir la pista correcta.",
          "- Si una respuesta admite una lectura generica y otra vinculada al tema, elige SIEMPRE la lectura vinculada al tema.",
          "- NUNCA uses pistas como 'relleno de crucigrama', 'palabra comun' o equivalentes.",
          "- No uses afirmaciones temporales inestables como 'actual', 'ex', 'ultimo', 'hoy' o 'desde' salvo que el hint lo diga.",
          "- Para nombres, apellidos, seudonimos o titulos breves, la pista debe decir explicitamente 'nombre', 'apellido', 'seudonimo' o equivalente.",
          "- Genera pistas para EXACTAMENTE estas respuestas ya colocadas en la grilla.",
          "- NO inventes respuestas nuevas ni hechos especificos dudosos.",
          "- NO uses comodines vacios como 'Palabra' o 'Sobre ...'.",
          "- Si la categoria tematica es clara y segura, usa una pista concreta de esa categoria.",
          "- Si no estas 100% seguro, usa una pista neutra pero descriptiva del dominio del tema.",
          "- Devuelve SOLO JSON valido con { clues: [{ answer, clue }] }.",
        ].join("\n")
      : [
          "CRITICAL RULES (MANDATORY):",
          "- The chosen THEME is mandatory and must shape every clue for items marked thematic:true.",
          "- If an item includes a hint field, that hint defines the correct thematic reading and you must NOT degrade it to a generic meaning.",
          "- If an item includes a note field, treat it as extra thematic context for choosing the right clue.",
          "- If an answer admits both a generic meaning and a theme-specific meaning, ALWAYS choose the theme-specific interpretation.",
          "- NEVER use clues like 'common crossword fill', 'common word', or equivalents.",
          "- Do not use unstable temporal claims like 'current', 'former', 'latest', 'today', or 'since' unless the hint explicitly says so.",
          "- For first names, surnames, stage names, or short titles, the clue must explicitly say 'first name', 'surname', 'stage name', or equivalent.",
          "- Generate clues for EXACTLY these answers already placed in the grid.",
          "- Do NOT invent new answers or doubtful specific facts.",
          "- Do NOT use empty placeholders like 'Word' or 'Related to ...'.",
          "- If the thematic category is clear and safe, use a concrete clue from that category.",
          `- Every thematic clue must include the literal theme name: ${theme}.`,
          "- A generic dictionary definition is invalid. Describe a concrete role the answer can play inside the theme.",
          `- Example: for PEN with theme ${theme}, write 'Tool used when drafting ${theme} lyrics', not 'Writing instrument'.`,
          `- Example: for STAGE with theme ${theme}, write 'Place where ${theme} performs', not 'Raised platform'.`,
          "- If no honest concrete thematic role exists, do not disguise the definition as a thematic clue.",
          "- Return ONLY valid JSON with { clues: [{ answer, clue }] }.",
        ].join("\n"));

  const completionClues = await client.chat.completions.create({
    model: opts.answerbankSearchModel,
    temperature: 0,
    max_tokens: 1600,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No extra text." },
      { role: "user", content: cluebankRequest },
    ],
  });

  const rawCluesText = completionClues.choices?.[0]?.message?.content ?? "";
  const parsedClues = safeJson<RawClueBank>(rawCluesText);

  const looksFactualOrRisky = (clue: string) => {
    const c = clue.toLowerCase();
    return /\b(current|former|latest|today|since)\b/i.test(c);
  };

  if (parsedClues?.clues && Array.isArray(parsedClues.clues)) {
    for (const item of parsedClues.clues) {
      const a = normalizeAnswer(item.answer ?? "");
      const clue = sanitizeModelClueText((item.clue ?? "").toString().trim(), language);
      if (!a || !clue) continue;
      if (!ASCII_A_TO_Z.test(a)) continue;
      if (policies.isBadClue(clue)) continue;
      if (policies.clueMentionsAnswer(clue, a)) continue;
      if (policies.clueMakesUnstableTemporalClaim(clue, language)) continue;
      if (policies.clueMislabelsPartialPersonAnswer(a, clue, language)) continue;
      if (policies.clueMislabelsKnownPartialTitle(theme, a, clue)) continue;
      if (looksFactualOrRisky(clue)) continue;
      if (policies.clueLooksOffTheme(theme, clue)) continue;
      clueByAnswer.set(a, clue);
    }
  }

  const missingItems = items.filter((item) => {
    const a = normalizeAnswer(item.answer);
    return a && !clueByAnswer.has(a);
  });

  if (missingItems.length > 0) {
    const retryPrompt =
      `Return ONLY JSON with { "clues": [{ "answer": string, "clue": string }] }.\n\n` +
      `THEME: ${theme}\nLANGUAGE: ${language === "es" ? "Spanish" : "English"}\n` +
      `Generate concrete, theme-specific crossword clues for exactly these already-placed answers:\n` +
      `${JSON.stringify(missingItems)}\n\n` +
      (language === "es"
        ? [
            "Reglas obligatorias:",
            "- No uses pistas genericas, comodines ni frases como 'relacionado con el tema'.",
            "- No uses 'relleno de crucigrama', 'palabra comun' ni equivalentes.",
            "- No uses afirmaciones temporales inestables como 'actual', 'ex', 'ultimo', 'hoy' o 'desde'.",
            "- Para nombres, apellidos, seudonimos y titulos breves, di explicitamente si es nombre, apellido o seudonimo.",
            "- No menciones la respuesta literal en su propia pista.",
            "- Si no sabes el dato exacto, da una pista descriptiva del dominio tematico, no una definicion de diccionario.",
          ].join("\n")
        : [
            "Mandatory rules:",
            "- Do not use generic placeholders or phrases like 'related to the theme'.",
            "- Do not use 'common crossword fill', 'common word', or equivalents.",
            "- Do not use unstable temporal claims like 'current', 'former', 'latest', 'today', or 'since'.",
            "- For first names, surnames, stage names, and short titles, explicitly say first name, surname, or stage name.",
            "- Do not mention the answer itself in its clue.",
            "- If the exact fact is uncertain, give a domain-specific clue, not a dictionary definition.",
          ].join("\n"));

    try {
      const retry = await client.chat.completions.create({
        model: opts.clueModel,
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return ONLY valid JSON. No extra text." },
          { role: "user", content: retryPrompt },
        ],
      });
      const retryParsed = safeJson<RawClueBank>(retry.choices?.[0]?.message?.content ?? "");
      if (retryParsed?.clues && Array.isArray(retryParsed.clues)) {
        for (const item of retryParsed.clues) {
          const a = normalizeAnswer(item.answer ?? "");
          const clue = sanitizeModelClueText((item.clue ?? "").toString().trim(), language);
          if (!a || !clue || !ASCII_A_TO_Z.test(a)) continue;
          if (policies.isBadClue(clue)) continue;
          if (policies.clueMentionsAnswer(clue, a)) continue;
          if (policies.clueMakesUnstableTemporalClaim(clue, language)) continue;
          if (policies.clueMislabelsPartialPersonAnswer(a, clue, language)) continue;
          if (policies.clueMislabelsKnownPartialTitle(theme, a, clue)) continue;
          if (looksFactualOrRisky(clue)) continue;
          if (policies.clueLooksOffTheme(theme, clue)) continue;
          clueByAnswer.set(a, clue);
        }
      }
    } catch (error: unknown) {
      policies.warnClueRetryFailed({
        name: error instanceof Error ? error.name : "unknown",
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return clueByAnswer;
}
