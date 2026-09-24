# Current State

## Snapshot

- Branch: `main`
- Current checkpoint: `Record dependency security review`
- Relation to `origin/main`: synchronized after the checkpoint commit is pushed.
- Tracked working tree: clean.
- Canonical docs currently present and tracked:
  - `PROJECT.md`
  - `AGENTS.md`
  - `ARCHITECTURE.md`
  - `CURRENT_STATE.md`
  - `ROADMAP.md`

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

The `/api/generate-crossword` route currently treats Supabase as a non-fatal
smoke/health-style check. The optional Supabase smoke dependency no longer
requires Supabase environment variables during route-module import or build
evaluation.

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
- `c25b98c Record core generator maturity`
- `b4469fe Establish product roadmap`
- `fcd6590 Ignore local generated artifacts`
- `Fix optional Supabase build dependency` checkpoint
- `Upgrade Next.js security patch` checkpoint
- `Record successful production deployment` checkpoint
- `95e6b4b Apply non-breaking dependency security updates`
- `Record dependency security review` checkpoint

The canonical documentation foundation currently consists of `PROJECT.md`,
`AGENTS.md`, `ARCHITECTURE.md`, `CURRENT_STATE.md`, and `ROADMAP.md`.

`fd5bb8c` is documentation and product-contract work. It is not evidence that
the newly documented business requirements are implemented.

The Theme Independence / Fixture Contamination cleanup removed a known source
of fixture contamination, but it does not itself establish acceptable
arbitrary-theme generation quality.

The Supabase deployment/build fix makes the generation route's optional
Supabase smoke-client acquisition lazy and non-fatal. Missing Supabase
configuration no longer causes the verified `Collecting page data` build
failure for `/api/generate-crossword`.

Vercel production evidence for
`50e72fdd398375d737f4d6711421140f8d21ccb9 Fix optional Supabase build dependency`
confirmed that compilation, page-data collection, static generation, and build
output completion succeeded. That deployment then failed for a separate
dependency security gate: `Vulnerable version of Next.js detected, please
update immediately.`

The Next.js security checkpoint upgrades the dependency state from Next.js
`15.5.4` to `15.5.26` and `eslint-config-next` from `15.5.4` to `15.5.26`.
React and React DOM remain `19.1.0`.

Vercel production evidence for
`3d2987f0a8e84663d4eacc9ece4130c41a03eac4 Upgrade Next.js security patch`
confirmed deployment status `Ready`, environment `Production`, production
designation `Current`, source branch `main`, source commit `3d2987f`, and
deployment duration `1m 18s`. Build Logs and Deployment Summary completed
successfully, and production domains were assigned.

The Supabase build-time incident is CLOSED. The vulnerable-Next.js deployment
rejection is CLOSED. The deployment incident that paused Milestone 1 is CLOSED.

The non-breaking npm security remediation is COMPLETE. The user ran
`npm.cmd audit fix` without `--force`, and the resulting compatible remediation
was checkpointed as
`95e6b4b4d1810119c013b815af08a46b7f648023 Apply non-breaking dependency security updates`.
It changed only `package-lock.json`; direct dependency declarations did not
change. Next remains `15.5.26`, `eslint-config-next` remains `15.5.26`, React
and React DOM remain `19.1.0`, and no Next 16 migration was performed.

The current npm audit state has 2 remaining records: `1 moderate` and `1 high`.
Both records correspond to the same dependency chain:
`next@15.5.26` -> nested `postcss@8.4.31` -> PostCSS advisories. The top-level
PostCSS used by development tooling was updated to `8.5.28`.

The remaining Next/PostCSS chain is a known, monitored dependency-maintenance
item. `npm audit fix --force`, a Next 16 migration, package overrides, and
manual changes to Next internals are not part of the current remediation. Current
repository evidence did not establish application-level exposure through
attacker-controlled CSS or source-map processing; that is an exposure
observation, not proof of immunity.

The security-maintenance work no longer blocks Milestone 1. Milestone 1 may
resume, but it has not resumed yet.

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
- `c25b98c Record core generator maturity`
- `b4469fe Establish product roadmap`
- `fcd6590 Ignore local generated artifacts`

These checks do not establish repository-wide lint status, runtime generation
quality, generation benchmark results, or external-service runtime behavior.

For the Supabase deployment/build fix checkpoint:

- `npm.cmd run test:contract` - PASS - 12/12
- file-scoped ESLint - PASS - for:
  - `app/api/generate-crossword/route.ts`
  - `app/api/generate-crossword/route.contract.test.ts`
- `npx.cmd tsc --noEmit` - PASS
- production build with `SUPABASE_URL=''` and
  `SUPABASE_SERVICE_ROLE_KEY=''` - PASS

For the Next.js `15.5.26` security checkpoint:

- `npm.cmd run test:contract` - PASS - 12/12
- relevant ESLint - PASS - for:
  - `app/api/generate-crossword/route.ts`
  - `app/api/generate-crossword/route.contract.test.ts`
- `npx.cmd tsc --noEmit` - PASS
- `npm.cmd run build` - PASS - detected Next.js `15.5.26`, compiled,
  collected page data, generated static pages `12/12`, and completed the
  production build
- `git diff --check` - PASS, with harmless line-ending warnings only

The initial npm audit after the Next.js checkpoint reported 18 vulnerabilities:
`1 low`, `5 moderate`, `11 high`, and `1 critical`.

The compatible npm security remediation passed:

- `npm.cmd run test:contract` - PASS - 12/12
- relevant ESLint - PASS - for:
  - `app/api/generate-crossword/route.ts`
  - `app/api/generate-crossword/route.contract.test.ts`
- `npx.cmd tsc --noEmit` - PASS
- `npm.cmd run build` - PASS - detected Next.js `15.5.26`, compiled,
  collected page data, generated static pages `12/12`, and completed the
  production build
- `git diff --check` - PASS, with harmless line-ending warnings only

After that remediation, the current npm audit state is 2 records: `1 moderate`
and `1 high`, both representing the same Next-owned nested PostCSS chain. The
remaining chain has not been documented here as a confirmed exploitable
Wordynamo application vulnerability.

The build also emitted stale `baseline-browser-mapping` and
Browserslist/caniuse-lite warnings. Those warnings did not block the local
production build and are not active product-development work here.

## Known Current Boundaries

- Theme and language are current product inputs.
- Grid size is not a current configurable product parameter.
- The current generation implementation uses fixed 11x11 generation internally.
- Fixture or example identities must not become production rules.
- Historical audit and plan files are not canonical current truth.
- Current implementation facts are authoritative over historical notes.
- Supabase is currently a non-fatal smoke/health-style dependency in
  `/api/generate-crossword`; persistence and reuse are not documented here as
  implemented.

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

`ROADMAP.md` determines which verified product gaps become authorized future
work.

## Unfinished / Unresolved

The items below record previously identified areas that may matter to future
work. Presence in current source does not equal a defect, and inclusion here
does not authorize work.

`ROADMAP.md` is the authority for authorized future direction.

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

At this checkpoint, repository hygiene has removed the previously observed
untracked local, generated, diagnostic, and historical-audit material.

No untracked local material is part of the canonical state.

## Unverified

- Runtime generation quality after the fixture-contamination cleanup remains
  UNVERIFIED; this is distinct from the product-owner-verified history that
  acceptable arbitrary-theme generalization has not yet been demonstrated.
- External-service behavior has not been exercised during this documentation
  reorganization.
- Product-contract implementation gaps are recorded as UNVERIFIED.
- Historical unresolved items have not all been reassessed against current code.
- The remaining Next/PostCSS audit chain is a monitored maintenance item, not a
  current blocker to Milestone 1 under the evidence recorded here.

## Resume Protocol

1. Read `PROJECT.md`.
2. Read `AGENTS.md`.
3. Read `ARCHITECTURE.md`.
4. Read `CURRENT_STATE.md`.
5. Consult `ROADMAP.md` for authorized future product direction.
6. Verify Git status and HEAD before modifying anything.
7. Do not resume work from historical audit files unless current canonical state
   explicitly authorizes it.
8. When core-generator development resumes, start from the product outcome in
   `PROJECT.md` and the generator-maturity status here, not from an old
   refactoring agenda by default.
