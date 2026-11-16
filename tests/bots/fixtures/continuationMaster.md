# Continuation prompt reference

`continuationMaster.json` was captured from the unmodified `origin/master` commit
`da8d8f5d111942d8993dcc8a231e31beee23c253`, not from the PR's implementation.
A temporary Vitest capture imported `BotEngine` from a detached worktree at that
commit and invoked its original `continuationPrompt` method with the inputs from
`continuationMatrix.ts`. Its receiver was a temporary bot fixture with no unknown
calls, subagents, or model override. No production source was copied onto the PR.

The committed test only reads the captured strings; it cannot regenerate them.
There are 65 reference prompts: 13 reasons × 5 additional-update kinds. Both
histories are compared with each reference (130 cells). A further 65 cases cross the same reasons and updates with a live wait, checking
the captured reason opening before the wait and remaining updates (195 cells in
all). No matrix cells are omitted in that original capture.

The columns describe additions to a causal event. An answered question or wall
needed by the reason still exists in the `none` column. A matching answer column
shares that causal answer; it does not invent another open question or duplicate
an answer. `note and answer` uses the question answer; the wall-answer column is
separate. Master retains its own precedence when multiple inputs are present.


The two additional reasons (a permission allowed since refusal, and the owner's words
instead of a wall answer) were captured from unmodified master
`8b847e47cc7885a5759c14678e74c2d954d92fe3`, in a detached worktree, by the same
prototype-call technique. Their live-wait prompts were captured too. These guard
master's existing behavior without a pending action update; they do not silently
regenerate from the PR's builder. All 15 reasons cross every update column and both
histories, plus live waits (225 cells). Action outcomes add 420 cells: seven outcomes
(including a server's error versus a refusal before dispatch), pending versus causal,
both wait histories, the turn cap and both additional reasons, and all five update
columns. Those assert that action context, notes, question answers, wall answers and
the owner's words each arrive once. Their outcome text comes from the same stored
outcome reader that the engine uses.
