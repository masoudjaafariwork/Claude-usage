# Phase N — <Title>

| | |
| --- | --- |
| **Status** | Planned / ⏭️ Next / 🚧 In progress / ✅ Done (YYYY-MM-DD) |
| **Depends on** | Phase X (or "—") |
| **Size** | One Claude Code session |

## Goal

One or two sentences: what the user can do after this phase that they couldn't before.

## Background

Why this phase exists, relevant decisions from `docs/PROGRESS.md` (D-numbers), links to research.

## Scope

- [ ] Concrete deliverable 1
- [ ] Concrete deliverable 2

## Out of scope

What this phase deliberately does not do (and which phase/idea covers it instead).

## Technical notes

Research hints, APIs to use, platform caveats, risks and how to handle them.

## Acceptance criteria

- Observable, testable outcomes.
- `npm run check` passes; `npm run screenshot` reviewed for UI changes.
- `docs/PROGRESS.md`, `docs/BACKLOG.md` and this file's **Result** section updated.

## Manual test checklist (for the user)

- [ ] Step the user can perform to confirm it works.

## Prompt

Paste into a new Claude Code session opened in this repository:

```text
Implement Phase N of Claude Usage as specified in docs/phases/phase-N-<slug>.md.
Read CLAUDE.md, docs/PROGRESS.md and that phase file first. Follow its Scope, Out of scope,
Technical notes and Acceptance criteria. If something in the plan turns out to be wrong or
risky, stop and ask me before deviating. When done: fill in the phase file's Result section,
set its status, update docs/PROGRESS.md and docs/BACKLOG.md, and give me the manual test steps.
```

## Result

_Filled in when the phase is done: what was delivered, deviations from the plan and why,
follow-ups, and what was / wasn't verified._
