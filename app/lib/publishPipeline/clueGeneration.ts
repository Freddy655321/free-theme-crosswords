import type { RawClueBank } from "@/app/lib/crosswordTypes";
import { ASCII_A_TO_Z, normalizeAnswer, safeJson } from "@/app/lib/crosswordUtils";
import type {
  CreateRequestModelCluesServiceInput,
  RequestModelCluesInput,
  RequestModelCluesService,
  PublishPipelineLanguage,
} from "./publishPipelineTypes";

export const CLUEBANK_PROMPT = `
You are a crossword editor.

Return ONLY a JSON object with this schema:
{
  "clues": [
    { "answer": string, "clue": string }
  ]
}

INPUT FORMAT:
You will receive a JSON array named ITEMS where each item is:
{ "answer": string, "thematic": boolean }

Hard rules:
- Output JSON ONLY. No markdown. No commentary.
- Each "answer" MUST match an input item "answer" EXACTLY (UPPERCASE A–Z and digits if present).
- Each "clue" must be in the requested LANGUAGE and must read like a real crossword clue.
- Keep each clue SHORT (max 55 characters).
- Do NOT include the answer text (or obvious substrings) in the clue.
- Do NOT use placeholder text like "Thematic entry" or "Definition".

CRITICAL FACTUALITY RULE:
- Never invent song titles, track lists, album contents, dates, or specific claims.
- If you are not 100% sure about a specific fact, write a safer, non-specific clue.

THEME POLICY (depends on thematic flag):
- If thematic=true: the clue MUST mention the theme (directly or by clear band/album/mascot context),
  but must stay FACTUAL. If unsure, use safe clues like "Megadeth album title" / "Megadeth mascot" /
  "Megadeth-related term" rather than a specific (possibly false) claim.
- If thematic=true for a place theme, prefer a factual local clue: lake, hill, neighborhood, route, activity,
  food, flora/fauna, province, region, or landmark associated with the place. Do NOT use a generic dictionary
  clue when the answer was selected as thematic.
- If thematic=false: the clue MUST be a normal general crossword clue (definition/synonym),
  and MUST NOT claim it is a song/album/member/etc. Do NOT mention album names or “track from…”.

Now produce one clue per input item.

THEME: \${theme}
LANGUAGE: \${languageLabel}
ITEMS:
\${itemsJson}
`;

export const CLUE_MODEL = process.env.OPENAI_CLUE_MODEL ?? "gpt-4o-mini";

export function isPlaceholderClue(clue: string, language: PublishPipelineLanguage): boolean {
  const c = clue.trim().toLowerCase();
  if (!c) return true;

  if (language === "en") {
    if (c === "brief definition.") return true;
    if (/^short definition/.test(c)) return true;
    if (/^common word/.test(c)) return true;
    if (/^themed entry/.test(c)) return true;
    if (/^theme context for /.test(c)) return true;
    if (/^word \(\d+ letters\)/.test(c)) return true;
    if (c === "place associated with california") return true;
    if (c === "california-related entry") return true;
    if (/^california entry/.test(c)) return true;
  } else {
    if (c === "definiciÃ³n breve." || c === "definicion breve.") return true;
    if (/^contexto tem[aÃ¡]tico para /.test(c)) return true;
    if (/^entrada com[uÃƒÂº]n de crucigrama/.test(c)) return true;
    if (/^sobre .+\(\d+ letras\)$/.test(c)) return true;
    if (/^palabra\b/.test(c)) return true;
    if (/^sobre [^,.;:!?]+$/.test(c)) return true;
    if (/^entrada tematica\b/.test(c) || /^entrada temÃ¡tica\b/.test(c)) return true;
  }

  return false;
}

export function isGenericThematicClue(clue: string): boolean {
  const lower = clue.toLowerCase().trim();
  if (lower === "pista temática." || lower === "pista tematica.") return true;
  if (lower === "thematic entry." || lower === "thematic entry") return true;
  if (lower.startsWith("thematic entry related to")) return true;
  if (lower.startsWith("term related to")) return true;
  if (lower.startsWith("término relacionado con")) return true;
  if (lower.includes("related to the theme")) return true;
  if (lower.includes("relacionado con el tema")) return true;
  if (lower.startsWith("palabra relacionada con")) return true;
  if (/^regi[oó]n relacionada con\b/.test(lower)) return true;
  if (/^referencia (local )?asociada con\b/.test(lower)) return true;
  if (/^local reference associated with\b/.test(lower)) return true;
  if (/^concrete reference associated with\b/.test(lower)) return true;
  return false;
}

export function clueLooksWeakGeneratedFallback(clue: string, language: PublishPipelineLanguage): boolean {
  const c = clue
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  if (language === "es") {
    return (
      /^respuesta tematica especifica y verificable\b/.test(c) ||
      /^respuesta tematica especifica\b/.test(c) ||
      /^definicion breve\.?$/.test(c) ||
      /^nombre propio asociado con\b/.test(c) ||
      /^sitio natural relacionado con\b/.test(c) ||
      /^lugar asociado con\b/.test(c) ||
      /^referencia concreta asociada con\b/.test(c) ||
      /^referencia local documentada en fuentes sobre\b/.test(c) ||
      /^referencia asociada con\b/.test(c)
    );
  }

  return (
    /^specific,?\s+verifiable\s+themed?\s+answer\b/.test(c) ||
    /^specific verifiable thematic answer\b/.test(c) ||
    /^specific thematic answer\b/.test(c) ||
    /^thematic fact linked to\b/.test(c) ||
    /^element associated with\b/.test(c) ||
    /^a term related to\b/.test(c) ||
    /^[a-z0-9 ]+-related term\b/.test(c) ||
    /^named thematic item from\b/.test(c) ||
    /^supporting term for\b/.test(c) ||
    /^related to [a-z0-9 ]+\.?$/.test(c) ||
    /^brief definition\.?$/.test(c) ||
    /^proper name associated with\b/.test(c) ||
    /^natural site related to\b/.test(c) ||
    /^place associated with\b/.test(c) ||
    /^concrete reference associated with\b/.test(c) ||
    /^documented local reference in sources about\b/.test(c) ||
    /^reference associated with\b/.test(c)
  );
}

export function isBadClue(clue: string): boolean {
  const c = clue.trim();
  if (c.length < 3) return true;
  if (isGenericThematicClue(c)) return true;
  if (clueLooksWeakGeneratedFallback(c, "es") || clueLooksWeakGeneratedFallback(c, "en")) return true;
  if (/common crossword fill/i.test(c) || /crossword fill/i.test(c) || /common word/i.test(c)) return true;
  if (/^common (male|female|given|first) name\b/i.test(c)) return true;
  if (/^nombre (masculino|femenino|comun|común)\b/i.test(c)) return true;
  if (/^pista temática/i.test(c)) return true;
  if (/^pista pendiente/i.test(c)) return true;
  return false;
}

export function clueMentionsAnswer(clue: string, answer: string): boolean {
  const lowerClue = clue.toLowerCase();
  const lowerAns = answer.toLowerCase();
  if (lowerAns.length <= 3) return false;
  return lowerClue.includes(lowerAns);
}

export function clueLanguageLooksValid(clue: string, language: PublishPipelineLanguage): boolean {
  const c = clue.toLowerCase();
  if (language === "es") {
    return !/\b(the|of|for|from|near|known|popular|hiking|mountain|skiing|lake|river|word|entry|coastal|areas|explore|museum|showcasing|history|fishing|pastime|historical|figure|summer|snow|snow-covered|peaks|visitors|specific|region|company|based|high-tech|tech)\b/.test(c);
  }

  return !/\b(el|la|los|las|de|del|para|cerca|conocido|popular|cerro|lago|rio|rÃ­o)\b/.test(c);
}

export function sanitizeModelClueText(clue: string, language: PublishPipelineLanguage): string {
  let cleaned = clue.replace(/\s+/g, " ").trim();
  if (language === "es") {
    cleaned = cleaned.replace(/^contexto tem[aÃ¡]tico para [^:]+:\s*/i, "").trim();
  } else {
    cleaned = cleaned.replace(/^theme context for [^:]+:\s*/i, "").trim();
  }
  return cleaned;
}

export function createRequestModelCluesService(
  opts: CreateRequestModelCluesServiceInput
): RequestModelCluesService {
  return ({ client, theme, language, items }) =>
    requestModelCluesWithPolicies({
      client,
      theme,
      language,
      items,
      cluebankPrompt: CLUEBANK_PROMPT,
      answerbankSearchModel: opts.answerbankSearchModel,
      clueModel: opts.clueModel,
      policies: opts.policies,
    });
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
