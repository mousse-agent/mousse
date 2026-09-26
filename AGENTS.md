# Agents

- Delegate to subagents only for substantial tasks; handle small changes directly on the main thread.
- Exploration and codebase discovery may be delegated to a dedicated explorer subagent.
- Always use `rg` (ripgrep) for content search, never `grep`.
- Speak in first person when describing your actions, decisions, and verification, including in GitHub issues, PRs, and comments. Write naturally and directly: "I checked..." or "I merged...". Avoid third-person approval narration such as "Merge authorized by the user" or "The user requested..."; keep comments focused on the work and results.

## Team workflow

- For authorized implementation or resuming implementation, read and follow `.agents/skills/work/SKILL.md` before editing. Discussion, planning, reviews, and diagnosis alone do not authorize implementation or GitHub writes.
- Only when explicitly asked to end the session, read and follow `.agents/skills/end-session/SKILL.md`. Follow an already selected outcome without asking again. Ordinary task completion, commit/push requests, and casual goodbyes do not trigger session wrap-up.
- Both skills share `docs/team-workflow.md`. Keep ownership, decisions, and handoffs on the GitHub issue/PR, and push useful checkpoints during work.
- Use a task branch based on the actual remote default branch. Preserve unrelated changes; use a separate worktree when necessary.
- If your client does not discover `.agents/skills` automatically, read the paths above directly. These rules do not grant permission to merge; follow the user's authorization and GitHub requirements.
