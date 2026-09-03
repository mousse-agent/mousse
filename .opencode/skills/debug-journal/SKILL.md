---
name: debug-journal
description: Use when the user says "fixed" or "fixed it" after a long debugging session. Appends one line about the root cause and the faster path to journal.md. Only for hard-won debugging, never features or trivial fixes.
---

# Debug Journal

When the user closes out a painful debugging fight with "fixed" (or
equivalent), record the lesson so the next encounter takes minutes.

## When this applies

- The user says the problem is fixed, AND
- the work was **debugging with real investigation** (dead ends, multiple
  hypotheses, non-obvious root cause).

Do NOT use for features, refactors, cleanups, or fixes that were obvious
within minutes. If it is ambiguous whether the fight qualifies, ask one
short question instead of guessing.

## What to do

Append exactly **one line** to `journal.md` in the project root (create the
file first if it is missing, with the header below). Never rewrite past
entries. Newest goes at the bottom.

File header (only when creating):

```markdown
# Debug journal — one line per hard-won lesson.
```

Line format (single line, human-readable):

```markdown
YYYY-MM-DD | <symptom> → <root cause> | next time: <shortcut>
```

- `<symptom>`: what it looked like from the outside, briefly.
- `<root cause>`: the true mechanism, precisely stated.
- `next time`: the check that would have found it fast — a concrete first
  move, not general advice.

Use today's date (UTC). Keep the whole line under ~280 characters so the
file stays scannable. No code blocks, no paragraphs, no commentary outside
the line.
