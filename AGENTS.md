# AGENTS.md

Operational rules for AI-assisted development in the Wordynamo repository.

## Source of Truth

- Inspect repository state before assuming it.
- Repository files and canonical docs outrank conversational memory.
- Current code and configuration are authoritative for implementation facts.
- Historical audits and plans are evidence, not automatically current truth.
- When reconstructing uncertain state, label claims as `VERIFIED`,
  `INFERENCE`, or `UNVERIFIED`.
- Never invent project state, validation status, file contents, or Git history.

## Scope Control

- Every implementation task must have a specific objective.
- Define scope and non-goals before changing code when the task is substantial.
- Discovery is not authorization to modify adjacent systems.
- Do not modify adjacent systems without explicit authorization.
- Record out-of-scope findings without pursuing them.
- Stop when acceptance criteria are satisfied.
- Do not continue into a next phase unless explicitly asked.

## Change Discipline

- Prefer the smallest change that solves the authorized problem.
- Do not redesign working systems incidentally.
- Do not create speculative infrastructure.
- Do not perform unrelated cleanup.
- Do not add dependencies unless explicitly authorized.
- Do not turn fixtures, examples, benchmark themes, languages, or local test
  cases into production rules.
- Avoid large multi-domain changes.
- Preserve behavior unless the task explicitly authorizes behavior changes.
- If preserving behavior requires an architectural decision not covered by the
  task, stop and report the boundary.

## File Discipline

- Prefer modifying existing appropriate modules over creating unnecessary files.
- Do not create audit, plan, or report files unless explicitly requested.
- Reports should normally be returned in chat, not persisted.
- Avoid creating oversized source files.
- If a task appears to require a large new monolithic file or broad rewrite,
  stop and report before implementing.
- Do not modify historical documentation unless the task explicitly says to do
  so.
- Do not create duplicate sources of truth.

## Validation

- Define validation before implementation when practical.
- Run the narrowest relevant existing tests first.
- Use repository-declared commands and configurations.
- Do not interpret environment or tool invocation failures as application
  failures.
- Distinguish `PASS`, `FAIL`, and `BLOCKED`.
- Do not fix unrelated failures.
- Do not run broad or expensive validation unless it is required by the task.
- Verify Git state after changes.

## Git Safety

- Inspect `git status` before staging or committing.
- Never use broad staging commands when unrelated or untracked files are present.
- Stage explicit authorized paths.
- Never commit unrelated changes.
- Never push unless explicitly authorized.
- Do not clean, delete, rename, or normalize untracked material without explicit
  authorization.
- If staging or committing requires elevated permissions, keep the operation
  limited to the authorized paths and action.

## Documentation Discipline

- Canonical docs should be updated rather than replaced with new overlapping
  docs.
- Historical reports do not become canonical automatically.
- Avoid duplicate sources of truth.
- `CURRENT_STATE.md` should describe current reality, not project history.
- `ROADMAP.md` should contain authorized future direction, not every discovered
  idea.
- `DECISIONS.md` should record durable decisions, not routine implementation
  details.
- `PROJECT.md` should stay product-level and should not become an architecture
  inventory.
- `AGENTS.md` should stay operational and should not become a project roadmap.

## Task Contract

Substantial future Codex tasks should normally define:

```text
TASK
OBJECTIVE
VERIFIED CONTEXT
SCOPE
NON-GOALS
ACCEPTANCE CRITERIA
VALIDATION
STOP CONDITION
```

If the task omits one of these sections, infer only what is safe from repository
evidence and the user's explicit request.

## Completion Report

Future Codex implementation tasks should normally return:

```text
RESULT
FILES CHANGED
VALIDATION
OUT-OF-SCOPE OBSERVATIONS
UNVERIFIED ITEMS
```

For read-only tasks, report commands used and avoid implementation-oriented
recommendations unless requested.

For commit tasks, report the exact committed files, commit hash, post-commit
status, and whether a push was performed.
