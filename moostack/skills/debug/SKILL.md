---
name: debug
description: Find the cause of a bug, a failing test or behavior nobody can explain, before fixing it. Use when the cause is not known after a first look, when a fix did not work, or when a failure comes and goes.
---

# Debug

A fix written before the cause is known is a guess. Guesses are how one bug takes five PRs. Find the cause first; the fix is usually small once it is known.

Read `journal.md` at the repository root first. It lists causes that already cost a long session, with the faster path to each.

## 1. Reproduce it

- Reproduce at the layer where the person saw it: the screen, the CLI, the file on disk ([test-the-claim](../test-the-claim/SKILL.md) section 6). Reduce it to the fewest steps that still fail.
- The goal is one command that fails every time. That command is how you test every later idea, and it becomes the test.
- A failure that comes and goes: find what makes it frequent (run it in a loop, add load, change the order) and record the rate, such as "fails 3 of 20". A fix is then judged against that rate, not against one lucky pass.
- If it cannot be reproduced, collect what is missing (the logs, the exact build, the data) before forming a theory. Check that it still happens on the latest default branch.

## 2. Write down what you know

Three short lists:

- **Observed:** facts, each with where it came from. No conclusions.
- **Changed recently:** commits in the area, dependencies, configuration.
- **Candidate causes:** each with what you would see if it were true, and what you would see if it were false.

## 3. Cut the candidates in half

Choose the check that rules out the most candidates, not the one that confirms your favourite.

- **Across commits:** `git bisect` with the reproduction, when it worked before.
- **Across the path:** look at the data where two layers meet. Is it already wrong here? That halves the code to read.
- **Across the input:** remove half of it and see whether the failure remains.

Change one thing at a time, and write each result next to the candidate it ruled out.

## 4. When to stop and change course

- **Two fixes failed.** The assumption they shared is wrong. Write it down and test it directly before a third.
- **Three checks in a row ruled nothing out.** Change the method: add logging where layers meet, or bisect. Or give the reproduction and the observed facts to a fresh subagent without your theory.
- **The fix is a retry, a longer timeout, a sleep or a caught error.** That hides the cause. It is a fix only when the state it handles is legitimate.

## 5. Fix it where it first went wrong

- Fix the first place the system went wrong, not the place where it showed.
- The reproduction becomes the test, and it fails without the fix. Add the sibling inputs now ([test-the-claim](../test-the-claim/SKILL.md) section 4), not in the next PR.
- Remove the logging you added.
- The PR says what the cause was and how it was found, in two lines.

After a long session, [debug-journal](../debug-journal/SKILL.md) records the cause in one line for the next person.
