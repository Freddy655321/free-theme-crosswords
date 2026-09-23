# Wordynamo

## Product

Wordynamo is a Next.js application for generating and playing themed crossword
puzzles.

The repository exposes a generation endpoint at `app/api/generate-crossword`
and user-facing App Router pages for generating and playing puzzles.

The project name in `package.json` is `free-theme-crosswords`; Wordynamo is the
product name used by the project documentation.

## Core Product Goal

Wordynamo's durable product goal is to generate playable themed crosswords from
a user-provided theme and language.

The generator should treat benchmark themes and historical examples as test
fixtures or evaluation inputs, not as production rules.

## Current Product Surface

Verified product capabilities include:

- collecting crossword generation inputs from the user;
- generating a themed crossword through the application backend;
- presenting generated crossword content for preview or play;
- displaying crossword grids and clue lists in the user interface.

## Product Invariants

- Theme handling must remain generic: product behavior should not depend on
  recognizing historical fixture identities.
- Examples such as bands, places, cuisines, countries, or benchmark themes must
  not become privileged production categories by accident.
- Fixture and evaluation themes may exist in tests, documentation, or benchmark
  matrices, but they are not product rules unless a durable product decision
  explicitly says so.

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

- `PROJECT.md`: durable product identity, product goals, and documentation rules.
- `AGENTS.md`: operational rules for AI-assisted repository work.
- `ARCHITECTURE.md`: current architecture and module ownership.
- `CURRENT_STATE.md`: current verified implementation and validation state.
- `ROADMAP.md`: authorized future direction and sequencing.
- `DECISIONS.md`: durable product and technical decisions.

`ARCHITECTURE.md`, `CURRENT_STATE.md`, `ROADMAP.md`, and `DECISIONS.md` may not
exist yet. Their absence does not make historical audit files canonical.

## Source of Truth

- Current repository code and configuration are authoritative for implementation
  facts.
- Canonical documentation describes product intent, architecture, current state,
  roadmap, and durable decisions.
- Historical audits, plans, and handoff documents are evidence and history; they
  are not automatically current truth.
- Conversational memory is not authoritative technical state.
- If repository evidence and documentation conflict, record the conflict instead
  of silently resolving it by assumption.
