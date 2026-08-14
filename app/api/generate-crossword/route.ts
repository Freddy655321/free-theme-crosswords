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
      /^precipitacion en forma de cristales blancos\.?$/.test(c) ||
      /^cuerpo de agua dulce\.?$/.test(c) ||
      /^cuerpo de agua dulce en la region\.?$/.test(c) ||
      /^cuerpo de agua grande y profundo\.?$/.test(c) ||
      /^cuerpo de agua dulce rodeado de tierra\.?$/.test(c) ||
      /^cuerpo de agua cercano a/.test(c) ||
      /^cuerpo de agua dulce en la montana\.?$/.test(c) ||
      /^lago pequeno cerca de/.test(c) ||
      /^terreno rodeado de agua\.?$/.test(c) ||
      /^limite entre tierra y mar\.?$/.test(c) ||
      /^limite entre mar y tierra\.?$/.test(c) ||
      /^limite entre tierra y agua\.?$/.test(c) ||
      /^orilla entre tierra y agua\.?$/.test(c) ||
      /^camino para (viajar|vehiculos)\.?$/.test(c) ||
      /^camino para el transito\.?$/.test(c) ||
      /^camino o via de transito\.?$/.test(c) ||
      /^camino o via para viajar\.?$/.test(c) ||
      /^camino para viajar o transportar\.?$/.test(c) ||
      /^tipo de hospedaje frecuente\.?$/.test(c) ||
      /^opcion economica de hospedaje\.?$/.test(c) ||
      /^desplazamiento de un lugar a otro\.?$/.test(c) ||
      /^excursion organizada a un lugar\.?$/.test(c) ||
      /^excursion guiada por un lugar\.?$/.test(c) ||
      /^embarcacion ligera y estrecha\.?$/.test(c) ||
      /^actividad de atrapar peces\.?$/.test(c) ||
      /^persona que atrapa peces\.?$/.test(c) ||
      /^persona que inicia un camino nuevo\.?$/.test(c) ||
      /^infusion tradicional argentina\.?$/.test(c) ||
      /^tecnica de coccion a la parrilla\.?$/.test(c) ||
      /^atraccion turistica con tobogan alpino\.?$/.test(c) ||
      /^atractivo principal en temporada invernal\.?$/.test(c) ||
      /^lugares populares en verano\.?$/.test(c) ||
      /^material solido de la corteza terrestre\.?$/.test(c) ||
      /^arbol con agujas y conos\.?$/.test(c) ||
      /^aves acuaticas de patas cortas\.?$/.test(c) ||
      /^ave comun en la zona\.?$/.test(c) ||
      /^anfibio que habita en la region\.?$/.test(c) ||
      /^perspectiva panoramica\.?$/.test(c) ||
      /^perspectiva visual de un paisaje\.?$/.test(c) ||
      /^satelite natural de la tierra\.?$/.test(c) ||
      /^termino que describe algo tranquilo\.?$/.test(c) ||
      /^punto de conexion o interseccion\.?$/.test(c) ||
      /^capa externa del cuerpo\.?$/.test(c) ||
      /^peces migratorios de agua dulce\.?$/.test(c) ||
      /^herramienta para excavar/.test(c) ||
      /^superficie de un lugar\.?$/.test(c) ||
      /^embarcacion para navegar en rios\.?$/.test(c) ||
      /^ciudad chilena cercana,? ruta turistica\.?$/.test(c) ||
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
    /^body of fresh water in the region\.?$/.test(c) ||
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
  const t = normalizeAnswer(theme);
  const a = normalizeAnswer(answer);
  if (t !== "MEGADETH") return false;

  const partialTitleWords = new Set([
    "SOULS",
    "TORNADO",
    "SWEATING",
    "COUNTDOWN",
    "CRYPTIC",
    "KILLING",
    "POLARIS",
  ]);
  if (!partialTitleWords.has(a)) return false;

  const c = clue
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (!/\b(song|track|album|title|titulo|cancion)\b/.test(c)) return false;
  return !/\b(word|part|first|last|opening|final|palabra|parte|primera|ultima)\b/.test(c);
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

function isKnownIncompleteTitleForTheme(theme: string, answer: string): boolean {
  const t = normalizeAnswer(theme);
  const a = normalizeAnswer(answer);
  if (t === "MEGADETH") {
    return (
      a === "HOLYWAR" ||
      a === "HOLY" ||
      a === "WARS" ||
      a === "SOFARSO" ||
      a === "SOFARSOOD" ||
      a === "SOFARSOGOOD" ||
      a === "PEACESELLER" ||
      a === "YOUTH" ||
      a === "SKULLS" ||
      a === "DROOGS" ||
      a === "DROOGIE"
    );
  }
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

  const specific = thematic ? specificThematicFallbackClue(theme, answer, language) : null;
  if (valid(specific)) return specific;

  const a = normalizeAnswer(answer);
  const placeContextEs: Record<string, string> = {
    ALBERGUE: `Alojamiento economico para viajeros que visitan ${theme}`,
    AVENTURA: `Actividad al aire libre asociada con el turismo de ${theme}`,
    BOSQUE: `Ambiente natural frecuente en la zona de ${theme}`,
    CAMPING: `Forma de alojamiento al aire libre usada por visitantes de ${theme}`,
    CANOA: `Embarcacion usada en actividades acuaticas asociadas con ${theme}`,
    CASCADA: `Caida de agua que puede formar parte de excursiones en la zona de ${theme}`,
    CERRO: `Elevacion natural caracteristica del paisaje de ${theme}`,
    CAMINO: `Via usada para recorrer o visitar la zona de ${theme}`,
    COLONIA: `Poblado o sector asociado con la historia local de ${theme}`,
    COSTA: `Orilla de los cuerpos de agua de la region de ${theme}`,
    EXCURSION: `Salida organizada para recorrer atractivos de ${theme}`,
    FAUNA: `Animales propios o asociados al entorno natural de ${theme}`,
    FESTIVAL: `Evento cultural que puede atraer visitantes a ${theme}`,
    FLORA: `Vegetacion asociada al entorno natural de ${theme}`,
    FRIO: `Baja temperatura asociada al clima de ${theme}`,
    GUIA: `Persona que orienta recorridos turisticos en ${theme}`,
    AGUA: `Elemento natural presente en lagos, rios u otros paisajes de ${theme}`,
    HOSTERIA: `Tipo de alojamiento turistico frecuente en ${theme}`,
    HOSTEL: `Alojamiento economico para viajeros que visitan ${theme}`,
    HOTEL: `Alojamiento para visitantes de ${theme}`,
    ISLA: `Tierra rodeada de agua que puede visitarse en excursiones desde ${theme}`,
    KAYAK: `Embarcacion usada para actividades acuaticas en la zona de ${theme}`,
    LAGO: `Cuerpo de agua frecuente en la region de ${theme}`,
    LAGOS: `Cuerpos de agua frecuentes en la region de ${theme}`,
    MAPA: `Representacion grafica util para recorrer ${theme}`,
    MIRADOR: `Punto elevado para apreciar el paisaje de ${theme}`,
    MUSEO: `Lugar cultural visitable en ${theme}`,
    NATURALEZA: `Entorno natural asociado con el paisaje de ${theme}`,
    NIEVE: `Elemento invernal asociado al paisaje de ${theme}`,
    NORTE: `Referencia geografica usada para ubicar la zona de ${theme}`,
    PAISAJE: `Vista natural destacada en ${theme}`,
    PARQUE: `Area natural o protegida asociada con ${theme}`,
    PASEO: `Recorrido breve para visitantes de ${theme}`,
    PATOS: `Aves acuaticas observables en ambientes de agua de la zona de ${theme}`,
    PESCA: `Actividad recreativa practicada en aguas de la zona de ${theme}`,
    PESCADOR: `Persona asociada a la pesca recreativa en aguas de la zona de ${theme}`,
    SALMONES: `Peces asociados a la pesca en aguas de la zona de ${theme}`,
    PLAYA: `Orilla junto al agua usada para descanso o paseo en ${theme}`,
    PUERTO: `Punto de salida o llegada de embarcaciones en la zona de ${theme}`,
    RANCHO: `Vivienda rural que puede asociarse al paisaje de ${theme}`,
    RANCHOS: `Construcciones rurales que pueden asociarse al paisaje de ${theme}`,
    REFUGIO: `Lugar de descanso o resguardo en travesias cercanas a ${theme}`,
    RIO: `Corriente natural de agua asociada al entorno de ${theme}`,
    RUTA: `Camino usado para recorrer la zona de ${theme}`,
    RUTAS: `Caminos usados para recorrer la zona de ${theme}`,
    SENDERO: `Camino senalizado para caminatas en la zona de ${theme}`,
    SUR: `Referencia geografica usada para ubicar la zona de ${theme}`,
    TOUR: `Recorrido organizado para visitantes de ${theme}`,
    TURISMO: `Actividad clave para quienes visitan ${theme}`,
    VALLE: `Depresion entre montanas o zona baja asociable al paisaje de ${theme}`,
    VERANO: `Temporada posible para recorrer atractivos de ${theme}`,
    VIAJE: `Traslado o recorrido para conocer ${theme}`,
    VILLA: `Localidad o sector residencial asociado con la zona de ${theme}`,
    VISTA: `Panorama observable desde puntos destacados de ${theme}`,
  };
  const placeContextEn: Record<string, string> = {
    ADVENTURE: `Outdoor activity associated with travel around ${theme}`,
    CAMPING: `Outdoor lodging used by visitors to ${theme}`,
    CASCADE: `Waterfall that can be part of excursions around ${theme}`,
    COAST: `Edge of bodies of water in the ${theme} area`,
    FAUNA: `Animals associated with the natural setting of ${theme}`,
    FLORA: `Plant life associated with the natural setting of ${theme}`,
    FOREST: `Natural wooded setting associated with ${theme}`,
    GUIDE: `Person who leads visitors around ${theme}`,
    HOSTEL: `Budget lodging for travelers visiting ${theme}`,
    HOTEL: `Lodging for visitors to ${theme}`,
    HILL: `Natural elevation in the landscape of ${theme}`,
    ISLAND: `Land surrounded by water that can be visited near ${theme}`,
    KAYAK: `Small boat used for water activities near ${theme}`,
    LAKE: `Body of water associated with the ${theme} area`,
    LAKES: `Bodies of water associated with the ${theme} area`,
    LOOKOUT: `Elevated point for viewing the landscape of ${theme}`,
    MAP: `Graphic aid for exploring ${theme}`,
    MUSEUM: `Cultural place visitors may see in ${theme}`,
    PARK: `Natural or protected area associated with ${theme}`,
    PORT: `Point where boats depart or arrive near ${theme}`,
    RIVER: `Natural stream associated with the setting of ${theme}`,
    REFUGE: `Shelter used during trips around ${theme}`,
    ROUTE: `Road or path used to explore ${theme}`,
    SNOW: `Winter element associated with the landscape of ${theme}`,
    TOURISM: `Travel activity centered on visiting ${theme}`,
    TOUR: `Organized route for visitors to ${theme}`,
    TRAIL: `Marked walking path around ${theme}`,
    VIEW: `Scene seen from a notable point in ${theme}`,
  };
  const contextualCommon = thematic
    ? language === "es"
      ? placeContextEs[a]
      : placeContextEn[a]
    : null;
  if (valid(contextualCommon)) return contextualCommon;

  const commonEs: Record<string, string> = {
    ANDES: "Cordillera que recorre el oeste sudamericano",
    AIRE: "Elemento natural asociado con espacios abiertos",
    AVENTURA: "Tipo de actividad al aire libre con cierto riesgo",
    BIRRA: "Forma coloquial de llamar a una bebida de cebada",
    BOSQUE: "Area natural cubierta de arboles",
    CAMPING: "Actividad de dormir al aire libre",
    CASCADA: "Caida natural de agua",
    CERRO: "Elevacion natural del terreno",
    CAMINO: "Via usada para trasladarse o recorrer una zona",
    CERVEZA: "Bebida fermentada de cebada y lupulo",
    DIAS: "Jornadas que puede durar una visita o viaje",
    COSTA: "Orilla entre tierra y agua",
    EXCURSION: "Salida organizada para visitar un lugar",
    FAUNA: "Conjunto de animales de una region",
    FESTIVAL: "Evento cultural o turistico con actividades",
    FLORA: "Vegetacion propia de una region",
    GUIA: "Persona o recurso que orienta un recorrido",
    AGUA: "Elemento natural presente en lagos y rios",
    HOSTERIA: "Tipo de alojamiento turistico",
    HIDRO: "Prefijo asociado con el agua",
    ALBERGUE: "Alojamiento economico para viajeros",
    HOSTEL: "Alojamiento economico para viajeros",
    HOTEL: "Alojamiento para visitantes",
    ISLA: "Terreno rodeado de agua",
    KAYAK: "Embarcacion pequena usada con remo",
    LAGO: "Gran cuerpo natural de agua",
    LAGOS: "Cuerpos naturales de agua",
    MAPA: "Representacion grafica de una zona",
    MIRADOR: "Lugar elevado desde donde se aprecia una vista",
    MUSEO: "Lugar de exhibicion cultural",
    NATURALEZA: "Conjunto de elementos naturales de un lugar",
    NIEVE: "Precipitacion blanca propia del invierno",
    NORTE: "Punto cardinal opuesto al sur",
    PAISAJE: "Vista natural apreciada por su belleza",
    PARQUE: "Espacio natural o protegido para visitar",
    PASEO: "Recorrido breve realizado por placer",
    PESCA: "Actividad con cana, red o anzuelo",
    PLAYA: "Orilla junto al agua usada para descanso o paseo",
    PUERTO: "Lugar de salida y llegada de embarcaciones",
    RANCHOS: "Construcciones rurales tradicionales",
    REFUGIO: "Lugar de descanso o resguardo en una travesia",
    RIO: "Corriente natural de agua",
    RUTA: "Camino usado para recorrer una zona",
    RUTAS: "Caminos usados para recorrer una zona",
    SENDERO: "Camino senalizado para caminar",
    SUR: "Punto cardinal opuesto al norte",
    TOUR: "Recorrido organizado para visitantes",
    TURISMO: "Actividad de viajar para conocer lugares",
    VALLE: "Terreno bajo entre montanas o alturas",
    VERANO: "Estacion calida del ano",
    VIAJE: "Traslado o recorrido para conocer un lugar",
    VISTA: "Panorama observado desde un punto",
    ZONA: "Area o sector de un territorio",
  };
  const commonEn: Record<string, string> = {
    ADVENTURE: "Outdoor activity with some risk",
    AIR: "Natural element associated with open spaces",
    CAMPING: "Sleeping outdoors as a recreational activity",
    CASCADE: "Natural fall of water",
    COAST: "Edge between land and water",
    FAUNA: "Animals of a region",
    FLORA: "Plant life of a region",
    FOREST: "Area covered with trees",
    GUIDE: "Person or resource that leads a visit",
    HOSTEL: "Budget lodging for travelers",
    HOTEL: "Lodging for visitors",
    HYDRO: "Prefix associated with water",
    HILL: "Natural elevation of land",
    ISLAND: "Land surrounded by water",
    KAYAK: "Small boat moved with a paddle",
    LAKE: "Large natural body of water",
    LAKES: "Natural bodies of water",
    LOOKOUT: "Elevated place for taking in a view",
    MAP: "Graphic representation of an area",
    MUSEUM: "Place for cultural exhibits",
    PARK: "Natural or protected area to visit",
    PORT: "Place where boats depart or arrive",
    RIVER: "Natural stream of water",
    REFUGE: "Shelter used during a journey",
    ROUTE: "Road or path used to travel through an area",
    SNOW: "White winter precipitation",
    TOURISM: "Travel activity focused on visiting places",
    TOUR: "Organized route for visitors",
    TRAIL: "Marked path for walking",
    VIEW: "Scene seen from a point",
    AREA: "Part or sector of a place",
  };
  const common = language === "es" ? commonEs[a] : commonEn[a];
  if (valid(common)) return common;

  const musicTheme =
    /MEGADETH|METALLICA|BEATLES|BAND|MUSIC|ROCK|METAL|JAZZ|PUNK/.test(normalizeAnswer(theme));
  if (musicTheme) {
    const musicEn: Record<string, string> = {
      ALBUM: `Recorded release associated with ${theme}`,
      ARENA: `Large venue where ${theme} could perform`,
      AMP: `Amplifier used for loud ${theme} guitar tones`,
      AXE: `Slang term for an electric guitar`,
      BAND: `Performing group form used by ${theme}`,
      BASS: `Low-pitched instrument part in ${theme}'s music`,
      BEAT: `Rhythmic pulse under ${theme}'s music`,
      CABLE: `Stage gear used for amplified ${theme} performances`,
      CAB: `Speaker cabinet used with a guitar amp`,
      CHORD: `Group of notes used in heavy guitar music`,
      CYMBAL: `Metal percussion disk in a drum kit`,
      DRUMS: `Percussion instrument set used in ${theme}'s music`,
      FANS: `Audience following associated with ${theme}`,
      FAN: `Follower of ${theme}`,
      FRET: `Raised strip on a guitar neck`,
      GIG: `Live music job or concert date`,
      GAIN: `Amplifier control for heavier guitar distortion`,
      HOOK: `Memorable musical phrase in a song`,
      JAM: `Informal playing session by musicians`,
      KICK: `Bass drum sound in rock music`,
      LABEL: `Company or imprint that releases music`,
      LIVE: `Performed before an audience rather than in studio`,
      LOGO: `Visual mark used on band merchandise`,
      LYRIC: `Line or words from a song`,
      MELODY: `Tune carried by a song or vocal line`,
      MERCH: `Band merchandise sold around concerts`,
      METAL: `Heavy music genre associated with ${theme}`,
      MIC: `Microphone used for vocals onstage`,
      MOSH: `Concert-floor movement associated with metal shows`,
      LOUD: `High-volume sound associated with ${theme} concerts`,
      MUSIC: `Art form performed by ${theme}`,
      PEDAL: `Guitar effect control used onstage`,
      PICK: `Small plectrum used to play guitar`,
      PIT: `Moshing area at a metal concert`,
      POSTER: `Band image or tour art displayed by fans`,
      RECORD: `Recorded music release by or around ${theme}`,
      RIFF: `Repeated guitar phrase common in metal music`,
      RIG: `Musician's setup of instruments and gear`,
      ROCK: `Amplified music style tied to metal bands`,
      ROLL: `Word paired with rock in music culture`,
      ROADIE: `Crew member who helps a band on tour`,
      ROCKER: `Rock musician or fan`,
      SCREAM: `Aggressive vocal sound used in heavy music`,
      SET: `Group of songs played in a concert`,
      SHOW: `Live performance event for ${theme}`,
      SHRED: `Fast lead-guitar playing style`,
      SNARE: `Sharp-sounding drum in a kit`,
      SOLO: `Featured instrumental passage in a rock song`,
      SONG: `Individual piece performed by ${theme}`,
      STAGE: `Performance platform for a band`,
      STUDIO: `Place where music is recorded`,
      TEMPO: `Speed of a piece of music`,
      THRASH: `Fast heavy-metal style associated with Megadeth`,
      TICKET: `Concert admission item`,
      TRACK: `Individual song on an album`,
      TUNER: `Device used to tune a guitar or bass`,
      TOUR: `Series of concerts in different cities`,
      VERSE: `Section of a song between repeated choruses`,
      VOCALS: `Sung part of a band's music`,
    };
    const musicEs: Record<string, string> = {
      ALBUM: `Disco grabado asociado con ${theme}`,
      ARENA: `Recinto grande donde podria tocar ${theme}`,
      AMP: `Amplificador usado para guitarras fuertes`,
      AXE: `Jerga inglesa para guitarra electrica`,
      BAND: `Formato de grupo musical de ${theme}`,
      BASS: `Parte grave de la musica de ${theme}`,
      BEAT: `Pulso ritmico bajo la musica de ${theme}`,
      CABLE: `Elemento de escenario usado en shows amplificados`,
      CAB: `Caja de parlantes usada con amplificador`,
      CHORD: `Conjunto de notas usado en musica de guitarras`,
      CYMBAL: `Platillo metalico de una bateria`,
      DRUMS: `Bateria usada en la musica de ${theme}`,
      FANS: `Publico seguidor asociado con ${theme}`,
      FAN: `Seguidor de ${theme}`,
      FRET: `Traste del mastil de una guitarra`,
      GIG: `Fecha de concierto o show musical`,
      GAIN: `Control de amplificador para distorsion pesada`,
      HOOK: `Frase musical memorable de una cancion`,
      JAM: `Sesion informal de musicos tocando`,
      KICK: `Golpe grave del bombo en rock`,
      LABEL: `Compania o sello que publica musica`,
      LIVE: `Tocado frente al publico, no en estudio`,
      LOGO: `Marca visual usada en material de una banda`,
      LYRIC: `Linea o letra de una cancion`,
      MELODY: `Melodia llevada por una cancion`,
      MERCH: `Mercaderia vendida alrededor de recitales`,
      METAL: `Genero pesado asociado con ${theme}`,
      MIC: `Microfono usado para voces en vivo`,
      MOSH: `Movimiento del publico en recitales de metal`,
      LOUD: `Sonido de alto volumen asociado con conciertos de ${theme}`,
      MUSIC: `Arte sonoro interpretado por ${theme}`,
      PEDAL: `Control de efecto usado por guitarristas`,
      PICK: `Pua pequena usada para tocar guitarra`,
      PIT: `Zona de pogo en un recital de metal`,
      POSTER: `Afiche de una banda o gira musical`,
      RECORD: `Grabacion musical vinculada con ${theme}`,
      RIFF: `Frase repetida de guitarra comun en el metal`,
      RIG: `Equipo completo de instrumentos y amplis`,
      ROCK: `Estilo amplificado ligado a bandas de metal`,
      ROLL: `Palabra emparejada con rock en la cultura musical`,
      ROADIE: `Tecnico que ayuda a una banda en gira`,
      ROCKER: `Musico o fan del rock`,
      SCREAM: `Voz agresiva usada en musica pesada`,
      SET: `Grupo de canciones tocadas en un concierto`,
      SHOW: `Presentacion en vivo de ${theme}`,
      SHRED: `Estilo de guitarra solista muy veloz`,
      SNARE: `Tambor agudo de una bateria`,
      SOLO: `Pasaje instrumental destacado en una cancion`,
      SONG: `Pieza individual interpretada por ${theme}`,
      STAGE: `Plataforma donde toca una banda`,
      STUDIO: `Lugar donde se graba musica`,
      TEMPO: `Velocidad de una pieza musical`,
      THRASH: `Estilo veloz de heavy metal asociado con Megadeth`,
      TICKET: `Entrada para un concierto`,
      TRACK: `Cancion individual dentro de un album`,
      TUNER: `Dispositivo para afinar guitarra o bajo`,
      TOUR: `Serie de conciertos en distintas ciudades`,
      VERSE: `Seccion de una cancion entre estribillos`,
      VOCALS: `Parte cantada de la musica de una banda`,
    };
    const musicClue = language === "es" ? musicEs[a] : musicEn[a];
    if (valid(musicClue)) return musicClue;
  }

  if (language === "es") {
    if (a.startsWith("LAGO")) return valid(`Lago asociado con ${theme}`) ? `Lago asociado con ${theme}` : null;
    if (a.startsWith("CERRO")) return valid(`Cerro asociado con ${theme}`) ? `Cerro asociado con ${theme}` : null;
    if (a.startsWith("RIO")) return valid(`Rio asociado con ${theme}`) ? `Rio asociado con ${theme}` : null;
    if (a.startsWith("ISLA")) return valid(`Isla asociada con ${theme}`) ? `Isla asociada con ${theme}` : null;
    if (a.startsWith("PUERTO")) return valid(`Puerto asociado con ${theme}`) ? `Puerto asociado con ${theme}` : null;
    if (thematic) {
      const properName = `Referencia local documentada en fuentes sobre ${theme}`;
      return valid(properName) ? properName : null;
    }
    return null;
  }

  if (a.startsWith("LAKE")) return `Lake associated with ${theme}`;
  if (a.startsWith("MOUNT")) return `Mountain associated with ${theme}`;
  if (a.startsWith("RIVER")) return `River associated with ${theme}`;
  if (a.startsWith("ISLAND")) return `Island associated with ${theme}`;
  if (thematic) {
    const properName = `Documented local reference in sources about ${theme}`;
    return valid(properName) ? properName : null;
  }
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
  const t = normalizeAnswer(theme);
  const c = clue
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const themeLooksMusical =
    /beatles|rolling|stones|metallica|megadeth|abba|band|banda|music|musica|rock|jazz|punk/.test(
      t.toLowerCase()
    );

  if (!themeLooksMusical && /\b(megadeth|metallica|beatles|banda|grupo|rock|musica|musical|musico|cancion|album|mascota)\b/.test(c)) {
    return true;
  }

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

const WINE_DOMAIN_ANSWERS = new Set([
  "BRUT",
  "CATA",
  "CAVA",
  "CEPA",
  "CEPAS",
  "MALBEC",
  "MERLOT",
  "NOIR",
  "PINOT",
  "RACIMO",
  "TANINO",
  "TANINOS",
  "TERROIR",
  "UVA",
  "UVAS",
  "VID",
  "VINO",
  "VINOS",
]);

const FOOD_DOMAIN_ANSWERS = new Set([
  "ASADO",
  "CENA",
  "COMIDA",
  "DULCE",
  "FRUTA",
  "MILANESA",
  "PASTEL",
  "PLATO",
  "QUESO",
  "TORTA",
]);

const BARILOCHE_OFF_THEME_ANSWERS = new Set([
  "BAGRE",
  "PUCON",
  "TROUT",
  "VUELO",
]);

function isDomainContextSupported(theme: string, note: string | undefined, domain: "wine" | "food"): boolean {
  const text = `${theme} ${note ?? ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (domain === "wine") {
    return /\b(vino|vinos|wine|winery|bodega|bodegas|uva|uvas|grape|grapes|viñedo|vinedo|vineyard|vitivinic|enolog|cepa|cepas|malbec|merlot|pinot|cabernet|noir)\b/.test(
      text
    );
  }

  return /\b(comida|food|cocina|cuisine|gastronom|restaurant|restaurante|plato|dish|receta|recipe|culinari|asado|curanto|chocolate|fondue)\b/.test(
    text
  );
}

function isUnsupportedDomainAnswerForTheme(theme: string, answer: string, note?: string): boolean {
  const a = normalizeAnswer(answer);
  if (!a) return true;
  const themeNorm = normalizeAnswer(theme);

  if (themeNorm === "BARILOCHE" && BARILOCHE_OFF_THEME_ANSWERS.has(a)) return true;

  if (WINE_DOMAIN_ANSWERS.has(a) && !isDomainContextSupported(theme, note, "wine")) return true;
  if (FOOD_DOMAIN_ANSWERS.has(a) && !isDomainContextSupported(theme, note, "food")) return true;

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
  const { theme, answer, language, size, note, allowContextualGeneric = false } = opts;
  const a = normalizeAnswer(answer);
  if (!a) return false;
  if (a === normalizeAnswer(theme)) return false;
  if (isKnownIncompleteTitleForTheme(theme, a)) return false;
  if (!ASCII_A_TO_Z.test(a)) return false;
  if (!answerLanguageLooksValidForPuzzle(a, language)) return false;
  if (a.length < minEntryLenForSize(size) || a.length > size) return false;
  if (isLikelyBadAnswer(a) && !ALWAYS_ALLOW_ANSWERS.has(a)) return false;
  if (size <= 11 && isRiskyGeneratedGeographicCompound(theme, a)) return false;
  if (isUnsupportedDomainAnswerForTheme(theme, a, note)) return false;
  if (!allowContextualGeneric && LOW_VALUE_CONTEXTLESS_ANSWERS.has(a)) return false;

  return true;
}

// -------------------- Theme anchors / overrides --------------------

const ALWAYS_ALLOW_ANSWERS = new Set<string>([]); // theme-agnostic
const ENABLE_LEGACY_TOPIC_SUPPORT = false;
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
  "TURIS", "PAISA", "PATAG", "ANDIN", "CHOCOL", "ARTES", "PANOR", "FOTOG", "FAMIL", "SENDER", "MERKADO",
  "ADIE", "ENTRAL", "GAR", "NTRAL", "NZA", "FRES", "HUITR", "SILV", "VERD", "VALL", "SEND", "SDEL", "VIVI", "OTT", "TEDRA", "NAVEG", "MELI", "TRANC", "MASC", "COSTAN",
  "ADRIFTING", "AEROLIB", "ALECE", "ALMOND", "ALPINIS", "ARAUCA", "ARENDEX", "ARGENT", "ARMIR12", "ARTESAN", "ATOMICA", "ATOMICENTRE", "BURILOCHE", "CAMP", "CAMPAN", "CAMINOSIETE", "CANACOLIHUE", "CENICIE", "CERROCAMP", "CERVEC", "CERVECER", "CICLIS", "CICLISM", "CIRCUIT", "CIUDADB", "CIVICCENTRE", "CIVICENTRE", "COIHUEDEM", "CORDER", "COSTANER", "CULTUR", "CULI", "ELLAOELAO", "ESQUIMOSKI", "FUERADE", "GASTRON", "GOLFLLAO", "GRADTRIP", "GUAT", "HHOTEL", "HORIZON", "HOTLLUOLLAO", "HOTELOGLI", "IPVAP", "LAGOBLANCO", "LAGOARGENT", "LAGOGUAT", "LAGOHERMOSO", "LAGOLIMPIO", "LAGOLOMA", "LAGOMORO", "LAGOSILVINA", "LAGOSOL", "LAGOSUR", "LAGOTRANC", "LAGOTRANCAS", "LAGOVIED", "LAGOVIEDMA", "LERALI", "LERPUMILIO", "LLOALLOO", "LOLIMPE", "LTACUL", "LUMI", "MASARDI", "MIBUS", "NATELHUAPI", "NATURA", "NATURALAP", "NATURALE", "NIE", "NUEVACHEL", "NUEVORUED", "OSEQUIPO", "PASEONUEVO", "PASSEOS", "PATABOS", "PATAGON", "PATRIMON", "PDAO", "PELUCHECOY", "PILTRAF", "POYAS", "PUEYL", "RAIDGAUL", "RAPA", "RUTHMER", "SENDERIS", "STUDENTTOUR", "SWISSTYLED", "TELSILLA", "TURONADOR", "VIED", "VERGEO", "VILLALTACUL", "VURILOCHE",
]);

const CONTEXTUAL_GENERIC_ANSWERS = new Set(["HIDRO"]);
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

const CONTEXTUAL_SUPPORT_ANSWERS = new Set([
  "ALBERGUE",
  "AVENTURA",
  "BOSQUE",
  "CAMPING",
  "CANOA",
  "CERRO",
  "CAMINO",
  "COAST",
  "COSTA",
  "FAUNA",
  "FLORA",
  "FOREST",
  "FRIO",
  "GUIA",
  "GUIDE",
  "AGUA",
  "HOSTERIA",
  "HOTEL",
  "HOSTEL",
  "ISLA",
  "ISLAND",
  "KAYAK",
  "LAGO",
  "LAKE",
  "MAP",
  "MAPA",
  "MIRADOR",
  "MUSEO",
  "MUSEUM",
  "NATURALEZA",
  "NIEVE",
  "NORTE",
  "PARK",
  "PARQUE",
  "PASEO",
  "PATOS",
  "PESCA",
  "PESCADOR",
  "SALMONES",
  "PLAYA",
  "PUERTO",
  "RANCHO",
  "RANCHOS",
  "REFUGIO",
  "RIO",
  "RIVER",
  "ROUTE",
  "RUTA",
  "RUTAS",
  "SENDERO",
  "SUR",
  "TOUR",
  "TRAIL",
  "TURISMO",
  "VALLE",
  "VERANO",
  "VIAJE",
  "VIEW",
  "VISTA",
]);

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
  "SANDS","SKIES","TACOS","TIDAL","TRAIL","TRAILS","TREE","TREES","VALLEY","WATER","WATERS","WILD","WINDY","WINE",
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
  const a = normalizeAnswer(answer);
  if (!a || isThemeCoreWord(theme, a)) return false;

  const prefixes = [
    "CERRO",
    "LAGO",
    "LAKE",
    "RIO",
    "RIVER",
    "ISLA",
    "ISLAND",
    "PUERTO",
    "PORT",
    "VILLA",
    "COLONIA",
    "PARQUE",
    "PARK",
    "MONTE",
    "MOUNT",
  ];

  return prefixes.some((prefix) => a.startsWith(prefix) && a.length >= prefix.length + 3);
}

function isOverGenericThemeWordForTheme(theme: string, answer: string): boolean {
  if (isThemeCoreWord(theme, answer)) return false;

  const t = normalizeAnswer(theme);
  const a = normalizeAnswer(answer);

  if (t === "VINO" || t === "WINE") {
    const tooLooseForWine = new Set([
      "CUBO","HIELO","JUGO","RICO","PICO","TROPA","CIEGA","MALTA","VISTA","BODEG",
      "TAPAS","SABOR","PICOS","FIESTA","RACIM","HOGAR","MESA","BARRA","BEBER","FRUTA",
      "BANDA","CIELO","FLORES","BEBE","SABE","TINO","SUIZO","TERRA","CANTO",
      "CENA","TROZO","ACEITE","TANIN"
    ]);
    if (tooLooseForWine.has(a)) return true;
  }

  if (t === "ARGENTINA") {
    const tooLooseForArgentina = new Set([
      "BANDA","GUITARRA","VINO","SABOR","RITMO","RUMBA","LAGO","FLORE","SUELO","RAPID",
      "VIVIR","RANGO","DANZA","RIVAS","LUCES","COSTA","COSTAS","COSTUM","NATURA","SUENO","FRESCO","CARNES",
      "LIMON","QUESO","PAPAS","TORTA","SUENOS","TRADIC","RITMOS","CULTA"
    ]);
    if (tooLooseForArgentina.has(a)) return true;
  }

  if (t === "MENDOZA") {
    const tooLooseForMendoza = new Set([
      "FRESCO","RICO","TERRA","RIEGO","FLORES","VINOS","BLANCO","TINTA",
      "RUTAS","CIELO","HOGAR","VERDE","TROPA","FRUTA","SUENO",
      "RANGO","SABOR","CUEVA","CULTI","SUELO","CIEGA","ARGENTO","DULCE",
      "LAGO","VIDA","FLOR","COSTA","CARNE","CARNI"
    ]);
    if (tooLooseForMendoza.has(a)) return true;
  }

  if (t === "BARILOCHE") {
    const tooLooseForBariloche = new Set([
      "VINO","VINOS","UVA","UVAS","VID","CEPA","CEPAS","MOSTO","CAVA","BRUT",
      "CATA","TANINO","TANINOS","BODEGA","BODEGAS","MALBEC","MERLOT","CABERNET",
      "TEMPRANILLO","VINICOLA","RACIMO","RAPIDO","RAPID","TINTA","BLANCO",
      "NORTON","PULENTA","MAIPU","UCO","TUNUYAN","SANRAFAEL","GODOYCRUZ",
      "GUAYMALLEN","USPALLATA","ACONCAGUA","RICO","FRESCO","SABOR","TERRA",
      "HESS","CIELO","ALMA","AMOR","TURBO","LUCES","CAMPER","BOCA","BESO",
      "CASA","CARA","CAMA","CIMA","CUEVA","PICO","VERDE","MONTE","FAUNA",
      "NAVEG","CERROPIEDRA","CENA","AZUL","ALTO","BAJO","BASE","ARTE","RAMA"
    ]);
    if (tooLooseForBariloche.has(a)) return true;
  }

  if (t === "JAPON" || t === "JAPAN") {
    const tooLooseForJapan = new Set([
      "LETRA","PAISA","AGUA","MUNDO","FLOR","LUNA","PAPEL","BANDA","FUEGO","CAMA",
      "SUENO","BOLSA","NIEVE","FIESTA","SOLAR","RUTA","COSTA","CULTA","MUNDO",
      "PAISA","AGUA","LAGO","TAIKO"
    ]);
    if (tooLooseForJapan.has(a)) return true;
  }

  if (t === "MEGADETH") {
    const tooLooseForMegadeth = new Set([
      "ESCENA","ALBUM","LETRA","CONCIER","TEMA","RITMO","MUSICA","RUIDO","ESTILO",
      "FANATIC","CANTAR","BANDA","FUEGO","CAMA","PAPEL","LUNA","FLOR","MUNDO",
      "AGUA","PAISA","SOLAR","FIESTA","BOLSA","NIEVE","RUTA","COSTA","CULTA",
      "LUCES","SUENO","DOLOR","RAPAZ","FUSION","TEMA","RUIDO","ACUSTIC","ACOUSTIC",
      "VIBRA","VIBRANTE","PULSO","NIVEL","DANZA","FESTIVAL","VIRTUAL","SONAR",
      "VIVO","ELECTRO","ESCENA","CONCIERTO"
    ]);
    if (tooLooseForMegadeth.has(a)) return true;
  }

  if (t === "METALLICA") {
    const tooLooseForMetallica = new Set([
      "ALBUM","LETRA","MUSICA","RITMO","BANDA","CANTAR","ESTILO","RUIDO","FANATIC",
      "ESCENA","CONCIERTO","VIBRA","VIBRANTE","PULSO","NIVEL","DANZA","FESTIVAL",
      "VIRTUAL","SONAR","VIVO","ELECTRO","LUCES","SUENO","DOLOR","RAPAZ","FUSION",
      "AGUA","PAISA","SOLAR","FIESTA","BOLSA","NIEVE","RUTA","COSTA","CULTA",
      "FUEGO","CAMA","PAPEL","LUNA","FLOR","MUNDO","ACUSTIC","ACOUSTIC"
    ]);
    if (tooLooseForMetallica.has(a)) return true;
  }

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
  const prefixes = [
    "CERRO",
    "LAGO",
    "RIO",
    "ISLA",
    "PUERTO",
    "VILLA",
    "COLONIA",
    "RUTA",
    "PARQUE",
    "MONTE",
  ];
  const out: string[] = [];

  for (const answer of answers) {
    const a = normalizeAnswer(answer);
    if (!a) continue;

    for (const prefix of prefixes) {
      if (!a.startsWith(prefix)) continue;
      if (MODEL_FRAGMENT_ANSWERS.has(a)) continue;
      const suffix = a.slice(prefix.length);
      if (suffix.length < 3 || suffix.length > maxLen) continue;
      if (!ASCII_A_TO_Z.test(suffix)) continue;
      if (BANNED_ANSWERS.has(suffix)) continue;
      if (isLikelyBadAnswer(suffix) && !ALWAYS_ALLOW_ANSWERS.has(suffix)) continue;
      if (prefix.length >= 3 && prefix.length <= maxLen && !BANNED_ANSWERS.has(prefix)) out.push(prefix);
      out.push(suffix);
    }
  }

  return Array.from(new Set(out));
}

function specificThematicFallbackClue(theme: string, answer: string, language: "es" | "en"): string | null {
  const a = normalizeAnswer(answer);
  const t = theme.trim().toLowerCase();
  const themeNorm = normalizeAnswer(theme);

  if (!ENABLE_LEGACY_TOPIC_SUPPORT && themeNorm !== "BARILOCHE" && themeNorm !== "MEGADETH" && themeNorm !== "METALLICA") {
    return null;
  }

  if (language === "en" && t === "california") {
    const exact: Record<string, string> = {
      BERKELEY: "Bay Area city known for its major university",
      BURLINGAME: "Bay Area city near San Francisco International Airport",
      CARMEL: "Scenic California town on the Monterey Peninsula",
      FRESNO: "Central California city in the San Joaquin Valley",
      GOLD: "Metal tied to California's 1849 gold rush",
      HUMBOLDT: "Northern California county associated with giant redwoods",
      IRVINE: "Master-planned city in Orange County, California",
      LONGBEACH: "Southern California port city on the Pacific coast",
      LOSANGELES: "Largest city in California",
      MALIBU: "Famous beach city in California known for surf culture",
      MENDOCINO: "Northern California region known for coastline and wine",
      MERCED: "Central California city in the San Joaquin Valley",
      MODESTO: "Central California city in the San Joaquin Valley",
      MONTEREY: "California coastal city known for its historic bay",
      NAPA: "Famous wine-producing region in California",
      OAKLAND: "Bay Area city east of San Francisco",
      OJAI: "California town known for its valley setting",
      ORANGE: "County in Southern California",
      PALOALTO: "Silicon Valley city in the San Francisco Bay Area",
      REDDING: "Northern California city near the Sacramento River",
      REDWOOD: "Tree strongly associated with Northern California",
      RIVERSIDE: "Southern California city in the Inland Empire",
      SACRAMENTO: "Capital city of California",
      SANDIEGO: "Major city in Southern California near the Mexican border",
      SANJOSE: "Large Silicon Valley city in Northern California",
      SANTAANA: "Orange County city in Southern California",
      SANTACLARA: "Silicon Valley city and county name in California",
      SANTACRUZ: "California coastal city and county on Monterey Bay",
      SANTAROSA: "Sonoma County city in Northern California",
      SEQUOIA: "National park and giant tree name associated with California",
      SILICON: "Word strongly associated with Silicon Valley",
      SONOMA: "Another prominent wine region in California",
      VENTURA: "California coastal city and county name",
      VISTA: "City in San Diego County, California",
      YOSEMITE: "National park in California known for granite cliffs",
    };

    return exact[a] ?? null;
  }

  if ((language === "en" && t === "argentina") || (language === "es" && t === "argentina")) {
    const exactEn: Record<string, string> = {
      ALFAJOR: "Sweet sandwich cookie popular in Argentina",
      ASADO: "Argentine barbecue tradition centered on grilled meat",
      BARILOCHE: "Patagonian city in Argentina known for lakes and chocolate",
      BIFE: "Spanish word often used for a steak cut in Argentina",
      CABA: "Abbreviation widely used for Buenos Aires city proper",
      EVITAPERON: "First Lady of Argentina often referred to as Evita",
      LITORAL: "Argentine region around the Parana and Uruguay rivers",
      MALBEC: "Red grape variety strongly associated with Argentina",
      MATE: "Traditional herbal drink shared from a gourd",
      MILANESA: "Breaded meat cutlet popular across Argentina",
      PAMPAS: "Vast grassland region strongly associated with Argentina",
      PROVOLETA: "Grilled provoleta cheese served at an Argentine asado",
      TIGRE: "Buenos Aires area town known for its delta waterways",
      VIEDMA: "Capital city of Rio Negro province in Argentina",
      BUENOSAIRES: "Capital city of Argentina",
      CORDOBA: "Major city and province in central Argentina",
      ROSARIO: "Major city in Santa Fe province, Argentina",
      MENDOZA: "Argentine province famous for wine production",
      IGUAZU: "Falls on the border of Argentina and Brazil",
      PATAGONIA: "Southern region shared by Argentina and Chile",
      TANGO: "Music and dance style strongly associated with Argentina",
    };

    const exactEs: Record<string, string> = {
      ALFAJOR: "Dulce relleno muy popular en Argentina",
      ASADO: "Parrillada tradicional muy asociada con Argentina",
      BARILOCHE: "Ciudad patagonica argentina famosa por lagos y montanas",
      BIFE: "Corte de carne muy usado en la cocina argentina",
      CABA: "Sigla muy usada para la Ciudad Autonoma de Buenos Aires",
      EVITAPERON: "Primera dama argentina conocida popularmente como Evita",
      LITORAL: "Region argentina asociada a los rios Parana y Uruguay",
      MALBEC: "Variedad de uva tinta muy asociada con Argentina",
      MATE: "Infusion tradicional compartida en ronda",
      MILANESA: "Filete empanado muy popular en Argentina",
      PAMPAS: "Gran llanura muy asociada con Argentina",
      PROVOLETA: "Queso a la parrilla tipico del asado argentino",
      TIGRE: "Localidad bonaerense muy asociada con el delta del Parana",
      VIEDMA: "Capital de la provincia argentina de Rio Negro",
      BUENOSAIRES: "Capital de Argentina",
      CORDOBA: "Importante ciudad y provincia del centro argentino",
      ROSARIO: "Importante ciudad argentina de la provincia de Santa Fe",
      MENDOZA: "Provincia argentina muy asociada con el vino",
      IGUAZU: "Cataratas en la frontera entre Argentina y Brasil",
      PATAGONIA: "Region del sur compartida por Argentina y Chile",
      TANGO: "Genero musical y baile muy asociado con Argentina",
    };

    return language === "en" ? (exactEn[a] ?? null) : (exactEs[a] ?? null);
  }

  if ((language === "en" && t === "bariloche") || (language === "es" && t === "bariloche")) {
    const exactEn: Record<string, string> = {
      ANDES: "Mountain range beside Bariloche",
      ARRAYANES: "National park near Bariloche known for myrtle trees",
      AVELLANO: "Tree name seen in Patagonian-Andean flora references",
      BUSTILLO: "Avenue running along Nahuel Huapi in Bariloche",
      CAMPANARIO: "Viewpoint hill near Bariloche",
      CATEDRAL: "Major ski area near Bariloche",
      CERVEZA: "Craft drink strongly associated with Bariloche",
      CHOCOLATE: "Sweet specialty sold throughout Bariloche",
      CIVICO: "Bariloche square: Centro ___",
      COLONIA: "First word of the Swiss-style village nearby",
      CURANTO: "Traditional dish associated with Colonia Suiza",
      ESQUI: "Winter sport practiced at Cerro Catedral",
      FREY: "Mountain refuge and area near Bariloche",
      GUTIERREZ: "Lake south of Bariloche",
      HUAPI: "Second word of Bariloche's main lake",
      LAGO: "Body of water central to Bariloche's landscape",
      LAGOMORENO: "Lake west of Bariloche",
      LAGOS: "Bariloche is famous for these bodies of water",
      LIMAY: "River that begins at Nahuel Huapi",
      LLAOLLAO: "Iconic hotel and area near Bariloche",
      LOPEZ: "Hill and refuge name near Bariloche",
      MASCARDI: "Lake in Nahuel Huapi National Park",
      MELIPAL: "Bariloche neighborhood and beach name",
      MORENO: "Lake west of Bariloche",
      NAHUEL: "First word in Bariloche's main lake",
      NIEVE: "Winter feature at Bariloche ski areas",
      NIRE: "Native Patagonian tree found around Bariloche",
      OTTO: "Hill reached by cable car in Bariloche",
      PATAGONIA: "Southern region where Bariloche is located",
      PIONEROS: "Early settlers remembered in Bariloche place names",
      RASTREO: "Tracking activity used on Bariloche trails and outings",
      RIONEGRO: "Argentine province containing Bariloche",
      RUTA: "Roadway term for trips around Bariloche",
      RUTA40: "Iconic Argentine highway used to reach Bariloche",
      RUTAS: "Roads used to tour the Bariloche area",
      SUIZA: "Second word of the historic village nearby",
      TRONADOR: "Extinct volcano near Bariloche",
    };

    const exactEs: Record<string, string> = {
      ANDES: "Cordillera junto a Bariloche",
      ARRAYANES: "Parque nacional cercano famoso por sus arboles",
      AVELLANO: "Arbol mencionado en referencias de flora andino-patagonica",
      BUSTILLO: "Avenida que bordea el Nahuel Huapi",
      CAMPANARIO: "Cerro mirador cercano a Bariloche",
      CATEDRAL: "Centro de esqui emblematico de Bariloche",
      CERVEZA: "Bebida artesanal muy asociada con Bariloche",
      CHICO: "Segunda palabra de Circuito Chico",
      CHOCOLATE: "Dulce tipico de Bariloche",
      CIVICO: "Centro ___, postal clasica de Bariloche",
      COLONIA: "Primera palabra del poblado suizo cercano",
      CURANTO: "Comida tradicional de Colonia Suiza",
      ESQUI: "Deporte invernal practicado en Cerro Catedral",
      FREY: "Topografo suizo-argentino ligado al Nahuel Huapi",
      GUTIERREZ: "Lago al sur de Bariloche",
      HUAPI: "Segunda palabra del lago principal de Bariloche",
      LAGO: "Cuerpo de agua clave del paisaje barilochense",
      LAGOMORENO: "Lago al oeste de Bariloche",
      LAGOS: "Bariloche es famosa por estos cuerpos de agua",
      LIMAY: "Rio que nace en el Nahuel Huapi",
      LLAOLLAO: "Hotel y zona iconica de Bariloche",
      LOPEZ: "Cerro y refugio cercano a Bariloche",
      MASCARDI: "Lago del Parque Nacional Nahuel Huapi",
      MELIPAL: "Barrio y playa de Bariloche",
      MORENO: "Lago al oeste de Bariloche",
      NAHUEL: "Primera palabra del lago principal de Bariloche",
      NIEVE: "Elemento invernal de los cerros barilochenses",
      NIRE: "Arbol nativo patagonico presente en la zona",
      OTTO: "Cerro con teleferico en Bariloche",
      PATAGONIA: "Region argentina donde esta Bariloche",
      PIONEROS: "Primeros pobladores recordados en la historia local",
      RASTREO: "Seguimiento de huellas en senderos y salidas de montana",
      RIONEGRO: "Provincia argentina donde esta Bariloche",
      RUTA: "Camino usado para recorrer la zona de Bariloche",
      RUTA40: "Ruta nacional emblematica para llegar a Bariloche",
      RUTAS: "Caminos usados para recorrer la zona",
      SUIZA: "Segunda palabra del poblado historico cercano",
      TRONADOR: "Volcan extinto cercano a Bariloche",
    };

    return language === "en" ? (exactEn[a] ?? null) : (exactEs[a] ?? null);
  }

  if ((language === "en" && t === "wine") || (language === "es" && t === "vino")) {
    const exactEn: Record<string, string> = {
      ALBARINO: "White grape variety popular in Spain",
      BLANCOS: "Spanish term for white wines",
      BODEGA: "Spanish winery or wine cellar",
      BODEGAS: "Spanish wineries or wine cellars",
      BRUT: "Dry sparkling-wine style with very little sugar",
      CABERNET: "Grape name seen in wines like Cabernet Sauvignon",
      CAVA: "Spanish sparkling wine made by the traditional method",
      CATA: "Spanish word for a wine tasting",
      COPA: "Stemmed glass commonly used to serve wine",
      FRESCO: "Tasting descriptor for a lively, crisp wine",
      GARNACHA: "Spanish name for the Grenache grape",
      JEREZ: "Spanish wine style and region known for sherry",
      MALBEC: "Red grape variety strongly associated with Argentina",
      RACIMO: "Cluster of grapes on the vine",
      SALUD: "Spanish toast often said before drinking wine",
      SANGRIA: "Wine punch commonly served chilled in Spain",
      TREBBIANO: "Italian white grape variety used in many wines",
      SANGIOVESE: "Italian red grape variety used in many Tuscan wines",
      SUELO: "Part of the terroir that influences the vine",
      TANNAT: "Red grape variety associated with Uruguay",
      TANNICO: "Italian word meaning tannic",
      TEMPRANILLO: "Spanish red grape variety used in wines like Rioja",
      TINTA: "Spanish word for a red-wine grape",
      VINO: "Spanish word for wine",
      VINOS: "Spanish word for wines",
      VINICULTOR: "Spanish term for a winegrower or winemaker",
      VINICOLA: "Related to wine production",
      VITIS: "Botanical genus of grapevines",
      DULCE: "Spanish descriptor for a sweet wine",
      NERO: "Italian word often seen in grape names",
      SIRAH: "Alternative spelling of the Syrah grape",
    };

    const exactEs: Record<string, string> = {
      ALBARINO: "Variedad de uva blanca muy usada en España",
      BLANCOS: "Nombre que reciben los vinos blancos",
      BODEGA: "Lugar donde se produce o guarda vino",
      BODEGAS: "Lugares donde se produce o guarda vino",
      CATA: "Degustación técnica de vino",
      GARNACHA: "Variedad de uva tinta muy extendida en España",
      TANNAT: "Variedad de uva tinta asociada con Uruguay",
      TANNICO: "Término italiano para algo con taninos marcados",
      TINTA: "Palabra usada para una uva o vino rojo",
      VINO: "Bebida obtenida de la fermentación de la uva",
      VINICOLA: "Relacionado con la producción de vino",
      VITIS: "Género botánico de la vid",
      DULCE: "Descriptor para un vino con azúcar perceptible",
      NERO: "Palabra italiana presente en nombres de uvas",
      SIRAH: "Variante gráfica del nombre de la uva Syrah",
    };

    const enrichedExactEs: Record<string, string> = {
      ...exactEs,
      BRUT: "Estilo de espumoso muy seco y con poco azucar",
      CABERNET: "Nombre de uva presente en vinos como Cabernet Sauvignon",
      CAVA: "Espumoso espanol elaborado por metodo tradicional",
      COPA: "Vaso con pie usado para servir vino",
      FRESCO: "Descriptor de cata para un vino vivo y ligero",
      MALBEC: "Variedad de uva tinta muy asociada con Argentina",
      JEREZ: "Vino y zona espanola conocidos por el sherry",
      RACIMO: "Conjunto de uvas que cuelga de la vid",
      SALUD: "Brindis habitual antes de beber vino",
      SANGRIA: "Bebida de vino con fruta muy popular en Espana",
      TREBBIANO: "Variedad italiana de uva blanca usada en muchos vinos",
      SANGIOVESE: "Variedad de uva tinta muy usada en vinos de la Toscana",
      SUELO: "Parte del terruno que influye en la vid",
      TEMPRANILLO: "Variedad de uva tinta muy usada en vinos de Rioja",
      VINOS: "Plural de la bebida fermentada hecha con uvas",
      VINICULTOR: "Persona dedicada al cultivo de la vid o al vino",
    };

    return language === "en" ? (exactEn[a] ?? null) : (enrichedExactEs[a] ?? null);
  }

  if ((language === "en" && t === "mendoza") || (language === "es" && t === "mendoza")) {
    const exactEn: Record<string, string> = {
      BRUT: "Dry sparkling wine style",
      CAVA: "Spanish sparkling wine made by traditional method",
      CATA: "Wine tasting term",
      MENDOZA: "Argentine province famous for wine production",
      MALBEC: "Red grape variety strongly associated with Mendoza",
      MERLOT: "Red grape variety used in Mendoza wines",
      CABERNET: "Grape name often seen in Mendoza wine labels",
      ROBLE: "Oak wood used in wine aging",
      BARRIL: "Container used to store or age wine",
      UVAS: "Fruit used to make wine",
      MOSTO: "Fresh grape juice before fermentation",
      BLANCOS: "Wines made from white grapes",
      TINTOS: "Wines made from red grapes",
      ROSADOS: "Wines with a pink hue",
      CEPAS: "Vine plants grown for grapes",
      VINO: "Alcoholic drink made from fermented grapes",
      ZONA: "Wine-producing area or region",
      CUPAGE: "Blend or coupage term used in winemaking",
      TERROIR: "Wine term about soil, climate, and place",
      TEMPRANILLO: "Spanish grape variety also found in Mendoza wines",
      VINICOLA: "Related to wine production",
      NORTON: "Mendoza winery name seen on Argentine wine labels",
      PULENTA: "Mendoza wine label associated with premium Argentine wines",
      ACONCAGUA: "Highest mountain in the Americas, located in Mendoza province",
      ANDES: "Mountain range running along western Mendoza",
      GUAYMALLEN: "Department of Greater Mendoza in western Argentina",
      GODOYCRUZ: "City and department within Greater Mendoza",
      LUJAN: "Mendoza department known for vineyards and wineries",
      MAIPU: "Mendoza department famous for wineries",
      POTRERILLOS: "Mountain and reservoir area near Mendoza city",
      RACIMO: "Cluster of grapes on the vine",
      SANRAFAEL: "Important city in southern Mendoza province",
      DULCE: "Descriptor for a wine with perceptible sweetness",
      TINTA: "Spanish word used for a red-wine grape",
      TUNUYAN: "Town and department in the Uco Valley of Mendoza",
      UCO: "Valley region of Mendoza known for vineyards",
      USPALLATA: "Mendoza mountain town on the route to the Andes",
      BODEGA: "Winery or wine cellar",
      BODEGAS: "Wineries or wine cellars",
      VINOS: "Spanish word for wines",
      BLANCO: "Spanish term for a white wine style",
    };

    const exactEs: Record<string, string> = {
      BRUT: "Tipo de vino espumoso seco",
      CAVA: "Vino espumoso espanol elaborado por metodo tradicional",
      CATA: "Termino de degustacion de vino",
      MENDOZA: "Provincia argentina famosa por su produccion de vino",
      MALBEC: "Variedad de uva tinta muy asociada con Mendoza",
      MERLOT: "Variedad de uva tinta presente en vinos mendocinos",
      CABERNET: "Nombre de uva presente en muchos vinos mendocinos",
      ROBLE: "Madera usada para anejamiento o crianza del vino",
      BARRIL: "Recipiente usado para almacenar o criar vino",
      UVAS: "Frutos utilizados para hacer vino",
      MOSTO: "Jugo de uva antes de fermentar",
      BLANCOS: "Vinos elaborados con uvas blancas",
      TINTOS: "Vinos elaborados con uvas tintas",
      ROSADOS: "Tipo de vino con color rosa",
      CEPAS: "Plantas de vid para vino",
      VINO: "Bebida alcoholica de uvas fermentadas",
      ZONA: "Region vitivinicola de Mendoza",
      CUPAGE: "Mezcla de variedades usada en enologia",
      TERROIR: "Concepto vitivinicola sobre suelo, clima y origen",
      TEMPRANILLO: "Variedad de uva tinta usada tambien en vinos mendocinos",
      VINICOLA: "Relacionado con la produccion de vino",
      NORTON: "Nombre de una bodega muy conocida de Mendoza",
      PULENTA: "Nombre de una etiqueta o bodega asociada con Mendoza",
      ACONCAGUA: "Cerro mas alto de America, ubicado en Mendoza",
      ANDES: "Cordillera que recorre el oeste de Mendoza",
      GUAYMALLEN: "Departamento del Gran Mendoza en el oeste argentino",
      GODOYCRUZ: "Ciudad y departamento del Gran Mendoza",
      LUJAN: "Departamento mendocino conocido por vinedos y bodegas",
      MAIPU: "Departamento mendocino famoso por sus bodegas",
      POTRERILLOS: "Zona de montana y embalse cerca de la capital mendocina",
      RACIMO: "Conjunto de uvas que cuelga de la vid",
      SANRAFAEL: "Importante ciudad del sur de la provincia de Mendoza",
      DULCE: "Descriptor para un vino con azucar perceptible",
      TINTA: "Palabra usada para una uva o vino rojo",
      TUNUYAN: "Localidad y departamento del Valle de Uco en Mendoza",
      UCO: "Valle mendocino muy asociado con vinedos y bodegas",
      USPALLATA: "Pueblo mendocino camino a la cordillera de los Andes",
      BODEGA: "Lugar donde se produce o guarda vino",
      BODEGAS: "Lugares donde se produce o guarda vino",
      VINOS: "Plural de la bebida fermentada hecha con uvas",
      BLANCO: "Termino usado para vinos blancos",
    };

    return language === "en" ? (exactEn[a] ?? null) : (exactEs[a] ?? null);
  }

  if ((language === "en" && t === "megadeth") || (language === "es" && t === "megadeth")) {
    const exactEn: Record<string, string> = {
      MUSTAINE: "Surname of Dave, Megadeth founder and frontman",
      ELLEFSON: "David ___, original bassist of Megadeth",
      RATTLEHEAD: "Mascot character associated with Megadeth",
      HOLYWARS: "Megadeth song title using the plural word 'Wars'",
      LUCRETIA: "One-word Megadeth song title from Rust in Peace",
      WAKEUPDEAD: "Megadeth song title written as three words",
      MARYJANE: "Megadeth song title using a woman's name",
      MECHANIX: "Early Megadeth song title with an unusual spelling",
      FIVEMAGICS: "Megadeth song title using the number five",
      HOOKINMOUTH: "Megadeth song title ending with 'Mouth'",
      CONJURING: "Megadeth song title beginning with 'The'",
      RECKONING: "Final word in the Megadeth title 'Day of ___'",
      SOULS: "Final word in the Megadeth title 'Tornado of ___'",
      TORNADO: "First word in the Megadeth title '___ of Souls'",
      SWEATING: "First word in the Megadeth title '___ Bullets'",
      KILLING: "First word in the Megadeth title '___ Is My Business...'",
      POLARIS: "Final word in the Megadeth title 'Rust in Peace... ___'",
      RUSTINPEACE: "Classic 1990 Megadeth album title",
      PEACESELLS: "Megadeth album title beginning with 'Peace'",
      YOUTHANASIA: "1994 Megadeth album title",
      DYSTOPIA: "2016 Megadeth album title",
      FRIEDMAN: "Surname of Marty, guitarist on major Megadeth albums",
      MARTY: "First name of guitarist ___ Friedman in Megadeth",
      RATTLE: "Part of mascot name Vic ___head",
      SELLS: "Second word in the Megadeth album title 'Peace ___...'",
      MENZA: "Surname of Nick, drummer on major Megadeth albums",
      NICKMENZA: "Full normalized name of a drummer on major Megadeth albums",
      NICK: "First name of drummer Menza from Megadeth",
      POLAND: "Surname of Chris, guitarist on early Megadeth recordings",
      DROVER: "Surname of Shawn, drummer associated with Megadeth",
      DAVE: "First name of Megadeth founder Mustaine",
      VIC: "First name of mascot ___ Rattlehead",
      LOUREIRO: "Surname of Kiko, guitarist associated with Megadeth",
      BRODERICK: "Surname of Chris, guitarist associated with Megadeth",
      KIKO: "First name of guitarist Loureiro from Megadeth",
      RISK: "1999 Megadeth album title",
      ENDGAME: "2009 Megadeth album title",
      THIRTEEN: "Megadeth studio album title",
      COUNTDOWN: "First word of the Megadeth album title ending in 'to Extinction'",
      CRYPTIC: "First word of the Megadeth album '___ Writings'",
    };

    const exactEs: Record<string, string> = {
      MUSTAINE: "Apellido de Dave, fundador y lider de Megadeth",
      ELLEFSON: "Apellido de David, bajista original de Megadeth",
      RATTLEHEAD: "Mascota o personaje asociado con Megadeth",
      HOLYWARS: "Titulo de cancion de Megadeth con la palabra plural 'Wars'",
      LUCRETIA: "Titulo de una cancion de Megadeth en Rust in Peace",
      WAKEUPDEAD: "Titulo de cancion de Megadeth escrito como tres palabras",
      MARYJANE: "Titulo de cancion de Megadeth con nombre femenino",
      MECHANIX: "Titulo temprano de Megadeth con grafia inusual",
      FIVEMAGICS: "Titulo de cancion de Megadeth con el numero cinco",
      HOOKINMOUTH: "Titulo de cancion de Megadeth que termina con 'Mouth'",
      CONJURING: "Titulo de cancion de Megadeth que empieza con 'The'",
      RECKONING: "Ultima palabra del titulo de Megadeth 'Day of ___'",
      SOULS: "Ultima palabra del titulo de Megadeth 'Tornado of ___'",
      TORNADO: "Primera palabra del titulo de Megadeth '___ of Souls'",
      SWEATING: "Primera palabra del titulo de Megadeth '___ Bullets'",
      KILLING: "Primera palabra del titulo de Megadeth '___ Is My Business...'",
      POLARIS: "Ultima palabra del titulo de Megadeth 'Rust in Peace... ___'",
      RUSTINPEACE: "Album clasico de Megadeth editado en 1990",
      PEACESELLS: "Album de Megadeth cuyo titulo comienza con 'Peace'",
      YOUTHANASIA: "Album de Megadeth publicado en 1994",
      DYSTOPIA: "Album de Megadeth publicado en 2016",
      FRIEDMAN: "Apellido de Marty, guitarrista asociado con discos de Megadeth",
      MARTY: "Nombre de pila del guitarrista Friedman en Megadeth",
      RATTLE: "Parte del nombre de la mascota Vic ___head",
      SELLS: "Segunda palabra del album de Megadeth 'Peace ___...'",
      MENZA: "Apellido de Nick, baterista asociado con discos de Megadeth",
      NICKMENZA: "Nombre completo normalizado de un baterista asociado con discos de Megadeth",
      NICK: "Nombre de pila del baterista Menza de Megadeth",
      POLAND: "Apellido de Chris, guitarrista asociado con grabaciones tempranas de Megadeth",
      DROVER: "Apellido de Shawn, baterista asociado con Megadeth",
      DAVE: "Nombre de pila de Mustaine, fundador de Megadeth",
      VIC: "Nombre de la mascota ___ Rattlehead",
      LOUREIRO: "Apellido de Kiko, guitarrista asociado con Megadeth",
      BRODERICK: "Apellido de Chris, guitarrista asociado con Megadeth",
      KIKO: "Nombre del guitarrista Loureiro en Megadeth",
      RISK: "Titulo de un album de Megadeth de 1999",
      ENDGAME: "Album de Megadeth publicado en 2009",
      THIRTEEN: "Titulo de album de estudio de Megadeth",
      COUNTDOWN: "Primera palabra del album de Megadeth '___ to Extinction'",
      CRYPTIC: "Primera palabra del album de Megadeth '___ Writings'",
    };

    return language === "en" ? (exactEn[a] ?? null) : (exactEs[a] ?? null);
  }

  if ((language === "en" && t === "metallica") || (language === "es" && t === "metallica")) {
    const exactEn: Record<string, string> = {
      HETFIELD: "Surname of James, Metallica cofounder and vocalist",
      ULRICH: "Surname of Lars, Metallica cofounder and drummer",
      HAMMETT: "Surname of Kirk, longtime Metallica guitarist",
      TRUJILLO: "Surname of Robert, bassist of Metallica since 2003",
      BURTON: "Surname of Cliff, early bassist of Metallica",
      JASON: "First name of Newsted, former Metallica bassist",
      NEWSTED: "Surname of Jason, former bassist of Metallica",
      LARS: "First name of Metallica drummer Ulrich",
      JAMES: "First name of Metallica singer Hetfield",
      KIRK: "First name of Metallica guitarist Hammett",
      ROBERT: "First name of Metallica bassist Trujillo",
      CLIFF: "First name of early Metallica bassist Burton",
      PUPPETS: "Second word in Metallica's album 'Master of ___'",
      SANDMAN: "Second word in Metallica's song 'Enter ___'",
      LIGHTNING: "Second word in the Metallica album 'Ride the ___'",
      JUSTICE: "Word after '...And' in a Metallica album title",
      BLACK: "Informal name of Metallica's self-titled 1991 album",
      BATTERY: "Opening track of Metallica's album 'Master of Puppets'",
      ORION: "Instrumental track on 'Master of Puppets'",
      ONE: "Metallica song from the album '...And Justice for All'",
      FUEL: "Metallica single with the line 'Gimme ___, gimme fire'",
      CREEPING: "First word of Metallica's song '___ Death'",
      DEATH: "Second word of Metallica's song 'Creeping ___'",
      UNFORGIVEN: "Metallica song title beginning with 'The'",
      KILLEMALL: "Debut studio album by Metallica",
      LOAD: "Metallica studio album released in 1996",
      RELOAD: "Metallica studio album released after 'Load'",
      STANGER: "Metallica album whose title begins with 'St.'",
      HARDWIRED: "Metallica album title beginning '___... to Self-Destruct'",
      DESTRUCT: "Final word of Metallica's album 'Hardwired... to Self-___'",
      AJFA: "Short form often used for '...And Justice for All'",
    };

    const exactEs: Record<string, string> = {
      HETFIELD: "Apellido de James, fundador y vocalista de Metallica",
      ULRICH: "Apellido de Lars, fundador y baterista de Metallica",
      HAMMETT: "Apellido de Kirk, guitarrista historico de Metallica",
      TRUJILLO: "Apellido de Robert, bajista de Metallica desde 2003",
      BURTON: "Apellido de Cliff, bajista clasico de los primeros anos de Metallica",
      JASON: "Nombre de pila de Newsted, exbajista de Metallica",
      NEWSTED: "Apellido de Jason, exbajista de Metallica",
      LARS: "Nombre de pila del baterista Ulrich en Metallica",
      JAMES: "Nombre de pila de Hetfield, cantante de Metallica",
      KIRK: "Nombre del guitarrista Hammett en Metallica",
      ROBERT: "Nombre de pila del bajista Trujillo en Metallica",
      CLIFF: "Nombre del bajista Burton en los primeros discos de Metallica",
      PUPPETS: "Segunda palabra del album de Metallica 'Master of ___'",
      SANDMAN: "Segunda palabra de la cancion 'Enter ___' de Metallica",
      LIGHTNING: "Segunda palabra del album 'Ride the ___' de Metallica",
      JUSTICE: "Palabra que sigue a '...And' en un album de Metallica",
      BLACK: "Nombre informal del disco homonimo de Metallica de 1991",
      BATTERY: "Tema que abre el album 'Master of Puppets'",
      ORION: "Tema instrumental del album 'Master of Puppets'",
      ONE: "Cancion de Metallica del album '...And Justice for All'",
      FUEL: "Sencillo de Metallica con el estribillo 'Gimme ___'",
      CREEPING: "Primera palabra de la cancion '___ Death' de Metallica",
      DEATH: "Segunda palabra de la cancion 'Creeping ___' de Metallica",
      UNFORGIVEN: "Cancion de Metallica cuyo titulo empieza con 'The'",
      KILLEMALL: "Album debut de estudio de Metallica",
      LOAD: "Album de Metallica publicado en 1996",
      RELOAD: "Album de Metallica publicado despues de 'Load'",
      STANGER: "Album de Metallica cuyo titulo empieza con 'St.'",
      HARDWIRED: "Album de Metallica titulado '___... to Self-Destruct'",
      DESTRUCT: "Ultima palabra del album 'Hardwired... to Self-___'",
      AJFA: "Sigla muy usada para '...And Justice for All'",
    };

    return language === "en" ? (exactEn[a] ?? null) : (exactEs[a] ?? null);
  }

  if ((language === "en" && t === "japan") || (language === "es" && t === "japon")) {
    const exactEn: Record<string, string> = {
      ANIME: "Japanese animation style popular worldwide",
      BONSAI: "Miniature tree art strongly associated with Japan",
      CABUKI: "Traditional Japanese theater style",
      FUGU: "Pufferfish delicacy served in Japan",
      GEISHA: "Traditional Japanese entertainer trained in arts and etiquette",
      HAIKU: "Short poetic form associated with Japan",
      JAPAN: "Island nation in East Asia",
      KABUKI: "Traditional Japanese theater style",
      KAWA: "Japanese word often translated as river",
      KIMONO: "Traditional Japanese robe",
      KITSUNE: "Fox figure from Japanese folklore",
      KONBU: "Edible kelp used in Japanese cuisine",
      KYOTO: "Historic Japanese city associated with temples and shrines",
      MISO: "Fermented soybean paste used in Japanese cooking",
      NIKKO: "Japanese city known for historic shrines and temples",
      NINJA: "Figure from Japanese martial tradition and folklore",
      NORI: "Edible seaweed often used with sushi",
      OSAKA: "Major Japanese city known for food culture",
      RAMEN: "Japanese noodle soup dish",
      RICE: "Staple grain central to Japanese cuisine",
      SAKE: "Traditional Japanese rice drink",
      SAMURAI: "Warrior class strongly associated with Japanese history",
      SHINTO: "Native religious tradition of Japan",
      SHOGUN: "Military ruler title in premodern Japan",
      SUMO: "Wrestling sport strongly associated with Japan",
      SUSHI: "Japanese dish of vinegared rice with varied toppings",
      TEMPURA: "Japanese dish of battered and fried seafood or vegetables",
      TOKYO: "Capital city of Japan",
      UDON: "Thick Japanese wheat noodle",
      YAKITORI: "Japanese skewered grilled chicken dish",
      YOKAI: "Supernatural being from Japanese folklore",
    };

    const exactEs: Record<string, string> = {
      ANIME: "Animacion japonesa popular en todo el mundo",
      BONSAI: "Arte japones de cultivar arboles en miniatura",
      CABUKI: "Forma tradicional de teatro japones",
      FUGU: "Pez globo servido como delicadeza en Japon",
      GEISHA: "Artista tradicional japonesa formada en musica y etiqueta",
      HAIKU: "Breve forma poetica asociada con Japon",
      JAPON: "Pais insular del este de Asia",
      KABUKI: "Forma tradicional de teatro japones",
      KAWA: "Palabra japonesa que suele traducirse como rio",
      KIMONO: "Vestimenta tradicional de Japon",
      KITSUNE: "Figura de zorro en el folclore japones",
      KONBU: "Alga comestible muy usada en la cocina japonesa",
      KYOTO: "Ciudad historica japonesa asociada a templos y santuarios",
      MISO: "Pasta fermentada de soja muy usada en Japon",
      NIKKO: "Ciudad japonesa conocida por sus santuarios y templos",
      NINJA: "Figura de la tradicion marcial y el folclore japones",
      NORI: "Alga comestible usada con frecuencia en sushi",
      OSAKA: "Importante ciudad japonesa conocida por su cultura gastronomica",
      RAMEN: "Sopa japonesa de fideos",
      RICE: "Grano basico de la cocina japonesa",
      SAKE: "Bebida japonesa elaborada a partir de arroz",
      SAMURAI: "Clase guerrera asociada con la historia de Japon",
      SHINTO: "Tradicion religiosa originaria de Japon",
      SHOGUN: "Titulo del gobernante militar en el Japon premoderno",
      SUMO: "Deporte de lucha fuertemente asociado con Japon",
      SUSHI: "Plato japones de arroz avinagrado con acompanamientos",
      TEMPURA: "Plato japones de fritura ligera",
      TOKYO: "Capital de Japon",
      UDON: "Fideo grueso de trigo muy usado en Japon",
      YAKITORI: "Brocheta japonesa de pollo a la parrilla",
      YOKAI: "Ser sobrenatural del folclore japones",
      TOKIO: "Capital de Japon",
      TAIKO: "Tambor tradicional japones usado en festivales y espectaculos",
    };

    return language === "en" ? (exactEn[a] ?? null) : (exactEs[a] ?? null);
  }

  return null;
}

function clueFromThemeNote(theme: string, note: string, language: "es" | "en"): string | null {
  const t = theme.trim();
  const themeNorm = normalizeAnswer(theme);
  const lower = note.toLowerCase();

  if (themeNorm === "VINO" || themeNorm === "WINE") {
    if (language === "en") {
      if (/\b(grape|varietal|variety)\b/.test(lower)) return `${t} grape variety`;
      if (/\bwhite wine|white wines\b/.test(lower)) return `${t} term for white wines`;
      if (/\bred wine|red wines\b/.test(lower)) return `${t} term for red wines`;
      if (/\bwinery|cellar|bodega\b/.test(lower)) return `${t} winery or cellar term`;
      if (/\btasting\b/.test(lower)) return `${t} tasting term`;
      if (/\btannic|tannin\b/.test(lower)) return `${t} tasting descriptor`;
      if (/\bbotanical|genus|grapevine\b/.test(lower)) return `${t} botanical term`;
      if (/\bsweet\b/.test(lower)) return `${t} sweetness descriptor`;
    } else {
      if (/\b(grape|varietal|variety|uva)\b/.test(lower)) return `Variedad de uva relacionada con el vino`;
      if (/\bwhite wine|white wines|vino blanco|vinos blancos\b/.test(lower)) return `Término para vinos blancos`;
      if (/\bred wine|red wines|vino tinto|vinos tintos\b/.test(lower)) return `Término para vinos tintos`;
      if (/\bwinery|cellar|bodega\b/.test(lower)) return `Lugar donde se produce o guarda vino`;
      if (/\btasting|cata\b/.test(lower)) return `Término de degustación de vino`;
      if (/\btannic|tannin|tanino\b/.test(lower)) return `Descriptor de cata relacionado con taninos`;
      if (/\bbotanical|genus|grapevine|vid\b/.test(lower)) return `Término botánico relacionado con la vid`;
      if (/\bsweet|dulce\b/.test(lower)) return `Descriptor de dulzor en el vino`;
    }
  }

  if (themeNorm === "ARGENTINA") {
    if (language === "en") {
      if (/\b(city|province|capital)\b/.test(lower)) return `Argentine city or province`;
      if (/\b(region)\b/.test(lower)) return `Argentine region`;
      if (/\b(wine|grape|vineyard)\b/.test(lower)) return `Argentine wine-related term`;
      if (/\b(dish|food|meat|cheese|barbecue|bbq)\b/.test(lower)) return `Argentine dish or food term`;
      if (/\b(drink|infusion|herbal)\b/.test(lower)) return `Argentine drink or infusion`;
      if (/\b(dance|music|genre)\b/.test(lower)) return `Argentine music or dance term`;
      if (/\b(dessert|pastry|cookie|sweet)\b/.test(lower)) return `Argentine sweet or dessert`;
      if (/\b(president|first lady|political figure|leader)\b/.test(lower)) return `Argentine historical figure`;
      if (/\b(falls|waterfall)\b/.test(lower)) return `Argentine natural landmark`;
    } else {
      if (/\b(city|province|capital|ciudad|provincia|capital)\b/.test(lower)) return `Ciudad o provincia de Argentina`;
      if (/\b(region|regi[oó]n)\b/.test(lower)) return `Region de Argentina`;
      if (/\b(wine|grape|vineyard|vino|uva|vinedo|viñedo)\b/.test(lower)) return `Termino argentino relacionado con el vino`;
      if (/\b(dish|food|meat|cheese|barbecue|bbq|plato|comida|carne|queso|parrilla|asado)\b/.test(lower)) return `Plato o comida tipica de Argentina`;
      if (/\b(drink|infusion|herbal|bebida|infusi[oó]n|mate)\b/.test(lower)) return `Bebida o infusion asociada con Argentina`;
      if (/\b(dance|music|genre|baile|musica|m[uú]sica|g[eé]nero)\b/.test(lower)) return `Genero musical o baile asociado con Argentina`;
      if (/\b(dessert|pastry|cookie|sweet|postre|dulce|galleta|alfajor)\b/.test(lower)) return `Dulce o postre tipico de Argentina`;
      if (/\b(president|first lady|political figure|leader|presidenta|figura politica|figura pol[iÃ­]tica|lider|l[iÃ­]der)\b/.test(lower)) return `Figura historica o politica asociada con Argentina`;
      if (/\b(falls|waterfall|cataratas)\b/.test(lower)) return `Paisaje natural asociado con Argentina`;
    }
  }

  if (themeNorm === "JAPON" || themeNorm === "JAPAN") {
    if (language === "en") {
      if (/\b(city|capital|prefecture|temple|shrine)\b/.test(lower)) return `Japanese place or landmark`;
      if (/\b(food|dish|noodle|rice|seaweed|fish|soup|paste|drink)\b/.test(lower)) return `Japanese food or drink term`;
      if (/\b(folklore|myth|spirit|fox|supernatural)\b/.test(lower)) return `Figure from Japanese folklore`;
      if (/\b(theater|poetry|robe|animation|wrestling|warrior|martial)\b/.test(lower)) return `Japanese culture term`;
      if (/\b(religion|religious|shrine)\b/.test(lower)) return `Japanese religious tradition or site`;
    } else {
      if (/\b(city|capital|prefecture|temple|shrine|ciudad|capital|templo|santuario)\b/.test(lower)) {
        return `Lugar o sitio destacado de Japon`;
      }
      if (/\b(food|dish|noodle|rice|seaweed|fish|soup|paste|drink|comida|plato|fideo|arroz|alga|pez|sopa|pasta|bebida)\b/.test(lower)) {
        return `Termino de la cocina japonesa`;
      }
      if (/\b(folklore|myth|spirit|fox|supernatural|folclore|mito|espiritu|zorro|sobrenatural)\b/.test(lower)) {
        return `Figura del folclore japones`;
      }
      if (/\b(theater|poetry|robe|animation|wrestling|warrior|martial|teatro|poesia|vestimenta|animacion|lucha|guerrero|marcial)\b/.test(lower)) {
        return `Termino cultural asociado con Japon`;
      }
      if (/\b(religion|religious|shrine|religion|religioso|santuario)\b/.test(lower)) {
        return `Tradicion religiosa o sitio sagrado de Japon`;
      }
    }
  }

  if (language === "en") {
    if (/\b(grape|varietal|variety)\b/.test(lower)) return `Wine grape variety`;
    if (/\bwhite wine|white wines\b/.test(lower)) return `Term for white wines`;
    if (/\bred wine|red wines\b/.test(lower)) return `Term for red wines`;
    if (/\bwinery|cellar|bodega\b/.test(lower)) return `Wine cellar or winery term`;
    if (/\btasting\b/.test(lower)) return `Wine tasting term`;
    if (/\btannic|tannin\b/.test(lower)) return `Wine tasting descriptor`;
    if (/\bbotanical|genus|grapevine\b/.test(lower)) return `Botanical term related to grapevines`;
    if (/\bsweet\b/.test(lower)) return `Sweetness descriptor in wine`;
    if (/\bblend|coupage|assemblage\b/.test(lower)) return `Wine blend term`;
    if (/\bterroir|soil|climate\b/.test(lower) && /\bwine|vineyard|vine\b/.test(lower)) return `Wine term about soil and climate`;
  } else {
    if (/\b(grape|varietal|variety|uva)\b/.test(lower)) return `Variedad de uva relacionada con el vino`;
    if (/\bwhite wine|white wines|vino blanco|vinos blancos\b/.test(lower)) return `Termino para vinos blancos`;
    if (/\bred wine|red wines|vino tinto|vinos tintos\b/.test(lower)) return `Termino para vinos tintos`;
    if (/\bwinery|cellar|bodega\b/.test(lower)) return `Lugar donde se produce o guarda vino`;
    if (/\btasting|cata\b/.test(lower)) return `Termino de degustacion de vino`;
    if (/\btannic|tannin|tanino\b/.test(lower)) return `Descriptor de cata relacionado con taninos`;
    if (/\bbotanical|genus|grapevine|vid\b/.test(lower)) return `Termino botanico relacionado con la vid`;
    if (/\bsweet|dulce\b/.test(lower)) return `Descriptor de dulzor en el vino`;
    if (/\bblend|coupage|assemblage|cupage\b/.test(lower)) return `Mezcla de variedades usada en el vino`;
    if (/\bterroir|terruno|terruño|soil|climate|clima|suelo\b/.test(lower) && /\bwine|vineyard|vine|vino|vinedo|viñedo|vid\b/.test(lower)) {
      return `Concepto vitivinicola sobre suelo y clima`;
    }
  }

  if (language === "en") {
    if (/\b(song|track|single)\b/.test(lower)) return `${t} song title`;
    if (/\balbum\b/.test(lower)) return `${t} album title`;
    if (/\b(guitarist|guitar player)\b/.test(lower)) return `${t} guitarist`;
    if (/\bdrummer\b/.test(lower)) return `${t} drummer`;
    if (/\bbassist\b/.test(lower)) return `${t} bassist`;
    if (/\bvocalist|singer|frontman\b/.test(lower)) return `${t} vocalist`;
    if (/\bmember\b/.test(lower)) return `${t} band member`;
    if (/\bmascot|character\b/.test(lower)) return `${t} mascot`;
    if (/\bcity\b/.test(lower)) return `${t} city`;
    if (/\bcounty\b/.test(lower)) return `${t} county`;
    if (/\bregion\b/.test(lower)) return `${t} region`;
    if (/\bwine\b/.test(lower)) return `${t} wine-related term`;
    if (/\bpark\b/.test(lower)) return `${t} park or landmark`;
    if (/\btree\b/.test(lower)) return `${t} natural landmark`;
    if (/\bband\b/.test(lower)) return `${t}-related term`;
  } else {
    if (/\b(song|track|single)\b/.test(lower)) return `Canción de ${t}`;
    if (/\balbum\b/.test(lower)) return `Álbum de ${t}`;
    if (/\b(guitarist|guitar player)\b/.test(lower)) return `Guitarrista de ${t}`;
    if (/\bdrummer\b/.test(lower)) return `Baterista de ${t}`;
    if (/\bbassist\b/.test(lower)) return `Bajista de ${t}`;
    if (/\bvocalist|singer|frontman\b/.test(lower)) return `Vocalista de ${t}`;
    if (/\bmember\b/.test(lower)) return `Integrante de ${t}`;
    if (/\bmascot|character\b/.test(lower)) return `Mascota o personaje de ${t}`;
    if (/\bcity\b/.test(lower)) return `Ciudad relacionada con ${t}`;
    if (/\bcounty\b/.test(lower)) return `Condado relacionado con ${t}`;
    if (/\bregion\b/.test(lower)) return `Región relacionada con ${t}`;
    if (/\bwine\b/.test(lower)) return `Término relacionado con ${t}`;
    if (/\bpark\b/.test(lower)) return `Parque o sitio relacionado con ${t}`;
    if (/\btree\b/.test(lower)) return `Sitio natural relacionado con ${t}`;
    if (/\bband\b/.test(lower)) return `Término relacionado con ${t}`;
  }

  return null;
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
  const noteBlob = Array.from(notesByAnswer.values())
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

  const looksWineRelated =
    themeNorm === "VINO" ||
    themeNorm === "WINE" ||
    themeNorm === "MENDOZA";

  const looksJapanRelated =
    themeNorm === "JAPON" ||
    themeNorm === "JAPAN";
  const looksMusicRelated =
    /MUSIC|MUSICA|ROCK|METAL|JAZZ|PUNK|BAND|BANDA|SONG|CANCION|ALBUM|GUITAR|GUITARRA|MEGADETH|METALLICA|BEATLES/.test(
      themeNorm
    ) ||
    /MUSIC|MUSICA|ROCK|METAL|JAZZ|PUNK|BAND|BANDA|SONG|CANCION|ALBUM|GUITAR|GUITARRA|MEGADETH|METALLICA|BEATLES|MUSTAINE|ELLEFSON|RATTLEHEAD|FRIEDMAN|MENZA|KIKO|LOUREIRO|BRODERICK/.test(
      noteBlob
    );

  if (themeNorm === "BARILOCHE") {
    const curated = [
      "NAHUEL",
      "HUAPI",
      "LLAOLLAO",
      "CATEDRAL",
      "CAMPANARIO",
      "TRONADOR",
      "MORENO",
      "GUTIERREZ",
      "MASCARDI",
      "ARRAYANES",
      "CHOCOLATE",
      "PATAGONIA",
      "RIONEGRO",
      "ANDES",
      "LAGOS",
      "NIEVE",
      "ESQUI",
      "OTTO",
      "BUSTILLO",
      "CIVICO",
      "CERVEZA",
      "CURANTO",
      "COLONIA",
      "SUIZA",
      "LIMAY",
    ];

    const seen = new Set<string>();
    const out: Array<{ answer: string; thematic: boolean }> = [];
    for (const raw of curated) {
      const answer = normalizeAnswer(raw);
      if (!answer) continue;
      if (answer.length < 3 || answer.length > size) continue;
      if (!ASCII_A_TO_Z.test(answer)) continue;
      if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
      if (seen.has(answer)) continue;
      seen.add(answer);
      out.push({ answer, thematic: true });
    }
    return out;
  }

  if (looksJapanRelated) {
    const curated = [
      "ANIME",
      "SUSHI",
      "UDON",
      "RAMEN",
      "MISO",
      "NORI",
      "SAKE",
      "SUMO",
      "KABUKI",
      "KIMONO",
      "SAMURAI",
      "SHINTO",
      "SHOGUN",
      "TOKYO",
      "TOKIO",
      "KYOTO",
      "OSAKA",
      "NIKKO",
      "FUGU",
      "KONBU",
      "KITSUNE",
      "YOKAI",
      "YAKITORI",
      "BONSAI",
      "HAIKU",
      "TAIKO",
      "GEISHA",
      "NINJA",
      "KAWA",
    ];

    const seen = new Set<string>();
    const out: Array<{ answer: string; thematic: boolean }> = [];
    for (const raw of curated) {
      const answer = normalizeAnswer(raw);
      if (!answer) continue;
      if (answer.length < 3 || answer.length > size) continue;
      if (!ASCII_A_TO_Z.test(answer)) continue;
      if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
      if (seen.has(answer)) continue;
      seen.add(answer);
      out.push({ answer, thematic: true });
    }
    return out;
  }

  const looksMegadethRelated =
    themeNorm === "MEGADETH" ||
    /MEGADETH|MUSTAINE|ELLEFSON|RATTLEHEAD|RUSTINPEACE|PEACESELLS|YOUTHANASIA|DYSTOPIA|FRIEDMAN|MENZA|KIKO|LOUREIRO|BRODERICK/.test(
      noteBlob
    );

  if (looksMegadethRelated) {
    const curated = [
      "MUSTAINE",
      "ELLEFSON",
      "RATTLEHEAD",
      "RUSTINPEACE",
      "PEACESELLS",
      "YOUTHANASIA",
      "DYSTOPIA",
      "FRIEDMAN",
      "MARTY",
      "MENZA",
      "DAVE",
      "VIC",
      "LOUREIRO",
      "BRODERICK",
      "KIKO",
      "ENDGAME",
      "THIRTEEN",
      "COUNTDOWN",
      "CRYPTIC",
      "RATTLE",
      "SELLS",
      "ALBUM",
      "AMP",
      "ARENA",
      "AXE",
      "BAND",
      "BASS",
      "BEAT",
      "CAB",
      "CABLE",
      "CHORD",
      "CHORUS",
      "CYMBAL",
      "DRUMS",
      "FAN",
      "FANS",
      "FRET",
      "GAIN",
      "GIG",
      "GUITAR",
      "HOOK",
      "JAM",
      "KICK",
      "LABEL",
      "LIVE",
      "LOGO",
      "LYRIC",
      "MELODY",
      "MERCH",
      "METAL",
      "MIC",
      "MOSH",
      "PEDAL",
      "PICK",
      "PIT",
      "RECORD",
      "REVERB",
      "RIFF",
      "RIG",
      "ROCK",
      "ROLL",
      "ROADIE",
      "ROCKER",
      "SCREAM",
      "SET",
      "SHRED",
      "SNARE",
      "SOLO",
      "SONG",
      "SOUND",
      "STAGE",
      "STUDIO",
      "TEMPO",
      "THRASH",
      "TICKET",
      "TRACK",
      "TUNER",
      "TOUR",
      "VERSE",
      "VOCALS",
    ];

    const seen = new Set<string>();
    const out: Array<{ answer: string; thematic: boolean }> = [];
    for (const raw of curated) {
      const answer = normalizeAnswer(raw);
      if (!answer) continue;
      if (answer.length < 3 || answer.length > size) continue;
      if (!ASCII_A_TO_Z.test(answer)) continue;
      if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
      if (seen.has(answer)) continue;
      seen.add(answer);
      out.push({ answer, thematic: true });
    }
    return out;
  }

  if (looksMusicRelated) {
    const curated = [
      "ALBUM",
      "AMP",
      "ARENA",
      "AXE",
      "BAND",
      "BASS",
      "BEAT",
      "CAB",
      "CABLE",
      "CHORD",
      "CHORUS",
      "CYMBAL",
      "DRUMS",
      "FAN",
      "FANS",
      "FRET",
      "GAIN",
      "GIG",
      "GUITAR",
      "HOOK",
      "JAM",
      "KICK",
      "LABEL",
      "LIVE",
      "LOGO",
      "LYRIC",
      "MELODY",
      "MERCH",
      "METAL",
      "MIC",
      "MOSH",
      "PEDAL",
      "PICK",
      "PIT",
      "RECORD",
      "REVERB",
      "RIFF",
      "RIG",
      "ROCK",
      "ROLL",
      "ROADIE",
      "ROCKER",
      "SCREAM",
      "SET",
      "SHRED",
      "SNARE",
      "SOLO",
      "SONG",
      "SOUND",
      "STAGE",
      "STUDIO",
      "TEMPO",
      "THRASH",
      "TICKET",
      "TRACK",
      "TUNER",
      "TOUR",
      "VERSE",
      "VOCALS",
    ];

    const seen = new Set<string>();
    const out: Array<{ answer: string; thematic: boolean }> = [];
    for (const raw of curated) {
      const answer = normalizeAnswer(raw);
      if (!answer) continue;
      if (answer.length < 3 || answer.length > size) continue;
      if (!ASCII_A_TO_Z.test(answer)) continue;
      if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
      if (seen.has(answer)) continue;
      seen.add(answer);
      out.push({ answer, thematic: true });
    }
    return out;
  }

  const looksMetallicaRelated =
    themeNorm === "METALLICA" ||
    /METALLICA|HETFIELD|ULRICH|HAMMETT|TRUJILLO|BURTON|NEWSTED|KILLEMALL|PUPPETS|SANDMAN|LIGHTNING|JUSTICE|BATTERY|ORION|UNFORGIVEN|HARDWIRED|STANGER|RELOAD|LOAD/.test(
      noteBlob
    );

  if (looksMetallicaRelated) {
    const curated = [
      "HETFIELD",
      "ULRICH",
      "HAMMETT",
      "TRUJILLO",
      "BURTON",
      "NEWSTED",
      "JASON",
      "LARS",
      "JAMES",
      "KIRK",
      "ROBERT",
      "CLIFF",
      "PUPPETS",
      "SANDMAN",
      "LIGHTNING",
      "JUSTICE",
      "BLACK",
      "BATTERY",
      "ORION",
      "ONE",
      "FUEL",
      "CREEPING",
      "DEATH",
      "UNFORGIVEN",
      "KILLEMALL",
      "LOAD",
      "RELOAD",
      "STANGER",
      "HARDWIRED",
      "DESTRUCT",
      "AJFA",
    ];

    const seen = new Set<string>();
    const out: Array<{ answer: string; thematic: boolean }> = [];
    for (const raw of curated) {
      const answer = normalizeAnswer(raw);
      if (!answer) continue;
      if (answer.length < 3 || answer.length > size) continue;
      if (!ASCII_A_TO_Z.test(answer)) continue;
      if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
      if (seen.has(answer)) continue;
      seen.add(answer);
      out.push({ answer, thematic: true });
    }
    return out;
  }

  if (!looksWineRelated) return [];

  const curated = [
    "UVA",
    "UVAS",
    "VID",
    "CEPA",
    "CEPAS",
    "MOSTO",
    "ROBLE",
    "CORCHO",
    "BARRICA",
    "BARRIL",
    "RESERVA",
    "CRIANZA",
    "TANINO",
    "TANINOS",
    "BLEND",
    "TINTO",
    "TINTOS",
    "BLANCO",
    "BLANCOS",
    "ROSADO",
    "ROSADOS",
    "BODEGA",
    "BODEGAS",
    "MERLOT",
    "MALBEC",
    "CABERNET",
    "TEMPRANILLO",
    "CATA",
    "VINICOLA",
    "VINO",
    "VINOS",
    "CAVA",
    "BRUT",
    "RACIMO",
    "TERROIR",
    "CUPAGE",
    "NORTON",
    "PULENTA",
    "MAIPU",
  ];

  if (themeNorm === "MENDOZA") {
    curated.push(
      "ACONCAGUA",
      "ANDES",
      "GUAYMALLEN",
      "GODOYCRUZ",
      "LUJAN",
      "POTRERILLOS",
      "SANRAFAEL",
      "TUNUYAN",
      "UCO",
      "USPALLATA"
    );
  }

  const seen = new Set<string>();
  const out: Array<{ answer: string; thematic: boolean }> = [];

  for (const raw of curated) {
    const answer = normalizeAnswer(raw);
    if (!answer) continue;
    if (answer.length < 3 || answer.length > size) continue;
    if (!ASCII_A_TO_Z.test(answer)) continue;
    if (isLikelyBadAnswer(answer) && !ALWAYS_ALLOW_ANSWERS.has(answer)) continue;
    if (seen.has(answer)) continue;
    seen.add(answer);
    out.push({ answer, thematic: true });
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

  const rawAnswerBlob = Array.isArray(raw?.answers) ? raw.answers.join(" ").toUpperCase() : "";
  const looksGeographic =
    /LAGO|LAKE|CERRO|HILL|MOUNT|MONTE|RIO|RIVER|ISLA|ISLAND|PUERTO|PORT|PLAYA|BEACH|RUTA|ROUTE|PARQUE|PARK|CIUDAD|CITY|VALLE|VALLEY|COSTA|COAST/.test(
      rawAnswerBlob
    );
  const contextualSupport =
    looksGeographic && language === "es"
      ? ["RUTA", "CAMINO", "PASEO", "COSTA", "CERRO", "LAGO", "LAGOS", "MUSEO", "PESCA", "KAYAK", "NIEVE", "FRIO", "FLORA", "FAUNA", "NATURALEZA", "SENDERO", "MIRADOR", "REFUGIO", "CAMPING", "VISTA", "GUIA", "MAPA", "TOUR", "TURISMO", "HOTEL", "HOSTEL", "HOSTERIA", "ALBERGUE", "PLAYA", "BOSQUE", "RIO", "AGUA", "SUR", "NORTE", "ISLA", "PUERTO", "PARQUE", "VALLE", "VIAJE", "RANCHO", "RANCHOS"]
      : looksGeographic
      ? ["ROUTE", "COAST", "MUSEUM", "KAYAK", "SNOW", "FLORA", "FAUNA", "TRAIL", "LOOKOUT", "REFUGE", "CAMPING", "VIEW", "GUIDE", "MAP", "TOUR", "AREA", "HOTEL", "HOSTEL", "BEACH", "FOREST", "RIVER", "ISLAND", "PORT", "PARK"]
      : [];

  for (const rawSupport of contextualSupport) {
    const ans = normalizeAnswer(rawSupport);
    if (!ans) continue;
    if (ans === themeNorm) continue;
    if (
      !isPublishableAnswerForTheme({
        theme,
        answer: ans,
        language,
        size: Math.min(size, 11),
        allowContextualGeneric: true,
      })
    ) {
      continue;
    }
    if (map.has(ans)) continue;
    map.set(ans, { answer: ans, thematic: false, source: "support" });
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

  const theme = (body.theme || "Argentina").toString();
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
