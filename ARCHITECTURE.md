# Architecture

## System Overview

Wordynamo is a Next.js App Router application for generating and playing themed crossword puzzles.

The primary generation flow takes a user-provided theme and language, sends them to the generation API, builds a crossword through modular generation services, and returns a crossword payload that browser preview and play surfaces can render.

This document describes current architecture, not roadmap, project history, or proposed refactors.

## Application Boundaries

### Generation UI

The generation UI collects the current generation inputs, requests crossword generation, validates the returned crossword data, and stores it for later presentation.

Current evidence:

- `app/generar/page.tsx`
- `app/lib/validateGeneratedCrossword.ts`

### Generation API

The generation API is the HTTP and composition boundary for crossword generation.

It parses the request, binds request-scoped dependencies and services, prepares generation inputs, invokes generation orchestration, and maps semantic outcomes to HTTP responses.

Primary path:

- `app/api/generate-crossword/route.ts`

### Preview / Play

Preview and play surfaces consume generated crossword data, render grids and clues, and support browser-storage handoff or progress state where currently implemented.

Current evidence:

- `app/jugar/preview/page.tsx`
- `app/jugar/pro/page.tsx`
- `app/jugar/ahora/page.tsx`
- shared grid and clue components under `app/components/`

## Generation Architecture

### Answer Preparation

Answer preparation is composed at the route boundary and uses modular answer and OpenAI generation services.

The route-level preparation step owns request-bound composition around answer bank generation, fallback answer acquisition, answer pipeline execution, and the prepared attempt state consumed by generation orchestration.

Relevant ownership:

- `app/lib/openaiGeneration/`
- `app/lib/answerPipeline/`
- route-level `prepareAttemptAnswers` composition in `app/api/generate-crossword/route.ts`

### Generation Orchestration

`app/lib/generationPipeline/` is the principal orchestration layer for prepared generation attempts.

It coordinates attempt progression, construction strategies, fallback and rescue paths, candidate retention, validation and repair sequencing, and semantic generation outcomes.

The pipeline returns semantic results to the route, including accepted, diagnostic, and failed outcomes. It does not own HTTP response serialization.

### Crossword Construction

Construction is split across strategy and primitive modules used by the generation pipeline.

Relevant module families:

- `app/lib/cspOrchestration/`
- `app/lib/gridConstruction/`
- `app/lib/freeformBuilder/`
- `app/lib/openingBuilder/`
- `app/lib/legacyBuilder/`

These modules provide construction strategies, placement primitives, and builder paths used during orchestration. Not every path necessarily runs for every request.

### Recovery and Candidate Improvement

Recovery and candidate-improvement modules support validation, retained candidates, rescue paths, reconstruction, enhancement, and repair during generation.

Relevant module families:

- `app/lib/bestPartial/`
- `app/lib/themeFirstRescue/`
- `app/lib/gridValidation/`
- `app/lib/gridReconstruction/`
- `app/lib/gridEnhancement/`
- `app/lib/openaiRepairServices/`

These modules are used by orchestration and route-level composition where their responsibilities apply.

### Publication

Publication covers clue handling, derived entries, cleanup, finalization, and the final crossword response boundary.

Relevant ownership:

- `app/lib/publishPipeline/`
- final route-level response composition in `app/api/generate-crossword/route.ts`

The route remains responsible for converting publish or generation outcomes into HTTP responses.

## Data Flow

Theme + language
-> Generation UI
-> `/api/generate-crossword`
-> Answer preparation
-> Generation Pipeline
-> Construction / rescue / repair / validation
-> Publication
-> API response
-> Browser storage
-> Preview / play

## External Boundaries

### OpenAI

OpenAI client creation lives at the server API composition boundary.

Modular services use the client for generation, validation, clue, and repair operations where currently wired.

Relevant paths:

- `app/api/generate-crossword/route.ts`
- `app/lib/openaiGeneration/`
- `app/lib/openaiRepairServices/`
- `app/lib/publishPipeline/`

This document does not record prompts, models, credentials, or environment values.

### Supabase

Supabase integration is server-only through the admin client.

The current generation route performs a non-fatal Supabase smoke check.

Relevant paths:

- `lib/supabaseAdmin.ts`
- `app/api/generate-crossword/route.ts`

No broader persistence ownership is documented here unless established by current source.

### Browser Storage

Client-side browser storage is used for generated crossword handoff and play progress where currently implemented.

Relevant paths:

- `app/generar/page.tsx`
- `app/jugar/preview/page.tsx`
- `app/jugar/pro/page.tsx`
- `app/jugar/ahora/page.tsx`

## Current Grid Model

The current generation route uses a fixed 11x11 generation size.

Grid size is not a current user-configurable product input in the primary generation flow. This is an implementation fact, not a permanent product invariant.

## Validation Boundary

The durable validation surface includes contract tests for the `generate-crossword` API boundary, module-level tests around major generation components, and the contract-test runner/configuration.

Relevant paths:

- `app/api/generate-crossword/route.contract.test.ts`
- module tests under `app/lib/`
- `scripts/run-contract-tests.mjs`
- `tsconfig.contract.json`

Baseline and evaluation scripts exist under `scripts/`, but this architecture document does not define their operational use.

## Architectural Ownership Summary

| Area | Primary ownership |
| --- | --- |
| Generation UI | `app/generar/page.tsx` and client validation helpers |
| HTTP/composition boundary | `app/api/generate-crossword/route.ts` |
| Answer preparation | route-level composition plus `openaiGeneration` and `answerPipeline` |
| Generation orchestration | `app/lib/generationPipeline/` |
| Construction | `cspOrchestration`, `gridConstruction`, `freeformBuilder`, `openingBuilder`, `legacyBuilder` |
| Recovery/repair | `bestPartial`, `themeFirstRescue`, `gridValidation`, `gridReconstruction`, `gridEnhancement`, `openaiRepairServices` |
| Publication | `app/lib/publishPipeline/` plus final route response composition |
| Preview/play | `app/jugar/preview`, `app/jugar/pro`, `app/jugar/ahora`, shared components |
| External services | API route client binding, `openaiGeneration`, `openaiRepairServices`, `publishPipeline`, `lib/supabaseAdmin.ts` |

## Architecture Documentation Rules

This document describes current architecture, not roadmap.

Implementation details belong in code.

`CURRENT_STATE.md` will hold temporary current-frontier information.

`ROADMAP.md` will hold authorized future direction.

Historical audits and plans are not architecture authority.
