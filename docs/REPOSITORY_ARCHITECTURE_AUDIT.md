# Auditoria arquitectonica completa del repositorio

Fecha: 2026-07-20.

Repositorio auditado: `C:\Users\feder\free-theme-crosswords`.

Principio rector: el producto debe generar crucigramas para cualquier tema ingresado por el usuario. Los temas usados en QA, como Megadeth, Taylor Swift, Bariloche, ancient Egypt o space exploration, no deben transformarse en reglas, vocabularios, excepciones, prompts, categorias privilegiadas ni heuristicas de produccion.

## A. Resumen ejecutivo

El repositorio es una aplicacion Next.js App Router con un backend de generacion concentrado casi por completo en `app/api/generate-crossword/route.ts`. El archivo tiene 20.541 lineas, `POST` ocupa 7.953 lineas y convive con aproximadamente 24 constructores, rebuilders, densifiers, proposal paths y fallbacks.

Durante las fases anteriores se agrego una capa CSP 11x11 modular en `app/lib`, con tests unitarios y diagnosticos. Esa capa ya es relativamente coherente, pero todavia depende de `route.ts` para integracion con OpenAI, validacion tematica, top-ups aceptados, mutacion de sets de publicacion y respuesta HTTP diagnostic-only.

El frontend real actual es pequeno: `/generar` llama a `/api/generate-crossword`, valida la respuesta con `generatedCrosswordIssue`, guarda en `sessionStorage`, y `/jugar/preview` y `/jugar/pro` leen ese payload. La persistencia principal del puzzle generado hoy es el navegador (`sessionStorage`/`localStorage`), no Supabase.

Supabase existe como cliente server-only y se usa en `route.ts` como smoke check no fatal y en un endpoint `ping-supabase`. No hay evidencia local de que una generacion se inserte o persista en tablas.

La deuda tecnica principal no es solo el tamano de `route.ts`: tambien hay multiples modelos de tipos de puzzle, validadores duplicados, semanticas distintas de cruces/runs, componentes frontend aparentemente obsoletos, logs y temporales grandes sin ignorar, tests CSP buenos pero poca caracterizacion HTTP, y un worktree muy sucio con muchos archivos nuevos sin trackear.

## B. Alcance y metodologia

Comandos de lectura/validacion usados:

- `git status --short`
- `git status --short --ignored`
- `git branch --show-current`
- `git log -1 --oneline`
- `git diff --stat`
- `git ls-files`
- `rg --files` con exclusiones de `node_modules`, `.git`, `.next` y `.tmp-csp-tests`
- busquedas `rg` para imports, env vars, OpenAI, Supabase, storage, tests y constructores
- lectura de archivos clave con `Get-Content`
- `npx.cmd tsc --noEmit`

No se ejecuto OpenAI, Supabase, endpoint de generacion ni servidor. No se modifico codigo, prompts, flags, patrones, tests ni configuracion.

## C. Arbol del repositorio

Vista compacta actual, excluyendo detalle interno de `node_modules`, `.git`, `.next` y `.tmp-csp-tests`:

```text
.
  app/
    api/
      generate-crossword/route.ts
      ping/route.ts
      ping-env/route.ts
      ping-supabase/route.ts
    components/
      AdSlot.tsx
      AppShell.tsx
      BundleClient.tsx
      ClueList.tsx
      Consent.tsx
      EditableGrid.tsx
      GridNumbered.tsx
      HouseAd.tsx
      PuzzlePreview.tsx
      StickyAd.tsx
      ThemeGenerator.tsx
      ThemeToggle.tsx
    debug/ads/page.tsx
    generar/page.tsx
    jugar/
      ahora/page.tsx
      preview/page.tsx
      pro/page.tsx
    lib/
      analyzeCspCompatibility11.ts
      buildCspCandidateReservoir11.ts
      buildCspCrossword11.ts
      buildHybridCspCandidateReservoir11.ts
      crosswordCsp11.ts
      crosswordCspAdapter11.ts
      crosswordCspConstraintTopUp11.ts
      crosswordCspOrchestrator11.ts
      crosswordCspTopUp11.ts
      crosswordPatterns11.ts
      cspSearchCausality11.ts
      validateGeneratedCrossword.ts
      plus legacy libs: schema, crosswordSchema, normalizePuzzle, numbering, quickplay, validateCrossword
    store/crosswordStore.ts
    layout.tsx
    page.tsx
    globals.css
  components/ThemeToggle.tsx
  data/
    common-words-en.txt
    frequency-en-50k.txt
    frequency-es-50k.txt
    words-en.txt
    crosswords_progress_*.json
  docs/
    ROUTE_TS_MODULARIZATION_AUDIT.md
    REPOSITORY_ARCHITECTURE_AUDIT.md
  lib/
    crossword.ts
    supabaseAdmin.ts
  public/
    crosswords.bundle
    *.svg
  types/puzzle.ts
  package.json
  tsconfig.json
  eslint.config.mjs
  next.config.ts
  tailwind.config.ts
  postcss.config.js
  postcss.config.mjs
  openai-smoke.js
```

Residuos relevantes:

- `.next-dev-3002.err.log`: 45.817.605 bytes.
- `.next-dev-3001.err.log`: 1.818.334 bytes.
- `.next-dev.err.log`: 1.111.778 bytes.
- `.tmp-csp-tests/`: compilacion temporal de tests CSP.
- `.tmp-csp-log-summary.ps1` y `.tmp-csp-manual-diagnostics.ps1`: scripts diagnosticos temporales.
- `tsconfig.tsbuildinfo`: ignorado.
- `.env.local`: ignorado, no leido en detalle ni expuesto.

## D. Estado Git

Rama actual: `main`.

Ultimo commit: `8a2f0b6 Change normalizeCrossword: across-first + safe downs + stronger theme filter`.

Tracked modificados:

- `app/api/generate-crossword/route.ts`
- `app/generar/page.tsx`
- `app/jugar/preview/page.tsx`
- `package-lock.json`
- `package.json`

Untracked relevantes:

- Modulos CSP y tests en `app/lib/*Csp*.ts`, `app/lib/*Csp*.test.ts`, `analyzeCspCompatibility11*`, `buildCspCrossword11*`, `buildHybridCspCandidateReservoir11*`, `cspSearchCausality11*`.
- `app/lib/validateGeneratedCrossword.ts`.
- `lib/supabaseAdmin.ts`.
- `app/api/ping-env/`, `app/api/ping-supabase/`.
- `data/common-words-en.txt`, `data/frequency-en-50k.txt`, `data/frequency-es-50k.txt`, `data/words-en.txt`.
- `docs/`.
- Logs `.next-dev*.log`.
- Scripts temporales `.tmp-csp-*.ps1`.

Ignored relevantes:

- `.env.local`
- `.next/`
- `.vercel/`
- `node_modules/`
- `next-env.d.ts`
- `tsconfig.tsbuildinfo`

Diff tracked aproximado: 20.577 inserciones, 1.051 eliminaciones en 5 archivos. El mayor cambio tracked es `route.ts`.

Riesgo: alto. Cualquier refactor con este worktree puede mezclar trabajo arquitectonico, diagnostico CSP, UI y dependencias en un mismo diff. Antes de mover codigo conviene crear checkpoints separados.

## E. Metricas globales

| Metrica | Valor |
|---|---:|
| Archivos no ignorados detectados por `rg --files` | 84 |
| Archivos relevantes auditados, excluyendo logs/binarios/lock | 76 |
| TypeScript/TSX/JS auditados | 63 |
| TypeScript/TSX | 60 |
| Tests `.test.ts` | 11 |
| Tests declarados con `test(...)` | 81 |
| Entry points aproximados | 18 |
| Feature flags/env vars de generacion | 25 lecturas aprox.; 22 en `route.ts`, mas `CROSSWORD_CSP_11_ENABLED` en `buildCspCrossword11.ts`, Supabase env y smoke |
| Constructores/rebuilders/proposals detectados | 24 |
| Ciclos static imports detectados | 0 |
| Archivos sin importadores estaticos detectables | 47, muchos son pages/routes/tests/config |
| `route.ts` | 20.541 lineas |
| `POST` | 7.953 lineas |

## F. Resumen por carpeta

### `app/`

Responsabilidad: App Router, frontend, API routes, store cliente y libs internas. Mezcla capas: UI, backend server, CSP solver, validadores y estado cliente viven bajo `app/`.

Dependencias externas: Next.js, React, Zustand, OpenAI en API, Supabase en API.

Problemas: `app/lib` contiene tanto librerias frontend (`quickplay`, `validateGeneratedCrossword`) como CSP backend-like y tests. `app/api/generate-crossword/route.ts` concentra backend.

### `app/api/`

Responsabilidad: route handlers. Endpoints:

- `/api/generate-crossword`: POST generacion real.
- `/api/ping`: GET smoke local.
- `/api/ping-env`: GET expone booleanos de env; untracked.
- `/api/ping-supabase`: GET cuenta tabla `crosswords`; untracked.

Mezcla: `generate-crossword` hace todo el pipeline. Los ping endpoints son development-only y deberian aislarse/documentarse.

### `app/lib/`

Responsabilidad actual mixta:

- CSP 11x11 modular y tests.
- Validadores frontend/backend.
- Schemas viejos.
- Helpers quickplay.

Capa clara parcial: los modulos CSP forman una subcapa coherente, pero no estan dentro de una carpeta `csp/`.

### `lib/`

Responsabilidad: tipos/guards legacy de crossword y cliente Supabase server-only.

Problema: `lib/crossword.ts` define otro modelo `Crossword` distinto al de `route.ts` y al store. `lib/supabaseAdmin.ts` es efecto externo server-only.

### `data/`

Responsabilidad: diccionarios y fixtures JSON antiguos.

Problemas: los archivos grandes de frecuencia son untracked, sin procedencia/licencia documentada. `words-en.txt` tiene 370.105 lineas y no se encontro consumo directo.

### `docs/`

Responsabilidad: auditorias. `ROUTE_TS_MODULARIZATION_AUDIT.md` existe; este documento agrega auditoria global.

### `public/`

Responsabilidad: assets publicos, bundle descargable y SVGs. `crosswords.bundle` parece consumido por `BundleClient`, pero ese componente no tiene importadores actuales detectados.

### `components/`

Contiene `components/ThemeToggle.tsx`, duplicado conceptual de `app/components/ThemeToggle.tsx`. No tiene importadores detectados.

### `scripts/`

Existe carpeta en filesystem, pero no aparecio con archivos relevantes por `rg --files`. Debe confirmarse antes de asumir uso.

## G. Inventario de archivos

| Ruta | Cat. | Git | Lineas | Proposito | Estado estimado |
|---|---|---|---:|---|---|
| `app/api/generate-crossword/route.ts` | source | tracked-modified | 20541 | Endpoint principal generacion | production-core + experimental + legacy |
| `app/api/ping/route.ts` | source | tracked-clean | 9 | Smoke endpoint | development-support |
| `app/api/ping-env/route.ts` | source | untracked | 12 | Smoke env booleans | development-only |
| `app/api/ping-supabase/route.ts` | source | untracked | 20 | Smoke Supabase count | development-only |
| `app/generar/page.tsx` | source | tracked-modified | 211 | UI generacion real | production-core |
| `app/jugar/preview/page.tsx` | source | tracked-modified | 313 | Preview QA | production-support/QA |
| `app/jugar/pro/page.tsx` | source | tracked-clean | 542 | Juego interactivo desde sessionStorage | production-core |
| `app/jugar/ahora/page.tsx` | source | tracked-clean | 142 | Quickplay legacy localStorage | legacy |
| `app/page.tsx` | source | tracked-clean | 15 | Home simple | production-support |
| `app/layout.tsx` | source | tracked-clean | 25 | Root layout | production-core |
| `app/debug/ads/page.tsx` | source | tracked-clean | 29 | Debug ads | development-only |
| `app/components/*.tsx` | source | mixed | 8-391 | UI components varios | mixed; varios apparently-unused |
| `app/store/crosswordStore.ts` | source | tracked-clean | 284 | Zustand puzzle legacy | legacy/support |
| `app/lib/crosswordCsp11.ts` | source | untracked | 2031 | Solver CSP y diagnostico | production-candidate/diagnostic |
| `app/lib/crosswordPatterns11.ts` | source | untracked | 363 | Patrones CSP | production-candidate |
| `app/lib/crosswordCspOrchestrator11.ts` | source | untracked | 405 | Ranking/solver multi-pattern | production-candidate |
| `app/lib/buildCspCrossword11.ts` | source | untracked | 1138 | Integracion CSP endpoint | diagnostic/production-candidate |
| `app/lib/*Csp*TopUp11.ts` | source | untracked | 139-259 | Prompts/parsers top-up CSP | experimental |
| `app/lib/analyzeCspCompatibility11.ts` | source | untracked | 209 | Compatibilidad de reservorio | diagnostic |
| `app/lib/buildCspCandidateReservoir11.ts` | source | untracked | 176 | Reservorio tematico CSP | production-candidate |
| `app/lib/buildHybridCspCandidateReservoir11.ts` | source | untracked | 189 | Reservorio hybrid | diagnostic |
| `app/lib/cspSearchCausality11.ts` | source | untracked | 125 | Resumen causal busqueda | diagnostic |
| `app/lib/*.test.ts` CSP | test | untracked | 47-560 | Suite CSP | test-only |
| `app/lib/validateGeneratedCrossword.ts` | source | untracked | 102 | Validador frontend generado | production-support |
| `app/lib/crosswordSchema.ts` | source | tracked-clean | 35 | Schema legacy payload | legacy |
| `app/lib/schema.ts` | source | tracked-clean | 61 | Zod schemas quickplay | legacy |
| `app/lib/validateCrossword.ts` | source | tracked-clean | 56 | Validador legacy schema | legacy |
| `app/lib/quickplay.ts` | source | tracked-clean | 26 | LocalStorage quickplay | legacy |
| `app/lib/normalizePuzzle.ts` | source | tracked-clean | 38 | Normalizacion puzzle legacy | apparently-unused |
| `app/lib/numbering.ts` | source | tracked-clean | 44 | Numeracion legacy | apparently-unused |
| `lib/crossword.ts` | source | tracked-clean | 114 | Type guards para Pro page | production-support |
| `lib/supabaseAdmin.ts` | source | untracked | 20 | Cliente Supabase server-only | production-support/dev |
| `types/puzzle.ts` | source | tracked-clean | 34 | Modelo puzzle Zustand | legacy/support |
| `data/*.txt` | data | untracked | 10k-370k | Diccionarios/frecuencias | support/unknown provenance |
| `data/crosswords_progress_*.json` | data | tracked-clean | 13-70 | Fixtures/demo progress | test/demo |
| `docs/ROUTE_TS_MODULARIZATION_AUDIT.md` | documentation | untracked | 852 | Auditoria route.ts | documentation |
| `docs/REPOSITORY_ARCHITECTURE_AUDIT.md` | documentation | untracked | este archivo | Auditoria repo | documentation |
| `public/crosswords.bundle` | generated/data | tracked-clean | 503 | Bundle publico | unknown/legacy |
| `public/*.svg` | asset | tracked-clean | 1 | Assets Next default | production-support |
| `package.json` | config | tracked-modified | 34 | Scripts/deps | production-config |
| `package-lock.json` | config | tracked-modified | 7362 | Lockfile | production-config |
| `tsconfig.json` | config | tracked-clean | 46 | TS config | production-config |
| `eslint.config.mjs` | config | tracked-clean | 25 | ESLint flat config | production-config |
| `next.config.ts` | config | tracked-clean | 7 | Next config vacia | production-config |
| `tailwind.config.ts` | config | tracked-clean | 7 | Tailwind paths | production-config |
| `postcss.config.js` / `.mjs` | config | tracked-clean | 6/10 | Duplicado PostCSS | production-config risk |
| `openai-smoke.js` | script | untracked | 13 | Smoke OpenAI manual | development-only |
| `.tmp-csp-*.ps1` | script | untracked | 41/131 | Diagnostico manual CSP | temporary |
| `.next-dev*.log` | log | untracked | varios | Logs dev grandes | temporary/log |

## H. Puntos de entrada

| Entrada | Tipo | Inputs | Outputs | Efectos externos | Estado |
|---|---|---|---|---|---|
| `app/api/generate-crossword/route.ts#POST` | API | JSON `{theme, language, size}` | JSON crossword o error | OpenAI, Supabase smoke, logs | principal |
| `app/api/ping/route.ts#GET` | API | ninguno | `{ok, where}` | ninguno | dev/support |
| `app/api/ping-env/route.ts#GET` | API | ninguno | booleans env | lee env | dev-only |
| `app/api/ping-supabase/route.ts#GET` | API | ninguno | count o error | Supabase select | dev-only |
| `app/page.tsx` | page | URL `/` | links | ninguno | principal simple |
| `app/generar/page.tsx` | page client | usuario tema/idioma | fetch endpoint + sessionStorage | HTTP `/api/generate-crossword` | principal |
| `app/jugar/preview/page.tsx` | page client | query + sessionStorage | preview QA | local/sessionStorage | principal QA |
| `app/jugar/pro/page.tsx` | page client | sessionStorage | juego interactivo | localStorage progress | principal juego |
| `app/jugar/ahora/page.tsx` | page client | localStorage `xw:quickplay` | juego simple | localStorage | legacy |
| `app/debug/ads/page.tsx` | page | URL | debug ads | NODE_ENV render | dev |
| `app/politica-cookies/page.tsx` | page | URL | static policy | ninguno | support |
| `app/layout.tsx` | layout | children | HTML shell | metadata | principal |
| `openai-smoke.js` | script | env `OPENAI_API_KEY` | console | OpenAI | manual/dev |
| `package.json` scripts | npm | CLI | dev/build/start/lint | Next/ESLint | tooling |

`ThemeGenerator.tsx` seria entry UI si se importara, pero no tiene importadores detectados y llama `/api/generate`, endpoint que no existe en el inventario.

## I. Grafo de imports

Static imports internos detectados: 60 edges sobre 63 archivos TS/TSX/JS no ignorados.

Fan-in mas alto:

| Archivo | Fan-in |
|---|---:|
| `app/lib/crosswordCsp11.ts` | 12 |
| `app/lib/crosswordPatterns11.ts` | 10 |
| `app/lib/crosswordCspAdapter11.ts` | 5 |
| `types/puzzle.ts` | 4 |
| `app/lib/buildHybridCspCandidateReservoir11.ts` | 3 |
| `app/lib/crosswordCspConstraintTopUp11.ts` | 3 |
| `app/lib/buildCspCrossword11.ts` | 2 |
| `app/lib/buildCspCandidateReservoir11.ts` | 2 |
| `app/lib/crosswordCspOrchestrator11.ts` | 2 |
| `app/lib/validateGeneratedCrossword.ts` | 2 |
| `lib/supabaseAdmin.ts` | 2 |

Fan-out mas alto:

| Archivo | Fan-out |
|---|---:|
| `app/api/generate-crossword/route.ts` | 7 |
| `app/lib/buildCspCrossword11.ts` | 6 |
| `app/lib/crosswordCspOrchestrator11.ts` | 3 |
| `app/lib/buildCspCrossword11.test.ts` | 3 |
| `app/lib/analyzeCspCompatibility11.test.ts` | 3 |
| `app/lib/crosswordCspOrchestrator11.test.ts` | 3 |
| varios CSP/frontend | 1-2 |

Ciclos: no se detectaron ciclos en imports estaticos propios.

Archivos sin importadores detectables incluyen:

- Entry points validos: pages, layouts, route handlers, config.
- Tests: todos los `.test.ts`.
- Componentes aparentemente sin uso: `AdSlot`, `BundleClient`, `ClueList`, `Consent`, `EditableGrid`, `GridNumbered`, `HouseAd`, `PuzzlePreview`, `StickyAd`, `ThemeGenerator`, `ThemeToggle`.
- Libs aparentemente sin uso directo: `app/lib/normalizePuzzle.ts`, `app/lib/numbering.ts`, `app/lib/schema.ts`, `app/lib/validateCrossword.ts`.

Nota: Next.js usa convenciones de archivos para pages/routes; no tener importador no implica no uso.

Grafo conceptual:

```text
Frontend pages
  -> app/lib/validateGeneratedCrossword
  -> sessionStorage/localStorage

route.ts
  -> lib/supabaseAdmin
  -> app/lib/buildCspCrossword11
       -> crosswordCspAdapter11
       -> crosswordCsp11
       -> crosswordCspOrchestrator11
       -> crosswordPatterns11
       -> buildHybridCspCandidateReservoir11
  -> crosswordCspTopUp11 / crosswordCspConstraintTopUp11
  -> buildCspCandidateReservoir11
  -> buildHybridCspCandidateReservoir11
  -> crosswordPatterns11
```

## J. Arquitectura funcional actual

### A-V Flujo real

1. Usuario abre `/generar` (`app/generar/page.tsx`).
2. UI fija `GRID_SIZE = 11`, toma `theme` y `lang`.
3. `handleGenerar` limpia `sessionStorage.generatedCrossword` y hace `fetch("/api/generate-crossword")`.
4. `POST` parsea body, fuerza `n=11`, configura TLS local, crea cliente OpenAI si hay `OPENAI_API_KEY`.
5. `POST` intenta smoke Supabase no fatal: `supabaseAdmin.from("crosswords").select("id").limit(1)`.
6. Pipeline de answer bank usa rutas OpenAI de `requestLengthBucketedAnswerbankText`, `requestAnswerbankText`, `requestCompactAnswerbankText`.
7. Se parsea JSON con `safeJson` o `salvageAnswerStringsFromJson`.
8. Respuestas se normalizan con `normalizeAnswer`, se sanitizan con `sanitizeAnswerList`, se elimina tema exacto, se expanden compuestos geograficos.
9. Validacion tematica: `validateThematicAnswers`; si falla, fallback local por notes/core.
10. Top-up general 11x11: `generateLengthBalancedThematicAnswers` si faltan longitudes y hay tiempo.
11. Construccion de `thematicKeepSet`, `publishThemeSet`, `placementThemeSet`.
12. `rawPool` con `buildCandidatePoolFromAnswers`.
13. Reservorio CSP: `buildCspCandidateReservoir11` antes de `pickPoolForSize`.
14. Reservorio hybrid diagnostic: `buildHybridCspCandidateReservoir11` si flags diagnostic/hybrid.
15. Pool legacy: `pickPoolForSize` y cuotas legacy.
16. CSP path si `CROSSWORD_CSP_11_ENABLED=true`: `buildCspCrossword11ForEndpoint`.
17. CSP thematic-only intenta patrones, compatibilidad, solver, top-up por longitud y por restricciones segun diagnostico.
18. CSP hybrid diagnostic intenta con soporte local si thematic-only falla y `CROSSWORD_CSP_11_HYBRID_DIAGNOSTIC=true`.
19. Diagnostic-only puede devolver 422 estructurado sin ejecutar legacy.
20. Si CSP ok, `cspBuilt` converge con tramo posterior de pistas/publicacion.
21. Si CSP falla y diagnostic-only no esta activo, se ejecuta legacy fallback.
22. Legacy intenta combinaciones de: direct model, fixed pattern, early opening, dictionary pattern, pattern assignment, generated grid, layout proposal, compact pattern, strict, freeform, densify, model rescue, theme-first rescue y fallbacks tardios.
23. Grillas se validan/reparan con `deriveEntriesFromGrid`, `hasShortLetterRuns`, `checkedCellStats`, `entryCrossingStats`, `publishQualityIssue`, rebuilders y densifiers.
24. Pistas: `requestModelClues`, `applyCluesAndOverrides`, `repairPublishClues`.
25. `publishCrosswordResponse` hace gate final, puede reparar/prunear y retorna `NextResponse.json`.
26. Frontend valida con `generatedCrosswordIssue`.
27. Frontend guarda en `sessionStorage.generatedCrossword`, `localStorage.ftc:lastTheme`, `localStorage.ftc:lastLang`.
28. `/jugar/preview` lee sessionStorage, verifica tema/idioma/tamano y vuelve a correr `generatedCrosswordIssue`.
29. `/jugar/pro` lee `sessionStorage.generatedCrossword`, inicializa tablero y guarda progreso en `localStorage`.

Supabase: solo smoke/check en generacion y ping; no se guarda puzzle generado segun el codigo auditado.

## K. Feature flags

| Flag/env | Archivo | Default / condicion | Camino |
|---|---|---|---|
| `OPENAI_API_KEY` | route, smoke, ping-env | requerido para generacion real | cliente OpenAI |
| `OPENAI_ANSWERBANK_MODEL` | route | `gpt-4.1-mini` | answerbank/validation |
| `OPENAI_CLUE_MODEL` | route | `gpt-4o-mini` | clues |
| `OPENAI_ANSWERBANK_SEARCH_MODEL` | route | `gpt-4.1` | search/topups |
| `OPENAI_COMPACT_ANSWERBANK_MODEL` | route | answerbank model | compact fallback |
| `OPENAI_ENABLE_WEB_SEARCH` | route | `"1"` activa | Responses API web search |
| `OPENAI_ALLOW_INSECURE_TLS` | route | si no `"0"` permite mutar TLS local | dev TLS |
| `NODE_TLS_REJECT_UNAUTHORIZED` | route | escrito a `"0"` local | TLS local |
| `NODE_ENV` | route/debug ads | production evita TLS hack / ads text | runtime |
| `CROSSWORD_CSP_11_ENABLED` | buildCspCrossword11 | `"true"` activa | CSP primero |
| `CROSSWORD_CSP_11_DIAGNOSTIC_ONLY` | route | `"true"` solo si CSP enabled | 422 diag sin legacy |
| `CROSSWORD_CSP_11_HYBRID_DIAGNOSTIC` | route | `"true"` solo diagnostic-only | hybrid CSP |
| `CROSSWORD_CSP_11_DIAGNOSTIC_BUDGET_MS` | route | 45000 | presupuesto diag |
| `ENABLE_DIRECT_MODEL_11` | route | `"1"` | direct model 11 |
| `OPENAI_FIXED_PATTERN_GRID` | route | `"1"` | fixed pattern model/grid |
| `OPENAI_11X11_MODEL_RESCUE` | route | no `"0"` | model rescue 11 |
| `ENABLE_SEMANTIC_SUPPORT_11` | route | `"1"` | support semantic OpenAI |
| `ENABLE_EARLY_OPENING_11` | route | `"1"` | early opening |
| `ENABLE_DICTIONARY_PATTERN_11` | route | `"1"` | dictionary pattern |
| `OPENAI_EARLY_LAYOUT_11` | route | no `"0"` | early layout |
| `OPENAI_11X11_MODEL_LAYOUT_GRID_UPGRADE` | route | `"1"` | layout/grid upgrade |
| `OPENAI_PATTERN_REPAIR_11` | route | `"1"` | pattern repair OpenAI |
| `ALLOW_RELAXED_CORE_11` | route | `"1"` | relaxed core fallback |
| `SUPABASE_URL` | supabaseAdmin/ping-env | required in supabaseAdmin import | Supabase client |
| `SUPABASE_SERVICE_ROLE_KEY` | supabaseAdmin/ping-env | required in supabaseAdmin import | Supabase server key |

Riesgo: flags leidos al importar (`OPENAI_*_MODEL`) y en runtime mezclados. No hay matriz documentada en README.

## L. Constructores y estrategias

Inventario principal:

| Nombre | Archivo | Lineas | Tipo | Estado |
|---|---|---:|---|---|
| `buildCspCrossword11ForEndpoint` | `app/lib/buildCspCrossword11.ts` | `198-...` | CSP orchestration | diagnostic/production-candidate |
| `solveCrosswordPattern11WithReport` | `app/lib/crosswordCsp11.ts` | `662-...` | CSP solver | production-candidate/diagnostic |
| `rebuildGridFromAllowedEntries` | route | `2830` | rebuild | legacy |
| `rebuildGridFromEntries` | route | `2867` | rebuild | legacy |
| `rebuildGridFromEntriesAllowingAllowedDerived` | route | `2906` | rebuild | legacy |
| `constructPatternCrossword11` | route | `5097-5436` | pattern legacy | fallback |
| `constructCompactPatternCrossword11` | route | `5437-5784` | compact pattern | fallback |
| `constructBeamCrossword11` | route | `5785-6040` | beam search | fallback |
| `constructStrictCrossword11` | route | `6041-6166` | strict wrapper | fallback |
| `constructGreedyCheckedCrossword11` | route | `6167-6387` | greedy checked | fallback |
| `constructFreeformCrossword` | route | `6388-8121` | greedy/freeform | fallback central |
| `densifyCleanGrid11` | route | `8122-8410` | densifier | fallback |
| `requestValidatedLayoutProposal` | route | `9228-9804` | model layout | flag/fallback |
| `requestDirectPlayableCrossword11` | route | `9805-10122` | model full grid | flag |
| `requestValidatedPatternAssignment11` | route | `10123-10333` | model pattern assignment | fallback |
| `requestGeneratedPatternGrid11` | route | `10334-10563` | model grid | fallback |
| `requestValidatedGridProposal` | route | `10564-10745` | model grid proposal | fallback |
| `tryOpeningDeterministic11` | route | `10936-11133` | opening deterministic | fallback |
| `buildThemeFirstRescueCrossword` | route | `11202-11429` | rescue | fallback |
| `rebuildPlayableCrossword` | route | `11430-11511` | rebuild | fallback |
| `rebuildExactPublishableCrossword` | route | `11512-11590` | rebuild exact | fallback |
| `rebuildExactFullyCheckedPublishableCrossword` | route | `11591-11674` | rebuild checked | fallback |
| `rebuildFullyCheckedPublishableCrossword` | route | `11675-11696` | wrapper | fallback |
| `rebuildSanitizedFullyCheckedPublishableCrossword` | route | `11697-11721` | wrapper | fallback |
| `rebuildNoShortRunPublishableCrossword` | route | `11722-11852` | rebuild no short | fallback |
| `augmentNoShortGridWithCandidates` | route | `11853-11966` | augmenter | fallback |
| `extendGridWithCrossedPair11` | route | `11967-12128` | pair extender | fallback |
| `constructOpeningCrossword11` | route | `12129-12484` | opening builder | fallback |

Matriz semantica:

| Camino | Vacio | Bloque | Slots | Cruces | Runs | Cleanup |
|---|---|---|---|---|---|---|
| CSP | patron fijo `.`/`#`; grilla final string | `#` definitivo del patron | extraidos automaticamente | intersecciones de slots; 2+ por slot | prohibidos por pattern validation | no cleanup legacy permitido |
| Freeform legacy | `""` en working grid | `#` puede ser bloque/reserva | no slot library | letras compartidas y side-touch | detecta/repara tarde | `paintBlocks`, `enforceMinWordLen`, `pruneDanglingRuns`, densify |
| Pattern legacy | masks/patterns legacy | `#` de pattern | `PatternSlot` propio | validacion local por assignments | varias gates | puede reconstruir |
| Model layout/grid | JSON modelo | depende de propuesta | validacion local posterior | derive entries/check stats | post-validation | puede caer a fallback |
| Rebuilders | grilla existente | mutan/bloquean | derive entries | checked stats | bloqueos/rebuilds | destructivo si no se aisla |

Riesgo mayor: distintos caminos aceptan/rechazan geometria con reglas no equivalentes.

## M. Modulos CSP

| Modulo | Responsabilidad | API publica | Consumidores | Madurez |
|---|---|---|---|---|
| `crosswordCsp11.ts` | Tipos, pattern validation, domains, solver, report/profile/causality | `extractSlotsFromPattern11`, `validatePattern11`, `prepareCandidateDomains`, `solveCrosswordPattern11*`, `buildCspCrossword11` | CSP modules/tests | production-candidate + diagnostic |
| `crosswordPatterns11.ts` | Biblioteca patrones, analysis, ranking por longitudes, benchmark | `CROSSWORD_PATTERNS_11`, `analyzePattern11`, `rankPatternsForCandidates11`, `benchmarkPatterns11` | route/CSP/tests | production-candidate |
| `crosswordCspOrchestrator11.ts` | Rank + solve multi-pattern, domain analysis | `analyzeCandidateDomains11`, `solveWithRankedPatterns11` | `buildCspCrossword11` | production-candidate |
| `crosswordCspAdapter11.ts` | Normaliza/adapta candidates para CSP | `adaptCandidatesForCsp11`, `normalizeCspAnswer11` | CSP topups/reservoir | production-candidate |
| `crosswordCspTopUp11.ts` | Prompt/parser top-up por longitud | `requestCspLengthTopUpAnswers11` | route callbacks | experimental |
| `crosswordCspConstraintTopUp11.ts` | Prompt/parser top-up posicional | `buildConstraintTopUpRequestsFromConflicts11`, `requestCspConstraintTopUpAnswers11` | route/buildCsp | experimental |
| `analyzeCspCompatibility11.ts` | Compatibilidad por posicion/interseccion | `analyzeCspCompatibility11` | orchestrator/buildCsp | diagnostic |
| `buildCspCandidateReservoir11.ts` | Reservorio tematico amplio | `buildCspCandidateReservoir11`, `cspRequiredLengthsFromPatterns11` | route | production-candidate |
| `buildHybridCspCandidateReservoir11.ts` | Candidatos thematic/support | `loadLocalSupportCandidates11`, `buildHybridCspCandidateReservoir11` | route/buildCsp | diagnostic |
| `buildCspCrossword11.ts` | Integracion de solver, top-ups, diagnostics, validation | `buildCspCrossword11ForEndpoint`, `validateCspCrosswordSolution11`, flags helpers | route/tests | diagnostic/production-candidate |
| `cspSearchCausality11.ts` | Clasifica causa de busqueda | `summarizeCspSearchCausality11` | solver/tests | diagnostic |

La capa CSP es bastante coherente internamente y no tiene ciclos detectados. Aun depende de `route.ts` para callbacks OpenAI, validacion tematica real y mutacion de sets de publicacion. Debe moverse a una integracion endpoint/pipeline separada antes de adelgazar `POST`.

## N. Datos y vocabularios

| Archivo | Bytes | Registros aprox. | Formato | Consumo | Riesgo |
|---|---:|---:|---|---|---|
| `data/common-words-en.txt` | 75.888 | 10.000 | txt una palabra/linea | `route.ts` top-level | untracked; origen/licencia no documentado |
| `data/frequency-en-50k.txt` | 622.749 | 50.000 | txt frecuencia/palabra | route + hybrid reservoir | untracked; memoria/carga sync |
| `data/frequency-es-50k.txt` | 658.626 | 50.000 | txt frecuencia/palabra | route + hybrid reservoir | untracked; origen/licencia no documentado |
| `data/words-en.txt` | 4.234.910 | 370.105 | txt | no consumo detectado | grande; aparentemente unused |
| `data/crosswords_progress_demo-7.json` | 339 | 13 lines | JSON | no consumo detectado | demo/test |
| `data/crosswords_progress_mini-5*.json` | 411-675 | 42-70 lines | JSON | no consumo detectado | demo/test |

Carga actual: `route.ts` usa `readFileSync(join(process.cwd(),"data",...))` al importar para diccionarios; `buildHybridCspCandidateReservoir11.ts` tambien lee frecuencia local. Esto es efecto de import o runtime server y deberia aislarse con cache/documentacion.

## O. OpenAI

Lugares detectados:

- `openai-smoke.js`: smoke manual `gpt-4.1-mini`, no usar en auditoria.
- `route.ts`:
  - `validateThematicAnswers` (`3940-4027`): chat completions, JSON, valida respuestas tematicas.
  - `topUpAnswers` (`4028-4112`): top-up general.
  - `generateLengthBalancedThematicAnswers` (`4156-4260`): top-up por longitud.
  - `generateSupportWords` (`4261-4329`): soporte contextual.
  - `generatePatternMatchedRepairWords` (`8411-8551`): repair words.
  - `requestAnswerbankText` (`8726-8804`): answerbank, Responses API web search opcional y chat fallback.
  - `requestCompactAnswerbankText` (`8805-8912`): compact answerbank fallback.
  - `requestLengthBucketedAnswerbankText` (`8913-9227`): answerbank estructurado por buckets.
  - `requestValidatedLayoutProposal` (`9228-9804`): layout proposal.
  - `requestDirectPlayableCrossword11` (`9805-10122`): grilla directa.
  - `requestValidatedPatternAssignment11` (`10123-10333`): asignacion pattern.
  - `requestGeneratedPatternGrid11` (`10334-10563`): grilla pattern.
  - `requestValidatedGridProposal` (`10564-10745`): grid proposal.
  - `requestModelClues` (`10777-10935`): pistas y retry.
  - callbacks CSP en `POST` (`14184`, `14274`): top-up length/constraint.
  - pre-clue/fallback clue request dentro de `POST` (`15441`).

Riesgos:

- Coste/latencia altos por muchas rutas alternativas.
- Riesgo de alucinacion mitigado por sanitize/validate, pero duplicado en varios puntos.
- Prompts distribuidos dentro de route, dificil de auditar.
- `OPENAI_ENABLE_WEB_SEARCH` puede cambiar coste/latencia.
- Cliente OpenAI se crea dentro de `POST`, timeout 45s para 11x11, maxRetries 0.

Diagrama:

```text
answerbank -> sanitize -> thematic validation
    -> length top-up -> validation
    -> candidate pools/reservoir
        -> CSP top-up length/constraint -> validation
        -> legacy builders
            -> model layout/grid/direct/repair proposals
    -> clue request -> clue validation/repair
```

## P. Supabase y persistencia

`lib/supabaseAdmin.ts`:

- Usa `server-only`.
- Crea cliente con `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`.
- `requiredEnv` lanza si falta una variable al importar el modulo.

Usos:

- `route.ts`: smoke check no fatal `supabaseAdmin.from("crosswords").select("id").limit(1)`.
- `app/api/ping-supabase/route.ts`: count exact/head sobre tabla `crosswords`.

No se encontraron inserts ni persistencia de crucigramas generados. Persistencia funcional actual:

- `sessionStorage.generatedCrossword`: puzzle generado para preview/pro.
- `localStorage.ftc:lastTheme`, `ftc:lastLang`: preferencias.
- `localStorage.ftc:progress:*`: progreso del juego.
- Quickplay legacy usa otras claves (`xw:quickplay`, `ftc_quickplay_puzzle_v1`).

## Q. Frontend

Flujo actual:

```text
/generar
  -> POST /api/generate-crossword
  -> generatedCrosswordIssue(data)
  -> sessionStorage.generatedCrossword
  -> /jugar/preview?theme=...&lang=...
      -> valida cache contra query
      -> muestra grid/pistas
      -> /jugar/pro?src=gen
          -> lee sessionStorage
          -> permite jugar
          -> guarda progreso en localStorage
```

Archivos:

- `app/generar/page.tsx`: UI real. Fija 11x11, elimina selector de tamano, usa validador frontend.
- `app/jugar/preview/page.tsx`: QA preview. Tiene hardcode anti-cache Bariloche/vino (`wineAnswers`, `barilocheWineCache`), contrario al principio multitema si quedara en produccion.
- `app/jugar/pro/page.tsx`: juego final desde sessionStorage; tiene `ClueList` interno y no usa store Zustand.
- `app/jugar/ahora/page.tsx`: quickplay legacy.
- `app/store/crosswordStore.ts` y `EditableGrid`: stack legacy Zustand no usado por flujo principal actual.
- `ThemeGenerator.tsx`: llama `/api/generate`, endpoint no detectado.

Inconsistencias:

- Comentarios/textos con mojibake (`GenerandoÃ¢â‚¬Â¦`, `EspaÃƒÂ±ol`) en varios archivos.
- Validadores frontend y backend no comparten tipos.
- Preview tiene reglas especificas de Bariloche/vino.

## R. Validadores

Matriz por etapa:

| Etapa | Validator | Archivo | Riesgo |
|---|---|---|---|
| Backend normalize | `normalizeAnswer` | route | duplicado en store/schema/patterns |
| Backend sanitize | `sanitizeAnswerList`, `isLikelyBadAnswer` | route | reglas locales + allowlist |
| Thematic | `validateThematicAnswers` | route | OpenAI + fallback local |
| Publish answer | `isPublishableAnswerForTheme` | route | mezcla semantica/dominio |
| Grid derive | `deriveEntriesFromGrid` | route/CSP variants | duplicado |
| Runs | `hasShortLetterRuns`, `shortRunCellKeys`, `validatePattern11` | route/CSP/frontend | semanticas no identicas |
| Crossings | `checkedCellStats`, `entryCrossingStats`, CSP intersections, frontend crossings | route/CSP/frontend | definiciones distintas |
| Clues | `isBadClue`, `clueLooksTooGenericForThematic`, `isPlaceholderClue` | route | no compartido frontend |
| CSP solution | `validateCspCrosswordSolution11` | buildCspCrossword11 | fuerte e independiente |
| Frontend generated | `generatedCrosswordIssue` | app/lib | impone 11x11, 15 entries, 2 cruces |
| Legacy payload | `validatePayload`, `isCrossword` | app/lib, lib | contratos antiguos |

Contradicciones relevantes:

- CSP productivo actual habla de 22 slots; frontend solo exige minimo 15.
- `lib/crossword.ts` acepta size 9-13; `/generar` fuerza 11.
- `types/puzzle.ts` usa grilla flatten; backend usa `string[][]`.
- Normalizacion duplicada con diferentes regex/acento handling.

## S. Tests

Tests detectados: 11 archivos, 81 tests con `node:test`.

| Archivo | Tests aprox. | Cubre |
|---|---:|---|
| `crosswordCsp11.test.ts` | 12 | pattern validation, solver, reports, profile |
| `buildCspCrossword11.test.ts` | 18 | integracion CSP, flags, topups, hybrid |
| `cspSearchCausality11.test.ts` | 9 | clasificador causal |
| `analyzeCspCompatibility11.test.ts` | 3 | compatibilidad |
| `crosswordPatterns11.test.ts` | 10 | patrones, fixtures, benchmark |
| `crosswordCspTopUp11.test.ts` | 3 | prompt/parser top-up length |
| `buildCspCandidateReservoir11.test.ts` | 7 | reservorio CSP |
| `crosswordCspOrchestrator11.test.ts` | 8 | ranking/orquestador |
| `crosswordCspAdapter11.test.ts` | 3 | adapter |
| `crosswordCspConstraintTopUp11.test.ts` | 6 | constraint top-up |
| `buildHybridCspCandidateReservoir11.test.ts` | 2 | reservoir hybrid |

No hay script `test` en `package.json`; los tests se ejecutan manualmente compilando a `.tmp-csp-tests` y usando `node --test`.

Huecos:

- Sin tests de contrato HTTP para `POST`.
- Sin mocks formales de OpenAI/Supabase en suite npm.
- Sin tests frontend.
- Sin tests de route legacy/fallback completo.
- CSP tests son buenos pero principalmente sinteticos.

## T. Dependencias y configuracion

`package.json`:

- Scripts: `dev`, `build`, `start`, `lint`.
- Sin `test`.
- Dependencies: Next 15.5.4, React 19.1.0, OpenAI 6.7.0, Supabase JS, Zustand, Zod, dotenv.
- Dev: TypeScript, ESLint 9, Tailwind/PostCSS.

Config:

- `tsconfig.json`: strict true, moduleResolution Bundler, alias `@/* -> ./*`, incremental true, noEmit.
- `eslint.config.mjs`: next/core-web-vitals + next/typescript, ignora `.next`, build, out, node_modules, next-env.
- `next.config.ts`: vacio.
- `tailwind.config.ts`: content app/components.
- `postcss.config.js` y `postcss.config.mjs`: duplicados funcionales.
- `.gitignore`: ignora `.next`, env, `.vercel`, tsbuildinfo, node_modules; no ignora `.next-dev*.log` ni `.tmp-csp-tests`.

## U. Codigo aparentemente muerto

| Archivo/simbolo | Evidencia | Confianza | Riesgo eliminacion |
|---|---|---|---|
| `app/components/ThemeGenerator.tsx` | Sin importadores; llama `/api/generate` no existente | alta | medio, podria ser dev manual |
| `app/jugar/ahora/page.tsx` | Usa quickplay legacy, no conectado desde flujo actual salvo link "Jugar ahora" en `/generar` que no guarda `xw:quickplay` | media | medio |
| `app/store/crosswordStore.ts` + `EditableGrid` | No usados por `/jugar/pro`; stack legacy Zustand | media | alto sin revisar rutas ocultas |
| `app/lib/normalizePuzzle.ts` | Sin importadores detectados | alta | bajo |
| `app/lib/numbering.ts` | Sin importadores detectados | alta | bajo |
| `app/lib/schema.ts`, `validateCrossword.ts`, `crosswordSchema.ts` | Legacy schemas sin uso en flujo principal | media | medio |
| `components/ThemeToggle.tsx` | Duplicado fuera de `app/components` sin importadores | alta | bajo |
| `public/crosswords.bundle` | Consumido solo por `BundleClient`, que no tiene importadores | media | bajo |
| `getDemoCrossword` en route | Sin referencias internas detectadas en auditoria previa | alta | medio |
| `data/words-en.txt` | No consumo detectado | media | bajo/unknown licencia |

## V. Duplicaciones e inconsistencias

| Tema | Archivos | Detalle | Canonico sugerido |
|---|---|---|---|
| Tipos crossword | route, `lib/crossword.ts`, `types/puzzle.ts`, `app/lib/crosswordSchema.ts`, `app/lib/schema.ts` | modelos incompatibles | nuevo `app/lib/crossword/domain/types.ts` |
| Normalizacion | route, store, schema, patterns | regex y acentos distintos | una normalizacion domain |
| Validacion generated | backend route, CSP validation, frontend `generatedCrosswordIssue` | umbrales distintos | validation compartida por etapa |
| PostCSS config | `.js` y `.mjs` | duplicado | uno solo |
| ThemeToggle | `components/` y `app/components/` | duplicado | `app/components` |
| ClueList | `app/components/ClueList.tsx` e interno en `pro/page.tsx` | duplicacion UI | componente unico |
| Constructores legacy | route | 20+ caminos solapados | encapsular luego retirar |
| Prompts OpenAI | route + CSP topup modules | prompts dispersos | `answerBank/prompts`, `clues/prompts`, `csp/prompts` |
| Diccionarios | route + hybrid reservoir | loaders separados | `data/dictionaries.ts` |
| Reglas tematicas especificas | route + preview | Bariloche/vino/musica | mover a tests o neutralizar |

## W. Registro de deuda tecnica

| Severidad | Deuda | Impacto | Esfuerzo |
|---|---|---|---|
| critical | `route.ts` 20.541 lineas / `POST` 7.953 | bloquea cambios seguros | alto |
| critical | Worktree sucio con cambios tracked/untracked grandes | riesgo de perder/mezclar trabajo | medio |
| high | 24 estrategias de grilla/fallbacks | comportamiento impredecible | alto |
| high | Sin tests contrato HTTP/OpenAI/Supabase | refactor sin red | medio |
| high | Varios modelos de puzzle/tipos | bugs de integracion | medio |
| high | Reglas especificas de tema en produccion/preview | viola principio multitema | medio |
| medium | Logs grandes untracked | ruido y performance git | bajo |
| medium | Diccionarios sin procedencia documentada | riesgo licencia/calidad | medio |
| medium | Config duplicada PostCSS | confusion build | bajo |
| medium | CSP integrado pero route captura callbacks | acoplamiento | medio |
| low | Mojibake en UI/textos | calidad percibida | bajo |

## X. Arquitectura actual

```text
Next App Router
  Frontend
    /generar
      -> app/lib/validateGeneratedCrossword
      -> sessionStorage/localStorage
    /jugar/preview
      -> sessionStorage + validation
    /jugar/pro
      -> sessionStorage + localStorage progress
    legacy quickplay stack

  API
    /api/generate-crossword (route.ts)
      -> Supabase smoke
      -> OpenAI answerbank
      -> sanitize/validate/topups
      -> rawPool
          -> CSP reservoir -> CSP modules -> optional CSP topups
          -> legacy pool -> 20+ legacy builders/fallbacks
      -> clue generation OpenAI
      -> publish validation/repair
      -> JSON response

  Data
    local txt dictionaries loaded by route and hybrid reservoir
```

## Y. Arquitectura objetivo

```text
app/api/generate-crossword/route.ts
  -> parse request
  -> build server dependencies
  -> call generateCrossword11()
  -> NextResponse

app/lib/crossword/
  domain/
    types.ts
    normalize.ts
    grid.ts
    thresholds.ts
  validation/
    answerQuality.ts
    geometry.ts
    clueQuality.ts
    publishQuality.ts
  data/
    dictionaries.ts
  openai/
    clientTypes.ts
    answerBank.ts
    thematicValidation.ts
    clues.ts
    modelGridProposals.ts
  candidates/
    candidateTypes.ts
    legacyPool.ts
    cspReservoir.ts
  csp/
    wrappers around existing CSP modules
    endpointIntegration.ts
    diagnostics.ts
  legacy/
    gridGeometry.ts
    freeformBuilder.ts
    patternBuilders.ts
    repair.ts
    fallbacks.ts
  pipeline/
    generateCrossword11.ts
    publication.ts
    featureFlags.ts
    errors.ts
  persistence/
    supabaseHealth.ts
```

Reglas:

- `domain` y `validation` no importan Next, OpenAI ni Supabase.
- `openai` recibe cliente inyectado.
- `pipeline` puede depender de servicios, no de UI.
- `route.ts` es la unica capa con `NextRequest`/`NextResponse`.
- CSP existente no se duplica.
- Legacy queda encapsulado y luego removable por evidencia.

## Z. Plan incremental

### FASE A: estabilizacion del repositorio

- Precondicion: no mover codigo.
- Accion: acordar checkpoint de worktree y separar logs/temporales.
- Tests: `tsc`, lint.
- No mezclar: optimizacion CSP.

### FASE B: tests de caracterizacion

- Agregar tests HTTP con mocks OpenAI/Supabase para `POST`.
- Cubrir flag off/on, diagnostic-only, CSP success/fail, legacy fallback.
- No mover codigo todavia.

### FASE C: tipos y utils

- Extraer tipos y normalizacion pura.
- Equivalencia por tests unitarios.
- Reducir poco, bajar riesgo futuro.

### FASE D: prompts y OpenAI

- Extraer prompts y llamadas a OpenAI detras de interfaces.
- Mantener modelos/env igual.
- Tests con completions mockeadas.

### FASE E: candidate pipeline

- Extraer sanitize, validate, rawPool, legacyPool, CSP reservoir integration.
- Tests de distribuciones.

### FASE F: consolidacion CSP

- Mover callbacks CSP/topup/audit desde `POST` a integracion endpoint.
- No cambiar solver ni heuristicas.

### FASE G: encapsulado legacy

- Mover geometry primitives y builders uno por uno.
- Snapshot de resultados con fixtures.

### FASE H: clue/publication pipeline

- Extraer clue request, clue validation, `publishCrosswordResponse`.
- Tests de contrato de salida.

### FASE I: handler delgado

- `route.ts` llama `generateCrossword11`.
- Criterio: route en 200-500 lineas.

### FASE J: retiro controlado de codigo muerto

- Solo luego de coverage.
- Eliminar ThemeGenerator legacy, quickplay, unused schemas si se confirma.

### FASE K: CI y documentacion

- Agregar script `test`.
- Documentar flags, env vars, pipelines y diccionarios.

## AA. Proximos 3 pasos

1. **Checkpoint seguro del worktree**
   - Objetivo: evitar perder o mezclar trabajo.
   - Accion: no tecnica/destructiva ahora; planificar commits tematicos o rama/checkpoint.
   - Razon: hay cambios tracked enormes y muchos untracked.
   - Cierre: estado Git documentado y separado por tema.

2. **Tests de contrato HTTP antes de mover codigo**
   - Objetivo: congelar comportamiento observable.
   - Accion: mocks OpenAI/Supabase para `/api/generate-crossword`.
   - Razon: `POST` es demasiado grande para refactorizar sin red.
   - Cierre: status/meta/flags principales cubiertos.

3. **Extraer tipos/normalizacion/metrics puras**
   - Objetivo: primera modularizacion de bajo riesgo.
   - Accion: mover tipos y helpers puros ya identificados.
   - Razon: reduce duplicacion y crea base para candidates/CSP/frontend.
   - Cierre: `tsc`, lint, tests unitarios verdes, sin cambio HTTP.

## AB. Criterios de finalizacion

La reorganizacion arquitectonica puede considerarse lista cuando:

- `route.ts` queda en 200-500 lineas.
- No contiene prompts, builders, validators, dictionaries, repairs ni fallback trees.
- OpenAI y Supabase estan inyectados o aislados.
- CSP y legacy tienen modulos separados y tests.
- Frontend y backend comparten contratos o adaptadores explicitos.
- No hay reglas de produccion especificas para fixtures.
- Logs/temporales estan ignorados o documentados.
- Existe script de test reproducible.
- Se puede desactivar/retirar legacy con evidencia.
