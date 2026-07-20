# Auditoria de modularizacion de `app/api/generate-crossword/route.ts`

Fecha de auditoria: 2026-07-20.

Alcance: lectura completa de `app/api/generate-crossword/route.ts` en su estado actual. Esta auditoria no propone cambios de comportamiento ni mueve codigo. El objetivo es dejar un mapa verificable para reducir el endpoint a un handler delgado de forma incremental.

## A. Resumen ejecutivo

`route.ts` tiene 20.541 lineas reales. El problema no es solo el tamano: el archivo mezcla frontera HTTP, configuracion de OpenAI, chequeos Supabase, prompts, normalizacion, validacion semantica, pools legacy, reservorios CSP, top-ups CSP, constructores legacy, reparaciones destructivas, generacion de pistas, publicacion y fallbacks tardios dentro de un mismo modulo.

El bloque mas riesgoso es `POST` (`12589-20541`, 7.953 lineas). Dentro de `POST` viven al menos 22 declaraciones anidadas importantes, varias de ellas con closures sobre `theme`, `language`, `client`, `deadlineMs`, `thematicKeepSet`, `publishThemeSet`, `placementThemeSet`, `cspBankAuditReport`, `pool`, `bestPartial`, `lastCspAttemptMeta` y otros estados compartidos. Esto hace que una extraccion directa sea riesgosa si antes no se congelan contratos con tests.

La funcion top-level mas larga fuera del handler es `constructFreeformCrossword` (`6388-8121`, 1.734 lineas). Es un constructor legacy completo con reglas geometricas, scoring, densificacion, reparacion y validacion final mezcladas. Debe extraerse tarde o encapsularse detras de tests de caracterizacion.

Ya existen modulos CSP separados en `app/lib`: `crosswordCsp11.ts`, `crosswordPatterns11.ts`, `crosswordCspOrchestrator11.ts`, `buildCspCrossword11.ts`, `buildCspCandidateReservoir11.ts`, `crosswordCspTopUp11.ts`, `crosswordCspConstraintTopUp11.ts`, `analyzeCspCompatibility11.ts`, `buildHybridCspCandidateReservoir11.ts` y `cspSearchCausality11.ts`. La modularizacion destino debe reutilizarlos; no conviene crear una segunda pila CSP.

La primera extraccion recomendada no es el constructor ni `POST`: es extraer tipos y utilidades puras estables (`Direction`, `Entry`, `Crossword`, `normalizeAnswer`, `safeJson`, `deriveEntriesFromGrid`, metricas de grilla y constantes de thresholds) con tests unitarios. Es el tramo de menor riesgo y habilita que los siguientes modulos compartan tipos.

Objetivo razonable final: `route.ts` deberia quedar entre 200 y 500 lineas, dedicado a recibir `NextRequest`, parsear input, construir dependencias externas, llamar a un servicio/orquestador y convertir el resultado en `NextResponse`.

## B. Metricas

| Metrica | Valor |
|---|---:|
| Lineas reales de `route.ts` | 20.541 |
| Imports | 11 |
| Tipos/interfaces top-level | 15 |
| Constantes top-level | 67 |
| Funciones top-level | 147 |
| Funciones async top-level, incluido `POST` | 19 |
| Lineas de `POST` | 7.953 |
| Declaraciones anidadas detectadas dentro de `POST` | 22 |
| Usos de `process.env` | 25 |
| Feature flags/env vars unicas | 22 |
| `console.log` | 1 |
| `console.warn` | 185 |
| `console.error` | 0 |
| Referencias textuales a OpenAI/openai | 28 |
| Referencias textuales a Supabase/supabase | 4 |
| Ocurrencias textuales de prompt/Prompt | 40 |
| TODO/FIXME | 0 |
| Maxima profundidad aproximada por llaves | 12, cerca de `18324` |
| Constructores/rebuilders/proposals detectados | 24 |
| Validadores/checkers/pruners aproximados | 60 |

Feature flags/env vars detectadas: `ALLOW_RELAXED_CORE_11`, `CROSSWORD_CSP_11_DIAGNOSTIC_BUDGET_MS`, `CROSSWORD_CSP_11_DIAGNOSTIC_ONLY`, `CROSSWORD_CSP_11_HYBRID_DIAGNOSTIC`, `ENABLE_DICTIONARY_PATTERN_11`, `ENABLE_DIRECT_MODEL_11`, `ENABLE_EARLY_OPENING_11`, `ENABLE_SEMANTIC_SUPPORT_11`, `NODE_ENV`, `NODE_TLS_REJECT_UNAUTHORIZED`, `OPENAI_11X11_MODEL_LAYOUT_GRID_UPGRADE`, `OPENAI_11X11_MODEL_RESCUE`, `OPENAI_ALLOW_INSECURE_TLS`, `OPENAI_ANSWERBANK_MODEL`, `OPENAI_ANSWERBANK_SEARCH_MODEL`, `OPENAI_API_KEY`, `OPENAI_CLUE_MODEL`, `OPENAI_COMPACT_ANSWERBANK_MODEL`, `OPENAI_EARLY_LAYOUT_11`, `OPENAI_ENABLE_WEB_SEARCH`, `OPENAI_FIXED_PATTERN_GRID`, `OPENAI_PATTERN_REPAIR_11`.

Diez funciones mas largas:

| Funcion | Lineas |
|---|---:|
| `POST` (`12589-20541`) | 7.953 |
| `constructFreeformCrossword` (`6388-8121`) | 1.734 |
| `specificThematicFallbackClue` (`3053-3647`) | 595 |
| `requestValidatedLayoutProposal` (`9228-9804`) | 577 |
| `inferLocalSupportWords` (`4330-4764`) | 435 |
| `fallbackClueForPublishRepair` (`874-1236`) | 363 |
| `constructOpeningCrossword11` (`12129-12484`) | 356 |
| `constructCompactPatternCrossword11` (`5437-5784`) | 348 |
| `constructPatternCrossword11` (`5097-5436`) | 340 |
| `requestDirectPlayableCrossword11` (`9805-10122`) | 318 |

Cinco dominios mas grandes por rango aproximado:

| Dominio | Rango principal | Lineas aprox. |
|---|---:|---:|
| Orquestacion HTTP, intentos, fallbacks y publicacion dentro de `POST` | `12589-20541` | 7.953 |
| Constructores/rebuilders legacy y rescates estructurales top-level | `4988-8410`, `10936-12484` | 4.972 |
| Vocabularios, filtros, auditoria CSP bank y pool de candidatos | `1972-4987` | 3.016 |
| Prompts y servicios OpenAI de answerbank/layout/grid/clues | `8552-10935` | 2.384 |
| Clue/publication validation y fallback clues | `472-1469`, `3053-3939` | 1.885 |

## C. Inventario

### Imports y efectos top-level

| Lineas | Declaracion | Uso/efecto |
|---|---|---|
| `1` | `NextRequest`, `NextResponse` desde `next/server` | Frontera HTTP; solo deberia quedar en `route.ts`. |
| `2` | `OpenAI` | Cliente externo; usado por answerbank, validacion, top-ups, clues y rescates. |
| `3` | `supabaseAdmin` | Chequeo no fatal al inicio de `POST`; efecto externo. |
| `4-5` | `readFileSync`, `join` | Carga sincrona de diccionarios locales al importar. |
| `6-18` | Modulos CSP existentes | Integracion CSP ya parcialmente extraida. |
| `20` | `runtime = "nodejs"` | Configuracion Next; debe permanecer en boundary. |

### Inventario top-level compacto

La tabla registra simbolos top-level, rango exacto actual, clase, responsabilidad dominante, efectos externos y estado. Las dependencias/callers se detallan en las secciones D y E por dominio; para simbolos pequenos de utilidad pura, el caller real suele ser multiple y no conviene fijarlo como dependencia arquitectonica.

| Simbolo | Clase | Lineas | Responsabilidad / dependencias principales | Efectos | Estado |
|---|---|---:|---|---|---|
| `runtime` | constant | `20-21` | Next runtime. | Next runtime config. | Activo. |
| `Direction` | type | `22-23` | Direccion across/down. | Ninguno. | Activo; duplicable con tipos CSP. |
| `Entry` | type | `24-32` | Entrada publicada. | Ninguno. | Activo. |
| `Crossword` | type | `33-41` | Respuesta interna final. | Ninguno. | Activo. |
| `DerivedEntry` | type | `42-45` | Entrada sin pista. | Ninguno. | Activo. |
| `configureOpenAITlsForLocalDev` | other | `46-58` | Lee/escribe `process.env.NODE_TLS_REJECT_UNAUTHORIZED`; llamado top-level y en `POST`. | Mutacion env + log. | Activo local/dev. |
| `errorSummary` | pure-function | `59-71` | Formatea errores. | Ninguno. | Activo. |
| `ASCII_A_TO_Z` | constant | `72` | Regex normalizacion. | Ninguno. | Activo. |
| `isBlock` | pure-function | `73-74` | Helper `#`. | Ninguno. | Activo. |
| `normalizeAnswer` | pure-function | `75-84` | Normaliza respuestas a A-Z0-9. | Ninguno. | Activo critico. |
| `safeJson` | pure-function | `85-104` | Parse JSON tolerante. | Ninguno. | Activo. |
| `salvageAnswerStringsFromJson` | pure-function | `105-143` | Recupera strings si falla JSON. | Ninguno. | Activo fallback. |
| `crosswordDensityFromGrid` | pure-function | `144-155` | Densidad. | Ninguno. | Activo validator. |
| `checkedCellStats` | validator | `156-205` | Celdas chequeadas por cruces. | Ninguno. | Activo publish. |
| `crossedEntryStats` | validator | `206-242` | Entradas cruzadas. | Ninguno. | Activo publish. |
| `entryCrossingStats` | validator | `243-287` | Cruces por entrada. | Ninguno. | Activo publish/CSP/legacy. |
| `minCrossingsPerEntryForPublish` | pure-function | `288-292` | Threshold cruces. | Ninguno. | Activo. |
| `sanitizeUncheckedGrid` | pure-function | `293-306` | Limpia celdas no chequeadas. | Ninguno. | Legacy/fallback. |
| `blockShortRunsOnly` | validator/repair | `307-355` | Bloquea runs cortos. | Ninguno. | Activo publish repair. |
| `shortRunCellKeys` | validator | `356-388` | Ubica runs cortos. | Ninguno. | Activo. |
| `minEntriesForSize` | pure-function | `389-394` | Threshold historico. | Ninguno. | Activo/legacy. |
| `minPublishEntriesForSize` | validator | `395-400` | Minimo publicable. | Ninguno. | Activo. |
| `desiredPublishEntriesForSize` | pure-function | `401-406` | Objetivo entradas. | Ninguno. | Activo. |
| `minCrossedEntriesForPublish` | validator | `407-410` | Minimo crossed. | Ninguno. | Activo. |
| `minThematicEntriesForPublish` | validator | `411-416` | Cuota tematica publish. | Ninguno. | Activo. |
| `minCoreThematicEntriesForPublish` | validator | `417-425` | Cuota core. | Ninguno. | Activo. |
| `maxGenericContextEntriesForPublish` | validator | `426-434` | Max genericos. | Ninguno. | Activo. |
| `minEntryLenForSize` | pure-function | `435-439` | Min len por tamano. | Ninguno. | Activo. |
| `hasShortLetterRuns` | validator | `440-467` | Detecta runs 1/2. | Ninguno. | Activo. |
| `shouldRejectBestPartialForStrict11` | validator | `468-471` | Gate estricto 11. | Ninguno. | Activo legacy. |
| `isGenericThematicClue` | validator | `472-488` | Pista generica. | Ninguno. | Activo. |
| `isBadClue` | validator | `489-501` | Pistas malas. | Ninguno. | Activo. |
| `clueLooksTooGenericForThematic` | validator | `502-587` | Genericidad por idioma. | Ninguno. | Activo. |
| `clueLooksWeakGeneratedFallback` | validator | `588-629` | Fallback debil. | Ninguno. | Activo. |
| `clueMakesUnstableTemporalClaim` | validator | `630-642` | Temporalidad riesgosa. | Ninguno. | Activo. |
| `clueMislabelsPartialPersonAnswer` | validator | `643-665` | Pistas de fragmentos de persona. | Ninguno. | Activo. |
| `clueMislabelsKnownPartialTitle` | validator | `666-690` | Titulos parciales conocidos. | Ninguno. | Activo; riesgo dominio-especifico. |
| `noteLooksWeakThematicContext` | validator | `691-708` | Nota tematica debil. | Ninguno. | Activo. |
| `clueLanguageLooksValid` | validator | `709-717` | Idioma pista. | Ninguno. | Activo. |
| `publishQualityIssue` | validator | `718-787` | Gate publicable principal de entradas/pistas. | Ninguno. | Activo critico. |
| `pruneMaskedDuplicateAnswers` | pure-function | `788-798` | Prune duplicados en entries. | Ninguno. | Activo. |
| `pruneForbiddenPublishAnswersIfPossible` | repair | `799-803` | Prune respuestas prohibidas. | Ninguno. | Activo. |
| `pruneMaskedDuplicateCandidates` | pure-function | `804-814` | Prune duplicados candidatos. | Ninguno. | Activo. |
| `isForbiddenPublishAnswer` | validator | `815-823` | Denylist publicable. | Ninguno. | Activo. |
| `isKnownIncompleteTitleForTheme` | validator | `824-844` | Fragmentos de titulos por tema. | Ninguno. | Activo; riesgo especifico. |
| `answerLanguageLooksValidForPuzzle` | validator | `845-852` | Idioma respuesta. | Ninguno. | Activo. |
| `blockForbiddenAnswerRuns` | repair | `853-873` | Bloquea runs prohibidos. | Ninguno. | Activo fallback. |
| `fallbackClueForPublishRepair` | prompt/validator | `874-1236` | Pistas fallback por answer/theme/language. | Datos tematicos locales. | Activo; alto riesgo de contaminacion. |
| `repairPublishClues` | repair | `1237-1275` | Repara pistas antes de publicar. | Ninguno. | Activo. |
| `clueMentionsAnswer` | validator | `1276-1282` | Pista contiene respuesta. | Ninguno. | Activo. |
| `clueLooksOffTheme` | validator | `1283-1301` | Pista fuera de tema. | Ninguno. | Activo. |
| `hasReasonableVowelRatio` | validator | `1302-1318` | Heuristica lexica. | Ninguno. | Activo. |
| `hasNoWeirdRepeats` | validator | `1319-1327` | Repeticiones raras. | Ninguno. | Activo. |
| `isLikelyBadAnswer` | validator | `1328-1374` | Calidad respuesta. | Sets locales. | Activo. |
| `WINE_DOMAIN_ANSWERS` | constant | `1375-1395` | Lista dominio vino. | Datos tematicos. | Activo en filtros. |
| `FOOD_DOMAIN_ANSWERS` | constant | `1396-1408` | Lista dominio comida. | Datos tematicos. | Activo en filtros. |
| `BARILOCHE_OFF_THEME_ANSWERS` | constant | `1409-1415` | Lista especifica Bariloche. | Datos especificos. | Activo; no generico. |
| `isDomainContextSupported` | validator | `1416-1432` | Detecta soporte dominio vino/comida. | Datos tematicos. | Activo. |
| `isUnsupportedDomainAnswerForTheme` | validator | `1433-1445` | Rechaza dominios no soportados. | Datos tematicos. | Activo. |
| `isPublishableAnswerForTheme` | validator | `1446-1469` | Gate respuesta publicable. | Varios sets. | Activo critico. |
| `shuffleInPlace` | pure-function | `1470-1476` | Shuffle determinista si recibe rng. | Mutacion de array. | Activo. |
| `makeSeededRng` | pure-function | `1477-1489` | RNG determinista. | Estado interno closure. | Activo. |
| `ALWAYS_ALLOW_ANSWERS` | constant | `1490` | Allowlist vacia. | Ninguno. | Activo/inocuo. |
| `ENABLE_LEGACY_TOPIC_SUPPORT` | constant | `1491-1492` | Flag hardcodeado false. | Control local. | Legacy desactivado. |
| `getThemeAnchors` | pure-function | `1493-1496` | Anchors legacy; retorna vacio. | Ninguno. | Legacy muerto/desactivado. |
| `getThemeClueOverrides` | pure-function | `1497-1502` | Overrides legacy; retorna vacio. | Ninguno. | Legacy muerto/desactivado. |
| `deriveEntriesFromGrid` | pure-function | `1503-1556` | Deriva across/down desde grilla. | Ninguno. | Activo central. |
| `isAcceptable` | validator | `1557-1611` | Gate geometrico/tematico. | Ninguno. | Activo legacy. |
| `Cell` | type | `1612-1613` | Celda working legacy. | Ninguno. | Activo legacy. |
| `Placement` | type | `1614-1620` | Placement legacy. | Ninguno. | Activo legacy. |
| `makeEmptyWorkingGrid` | pure-function | `1621-1624` | Grilla mutable legacy. | Ninguno. | Activo legacy. |
| `inBounds` | pure-function | `1625-1628` | Bounds. | Ninguno. | Activo legacy. |
| `getCell` | pure-function | `1629-1632` | Lee celda. | Ninguno. | Activo legacy. |
| `setCell` | pure-function | `1633-1641` | Escribe celda. | Mutacion grid. | Activo legacy. |
| `canPlaceWord` | validator/builder | `1642-1735` | Valida placement greedy. | Ninguno. | Activo legacy. |
| `placeWord` | builder | `1736-1786` | Coloca palabra y bloques. | Mutacion grid. | Activo legacy. |
| `paintBlocks` | repair | `1787-1809` | Convierte vacios en bloques. | Ninguno. | Activo legacy. |
| `enforceMinWordLen` | repair | `1810-1859` | Bloquea runs cortos. | Ninguno. | Activo legacy. |
| `pruneDanglingRuns` | repair | `1860-1917` | Prune runs colgantes. | Ninguno. | Activo legacy. |
| `keepLargestConnectedComponent` | repair | `1918-1971` | Mantiene componente mayor. | Ninguno. | Activo legacy. |
| `WordCandidate` | type | `1972-1981` | Candidate legacy/CSP adapter. | Ninguno. | Activo; conviene mover temprano. |
| `FILLER_WORDS` | constant | `1982-2076` | Filler EN. | Datos locales. | Activo legacy/support. |
| `SPANISH_FILLER_WORDS` | constant | `2077-2096` | Filler ES. | Datos locales. | Activo legacy/support. |
| `COMMON_ENGLISH_DICTIONARY_WORDS` | constant | `2097-2119` | Lee `data/common-words-en.txt`. | Filesystem top-level. | Activo; side effect import. |
| `loadFrequencyDictionary` | other | `2120-2143` | Lee diccionarios locales. | Filesystem top-level via callers. | Activo. |
| `FREQUENCY_ENGLISH_DICTIONARY_WORDS` | constant | `2144-2146` | Carga `frequency-en-50k.txt`. | Filesystem top-level. | Activo. |
| `FREQUENCY_SPANISH_DICTIONARY_WORDS` | constant | `2147-2150` | Carga `frequency-es-50k.txt`. | Filesystem top-level. | Activo. |
| `WEAK_CONTEXT_DICTIONARY_WORDS` | constant | `2151-2157` | Set soporte debil. | Datos locales. | Activo. |
| `rankSemanticSupportWords` | async-service | `2158-2209` | Usa OpenAI para rankear soporte. | OpenAI. | Activo bajo flag. |
| `RawAnswerBank` | type | `2210` | JSON answerbank. | Ninguno. | Activo. |
| `TARGET_ANSWERS` | constant | `2211` | Target banco. | Ninguno. | Activo. |
| `ANSWERBANK_MODEL` | constant | `2212` | Env model. | `process.env`. | Activo. |
| `CLUE_MODEL` | constant | `2213` | Env model. | `process.env`. | Activo. |
| `ANSWERBANK_SEARCH_MODEL` | constant | `2214` | Env model. | `process.env`. | Activo. |
| `COMPACT_ANSWERBANK_MODEL` | constant | `2215-2217` | Env model fallback. | `process.env`. | Activo. |
| `BANNED_ANSWERS` | constant | `2218-2228` | Denylist. | Datos locales. | Activo. |
| `MODEL_FRAGMENT_ANSWERS` | constant | `2229-2235` | Fragmentos modelo. | Datos locales. | Activo. |
| `CONTEXTUAL_GENERIC_ANSWERS` | constant | `2236` | Genericos contextuales. | Datos locales. | Activo. |
| `LOW_VALUE_CONTEXTLESS_ANSWERS` | constant | `2237-2322` | Respuestas de bajo valor. | Datos locales. | Activo. |
| `CONTEXTUAL_SUPPORT_ANSWERS` | constant | `2323-2384` | Soporte contextual. | Datos locales. | Activo. |
| `SPANISH_WRONG_LANGUAGE_ANSWERS` | constant | `2385-2412` | Filtro idioma. | Datos locales. | Activo. |
| `OVER_GENERIC_THEME_WORDS` | constant | `2413-2423` | Genericos. | Datos locales. | Activo. |
| `isOverGenericThemeWord` | validator | `2424-2436` | Genericidad. | Ninguno. | Activo. |
| `isThemeCoreWord` | validator | `2437-2451` | Relacion tema/respuesta. | Ninguno. | Activo. |
| `isRiskyGeneratedGeographicCompound` | validator | `2452-2476` | Compuestos geograficos riesgosos. | Datos dominio geografico. | Activo. |
| `isOverGenericThemeWordForTheme` | validator | `2477-2560` | Genericidad dependiente de tema. | Datos dominio. | Activo. |
| `sanitizeAnswerList` | pure-function | `2561-2595` | Sanitiza banco. | Ninguno. | Activo critico. |
| `CspBankAuditRejectedSample` | type | `2596-2600` | Auditoria CSP. | Ninguno. | Activo diagnostico. |
| `CspBankAuditReport` | type | `2601-2622` | Auditoria CSP. | Ninguno. | Activo diagnostico. |
| `createCspBankAuditReport` | diagnostic | `2623-2646` | Inicializa auditoria. | Ninguno. | Activo bajo CSP/logs. |
| `cspBankAuditDistribution` | diagnostic | `2647-2656` | Distribucion longitudes. | Ninguno. | Activo. |
| `cspBankAuditCandidateDistribution` | diagnostic | `2657-2660` | Distribucion candidates. | Ninguno. | Activo. |
| `cspBankAuditSample` | diagnostic | `2661-2673` | Samples limitadas. | Ninguno. | Activo. |
| `cspBankAuditLog` | diagnostic | `2674-2677` | Log `[csp-bank-audit]`. | `console.warn`. | Activo. |
| `cspDiagnosticLog` | diagnostic | `2678-2681` | Log `[csp-diagnostic]`. | `console.warn`. | Activo. |
| `cspHybridDiagnosticLog` | diagnostic | `2682-2685` | Log hybrid. | `console.warn`. | Activo. |
| `cspSearchProfileLog` | diagnostic | `2686-2689` | Log search profile. | `console.warn`. | Activo. |
| `cspSearchCausalityLog` | diagnostic | `2690-2693` | Log causality. | `console.warn`. | Activo. |
| `cspWipeoutCausalityLog` | diagnostic | `2694-2697` | Log wipeout. | `console.warn`. | Activo. |
| `cspBranchingDiagnosticLog` | diagnostic | `2698-2701` | Log branching. | `console.warn`. | Activo. |
| `cspValueOrderingDiagnosticLog` | diagnostic | `2702-2705` | Log value ordering. | `console.warn`. | Activo. |
| `cspBankAuditSetDistribution` | diagnostic | `2706-2716` | Registra distribucion. | Log. | Activo. |
| `cspBankAuditAddRejected` | diagnostic | `2717-2730` | Registra rechazo. | Ninguno. | Activo. |
| `cspBankAuditMergeCounts` | diagnostic | `2731-2736` | Merge contadores. | Mutacion objeto. | Activo. |
| `cspBankAuditAnalyzeSanitize` | diagnostic | `2737-2781` | Rechazos sanitize. | Mutacion report. | Activo. |
| `cspBankAuditRejectedBySet` | diagnostic | `2782-2794` | Rechazos por diferencia sets. | Mutacion report. | Activo. |
| `expandGeographicCompoundAnswers` | pure-function | `2795-2829` | Expande compuestos geograficos. | Datos dominio geografico. | Activo. |
| `rebuildGridFromAllowedEntries` | repair | `2830-2866` | Reconstruye grilla por entries permitidas. | Ninguno. | Activo fallback/publish. |
| `rebuildGridFromEntries` | repair | `2867-2905` | Reconstruye por entries. | Ninguno. | Activo. |
| `rebuildGridFromEntriesAllowingAllowedDerived` | repair | `2906-2942` | Reconstruccion permisiva. | Ninguno. | Activo fallback. |
| `pruneWeakEntriesPreservingCrosses` | repair | `2943-3052` | Prune weak manteniendo cruces. | Ninguno. | Activo fallback. |
| `specificThematicFallbackClue` | prompt | `3053-3647` | Pistas fallback especificas. | Datos tematicos locales. | Activo; extraccion riesgosa. |
| `clueFromThemeNote` | pure-function | `3648-3787` | Pista desde nota. | Ninguno. | Activo. |
| `hasStrongThematicClueSupport` | validator | `3788-3810` | Soporte fuerte pista. | Ninguno. | Activo. |
| `isCoreThematicCandidate` | validator | `3811-3836` | Candidate core. | Ninguno. | Activo. |
| `buildCoreThematicSetFromPool` | pure-function | `3837-3860` | Set core. | Ninguno. | Activo. |
| `buildPublishThematicSetFromPool` | pure-function | `3861-3902` | Set publish thematic. | Ninguno. | Activo. |
| `isPlaceholderClue` | validator | `3903-3929` | Placeholder clues. | Ninguno. | Activo. |
| `sanitizeModelClueText` | pure-function | `3930-3939` | Limpia pista. | Ninguno. | Activo. |
| `validateThematicAnswers` | async-service | `3940-4027` | OpenAI valida respuestas. | OpenAI/logs. | Activo critico. |
| `topUpAnswers` | async-service | `4028-4112` | OpenAI top-up simple. | OpenAI/logs. | Activo legacy/no 11 actual. |
| `topUpAnswersRobust` | async-service | `4113-4155` | Retry top-up. | OpenAI via `topUpAnswers`. | Activo legacy. |
| `generateLengthBalancedThematicAnswers` | async-service | `4156-4260` | Top-up por longitud. | OpenAI/logs. | Activo 11. |
| `generateSupportWords` | async-service | `4261-4329` | Soporte via OpenAI. | OpenAI/logs. | Activo/flag. |
| `inferLocalSupportWords` | pure-function | `4330-4764` | Soporte local por diccionarios/listas. | Datos locales/dominio. | Activo. |
| `gridToStrings` | pure-function | `4765-4776` | Convierte cells. | Ninguno. | Activo legacy. |
| `buildCandidatePoolFromAnswers` | builder | `4777-4987` | Pool legacy desde respuestas. | Sets locales. | Activo critico. |
| `PatternSlot` | type | `4988-4995` | Slot pattern legacy. | Ninguno. | Activo legacy. |
| `PATTERN_11X11S` | constant | `4996-5050` | Patrones legacy. | Datos geometricos. | Activo legacy. |
| `extractPatternSlots` | pure-function | `5051-5096` | Slots legacy. | Ninguno. | Activo legacy. |
| `constructPatternCrossword11` | builder | `5097-5436` | Builder fixed pattern legacy. | Logs. | Activo fallback. |
| `constructCompactPatternCrossword11` | builder | `5437-5784` | Builder compact legacy. | Logs. | Activo fallback. |
| `constructBeamCrossword11` | builder | `5785-6040` | Beam 11. | Logs. | Activo fallback. |
| `constructStrictCrossword11` | builder | `6041-6166` | Strict 11. | Ninguno. | Activo fallback. |
| `constructGreedyCheckedCrossword11` | builder | `6167-6387` | Greedy checked. | Logs. | Activo fallback. |
| `constructFreeformCrossword` | builder | `6388-8121` | Constructor greedy/freeform completo. | Logs/mutacion local. | Activo fallback central. |
| `densifyCleanGrid11` | repair | `8122-8410` | Densifica grilla 11. | Logs. | Activo fallback. |
| `generatePatternMatchedRepairWords` | async-service | `8411-8551` | OpenAI repair words. | OpenAI/logs. | Activo bajo flag. |
| `ANSWERBANK_PROMPT` | prompt | `8552-8617` | Prompt answerbank base. | Ninguno. | Activo. |
| `buildAnswerbankRequest` | prompt | `8618-8644` | Construye prompt answerbank. | Ninguno. | Activo. |
| `CLUEBANK_PROMPT` | prompt | `8645-8688` | Prompt pistas. | Ninguno. | Activo. |
| `RawClueBank` | type | `8689-8692` | JSON clues. | Ninguno. | Activo. |
| `AnswerbankTextResult` | type | `8693-8702` | Resultado answerbank. | Ninguno. | Activo. |
| `extractResponseOutputText` | pure-function | `8703-8725` | Extrae Responses API. | Ninguno. | Activo. |
| `requestAnswerbankText` | async-service | `8726-8804` | Pide answerbank, con web search opcional. | OpenAI/env/logs. | Activo. |
| `requestCompactAnswerbankText` | async-service | `8805-8912` | Fallback compact. | OpenAI/env/logs. | Activo. |
| `requestLengthBucketedAnswerbankText` | async-service | `8913-9227` | Answerbank por buckets. | OpenAI/logs. | Activo 11. |
| `requestValidatedLayoutProposal` | async-service/builder | `9228-9804` | Modelo propone layout y valida. | OpenAI/logs/builders. | Activo bajo paths legacy. |
| `requestDirectPlayableCrossword11` | async-service/builder | `9805-10122` | Modelo directo 11. | OpenAI/logs. | Activo bajo flag. |
| `requestValidatedPatternAssignment11` | async-service/builder | `10123-10333` | Modelo asigna pattern. | OpenAI/logs. | Activo. |
| `requestGeneratedPatternGrid11` | async-service/builder | `10334-10563` | Modelo genera grilla pattern. | OpenAI/logs. | Activo bajo flag. |
| `requestValidatedGridProposal` | async-service/builder | `10564-10745` | Modelo propone grilla validada. | OpenAI/logs. | Activo fallback. |
| `buildThematicClueRequestHint` | prompt | `10746-10769` | Hint para pistas. | Ninguno. | Activo. |
| `ClueRequestItem` | type | `10770-10776` | Item pistas. | Ninguno. | Activo. |
| `requestModelClues` | async-service | `10777-10935` | Pide pistas. | OpenAI. | Activo critico. |
| `tryOpeningDeterministic11` | async-service/builder | `10936-11133` | Opening deterministico. | Puede usar client. | Activo fallback. |
| `getPreferredThematicClue` | pure-function | `11134-11147` | Selecciona pista preferida. | Ninguno. | Activo. |
| `reinforceThematicClues` | repair | `11148-11168` | Refuerza pistas. | Ninguno. | Activo. |
| `applyCluesAndOverrides` | repair | `11169-11201` | Aplica clues/overrides. | Ninguno. | Activo. |
| `buildThemeFirstRescueCrossword` | async-service/builder | `11202-11429` | Rescue theme-first. | OpenAI opcional. | Activo fallback. |
| `rebuildPlayableCrossword` | repair | `11430-11511` | Rebuild publicable laxo. | Ninguno. | Activo fallback. |
| `rebuildExactPublishableCrossword` | repair | `11512-11590` | Rebuild exact. | Ninguno. | Activo fallback. |
| `rebuildExactFullyCheckedPublishableCrossword` | repair | `11591-11674` | Rebuild exact checked. | Ninguno. | Activo fallback. |
| `rebuildFullyCheckedPublishableCrossword` | repair | `11675-11696` | Wrapper checked. | Ninguno. | Activo fallback. |
| `rebuildSanitizedFullyCheckedPublishableCrossword` | repair | `11697-11721` | Wrapper sanitized. | Ninguno. | Activo fallback. |
| `rebuildNoShortRunPublishableCrossword` | repair | `11722-11852` | Rebuild sin short runs. | Ninguno. | Activo fallback. |
| `augmentNoShortGridWithCandidates` | repair | `11853-11966` | Aumenta grilla con candidates. | Ninguno. | Activo fallback. |
| `extendGridWithCrossedPair11` | repair/builder | `11967-12128` | Extiende con par cruzado. | Ninguno. | Activo fallback. |
| `constructOpeningCrossword11` | builder | `12129-12484` | Opening deterministic builder. | Ninguno. | Activo fallback. |
| `getDemoCrossword` | builder | `12485-12588` | Demo crossword. | Ninguno. | Sin referencias internas detectables; probablemente muerto. |
| `POST` | HTTP-handler | `12589-20541` | Orquestacion completa. | HTTP, OpenAI, Supabase, env, logs. | Activo. |

### Declaraciones anidadas importantes en `POST`

Deteccion por patron de declaraciones anidadas, con lineas actuales:

| Linea | Declaracion | Rol |
|---:|---|---|
| `12648` | `makeGenerationErrorResponse` | Respuesta de error 503/422 con meta y `lastCspAttemptMeta`. |
| `12666` | `publishCrosswordResponse` | Gate final de publicacion, con reparaciones recursivas. |
| `13822` | `pickPoolForSize` | Recorte legacy por tamano. |
| `13827` | `takeByLen` | Helper de cuotas legacy. |
| `13886` | `band` | Scoring/ranking pool legacy. |
| `13913` | `band` | Segundo helper `band` con mismo nombre en otro scope. |
| `13930` | `pushUnique` | Construccion de pool legacy. |
| `14752` | `isCommonFreeformCandidate` | Identifica candidates comunes para freeform. |
| `14863` | `score` | Score de build candidate. |
| `15455` | `looksFactualOrRisky` | Heuristica para pistas antes de publicar. |
| `16320` | `boundedFallbackDeadline` | Deadline local para fallbacks. |
| `16759` | `buildFastPublishCandidate` | Arma candidato de publicacion fallback. |
| `17457` | `score` | Segundo score de fallback structural. |
| `17488` | `hasPublishableShape` | Shape gate fallback. |

El contador automatico encontro 22 declaraciones anidadas porque tambien detecta `const` iniciales del body y constantes multilinea. Las 14 de la tabla son las que tienen comportamiento funcional relevante.

## D. Mapa de responsabilidades

### 1. HTTP/API boundary

Incluye `runtime`, imports Next, `POST`, `makeGenerationErrorResponse`, `publishCrosswordResponse`.

Rango principal: `12589-20541`.

Dependencias: OpenAI client, Supabase check, todos los dominios internos, flags, logs, CSP modules.

Riesgo de extraccion: alto. `POST` captura muchas variables y tiene retornos anticipados. Debe ser la ultima fase.

Destino recomendado: `app/api/generate-crossword/route.ts` + `app/lib/crossword/pipeline/generateCrosswordEndpoint.ts`.

### 2. Request parsing y runtime config

Incluye parsing de body (`12598-12608`), `configureOpenAITlsForLocalDev`, `isCsp11Enabled`, `shouldUseCspDiagnosticOnly` importados, creacion de `OpenAI`.

Dependencias: `process.env`, `NextRequest`, `OpenAI`.

Riesgo: bajo-medio. Puede extraerse si se inyecta `env`.

Destino: `app/lib/crossword/pipeline/request.ts`.

### 3. OpenAI answer-bank service

Incluye `ANSWERBANK_PROMPT`, `buildAnswerbankRequest`, `requestAnswerbankText`, `requestCompactAnswerbankText`, `requestLengthBucketedAnswerbankText`, `topUpAnswers`, `topUpAnswersRobust`, `generateLengthBalancedThematicAnswers`.

Rangos: `3940-4260`, `8552-9227`.

Dependencias: `OpenAI`, modelos env, `safeJson`, `salvageAnswerStringsFromJson`, normalizacion.

Riesgo: medio. Tiene efectos externos pero firmas claras.

Destino: `app/lib/crossword/answerBank/`.

### 4. Answer sanitization y lexical filters

Incluye `normalizeAnswer`, `sanitizeAnswerList`, `isLikelyBadAnswer`, `answerLanguageLooksValidForPuzzle`, `BANNED_ANSWERS`, `MODEL_FRAGMENT_ANSWERS`, `LOW_VALUE_CONTEXTLESS_ANSWERS`, `SPANISH_WRONG_LANGUAGE_ANSWERS`, `OVER_GENERIC_THEME_WORDS`.

Rangos: `75-84`, `815-852`, `1302-1374`, `2218-2560`, `2561-2595`.

Dependencias: sets locales, idioma, tema.

Riesgo: bajo para funciones puras; medio para reglas con datos de dominio.

Destino: `app/lib/crossword/domain/normalize.ts`, `app/lib/crossword/answerBank/sanitizeAnswers.ts`, `app/lib/crossword/answerBank/answerQuality.ts`.

### 5. Thematic validation

Incluye `validateThematicAnswers`, `isThemeCoreWord`, `isOverGenericThemeWordForTheme`, `isPublishableAnswerForTheme`, `isUnsupportedDomainAnswerForTheme`, `expandGeographicCompoundAnswers`.

Rangos: `1416-1469`, `2437-2560`, `2795-2829`, `3940-4027`.

Dependencias: OpenAI para validacion principal, heuristicas locales de fallback, notes.

Riesgo: medio-alto por mezcla semantica/local y contaminacion de dominio.

Destino: `app/lib/crossword/semantic/`.

### 6. Candidate-pool construction legacy

Incluye `WordCandidate`, filler/local dictionaries, `inferLocalSupportWords`, `buildCandidatePoolFromAnswers`, `pickPoolForSize` dentro de `POST`.

Rangos: `1972-2209`, `4330-4987`, `13822-13976`.

Dependencias: filesystem top-level, sets lexicales, thematic sets, notes.

Riesgo: medio. `pickPoolForSize` captura variables en `POST`.

Destino: `app/lib/crossword/candidates/legacyPool.ts`.

### 7. CSP integration y diagnostics

Incluye imports CSP, `CspBankAuditReport`, `cspBankAudit*`, `cspDiagnosticLog`, `cspHybridDiagnosticLog`, `cspSearch*Log`, construccion de `cspCandidateReservoir`, callbacks `topUpByLength` y `topUpByConstraints`, respuesta diagnostic-only.

Rangos: `2596-2794`, `13746-14355`, `14403-14445`.

Dependencias: modulos CSP existentes, OpenAI para top-ups, `validateThematicAnswers`, thematic sets.

Riesgo: medio. Ya hay modulos CSP, pero los callbacks siguen capturando `client`, `theme`, `language`, `cspBankAuditReport`, `thematicKeepSet`.

Destino: `app/lib/crossword/csp/endpointIntegration.ts` o ampliar `app/lib/buildCspCrossword11.ts`.

### 8. Legacy geometric primitives

Incluye `deriveEntriesFromGrid`, `isAcceptable`, `makeEmptyWorkingGrid`, `canPlaceWord`, `placeWord`, `paintBlocks`, `enforceMinWordLen`, `pruneDanglingRuns`, `keepLargestConnectedComponent`.

Rangos: `1503-1971`.

Dependencias: thresholds, `Entry`, `Cell`.

Riesgo: bajo-medio. Funciones puras/mutantes locales, pero semantica delicada.

Destino: `app/lib/crossword/legacy/gridGeometry.ts`.

### 9. Legacy builders

Incluye `PATTERN_11X11S`, `extractPatternSlots`, `constructPatternCrossword11`, `constructCompactPatternCrossword11`, `constructBeamCrossword11`, `constructStrictCrossword11`, `constructGreedyCheckedCrossword11`, `constructFreeformCrossword`, `constructOpeningCrossword11`.

Rangos: `4988-8121`, `12129-12484`.

Dependencias: geometric primitives, pool, scoring, validators, logs.

Riesgo: alto, especialmente `constructFreeformCrossword`.

Destino: `app/lib/crossword/legacy/`.

### 10. Grid repair/cleanup/rebuild

Incluye `blockShortRunsOnly`, `blockForbiddenAnswerRuns`, `rebuildGridFromAllowedEntries`, `rebuildGridFromEntries`, `rebuildGridFromEntriesAllowingAllowedDerived`, `pruneWeakEntriesPreservingCrosses`, `densifyCleanGrid11`, `rebuildPlayableCrossword`, `rebuildExactPublishableCrossword`, `rebuildExactFullyCheckedPublishableCrossword`, `rebuildNoShortRunPublishableCrossword`, `augmentNoShortGridWithCandidates`, `extendGridWithCrossedPair11`.

Rangos: `293-388`, `853-873`, `2830-3052`, `8122-8410`, `11430-12128`.

Dependencias: validators, entries, candidates.

Riesgo: alto cuando se usa despues de validaciones. Debe extraerse con tests de caracterizacion.

Destino: `app/lib/crossword/legacy/repair.ts`.

### 11. Model layout/grid/direct proposals

Incluye `requestValidatedLayoutProposal`, `requestDirectPlayableCrossword11`, `requestValidatedPatternAssignment11`, `requestGeneratedPatternGrid11`, `requestValidatedGridProposal`, `generatePatternMatchedRepairWords`.

Rangos: `8411-8551`, `9228-10745`.

Dependencias: OpenAI, validators, builders locales, prompts embebidos.

Riesgo: medio-alto. Son servicios externos con validacion interna.

Destino: `app/lib/crossword/modelLayout/`.

### 12. Clue generation and validation

Incluye `CLUEBANK_PROMPT`, `requestModelClues`, `fallbackClueForPublishRepair`, `specificThematicFallbackClue`, `clueFromThemeNote`, `repairPublishClues`, `applyCluesAndOverrides`, `publishQualityIssue`, clue validators.

Rangos: `472-1301`, `3053-3939`, `8645-8688`, `10746-11201`.

Dependencias: OpenAI, theme, language, notes, publication thresholds.

Riesgo: alto por contaminacion de dominio y fallback clues.

Destino: `app/lib/crossword/clues/`.

### 13. Publication validation and response shaping

Incluye `publishCrosswordResponse` anidada, `publishQualityIssue`, crossing/density validators, final JSON assembly en varios puntos de `POST`.

Rangos: `718-787`, `12666-12850`, `15128-15720`, fallbacks `15758-20496`.

Dependencias: casi todo el pipeline.

Riesgo: alto. Requiere tests de contrato HTTP.

Destino: `app/lib/crossword/pipeline/publication.ts`.

### 14. Supabase integration

Incluye `supabaseAdmin.from("crosswords").select("id").limit(1)` al inicio de `POST`.

Rango: `12591-12596`.

Dependencias: Supabase singleton.

Riesgo: bajo si se encapsula como health/check no fatal.

Destino: `app/lib/crossword/pipeline/supabaseHealth.ts`.

## E. Grafo de dependencias

Grafo conceptual real con nombres actuales:

```text
POST
  -> supabaseAdmin health check
  -> request parsing / env / OpenAI client
  -> requestLengthBucketedAnswerbankText | requestAnswerbankText | requestCompactAnswerbankText
  -> safeJson / salvageAnswerStringsFromJson / normalizeAnswer / sanitizeAnswerList
  -> expandGeographicCompoundAnswers / notesByAnswer
  -> validateThematicAnswers
  -> generateLengthBalancedThematicAnswers / topUpAnswersRobust
  -> buildCandidatePoolFromAnswers
  -> buildCspCandidateReservoir11 / buildHybridCspCandidateReservoir11
  -> pickPoolForSize (nested legacy)
  -> buildCspCrossword11ForEndpoint
       -> requestCspLengthTopUpAnswers11 callback
       -> requestCspConstraintTopUpAnswers11 callback
       -> validateThematicAnswers callback
  -> if CSP ok: cspBuilt
  -> if CSP diagnostic-only fails: NextResponse 422
  -> legacy builders:
       -> tryOpeningDeterministic11
       -> constructCompactPatternCrossword11
       -> constructFreeformCrossword
       -> constructStrictCrossword11
       -> constructBeamCrossword11
       -> constructOpeningCrossword11
       -> requestValidatedLayoutProposal / requestValidatedGridProposal
       -> buildThemeFirstRescueCrossword
       -> densifyCleanGrid11 / rebuild* / augment*
  -> deriveEntriesFromGrid / isAcceptable / hasShortLetterRuns / checkedCellStats / entryCrossingStats
  -> requestModelClues
  -> applyCluesAndOverrides / repairPublishClues / publishQualityIssue
  -> publishCrosswordResponse
  -> NextResponse.json
```

Dependencias ciclicas o casi ciclicas:

- `POST` llama validators y repairs; `publishCrosswordResponse` anidado puede llamar `publishCrosswordResponse` recursivamente luego de reparar grillas.
- Builders legacy devuelven grillas que luego son transformadas por cleanup/rebuild; algunas reparaciones vuelven a derivar entries y vuelven a entrar a gates similares.
- Clue validation y publication validation estan acopladas: una pista puede ser generada, reparada, rechazada, re-reparada o usada para decidir publicar.
- CSP integration ya llama modulos externos, pero sus callbacks vuelven a `validateThematicAnswers` y mutan sets compartidos de `POST`.

Funciones con demasiadas dependencias:

- `POST`: todos los dominios, HTTP, env, OpenAI, Supabase, deadlines, CSP, legacy, clues, publish.
- `publishCrosswordResponse`: validators, rebuilders, clue repair, thresholds, theme/language, recursion.
- `constructFreeformCrossword`: geometric primitives, scoring, repair/densify, candidate metadata, logs, final validation.
- `requestValidatedLayoutProposal`: OpenAI, JSON parsing, pattern local fill, validators, builder metadata.
- `specificThematicFallbackClue`: tema/respuesta/idioma, multiples reglas especificas.

Helpers que dependen accidentalmente del scope de `POST`:

- `pickPoolForSize`, `takeByLen`, `pushUnique`, `isCommonFreeformCandidate`, los dos `score`, `looksFactualOrRisky`, `boundedFallbackDeadline`, `buildFastPublishCandidate`, `hasPublishableShape`.
- Callbacks CSP `topUpByLength` y `topUpByConstraints` capturan `client`, `theme`, `language`, `n`, `attempt`, `deadlineMs`, `cspBankAuditReport`, `thematicKeepSet`, `publishThemeSet`, `placementThemeSet`, `cspTopUpCandidates`.

Validaciones duplicadas o divergentes:

- Runs cortos: `hasShortLetterRuns`, `shortRunCellKeys`, `blockShortRunsOnly`, `enforceMinWordLen`, `pruneDanglingRuns`.
- Cruces: `checkedCellStats`, `crossedEntryStats`, `entryCrossingStats`, `isAcceptable`, validators frontend en `app/lib/validateGeneratedCrossword.ts`.
- Respuesta mala/generica: `isLikelyBadAnswer`, `isForbiddenPublishAnswer`, `isOverGenericThemeWord`, `isOverGenericThemeWordForTheme`, `publishQualityIssue`, clue validators.
- Rebuilds publicables: multiples `rebuild*PublishableCrossword` con semantica similar pero diferente.

## F. Codigo posiblemente muerto o duplicado

| Simbolo/bloque | Lineas | Evidencia | Confianza |
|---|---:|---|---|
| `getDemoCrossword` | `12485-12588` | Sin referencias internas detectables salvo declaracion. | Alta |
| `ENABLE_LEGACY_TOPIC_SUPPORT` | `1491-1492` | Constante hardcodeada `false`; `getThemeAnchors` y `getThemeClueOverrides` devuelven vacio. | Alta |
| `getThemeAnchors` / `getThemeClueOverrides` | `1493-1502` | Retornos vacios; parecen restos de soporte tematico legacy. | Alta |
| Dos helpers `band` anidados | `13886`, `13913` | Mismo nombre en scopes cercanos para scoring de pool. | Media |
| Dos helpers `score` anidados | `14863`, `17457` | Misma palabra para scoring de candidatos/builds distintos. | Media |
| `PATTERN_11X11S` vs `CROSSWORD_PATTERNS_11` | `4996-5050`, import `18` | Dos bibliotecas de patrones 11x11: legacy y CSP. No son equivalentes. | Alta |
| `constructPatternCrossword11`, `constructCompactPatternCrossword11`, `constructStrictCrossword11`, `constructGreedyCheckedCrossword11`, `constructFreeformCrossword`, `constructOpeningCrossword11` | `5097-8121`, `12129-12484` | Varios builders compiten y aplican reglas geometricas distintas. | Alta |
| `rebuildPlayableCrossword`, `rebuildExactPublishableCrossword`, `rebuildExactFullyCheckedPublishableCrossword`, `rebuildFullyCheckedPublishableCrossword`, `rebuildSanitizedFullyCheckedPublishableCrossword`, `rebuildNoShortRunPublishableCrossword` | `11430-11852` | Familia de rebuilds con nombres casi sinonimos y gates distintos. | Alta |
| `fallbackClueForPublishRepair` y `specificThematicFallbackClue` | `874-1236`, `3053-3647` | Ambos generan pistas fallback; responsabilidades superpuestas. | Media |
| `requestValidatedLayoutProposal`, `requestValidatedGridProposal`, `requestGeneratedPatternGrid11`, `requestValidatedPatternAssignment11` | `9228-10745` | Varias rutas de modelo para layout/grid/pattern. Activas por flags/rutas de fallback. | Media |
| Reglas especificas de dominio (`WINE_DOMAIN_ANSWERS`, `FOOD_DOMAIN_ANSWERS`, `BARILOCHE_OFF_THEME_ANSWERS`) | `1375-1415` | Datos no genericos en route. | Alta |
| `COMMON_ENGLISH_DICTIONARY_WORDS`, `FREQUENCY_*` top-level | `2097-2150` | Lee archivos al importar endpoint; side effect no ideal. | Alta |

No se borra nada en esta auditoria. La confianza "alta" solo significa que merece aislamiento o test de caracterizacion antes de decidir si se elimina.

## G. Arquitectura destino

Propuesta bajo `app/lib/crossword/`, reutilizando los modulos CSP existentes:

```text
app/lib/crossword/
  domain/
    types.ts
    normalize.ts
    grid.ts
    thresholds.ts
    rng.ts

  validation/
    geometry.ts
    publishQuality.ts
    clueQuality.ts
    answerQuality.ts

  answerBank/
    prompts.ts
    requestAnswerBank.ts
    sanitizeAnswers.ts
    validateThematicAnswers.ts
    topUpAnswers.ts
    responseParsing.ts

  candidates/
    types.ts
    buildCandidatePool.ts
    buildLegacyPool.ts
    supportWords.ts
    dictionaries.ts

  csp/
    endpointIntegration.ts
    diagnostics.ts
    topUpCallbacks.ts
    re-export/import existing app/lib/crosswordCsp*.ts modules

  legacy/
    gridGeometry.ts
    patternBuilder.ts
    compactPatternBuilder.ts
    beamBuilder.ts
    strictBuilder.ts
    greedyCheckedBuilder.ts
    freeformBuilder.ts
    openingBuilder.ts
    repair.ts
    modelLayout.ts

  clues/
    prompts.ts
    requestClues.ts
    fallbackClues.ts
    repairClues.ts

  pipeline/
    request.ts
    generationTypes.ts
    generateCrossword11.ts
    publication.ts
    fallbacks.ts
    diagnostics.ts
    supabaseHealth.ts

app/api/generate-crossword/route.ts
```

Responsabilidades y APIs sugeridas:

| Archivo destino | Contenido | Dependencias permitidas | Prohibidas |
|---|---|---|---|
| `domain/types.ts` | `Direction`, `Entry`, `Crossword`, `DerivedEntry`, `WordCandidate` | Ninguna o tipos TS. | OpenAI, Next, Supabase. |
| `domain/normalize.ts` | `normalizeAnswer`, `ASCII_A_TO_Z` | Ninguna. | Logs, env. |
| `domain/grid.ts` | `deriveEntriesFromGrid`, `gridToStrings`, density/crossing stats | `types.ts`. | OpenAI, Next. |
| `validation/publishQuality.ts` | `publishQualityIssue`, publish thresholds | `types`, `answerQuality`, `clueQuality`, `grid`. | NextResponse. |
| `answerBank/requestAnswerBank.ts` | `requestAnswerbankText`, compact, bucketed | OpenAI client inyectado. | Instanciar OpenAI internamente. |
| `answerBank/prompts.ts` | `ANSWERBANK_PROMPT`, builders de prompt | Ninguna. | Cliente OpenAI. |
| `answerBank/validateThematicAnswers.ts` | `validateThematicAnswers` | OpenAI client inyectado, sanitize. | NextRequest/Response. |
| `candidates/buildLegacyPool.ts` | `buildCandidatePoolFromAnswers`, `pickPoolForSize` | answer quality, support words. | CSP solver. |
| `csp/endpointIntegration.ts` | Adaptar route -> `buildCspCrossword11ForEndpoint` | Modulos CSP existentes, callbacks inyectados. | Legacy builders. |
| `legacy/freeformBuilder.ts` | `constructFreeformCrossword` | `legacy/gridGeometry`, validators. | OpenAI, Next. |
| `legacy/modelLayout.ts` | request model layout/grid | OpenAI client inyectado, validators. | Next. |
| `clues/requestClues.ts` | `requestModelClues` | OpenAI client inyectado. | Publication response. |
| `pipeline/generateCrossword11.ts` | Orquestacion de alto nivel | Servicios por interfaz. | NextRequest/NextResponse. |
| `pipeline/publication.ts` | `publishCrosswordResponse` como funcion pura-ish | validators, repair clues. | Leer env. |

## H. Plan incremental

Cada fase debe preservar logs, flags y respuestas. Ninguna fase deberia cambiar semantica.

### Fase 1: tipos y normalizacion pura

- Origen: `route.ts`.
- Destino: `app/lib/crossword/domain/types.ts`, `normalize.ts`, `rng.ts`.
- Simbolos: `Direction`, `Entry`, `Crossword`, `DerivedEntry`, `WordCandidate`, `ASCII_A_TO_Z`, `normalizeAnswer`, `safeJson`, `errorSummary`, `makeSeededRng`, `shuffleInPlace`.
- Riesgo: bajo.
- Tests: normalizacion, JSON seguro, RNG determinista.
- Equivalencia: snapshots de outputs actuales.
- Reduccion estimada: 80-120 lineas.

### Fase 2: metricas y derivacion de grilla

- Destino: `app/lib/crossword/domain/grid.ts`.
- Simbolos: `crosswordDensityFromGrid`, `checkedCellStats`, `crossedEntryStats`, `entryCrossingStats`, `deriveEntriesFromGrid`, `gridToStrings`, `minEntryLenForSize`.
- Riesgo: bajo-medio.
- Tests: grillas fixture con runs, cruces, duplicados.
- Reduccion estimada: 220-280 lineas.

### Fase 3: thresholds y validadores publicables puros

- Destino: `app/lib/crossword/validation/publishQuality.ts`.
- Simbolos: `min*ForSize`, `hasShortLetterRuns`, `shortRunCellKeys`, `publishQualityIssue`, clue validators puros.
- Riesgo: medio porque afecta gates.
- Tests: fixtures de publicaciones aceptadas/rechazadas.
- Reduccion estimada: 450-650 lineas.

### Fase 4: answer sanitize y answer quality

- Destino: `answerBank/sanitizeAnswers.ts`, `validation/answerQuality.ts`.
- Simbolos: `sanitizeAnswerList`, `isLikelyBadAnswer`, `isForbiddenPublishAnswer`, `isOverGenericThemeWord*`, sets de banned/contextual.
- Riesgo: medio por reglas especificas.
- Tests: casos de idioma, duplicados, tema exacto, fragmentos.
- Reduccion estimada: 500-800 lineas.

### Fase 5: auditoria/logging CSP bank

- Destino: `csp/diagnostics.ts`.
- Simbolos: `CspBankAuditReport`, `createCspBankAuditReport`, `cspBankAudit*`, `cspDiagnosticLog`, `cspHybridDiagnosticLog`, `cspSearch*Log`.
- Riesgo: bajo-medio; preservar prefijos exactos.
- Tests: estructuras de reporte y muestras limitadas.
- Reduccion estimada: 200-260 lineas.

### Fase 6: prompts y request answerbank

- Destino: `answerBank/prompts.ts`, `answerBank/requestAnswerBank.ts`.
- Simbolos: `ANSWERBANK_PROMPT`, `buildAnswerbankRequest`, `requestAnswerbankText`, `requestCompactAnswerbankText`, `requestLengthBucketedAnswerbankText`, `extractResponseOutputText`, `RawAnswerBank`, `AnswerbankTextResult`.
- Riesgo: medio; efectos OpenAI.
- Tests: mock de OpenAI, web-search fallback, JSON parse.
- Reduccion estimada: 600-750 lineas.

### Fase 7: validate/top-up semantic services

- Destino: `answerBank/validateThematicAnswers.ts`, `answerBank/topUpAnswers.ts`.
- Simbolos: `validateThematicAnswers`, `topUpAnswers`, `topUpAnswersRobust`, `generateLengthBalancedThematicAnswers`, `generateSupportWords`, `rankSemanticSupportWords`.
- Riesgo: medio-alto; OpenAI y prompts.
- Tests: mocks, rejects, no API key, timeouts.
- Reduccion estimada: 450-550 lineas.

### Fase 8: candidate pools y dictionaries

- Destino: `candidates/dictionaries.ts`, `candidates/supportWords.ts`, `candidates/buildCandidatePool.ts`, `candidates/buildLegacyPool.ts`.
- Simbolos: filler/dictionaries, `loadFrequencyDictionary`, `inferLocalSupportWords`, `buildCandidatePoolFromAnswers`, `pickPoolForSize` extraido desde `POST`.
- Riesgo: medio-alto por capturas y side effects top-level.
- Tests: distribuciones por longitud, no cap CSP, legacy pool equivalente.
- Reduccion estimada: 900-1.200 lineas.

### Fase 9: CSP endpoint integration

- Destino: `csp/endpointIntegration.ts`, `csp/topUpCallbacks.ts`.
- Simbolos: construccion `cspCandidateReservoir`, `hybridCspCandidateReservoir`, callbacks de top-up, respuesta diagnostic-only CSP.
- Riesgo: medio-alto por callbacks que mutan sets.
- Tests: flag off, flag on, diagnostic-only, top-up accepted/rejected, no legacy en diagnostic-only.
- Reduccion estimada: 650-900 lineas desde `POST`.

### Fase 10: legacy geometry primitives

- Destino: `legacy/gridGeometry.ts`.
- Simbolos: `Cell`, `Placement`, `makeEmptyWorkingGrid`, `inBounds`, `getCell`, `setCell`, `canPlaceWord`, `placeWord`, `paintBlocks`, `enforceMinWordLen`, `pruneDanglingRuns`, `keepLargestConnectedComponent`.
- Riesgo: medio. No cambiar semantica.
- Tests: fixtures con motivos de rechazo y blocks.
- Reduccion estimada: 360-420 lineas.

### Fase 11: legacy builders y repair

- Destino: `legacy/patternBuilder.ts`, `legacy/freeformBuilder.ts`, `legacy/repair.ts`, `legacy/openingBuilder.ts`, `legacy/modelLayout.ts`.
- Simbolos: todos los `construct*`, `densifyCleanGrid11`, `rebuild*`, `augment*`, `extendGrid*`, `requestValidatedLayoutProposal`, etc.
- Riesgo: alto. Mover uno por fase si hace falta.
- Tests: caracterizacion con bancos sintenticos y snapshots de meta/failure.
- Reduccion estimada: 4.500-5.500 lineas.

### Fase 12: pipeline y handler delgado

- Destino: `pipeline/generateCrossword11.ts`, `pipeline/publication.ts`, `pipeline/fallbacks.ts`.
- Simbolos: cuerpo de `POST`, `publishCrosswordResponse`, `makeGenerationErrorResponse`.
- Riesgo: muy alto; debe hacerse al final.
- Tests: contrato HTTP completo con mocks OpenAI/Supabase.
- Reduccion estimada final: 7.000+ lineas.

## I. Pruebas de caracterizacion necesarias

Unitarias:

- `normalizeAnswer`, `sanitizeAnswerList`, `safeJson`, `salvageAnswerStringsFromJson`.
- `deriveEntriesFromGrid`, `hasShortLetterRuns`, `entryCrossingStats`, `checkedCellStats`.
- `publishQualityIssue` con pistas genericas, respuestas duplicadas, tema exacto, soporte contextual.
- `buildCandidatePoolFromAnswers` y `pickPoolForSize` con distribuciones conocidas.
- `canPlaceWord` y `placeWord` con rechazos `out_of_bounds`, `blocked_cell`, `side_touch`, `before/after`.
- `repairPublishClues`, `applyCluesAndOverrides`, `clueLooksTooGenericForThematic`.

Integracion con mocks:

- Request sin API key.
- Fallo de OpenAI answerbank.
- Answerbank valido e invalido.
- `validateThematicAnswers` falla y activa fallback local.
- Length-balanced top-up.
- CSP flag apagado no intenta CSP.
- CSP flag prendido intenta antes de legacy.
- Diagnostic-only no ejecuta legacy.
- Hybrid diagnostic solo bajo los tres flags.
- CSP exitoso converge al flujo de pistas.
- CSP fallido cae a legacy si diagnostic-only esta apagado.
- Legacy builder null con rescates.
- Publicacion aceptada/rechazada por status y JSON.

Contrato HTTP:

- Status 200 con grilla/pistas/meta.
- Status 422 diagnostic-only CSP.
- Status 503/422 generacion imposible.
- Estructura `meta.source`, `meta.cspAttempt`, `diagnostic.bankAudit`.
- Ausencia de prompts y secretos en respuestas.

Mocks necesarios:

- OpenAI chat completions y Responses API.
- Supabase `from().select().limit()`.
- Reloj/deadline (`Date.now`) para rutas de timeout.
- Diccionarios locales si se quiere evitar dependencia de archivos reales en unit tests.

## J. Riesgos y mitigaciones

| Riesgo | Evidencia | Mitigacion |
|---|---|---|
| Closures masivas en `POST` | callbacks CSP y helpers nested capturan estado mutable. | Extraer primero tipos/funciones puras; luego introducir contexto explicito `GenerationContext`. |
| Orden de inicializacion | diccionarios se leen al importar. | Mover a loader lazy/cacheado con tests de fallback. |
| Variables env leidas al importar | modelos OpenAI y TLS config. | Centralizar `getGenerationConfig(env)`; mantener defaults. |
| Mutacion de `process.env.NODE_TLS_REJECT_UNAUTHORIZED` | `configureOpenAITlsForLocalDev`. | Aislar en boundary, no en modulos puros. |
| Sets/Maps compartidos | `thematicKeepSet`, `publishThemeSet`, `placementThemeSet`. | Pasar y devolver snapshots; evitar mutacion oculta en callbacks. |
| Dependencia circular futura | candidates -> validation -> clues -> candidates. | Definir capas: domain -> validation -> answerBank/candidates -> builders -> pipeline. |
| Logs dependientes de orden | 185 `console.warn`. | Tests de prefijos y mantener loggers inyectados. |
| Feature flags | 22 env vars. | Config tipada y snapshot de flags al inicio del request. |
| Deadline compartido | `deadlineMs` usado por muchas ramas. | Crear `DeadlineBudget` inyectado. |
| Determinismo/seed | seed calculado dentro de attempt. | Extraer `computeGenerationSeed(theme,n,attempt)`. |
| Next runtime boundary | `NextRequest/NextResponse` mezclado con pipeline. | Pipeline devuelve resultado serializable; route convierte a response. |
| OpenAI y Supabase en tests | Efectos externos. | Interfaces `AnswerBankClient`, `ClueClient`, `SupabaseHealthClient`. |
| Validadores duplicados | runs/cruces/publish gates en varios puntos. | Consolidar con tests antes de reemplazar llamadas. |
| Codigo especifico de dominio | Bariloche/vino/comida/titulos. | Mover a `semantic/legacyRules.ts`, auditar y testear antes de neutralizar. |

## K. Criterio para considerar finalizada la modularizacion

La modularizacion puede considerarse terminada cuando:

1. `route.ts` contiene solo imports, `runtime`, parsing minimo, construccion de dependencias y llamada a un servicio.
2. No hay prompts, builders, validators, dictionaries ni repairs dentro de `route.ts`.
3. `POST` no contiene callbacks grandes ni helpers anidados con logica de negocio.
4. El pipeline principal es testeable sin `NextRequest` ni `NextResponse`.
5. OpenAI y Supabase estan detras de interfaces mockeables.
6. Los modulos puros no leen `process.env`, filesystem ni hacen logs.
7. Los builders legacy estan encapsulados detras de una API estable.
8. La integracion CSP reutiliza los modulos existentes y no duplica tipos.
9. Los tests de contrato HTTP cubren status, JSON y metadata.
10. El comportamiento con flags apagados y encendidos queda caracterizado.

Tamano objetivo: unos pocos cientos de lineas, idealmente 200-500. No es una cifra rigida; el criterio importante es que `route.ts` no contenga logica de generacion, construccion, pistas ni reparacion.

## L. Primer corte recomendado

Primera fase concreta:

```text
Extraer:
  Direction, Entry, Crossword, DerivedEntry, WordCandidate
  ASCII_A_TO_Z
  normalizeAnswer
  safeJson
  errorSummary
  makeSeededRng
  shuffleInPlace

Destino:
  app/lib/crossword/domain/types.ts
  app/lib/crossword/domain/normalize.ts
  app/lib/crossword/domain/rng.ts
```

Motivo: son simbolos chicos, casi puros, con dependencias minimas y alto reuso. Reducen poco en lineas, pero crean una base comun para extraer luego grid validators, answerbank y candidate pools sin introducir dependencias circulares.

Reduccion total estimada tras todas las fases: entre 18.000 y 20.000 lineas fuera de `route.ts`, dejando el handler en el orden de 200-500 lineas.
