# Current State

## Snapshot

- Branch: `main`
- HEAD: `66d58b1 Align current state with product contract`
- Relation to `origin/main`: `main` is ahead by 36 commits.
- Tracked working tree: clean.
- Canonical docs currently present and tracked:
  - `PROJECT.md`
  - `AGENTS.md`
  - `ARCHITECTURE.md`
  - `CURRENT_STATE.md`

The ahead-of-origin count is Git state only. It is not an application-health or
deployment-health claim.

## Product State

Wordynamo currently generates themed crossword puzzles from user-provided theme
and language inputs.

The primary generation boundary is:

- `/api/generate-crossword`

The primary generation flow currently uses a fixed 11x11 generation size
internally. Grid size is not a current user-configurable product input.

The modular generation architecture is documented in `ARCHITECTURE.md`.

PRODUCT-OWNER-VERIFIED HISTORY: the generator has not yet demonstrated
acceptable, genuinely general arbitrary-theme crossword generation. Historically
moderately acceptable outputs depended on practice themes with
theme-specific repositories, fixtures, or material; genuinely unseen themes did
not produce acceptable results.

UNVERIFIED CURRENT RUNTIME: runtime quality after the Theme Independence /
Fixture Contamination cleanup has not been re-evaluated.

`PROJECT.md` now defines additional durable business and product requirements.
Their implementation status was not verified during this documentation
reorganization.

## Completed / Verified Frontier

The current implementation frontier includes the completed generation-pipeline
extraction and the route-local Theme Independence / Fixture Contamination
cleanup.

Important current commits:

- `5f69be8 Extract generation pipeline`
- `3bd7c79 Remove route fixture contamination`
- `93f1e67 Establish canonical project foundation`
- `47a2cdc Document current architecture`
- `794cf68 Document current project state`
- `fd5bb8c Define durable product contract`
- `66d58b1 Align current state with product contract`

The canonical documentation foundation currently consists of `PROJECT.md`,
`AGENTS.md`, `ARCHITECTURE.md`, and `CURRENT_STATE.md`.

`fd5bb8c` is documentation and product-contract work. It is not evidence that
the newly documented business requirements are implemented.

The Theme Independence / Fixture Contamination cleanup removed a known source
of fixture contamination, but it does not itself establish acceptable
arbitrary-theme generation quality.

## Validation Status

At the validated implementation frontier for
`3bd7c79 Remove route fixture contamination`:

- `npm.cmd run test:contract` - PASS - 10/10
- file-scoped ESLint - PASS - for:
  - `app/api/generate-crossword/route.ts`
  - `app/api/generate-crossword/route.contract.test.ts`
- `npx.cmd tsc --noEmit` - PASS

The commits after that validation were documentation-only:

- `93f1e67 Establish canonical project foundation`
- `47a2cdc Document current architecture`
- `794cf68 Document current project state`
- `fd5bb8c Define durable product contract`
- `66d58b1 Align current state with product contract`

These checks do not establish repository-wide lint status, runtime generation
quality, generation benchmark results, or external-service runtime behavior.

## Known Current Boundaries

- Theme and language are current product inputs.
- Grid size is not a current configurable product parameter.
- The current generation implementation uses fixed 11x11 generation internally.
- Fixture or example identities must not become production rules.
- Historical audit and plan files are not canonical current truth.
- Current implementation facts are authoritative over historical notes.

Temporary implementation facts should not be treated as permanent product
decisions unless recorded as durable decisions.

## Core Generator Maturity

Product goal: acceptable playable crosswords for arbitrary user-selected themes.

Known historical product status: NOT YET ACHIEVED.

PRODUCT-OWNER-VERIFIED HISTORY: moderately acceptable results historically
depended on practice-theme-specific repositories, fixtures, or material.
Genuinely unseen themes did not produce acceptable results, so those historical
results did not establish arbitrary-theme generalization.

UNVERIFIED CURRENT RUNTIME: runtime quality after the current cleanup has not
been re-evaluated.

Development status: substantial generator-quality work remains before the core
product goal is achieved.

Future generator work is authorized at the product-outcome level: improving the
genuinely generic generator. This does not automatically authorize any specific
technical remedy, including further route modularization,
`prepareAttemptAnswers` extraction, `legacyBuilder` removal,
`getDemoCrossword` removal, multi-size cleanup, additional clue/answer
extraction, or any other historical refactor.

## Product Contract / Implementation Gap

`PROJECT.md` is authoritative for the durable product contract. The statuses
below were not investigated during this reorganization.

| Verified product requirement | Current implementation status |
| --- | --- |
| US$9.99/month subscription | UNVERIFIED |
| One crossword generation per day | UNVERIFIED |
| Generation economics ceiling | UNVERIFIED |
| Generated-crossword storage | UNVERIFIED |
| Same-theme-name + same-language reuse | UNVERIFIED |

UNVERIFIED does not mean definitely absent, broken, unfinished, or authorized next work.

`ROADMAP.md`, if created, will determine which verified product gaps become
authorized future work.

## Unfinished / Unresolved

The items below record previously identified areas that may matter to future
work. Presence in current source does not equal a defect, and inclusion here
does not authorize work.

`ROADMAP.md`, if created, is the authority for authorized future direction.

### `prepareAttemptAnswers` boundary

Current condition: VERIFIED PRESENT

Evidence: `prepareAttemptAnswers` remains route-level composition in
`app/api/generate-crossword/route.ts`, and `GenerationPipelineDependencies`
still receives it as a prepared-attempt service.

Future-work status: UNVERIFIED / REQUIRES REASSESSMENT

Current classification: route-bound composition remains present. Whether it
should be extracted or changed is not established here.

### Further separation of generic clue/answer mechanisms

Current condition: UNVERIFIED / REQUIRES REASSESSMENT

Evidence: current source contains modular owners such as
`app/lib/openaiGeneration/`, `app/lib/answerPipeline/`, and
`app/lib/publishPipeline/`.

Future-work status: UNVERIFIED / REQUIRES REASSESSMENT

Current classification: no deep reassessment was performed, so no unfinished
extraction claim or current need for further separation is made here.

### Explicitly legacy, demo, or dead residue

Current condition: VERIFIED PRESENT

Evidence: current tracked source still contains `app/lib/legacyBuilder/` and a
route-level `getDemoCrossword` function.

Future-work status: UNVERIFIED / REQUIRES REASSESSMENT

Current classification: these names indicate legacy/demo boundaries are present.
Whether they are dead, should be removed, or represent technical debt requiring
action has not been audited here.

### Historical multi-size implementation residue

Current condition: VERIFIED PRESENT

Evidence: the primary generation flow fixes generation to 11x11, while current
tracked source still contains size-related branches and types in generation
support code.

Future-work status: UNVERIFIED / REQUIRES REASSESSMENT

Current classification: historical size-related implementation residue is
present. Whether it should be removed, retained, or simplified was not reassessed here.

## Local / Non-Canonical Material

The working tree contains unrelated untracked local or historical material.

Observed categories include:

- historical audit and plan documents under `docs/`
- generated or temporary contract/CSP material
- Next.js development logs
- local diagnostic API endpoints
- local data or support files
- local smoke-test script

These files are not part of the tracked canonical state.

Their presence does not make them authoritative.

They have not been reconciled, deleted, adopted, or classified as canonical.

## Unverified

- Runtime generation quality after the fixture-contamination cleanup remains
  UNVERIFIED; this is distinct from the product-owner-verified history that
  acceptable arbitrary-theme generalization has not yet been demonstrated.
- External-service behavior has not been exercised during this documentation
  reorganization.
- Product-contract implementation gaps are recorded as UNVERIFIED.
- Historical unresolved items have not all been reassessed against current code.
- Untracked local material has not been reconciled.
- No deployment state is verified by this file.

## Resume Protocol

1. Read `PROJECT.md`.
2. Read `AGENTS.md`.
3. Read `ARCHITECTURE.md`.
4. Read `CURRENT_STATE.md`.
5. Consult `ROADMAP.md` only if it exists and contains authorized work.
6. Verify Git status and HEAD before modifying anything.
7. Do not resume work from historical audit files unless current canonical state
   explicitly authorizes it.
8. When core-generator development resumes, start from the product outcome in
   `PROJECT.md` and the generator-maturity status here, not from an old
   refactoring agenda by default.
