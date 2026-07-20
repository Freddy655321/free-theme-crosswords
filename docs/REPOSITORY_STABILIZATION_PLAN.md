# Repository Stabilization Plan

Fecha: 2026-07-20

Repositorio: `C:\Users\feder\free-theme-crosswords`

Esta fase es solo de estabilizacion. No se modifico codigo, no se preparo staging, no se hizo commit, no se llamo OpenAI, no se llamo Supabase y no se ejecuto ningun request de generacion.

Principio obligatorio: el producto debe generar crucigramas para cualquier tema ingresado por el usuario. Megadeth, Taylor Swift, Bariloche, ancient Egypt, space exploration, musica, vino u otros ejemplos son fixtures o casos de QA; no deben convertirse en reglas de produccion.

## A. Resumen ejecutivo

El repositorio esta en un estado de trabajo acumulado valioso pero riesgoso. Hay 5 archivos tracked modificados y 63 archivos untracked antes de crear este documento. No hay archivos tracked eliminados. El diff tracked actual suma aproximadamente 20.577 inserciones y 1.051 eliminaciones; `app/api/generate-crossword/route.ts` concentra casi todo el cambio tracked.

La recomendacion es hacer primero un checkpoint de preservacion, no intentar separar commits finos ahora. El checkpoint deberia incluir el estado funcional acumulado del backend, frontend relacionado, modulos CSP, tests CSP, documentos de auditoria, datos locales necesarios y configuracion/dependencias. Debe excluir logs, salidas compiladas `.tmp-csp-tests`, scripts temporales de diagnostico, smoke tests manuales y archivos sensibles/ignorados.

Hay mezcla de trabajos: integracion CSP, diagnostico CSP, soporte Supabase, cambios UI/preview, datos lexicos, auditorias y logs de desarrollo. Separarlos con hunks antes de preservar tendria riesgo alto de perder coherencia, porque `route.ts` contiene integracion, flags, auditoria, fallback legacy y logica tematica especifica mezclada.

Validacion local no destructiva:

- `npx.cmd tsc --noEmit`: OK.
- ESLint sobre archivos modificados/nuevos de produccion y tests: OK.
- `node --test .tmp-csp-tests/*.test.js`: 81/81 tests OK.

## B. Estado Git exacto

Comandos ejecutados:

```powershell
git branch --show-current
git log -1 --oneline
git status --short
git status --ignored --short
git diff --stat
git diff --numstat
git diff --name-status
git ls-files --others --exclude-standard
git ls-files --modified
git ls-files --deleted
```

Rama actual:

```text
main
```

Ultimo commit:

```text
8a2f0b6 Change normalizeCrossword: across-first + safe downs + stronger theme filter
```

Tracked modificados:

```text
M app/api/generate-crossword/route.ts
M app/generar/page.tsx
M app/jugar/preview/page.tsx
M package-lock.json
M package.json
```

Eliminados tracked:

```text
ninguno
```

Untracked antes de crear este documento: 63 archivos/rutas de Git. Despues de crear este documento, el total pasa a 64.

Ignored relevantes:

```text
.env.local
.next/
.vercel/
next-env.d.ts
node_modules/
tsconfig.tsbuildinfo
```

## C. Metricas del diff

`git diff --stat`:

```text
 app/api/generate-crossword/route.ts | 21295 ++++++++++++++++++++++++++++++++--
 app/generar/page.tsx                |    83 +-
 app/jugar/preview/page.tsx          |   107 +-
 package-lock.json                   |   141 +-
 package.json                        |     2 +
 5 files changed, 20577 insertions(+), 1051 deletions(-)
```

`git diff --numstat`:

| Archivo | Agregadas | Eliminadas |
|---|---:|---:|
| `app/api/generate-crossword/route.ts` | 20.311 | 984 |
| `app/generar/page.tsx` | 52 | 31 |
| `app/jugar/preview/page.tsx` | 73 | 34 |
| `package-lock.json` | 139 | 2 |
| `package.json` | 2 | 0 |

Cinco archivos con mayores cambios tracked:

1. `app/api/generate-crossword/route.ts`
2. `package-lock.json`
3. `app/jugar/preview/page.tsx`
4. `app/generar/page.tsx`
5. `package.json`

Advertencia Git observada: Git aviso que algunos archivos LF seran reemplazados por CRLF cuando Git los toque.

## D. Inventario de archivos cambiados

La tabla clasifica archivos tracked modificados y untracked relevantes. `Necesario compilar/tests/produccion` se basa en imports detectados y en validacion local; no implica que el archivo este listo para produccion.

| Ruta | Estado | Categoria | Tamano/lineas aprox. | Proposito | Importador/ejecutor | Necesario compilar | Necesario tests | Necesario produccion | Generado/datos | Recomendacion | Confianza |
|---|---|---|---:|---|---|---|---|---|---|---|---|
| `app/api/generate-crossword/route.ts` | tracked-modified | A | 804 KB / 20.541 | Endpoint principal, CSP, legacy, OpenAI, Supabase, pistas, diagnostico | Next route | Si | indirecto | Si | no | incluir checkpoint | Alta |
| `app/generar/page.tsx` | tracked-modified | A | 6 KB / 211 | UI de generacion y sessionStorage | Next page | Si | no | Si | no | incluir checkpoint | Alta |
| `app/jugar/preview/page.tsx` | tracked-modified | A/J | 10 KB / 313 | Preview QA/solo lectura | Next page | Si | no | Si/QA | no | incluir checkpoint, luego auditar Bariloche/vino | Alta |
| `package.json` | tracked-modified | D | 771 B / 34 | Dependencias; agrega Supabase/dotenv | npm | Si | Si | Si | no | incluir checkpoint | Alta |
| `package-lock.json` | tracked-modified | D | 255 KB / 7.362 | Lockfile correspondiente | npm | Si | Si | Si | generado por npm | incluir checkpoint | Alta |
| `app/lib/crosswordCsp11.ts` | untracked | A | 71 KB / 2.031 | Solver CSP, perfiles, causalidad | route/CSP modules/tests | Si | Si | candidato | no | incluir checkpoint | Alta |
| `app/lib/crosswordPatterns11.ts` | untracked | A | 11 KB / 363 | Patrones 11x11 y ranking por longitudes | CSP modules/tests | Si | Si | candidato | no | incluir checkpoint | Alta |
| `app/lib/crosswordCspOrchestrator11.ts` | untracked | A | 15 KB / 405 | Orquestador multi-patron | buildCsp/tests | Si | Si | candidato | no | incluir checkpoint | Alta |
| `app/lib/buildCspCrossword11.ts` | untracked | A | 47 KB / 1.138 | Integracion CSP endpoint y diagnostic-only | route/tests | Si | Si | candidato/diagnostic | no | incluir checkpoint | Alta |
| `app/lib/crosswordCspAdapter11.ts` | untracked | A | 3.5 KB / 105 | Adaptador de candidatos CSP | buildCsp/tests | Si | Si | candidato | no | incluir checkpoint | Alta |
| `app/lib/buildCspCandidateReservoir11.ts` | untracked | A | 5.4 KB / 176 | Reservorio tematico CSP separado del pool legacy | route/buildCsp/tests | Si | Si | candidato | no | incluir checkpoint | Alta |
| `app/lib/buildHybridCspCandidateReservoir11.ts` | untracked | A | 5.9 KB / 189 | Reservorio hibrido thematic/support | route/buildCsp/tests | Si | Si | diagnostic | no | incluir checkpoint | Alta |
| `app/lib/analyzeCspCompatibility11.ts` | untracked | A | 6.9 KB / 209 | Compatibilidad por posicion/interseccion | orchestrator/buildCsp/tests | Si | Si | diagnostic | no | incluir checkpoint | Alta |
| `app/lib/crosswordCspTopUp11.ts` | untracked | A | 4.9 KB / 139 | Prompt/parser top-up por longitud | route/buildCsp/tests | Si | Si | experimental | no | incluir checkpoint | Alta |
| `app/lib/crosswordCspConstraintTopUp11.ts` | untracked | A | 9.7 KB / 259 | Prompt/parser top-up por restricciones | route/buildCsp/tests | Si | Si | experimental | no | incluir checkpoint | Alta |
| `app/lib/cspSearchCausality11.ts` | untracked | A/F | 4.7 KB / 125 | Resumen causal de busqueda CSP | solver/tests | Si | Si | diagnostic | no | incluir checkpoint | Alta |
| `app/lib/validateGeneratedCrossword.ts` | untracked | A | 4.1 KB / 102 | Validador frontend/generated payload | generar/preview | Si | no | Si | no | incluir checkpoint | Alta |
| `app/lib/*.test.ts` CSP (11 archivos) | untracked | B | 2-19 KB c/u | Tests unitarios/sinteticos CSP | Node test/tsc | Si por tsc | Si | no | no | incluir checkpoint | Alta |
| `data/common-words-en.txt` | untracked | E | 75 KB / 10.000 | Diccionario local ingles comun | route | Si | Si | support | datos locales | incluir checkpoint si licencia aceptable | Media |
| `data/frequency-en-50k.txt` | untracked | E | 623 KB / 50.000 | Frecuencia ingles | route/hybrid reservoir | Si | Si | support | datos locales | incluir checkpoint si licencia aceptable | Media |
| `data/frequency-es-50k.txt` | untracked | E | 659 KB / 50.000 | Frecuencia espanol | route/hybrid reservoir | Si | Si | support | datos locales | incluir checkpoint si licencia aceptable | Media |
| `data/words-en.txt` | untracked | J/E | 4.2 MB / 370.105 | Vocabulario ingles grande | sin importador detectado | No detectado | no | incierto | datos locales | revisar manualmente antes de incluir | Media |
| `lib/supabaseAdmin.ts` | untracked | A/D | 619 B / 18 | Cliente Supabase server-only | route/ping-supabase | Si | no | Si si persistencia activa | no | incluir checkpoint si Supabase sigue en plan | Media |
| `app/api/ping-env/route.ts` | untracked | I/J | 401 B / 10 | Smoke env booleans | Next route | Si | no | no | no | revisar manualmente/excluir de checkpoint productivo | Media |
| `app/api/ping-supabase/route.ts` | untracked | I/J | 552 B / 16 | Smoke Supabase count | Next route | Si | no | no | no | revisar manualmente/excluir de checkpoint productivo | Media |
| `openai-smoke.js` | untracked | I/L | 378 B / 11 | Smoke manual OpenAI | manual | no | no | no | puede tocar env/API | excluir o revisar manualmente | Alta |
| `docs/ROUTE_TS_MODULARIZATION_AUDIT.md` | untracked | C | 55 KB / 852 | Auditoria route.ts | humano | no | no | no | doc | incluir checkpoint | Alta |
| `docs/REPOSITORY_ARCHITECTURE_AUDIT.md` | untracked | C | 46 KB / 923 | Auditoria repo | humano | no | no | no | doc | incluir checkpoint | Alta |
| `docs/REPOSITORY_STABILIZATION_PLAN.md` | untracked | C | este archivo | Plan fase A | humano | no | no | no | doc | incluir checkpoint | Alta |
| `.tmp-csp-log-summary.ps1` | untracked | F/H | 2.3 KB / 41 | Resumen manual logs CSP | manual | no | no | no | temporal | excluir checkpoint, considerar docs si util | Media |
| `.tmp-csp-manual-diagnostics.ps1` | untracked | F/H | 8.6 KB / 126 | Diagnostico manual CSP | manual | no | no | no | temporal | excluir checkpoint, considerar mover a scripts luego | Media |
| `.tmp-csp-tests/*.js` | untracked | H | 200 KB total aprox. | JS compilado temporal para tests | node --test actual | no fuente | ejecutable temporal | no | generado | excluir checkpoint, regenerar con build/test formal luego | Alta |
| `.next-dev*.log` / `.next-dev*.out.log` | untracked | G/K | 48.7 MB aprox. | Logs dev Next | ninguno | no | no | no | generado/log | excluir checkpoint e ignorar luego | Alta |

## E. Clasificacion por categoria

### A. Codigo de produccion necesario

- `app/api/generate-crossword/route.ts`
- `app/generar/page.tsx`
- `app/jugar/preview/page.tsx`
- `app/lib/crosswordCsp11.ts`
- `app/lib/crosswordPatterns11.ts`
- `app/lib/crosswordCspOrchestrator11.ts`
- `app/lib/crosswordCspAdapter11.ts`
- `app/lib/buildCspCandidateReservoir11.ts`
- `app/lib/buildCspCrossword11.ts`
- `app/lib/buildHybridCspCandidateReservoir11.ts`
- `app/lib/analyzeCspCompatibility11.ts`
- `app/lib/crosswordCspTopUp11.ts`
- `app/lib/crosswordCspConstraintTopUp11.ts`
- `app/lib/cspSearchCausality11.ts`
- `app/lib/validateGeneratedCrossword.ts`
- `lib/supabaseAdmin.ts` si la persistencia Supabase debe mantenerse.

### B. Tests necesarios

- `app/lib/analyzeCspCompatibility11.test.ts`
- `app/lib/buildCspCandidateReservoir11.test.ts`
- `app/lib/buildCspCrossword11.test.ts`
- `app/lib/buildHybridCspCandidateReservoir11.test.ts`
- `app/lib/crosswordCsp11.test.ts`
- `app/lib/crosswordCspAdapter11.test.ts`
- `app/lib/crosswordCspConstraintTopUp11.test.ts`
- `app/lib/crosswordCspOrchestrator11.test.ts`
- `app/lib/crosswordCspTopUp11.test.ts`
- `app/lib/crosswordPatterns11.test.ts`
- `app/lib/cspSearchCausality11.test.ts`

### C. Documentacion necesaria

- `docs/ROUTE_TS_MODULARIZATION_AUDIT.md`
- `docs/REPOSITORY_ARCHITECTURE_AUDIT.md`
- `docs/REPOSITORY_STABILIZATION_PLAN.md`

### D. Configuracion o dependencias necesarias

- `package.json`
- `package-lock.json`

### E. Datos/vocabularios necesarios

- `data/common-words-en.txt`
- `data/frequency-en-50k.txt`
- `data/frequency-es-50k.txt`
- `data/words-en.txt` requiere decision humana: no se detecto importador directo.

### F. Diagnostico temporal potencialmente util

- `.tmp-csp-log-summary.ps1`
- `.tmp-csp-manual-diagnostics.ps1`

### G. Logs generados

- `.next-dev.err.log`
- `.next-dev.out.log`
- `.next-dev-3001.err.log`
- `.next-dev-3001.out.log`
- `.next-dev-3002.err.log`
- `.next-dev-3002.out.log`

### H. Outputs compilados o temporales

- `.tmp-csp-tests/*.js`

### I. Smoke tests o herramientas manuales

- `openai-smoke.js`
- `app/api/ping-env/route.ts`
- `app/api/ping-supabase/route.ts`

### J. Archivos dudosos que requieren decision humana

- `data/words-en.txt`
- `app/api/ping-env/route.ts`
- `app/api/ping-supabase/route.ts`
- `lib/supabaseAdmin.ts` si Supabase no debe entrar aun al checkpoint.

### K. Posibles residuos que no deberian entrar en checkpoint

- Logs `.next-dev*`
- `.tmp-csp-tests/`
- scripts `.tmp-csp-*.ps1`

### L. Posibles secretos o archivos sensibles

- `.env.local` esta ignored. No se abrio ni se expuso su contenido.
- Logs `.next-dev*.err.log` podrian contener prompts, respuestas, errores o trazas. No deberian entrar al checkpoint.
- `openai-smoke.js` no debe entrar si contiene o induce uso manual de `OPENAI_API_KEY`; no se detectaron valores en el nombre, pero requiere revision antes de versionar.

## F. Cambios mezclados

### `app/api/generate-crossword/route.ts`

Grupos mezclados:

- Imports y wiring CSP.
- Cliente Supabase.
- TLS local OpenAI.
- Flags CSP/diagnostic/hybrid.
- Banco OpenAI, validacion tematica y top-ups.
- Reservorio CSP separado.
- Top-ups CSP por longitud y por restricciones.
- Solver/diagnostico CSP integrado.
- Constructor legacy/freeform/pattern/rebuilders.
- Reglas de pistas y publicacion.
- Fallbacks y respuestas HTTP.
- Logica especifica de fixtures/dominios.

Separacion futura: posible, pero no mediante hunks en esta fase. Requiere tests de caracterizacion HTTP antes. Conviene preservarlo entero en un checkpoint inicial.

Riesgo de perdida: alto, porque los modulos CSP untracked son importados por este archivo.

### `package.json` / `package-lock.json`

Cambios: agrega `@supabase/supabase-js` y `dotenv`. Deben viajar juntos. Separarlos del codigo Supabase romperia installs reproducibles.

### `app/generar/page.tsx`

Grupos mezclados:

- UI fija 11x11.
- Uso del validador `generatedCrosswordIssue`.
- sessionStorage/localStorage.
- Textos de sugerencias de prueba.

Debe preservarse para conservar el flujo actual, pero las sugerencias visibles con ejemplos tematicos deben auditarse despues.

### `app/jugar/preview/page.tsx`

Grupos mezclados:

- Preview.
- Validacion del payload generado.
- Anticache especifico Bariloche/vino.

Debe preservarse por ahora, pero el anticache especifico no debe normalizarse como comportamiento definitivo.

### `app/lib/validateGeneratedCrossword.ts`

Validador frontend/backend-adjacent con reglas de publicacion: 11x11, minimo 15 entradas, densidad 0.4, 2 cruces, runs declarados. Debe preservarse, pero luego conviene reconciliarlo con validadores backend.

### Modulos CSP

Estan separados por responsabilidad, pero aun son un lote funcional dependiente:

- `route.ts` importa varios.
- tests TS requieren los archivos fuente.
- `.tmp-csp-tests` contiene JS compilado que no debe versionarse.

Conviene preservar todos los `.ts` y `.test.ts` juntos.

### Vocabularios

`common-words-en`, `frequency-en-50k` y `frequency-es-50k` estan importados por runtime/test. `words-en.txt` parece no importado. Antes de checkpoint definitivo debe decidirse si entra o queda fuera.

### Scripts temporales

`.tmp-csp-log-summary.ps1` y `.tmp-csp-manual-diagnostics.ps1` pueden ser utiles como referencia, pero son temporales. Si se preservan, deberian moverse en una fase futura a `scripts/` con nombre estable; no en esta fase.

## G. Estado de modulos CSP

| Modulo | Estado | Grupo | Importadores | Test asociado | Madurez | Preservar |
|---|---|---|---|---|---|---|
| `app/lib/crosswordCsp11.ts` | untracked | solver core | build/orchestrator/tests/route indirecto | `crosswordCsp11.test.ts` | core/diagnostic | Si |
| `app/lib/crosswordPatterns11.ts` | untracked | patterns | route/build/adapter/orchestrator/tests | `crosswordPatterns11.test.ts` | production-candidate | Si |
| `app/lib/crosswordCspOrchestrator11.ts` | untracked | orchestrator | build/tests | `crosswordCspOrchestrator11.test.ts` | production-candidate | Si |
| `app/lib/crosswordCspAdapter11.ts` | untracked | adapters | build/tests | `crosswordCspAdapter11.test.ts` | production-candidate | Si |
| `app/lib/buildCspCandidateReservoir11.ts` | untracked | reservoirs | route/tests | `buildCspCandidateReservoir11.test.ts` | production-candidate | Si |
| `app/lib/buildHybridCspCandidateReservoir11.ts` | untracked | reservoirs | route/build/tests | `buildHybridCspCandidateReservoir11.test.ts` | diagnostic | Si |
| `app/lib/crosswordCspTopUp11.ts` | untracked | top-ups | route/build/tests | `crosswordCspTopUp11.test.ts` | experimental | Si |
| `app/lib/crosswordCspConstraintTopUp11.ts` | untracked | top-ups | route/build/tests | `crosswordCspConstraintTopUp11.test.ts` | experimental | Si |
| `app/lib/analyzeCspCompatibility11.ts` | untracked | compatibility analysis | orchestrator/build/tests | `analyzeCspCompatibility11.test.ts` | diagnostic | Si |
| `app/lib/cspSearchCausality11.ts` | untracked | diagnostics/profiling | solver/tests | `cspSearchCausality11.test.ts` | diagnostic | Si |
| `app/lib/buildCspCrossword11.ts` | untracked | endpoint integration | route/tests | `buildCspCrossword11.test.ts` | diagnostic/production-candidate | Si |

Cantidad de modulos CSP fuente a preservar: 11.

Cantidad de tests CSP a preservar: 11.

Ningun modulo CSP fuente necesario debe quedar fuera del checkpoint si se preserva la integracion actual de `route.ts`.

## H. Logica especifica de fixtures detectada

No se corrigio nada. Estos son candidatos de logica especifica dentro de produccion o UI productiva/QA.

| Archivo | Simbolo/rango | Tema/dominio | Tipo | Caller/activacion | Estado | Riesgo | Recomendacion futura |
|---|---|---|---|---|---|---|---|
| `app/api/generate-crossword/route.ts` | `clueMislabelsKnownPartialTitle`, lineas ~666-691 | Megadeth | filtro/pista | validacion pista | activo | Medio | mover a tests o neutralizar |
| `app/api/generate-crossword/route.ts` | `fallbackClueForPublishRepair`, lineas ~827-1237 | Megadeth/musica | fallback/overrides | repair pistas | activo | Alto | auditoria tematica especifica |
| `app/api/generate-crossword/route.ts` | `WINE_DOMAIN_ANSWERS`, lineas ~1375-1395 | vino | lista especial | `isUnsupportedDomainAnswerForTheme` | activo | Alto | eliminar/generalizar |
| `app/api/generate-crossword/route.ts` | `BARILOCHE_OFF_THEME_ANSWERS`, lineas ~1409-1415 | Bariloche | filtro especial | `isUnsupportedDomainAnswerForTheme` | activo | Alto | mover a fixture/test |
| `app/api/generate-crossword/route.ts` | `isDomainContextSupported`, lineas ~1416-1432 | vino/comida | soporte local | filtros | activo | Medio | generalizar via evidencia semantica |
| `app/api/generate-crossword/route.ts` | `isOverGenericThemeWordForTheme`, lineas ~2477-2555 | vino/Bariloche/Megadeth/Metallica | filtro especial | sanitizacion/validacion | activo | Critico | neutralizacion posterior |
| `app/api/generate-crossword/route.ts` | `specificThematicFallbackClue`, lineas ~3053-3564 | Bariloche/vino/Megadeth/Metallica | pistas hardcodeadas | repair/pistas | activo parcial | Critico | sacar de produccion |
| `app/api/generate-crossword/route.ts` | `clueFromThemeNote`, lineas ~3648-3782 | vino/Argentina/musica | pista por dominio | repair/pistas | activo | Alto | generalizar |
| `app/api/generate-crossword/route.ts` | `generateSupportWords`/`inferLocalSupportWords`, lineas ~4261-4722 | musica, Bariloche, Megadeth, Metallica, vino | soporte local | answer bank | activo | Critico | separar support universal de fixtures |
| `app/api/generate-crossword/route.ts` | prompt de pistas, lineas ~8668-8679 | Megadeth ejemplos | prompt leakage | OpenAI clues | activo | Alto | reemplazar ejemplos especificos por genericos |
| `app/api/generate-crossword/route.ts` | fallback demo, lineas ~12529-12578 | musica/rock/band | fallback grilla/pistas | POST error/fallback | activo segun camino | Critico | eliminar en fase dedicada |
| `app/jugar/preview/page.tsx` | `wineAnswers`, `barilocheWineCache`, lineas ~52-74 | Bariloche/vino | anticache especifico | preview | activo | Alto | reemplazar por invalidacion generica |
| `app/generar/page.tsx` | sugerencias lineas ~198-203 | Argentina/Metallica/Energias | ejemplos UI | visible | activo | Bajo/medio | mantener como ejemplos o rotar genericos |

Fixtures legitimos en tests:

- `app/lib/buildCspCandidateReservoir11.test.ts` usa `space exploration` como fixture. No es produccion.
- Tests CSP comprueban ausencia de `megadeth|taylor swift|bariloche` en prompts. Correcto como proteccion.

Cantidad de candidatos de logica especifica en produccion/UI: 13.

## I. Archivos sensibles

Busqueda por nombres/estado:

- `.env.local`: ignored, 630 bytes. No se abrio ni se mostro contenido. Riesgo alto si se agrega accidentalmente.
- `.next-dev*.err.log` y `.next-dev*.out.log`: untracked, ~48.7 MB. Podrian contener prompts, respuestas, stack traces o diagnosticos. No deben entrar al checkpoint.
- `openai-smoke.js`: untracked. No se debe ejecutar ni incluir sin revision humana.
- `lib/supabaseAdmin.ts`: no contiene secretos por nombre; lee `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` desde env.
- `app/api/ping-env/route.ts`: expone solo booleanos de env; aun asi es development-only y requiere decision humana antes de versionar.

No se revelaron valores sensibles.

## J. Resultados de validacion

Comandos ejecutados:

```powershell
npx.cmd tsc --noEmit
```

Resultado: OK.

```powershell
npx.cmd eslint app/api/generate-crossword/route.ts app/generar/page.tsx app/jugar/preview/page.tsx app/lib/analyzeCspCompatibility11.ts app/lib/analyzeCspCompatibility11.test.ts app/lib/buildCspCandidateReservoir11.ts app/lib/buildCspCandidateReservoir11.test.ts app/lib/buildCspCrossword11.ts app/lib/buildCspCrossword11.test.ts app/lib/buildHybridCspCandidateReservoir11.ts app/lib/buildHybridCspCandidateReservoir11.test.ts app/lib/crosswordCsp11.ts app/lib/crosswordCsp11.test.ts app/lib/crosswordCspAdapter11.ts app/lib/crosswordCspAdapter11.test.ts app/lib/crosswordCspConstraintTopUp11.ts app/lib/crosswordCspConstraintTopUp11.test.ts app/lib/crosswordCspOrchestrator11.ts app/lib/crosswordCspOrchestrator11.test.ts app/lib/crosswordCspTopUp11.ts app/lib/crosswordCspTopUp11.test.ts app/lib/crosswordPatterns11.ts app/lib/crosswordPatterns11.test.ts app/lib/cspSearchCausality11.ts app/lib/cspSearchCausality11.test.ts app/lib/validateGeneratedCrossword.ts lib/supabaseAdmin.ts app/api/ping-env/route.ts app/api/ping-supabase/route.ts
```

Resultado: OK.

```powershell
node --test .tmp-csp-tests/*.test.js
```

Resultado: 81 tests, 81 pass, 0 fail.

Nota: el comando de tests usa JS temporal en `.tmp-csp-tests`. Esa carpeta sirve para validar el estado actual, pero no deberia entrar al checkpoint.

## K. Estrategia recomendada de checkpoint

Recomendacion: un unico checkpoint de preservacion grande, luego commits logicos futuros.

Motivo:

- `route.ts` ya mezcla integracion CSP, diagnostics, legacy, pistas y reglas especificas.
- Los modulos CSP untracked estan conectados con imports reales desde `route.ts`.
- Separar hunks ahora seria manual y riesgoso.
- La prioridad es no perder trabajo y congelar una base verde.

Mensaje sugerido para checkpoint:

```text
Checkpoint CSP integration and repository audits
```

Verificacion sugerida antes de ejecutar un futuro commit:

```powershell
git status --short
npx.cmd tsc --noEmit
npx.cmd eslint app/api/generate-crossword/route.ts app/generar/page.tsx app/jugar/preview/page.tsx app/lib/analyzeCspCompatibility11.ts app/lib/analyzeCspCompatibility11.test.ts app/lib/buildCspCandidateReservoir11.ts app/lib/buildCspCandidateReservoir11.test.ts app/lib/buildCspCrossword11.ts app/lib/buildCspCrossword11.test.ts app/lib/buildHybridCspCandidateReservoir11.ts app/lib/buildHybridCspCandidateReservoir11.test.ts app/lib/crosswordCsp11.ts app/lib/crosswordCsp11.test.ts app/lib/crosswordCspAdapter11.ts app/lib/crosswordCspAdapter11.test.ts app/lib/crosswordCspConstraintTopUp11.ts app/lib/crosswordCspConstraintTopUp11.test.ts app/lib/crosswordCspOrchestrator11.ts app/lib/crosswordCspOrchestrator11.test.ts app/lib/crosswordCspTopUp11.ts app/lib/crosswordCspTopUp11.test.ts app/lib/crosswordPatterns11.ts app/lib/crosswordPatterns11.test.ts app/lib/cspSearchCausality11.ts app/lib/cspSearchCausality11.test.ts app/lib/validateGeneratedCrossword.ts lib/supabaseAdmin.ts app/api/ping-env/route.ts app/api/ping-supabase/route.ts
node --test .tmp-csp-tests/*.test.js
git diff --stat
```

Procedimiento futuro propuesto, no ejecutado:

```powershell
git add app/api/generate-crossword/route.ts app/generar/page.tsx app/jugar/preview/page.tsx package.json package-lock.json
git add app/lib/*Csp*.ts app/lib/*Csp*.test.ts app/lib/*csp*.ts app/lib/*csp*.test.ts app/lib/crosswordPatterns11.ts app/lib/crosswordPatterns11.test.ts app/lib/analyzeCspCompatibility11.ts app/lib/analyzeCspCompatibility11.test.ts app/lib/buildHybridCspCandidateReservoir11.ts app/lib/buildHybridCspCandidateReservoir11.test.ts app/lib/validateGeneratedCrossword.ts
git add docs/ROUTE_TS_MODULARIZATION_AUDIT.md docs/REPOSITORY_ARCHITECTURE_AUDIT.md docs/REPOSITORY_STABILIZATION_PLAN.md
git add data/common-words-en.txt data/frequency-en-50k.txt data/frequency-es-50k.txt
git add lib/supabaseAdmin.ts
git commit -m "Checkpoint CSP integration and repository audits"
```

No se ejecuto ninguno de esos comandos.

## L. Lista exacta propuesta para incluir

Incluir en el checkpoint de preservacion:

```text
app/api/generate-crossword/route.ts
app/generar/page.tsx
app/jugar/preview/page.tsx
package.json
package-lock.json
app/lib/analyzeCspCompatibility11.test.ts
app/lib/analyzeCspCompatibility11.ts
app/lib/buildCspCandidateReservoir11.test.ts
app/lib/buildCspCandidateReservoir11.ts
app/lib/buildCspCrossword11.test.ts
app/lib/buildCspCrossword11.ts
app/lib/buildHybridCspCandidateReservoir11.test.ts
app/lib/buildHybridCspCandidateReservoir11.ts
app/lib/crosswordCsp11.test.ts
app/lib/crosswordCsp11.ts
app/lib/crosswordCspAdapter11.test.ts
app/lib/crosswordCspAdapter11.ts
app/lib/crosswordCspConstraintTopUp11.test.ts
app/lib/crosswordCspConstraintTopUp11.ts
app/lib/crosswordCspOrchestrator11.test.ts
app/lib/crosswordCspOrchestrator11.ts
app/lib/crosswordCspTopUp11.test.ts
app/lib/crosswordCspTopUp11.ts
app/lib/crosswordPatterns11.test.ts
app/lib/crosswordPatterns11.ts
app/lib/cspSearchCausality11.test.ts
app/lib/cspSearchCausality11.ts
app/lib/validateGeneratedCrossword.ts
data/common-words-en.txt
data/frequency-en-50k.txt
data/frequency-es-50k.txt
docs/ROUTE_TS_MODULARIZATION_AUDIT.md
docs/REPOSITORY_ARCHITECTURE_AUDIT.md
docs/REPOSITORY_STABILIZATION_PLAN.md
lib/supabaseAdmin.ts
```

Incluir solo con decision humana:

```text
data/words-en.txt
app/api/ping-env/route.ts
app/api/ping-supabase/route.ts
```

## M. Lista exacta propuesta para excluir

Excluir del checkpoint:

```text
.next-dev-3001.err.log
.next-dev-3001.out.log
.next-dev-3002.err.log
.next-dev-3002.out.log
.next-dev.err.log
.next-dev.out.log
.tmp-csp-log-summary.ps1
.tmp-csp-manual-diagnostics.ps1
.tmp-csp-tests/analyzeCspCompatibility11.js
.tmp-csp-tests/analyzeCspCompatibility11.test.js
.tmp-csp-tests/buildCspCandidateReservoir11.js
.tmp-csp-tests/buildCspCandidateReservoir11.test.js
.tmp-csp-tests/buildCspCrossword11.js
.tmp-csp-tests/buildCspCrossword11.test.js
.tmp-csp-tests/buildHybridCspCandidateReservoir11.js
.tmp-csp-tests/buildHybridCspCandidateReservoir11.test.js
.tmp-csp-tests/crosswordCsp11.js
.tmp-csp-tests/crosswordCsp11.test.js
.tmp-csp-tests/crosswordCspAdapter11.js
.tmp-csp-tests/crosswordCspAdapter11.test.js
.tmp-csp-tests/crosswordCspConstraintTopUp11.js
.tmp-csp-tests/crosswordCspConstraintTopUp11.test.js
.tmp-csp-tests/crosswordCspOrchestrator11.js
.tmp-csp-tests/crosswordCspOrchestrator11.test.js
.tmp-csp-tests/crosswordCspTopUp11.js
.tmp-csp-tests/crosswordCspTopUp11.test.js
.tmp-csp-tests/crosswordPatterns11.js
.tmp-csp-tests/crosswordPatterns11.test.js
.tmp-csp-tests/cspSearchCausality11.js
.tmp-csp-tests/cspSearchCausality11.test.js
openai-smoke.js
```

Tambien excluir siempre:

```text
.env.local
.next/
.vercel/
node_modules/
tsconfig.tsbuildinfo
next-env.d.ts
```

Los ultimos ya estan ignored.

## N. Archivos que requieren decision humana

1. `data/words-en.txt`
   - Motivo: muy grande, sin importador detectado, origen/licencia no documentado.
   - Decision: incluir si se decide que sera fuente lexica real; excluir si fue descarga exploratoria.

2. `app/api/ping-env/route.ts`
   - Motivo: endpoint development-only que expone booleanos de env.
   - Decision: incluir solo si se quiere smoke endpoint versionado; si no, excluir.

3. `app/api/ping-supabase/route.ts`
   - Motivo: endpoint development-only que llama Supabase.
   - Decision: incluir solo si se quiere smoke endpoint versionado; si no, excluir.

4. `lib/supabaseAdmin.ts`
   - Motivo: importado por `route.ts`; si el checkpoint incluye `route.ts`, probablemente debe incluirse.
   - Decision: confirmar que Supabase pertenece al estado a preservar.

5. `.tmp-csp-*.ps1`
   - Motivo: utiles manualmente, pero temporales.
   - Decision: excluir ahora; si hacen falta, mover a `scripts/` en otra fase.

## O. Comandos futuros propuestos, pero no ejecutados

Para ignorar logs/temporales en una fase posterior:

```powershell
# No ejecutado
# editar .gitignore para agregar:
# .next-dev*.log
# .next-dev*.out.log
# .tmp-csp-tests/
# .tmp-csp-*.ps1
```

Para preparar checkpoint en una fase posterior:

```powershell
# No ejecutado
git add <lista revisada de archivos a incluir>
git status --short
npx.cmd tsc --noEmit
node --test .tmp-csp-tests/*.test.js
git commit -m "Checkpoint CSP integration and repository audits"
```

Para separar commits logicos despues del checkpoint:

```powershell
# No ejecutado
git switch -c refactor/characterization-tests
```

## P. Riesgos y rollback

Riesgos:

1. `route.ts` gigante y mezclado.
   - Riesgo: perdida de trabajo si se intenta particionar antes de checkpoint.
   - Mitigacion: checkpoint de preservacion primero.

2. Modulos CSP untracked.
   - Riesgo: `route.ts` modificado importa archivos que Git no preservaria.
   - Mitigacion: incluir todos los modulos CSP fuente y tests juntos.

3. Logs enormes untracked.
   - Riesgo: commit accidental pesado y posible contenido sensible.
   - Mitigacion: excluir ahora; ignorar en fase posterior.

4. Datos lexicos sin procedencia.
   - Riesgo: licencia/procedencia desconocida.
   - Mitigacion: decision humana antes de incluir `words-en.txt`; documentar origen de todos.

5. Lógica especifica de fixtures en produccion.
   - Riesgo: violar principio multitema.
   - Mitigacion: no corregir en checkpoint; abrir auditoria/neutralizacion separada.

6. Smoke endpoints y smoke scripts.
   - Riesgo: exponer entorno o inducir llamadas externas.
   - Mitigacion: excluir o revisar manualmente.

Rollback futuro recomendado:

- Si se hace un checkpoint unico, rollback es revertir ese commit completo o crear una rama antes de cambios siguientes.
- Para refactors posteriores, cada fase debe tener su propio commit pequeno con `tsc`, ESLint y tests.
- No usar `git reset --hard` ni `git clean` sin confirmacion explicita, por el volumen de untracked valioso.

## Q. Criterio para considerar estabilizado el repositorio

El repositorio puede considerarse estabilizado cuando:

- Existe un checkpoint Git que preserva `route.ts`, frontend relacionado, modulos CSP, tests CSP, docs, deps y datos elegidos.
- Logs, compilados temporales y scripts temporales quedan fuera del checkpoint.
- `.env.local` y cualquier secreto permanecen ignored y sin staging.
- `git status --short` despues del checkpoint muestra solo residuos intencionalmente excluidos.
- `npx.cmd tsc --noEmit` pasa.
- ESLint sobre archivos preservados pasa.
- Suite CSP local pasa.
- Se documenta que la logica especifica de fixtures sigue pendiente y no se confunde con arquitectura objetivo.
- Queda definida la siguiente fase: tests de caracterizacion HTTP antes de modularizar.
