import { requestAnswerTopUp } from "@/app/lib/answerPipeline";
import { safeJson } from "@/app/lib/crosswordUtils";
import type {
  AnswerbankTextResult,
  BuildAnswerbankRequestInput,
  GenerateLengthBalancedThematicAnswersInput,
  GenerateSupportWordsInput,
  OpenAiGenerationClient,
  OpenAiGenerationCompletion,
  OpenAiGenerationRequestArgs,
  RequestAnswerbankTextInput,
  RequestCompactAnswerbankTextInput,
  RequestLengthBucketedAnswerbankTextInput,
  RequestTopUpAnswersInput,
} from "./openaiGenerationTypes";

function createChatCompletion(
  client: OpenAiGenerationClient,
  request: OpenAiGenerationRequestArgs
): Promise<OpenAiGenerationCompletion> {
  const create = client.chat.completions.create as unknown as (
    args: OpenAiGenerationRequestArgs
  ) => Promise<OpenAiGenerationCompletion>;
  return create(request);
}

export function buildAnswerbankPrompt(targetAnswers: number): string {
  return `
You are generating a THEMATIC crossword answer bank.

Return ONLY a JSON object with this exact schema:

{
  "answers": string[],
  "notes": [{ "answer": string, "note": string }]
}

Rules:

- Generate EXACTLY ${targetAnswers} answers in the first response.
- If the theme has many names, titles, places, works, people, terms, or related entities, use that breadth to reach ${targetAnswers}.
- "answers" must be uppercase A-Z (and digits if needed).
- Every answer MUST be strongly tied to the THEME.
- Every answer MUST be a standalone crossword-ready entry.
- Every answer MUST fit in the requested grid size.
- Avoid generic filler words unless unavoidable.
- DO NOT include definitions.
- DO NOT include commentary.
- JSON only.
- Include one short note for EVERY answer. Each note must be at most 10 words.
- Each note must explain the factual connection to the theme.
- If you cannot write a factual theme note for an answer, do not include that answer.
- Notes should be factual and based on widely reputable general knowledge sources such as encyclopedias,
  official tourism pages, museum/venue pages, or other reliable references. Do not invent local facts.

CRITICAL ENTRY QUALITY RULES:
- Each answer must be a real, complete, self-contained term that a crossword solver could reasonably expect.
- Do NOT output abbreviations, airport codes, postal codes, acronyms, initials, nicknames, or shorthand forms unless they are universally recognized standalone entries.
- Do NOT output fragments, clipped forms, prefixes, suffixes, chopped place names, partial names, or shortened pieces of a longer word or phrase.
- Do NOT output partial city names, partial region names, or truncated versions of proper nouns.
- Do NOT output a substring of a better full answer.
- If the complete term is longer than the current grid, skip it. Never return a shortened fake form.
- Reject stems and chopped words such as NATUR, CARNI, CULTU, CASC, CUMB, CICL, MONT, NEVE, AVENT.
- Prefer complete nouns, place names, demonyms, landmarks, titles, products, dishes, animals, concepts, etc.
- If an answer would normally contain spaces or punctuation, normalize it into a full crossword entry only if the full term is still clearly recognizable and complete.
- Bad examples: SFO, LAX, SONO, PALO, MEND, SACRAM, SD, LA, OC.
- Good examples: SONOMA, PALOALTO, MENDOCINO, SACRAMENTO, SANDIEGO, LOSANGELES.

DIVERSITY RULES:
- Prefer complete theme-specific answers over short generic answers.
- For 11x11, use complete entries of length 3-11 only. At least 55 answers should be 3-8 letters when the theme has enough good short entries.
- Include a mix of lengths, but never invent stems or generic filler just to create short answers.
- For places, prioritize landmarks, lakes, mountains, neighborhoods, routes, foods, flora/fauna, local culture, activities, and tourism terms that are specifically associated with the place.
- For geographic names with generic prefixes, prefer the distinctive standalone part when it is commonly used and fits better: MORENO instead of LAGOMORENO, OTTO instead of CERROOTTO, CATEDRAL instead of CERROCATEDRAL.
- Do not fabricate template-like names such as CERROAZUL or LAGOFONTANA unless they are real and important to the requested theme.
- Do not fabricate or keep doubtful geographic compounds such as LAGOSOL, LAGOBLANCO, LAGOHERMOSO, LAGOLIMPIO, LAGOSILVINA, LAGOTRANCAS, LAGOVIEDMA, CERROVERDE, or CERROAZUL unless the exact full name is a reputable, notable match for the requested theme.
- For place themes, DO NOT over-list entries with the same prefix. Avoid returning many LAGO... or CERRO... answers. Cover many categories: landmarks, activities, food, climate, flora, fauna, routes, nearby places, tourism, culture.
- For place themes, at least half of the answers should NOT start with generic geographic prefixes like LAGO, CERRO, RIO, ISLA, PUERTO, VILLA, COLONIA, PARQUE, MONTE.
- For place themes, no more than 8 total answers may start with LAGO or CERRO combined.
- For place themes, include at least 25 short entries of length 3-8 from varied real categories when true for the place: weather, outdoor sports, food/drink, flora, fauna, landscape nouns, local culture, tourism activities, and distinctive nearby names.
- For place themes, include complete short thematic terms that are broadly but strongly characteristic of the place when they are true: local foods, animals, plants, activities, weather terms, landmarks, and famous local names.
- Prefer famous/relevant names over obscure or doubtful names.
- For artists, bands, books, films, historical events, or brands, prioritize names, works, characters, places, members, concepts, objects, and terms that are specifically associated with the theme.
- Avoid generic words like COLOR, BLUE, TRAVEL, SOUL, HOME, BASE, ART, MARKET, TOWER, COFFEE unless they are the actual complete name of a theme-specific entity.
- Avoid returning too many entries that are nearly the same pattern or same root.
- Do NOT include clues or explanations outside JSON.
- Return compact one-line JSON. Do not pretty-print.

THEME: \${theme}
LANGUAGE: \${languageLabel}

`;
}

export function buildAnswerbankRequest(input: BuildAnswerbankRequestInput): string {
  const { theme, language, size, targetAnswers } = input;
  const languageLabel = language === "es" ? "Spanish" : "English";
  const anchors = input
    .getThemeAnchors(theme)
    .map((anchor) => input.normalizeAnswer(anchor))
    .filter(Boolean)
    .slice(0, 40);

  return `
THEME: ${theme}
LANGUAGE: ${languageLabel}
SIZE: ${size}

Answer count:
- Generate EXACTLY ${targetAnswers} answers.
- Return answers plus matching notes for every answer. Do not include clues in this response.

Length:
- Prefer many complete theme-specific terms that fit within ${size} letters, because those can be placed in this grid.
- Do NOT include answers longer than ${size}; they cannot be placed in this grid.
- Output tokens MUST be normalized: ONLY A-Z and digits (NO spaces/hyphens).
- Never truncate longer thematic terms. If an important term is longer than ${size}, skip it instead of inventing fragments.
- Bad truncated examples: NATUR, CARNI, CULTU, CASC, CUMB, CICL, MONT, NEVE, AVENT.
- Bad fabricated geographic examples: LAGOSOL, LAGOBLANCO, LAGOHERMOSO, LAGOLIMPIO, LAGOSILVINA, LAGOTRANCAS, LAGOVIEDMA, CERROVERDE, CERROAZUL.
- Bad generic examples for a place theme: AZUL, ALMA, BASE, CAFE, VIAJE, LUGAR, TORRE, MUSEO, ARTE unless they are part of a specific proper name.

Known thematic anchor ideas you may include (optional):
${anchors.join(", ") || "(none)"}
`;
}

export function extractResponseOutputText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const direct = "output_text" in response ? (response as { output_text?: unknown }).output_text : undefined;
  if (typeof direct === "string" && direct.trim()) return direct;

  const output = "output" in response ? (response as { output?: unknown }).output : undefined;
  if (!Array.isArray(output)) return "";

  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = "content" in item ? (item as { content?: unknown }).content : undefined;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = "text" in part ? (part as { text?: unknown }).text : undefined;
      if (typeof text === "string") chunks.push(text);
    }
  }

  return chunks.join("\n").trim();
}

export async function requestAnswerbankText(
  opts: RequestAnswerbankTextInput
): Promise<AnswerbankTextResult> {
  const { client, prompt, models, allowWebSearch } = opts;

  if (allowWebSearch) {
    try {
      if (client.responses?.create) {
        const response = await client.responses.create({
          model: models.answerbankSearchModel,
          tools: [
            {
              type: "web_search",
              search_context_size: "low",
              filters: {
                allowed_domains: [
                  "wikipedia.org",
                  "britannica.com",
                ],
              },
            },
          ],
          tool_choice: "required",
          input: `${prompt}

Use web search on reputable sources to ground the answer list. Prioritize encyclopedia, official tourism,
official government, museum, venue, or similarly reputable sources. Return ONLY the requested JSON.`,
        });

        const text = extractResponseOutputText(response);
        if (text) {
          const parsed = safeJson<{ answers?: unknown }>(text);
          if (parsed && Array.isArray(parsed.answers)) {
            return {
              text,
              model: models.answerbankSearchModel,
              usedWebSearch: true,
            };
          }
          console.warn("[generate-crossword] answerbank web search returned non-json; falling back to chat", {
            chars: text.length,
          });
        }
      }
    } catch (error: unknown) {
      console.warn("[generate-crossword] answerbank web search failed; falling back to chat", {
        name: error instanceof Error ? error.name : "unknown",
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const completion = await createChatCompletion(client, {
    model: models.answerbankModel,
    temperature: 0.2,
    max_tokens: 6000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No extra text." },
      { role: "user", content: prompt },
    ],
  });

  return {
    text: completion.choices?.[0]?.message?.content ?? "",
    model: completion.model ?? models.answerbankModel,
    finishReason: completion.choices?.[0]?.finish_reason ?? undefined,
    usedWebSearch: false,
  };
}

export async function requestCompactAnswerbankText(
  opts: RequestCompactAnswerbankTextInput
): Promise<AnswerbankTextResult> {
  const { client, theme, language, size, models, allowWebSearch } = opts;
  const languageLabel = language === "es" ? "Spanish" : "English";
  const compactTarget = opts.target ?? (size === 11 ? 70 : 65);
  const compactMaxTokens = opts.maxTokens ?? (size === 11 ? 4200 : 4200);
  const prompt = `
Return ONLY compact JSON:
{"answers":["..."],"notes":[{"answer":"...","note":"..."}]}

Generate EXACTLY ${compactTarget} crossword answers for this theme.

THEME: ${theme}
LANGUAGE: ${languageLabel}
GRID SIZE: ${size}x${size}

Rules:
- Answers must be uppercase A-Z/digits only.
- Length must be 3..${size}.
- Every answer must be a complete standalone term, never a fragment.
- Prefer real named entities and specific theme terms.
- Add generic context words only when very characteristic of the theme.
- For 11x11, prioritize crossword-buildable thematic entries: at least ${Math.max(48, Math.floor(compactTarget * 0.68))} answers should be 4..7 letters when the theme has enough real names, terms, components, places, works, people, or objects.
- For 11x11, include a balanced spread: many 4-, 5-, 6-, and 7-letter answers; only a few 9..11-letter anchors.
- For 11x11, avoid returning mostly long names. Long entries are useful anchors, but short real entries make the crossword possible.
- For multiword names, a complete distinctive component is allowed when it can be clued through the full name.
- For place themes, mix landmarks, neighborhoods, lakes, hills, routes, foods, flora/fauna, activities, and regional names.
- Avoid generic words unless strongly characteristic of the theme.
- Avoid empty crossword filler such as CADA, CASO, IDEA, COLA, ALMA, BASE, DATO, DEDO, USO.
- Include one short factual note for every answer, 3..8 words.
- If you cannot write a factual theme note, skip the answer.
- Do not concatenate descriptors with names unless the whole phrase is an official/common name.
- Do not abbreviate by truncating a longer word.
- Do not include clues, markdown, or extra keys.
- Return one-line JSON only.
`;

  if (allowWebSearch) {
    try {
      if (client.responses?.create) {
        const response = await client.responses.create({
          model: models.answerbankSearchModel,
          tools: [
            {
              type: "web_search",
              search_context_size: "low",
              filters: {
                allowed_domains: ["wikipedia.org", "britannica.com"],
              },
            },
          ],
          tool_choice: "required",
          input: `${prompt}

Use web search only to ground the answer list. Prefer the theme's main encyclopedia page and directly related reputable pages.
Return ONLY the compact JSON schema requested above.`,
        });

        const text = extractResponseOutputText(response);
        const parsed = safeJson<{ answers?: unknown; notes?: unknown }>(text);
        if (parsed && Array.isArray(parsed.answers) && Array.isArray(parsed.notes)) {
          return {
            text,
            model: models.answerbankSearchModel,
            usedWebSearch: true,
          };
        }
      }
    } catch (error: unknown) {
      console.warn("[generate-crossword] compact answerbank web search failed; falling back to chat", {
        name: error instanceof Error ? error.name : "unknown",
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const completion = await createChatCompletion(client, {
    model: models.compactAnswerbankModel,
    temperature: 0.1,
    max_tokens: compactMaxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return ONLY valid compact JSON. No extra text." },
      { role: "user", content: prompt },
    ],
  });

  return {
    text: completion.choices?.[0]?.message?.content ?? "",
    model: completion.model ?? models.compactAnswerbankModel,
    finishReason: completion.choices?.[0]?.finish_reason ?? undefined,
    usedWebSearch: false,
  };
}

export async function requestLengthBucketedAnswerbankText(
  opts: RequestLengthBucketedAnswerbankTextInput
): Promise<AnswerbankTextResult> {
  const { client, theme, language, size, answerbankSearchModel } = opts;
  const languageLabel = language === "es" ? "Spanish" : "English";
  // Exact-length quotas force the model to invent or distort terms when a
  // theme does not naturally contain enough answers of a given length.
  // Structural filler comes from the local dictionary instead.
  const requestedBuckets: Array<{ len: number; count: number }> = [];
  const localContextWords = language === "es" ? opts.spanishFillerWords : opts.fillerWords;

  const corePromise = createChatCompletion(client, {
    model: answerbankSearchModel,
    temperature: 0.15,
    max_tokens: 5200,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "crossword_thematic_core",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["entries"],
          properties: {
            entries: {
              type: "array",
              minItems: 20,
              maxItems: 70,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["answer", "canonical", "relation", "kind"],
                properties: {
                  answer: { type: "string", pattern: "^[A-Z0-9]{3,11}$" },
                  canonical: { type: "string", minLength: 2, maxLength: 100 },
                  relation: { type: "string", minLength: 8, maxLength: 140 },
                  kind: {
                    type: "string",
                    enum: ["exact", "name_part", "title_segment"],
                  },
                },
              },
            },
          },
        },
      },
    },
    messages: [
      {
        role: "system",
        content:
          "Return exact structured data. Preserve official spellings and never manufacture a word to satisfy a length.",
      },
      {
        role: "user",
        content: `
Generate between 40 and 70 candidate CORE crossword entries for THEME.

THEME: ${theme}
LANGUAGE: ${languageLabel}

These are candidates, so natural accuracy matters more than covering every length:
- Use only real, correctly spelled people, surnames, first names, places, works, characters, products, events, objects, roles, or technical terms specifically tied to THEME.
- Answers must naturally normalize to 3..11 uppercase A-Z/digits.
- Never use the exact theme text.
- Never clip, pad, respell, singularize, pluralize, abbreviate, or concatenate anything to fit.
- For exact and title_segment, normalizing CANONICAL must equal ANSWER.
- For name_part, ANSWER must be one complete token in the person's full CANONICAL name.
- A title segment must be a complete word or established standalone segment, not an arbitrary substring.
- RELATION must identify the concrete connection to THEME and be suitable for writing a factual clue.
- Prefer a broad natural distribution, especially accurate 4..8 letter entries, but do not force any length.
- Use the theme's full breadth: people, works, titles, characters, places, objects, events, and terminology.
- Stop as soon as you run out of exact, defensible identifiers. Never invent entries to reach 40.
- If a correct normalized identifier is longer than 11 characters, omit it. Never truncate it.
- Include legitimate deeper-cut identifiers only when their spelling and relationship are certain.

Forbidden examples: COUNTDOWNX, HANGAR18XX, PEACESELLSB, altered names, incomplete words.
`,
      },
    ],
  });

  const [coreCompletion, responses] = await Promise.all([
    corePromise,
    Promise.all(requestedBuckets.map(async ({ len, count }) => {
      const allowedContextWords = Array.from(
        new Set(
          localContextWords
            .map((word) => opts.normalizeAnswer(word))
            .filter((word) => word.length === len && opts.isValidAnswerCharacters(word))
        )
      ).slice(0, 180);
      const prompt = `
Generate exactly ${count} different crossword entries of exactly ${len} normalized characters for THEME.

THEME: ${theme}
LANGUAGE: ${languageLabel}

The set must be useful for building a dense 11x11 crossword:
- Prefer entries with common crossing letters and varied letter positions.
- Use an exact thematic identifier only when its correct spelling naturally has exactly ${len} characters.
- Otherwise choose a real context word from ALLOWED_CONTEXT_WORDS and explain its concrete relationship to the theme.
- It is always better to use an allowed context word than to alter, clip, pad, singularize, pluralize, or invent a thematic term.
- First names and surnames are allowed when the note identifies the full person.
- A title segment is allowed only when CANONICAL contains exactly that complete segment, without truncation.
- Never include the exact theme text.
- No abbreviations, initials, codes, fragments, chopped words, invented compounds, altered singular/plural forms, or shortened titles.
- Every answer must contain exactly ${len} characters and only uppercase A-Z or digits.
- CANONICAL must be the correctly spelled complete word, title segment, or full person's name.
- For exact, title_segment, and context entries, normalizing CANONICAL must equal ANSWER exactly.
- For name_part entries, ANSWER must be one complete first name or surname in CANONICAL.
- RELATION must be concrete and factual, not a dictionary definition or vague phrase such as "related to the theme".

Critical examples:
- Never turn a title such as COUNTDOWN into COUNTDOWNX, or HANGAR18 into HANGAR18XX.
- Never change a person's name merely to reach the requested length.
- For kind=context, ANSWER must be copied exactly from ALLOWED_CONTEXT_WORDS.

ALLOWED_CONTEXT_WORDS:
${allowedContextWords.join(", ")}
`;

      const completion = await createChatCompletion(client, {
        model: answerbankSearchModel,
        temperature: 0.2,
        max_tokens: Math.max(2200, count * 110),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: `crossword_entries_len_${len}`,
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["entries"],
              properties: {
                entries: {
                  type: "array",
                  minItems: count,
                  maxItems: count,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["answer", "canonical", "relation", "kind"],
                    properties: {
                      answer: {
                        type: "string",
                        pattern: `^[A-Z0-9]{${len}}$`,
                      },
                      canonical: {
                        type: "string",
                        minLength: 2,
                        maxLength: 100,
                      },
                      relation: {
                        type: "string",
                        minLength: 8,
                        maxLength: 120,
                      },
                      kind: {
                        type: "string",
                        enum: ["exact", "name_part", "title_segment", "context"],
                      },
                    },
                  },
                },
              },
            },
          },
        },
        messages: [
          {
            role: "system",
            content:
              "Return the exact structured output. Count every answer character and obey the requested length.",
          },
          { role: "user", content: prompt },
        ],
      });

      const text = completion.choices?.[0]?.message?.content ?? "";
      const parsed = safeJson<{
        entries?: Array<{
          answer?: string;
          canonical?: string;
          relation?: string;
          kind?: "exact" | "name_part" | "title_segment" | "context";
        }>;
      }>(text);
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      return {
        len,
        entries: entries
          .map((entry) => {
            const answer = opts.normalizeAnswer(entry.answer ?? "");
            const canonical = (entry.canonical ?? "").trim();
            const canonicalNormalized = opts.normalizeAnswer(canonical);
            const canonicalParts = canonical
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .toUpperCase()
              .split(/[^A-Z0-9]+/)
              .map((part) => opts.normalizeAnswer(part))
              .filter(Boolean);
            const kind = entry.kind ?? "context";
            const canonicalMatches =
              kind === "name_part"
                ? canonicalParts.includes(answer)
                : canonicalNormalized === answer;
            const contextAllowed =
              kind !== "context" || allowedContextWords.includes(answer);
            return {
              answer,
              note: (entry.relation ?? "").trim(),
              kind,
              canonicalMatches,
              contextAllowed,
            };
          })
          .filter(
            (entry) =>
              entry.answer.length === len &&
              new RegExp(`^[A-Z0-9]{${len}}$`).test(entry.answer) &&
              entry.note.length >= 8 &&
              entry.canonicalMatches &&
              entry.contextAllowed
          ),
        model: completion.model,
      };
    })),
  ]);

  const answers: string[] = [];
  const notes: Array<{ answer: string; note: string }> = [];
  const coreAnswers: string[] = [];
  const contextAnswers: string[] = [];
  const seen = new Set<string>([opts.normalizeAnswer(theme)]);
  const coreParsed = safeJson<{
    entries?: Array<{
      answer?: string;
      canonical?: string;
      relation?: string;
      kind?: "exact" | "name_part" | "title_segment";
    }>;
  }>(coreCompletion.choices?.[0]?.message?.content ?? "");
  for (const entry of coreParsed?.entries ?? []) {
    const answer = opts.normalizeAnswer(entry.answer ?? "");
    const canonical = (entry.canonical ?? "").trim();
    const canonicalNormalized = opts.normalizeAnswer(canonical);
    const canonicalParts = canonical
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .map((part) => opts.normalizeAnswer(part))
      .filter(Boolean);
    const relation = (entry.relation ?? "").trim();
    const canonicalMatches =
      entry.kind === "name_part"
        ? canonicalParts.includes(answer)
        : canonicalNormalized === answer;
    if (
      answer.length < 3 ||
      answer.length > size ||
      !opts.isValidAnswerCharacters(answer) ||
      relation.length < 8 ||
      !canonicalMatches ||
      seen.has(answer)
    ) {
      continue;
    }
    seen.add(answer);
    answers.push(answer);
    notes.push({ answer, note: relation });
    coreAnswers.push(answer);
  }
  for (const response of responses) {
    for (const entry of response.entries) {
      if (seen.has(entry.answer)) continue;
      seen.add(entry.answer);
      answers.push(entry.answer);
      notes.push({ answer: entry.answer, note: entry.note });
      if (entry.kind === "context") contextAnswers.push(entry.answer);
      else coreAnswers.push(entry.answer);
    }
  }

  console.warn("[generate-crossword] structured length buckets", {
    requested: Object.fromEntries(requestedBuckets.map((bucket) => [bucket.len, bucket.count])),
    received: Object.fromEntries(
      answers.reduce((counts, answer) => {
        counts.set(answer.length, (counts.get(answer.length) ?? 0) + 1);
        return counts;
      }, new Map<number, number>())
    ),
    total: answers.length,
    core: coreAnswers.length,
    context: contextAnswers.length,
  });

  return {
    text: JSON.stringify({ answers, notes }),
    model: coreCompletion.model ?? responses[0]?.model ?? answerbankSearchModel,
    finishReason: "structured-length-buckets",
    usedWebSearch: false,
    trustedAnswers: answers,
    coreAnswers,
    contextAnswers,
  };
}

export async function topUpAnswers(opts: RequestTopUpAnswersInput): Promise<string[]> {
  const { client, theme, language, size, existing, need, attempt } = opts;

  const languageLabel = language === "es" ? "Spanish" : "English";

  const prompt = `
You will OUTPUT ONLY JSON: {"answers":[...]}.

Generate EXACTLY ${need} NEW crossword answers that are STRONGLY AND DIRECTLY RELATED to the THEME.

CRITICAL THEME RULES:
- Every answer must be a real, specific themed entry.
- Length MUST be 3..${size}. Do NOT output anything longer than ${size}.
- Prefer a SINGLE token that is a complete, standalone, crossword-ready entry.
- Prefer 3..8 letter answers when they are real exact themed terms; they cross much better in an 11x11.
- For an 11x11, at least 70% of this response MUST be length 3..6, and every such short answer must still be a real exact themed term.
- Include short exact names, surnames, places, routes, landmarks, foods, activities, animals, plants, songs, albums, characters, or other domain-specific terms when they are genuinely tied to the theme.
- At least 70% of the answers should be exact named/theme-specific entries, not broad category words.
- For place themes, cover varied categories: landmarks, activities, food, climate, flora, fauna, routes, nearby towns, tourism, and culture.
- For place themes, avoid repeated fabricated template entries with the same prefix. Do not make lists like CERROAZUL, CERROVERDE, CERROGRIS unless each one is a real, notable themed place.
- For place themes, no more than 5 answers in this top-up may start with LAGO or CERRO combined.
- For place themes, prioritize short real thematic category entries of length 3-8 over more LAGO/CERRO proper names.
- For place themes, include short real thematic terms when true and distinctive: local foods, animals, plants, activities, weather, and famous names.
- Use only complete official names or complete standalone words. Never output a partial phrase.
- For titles of songs, albums, books, films, games, episodes, products, or works, output the exact normalized title token when it fits. Do not drop a final S or alter singular/plural.
- Do NOT output abbreviations, initials, airport codes, postal codes, nicknames, clipped forms, fragments, prefixes, suffixes, or shortened pieces of longer names.
- Do NOT output answers ending in function words or prepositions such as DE, DEL, OF, THE.
- Do NOT invent concatenations. A compound answer must be the normalized form of a real complete name, not a prefix plus a guessed suffix.
- Do NOT output partial place names or truncated versions of a better full answer.
- If a complete themed term is longer than ${size}, skip it. Never shorten it.
- AVOID generic fill words (e.g., DREAM, HARD, PEACE, CHAOS, CLOUD, SILENT, COAT, INK, OFF, NOR, FEE, RUE, AZUL, ALMA, BASE, CAFE, VIAJE, LUGAR, TORRE, MUSEO, ARTE, etc.).
- Reject chopped stems such as NATUR, CARNI, CULTU, CASC, CUMB, CICL, MONT, NEVE, AVENT.
- DO NOT output theme-adjacent but generic words created by adding suffixes/prefixes (RUSTY, RUSTED, FROSTY, SILVERY, etc.).
- No duplicates.
- Must NOT include any of these existing answers:
${existing.join(", ")}

FORMAT / VALIDITY (hard):
- Output tokens MUST ALREADY be normalized: ONLY A-Z and digits (NO spaces, NO hyphens, NO accents).

Theme: ${theme}
Language: ${languageLabel}

All answers must be UNIQUE (no repeats).
Return JSON only. No extra keys. No notes.
`;

  const result = await requestAnswerTopUp({
    client,
    request: {
      model: size === 11 ? opts.answerbankSearchModel : opts.answerbankModel,
      temperature: 0.2,
      max_tokens: Math.min(3200, 800 + need * 40),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return ONLY valid JSON. No extra text." },
        { role: "user", content: prompt },
      ],
    },
    parseMode: "answers-with-salvage",
    maxLen: size,
    language,
    sanitize: opts.sanitizeAnswerList,
    logger: (raw) => {
      console.warn("[generate-crossword] answerbank topup raw", {
        attempt,
        need,
        rawText_len: raw.rawText_len,
        rawText_head: raw.rawText_head,
        rawText_tail: raw.rawText_tail,
      });
    },
  });

  return result.cleanedAnswers;
}

export async function generateLengthBalancedThematicAnswers(
  opts: GenerateLengthBalancedThematicAnswersInput
): Promise<string[]> {
  const { client, theme, language, size, existing, desiredByLength, attempt } = opts;
  const requested = Array.from(desiredByLength.entries())
    .filter(([len, count]) => len >= 3 && len <= size && count > 0)
    .sort(([a], [b]) => a - b);
  if (requested.length === 0) return [];

  const languageLabel = language === "es" ? "Spanish" : "English";
  const responses = await Promise.all(
    requested.map(async ([len, requestedCount]) => {
      const count = Math.min(requestedCount, 10);
      const prompt = `
Return ONLY JSON: {"answers":[...]}.

Generate EXACTLY ${count} NEW, crossword-ready answers that are strongly and directly tied to THEME.
EVERY answer MUST contain exactly ${len} normalized characters. Count them before returning JSON.

Hard rules:
- Count normalized characters, not display characters. Every answer must already contain ONLY uppercase A-Z and digits.
- Every answer must be a real, complete, standalone themed identifier or term.
- Good entries include exact surnames, first names commonly used for a themed person, stage names, characters,
  places, products, works, songs, albums, objects, technical terms, foods, species, events, or other specific domain terms.
- A word with an ordinary dictionary meaning is allowed only when it is also a concrete named or unmistakable reference in THEME.
- No abbreviations, initials, codes, fragments, clipped names, shortened titles, invented compounds, or altered singular/plural forms.
- Do not include the theme itself.
- Do not include generic words whose clue would merely be a dictionary definition.
- Every answer must support a concrete clue that explicitly connects it to THEME.
- No duplicates and none of these existing answers:
${existing.join(", ")}

THEME: ${theme}
LANGUAGE: ${languageLabel}
`;

      const result = await requestAnswerTopUp({
        client,
        request: {
          model: opts.answerbankSearchModel,
          temperature: 0.1,
          max_tokens: 900,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `Return ONLY valid JSON. Every answer must have exactly ${len} characters.`,
            },
            { role: "user", content: prompt },
          ],
        },
        parseMode: "answers-with-salvage",
        maxLen: size,
        language,
        sanitize: opts.sanitizeAnswerList,
      });
      return {
        len,
        text: result.rawText,
        cleaned: result.cleanedAnswers,
      };
    })
  );

  const existingSet = new Set(existing.map((answer) => opts.normalizeAnswer(answer)).filter(Boolean));
  const accepted: string[] = [];

  for (const response of responses) {
    const limit = Math.min(desiredByLength.get(response.len) ?? 0, 10);
    let added = 0;
    for (const answer of response.cleaned) {
      if (answer.length !== response.len || existingSet.has(answer)) continue;
      accepted.push(answer);
      existingSet.add(answer);
      added++;
      if (added >= limit) break;
    }
  }

  console.warn("[generate-crossword] length-balanced topup raw", {
    attempt,
    requested: Object.fromEntries(requested),
    received: Object.fromEntries(
      accepted.reduce((counts, answer) => {
        counts.set(answer.length, (counts.get(answer.length) ?? 0) + 1);
        return counts;
      }, new Map<number, number>())
    ),
    responses: responses.map((response) => ({
      len: response.len,
      rawText_len: response.text.length,
      rawText_head: response.text.slice(0, 100),
    })),
  });

  return accepted;
}

export async function generateSupportWords(opts: GenerateSupportWordsInput): Promise<string[]> {
  const { client, theme, language, size, existing, attempt } = opts;
  const languageLabel = language === "es" ? "Spanish" : "English";
  const prompt = `
You will OUTPUT ONLY JSON: {"answers":[...]}.

Task:
Generate up to 80 SUPPORT words for a themed crossword.

These are NOT required to be unique themed entities.
Instead, they should be SAFE, REAL, common, crossword-friendly words that are:
- genuinely connected to the THEME's world, context, imagery, domain, or vocabulary
- useful as support fill around stronger thematic entries
- standalone dictionary words or very common domain terms
- easy to connect explicitly to the theme in a clue
- concrete enough that a solver would accept the clue as thematic, not a plain dictionary definition

Hard rules:
- Use ONLY uppercase A-Z and digits.
- Length MUST be 3..${Math.min(size, 8)}.
- No duplicates.
- No abbreviations, airport codes, clipped forms, fragments, or junk.
- Avoid ultra-generic stopwords.
- Avoid obscure trivia and doubtful references.
- Include a balanced spread of 3-, 4-, 5-, 6-, 7-, and 8-letter words.
- Prefer words that can be clued through the theme, not unrelated dictionary fill.
- For music themes, include concrete domain vocabulary such as instrument, performance, release, studio, lyric, tour, genre, and sound terms when true.
- For place themes, include concrete local landscape, travel, food, climate, activity, culture, flora/fauna, route, and landmark-category words when true.
- For sports, games, films, books, brands, people, science, history, and hobbies, choose equivalent concrete domain vocabulary.
- Reject words whose only honest clue would be "thing related to THEME".
- Must NOT include any of these existing answers:
${existing.join(", ")}

Theme: ${theme}
Language: ${languageLabel}

Return JSON only.
`;

  const result = await requestAnswerTopUp({
    client,
    request: {
      model: opts.answerbankSearchModel,
      temperature: 0.2,
      max_tokens: 2200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return ONLY valid JSON. No extra text." },
        { role: "user", content: prompt },
      ],
    },
    parseMode: "answers-no-salvage",
    maxLen: Math.min(size, 8),
    language,
    sanitize: opts.sanitizeAnswerList,
    logger: (raw) => {
      console.warn("[generate-crossword] support raw", {
        attempt,
        rawText_len: raw.rawText.length,
        rawText_head: raw.rawText.slice(0, 160),
        rawText_tail: raw.rawText.slice(-120),
      });
    },
  });

  return result.cleanedAnswers.filter((answer) => answer.length >= 3);
}
