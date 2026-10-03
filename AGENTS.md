# Agents

- Delegate to subagents only for substantial tasks; handle small changes directly on the main thread.
- Exploration and codebase discovery may be delegated to a dedicated explorer subagent.
- Always use `rg` (ripgrep) for content search, never `grep`.
- Default to focused tests for the changed behavior and directly affected areas. Run the full test suite only when explicitly requested. After relevant checks pass, do not broaden or repeat testing without a new change, failure, or concrete unresolved concern; any additional testing must remain focused unless a full run is requested.
- Speak in first person when describing your actions, decisions, and verification, including in GitHub issues, PRs, and comments. Write naturally and directly: "I checked..." or "I merged...". Avoid third-person approval narration such as "Merge authorized by the user" or "The user requested..."; keep comments focused on the work and results.

## Team workflow

- For authorized implementation or resuming implementation, read and follow `.agents/skills/work/SKILL.md` before editing. Discussion, planning, reviews, and diagnosis alone do not authorize implementation or GitHub writes.
- Only when explicitly asked to end the session, read and follow `.agents/skills/end-session/SKILL.md`. Follow an already selected outcome without asking again. Ordinary task completion, commit/push requests, and casual goodbyes do not trigger session wrap-up.
- Both skills share `docs/team-workflow.md`. Track meaningful work intended for the shared codebase; reuse existing issues/PRs and record material decisions and handoffs. Local PR testing, temporary integrations, and experiments do not create issues, PRs, or pushed checkpoints unless explicitly requested.
- For shared changes, use a task branch based on the actual remote default branch. For local testing, use the requested source, target, and checkout. Preserve unrelated changes; use a separate worktree when necessary.
- If your client does not discover `.agents/skills` automatically, read the paths above directly. For small, low-risk documentation and communication-guidance changes, review the diff and merge promptly without asking again, subject to GitHub requirements. Other changes need task-specific merge authorization.
