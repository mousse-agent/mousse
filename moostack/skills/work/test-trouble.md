# When the tests are the delay

Read this only when tests, not the change, are what is slowing the task: a test that fails some runs and passes others, a file that takes minutes, one change that breaks dozens of tests that all assert the same thing, or a test that fails on wording the change did not mean to touch.

You are allowed to deal with it. Decide which of three it is.

## Fix it now, in this PR

When the cause is clear and the fix is a few lines in a test this task touches or is blocked by:

- Loosen an assertion that fails on a harmless change: exact copy, a whole object, a class name, the order of mock calls ([test-the-claim](../test-the-claim/SKILL.md) section 5).
- Replace a sleep with a deferred promise or an awaited event.
- Close what a test leaves open: a process, a server, a timer, a temp folder.
- Delete a test that repeats a row an existing table already covers.

List these in the PR under Verification as "Tests changed that are not about this change", one line each with the reason.

## Hand it off, and keep going

When it is not a few lines, do not let it hold the task:

- **A flaky test whose cause is not found after one honest look.** Record it as a known failure ("Verify" in [work](SKILL.md)) with an issue, and start a separate task for the cause: a background subagent on its own branch following [debug](../debug/SKILL.md), or the issue alone when no subagent is available.
- **Heavy repetition or a slow file.** Many files asserting one behavior, or a file that boots the whole app per case. Start a separate task to cut it down, with [test-the-claim](../test-the-claim/SKILL.md) sections 5 and 7 as its brief. It deletes or merges tests in its own PR, where the diff is only that.

A handed-off task works on its own branch and stays out of the files this task is changing. Brief it as [subagents](subagents.md) says.

## Never, in any PR

- Skip or delete a test that fails for a reason you have not found.
- Raise a timeout or add retries to get a pass.
- Weaken an assertion about the thing the PR claims.
- Mark a failure as known without showing that it fails on the default branch too.
