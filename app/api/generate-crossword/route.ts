import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCsp11Enabled, shouldUseCspDiagnosticOnly } from "@/app/lib/buildCspCrossword11";
import type {
  Crossword,
  DerivedEntry,
  Entry,
  RawAnswerBank,
  WordCandidate,
} from "@/app/lib/crosswordTypes";
import {
  ASCII_A_TO_Z,
  errorSummary,
  normalizeAnswer,
} from "@/app/lib/crosswordUtils";
import {
  runRobustAnswerTopUp,
  runAnswerPipeline,
  sanitizeAnswerListWithPolicies,
} from "@/app/lib/answerPipeline";
import { cspBankAuditSetDistribution } from "@/app/lib/cspOrchestration";
import {
  buildAnswerbankPrompt,
  buildAnswerbankRequest,
  generateLengthBalancedThematicAnswers,
  generateSupportWords,
  requestAnswerbankText,
  requestCompactAnswerbankText,
  requestLengthBucketedAnswerbankText,
  topUpAnswers,
  validateThematicAnswers,
  type AnswerbankTextResult,
} from "@/app/lib/openaiGeneration";
import {
  requestDirectPlayableCrossword11 as requestDirectPlayableCrossword11WithDependencies,
  requestGeneratedPatternGrid11 as requestGeneratedPatternGrid11WithDependencies,
  type OpenAiRepairServicesDependencies,
} from "@/app/lib/openaiRepairServices";
import { type ThemeFirstRescueDependencies } from "@/app/lib/themeFirstRescue";
import {
  applyCluesAndOverridesWithPolicies,
  CLUE_MODEL,
  clueLooksWeakGeneratedFallback,
  clueLanguageLooksValid,
  clueMentionsAnswer,
  createRequestModelCluesService,
  deriveEntriesFromGrid as deriveEntriesFromGridFromPublish,
  isBadClue,
  isPlaceholderClue,
  publishQualityIssueWithPolicies,
  repairPublishCluesWithPolicies,
  runPublishPipeline,
  sanitizeModelClueText,
} from "@/app/lib/publishPipeline";
import {
  blockShortRunsOnly,
  checkedCellStats,
  crossedEntryStats,
  crosswordDensityFromGrid,
  entryCrossingStats,
  hasShortLetterRuns,
  isAcceptableGridWithPolicies,
  maxGenericContextEntriesForPublish,
  minCoreThematicEntriesForPublish,
  minCrossingsPerEntryForPublish,
  minEntriesForSize,
  minEntryLenForSize,
  minPublishEntriesForSize,
} from "@/app/lib/gridValidation";
import {
  rebuildGridFromAllowedEntries,
  rebuildGridFromEntries,
  type GridReconstructionPolicies,
} from "@/app/lib/gridReconstruction";
import {
  augmentNoShortGridWithCandidates as augmentNoShortGridWithCandidatesWithDependencies,
  type GridEnhancementDependencies,
} from "@/app/lib/gridEnhancement";
import { type OpeningBuilderDependencies } from "@/app/lib/openingBuilder";
import {
  runLegacyBuilder,
  type LegacyBuilderDependencies,
} from "@/app/lib/legacyBuilder";
import { runFreeformBuilder, type FreeformBuilderDependencies } from "@/app/lib/freeformBuilder";
import { runGenerationPipeline, type PreparedGenerationAttempt } from "@/app/lib/generationPipeline";

export const runtime = "nodejs";

type GenerateCrosswordOpenAIClient = OpenAI;
type GenerateCrosswordOpenAIOptions = ConstructorParameters<typeof OpenAI>[0];
type GenerateCrosswordSupabaseSmokeClient = {
  from(table: string): {
    select(columns: string): {
      limit(count: number): Promise<unknown>;
    };
  };
};
type GenerateCrosswordTestOverrides = {
  createOpenAIClient?: (opts: GenerateCrosswordOpenAIOptions) => GenerateCrosswordOpenAIClient;
  getSupabaseSmokeClient?: () => GenerateCrosswordSupabaseSmokeClient;
  timeBudgetMs?: number;
};

declare global {
  var __generateCrosswordTestOverrides: GenerateCrosswordTestOverrides | undefined;
}

function createGenerateCrosswordOpenAIClient(opts: GenerateCrosswordOpenAIOptions): GenerateCrosswordOpenAIClient {
  return globalThis.__generateCrosswordTestOverrides?.createOpenAIClient?.(opts) ?? new OpenAI(opts);
}

function getGenerateCrosswordSupabaseSmokeClient(): GenerateCrosswordSupabaseSmokeClient {
  return (
    globalThis.__generateCrosswordTestOverrides?.getSupabaseSmokeClient?.() ??
    (supabaseAdmin as unknown as GenerateCrosswordSupabaseSmokeClient)
  );
}

// -------------------- Utils --------------------

function configureOpenAITlsForLocalDev() {
  if (process.env.NODE_ENV === "production") return;
  if (process.env.OPENAI_ALLOW_INSECURE_TLS === "0") return;
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return;

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn(
    "[generate-crossword] Local OpenAI TLS verification disabled. Use NODE_EXTRA_CA_CERTS for a safer local setup."
  );
}

configureOpenAITlsForLocalDev();

function clueLooksTooGenericForThematic(clue: string, language: "es" | "en"): boolean {
  const c = clue
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  if (language === "es") {
    return (
      /^porcion de tierra rodeada de agua/.test(c) ||
      /^territorio rodeado de agua\.?$/.test(c) ||
      /^persona que orienta en un recorrido\.?$/.test(c) ||
      /^persona que orienta en excursiones\.?$/.test(c) ||
      /^representacion grafica de (un area|una zona)\.?$/.test(c) ||
      /^extension de terreno al aire libre\.?$/.test(c) ||
      /^conjunto de plantas de una region\.?$/.test(c) ||
      /^conjunto de plantas en un area\.?$/.test(c) ||
      /^conjunto de animales en un area\.?$/.test(c) ||
      /^recorrido turistico por un lugar\.?$/.test(c) ||
      /^cuerpo de agua dulce\.?$/.test(c) ||
      /^cuerpo de agua grande y profundo\.?$/.test(c) ||
      /^terreno rodeado de agua\.?$/.test(c) ||
      /^limite entre tierra y mar\.?$/.test(c) ||
      /^camino para (viajar|vehiculos)\.?$/.test(c) ||
      /^camino para el transito\.?$/.test(c) ||
      /^tipo de hospedaje frecuente\.?$/.test(c) ||
      /^opcion economica de hospedaje\.?$/.test(c) ||
      /^desplazamiento de un lugar a otro\.?$/.test(c) ||
      /^excursion organizada a un lugar\.?$/.test(c) ||
      /^actividad de atrapar peces\.?$/.test(c) ||
      /^persona que inicia un camino nuevo\.?$/.test(c) ||
      /^material solido de la corteza terrestre\.?$/.test(c) ||
      /^arbol con agujas y conos\.?$/.test(c) ||
      /^perspectiva panoramica\.?$/.test(c) ||
      /^perspectiva visual de un paisaje\.?$/.test(c) ||
      /^satelite natural de la tierra\.?$/.test(c) ||
      /^termino que describe algo tranquilo\.?$/.test(c) ||
      /^punto de conexion o interseccion\.?$/.test(c) ||
      /^capa externa del cuerpo\.?$/.test(c) ||
      /^herramienta para excavar/.test(c) ||
      /^superficie de un lugar\.?$/.test(c) ||
      /^nombre de un lugar o persona\.?$/.test(c) ||
      /^nombre de una calle o lugar\.?$/.test(c) ||
      /^baja temperatura\.?$/.test(c) ||
      /^acumulacion de arena\.?$/.test(c) ||
      /^filamento delgado/.test(c)
    );
  }

  return (
    /^land surrounded by water/.test(c) ||
    /^person who guides a route\.?$/.test(c) ||
    /^graphic representation of (an area|a place)\.?$/.test(c) ||
    /^plant life of a region\.?$/.test(c) ||
    /^organized route for visitors\.?$/.test(c) ||
    /^thin flexible thread/.test(c)
  );
}

function clueMakesUnstableTemporalClaim(clue: string, language: "es" | "en"): boolean {
  const c = clue
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (language === "es") {
    return /\b(actual|actualmente|hoy|reciente|ultimo|ultima|ex(?:\s|-)?|antiguo|anterior|desde)\b/.test(c);
  }

  return /\b(current|currently|today|recent|latest|former|ex(?:\s|-)?|previous|since|as of|now)\b/.test(c);
}

function clueMislabelsPartialPersonAnswer(answer: string, clue: string, language: "es" | "en"): boolean {
  const a = normalizeAnswer(answer);
  if (a.length < 3 || a.length > 9) return false;

  const c = clue
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const role =
    language === "es"
      ? /\b(guitarrista|baterista|bajista|vocalista|cantante|fundador|integrante|miembro|actor|actriz|director|autor|escritor|productor|jugador|entrenador)\b/.test(c)
      : /\b(guitarist|drummer|bassist|vocalist|singer|frontman|founder|member|actor|actress|director|author|writer|producer|player|coach)\b/.test(c);
  if (!role) return false;

  const markedAsPartial =
    language === "es"
      ? /\b(nombre|apellido|seudonimo|alias|apodo|primer nombre|segundo nombre|nombre completo normalizado)\b/.test(c)
      : /\b(first name|given name|last name|surname|stage name|alias|nickname|forename|full normalized name)\b/.test(c);

  return !markedAsPartial;
}

function clueMislabelsKnownPartialTitle(theme: string, answer: string, clue: string): boolean {
  void theme;
  void answer;
  void clue;
  return false;
}

function noteLooksWeakThematicContext(note: string, language: "es" | "en"): boolean {
  const c = note
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  if (clueLooksWeakGeneratedFallback(note, language)) return true;
  return (
    /^respuesta candidata del banco tematico\b/.test(c) ||
    /^candidate themed answer from\b/.test(c) ||
    /^tema principal\b/.test(c) ||
    /^main theme\b/.test(c) ||
    /^contexto tematico para\b/.test(c) ||
    /^theme context for\b/.test(c)
  );
}

function publishQualityIssue(
  entries: Entry[],
  thematicSet: Set<string>,
  language: "es" | "en",
  minEntries: number,
  theme = ""
): string | null {
  return publishQualityIssueWithPolicies(entries, thematicSet, language, minEntries, theme, {
    answerLanguageLooksValidForPuzzle,
    isLikelyBadAnswer,
    alwaysAllowAnswers: ALWAYS_ALLOW_ANSWERS,
    modelFragmentAnswers: MODEL_FRAGMENT_ANSWERS,
    bannedAnswers: BANNED_ANSWERS,
    contextualGenericAnswers: CONTEXTUAL_GENERIC_ANSWERS,
    contextualSupportAnswers: CONTEXTUAL_SUPPORT_ANSWERS,
    isPlaceholderClue,
    isBadClue,
    clueMakesUnstableTemporalClaim,
    clueMislabelsPartialPersonAnswer,
    clueMislabelsKnownPartialTitle,
    clueLooksTooGenericForThematic,
    clueLanguageLooksValid,
    clueMentionsAnswer,
    lowValueContextlessAnswers: LOW_VALUE_CONTEXTLESS_ANSWERS,
    clueLooksWeakGeneratedFallback,
    minEntriesForSize,
  });
}

function pruneMaskedDuplicateCandidates(candidates: WordCandidate[]): WordCandidate[] {
  const answers = new Set(candidates.map((candidate) => candidate.answer));
  return candidates.filter((candidate) => {
    const answer = candidate.answer;
    if (answer.length > 3 && answer.endsWith("S") && answers.has(answer.slice(0, -1))) {
      return false;
    }
    return true;
  });
}

function isForbiddenPublishAnswer(answer: string): boolean {
  const a = normalizeAnswer(answer);
  if (MODEL_FRAGMENT_ANSWERS.has(a)) return true;
  if (BANNED_ANSWERS.has(a) && !CONTEXTUAL_GENERIC_ANSWERS.has(a)) return true;
  if (LOW_VALUE_CONTEXTLESS_ANSWERS.has(a)) return true;
  if (isLikelyBadAnswer(a) && !ALWAYS_ALLOW_ANSWERS.has(a)) return true;
  return false;
}

function answerLanguageLooksValidForPuzzle(answer: string, language: "es" | "en"): boolean {
  const a = normalizeAnswer(answer);
  if (!a) return false;
  if (language === "es" && SPANISH_WRONG_LANGUAGE_ANSWERS.has(a)) return false;
  if (language === "es" && /(?:RIVER|HUT|LAKE|TRAIL|LODGE|SKIRESORT|SNOWPARK)$/.test(a)) return false;
  return true;
}

function fallbackClueForPublishRepair(
  theme: string,
  answer: string,
  language: "es" | "en",
  thematic: boolean,
  note?: string
): string | null {
  const valid = (clue: string | null) =>
    clue &&
    !isPlaceholderClue(clue, language) &&
    !isBadClue(clue) &&
    !clueLooksTooGenericForThematic(clue, language) &&
    clueLanguageLooksValid(clue, language) &&
    !clueLooksWeakGeneratedFallback(clue, language) &&
    !clueMakesUnstableTemporalClaim(clue, language) &&
    !clueMislabelsPartialPersonAnswer(answer, clue, language) &&
    !clueMislabelsKnownPartialTitle(theme, answer, clue) &&
    !clueMentionsAnswer(clue, answer);

  const fromNote = note ? clueFromThemeNote(theme, note, language) : null;
  if (valid(fromNote)) return fromNote;

  const generic = thematic ? specificThematicFallbackClue(theme, answer, language) : null;
  if (valid(generic)) return generic;

  return null;
}

function repairPublishClues(
  entries: Entry[],
  opts: {
    theme: string;
    language: "es" | "en";
    thematicSet: Set<string>;
    notesByAnswer: Map<string, string>;
  }
): Entry[] {
  return repairPublishCluesWithPolicies(entries, opts, {
    contextualSupportAnswers: CONTEXTUAL_SUPPORT_ANSWERS,
    fallbackClueForPublishRepair,
    isPlaceholderClue,
    isBadClue,
    clueLooksTooGenericForThematic,
    clueLooksWeakGeneratedFallback,
    clueMakesUnstableTemporalClaim,
    clueMislabelsPartialPersonAnswer,
    clueMislabelsKnownPartialTitle,
    clueLanguageLooksValid,
    clueLooksOffTheme,
    clueMentionsAnswer,
  });
}

function clueLooksOffTheme(theme: string, clue: string): boolean {
  void theme;
  void clue;
  return false;
}

function hasReasonableVowelRatio(answer: string): boolean {
  const a = normalizeAnswer(answer);
  if (!a) return false;

  // Only letters count for vowel ratio; digits are neutral.
  const lettersOnly = a.replace(/[^A-Z]/g, "");
  if (!lettersOnly) return false;

  const vowels = (lettersOnly.match(/[AEIOU]/g) || []).length;
  const ratio = vowels / lettersOnly.length;

  if (lettersOnly.length >= 8 && ratio < 0.15) return false;
  if (lettersOnly.length >= 6 && ratio < 0.1) return false;
  if (ratio > 0.8) return false;
  return true;
}

function hasNoWeirdRepeats(answer: string): boolean {
  const a = normalizeAnswer(answer);
  if (a.length <= 3) return true;
  if (/(.)\1\1/.test(a)) return false;
  if (/^(..)\1\1+/.test(a)) return false;
  if (!/^[A-Z0-9]{3,}$/.test(a)) return false;
  return true;
}

function isLikelyBadAnswer(answer: string): boolean {
  const a = normalizeAnswer(answer);
  if (!a) return true;
  if (!ASCII_A_TO_Z.test(a)) return true;
  if (a.length < 3) return true;
  if (MODEL_FRAGMENT_ANSWERS.has(a)) return true;
  if (LOW_VALUE_CONTEXTLESS_ANSWERS.has(a)) return true;
  if (/(?:DE|DEL|OF|THE)$/.test(a) && a.length >= 5) return true;
  if (/^(?:LAGO|RIO|ISLA|CERRO|MONTE|PUERTO|VILLA|COLONIA)[A-Z]{1,4}$/.test(a)) return true;
  if (!hasReasonableVowelRatio(a)) return true;
  if (!hasNoWeirdRepeats(a)) return true;
  if (a.length >= 8 && /(CENT|CENTR|DEPORT|RESORT|PARK|MAPU|HUA|SAM|PALAS)$/.test(a)) return true;
  if (a.length >= 8 && /^(NATURAL|CIVIC|CARDENAL|NOMBRE|PESCA|SKI).{2,}$/.test(a)) return true;
  if (/^LAGO(ARGENT|GUAT|HERMOSO|LIMPIO|LOMA|MORO|PALAS|SILVINA|SOL|SUR|TRANC|VIED)/.test(a)) return true;

  const bannedSubs = ["AAAA", "EEE", "III", "OOO", "UUU", "QW", "ZX", "JQ", "VQ"];
  for (const b of bannedSubs) {
    if (a.includes(b)) return true;
  }

  // Three-letter entries are valid crossword answers. Reject only consonant-only
  // tokens here; thematic validation handles abbreviations, fragments, and codes.
  if (a.length === 3 && /^[A-Z]{3}$/.test(a) && !/[AEIOUY]/.test(a)) return true;

  if (a.length <= 4) {
  const bannedShort = new Set([
    "SFO",
    "LAX",
    "SONO",
    "PALO",
    "MEND",
    "NAVEG",
    "SAC",
    "RIV",
    "OC",
    "SD",
    "LA",
      "SDEL",
      "SLO",
      "ARG",
  ]);

  if (bannedShort.has(a)) return true;
}
  return false;
}

function isPublishableAnswerForTheme(opts: {
  theme: string;
  answer: string;
  language: "es" | "en";
  size: number;
  note?: string;
  allowContextualGeneric?: boolean;
}): boolean {
  const { theme, answer, language, size, allowContextualGeneric = false } = opts;
  const a = normalizeAnswer(answer);
  if (!a) return false;
  if (a === normalizeAnswer(theme)) return false;
  if (!ASCII_A_TO_Z.test(a)) return false;
  if (!answerLanguageLooksValidForPuzzle(a, language)) return false;
  if (a.length < minEntryLenForSize(size) || a.length > size) return false;
  if (isLikelyBadAnswer(a) && !ALWAYS_ALLOW_ANSWERS.has(a)) return false;
  if (size <= 11 && isRiskyGeneratedGeographicCompound(theme, a)) return false;
  if (!allowContextualGeneric && LOW_VALUE_CONTEXTLESS_ANSWERS.has(a)) return false;

  return true;
}

// -------------------- Theme anchors / overrides --------------------

const ALWAYS_ALLOW_ANSWERS = new Set<string>([]); // theme-agnostic
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getThemeAnchors(_theme: string): string[] {
  return [];
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getThemeClueOverrides(_theme: string): Record<string, { es: string; en: string }> {
  return {};
}

// -------------------- Derive entries from grid --------------------

function deriveEntriesFromGrid(grid: string[][], minLen = 3): DerivedEntry[] {
  return deriveEntriesFromGridFromPublish(grid, minLen);
}

function isAcceptable(grid: string[][], derived: Omit<Entry, "clue">[], themeSet?: Set<string>): boolean {
  return isAcceptableGridWithPolicies({
    grid,
    derived,
    themeSet,
    policies: {
      isOverGenericThemeWord,
    },
  });
}

const freeformBuilderDependencies: FreeformBuilderDependencies = {
  isForbiddenPublishAnswer,
};

// -------------------- Filler pool (local, deterministic) --------------------
// These are common crossword-friendly fills (3–5 letters). They are NOT theme-linked.
// Keep them ASCII A–Z only. No plurals explosion; moderate list is enough.

const FILLER_WORDS: string[] = [
  // 3 letters
  "ACE","ACT","ADO","AGE","AID","AIM","AIR","ALE","ALL","ALP","AMI","AMP","AND","ANT","ANY","APE","APT","ARC","ARE","ARK","ARM","ART","ASH","ASK","ATE","AUK","AWE","AWL","AXE",
  "BAD","BAG","BAN","BAR","BAT","BAY","BEE","BEG","BET","BID","BIG","BIN","BIS","BIT","BOW","BOX","BOY","BRA","BUN","BUS","BUT","BUY",
  "CAB","CAN","CAP","CAR","CAT","COT","COW","COY","CRY","CUE","CUP","CUT",
  "DAY","DEE","DEN","DID","DIG","DIM","DIN","DIP","DOG","DON","DOT","DRY","DUE",
  "EAR","EAT","EEL","EGG","ELM","EMU","END","ERA","ERR","EVE","EWE","EYE",
  "FAD","FAN","FAR","FAT","FAX","FED","FEE","FEW","FIG","FIN","FIT","FIX","FLU","FOE","FOR","FUN",
  "GAS","GEL","GEM","GET","GIG","GIN","GOD","GUM","GUN","GUT","GUY",
  "HAD","HAS","HAT","HAY","HEM","HER","HID","HIM","HIP","HIT","HOG","HOP","HOT","HUB","HUE","HUG","HUT",
  "ICE","ILL","IMP","INK","INN","ION","ITS",
  "JAB","JAM","JAR","JET","JIG","JOB","JOG","JOT","JOY","JUT",
  "KEY","KID","KIN","KIT",
  "LAP","LAW","LAX","LAY","LED","LEG","LET","LID","LIE","LIP","LIT","LOG","LOT","LOW",
  "MAD","MAN","MAP","MAT","MAY","MEN","MET","MID","MIX","MOB","MOM","MOO","MOP","MUD",
  "NAG","NAP","NAY","NET","NEW","NOD","NOR","NOT","NOW","NUN",
  "OAK","OAR","ODD","ODE","OFF","OIL","OLD","ONE","OPT","ORB","ORE","OUR","OUT","OWE","OWN",
  "PAD","PAL","PAN","PAR","PAW","PAY","PEA","PEG","PEN","PER","PET","PIE","PIG","PIN","PIT","PLY","POD","POP","POT","PRO","PRY",
  "RAG","RAM","RAN","RAP","RAT","RAW","RAY","RED","REP","RIB","RID","RIG","RIM","RIP","ROB","ROD","ROE","ROT","RUE","RUG","RUN",
  "SAD","SAG","SAP","SAT","SAW","SAY","SEA","SEE","SET","SEW","SHE","SHY","SIN","SIP","SIR","SIT","SIX","SKY","SOD","SON","SOP","SOT","SOY","SUN",
  "TAP","TAR","TEA","TEN","THE","TIC","TIE","TIN","TIP","TOE","TON","TOO","TOP","TOY","TRY","TUB","TUG","TWO",
  "URN","USE",
  "VAN","VAT","VET",
  "WAR","WAS","WAX","WAY","WEB","WET","WHO","WHY","WIN","WIT","WON",
  "YAK","YAM","YAP","YAW","YEA","YES","YET","YOU",
  "ZAP","ZED","ZEE",
  // 4 letters
  "ABLE","ACID","ACRE","AFAR","AIDE","ALLY","ALSO","AMEN","AMID","ANTE","APEX","ARCH","AREA","ARID","ARMS","ATOM","AUNT","AUTO","AVER",
  "BACK","BAKE","BALD","BAND","BANK","BARN","BATH","BEAD","BEAM","BEAN","BEAR","BEAT","BEEF","BEEN","BELL","BELT","BEND","BENT","BEST","BETA","BIDE","BIKE","BILL","BIND","BIRD","BITE","BLAH","BLOW","BLUE","BOAT","BOLD","BONE","BOOK","BOOM","BOOT","BORN","BOSS","BOTH","BOWL","BRAG","BRAN","BRED","BREW",
  "CAGE","CAKE","CALL","CALM","CAME","CAMP","CANE","CARD","CARE","CART","CASE","CASH","CAVE","CELL","CHAT","CHEF","CHIP","CHOP","CITE","CITY","CLAD","CLAY","CLIP","CLOUD","CLUE","COAL","COAT","CODE","COIN","COLD","COME","COOK","COOL","COPE","COPY","CORE","CORN","COST","CREW","CROP",
  "DARE","DARK","DATA","DATE","DAWN","DEAL","DEAR","DEBT","DECK","DEEP","DENT","DICE","DIED","DIET","DIME","DINE","DISH","DIVE","DONE","DOOM","DOOR","DOWN","DRAW","DREW","DROP","DUAL","DUCK",
  "EACH","EARN","EASE","EAST","ECHO","EDIT","ELEV","ELSE","EMIT","ENDS","ENVY","EPIC","EVEN","EVER","EXIT",
  "FACT","FADE","FAIL","FAIR","FALL","FAME","FARM","FAST","FATE","FEAR","FEED","FEEL","FELL","FELT","FILE","FILL","FIND","FINE","FIRE","FIRM","FISH","FIVE","FLAG","FLEE","FLEW","FLIP","FLOW","FOAM","FOOD","FOOL","FOOT","FORE","FORK","FORM","FORT","FOUR","FREE","FROG","FROM","FUEL","FULL",
  "GAIN","GAME","GATE","GEAR","GELD","GIFT","GIRL","GIVE","GLAD","GLOW","GOAL","GOES","GOLD","GONE","GOOD","GOWN","GRAB","GRAY","GREW","GRIN","GROW",
  "HAIR","HALF","HALL","HAND","HANG","HARD","HARM","HATE","HAVE","HEAD","HEAL","HEAR","HEAT","HELD","HELP","HERE","HERO","HIDE","HIGH","HILL","HINT","HOLD","HOME","HOPE","HOST","HOUR","HUSH",
  "IDEA","IDLE","IDOL","INCH","INTO","IRON","ITEM",
  "JAZZ","JOIN","JOKE","JUMP","JURY","JUST",
  "KEEP","KERN","KIND","KITE","KNEE",
  "LACK","LADY","LAID","LAKE","LAND","LANE","LAST","LATE","LAWN","LEAD","LEFT","LEND","LENS","LESS","LIFE","LIFT","LIKE","LINE","LINK","LIST","LIVE","LOAD","LOAN","LOCK","LOGO","LONG","LOOK","LOOP","LOSE","LOSS","LOST","LOUD","LOVE","LUCK",
  "MADE","MAIL","MAIN","MAKE","MALE","MANY","MARK","MASS","MATE","MEAL","MEAN","MEET","MENU","MERE","MESH","MILD","MILE","MILK","MIND","MINT","MISS","MOOD","MOON","MORE","MOST","MOVE","MUCH","MUSE",
  "NAME","NAVY","NEAR","NEED","NEST","NEXT","NICE","NINE","NONE","NOSE","NOTE","NOUN","NOVA",
  "OATH","OBEY","ODDS","ONCE","ONLY","OPEN","ORAL","OVER",
  "PACK","PAGE","PAID","PAIN","PAIR","PALM","PARK","PART","PASS","PAST","PATH","PEAK","PICK","PINK","PIPE","PLAN","PLAY","PLOT","PLUS","POEM","POET","POLL","POOL","POOR","PORT","POST","PULL","PURE",
  "RACE","RAIL","RAIN","RARE","RATE","READ","REAL","RELY","RENT","REST","RICH","RIDE","RING","RISE","RISK","ROAD","ROCK","ROLE","ROLL","ROOF","ROOM","ROOT","ROSE","RULE","RUST",
  "SAFE","SAID","SAME","SAND","SAVE","SEAL","SEAT","SEED","SEEK","SEEM","SEEN","SELF","SELL","SEND","SENT","SHED","SHIP","SHOE","SHOP","SHOT","SHOW","SHUT","SICK","SIDE","SIGN","SILK","SING","SITE","SIZE","SKIN","SLAM","SLOW","SOFT","SOLD","SOLO","SOME","SONG","SOON","SOUL","STAR","STAY","STEP","STOP","SUCH","SURE",
  "TAKE","TALE","TALK","TALL","TANK","TASK","TEAM","TELL","TEND","TENT","TERM","TEST","TEXT","THEN","THEY","THIN","THIS","TIDE","TILE","TIME","TINY","TOLD","TONE","TOOL","TORE","TOUR","TOWN","TREE","TRIP","TRUE","TUNE","TURN",
  "UNDO","UNIT","UPON","URGE","USER",
  "VAST","VERY","VIEW","VINE","VOTE",
  "WAIT","WAKE","WALK","WALL","WANT","WARM","WASH","WAVE","WEAR","WEEK","WELL","WENT","WEST","WHAT","WHEN","WHOM","WIDE","WIFE","WILD","WILL","WIND","WINE","WING","WISE","WISH","WITH","WOLF","WOOD","WORD","WORK","WORN",
  "YARN","YELL","YEST","YOUN",
  "ZERO","ZONE",
  // 5 letters (just a small helpful set)
  "ABOUT","ABOVE","ACORN","ADORE","AFTER","AGAIN","ALARM","ALBUM","ALERT","ALIEN","ALIVE","ALONE","ANGEL","APPLE","APRIL","ARENA",
  "BASIC","BATCH","BEACH","BEGAN","BEGIN","BEGUN","BELOW","BLANK","BLEED","BLEND","BLINK","BRAVE","BREAD","BREAK","BRICK","BRIEF","BRING","BROAD",
  "CABLE","CAMEL","CANAL","CANDY","CARRY","CATCH","CAUSE","CHAIN","CHAIR","CHEAP","CHECK","CHEST","CHIEF","CHILD","CHOIR","CIVIL","CLEAN","CLEAR","CLIMB","CLOCK","CLOSE","COAST","COMET","CORAL","COULD","COUNT",
  "DAILY","DANCE","DEALT","DEPTH","DOZEN","DREAM",
  "EARLY","EARTH","EIGHT","ELITE","EMPTY","ENJOY","ENTRY","EQUAL","ERROR","EVENT",
  "FAITH","FALSE","FARMS","FIFTY","FIGHT","FINAL","FIRST","FLOOR","FOCUS","FORCE","FRESH","FRONT",
  "GIANT","GIVEN","GLASS","GLOVE","GOING","GRACE","GRAND","GREAT","GREEN","GROUP",
  "HAPPY","HEART","HONEY","HORSE","HOUSE","HUMAN",
  "IDEAL","IMAGE","ISSUE",
  "KNOWN",
  "LARGE","LATER","LAUGH","LEARN","LEVEL","LIGHT","LIMIT","LOCAL","LOGIC","LOWER",
  "MAJOR","MATCH","MAYBE","METAL","MIGHT","MINOR","MONEY","MONTH","MOTOR","MUSIC",
  "NERVE","NEVER","NIGHT","NORTH",
  "OCEAN","OFTEN","ORDER","OTHER",
  "PARTY","PEACE","PHONE","PIANO","PLAIN","PLANT","POINT","POWER","PRESS","PRICE","PRIDE","PRIME","PROOF","PROUD",
  "QUIET",
  "RADIO","RAISE","RANGE","REACH","READY","RIGHT","RIVER","ROUND","ROUTE","RUGBY",
  "SCALE","SCENE","SCOPE","SCORE","SENSE","SERVE","SEVEN","SHARE","SHIFT","SHINE","SHIRT","SHORT","SIGHT","SINCE","SIXTH","SLEEP","SMALL","SMART","SMILE","SOLID","SOUND","SOUTH","SPEED","SPEND","SPLIT","SPORT","STAGE","START","STEEL","STILL","STOCK","STONE","STORE","STORY","STYLE","SUGAR",
  "TABLE","TAKEN","TEACH","THANK","THEIR","THERE","THESE","THICK","THING","THINK","THIRD","THOSE","THREE","THROW","TIGHT","TIMES","TODAY","TOTAL","TOUGH","TRAIN","TRUST","TRUTH",
  "UNDER","UNION","UNTIL","UPPER","USUAL",
  "VALUE","VIDEO","VISIT",
  "WATER","WHILE","WHITE","WHOLE","WORLD","WORTH","WOULD","WRITE",
  "YOUTH",
  // 6 letters
  "ACTION","ARTIST","BATTLE","BRIDGE","CAMERA","CIRCLE","DANGER","ENERGY","FAMILY","FOREST",
  "FRIEND","GUITAR","HAMMER","ISLAND","LETTER","MARKET","MEMORY","MOTION","NATURE","OBJECT",
  "ORANGE","PLANET","PLAYER","POETRY","RECORD","SIGNAL","SILVER","SPIRIT","STREET","SUMMER",
  "SYSTEM","TRAVEL","WINTER",
  // 7 letters
  "ANCIENT","BALANCE","CAPTAIN","CENTRAL","CHAPTER","CONCERT","CRYSTAL","CULTURE","DIAMOND","FREEDOM",
  "GALLERY","HISTORY","JOURNEY","KINGDOM","MACHINE","MESSAGE","MORNING","MUSICAL","MYSTERY","NATURAL",
  "PICTURE","RAINBOW","SCIENCE","SILENCE","SOLDIER","SPECIAL","THUNDER","VILLAGE","WEATHER",
  // 8 letters
  "BUILDING","CHILDREN","COMPLETE","COMPUTER","CROSSING","DISCOVER","DISTANCE","FESTIVAL","MOUNTAIN",
  "PAINTING","QUESTION","REMEMBER","SENTENCE","SHOULDER","STANDARD","STRENGTH","SUNSHINE","TREASURE",
  "UNIVERSE",
  // 9-11 letters
  "ADVENTURE","COMMUNITY","EDUCATION","KNOWLEDGE","LANDSCAPE","MOVEMENT","PRESIDENT","SOMETHING",
  "BACKGROUND","BASKETBALL","DIFFERENCE","EARTHQUAKE","EVERYTHING","FRIENDSHIP","GOVERNMENT",
  "LIGHTHOUSE","NEWSPAPER","POPULATION","RESTAURANT","SCIENTIFIC","TECHNOLOGY","TELEVISION",
  "CELEBRATION","ENVIRONMENT","GENERATION","IMAGINATION","INFORMATION","PERFORMANCE","POSSIBILITY"
];

const SPANISH_FILLER_WORDS: string[] = [
  "AIRE", "ALMA", "ALTO", "AMOR", "ARTE", "AZUL", "BAJO", "BASE", "BESO", "BOCA",
  "CADA", "CAMA", "CARA", "CASA", "CASO", "CENA", "CINE", "CITA", "CLUB", "COLA",
  "DATO", "DEDO", "DIA", "DIAS", "DUNA", "EDAD", "EJE", "EJES", "ESTE", "FARO",
  "FILA", "FINO", "FLOR", "FOTO", "GALA", "GATO", "GIRO", "GOTA", "GRIS", "HILO",
  "HORA", "IDEA", "ISLA", "LADO", "LAGO", "LATA", "LIGA", "LIMA", "LONA", "LUNA",
  "MANO", "MAR", "MASA", "MESA", "META", "MODO", "MONO", "NAVE", "NODO", "NOTA",
  "ONDA", "ORO", "PALA", "PALO", "PATA", "PENA", "PESO", "PICO", "PIEL", "PISO",
  "RAMA", "RANA", "RATO", "RED", "REDES", "RETO", "RIMA", "RIO", "RIOS", "ROCA",
  "ROJO", "ROSA", "RUTA", "SALA", "SAL", "SEDA", "SEDE", "SEIS", "SILLA", "SOGA",
  "SOL", "SOPA", "SUR", "TAPA", "TARDE", "TASA", "TELA", "TEMA", "TONO", "TORRE",
  "TREN", "UNO", "USO", "VALLE", "VASO", "VELA", "VIDA", "VINO", "ZONA",
  "ABIERTO", "ALTURA", "AMBIENTE", "ANTIGUO", "BARRIO", "BELLEZA", "BOSQUE",
  "CAMINO", "CAMINOS", "CENTRO", "CIUDAD", "CLASICO", "COMARCA", "CULTURA",
  "DESTINO", "ENTORNO", "ESTACION", "FAMILIA", "FUENTE", "HISTORIA", "JARDIN",
  "LAGUNA", "LUGARES", "MIRADOR", "MONTANA", "NATURAL", "PARAJE",
  "PARQUE", "PAISAJE", "PASEOS", "PUEBLO", "PUENTE", "PUERTO", "REGION",
  "RESERVA", "REFUGIO", "SENDERO", "TURISMO", "VECINO", "VIAJERO"
];

const COMMON_ENGLISH_DICTIONARY_WORDS = (() => {
  try {
    return Array.from(
      new Set(
        readFileSync(join(process.cwd(), "data", "common-words-en.txt"), "utf8")
          .split(/\r?\n/)
          .map((word) => normalizeAnswer(word))
          .filter(
            (word) =>
              word.length >= 3 &&
              word.length <= 11 &&
              ASCII_A_TO_Z.test(word)
          )
      )
    ).slice(0, 5000);
  } catch (error: unknown) {
    console.warn("[generate-crossword] common English dictionary unavailable", {
      msg: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
})();

function loadFrequencyDictionary(filename: string): string[] {
  try {
    return Array.from(
      new Set(
        readFileSync(join(process.cwd(), "data", filename), "utf8")
          .split(/\r?\n/)
          .map((line) => normalizeAnswer(line.trim().split(/\s+/)[0] ?? ""))
          .filter(
            (word) =>
              word.length >= 3 &&
              word.length <= 11 &&
              ASCII_A_TO_Z.test(word)
          )
      )
    ).slice(0, 30_000);
  } catch (error: unknown) {
    console.warn("[generate-crossword] frequency dictionary unavailable", {
      filename,
      msg: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

const FREQUENCY_ENGLISH_DICTIONARY_WORDS = loadFrequencyDictionary(
  "frequency-en-50k.txt"
);
const FREQUENCY_SPANISH_DICTIONARY_WORDS = loadFrequencyDictionary(
  "frequency-es-50k.txt"
);

const WEAK_CONTEXT_DICTIONARY_WORDS = new Set([
  "ARE", "ASK", "BEEN", "DID", "DOES", "DONE", "FINE", "GET", "GOT", "HAS",
  "HAVE", "KENYA", "LIE", "ONE", "SEE", "TOO", "WAS", "WERE", "YET",
  "ABOUT", "AFTER", "AGAIN", "BEFORE", "COULD", "EVERY", "OTHER", "THEIR",
  "THERE", "THESE", "THOSE", "WOULD",
]);

async function rankSemanticSupportWords(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
}): Promise<string[]> {
  const { client, theme, language, size } = opts;
  const source = Array.from(
    new Set(
      (language === "es" ? SPANISH_FILLER_WORDS : FILLER_WORDS)
        .map((word) => normalizeAnswer(word))
        .filter(
          (word) =>
            word.length >= 3 &&
            word.length <= Math.min(size, 8) &&
            ASCII_A_TO_Z.test(word) &&
            !WEAK_CONTEXT_DICTIONARY_WORDS.has(word)
        )
    )
  ).slice(0, 1500);
  if (source.length === 0) return [];

  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: [
      language === "es"
        ? `Vocabulario concretamente relacionado con el tema: ${theme}`
        : `Vocabulary concretely related to the theme: ${theme}`,
      ...source.map((word) => word.toLowerCase()),
    ],
  });
  const themeVector = response.data[0]?.embedding;
  if (!themeVector) return [];

  const norm = (vector: number[]) =>
    Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  const themeNorm = norm(themeVector);
  return source
    .map((word, index) => {
      const vector = response.data[index + 1]?.embedding ?? [];
      const dot = vector.reduce(
        (sum, value, vectorIndex) =>
          sum + value * (themeVector[vectorIndex] ?? 0),
        0
      );
      return { word, score: dot / (themeNorm * norm(vector)) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 500)
    .map((item) => item.word);
}

const TARGET_ANSWERS = 70;
const ANSWERBANK_MODEL = process.env.OPENAI_ANSWERBANK_MODEL ?? "gpt-4.1-mini";
const ANSWERBANK_SEARCH_MODEL = process.env.OPENAI_ANSWERBANK_SEARCH_MODEL ?? "gpt-4.1";
const COMPACT_ANSWERBANK_MODEL = process.env.OPENAI_COMPACT_ANSWERBANK_MODEL ?? ANSWERBANK_MODEL;

// Palabras ultra genéricas / stopwords que NO queremos como respuestas.
const BANNED_ANSWERS = new Set([
  "IN", "ON", "AT", "OF", "TO", "FOR", "AND", "OR", "THE", "A", "AN",
  "AIRE", "AMEA", "CADA", "CASO", "COLA", "COSA", "DATO", "DIAS", "FLORE", "IDEA", "MENOR", "MODO", "PAISA", "ROJO", "SEIS", "SOGA", "TAPA", "TEMA", "TRILHA", "USO", "UNO", "VIVIR",
  "WIND", "WAVE", "WARM", "WILD", "WISH", "NICE", "MILD", "PICK", "RIDE", "SLOW", "TIDE", "YARN", "ZING", "JACKET", "PLUCK",
  "MEUP", "BROWNIE", "AVENT", "MONT", "NEVE", "FEST", "CULT", "AFAR",
  "CASC", "CUMB", "CICL", "AIDE", "ARMS", "ATOM", "NATUR", "CARNI", "CULTU", "MERKADO",
  "CAMPAR",
  "FRES", "VERD", "VALL", "SEND", "VIVI",
  "OTT", "TEDRA", "NAVEG", "PATRICIO",
]);

const MODEL_FRAGMENT_ANSWERS = new Set([
  "AMEA", "NATUR", "CARNI", "CULTU", "AVENT", "MONT", "NEVE", "CASC", "CUMB", "CICL",
  "TURIS", "PAISA", "PATAG", "ANDIN", "CHOCOL", "ARTES", "PANOR", "FOTOG", "FAMIL", "SENDER",
  "ADIE", "ENTRAL", "GAR", "NTRAL", "NZA", "FRES", "SILV", "VERD", "VALL", "SEND", "SDEL",
  "VIVI", "MELI", "TRANC", "MASC", "COSTAN"
]);

const CONTEXTUAL_GENERIC_ANSWERS = new Set<string>([]);
const LOW_VALUE_CONTEXTLESS_ANSWERS = new Set([
  "AIRE",
  "ALMENDRO",
  "ASADO",
  "BAYO",
  "CAMPOS",
  "CAMPO",
  "CITA",
  "CLUB",
  "CINE",
  "CIRUELA",
  "COLA",
  "CUATRO",
  "DECLARACION",
  "DEDO",
  "DATO",
  "DIAS",
  "DOLARES",
  "DUNA",
  "EDAD",
  "ESCOBA",
  "EJES",
  "ESTE",
  "FARO",
  "FILA",
  "FINO",
  "FLOR",
  "FOTO",
  "GALA",
  "GATO",
  "GOTA",
  "GOLF",
  "GRIS",
  "HERMOSO",
  "HIKING",
  "HORA",
  "LADO",
  "LATA",
  "HILO",
  "GIRO",
  "LIGA",
  "LIMA",
  "LIMPIO",
  "LONA",
  "LUNA",
  "MANO",
  "MASA",
  "META",
  "MONO",
  "MONTI",
  "MIRLO",
  "NIVEL",
  "NODO",
  "NUBE",
  "MESA",
  "ONDA",
  "OLAS",
  "PATRON",
  "FESTI",
  "NAVE",
  "NOTA",
  "PATA",
  "PALA",
  "PIEL",
  "PIONERA",
  "PENA",
  "PESO",
  "PINO",
  "PISO",
  "RIMA",
  "ROSA",
  "RATO",
  "RANA",
  "RETO",
  "ROCA",
  "SALA",
  "SEDA",
  "SEDE",
  "SOPA",
  "TELA",
  "SKIING",
  "TORTA",
  "VIEJO",
  "ZONA",
]);

const CONTEXTUAL_SUPPORT_ANSWERS = new Set<string>([]);

const SPANISH_WRONG_LANGUAGE_ANSWERS = new Set([
  "ADVENTURE",
  "BIRCH",
  "BROOKTROUT",
  "CATHEDRAL",
  "CIVICCENTRE",
  "GLACIER",
  "RAILWAY",
  "SEVENLAKES",
  "SKIHUT",
  "SKIRESORT",
  "SNOWFALL",
  "SNOWBOARD",
  "SNOWPARK",
  "STEPPE",
  "TOURISM",
  "WINDSURF",
  "ZIPLINE",
  "GUIDE",
  "HUT",
  "FREYHUT",
  "LIMAYRIVER",
  "RIVER",
  "TRAIL",
  "VALDIVIAN",
  "BLAU",
]);

const OVER_GENERIC_THEME_WORDS = new Set([
  "BAYOU","BEACH","BEACHES","BLOOM","CAMP","CAMPS","CAMPSITE","CAMPY","CITIES","CITY",
  "CAMPUS","CANYON","CANYONS","COAST","COASTAL","CLOUD","CLOUDS","CREEK","DESERT","DESERTS",
  "COVE","COVES","DREAM","DUNE","DUNES","FARM","FARMS","FIELD","FIELDS","FISH","FOLK","FRESH","GARDEN","GARDENS","GOLDEN","GRASS","GROVE","HARBOR","HARBORS",
  "HILL","HILLS","HONEY","ISLAND","ISLANDS","JOURNAL","LAKE","LAKES","MEADOW","MEADOWS",
  "MOUNTAIN","MOUNTAINS","NATURE","OCEAN","PARK","PARKS","PATIO","PEACE","RANCH","RANCHES",
  "RIVER","RIVERS","ROCKY","SAND","SANDAL","SANDY","SHORE","SHORES","SKYLINE","SLOPE","SLOPES","SUNNY","SUNSET",
  "SANDS","SKIES","TACOS","TIDAL","TRAIL","TRAILS","TREE","TREES","VALLEY","WATER","WATERS","WILD","WINDY",
  "WOOD","WOODS"
]);

function isOverGenericThemeWord(answer: string): boolean {
  const a = normalizeAnswer(answer);
  if (!a) return true;
  if (OVER_GENERIC_THEME_WORDS.has(a)) return true;

  if (a.length <= 4) return false;

  if (/^(SUN|SEA|SKY|BAY|PARK|HILL|LAKE|RIVER|TREE|COAST|SHORE|WOOD|CLOUD|DESERT|MEADOW|GARDEN|CANYON|ISLAND|DUNE|COVE|FISH|FOLK)/.test(a)) return true;
  if (/(VILLE|WOODS|SHORE|SHORES|TRAIL|TRAILS|PARKS|HILLS|WATER|WATERS|GARDEN|GARDENS|DESERT|DESERTS|CANYON|CANYONS|CLOUD|CLOUDS|MEADOW|MEADOWS|ISLAND|ISLANDS|DUNE|DUNES|COVE|COVES)$/.test(a)) return true;

  return false;
}

function isThemeCoreWord(theme: string, answer: string): boolean {
  const t = normalizeAnswer(theme);
  const a = normalizeAnswer(answer);
  if (!t || !a) return false;

  if (a === t) return true;

  const anchors = getThemeAnchors(theme).map((x) => normalizeAnswer(x)).filter(Boolean);
  if (anchors.includes(a)) return true;

  if (t.length >= 4 && (a.includes(t) || t.includes(a))) return true;

  return false;
}

function isRiskyGeneratedGeographicCompound(theme: string, answer: string): boolean {
  void theme;
  void answer;
  return false;
}

function isOverGenericThemeWordForTheme(theme: string, answer: string): boolean {
  if (isThemeCoreWord(theme, answer)) return false;
  return isOverGenericThemeWord(answer);
}

function sanitizeAnswerList(raw: unknown, maxLen: number, language?: "es" | "en") {
  return sanitizeAnswerListWithPolicies(raw, maxLen, language, {
    asciiAnswerPattern: ASCII_A_TO_Z,
    bannedAnswers: BANNED_ANSWERS,
    alwaysAllowAnswers: ALWAYS_ALLOW_ANSWERS,
    answerLanguageLooksValidForPuzzle,
    isLikelyBadAnswer,
  });
}

function expandGeographicCompoundAnswers(answers: string[], maxLen: number): string[] {
  void answers;
  void maxLen;
  return [];
}

function specificThematicFallbackClue(theme: string, answer: string, language: "es" | "en"): string | null {
  const a = normalizeAnswer(answer);
  const t = theme.trim();
  if (!a || !t) return null;

  return language === "es"
    ? `Entrada validada por el banco tematico de ${t}`
    : `Validated entry from the ${t} thematic bank`;
}

function clueFromThemeNote(theme: string, note: string, language: "es" | "en"): string | null {
  void theme;
  void language;
  const cleaned = note.replace(/\s+/g, " ").trim();
  if (cleaned.length < 12) return null;
  return cleaned.length <= 80 ? cleaned : cleaned.slice(0, 77).trim() + "...";
}

function hasStrongThematicClueSupport(opts: {
  theme: string;
  answer: string;
  language: "es" | "en";
  note?: string;
  clue?: string;
}): boolean {
  const { theme, answer, language, note, clue } = opts;
  const hinted = buildThematicClueRequestHint(theme, answer, language, note);
  if (hinted) return true;
  if (
    clue &&
    !isPlaceholderClue(clue, language) &&
    !isBadClue(clue) &&
    note &&
    note.trim().length >= 8 &&
    !noteLooksWeakThematicContext(note, language)
  ) {
    return true;
  }
  return false;
}

function isCoreThematicCandidate(opts: {
  candidate: WordCandidate;
  trustedThematicSet: Set<string>;
  theme: string;
  language: "es" | "en";
  notesByAnswer: Map<string, string>;
  clueByAnswer?: Map<string, string>;
}) {
  const { candidate, trustedThematicSet, theme, language, notesByAnswer, clueByAnswer } = opts;
  const answer = candidate.answer;

  if (candidate.source === "filler" || candidate.source === "support") return false;
  if (!candidate.thematic && !trustedThematicSet.has(answer)) return false;
  if (CONTEXTUAL_SUPPORT_ANSWERS.has(answer)) return false;
  if (LOW_VALUE_CONTEXTLESS_ANSWERS.has(answer)) return false;
  if (isOverGenericThemeWordForTheme(theme, answer)) return false;

  return hasStrongThematicClueSupport({
    theme,
    answer,
    language,
    note: notesByAnswer.get(answer),
    clue: clueByAnswer?.get(answer),
  });
}

function buildCoreThematicSetFromPool(opts: {
  pool: WordCandidate[];
  trustedThematicSet: Set<string>;
  theme: string;
  language: "es" | "en";
  notesByAnswer: Map<string, string>;
  clueByAnswer?: Map<string, string>;
}) {
  return new Set(
    opts.pool
      .filter((candidate) =>
        isCoreThematicCandidate({
          candidate,
          trustedThematicSet: opts.trustedThematicSet,
          theme: opts.theme,
          language: opts.language,
          notesByAnswer: opts.notesByAnswer,
          clueByAnswer: opts.clueByAnswer,
        })
      )
      .map((candidate) => candidate.answer)
  );
}

function buildPublishThematicSetFromPool(opts: {
  pool: WordCandidate[];
  trustedThematicSet: Set<string>;
  theme: string;
  language: "es" | "en";
  notesByAnswer: Map<string, string>;
  clueByAnswer?: Map<string, string>;
}) {
  const thematicSet = buildCoreThematicSetFromPool(opts);

  for (const candidate of opts.pool) {
    if (candidate.source === "filler") continue;
    if (isOverGenericThemeWordForTheme(opts.theme, candidate.answer)) continue;
    if (LOW_VALUE_CONTEXTLESS_ANSWERS.has(candidate.answer)) continue;

    const contextual =
      candidate.source === "support" || CONTEXTUAL_SUPPORT_ANSWERS.has(candidate.answer);
    if (!contextual) continue;

    if (
      hasStrongThematicClueSupport({
        theme: opts.theme,
        answer: candidate.answer,
        language: opts.language,
        note: opts.notesByAnswer.get(candidate.answer),
        clue: opts.clueByAnswer?.get(candidate.answer),
      }) ||
      fallbackClueForPublishRepair(
        opts.theme,
        candidate.answer,
        opts.language,
        true,
        opts.notesByAnswer.get(candidate.answer)
      )
    ) {
      thematicSet.add(candidate.answer);
    }
  }

  return thematicSet;
}

async function topUpAnswersRobust(opts: {
  client: OpenAI;
  theme: string;
  language: "es" | "en";
  size: number;
  existing: string[];
  need: number;
  attempt: number;
}) {
  return runRobustAnswerTopUp({
    existing: opts.existing,
    need: opts.need,
    size: opts.size,
    normalizeKey: normalizeAnswer,
    requestBatch: ({ existing, need }) =>
      topUpAnswers({
        ...opts,
        existing,
        need,
        answerbankModel: ANSWERBANK_MODEL,
        answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
        sanitizeAnswerList,
      }),
  });
}

function inferLocalSupportWords(
  theme: string,
  size: number,
  notesByAnswer: Map<string, string>
): Array<{ answer: string; thematic: boolean }> {
  const themeNorm = normalizeAnswer(theme);
  const seen = new Set<string>();
  const out: Array<{ answer: string; thematic: boolean }> = [];

  const add = (raw: string) => {
    const answer = normalizeAnswer(raw);
    if (!answer) return;
    if (answer === themeNorm) return;
    if (answer.length < 3 || answer.length > size) return;
    if (!ASCII_A_TO_Z.test(answer)) return;
    if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) return;
    if (seen.has(answer)) return;
    seen.add(answer);
    out.push({ answer, thematic: true });
  };

  for (const [answer, note] of notesByAnswer.entries()) {
    if (note && !noteLooksWeakThematicContext(note, "en") && !noteLooksWeakThematicContext(note, "es")) {
      add(answer);
    }
    for (const token of note.match(/[A-Za-z]{3,}/g) ?? []) {
      if (out.length >= 80) return out;
      add(token);
    }
  }

  return out;
}

function buildCandidatePoolFromAnswers(
  theme: string,
  raw: RawAnswerBank | null,
  size: number,
  thematicKeep: Set<string>,
  supportWords: string[] = [],
  localSupportWords: Array<{ answer: string; thematic: boolean }> = [],
  language: "es" | "en" = "en"
): WordCandidate[] {
  const themeNorm = normalizeAnswer(theme);
  const rawNotesByAnswer = new Map<string, string>();
  for (const item of raw?.notes ?? []) {
    const answer = normalizeAnswer(item.answer);
    if (answer && item.note) rawNotesByAnswer.set(answer, item.note);
  }

  const anchors = getThemeAnchors(theme)
    .map((a) => normalizeAnswer(a))
    .filter(Boolean)
    .filter((a) => a !== themeNorm); // NO permitir el tema como respuesta

  const map = new Map<string, WordCandidate>();

  // 1) Anchors (theme-linked, strongest)
  for (const a of anchors) {
    if (a.length <= size && a.length >= 3 && ASCII_A_TO_Z.test(a)) {
      map.set(a, { answer: a, thematic: true, source: "anchor" });
    }
  }

  // 2) Model answers (THEMATIC) — con cap para que no exploten
  const MODEL_CAP = Math.max(120, size * size); // 11 => 121 aprox
  let modelAdded = 0;

  if (raw?.answers && Array.isArray(raw.answers)) {
    for (const ansRaw of raw.answers) {
      if (modelAdded >= MODEL_CAP) break;

      const ans = normalizeAnswer(ansRaw);
      if (!ans) continue;
      if (ans === themeNorm) continue;
      if (
        !isPublishableAnswerForTheme({
          theme,
          answer: ans,
          language,
          size,
          note: rawNotesByAnswer.get(ans),
          allowContextualGeneric: true,
        })
      ) {
        continue;
      }
      // Only allow model answers that passed thematic validation.
      // If it's not in thematicKeep, we drop it completely (prevents SWEETLEAF, etc.)
      if (!thematicKeep.has(ans)) continue;

      if (!map.has(ans)) {
        map.set(ans, { answer: ans, thematic: true, source: "model" });
        modelAdded++;
      }
    }
  }

  // 2b) Curated local support words (strong domain-adjacent vocabulary)
  for (const item of localSupportWords) {
    const ans = normalizeAnswer(item.answer);
    if (!ans) continue;
    if (ans === themeNorm) continue;
    if (
      !isPublishableAnswerForTheme({
        theme,
        answer: ans,
        language,
        size: Math.min(size, 11),
        note: rawNotesByAnswer.get(ans),
        allowContextualGeneric: item.thematic,
      })
    ) {
      continue;
    }

    const prev = map.get(ans);
    if (!prev) {
      map.set(ans, {
        answer: ans,
        thematic: item.thematic,
        source: item.thematic ? "model" : "support",
      });
      continue;
    }

    if (item.thematic && !prev.thematic) {
      map.set(ans, { ...prev, thematic: true, source: "model" });
    }
  }

  // 2b) Model support words (domain-adjacent but not necessarily pure thematics)
  for (const ansRaw of supportWords) {
    const ans = normalizeAnswer(ansRaw);
    if (!ans) continue;
    if (ans === themeNorm) continue;
    if (
      !isPublishableAnswerForTheme({
        theme,
        answer: ans,
        language,
        size: Math.min(size, 8),
        note: rawNotesByAnswer.get(ans),
        allowContextualGeneric: true,
      })
    ) {
      continue;
    }
    if (ans.length < 3) continue;
    if (isOverGenericThemeWordForTheme(theme, ans) && !thematicKeep.has(ans)) continue;

    if (!map.has(ans)) {
      const thematic = thematicKeep.has(ans);
      map.set(ans, {
        answer: ans,
        thematic,
        source: thematic ? "model" : "support",
      });
    }
  }

  // 3) Local fillers (NOT thematic) — CAP MUY AGRESIVO
  const fillerCap = size === 11 ? 180 : Math.max(64, size * 5);
  let fillerAdded = 0;
  const fillerAddedByLength = new Map<number, number>();

  const baseFillerWords = language === "es" ? SPANISH_FILLER_WORDS : FILLER_WORDS;
  const fillerWordsForSize =
    size === 11
      ? baseFillerWords.slice().sort((a, b) => {
          const rank = (word: string) => {
            const len = normalizeAnswer(word).length;
            if (len >= 4 && len <= 6) return 0;
            if (len === 7 || len === 3) return 1;
            return 2;
          };

          const rankDiff = rank(a) - rank(b);
          if (rankDiff !== 0) return rankDiff;
          return normalizeAnswer(a).length - normalizeAnswer(b).length;
        })
      : baseFillerWords;

  for (const w of fillerWordsForSize) {
    if (fillerAdded >= fillerCap) break;

    const ans = normalizeAnswer(w);
    if (!ans) continue;
    if (size === 11 && (fillerAddedByLength.get(ans.length) ?? 0) >= 36) continue;
    if (ans === themeNorm) continue;
    if (
      !isPublishableAnswerForTheme({
        theme,
        answer: ans,
        language,
        size,
        allowContextualGeneric: false,
      })
    ) {
      continue;
    }
    if (anchors.includes(ans)) continue;
    if (size === 11 && isOverGenericThemeWordForTheme(theme, ans)) continue;

    if (!map.has(ans)) {
      map.set(ans, { answer: ans, thematic: false, source: "filler" });
      fillerAdded++;
      fillerAddedByLength.set(ans.length, (fillerAddedByLength.get(ans.length) ?? 0) + 1);
    }
  }

  return pruneMaskedDuplicateCandidates(Array.from(map.values()));
}

const PATTERN_11X11S: string[][] = [
  [
    "##.....####",
    "#....#....#",
    ".....#.....",
    "....#....##",
    "#....#.....",
    "...........",
    ".....#....#",
    "##....#....",
    ".....#.....",
    "#....#....#",
    "####.....##",
  ],
  [
    "###....####",
    "#....#....#",
    ".....#.....",
    "....#.....#",
    "...#.......",
    "...........",
    ".......#...",
    "#.....#....",
    ".....#.....",
    "#....#....#",
    "####....###",
  ],
  [
    "####.....##",
    "#....#....#",
    "#.....#....",
    ".....#.....",
    "....#....##",
    "...........",
    "##....#....",
    ".....#.....",
    "....#.....#",
    "#....#....#",
    "##.....####",
  ],
  [
    "##....#....",
    "#....#....#",
    ".....#.....",
    "....#....##",
    "....#.....#",
    "...........",
    "#.....#....",
    "##....#....",
    ".....#.....",
    "#....#....#",
    "....#....##",
  ],
];

const requestModelClues = createRequestModelCluesService({
  answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
  clueModel: CLUE_MODEL,
  policies: {
    isBadClue,
    clueMentionsAnswer,
    clueMakesUnstableTemporalClaim,
    clueMislabelsPartialPersonAnswer,
    clueMislabelsKnownPartialTitle,
    clueLooksOffTheme,
    warnClueRetryFailed: (payload) => {
      console.warn("[generate-crossword] clue retry failed", payload);
    },
  },
});

const legacyBuilderDependencies: LegacyBuilderDependencies = {
  alwaysAllowAnswers: ALWAYS_ALLOW_ANSWERS,
  commonEnglishDictionaryWords: COMMON_ENGLISH_DICTIONARY_WORDS,
  fillerWords: FILLER_WORDS,
  frequencyEnglishDictionaryWords: FREQUENCY_ENGLISH_DICTIONARY_WORDS,
  frequencySpanishDictionaryWords: FREQUENCY_SPANISH_DICTIONARY_WORDS,
  isAcceptable,
  isForbiddenPublishAnswer,
  isLikelyBadAnswer,
  isOverGenericThemeWordForTheme,
  patterns11: PATTERN_11X11S,
  spanishFillerWords: SPANISH_FILLER_WORDS,
  weakContextDictionaryWords: WEAK_CONTEXT_DICTIONARY_WORDS,
};

const gridEnhancementDependencies: GridEnhancementDependencies = {
  isForbiddenPublishAnswer,
  isOverGenericThemeWordForTheme,
  logger: console,
};

const openingBuilderDependencies: OpeningBuilderDependencies = {
  isForbiddenPublishAnswer,
  isOverGenericThemeWordForTheme,
};

const openAiRepairServicesDependencies: OpenAiRepairServicesDependencies = {
  answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
  alwaysAllowAnswers: ALWAYS_ALLOW_ANSWERS,
  commonEnglishDictionaryWords: COMMON_ENGLISH_DICTIONARY_WORDS,
  frequencyEnglishDictionaryWords: FREQUENCY_ENGLISH_DICTIONARY_WORDS,
  frequencySpanishDictionaryWords: FREQUENCY_SPANISH_DICTIONARY_WORDS,
  weakContextDictionaryWords: WEAK_CONTEXT_DICTIONARY_WORDS,
  spanishFillerWords: SPANISH_FILLER_WORDS,
  fillerWords: FILLER_WORDS,
  pattern11x11s: PATTERN_11X11S,
  logger: console,
  errorSummary,
  deriveEntriesFromGrid,
  isAcceptable,
  isForbiddenPublishAnswer,
  isLikelyBadAnswer,
  isOverGenericThemeWordForTheme,
  noteLooksWeakThematicContext,
  hasStrongThematicClueSupport,
  validateThematicAnswers: (opts) =>
    validateThematicAnswers({
      ...opts,
      answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
      sanitizeAnswerList,
    }),
  sanitizeModelClueText,
  isBadClue,
  clueMentionsAnswer,
  clueMakesUnstableTemporalClaim,
  clueMislabelsPartialPersonAnswer,
  clueMislabelsKnownPartialTitle,
  buildThematicClueRequestHint,
  requestModelClues,
  reinforceThematicClues,
  applyCluesAndOverrides,
  repairPublishClues,
  publishQualityIssue,
  augmentNoShortGridWithCandidates: (
    grid,
    candidates,
    minLen,
    targetEntries,
    minimumReturnEntries
  ) =>
    augmentNoShortGridWithCandidatesWithDependencies(
      grid,
      candidates,
      minLen,
      targetEntries,
      minimumReturnEntries,
      gridEnhancementDependencies
    ),
};

const themeFirstRescueDependencies: ThemeFirstRescueDependencies = {
  buildBeamCrossword11: (opts) =>
    runLegacyBuilder({ mode: "beam-11", dependencies: legacyBuilderDependencies, ...opts }),
  buildCompactPatternCrossword11: (opts) =>
    runLegacyBuilder({ mode: "compact-pattern-11", dependencies: legacyBuilderDependencies, ...opts }),
  buildPatternCrossword11: (opts) =>
    runLegacyBuilder({ mode: "pattern-11", dependencies: legacyBuilderDependencies, ...opts }),
  rebuildGridFromAllowedEntries,
  deriveEntriesFromGrid,
  checkedCellStats,
  crossedEntryStats,
  entryCrossingStats,
  crosswordDensityFromGrid,
  minEntryLenForSize,
  minPublishEntriesForSize,
  minCrossingsPerEntryForPublish,
  isOverGenericThemeWordForTheme,
  hasStrongThematicClueSupport,
  buildThematicClueRequestHint,
  requestModelClues,
  clueFromThemeNote,
  specificThematicFallbackClue,
  reinforceThematicClues,
  applyCluesAndOverrides,
  isPlaceholderClue,
  now: Date.now,
  warn: console.warn,
};

// -------------------- Clue plumbing --------------------

function buildThematicClueRequestHint(
  theme: string,
  answer: string,
  language: "es" | "en",
  note?: string | null
): string | null {
  const specific = specificThematicFallbackClue(theme, answer, language);
  if (specific) return specific;

  if (note && !noteLooksWeakThematicContext(note, language)) {
    const fromNote = clueFromThemeNote(theme, note, language);
    if (fromNote) return fromNote;

    const cleaned = note.replace(/\s+/g, " ").trim();
    if (cleaned.length >= 12) {
      return language === "es"
        ? `Contexto temático para ${theme}: ${cleaned}`
        : `Theme context for ${theme}: ${cleaned}`;
    }
  }

  return null;
}

function getPreferredThematicClue(
  theme: string,
  answer: string,
  language: "es" | "en",
  note?: string | null,
  fallback?: string | null
): string | null {
  const hinted = buildThematicClueRequestHint(theme, answer, language, note);
  if (hinted && !isBadClue(hinted) && !clueMentionsAnswer(hinted, answer)) return hinted;

  if (fallback && !isBadClue(fallback) && !clueMentionsAnswer(fallback, answer) && !clueLooksOffTheme(theme, fallback)) return fallback;
  return null;
}

function reinforceThematicClues(
  theme: string,
  language: "es" | "en",
  answers: Iterable<string>,
  clueByAnswer: Map<string, string>,
  notesByAnswer: Map<string, string>,
  thematicSet: Set<string>
) {
  for (const answer of answers) {
    if (!thematicSet.has(answer)) continue;
    const preferred = getPreferredThematicClue(
      theme,
      answer,
      language,
      notesByAnswer.get(answer),
      clueByAnswer.get(answer)
    );
    if (preferred) clueByAnswer.set(answer, preferred);
  }
}

function applyCluesAndOverrides(
  theme: string,
  language: "es" | "en",
  derived: Omit<Entry, "clue">[],
  clueByAnswer: Map<string, string>
): Entry[] {
  return applyCluesAndOverridesWithPolicies(theme, language, derived, clueByAnswer, {
    getThemeClueOverrides,
    specificThematicFallbackClue,
    isBadClue,
    clueMentionsAnswer,
  });
}

const gridReconstructionPolicies: GridReconstructionPolicies = {
  applyCluesAndOverrides,
  isAlwaysAllowedAnswer: (answer) => ALWAYS_ALLOW_ANSWERS.has(answer),
  isLikelyBadAnswer,
  isOverGenericThemeWordForTheme,
  isPlaceholderClue,
  specificThematicFallbackClue,
};

// -------------------- Demo fallback --------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getDemoCrossword(size: number, theme: string, language: "es" | "en") {
  const localSupportWords = inferLocalSupportWords(theme, size, new Map());
  if (localSupportWords.length > 0) {
    const candidates: WordCandidate[] = localSupportWords.map((item) => ({
      answer: normalizeAnswer(item.answer),
      thematic: item.thematic,
      source: item.thematic ? "model" : "support",
    }));
    const seed = (normalizeAnswer(theme).length * 2654435761 + size * 1013904223) >>> 0;
    const built =
      size === 11
        ? runLegacyBuilder({ mode: "strict-11", dependencies: legacyBuilderDependencies,
            theme,
            size,
            candidates,
            seed,
          }) ??
          runFreeformBuilder({ dependencies: freeformBuilderDependencies,
            size,
            seed,
            candidates,
          })
        : runFreeformBuilder({ dependencies: freeformBuilderDependencies,
            size,
            seed,
            candidates,
          });

    if (built) {
      const derived = deriveEntriesFromGrid(built.grid, minEntryLenForSize(size));
      if (derived.length > 0) {
        return {
          grid: built.grid,
          theme,
          language,
          entries: applyCluesAndOverrides(theme, language, derived, new Map()),
        };
      }
    }
  }

  if (size === 11) {
    const grid = [
      "###########",
      "#ROCK#BAND#",
      "###########",
      "#NOTE#KEYS#",
      "###########",
      "#DRUM#SOLO#",
      "###########",
      "#SONG#HARP#",
      "###########",
      "#JAZZ#PUNK#",
      "###########",
    ].map((row) => row.split(""));

    const entries: Entry[] = [
      { number: 1, row: 1, col: 1, direction: "across", answer: "ROCK", clue: language === "es" ? "Género musical." : "Music genre." },
      { number: 2, row: 1, col: 6, direction: "across", answer: "BAND", clue: language === "es" ? "Grupo de músicos." : "Group of musicians." },
      { number: 3, row: 3, col: 1, direction: "across", answer: "NOTE", clue: language === "es" ? "Símbolo musical." : "Musical symbol." },
      { number: 4, row: 3, col: 6, direction: "across", answer: "KEYS", clue: language === "es" ? "Teclas de piano." : "Piano keys." },
      { number: 5, row: 5, col: 1, direction: "across", answer: "DRUM", clue: language === "es" ? "Instrumento de percusión." : "Percussion instrument." },
      { number: 6, row: 5, col: 6, direction: "across", answer: "SOLO", clue: language === "es" ? "Actuación individual." : "Single musical performance." },
      { number: 7, row: 7, col: 1, direction: "across", answer: "SONG", clue: language === "es" ? "Composición musical." : "Musical composition." },
      { number: 8, row: 7, col: 6, direction: "across", answer: "HARP", clue: language === "es" ? "Instrumento de cuerdas." : "Stringed instrument." },
      { number: 9, row: 9, col: 1, direction: "across", answer: "JAZZ", clue: language === "es" ? "Género musical con swing." : "Music genre with swing." },
      { number: 10, row: 9, col: 6, direction: "across", answer: "PUNK", clue: language === "es" ? "Estilo musical irreverente." : "Edgy music style." },
    ];

    return { grid, entries, theme, language };
  }

  if (size === 9) {
    const grid = [
      "#########",
      "#ROCK#BAND",
      "#########",
      "#NOTE#KEYS",
      "#########",
      "#DRUM#SOLO",
      "#########",
      "#JAZZ#PUNK",
      "#########",
    ].map((row) => row.split(""));

    const entries: Entry[] = [
      { number: 1, row: 1, col: 1, direction: "across", answer: "ROCK", clue: language === "es" ? "Género musical." : "Music genre." },
      { number: 2, row: 1, col: 6, direction: "across", answer: "BAND", clue: language === "es" ? "Grupo de músicos." : "Group of musicians." },
      { number: 3, row: 3, col: 1, direction: "across", answer: "NOTE", clue: language === "es" ? "Símbolo musical." : "Musical symbol." },
      { number: 4, row: 3, col: 6, direction: "across", answer: "KEYS", clue: language === "es" ? "Teclas de piano." : "Piano keys." },
      { number: 5, row: 5, col: 1, direction: "across", answer: "DRUM", clue: language === "es" ? "Instrumento de percusión." : "Percussion instrument." },
      { number: 6, row: 5, col: 6, direction: "across", answer: "SOLO", clue: language === "es" ? "Actuación individual." : "Single musical performance." },
      { number: 7, row: 7, col: 1, direction: "across", answer: "JAZZ", clue: language === "es" ? "Género musical con swing." : "Music genre with swing." },
      { number: 8, row: 7, col: 6, direction: "across", answer: "PUNK", clue: language === "es" ? "Estilo musical irreverente." : "Edgy music style." },
    ];

    return { grid, entries, theme, language };
  }

  return null;
}

// -------------------- Handler --------------------

export async function POST(req: NextRequest) {
  try {
    await getGenerateCrosswordSupabaseSmokeClient().from("crosswords").select("id").limit(1);
  } catch (e) {
    console.warn("[generate-crossword] supabase check failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const body = (await req.json().catch(() => ({}))) as {
    theme?: string;
    language?: "es" | "en" | string;
    size?: unknown;
  };

  const theme = (body.theme || "general knowledge").toString();
  const language: "es" | "en" = body.language === "en" ? "en" : "es";
  const n: number = 11;

  configureOpenAITlsForLocalDev();

  const apiKey = process.env.OPENAI_API_KEY;
  const client = apiKey
    ? createGenerateCrosswordOpenAIClient({ apiKey, timeout: n === 11 ? 45_000 : 10_000, maxRetries: 0 })
    : null;

  const TIME_BUDGET_MS = n === 11 ? 240_000 : 22_000;
  const t0 = Date.now();
  const deadlineMs = t0 + (globalThis.__generateCrosswordTestOverrides?.timeBudgetMs ?? TIME_BUDGET_MS);
  const csp11Enabled = n === 11 && isCsp11Enabled();
  const csp11DiagnosticOnly = shouldUseCspDiagnosticOnly({
    cspEnabled: csp11Enabled,
    diagnosticOnly: process.env.CROSSWORD_CSP_11_DIAGNOSTIC_ONLY,
  });
  const csp11DiagnosticBudgetMs = Math.max(
    1_000,
    Number(process.env.CROSSWORD_CSP_11_DIAGNOSTIC_BUDGET_MS) || 45_000
  );
  const csp11HybridDiagnostic =
    csp11DiagnosticOnly && process.env.CROSSWORD_CSP_11_HYBRID_DIAGNOSTIC === "true";
  let lastCspAttemptMeta: Record<string, unknown> | null = null;

  console.warn("[generate-crossword] env check", {
    hasApiKey: Boolean(apiKey),
    apiKeyLen: apiKey?.length ?? 0,
    hasClient: Boolean(client),
    theme,
    language,
    size: n,
  });
  console.warn("[generate-crossword] csp11 config", {
    enabled: csp11Enabled,
    diagnosticOnly: csp11DiagnosticOnly,
    hybridDiagnostic: csp11HybridDiagnostic,
    theme,
    language,
    candidateCount: 0,
    deadlineRemainingMs: deadlineMs - Date.now(),
  });

  const makeGenerationErrorResponse = (meta: Record<string, unknown>, status = 503) => {
    const responseMeta = {
      ...meta,
      ...(lastCspAttemptMeta && { cspAttempt: lastCspAttemptMeta }),
    };
    console.warn("[generate-crossword] GENERATION FAILED", responseMeta);
    return NextResponse.json(
      {
        error: "No se pudo generar un crucigrama jugable con la calidad requerida.",
        theme,
        language,
        size: n,
        meta: responseMeta,
      },
      { status }
    );
  };

  const publishCrosswordResponse = (out: Crossword) => {
    if (n !== 11) return NextResponse.json(out, { status: 200 });

    const minLen = minEntryLenForSize(n);
    const minEntriesForGate = minPublishEntriesForSize(n);
    const finalEntryCrossings = entryCrossingStats(out.grid, out.entries, minLen);
    const finalCrossed = crossedEntryStats(out.grid, out.entries, minLen);
    const finalChecked = checkedCellStats(out.grid, minLen);
    const finalThematicSet = new Set(out.entries.map((entry) => entry.answer));
    const finalQualityIssue = publishQualityIssue(
      out.entries,
      finalThematicSet,
      language,
      minEntriesForGate,
      theme
    );
    const tolerableNearQualityIssue = false;
    const metaCore =
      typeof out.meta?.coreThematicEntries === "number"
        ? out.meta.coreThematicEntries
        : undefined;
    const metaGeneric =
      typeof out.meta?.genericContextEntries === "number"
        ? out.meta.genericContextEntries
        : undefined;
    const inferredCore = out.entries.filter(
      (entry) =>
        !LOW_VALUE_CONTEXTLESS_ANSWERS.has(entry.answer) &&
        !BANNED_ANSWERS.has(entry.answer)
    ).length;
    const finalCoreThematicEntries = Math.max(metaCore ?? 0, inferredCore);
    const finalGenericContextEntries = Math.min(
      metaGeneric ?? out.entries.length - inferredCore,
      Math.max(0, out.entries.length - finalCoreThematicEntries)
    );
    const minCoreEntries = minCoreThematicEntriesForPublish(n, out.entries.length);
    const maxGenericEntries = maxGenericContextEntriesForPublish(n, out.entries.length);
    const minCheckedRatioForPublish = 0.2;
    const minDensityForPublish = 0.4;
    const finalDensity = crosswordDensityFromGrid(out.grid);
    const finalHasShortRuns = hasShortLetterRuns(out.grid, minLen);
    const hasEnoughCrossing =
      finalCrossed.crossed >= out.entries.length &&
      finalEntryCrossings.weakEntries.length === 0;
    const finalUnsupported = out.entries.filter(
      (entry) =>
        !isPublishableAnswerForTheme({
          theme,
          answer: entry.answer,
          language,
          size: n,
          allowContextualGeneric: finalThematicSet.has(entry.answer),
        })
    );

    if (finalHasShortRuns) {
      const allowedAnswers = new Set(out.entries.map((entry) => entry.answer));
      const clueByAnswer = new Map(out.entries.map((entry) => [entry.answer, entry.clue] as const));
      const cleanedGrid = blockShortRunsOnly(out.grid, minLen);
      const rebuilt = rebuildGridFromAllowedEntries(cleanedGrid, allowedAnswers, minLen);
      if (rebuilt && !hasShortLetterRuns(rebuilt.grid, minLen)) {
        const repairedEntries = repairPublishClues(
          rebuilt.derived.map((entry) => ({
            ...entry,
            clue: clueByAnswer.get(entry.answer) ?? "",
          })),
          {
            theme,
            language,
            thematicSet: finalThematicSet,
            notesByAnswer: new Map(),
          }
        );
        if (repairedEntries.length >= minEntriesForGate) {
          return publishCrosswordResponse({
            ...out,
            grid: rebuilt.grid,
            entries: repairedEntries,
            meta: {
              ...out.meta,
              source: `${out.meta?.source ?? "unknown"}-short-runs-repaired`,
              repairedShortRuns: true,
              preRepairEntries: out.entries.length,
            },
          });
        }
      }
    }

    if (finalEntryCrossings.weakEntries.length > 0) {
      const weakAnswers = new Set(finalEntryCrossings.weakEntries.map((entry) => entry.answer));
      const prunedEntries = out.entries.filter((entry) => !weakAnswers.has(entry.answer));
      if (prunedEntries.length >= minEntriesForGate) {
        const rebuilt = rebuildGridFromEntries(n, prunedEntries, minLen);
        if (rebuilt && !hasShortLetterRuns(rebuilt.grid, minLen)) {
          const clueByAnswer = new Map(out.entries.map((entry) => [entry.answer, entry.clue] as const));
          const repairedEntries = repairPublishClues(
            rebuilt.derived.map((entry) => ({
              ...entry,
              clue: clueByAnswer.get(entry.answer) ?? "",
            })),
            {
              theme,
              language,
              thematicSet: finalThematicSet,
              notesByAnswer: new Map(),
            }
          );
          console.warn("[generate-crossword] publish pruning weak entries", {
            removed: Array.from(weakAnswers),
            before: out.entries.length,
            after: repairedEntries.length,
          });
          return publishCrosswordResponse({
            ...out,
            grid: rebuilt.grid,
            entries: repairedEntries,
            meta: {
              ...out.meta,
              source: `${out.meta?.source ?? "unknown"}-weak-pruned`,
              prunedWeakEntries: Array.from(weakAnswers),
            },
          });
        }
      }
    }

    if (
      out.entries.length < minEntriesForGate ||
      !hasEnoughCrossing ||
      finalDensity < minDensityForPublish ||
      finalChecked.ratio < minCheckedRatioForPublish ||
      finalCoreThematicEntries < minCoreEntries ||
      finalGenericContextEntries > maxGenericEntries ||
      finalHasShortRuns ||
      finalUnsupported.length > 0 ||
      (finalQualityIssue && !tolerableNearQualityIssue)
    ) {
      return makeGenerationErrorResponse(
        {
          source: "publish-gate",
          originalSource: out.meta?.source,
          reason:
            finalQualityIssue ??
            (out.entries.length < minEntriesForGate
              ? "La grilla final no alcanzo el minimo de entradas publicables."
              : finalCoreThematicEntries < minCoreEntries
              ? "La grilla final no alcanzo suficientes entradas tematicas reales."
              : finalGenericContextEntries > maxGenericEntries
              ? "La grilla final contiene demasiadas entradas genericas adyacentes."
              : finalDensity < minDensityForPublish
              ? "La grilla final tiene una densidad demasiado baja."
              : finalHasShortRuns
              ? "La grilla final contenia secuencias demasiado cortas."
              : "La grilla final no alcanzo el minimo de cruces por entrada."),
          finalEntries: out.entries.length,
          finalDensity,
          minDensityForPublish,
          finalCrossedEntries: finalCrossed.crossed,
          finalCheckedRatio: finalChecked.ratio,
          minCrossingsPerEntry: minCrossingsPerEntryForPublish(n),
          weakCrossingEntries: finalEntryCrossings.weakEntries,
          finalCoreThematicEntries,
          minCoreThematicEntries: minCoreEntries,
          finalGenericContextEntries,
          maxGenericContextEntries: maxGenericEntries,
          finalUnsupportedAnswers: finalUnsupported.map((entry) => entry.answer),
          finalHasShortRuns,
          finalQualityIssue,
          finalAnswers: out.entries.map((entry) => entry.answer),
        },
        422
      );
    }

    return NextResponse.json(out, { status: 200 });
  };

  if (!client) {
    return makeGenerationErrorResponse(
      { source: "generation-error", reason: "OPENAI_API_KEY no configurada." },
      503
    );
  }

  if (n === 11 && process.env.ENABLE_DIRECT_MODEL_11 === "1") {
    try {
      const direct = await requestDirectPlayableCrossword11WithDependencies({ dependencies: openAiRepairServicesDependencies,
        client,
        theme,
        language,
        attempt: 0,
      });

      if (direct) {
        console.warn("[generate-crossword] publishing direct validated 11x11", {
          entries: direct.entries.length,
          source: direct.meta?.source,
        });
        return publishCrosswordResponse(direct);
      }
    } catch (error: unknown) {
      console.warn("[generate-crossword] direct validated 11x11 failed; continuing legacy pipeline", {
        msg: errorSummary(error),
      });
    }
  }

  if (n === 11 && process.env.OPENAI_FIXED_PATTERN_GRID === "1") {
    try {
      const generatedFixedGrid = await requestGeneratedPatternGrid11WithDependencies({ dependencies: openAiRepairServicesDependencies,
        client,
        theme,
        language,
        size: n,
        attempt: 0,
      });

      if (generatedFixedGrid) {
        const thematicSet = new Set(generatedFixedGrid.thematicAnswers);
        const published = await runPublishPipeline({
          client,
          theme,
          language,
          size: n,
          grid: generatedFixedGrid.grid,
          notesByAnswer: generatedFixedGrid.notes,
          thematicSet,
          source: "fast-generated-fixed-pattern-11",
          meta: {
            coreThematicEntries: generatedFixedGrid.thematicAnswers.length,
            ...generatedFixedGrid.meta,
          },
          answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
          clueModel: CLUE_MODEL,
          minEntryLenForSize,
          buildThematicClueRequestHint,
          reinforceThematicClues,
          requestModelClues,
          applyCluesAndOverrides,
          repairPublishClues,
        });
        const { entries } = published.crossword;
        published.crossword.meta.genericContextEntries =
          entries.length - generatedFixedGrid.thematicAnswers.length;

        console.warn("[generate-crossword] publishing fast fixed-pattern result", {
          entries: entries.length,
          builder: generatedFixedGrid.meta.builder,
        });
        return publishCrosswordResponse(published.crossword);
      }
    } catch (error: unknown) {
      console.warn("[generate-crossword] fast fixed-pattern path failed", {
        msg: errorSummary(error),
      });
    }
  }

  const prepareAttemptAnswers = async ({ attempt }: { attempt: number }): Promise<PreparedGenerationAttempt> => {
    let lastModelError: string | null = null;
    // Phase 1: answers-only
      const answerbankRequest = `${buildAnswerbankPrompt(TARGET_ANSWERS)}\n${buildAnswerbankRequest({
        theme,
        language,
        size: n,
        targetAnswers: TARGET_ANSWERS,
        getThemeAnchors,
        normalizeAnswer,
      })}`;

      let answerbankTextResult: AnswerbankTextResult | null = null;
      try {
        answerbankTextResult =
          n === 11
            ? await requestLengthBucketedAnswerbankText({
                client,
                theme,
                language,
                size: n,
                answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
                fillerWords: FILLER_WORDS,
                spanishFillerWords: SPANISH_FILLER_WORDS,
                normalizeAnswer,
                isValidAnswerCharacters: (answer) => ASCII_A_TO_Z.test(answer),
              })
            : await requestAnswerbankText({
                client,
                prompt: answerbankRequest,
                models: {
                  answerbankModel: ANSWERBANK_MODEL,
                  answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
                },
                allowWebSearch: process.env.OPENAI_ENABLE_WEB_SEARCH === "1",
              });
      } catch (e: unknown) {
        lastModelError = errorSummary(e);
        console.warn("[generate-crossword] model1 failed", {
          attempt,
          error: lastModelError,
        });
        try {
          answerbankTextResult =
            n === 11
              ? await requestLengthBucketedAnswerbankText({
                  client,
                  theme,
                  language,
                  size: n,
                  answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
                  fillerWords: FILLER_WORDS,
                  spanishFillerWords: SPANISH_FILLER_WORDS,
                  normalizeAnswer,
                  isValidAnswerCharacters: (answer) => ASCII_A_TO_Z.test(answer),
                })
              : await requestCompactAnswerbankText({
                  client,
                  theme,
                  language,
                  size: n,
                  models: {
                    compactAnswerbankModel: COMPACT_ANSWERBANK_MODEL,
                    answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
                  },
                  allowWebSearch: process.env.OPENAI_ENABLE_WEB_SEARCH === "1",
                });
          console.warn("[generate-crossword] answerbank fallback succeeded", {
            attempt,
            model: answerbankTextResult.model,
            finishReason: answerbankTextResult.finishReason,
          });
        } catch (fallbackError: unknown) {
          lastModelError = `${lastModelError}; compact fallback: ${errorSummary(fallbackError)}`;
          console.warn("[generate-crossword] compact answerbank fallback failed", {
            attempt,
            error: lastModelError,
          });
          if (n === 11 && Date.now() < deadlineMs - 10_000) {
            try {
              const emergencyAnswers = await topUpAnswersRobust({
                client,
                theme,
                language,
                size: n,
                existing: [],
                need: 64,
                attempt,
              });
              if (emergencyAnswers.length >= minPublishEntriesForSize(n)) {
                const emergencyNotes = emergencyAnswers.map((answer) => ({
                  answer,
                  note:
                    language === "es"
                      ? `Respuesta candidata del banco tematico sobre ${theme}.`
                      : `Candidate themed answer from the ${theme} answer bank.`,
                }));
                answerbankTextResult = {
                  text: JSON.stringify({ answers: emergencyAnswers, notes: emergencyNotes }),
                  model: ANSWERBANK_MODEL,
                  finishReason: "emergency-answer-only",
                  usedWebSearch: false,
                };
                console.warn("[generate-crossword] emergency answer-only bank succeeded", {
                  attempt,
                  answers: emergencyAnswers.length,
                });
              } else {
                return { status: "continue", lastModelError };
              }
            } catch (emergencyError: unknown) {
              lastModelError = `${lastModelError}; answer-only emergency: ${errorSummary(emergencyError)}`;
              return { status: "continue", lastModelError };
            }
          } else {
            return { status: "continue", lastModelError };
          }
        }
      }

      const answerPipelineResult = await runAnswerPipeline({
        answerbankTextResult,
        theme,
        language,
        size: n,
        attempt,
        deadlineMs,
        targetAnswers: TARGET_ANSWERS,
        enableSemanticSupport11: process.env.ENABLE_SEMANTIC_SUPPORT_11 === "1",
        fillerWords: language === "es" ? SPANISH_FILLER_WORDS : FILLER_WORDS,
        policies: {
          asciiAnswerPattern: ASCII_A_TO_Z,
          bannedAnswers: BANNED_ANSWERS,
          alwaysAllowAnswers: ALWAYS_ALLOW_ANSWERS,
          answerLanguageLooksValidForPuzzle,
          isLikelyBadAnswer,
          noteLooksWeakThematicContext,
          minEntryLenForSize,
          isPublishableAnswerForTheme,
          isForbiddenPublishAnswer,
          isOverGenericThemeWordForTheme,
          isThemeCoreWord,
        },
        dependencies: {
          expandGeographicCompoundAnswers,
          inferLocalSupportWords,
          validateThematicAnswers: ({ answers }) =>
            validateThematicAnswers({
              client,
              theme,
              language,
              size: n,
              answers,
              attempt,
              answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
              sanitizeAnswerList,
            }),
          topUpAnswers: ({ existing, need }) =>
            topUpAnswersRobust({
              client,
              theme,
              language,
              size: n,
              existing,
              need,
              attempt,
            }),
          generateLengthBalancedThematicAnswers: ({ existing, desiredByLength }) =>
            generateLengthBalancedThematicAnswers({
              client,
              theme,
              language,
              size: n,
              existing,
              desiredByLength,
              attempt,
              answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
              sanitizeAnswerList,
              normalizeAnswer,
            }),
          generateSupportWords: ({ existing }) =>
            generateSupportWords({
              client,
              theme,
              language,
              size: n,
              existing,
              attempt,
              answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
              sanitizeAnswerList,
            }),
          rankSemanticSupportWords: () =>
            rankSemanticSupportWords({
              client,
              theme,
              language,
              size: n,
            }),
          buildCandidatePoolFromAnswers: ({
            theme: poolTheme,
            normalizedAnswerBank,
            size: poolSize,
            placementThemeSet,
            supportWords,
            localSupportWords,
            language: poolLanguage,
          }) =>
            buildCandidatePoolFromAnswers(
              poolTheme,
              normalizedAnswerBank,
              poolSize,
              placementThemeSet,
              supportWords,
              localSupportWords,
              poolLanguage
            ),
          minPublishEntriesForSize,
          now: Date.now,
          warn: (message, payload) => console.warn(message, payload),
          recordAuditDistribution: cspBankAuditSetDistribution,
          errorSummary,
        },
      });

      if (answerPipelineResult.status === "skip") {
        return {
          status: "skip",
          issue: answerPipelineResult.issue,
          lastModelError,
        };
      }

      const {
        cspBankAuditReport,
        notesByAnswer,
        thematicKeepSet,
        publishThemeSet,
        placementThemeSet,
        rawPool,
      } = answerPipelineResult;
      return {
        status: "ready",
        attempt,
        cspBankAuditReport,
        notesByAnswer,
        thematicKeepSet,
        publishThemeSet,
        placementThemeSet,
        rawPool,
        lastModelError,
        lastAnswerStats: answerPipelineResult.lastAnswerStats,
      };
  };


  const firstAttemptDeadlineCheckMs = Date.now();
  const generationResult = await runGenerationPipeline({
    client,
    theme,
    language,
    size: n,
    startedAtMs: t0,
    deadlineMs,
    firstAttemptDeadlineCheckMs,
    csp11Enabled,
    csp11DiagnosticOnly,
    csp11DiagnosticBudgetMs,
    csp11HybridDiagnostic,
    answerbankSearchModel: ANSWERBANK_SEARCH_MODEL,
    dependencies: {
      prepareAttemptAnswers,
      requestModelClues,
      sanitizeAnswerList,
      freeformBuilderDependencies,
      legacyBuilderDependencies,
      openingBuilderDependencies,
      themeFirstRescueDependencies,
      gridEnhancementDependencies,
      openAiRepairServicesDependencies,
      gridReconstructionPolicies,
      applyCluesAndOverrides,
      buildCoreThematicSetFromPool,
      buildPublishThematicSetFromPool,
      buildThematicClueRequestHint,
      clueFromThemeNote,
      clueLooksOffTheme,
      fallbackClueForPublishRepair,
      hasStrongThematicClueSupport,
      isAcceptable,
      isCoreThematicCandidate,
      isForbiddenPublishAnswer,
      isLikelyBadAnswer,
      isOverGenericThemeWordForTheme,
      isPublishableAnswerForTheme,
      publishQualityIssue,
      reinforceThematicClues,
      repairPublishClues,
      specificThematicFallbackClue,
      alwaysAllowAnswers: ALWAYS_ALLOW_ANSWERS,
      bannedAnswers: BANNED_ANSWERS,
      contextualGenericAnswers: CONTEXTUAL_GENERIC_ANSWERS,
      contextualSupportAnswers: CONTEXTUAL_SUPPORT_ANSWERS,
      fillerWords: FILLER_WORDS,
      lowValueContextlessAnswers: LOW_VALUE_CONTEXTLESS_ANSWERS,
      modelFragmentAnswers: MODEL_FRAGMENT_ANSWERS,
      spanishFillerWords: SPANISH_FILLER_WORDS,
    },
  });

  lastCspAttemptMeta = generationResult.lastCspAttemptMeta;
  if (generationResult.status === "diagnostic") {
    return NextResponse.json(generationResult.responsePayload, { status: 422 });
  }
  if (generationResult.status === "failed") {
    const status =
      generationResult.failureKind === "service-unavailable"
        ? 503
        : generationResult.failureKind === "internal"
        ? 500
        : 422;
    return makeGenerationErrorResponse(generationResult.meta, status);
  }
  return publishCrosswordResponse(generationResult.crossword);
}
