# Roadmap

## Purpose

This document records Wordynamo's authorized future product direction.

It describes product outcomes and milestone sequencing. It does not prescribe
technical solutions, create implementation tasks, or revive historical
refactoring agendas.

Within each milestone, implementation should be investigated only when that
milestone is active. Technical changes require evidence that they serve the
active product outcome or separate explicit authorization.

## Sequencing

Milestones are ordered product direction.

Milestone 1 is the active next product-development frontier once the current
documentation reorganization is closed.

Later milestones should not distract from core-generator development. A later
milestone may receive narrowly necessary preparatory work only when explicitly
authorized.

Completion of one milestone does not automatically authorize unrelated cleanup,
rewrites, modularization, or refactoring.

## Milestone 1 - Core Generator

Outcome: Wordynamo can generate acceptable playable crosswords for genuinely
new, arbitrary user-selected themes in the currently intended languages,
English and Spanish.

The generator must achieve this without theme-specific repositories, fixtures,
vocabulary, exceptions, prepared material, or privileged treatment for examples
used during development.

Current status: this outcome is not currently achieved.

Substantial generator-quality development remains. Historical moderately
acceptable results from practice themes do not establish generalization because
those themes had theme-specific supporting material. Runtime quality after the
fixture-contamination cleanup is currently unverified.

Development must test against genuinely unseen themes. A theme used to develop,
tune, debug, or evaluate behavior cannot by itself demonstrate generalization.

Testing is part of iterative generator development, not a substitute for the
development known to remain.

Fixture contamination must not be reintroduced.

This milestone does not prescribe algorithms, prompts, OpenAI models, CSP
changes, route changes, module extraction, data structures, repositories, or
refactors.

Exit direction: this milestone ends only when there is credible evidence that
the generic generator produces acceptable playable themed crosswords across
genuinely unseen themes in English and Spanish.

No durable numerical success threshold has been established here.

## Milestone 2 - Persistence and Reuse

Outcome: accepted generated crosswords can be stored and reused so that a
request for the same theme name and same language can use an existing crossword
instead of requiring another paid generation.

Storage and reuse are durable product requirements.

Current canonical state does not establish storage or reuse as implemented.

The exact semantics of "same theme name" are intentionally undecided at the
roadmap level.

Normalization, collisions, versioning, invalidation, schema, storage
technology, and related behavior are implementation decisions for this
milestone, not roadmap decisions.

## Milestone 3 - Generation Economics

Outcome: Wordynamo can measure and operate within the durable generation
economics constraint in `PROJECT.md`.

The cost of generating 30 crosswords must never exceed 50% of the US$9.99
monthly subscription price.

The aggregate ceiling is US$4.995 per 30 generated crosswords.

The derived average is US$0.1665 per crossword across that 30-generation
budget.

The derived average is not automatically a hard per-request ceiling.

Real cost must be measured rather than assumed.

Reuse from Milestone 2 may contribute to product economics.

This milestone does not assume provider pricing, choose models, invent token
budgets, or prescribe optimization techniques.

## Milestone 4 - Accounts, Subscription, and Daily Entitlement

Outcome: the commercial product supports subscription access and daily
generation entitlement.

The durable business requirements are:

- US$9.99/month subscription.
- subscriber or account state sufficient to enforce product access.
- one crossword generation per subscribed user per day.

This milestone does not select a payment provider, authentication provider,
database design, or billing architecture. Those are implementation decisions
when this milestone becomes active.

## Milestone 5 - Production Readiness

Outcome: validate the complete product behavior before launch.

At a high level, this includes verifying integrated behavior for:

- arbitrary-theme generation;
- English and Spanish generation;
- playable crossword delivery;
- persistence and reuse;
- generation economics;
- account and subscription state;
- daily generation entitlement;
- failure handling across the user flow.

This milestone is intentionally high-level and is not a detailed QA checklist.

## Historical Technical Items

The following are not roadmap items merely because they exist in current source
or prior audits:

- `prepareAttemptAnswers`;
- generic clue/answer separation;
- `legacyBuilder`;
- `getDemoCrossword`;
- multi-size residue;
- route modularization;
- historical extraction work.

They may be changed in the future only if evidence shows the change serves an
authorized product outcome or the product owner explicitly authorizes separate
work.

## Document Relationships

- `PROJECT.md`: durable product contract.
- `AGENTS.md`: operating rules for AI-assisted work.
- `ARCHITECTURE.md`: current architecture.
- `CURRENT_STATE.md`: verified current frontier and unresolved state.
- `ROADMAP.md`: authorized future product direction.

