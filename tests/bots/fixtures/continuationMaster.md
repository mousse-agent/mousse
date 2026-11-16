# Continuation prompt reference

`continuationMaster.json` was captured from the unmodified `origin/master` commit
`da8d8f5d111942d8993dcc8a231e31beee23c253`, not from the PR's implementation.
A temporary Vitest capture imported `BotEngine` from a detached worktree at that
commit and invoked its original `continuationPrompt` method with the inputs from
`continuationMatrix.ts`. Its receiver was a temporary bot fixture with no unknown
calls, subagents, or model override. No production source was copied onto the PR.

The committed test only reads the captured strings; it cannot regenerate them.
There are 65 reference prompts: 13 reasons × 5 additional-update kinds. Both
histories are compared with each reference (130 cells). A further 13 cases include
a live wait and a note, checking the captured reason opening before the wait and
remaining updates. No matrix cells are omitted.

The columns describe additions to a causal event. An answered question or wall
needed by the reason still exists in the `none` column. A matching answer column
shares that causal answer; it does not invent another open question or duplicate
an answer. `note and answer` uses the question answer; the wall-answer column is
separate. Master retains its own precedence when multiple inputs are present.
