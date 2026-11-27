# Working with subagents

Read this only when handing part of a task to a subagent or another session.

- Delegate work that is large and independent. A handful of edits, a lookup or a fix of a few lines is faster done directly.
- The brief gives the goal in one or two sentences, what is out of scope, the constraints, and pointers: the issue, the PR, the files by path, the plan's rules. Do not paste files. The subagent starts with none of your context, so a missing pointer costs it a search.
- One implementer per branch. A subagent starts no reviewers and no subagents of its own; review comes from you, after its report.
- Send a fix round back to the subagent that wrote the code while its session and checkout still exist. Start a fresh one only when they are gone, or when it has failed twice on the same finding. The fresh one gets the original brief, every later instruction, and the earlier report and branch.
- A subagent commits and pushes before its turn ends, and its report names the pushed commit. Work that is only committed is lost when a session restarts.
- Its report says what changed, which checks ran with their commands, and what is not done. No logs, diffs or step-by-step narration.
- You own what comes back. Read the diff before you repeat its summary.
- Work that outlasts a session keeps its state in the issue checklist and the task notes, not in the conversation.
