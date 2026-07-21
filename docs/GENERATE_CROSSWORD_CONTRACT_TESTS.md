# Generate Crossword Contract Tests

## A. Objetivo

Esta fase agrega tests de caracterizacion para `app/api/generate-crossword/route.ts` antes de modularizarlo. Los tests congelan el comportamiento observable actual del endpoint sin red, sin servidor local y sin credenciales reales.

## B. Alcance

La suite cubre el handler `POST` importado directamente, con `Request` de plataforma web y mocks deterministas para OpenAI y Supabase. Los temas usados son fixtures neutrales de QA, no reglas de producto.

## C. Comportamiento Caracterizado

- Normalizacion actual de request: idioma desconocido cae a `es`, `size` queda en 11, body invalido o tema ausente usa el fallback actual.
- Ausencia de `OPENAI_API_KEY`: status 503 y envelope de error actual.
- Fallos del banco inicial de OpenAI: error, JSON invalido y objeto sin `answers/entries`.
- Flags CSP: apagado, diagnostic-only, hybrid diagnostic y hybrid aislado sin flags requeridos.
- Contrato 422 de diagnostic-only: `error: "csp-diagnostic-failed"` y diagnostico estructurado.
- Contrato 200 controlado por el camino `ENABLE_DIRECT_MODEL_11`.
- Casos de pistas validas, faltantes, genericas, con mencion de respuesta y excepcion.
- Supabase smoke check exitoso, con error y con excepcion como dependencia mockeada.

## D. Comportamiento No Cubierto

- No se ejecutan generaciones reales contra OpenAI.
- No se ejecutan llamadas reales a Supabase.
- No se levanta Next.js ni se usa `localhost`.
- No se congelan snapshots completos de prompts ni diagnosticos gigantes.
- El exito integral CSP productivo con bancos reales queda fuera: ya esta cubierto por pruebas CSP aisladas y por diagnostico manual.

## E. Mocks y Costuras

Se agrego una costura minima en `route.ts`:

- `__setGenerateCrosswordTestOverrides`
- reemplazo del factory de `OpenAI`
- reemplazo del cliente usado para el smoke check de Supabase

El comportamiento por defecto no cambia: produccion sigue creando `new OpenAI(...)` y usando `supabaseAdmin`.

## F. Feature Flags Cubiertos

- `CROSSWORD_CSP_11_ENABLED`
- `CROSSWORD_CSP_11_DIAGNOSTIC_ONLY`
- `CROSSWORD_CSP_11_HYBRID_DIAGNOSTIC`
- `CROSSWORD_CSP_11_DIAGNOSTIC_BUDGET_MS`
- `ENABLE_DIRECT_MODEL_11`

## G. Casos de Exito

La suite intenta un camino controlado con `ENABLE_DIRECT_MODEL_11=1`, fills sinteticos consistentes con el patron directo y pistas mockeadas. El comportamiento actual observado no publica 200 con ese fixture: el endpoint devuelve un error de publicacion o generacion despues de validar el camino directo. Por eso esta fase congela el contrato real de rechazo/fallback de ese camino, y deja pendiente un fixture integral publicable para cubrir un 200 end-to-end sin acoplar el test a vocabulario tematico real.

Los invariantes de grilla 11x11 y coherencia `entry/grid` quedan cubiertos en los tests CSP aislados existentes; el contrato HTTP 200 integral debe agregarse cuando exista un fixture publicable estable y no fragil.

## H. Casos de Error

La suite cubre API key ausente, fallos de OpenAI, JSON invalido, banco insuficiente, CSP diagnostic-only fallido y variantes de clues problemáticas.

## I. Comandos

```powershell
npm run test:contract
npx.cmd tsc --noEmit
npx.cmd eslint app/api/generate-crossword/route.ts app/api/generate-crossword/route.contract.test.ts scripts/run-contract-tests.mjs
```

La suite de contrato compila temporalmente a `.tmp-contract-tests` y ejecuta:

```powershell
node --test .tmp-contract-tests/app/api/generate-crossword/route.contract.test.js
```

## J. Limitaciones

El endpoint sigue siendo muy grande y con dependencias top-level. La costura evita red, pero no resuelve la mezcla arquitectonica. Algunos fallos se caracterizan por shape/status en lugar de valores internos exactos porque el pipeline legacy puede cambiar el motivo final segun el banco.

## K. Riesgos

- Los tests importan `route.ts`, por lo que siguen pagando el costo de inicializacion del archivo monolitico.
- El runner crea aliases compilados temporales para `@/app` y `@/lib`.
- La carpeta `.tmp-contract-tests` es generada y no debe entrar en commits.

## L. Antes de Modularizar

Antes de extraer bloques de `route.ts`, esta suite debe seguir pasando. Cualquier extraccion debe conservar los contratos HTTP y los flags cubiertos aqui.
