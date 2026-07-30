# Route Executive Refactor Roadmap

Fecha: 2026-07-30.

Alcance: decision ejecutiva para convertir `app/api/generate-crossword/route.ts` en un orquestador delgado. No describe el codigo en detalle; solo ordena bloques completos extraibles por reduccion esperada y riesgo.

Estado base observado:

- `route.ts`: 20.181 lineas fisicas por `(Get-Content ...).Count`.
- `route.ts`: 18.600 lineas por `Measure-Object -Line`.
- Answer Pipeline ya parcialmente extraido: parsing/audit, sanitizacion inicial, merge pre-pool, request adapter y runner robusto de top-up.
- Objetivo final razonable: `route.ts` entre 300 y 700 lineas, dedicado a HTTP, dependencias externas, orquestacion y `NextResponse`.

## Dominios principales

| Dominio | Responsabilidad | Lineas aprox. en `route.ts` | Dependencias principales | Modularizacion | Encapsulable hoy | Riesgo | Reduccion estimada |
|---|---|---:|---|---:|---|---|---:|
| Legacy grid builders | Constructores, rebuilders, densificacion, rescates estructurales y fallback de grilla. | 5.000-5.700 | `WordCandidate`, grid utils, publish gates, RNG, candidates, clues | 0% | Parcial | Alto | 4.500-5.200 |
| `POST` orchestration blocks | Intentos, flags, deadlines, handoffs CSP/legacy, fallback final, responses. | 6.500-7.200 | Next, OpenAI, Supabase, Answer Pipeline, CSP, legacy, publish | 10% | Parcial | Alto | 3.000-4.500 |
| Clues and publish pipeline | Generacion de pistas, fallback clues, reparacion de pistas, gates publicables. | 2.200-2.800 | OpenAI clue model, entries, theme/language, publish policies | 0% | Si | Medio | 2.000-2.500 |
| OpenAI generation services | Answer bank, compact/length-bucketed bank, layout proposal, direct model, grid proposal, pattern assignment. | 2.000-2.500 | OpenAI client, prompts, env models, parsers, validators | 15% | Si | Medio | 1.800-2.300 |
| Answer Pipeline remaining | Validacion tematica, support words, semantic support, candidate pool, notes/source/priority, general top-ups wrappers. | 1.700-2.300 | OpenAI, policies, notes maps, support dictionaries, CSP/legacy consumers | 60% | Si | Medio | 1.300-1.900 |
| Grid validators and repairs | Derivacion de entries, short runs, crossing stats, density, component repairs, publish geometry. | 1.200-1.700 | `Entry`, `Crossword`, grid arrays, min thresholds | 20% | Si | Bajo-Medio | 1.100-1.500 |
| Editorial policies and vocabularies | Denylists, allowlists, language filters, genericity, domain/fixture debt, filler words. | 1.000-1.500 | theme/language, normalize, local sets, data files | 10% | Parcial | Alto | 700-1.100 |
| CSP endpoint integration | Diagnostic-only/hybrid orchestration, reservoir handoff, CSP top-up callbacks, diagnostic logs. | 900-1.300 | CSP modules, OpenAI callbacks, deadline, flags, diagnostics | 65% | Parcial | Medio-Alto | 600-900 |
| Local dictionaries/data loading | Common/frequency dictionaries and support dictionary loading. | 250-450 | filesystem, data files, `process.cwd`, normalize | 0% | Si | Bajo | 250-400 |
| HTTP/API boundary | Request parsing, env checks, dependency construction, Supabase smoke, error envelopes. | 300-600 | NextRequest, NextResponse, env, Supabase, OpenAI factory | 25% | No | Medio | 0-150 |

## Tabla resumen priorizada

Ordenada por mayor reduccion y, dentro de rangos similares, menor riesgo.

| Prioridad | Bloque completo | Encapsulable hoy | Riesgo | Reduccion aprox. | Nota ejecutiva |
|---:|---|---|---|---:|---|
| 1 | OpenAI generation services | Si | Medio | 1.800-2.300 | Gran bloque effectful con frontera clara: cliente inyectado, prompts intactos, payloads intactos. |
| 2 | Clues and publish pipeline | Si | Medio | 2.000-2.500 | Bloque completo de salida/publicacion; alto impacto y menos acoplado al CSP que legacy builders. |
| 3 | Grid validators and repairs | Si | Bajo-Medio | 1.100-1.500 | Muchas funciones puras o deterministas; reduce dependencia previa antes de mover builders. |
| 4 | Answer Pipeline remaining | Si | Medio | 1.300-1.900 | Ya hay frontera y tests; conviene completar antes de mover orquestacion `POST`. |
| 5 | Legacy grid builders | Parcial | Alto | 4.500-5.200 | Mayor reduccion individual, pero debe esperar a que validators/publish/candidates esten fuera. |
| 6 | CSP endpoint integration | Parcial | Medio-Alto | 600-900 | Reutiliza modulos existentes, pero callbacks aun capturan estado de `POST`. |
| 7 | Editorial policies and vocabularies | Parcial | Alto | 700-1.100 | Contiene deuda tematica; no conviene convertirla en arquitectura generica sin fase separada. |
| 8 | Local dictionaries/data loading | Si | Bajo | 250-400 | Facil, pero reduccion pequena; puede entrar junto con policies/support. |
| 9 | `POST` orchestration blocks | Parcial | Alto | 3.000-4.500 | Solo se reduce fuerte cuando los dominios anteriores ya tengan APIs. |
| 10 | HTTP/API boundary | No | Medio | 0-150 | Debe quedar en `route.ts`. |

# Roadmap recomendado

## 1. Extraer OpenAI generation services

- Modulo a crear: `app/lib/generationServices/` o `app/lib/openAiGeneration/`.
- Archivos afectados: `route.ts`, nuevos modulos de servicios OpenAI, tests unitarios/contract existentes.
- Reduccion aproximada: 1.800-2.300 lineas.
- Riesgo: Medio.
- Por que va primero: encapsula efectos externos sin tocar CSP, legacy ni publish; ademas deja prompts/payloads detras de una frontera testeable y libera al `POST` de requests directos.

## 2. Extraer clues and publish pipeline

- Modulo a crear: `app/lib/publicationPipeline/`.
- Archivos afectados: `route.ts`, nuevos modulos de clues, clue repair, publish gates y tests de caracterizacion.
- Reduccion aproximada: 2.000-2.500 lineas.
- Riesgo: Medio.
- Por que va antes que builders: los builders y rescates dependen de validacion publicable y pistas; mover esta frontera primero evita que legacy arrastre funciones de publish de vuelta a `route.ts`.

## 3. Extraer grid validators and repairs

- Modulo a crear: `app/lib/gridPipeline/`.
- Archivos afectados: `route.ts`, nuevos modulos de derivacion de entries, stats, short-runs, connectivity y repairs deterministas.
- Reduccion aproximada: 1.100-1.500 lineas.
- Riesgo: Bajo-Medio.
- Por que va antes que legacy: convierte las dependencias geometricas en API estable; despues los builders pueden moverse como bloque grande con menos acoplamiento.

## 4. Completar Answer Pipeline restante

- Modulo a ampliar: `app/lib/answerPipeline/`.
- Archivos afectados: `route.ts`, modulos existentes de Answer Pipeline.
- Reduccion aproximada: 1.300-1.900 lineas.
- Riesgo: Medio.
- Por que va antes que orquestacion: ya existe avance modular y cobertura; completar candidates/support/top-ups generales deja a `POST` consumiendo un resultado unico para CSP y legacy.

## 5. Encapsular legacy builders como bloque completo

- Modulo a crear: `app/lib/legacyGridPipeline/`.
- Archivos afectados: `route.ts`, nuevos modulos legacy, dependencias ya extraidas de grid/publish/answer.
- Reduccion aproximada: 4.500-5.200 lineas.
- Riesgo: Alto.
- Por que va al final: es la mayor reduccion, pero tambien el bloque con mas reglas geometrico-editoriales y fallbacks; despues de los pasos 1-4 puede moverse casi como una caja negra, manteniendo comportamiento.

## Resultado esperado

| Etapa | Reduccion acumulada aprox. | `route.ts` esperado |
|---|---:|---:|
| Estado actual | 0 | 20.181 |
| Paso 1 | 1.800-2.300 | 17.900-18.400 |
| Paso 2 | 3.800-4.800 | 15.300-16.400 |
| Paso 3 | 4.900-6.300 | 13.800-15.300 |
| Paso 4 | 6.200-8.200 | 12.000-13.900 |
| Paso 5 | 10.700-13.400 | 6.700-9.500 |

Despues de esos cinco pasos, el trabajo restante deberia concentrarse en:

- encapsular la integracion CSP endpoint;
- separar deuda tematica/editorial en policies explicitas;
- reducir `POST` a un orquestador final.

Estimacion final tras completar tambien esos remanentes: `route.ts` de 300-700 lineas.
