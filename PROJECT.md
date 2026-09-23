# Wordynamo

## Product

Wordynamo is an AI-powered application for generating and playing themed
crossword puzzles.

The repository is a Next.js application. The project name in `package.json` is
`free-theme-crosswords`; Wordynamo is the product name used by the canonical
project documentation.

## Core Product Goal

Wordynamo generates playable AI-created crosswords from arbitrary
user-selected themes and supported languages.

Theme handling must remain domain-agnostic. A theme such as Argentina,
Megadeth, Tokyo, vegan foods, HIV, or carpentry is an example of user input,
not a production category.

Examples, benchmark themes, and historical fixtures must never become hardcoded
theme-specific rules, privileged vocabularies, defaults, scoring assumptions,
or production exceptions.

## Product Inputs

Durable product inputs are:

- theme
- language

English and Spanish are the currently intended product languages.

Additional languages are part of the durable product direction.

Grid size is not a current product input.

## Business Model

The durable business model is subscription access at US$9.99 per month.

A subscription allows one crossword generation per day.

This section records the product contract. It does not claim that subscription
billing or daily quota enforcement is currently implemented.

## Generation Economics

The cost of generating 30 crosswords must never exceed 50% of the US$9.99
monthly subscription price.

The aggregate cost ceiling is:

- US$4.995 per 30 generated crosswords.

The mathematically derived average across that 30-generation budget is:

- US$0.1665 per crossword.

The derived average is not automatically a hard individual-request cost ceiling.
The authoritative constraint is the aggregate 30-crossword cost ceiling unless
a future durable product decision establishes a stricter per-request rule.

This document does not define token budgets, provider pricing assumptions, or
model-specific cost controls.

## Crossword Reuse

Generated crosswords should be stored in a repository or store.

If another user later requests the same theme name in the same language, the
product should be able to reuse the previously generated crossword rather than
make another paid generation API request.

Reuse exists to avoid unnecessary regeneration and reduce API cost.

This section records a durable product requirement. It does not claim that
storage, lookup, cache keys, normalization, collision handling, versioning, or
cache invalidation are currently implemented.

## Current Product Surface

Verified current product capabilities include:

- collecting theme and language generation inputs from the user;
- generating a themed crossword through the application backend;
- presenting generated crossword content for preview or play;
- displaying crossword grids and clue lists in the user interface.

Future subscription, quota, storage, and reuse requirements are not listed here
as current capabilities unless current implementation evidence establishes
them.

## Product Invariants

- Arbitrary user-chosen themes must remain supported.
- Theme handling must remain generic and domain-agnostic.
- Fixture and example identities must never become privileged production rules.
- Benchmark themes remain tests or evaluation inputs, not product categories.
- Grid size is not a product input merely because the current implementation
  uses a fixed size internally.
- Technical refactoring serves the product; it does not redefine the product.

## Technical Identity

- Framework: Next.js App Router.
- Language: TypeScript.
- Package manager: npm, indicated by `package-lock.json`.
- Main runtime dependencies include Next.js, React, OpenAI SDK, Supabase JS,
  Zod, Zustand, and dotenv.
- Styling/tooling includes Tailwind CSS, PostCSS, ESLint, and TypeScript.
- The repository contains Vercel metadata in `.vercel`.
- Contract tests are run by `npm run test:contract`, which delegates to
  `scripts/run-contract-tests.mjs`.

## Canonical Documentation

The intended canonical project documentation system consists of:

- `PROJECT.md`: durable product identity, product contract, and documentation
  rules.
- `AGENTS.md`: operational rules for AI-assisted repository work.
- `ARCHITECTURE.md`: current architecture and module ownership.
- `CURRENT_STATE.md`: current verified implementation and validation state.
- `ROADMAP.md`: authorized future direction and sequencing.
- `DECISIONS.md`: durable product and technical decisions.

`PROJECT.md`, `AGENTS.md`, `ARCHITECTURE.md`, and `CURRENT_STATE.md` currently
exist as canonical documentation.

`ROADMAP.md` and `DECISIONS.md` may not exist yet. Their absence does not make
historical audit files canonical.

## Source of Truth

- Explicit durable product-owner requirements are authoritative for product
  intent and product constraints.
- Current repository code and configuration are authoritative for current
  implementation facts.
- A product requirement does not automatically mean the requirement is currently
  implemented.
- Canonical documentation describes product intent, architecture, current state,
  roadmap, and durable decisions.
- Historical audits, plans, and handoff documents are evidence and history; they
  are not automatically current truth.
- Conversational memory is not authoritative technical state.
- If repository evidence and documentation conflict, record the conflict instead
  of silently resolving it by assumption.
