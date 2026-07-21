# Route TS Modularization Phase C

## A. Objetivo

Extraer de `app/api/generate-crossword/route.ts` solamente tipos compartidos, constantes estructurales simples y utilidades puras deterministas, sin cambiar el comportamiento observable del endpoint ni tocar el cuerpo logico de `POST`.

## B. Simbolos Extraidos

Tipos movidos a `app/lib/crosswordTypes.ts`:

- `Direction`
- `Entry`
- `Crossword`
- `DerivedEntry`
- `Cell`
- `Placement`
- `WordCandidate`
- `RawAnswerBank`
- `RawClueBank`

Utilidades movidas a `app/lib/crosswordUtils.ts`:

- `ASCII_A_TO_Z`
- `isBlock`
- `normalizeAnswer`
- `safeJson`
- `shuffleInPlace`
- `makeSeededRng`
- `inBounds`

## C. Simbolos Deliberadamente No Extraidos

No se extrajeron funciones que mezclan reglas editoriales, listas locales, filtros tematicos, validacion de publicacion, prompts, OpenAI, Supabase, CSP, constructores legacy ni funciones anidadas dentro de `POST`.

Tambien se evaluaron pero no se extrajeron `clampOddSize` y `parseRequestedSize` porque no existen actualmente como simbolos top-level en `route.ts`.

## D. Archivos Creados

- `app/lib/crosswordTypes.ts`
- `app/lib/crosswordUtils.ts`
- `app/lib/crosswordUtils.test.ts`
- `docs/ROUTE_TS_MODULARIZATION_PHASE_C.md`

## E. Dependencias

`route.ts` ahora importa tipos desde `@/app/lib/crosswordTypes` y utilidades puras desde `@/app/lib/crosswordUtils`.

Los nuevos modulos no importan `route.ts`, no importan Next.js, no leen `process.env`, no usan OpenAI, no usan Supabase y no escriben logs.

## F. Lineas de route.ts

- Antes: 18.928 lineas.
- Despues: 18.866 lineas.
- Reduccion neta: 62 lineas.

La reduccion neta es menor que las lineas movidas porque se agregaron imports explicitos.

## G. Tests

Se agregaron tests unitarios para:

- `normalizeAnswer`
- `safeJson`
- `makeSeededRng`
- `shuffleInPlace`
- `inBounds`

No se agregaron tests para `clampOddSize` ni `parseRequestedSize` porque no hay funciones actuales con esos nombres en `route.ts`.

## H. Comportamiento Preservado

La implementacion de cada utilidad fue copiada sin cambiar parametros, regex, retornos ni manejo de errores. `POST`, prompts, flags, builders, validadores y pipeline de publicacion no fueron modificados logicamente.

## I. Riesgos

- `route.ts` sigue siendo monolitico y contiene muchas funciones puras aun no extraidas.
- Algunos tipos importados siguen acoplados a constructores legacy; mover mas tipos sin caracterizacion adicional podria mezclar responsabilidades.
- La suite de contrato cubre el endpoint sin red, pero no provee todavia un 200 integral estable.

## J. Proxima Extraccion Recomendada

La siguiente fase de bajo riesgo deberia extraer normalizadores y helpers puros de grilla que no dependan de listas editoriales ni de estado mutable compartido. Antes de mover validadores mas complejos conviene agregar tests de caracterizacion especificos para esas reglas.
