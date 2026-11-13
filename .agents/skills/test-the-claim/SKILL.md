---
name: test-the-claim
description: Decide what to test for a change, at which level, and what not to write. Use before writing or changing tests for a feature or fix, and when reviewing a PR's tests. Complements docs/testing.md, which covers commands, fixtures and what must stay.
---

# Test the claim

A PR's title says what a person now sees or gets. The tests must fail when that sentence stops being true, and must not fail for anything else. A review of 450 merged PRs (November 2026) found the suite strong at the deciding module and weak in four places: the last hop to the screen, how things look, what external programs really do, and inputs nobody listed. This skill is about those four.

## 1. Start from the claim

Write the claim as the title will say it. For each part of it, name where a person would notice it broken: a file on disk, a row in a list, a button that does nothing, a message that never reaches the model. That place is the layer one test must observe. Tests below it are welcome; they do not replace it.

## 2. Pick the level from what the claim is about

| The claim is about | Test it by | Not by |
|---|---|---|
| A rule or decision | A table at the module that decides. List the inputs first (section 4), then write rows. | A daemon-booting file per branch. |
| Data on disk: git, undo, delete, storage | Real repository or store. Compare full state before and after (HEAD, index, refs, bytes). Add a control case that shows the danger is real, as `tests/gitNoAutoMaintenance.test.ts` does. | Asserting the arguments passed to git. |
| Ordering, races, restart | Real services in one process with only the provider scripted, and deferred promises to pick the interleaving, as `tests/run/leaseRaceQueuedSend.test.ts` does. A real kill only when death is the claim. | Sleeps, or reading private maps. |
| Something on screen that reacts | Mount the surface the person uses (the chat, the page, the dialog host) with the bridge stubbed. Click and type. Read text and roles. `tests/renderer/approvalNotice.test.ts` is the model. | Rendering a child with hand-built props, or matching an HTML string. |
| How something looks or where it sits: position, size, wrapping, colour, blur, motion | jsdom has no layout. Either a real-window test that reads rectangles or computed style (`tests/renderer/code-block-copy-electron.test.ts`), or no automated test and a real-app screenshot in the PR. | A regular expression over a `.css` or `.tsx` file. A class-name assertion. These pass when the screen is wrong and fail on a harmless restyle. |
| What Claude Code, Codex, Pi, Cursor or gh does | A recording from the real program with its version, or a gated live test (`tests/live/`, `tests/harness/piRpcSteerCut.test.ts`). A script written by hand is labelled `hand-authored` and proves only Mousse's side. The PR then says how the real program was checked. | Treating a hand-written script as evidence about the real program. |
| Speed or memory | Count the expensive thing (processes started, reads, renders), or compare the fast path against the slow one for equal results (`tests/contextGaugeRead.test.ts`). | A time or heap limit. |

## 3. Cross the last hop

Most gaps found were one line: the handler that calls the tested function, the parent that passes the prop, the mount in `App.tsx`, the preload method. After testing the helper, ask:

> If I delete the line that calls this, does any test fail?

If not, one test goes through that line. For a main-process handler, call the registered handler, not the function behind it.

## 4. List the inputs before the examples

The largest cause of repeat fixes was an input nobody wrote down: Discard, worktree cleanup, exact-bytes snapshots, delete and the lease wait each took four or five PRs, one new input at a time. Before writing cases for code that keeps or removes a person's data, or that orders work, write the list: file kinds (ignored, untracked, binary, symlink, line endings, filters), states (dirty, staged, mid-merge, locked), actors (a second process, a restart, a Stop), and orders. Put the list in the test file as the table's rows. A missing row is then visible in review.

## 5. Two questions for every test you keep

1. Which wrong change to the source fails this test? Name the line.
2. Which harmless change fails it? If there is an answer, loosen the test.

Usual answers to the second, and the remedy:

- Exact copy. Assert copy only when the wording is the claim; otherwise find the control by role or a stable id.
- A whole object or list of defaults (`toEqual`). Assert the fields the test is about.
- Class names, CSS values, source lines, line numbers, private fields, the order of mock calls. Assert the result instead, or drop the case.

## 6. Fixing a bug

- Reproduce it first at the layer where the person saw it, and see it fail. A test one layer down, at the changed line, comes second.
- If an existing test asserted the broken behaviour, say so in the PR and replace it. Tests that describe the current code instead of the intended behaviour cannot catch the bug they describe.
- Add the sibling inputs now (section 4), not in the next fix.
- A flaky test may be a real defect. Find the cause before adding a wait.

## 7. What not to write

- A test of a constant, or one that repeats the line above it.
- A second test of a rule already covered by a table row.
- A source-text test, except for a repository rule that has no behaviour to observe: an import boundary, a privacy ban, the no-GPU audit.
- More cases to reach a size. Half the PRs reviewed added more test lines than source lines; the count did not predict whether the claim was proved.

## 8. Before the PR

Run the named files for the changed code, as AGENTS.md says. Then find the tests that depend on what you changed without importing it: search `tests/` with `rg` for the copy, class, default or list entry you changed, and run those files too. About one PR in fifteen was a follow-up repairing tests that an earlier PR broke this way.

In the PR's Verification, write for each part of the claim which test observes it, and which parts are checked by hand or not at all. "Not tested: the button's position" is an acceptable line; a CSS regex in its place is not.
