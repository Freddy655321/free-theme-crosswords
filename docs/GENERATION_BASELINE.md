# Generation Baseline

## Propósito

Este benchmark ejecuta una matriz controlada de generaciones end-to-end de WORDYNAMO y produce artefactos comparables entre versiones. Su objetivo es medir calidad observable antes de cambiar algoritmos, prompts, thresholds o builders.

Por defecto arranca en modo `dry-run`: valida configuración, lista la matriz, calcula cuántas generaciones se ejecutarían y escribe un reporte sin invocar el endpoint.

## Matriz Inicial

La matriz versionada tiene 12 fixtures de evaluación, todos en `language: en`, `size: 11` y una generación por caso salvo que se use `--repeat`.

| id | theme | categoría |
| --- | --- | --- |
| `taylor-swift` | Taylor Swift | popular |
| `the-beatles` | The Beatles | popular |
| `star-wars` | Star Wars | popular |
| `argentina` | Argentina | geographic |
| `new-york-city` | New York City | geographic |
| `japanese-cuisine` | Japanese cuisine | geographic |
| `ancient-egypt` | Ancient Egypt | cultural |
| `greek-mythology` | Greek mythology | cultural |
| `the-renaissance` | The Renaissance | cultural |
| `astronomy` | Astronomy | broad |
| `dogs` | Dogs | broad |
| `classical-music` | Classical music | broad |

Estos temas son fixtures de evaluación únicamente. No se usan como reglas de producción.

## Comandos

El repo no incluye `tsx`. Flujo local:

```powershell
npx.cmd tsc -p tsconfig.contract.json
node .tmp-contract-tests/scripts/run-generation-baseline.js --dry-run
node .tmp-contract-tests/scripts/run-generation-baseline.js --dry-run --case astronomy
node .tmp-contract-tests/scripts/run-generation-baseline.js --dry-run --repeat 3
node .tmp-contract-tests/scripts/run-generation-baseline.js --compare outputs/generation-baseline/<run-a> outputs/generation-baseline/<run-b>
```

Para ejecutar generaciones reales se requiere el flag explícito:

```powershell
node .tmp-contract-tests/scripts/run-generation-baseline.js --execute
```

Sin `--execute`, no se importa el handler del endpoint, no se llama OpenAI, no se llama Supabase y no se ejecuta generación.

## Inputs

Flags soportados:

- `--execute`: ejecuta generaciones reales.
- `--dry-run`: fuerza modo seco. Es el comportamiento por defecto.
- `--case <id|theme>`: filtra un caso.
- `--repeat <n>`: repite cada caso `n` veces.
- `--language <en|es>`: idioma enviado al endpoint.
- `--size <n>`: tamaño enviado al endpoint.
- `--timeout-ms <n>`: timeout externo por generación real.
- `--output-dir <path>`: directorio base de salida.
- `--compare <run-a> <run-b>`: compara dos carpetas de resultados.

## Ruta de Ejecución

La herramienta usa la ruta más representativa disponible sin levantar servidor:

1. En `dry-run`, no importa ni ejecuta el endpoint.
2. Con `--execute`, importa dinámicamente `app/api/generate-crossword/route` y llama `POST` con un `Request` local.

Limitación: esta vía mide el handler completo sin red HTTP local, pero sigue pasando por el código del endpoint y sus dependencias reales. No duplica la lógica de generación dentro del benchmark.

## Outputs

Cada ejecución crea:

```text
outputs/generation-baseline/<run-id>/
  run.json
  cases.jsonl
  summary.json
  summary.md
  cases/
    <case-id>.json
```

Las comparaciones crean:

```text
outputs/generation-baseline/comparison-<timestamp>/
  comparison.json
  comparison.md
```

`outputs/generation-baseline/` está ignorado por Git.

## Métricas

Identidad:

- `benchmarkRunId`
- `timestamp`
- `gitCommit`
- `theme`
- `language`
- `size`
- `seed`
- `attemptIndex`

Resultado:

- success
- status
- failure stage
- failure reason
- exception type/message
- duration milliseconds

Pipeline:

- builder
- strategies attempted/order
- attempts by builder
- deadline exhausted
- fallback used
- answer-bank source
- OpenAI call count
- models used
- token usage
- estimated cost

Grid:

- dimensions
- open cells
- blocks
- density
- entries total/across/down
- crossing cells
- checked-cell ratio
- unchecked cells
- connected components
- short runs
- validation accepted
- repairs applied

Answers:

- initial/sanitized/merged/candidate counts
- used answers
- confirmed thematic/support/unknown answers
- confirmed thematic ratio
- confirmed support/filler ratio
- unknown ratio
- thematic cell ratio
- used answer lengths
- duplicates
- rejected by language or policies

Publish:

- entries with clue
- clue fallbacks
- editorial repairs
- publish gate accepted
- final warnings

## Unavailable

La herramienta no inventa métricas. Si el response o `meta` no exponen un dato, el valor queda en `null` y se lista en `unavailableMetrics`.

Ejemplos comunes:

- tokens, si el endpoint no los devuelve;
- costo, si no existe usage o precios configurados;
- intentos por builder, si no están en metadata;
- provenance temática, si no está expuesta para una respuesta usada.

## Clasificación Temática

La clasificación reutiliza únicamente provenance existente:

- `thematicKeepSet`
- `broadThematicSet`
- `validatedAnswers`
- `supportAnswers`
- `fillerAnswers`
- campos equivalentes disponibles en `meta`

Si una respuesta usada no aparece en provenance confiable, se clasifica como `unknown`.

No se agregan listas por fixture ni llamadas OpenAI de evaluación.

## Comparación

`--compare <run-a> <run-b>` compara:

- éxito;
- duración mediana y p95;
- thematic ratio;
- entries;
- checked ratio;
- builder usage;
- fallbacks;
- failure reasons.

Cada métrica se marca como:

- `improvement`
- `regression`
- `unchanged`
- `unavailable`

Con muestras chicas, el reporte es descriptivo y no declara significancia estadística.

## Limitaciones

- El endpoint actual no expone todos los contadores internos como metadata estable.
- El modo real puede incurrir costo OpenAI y tocar dependencias del endpoint; por eso exige `--execute`.
- El benchmark no optimiza ni corrige comportamiento.
- El dry-run produce artefactos de estructura, no resultados de calidad reales.
