# Agents

- Delegate to subagents only for substantial tasks; handle small changes directly on the main thread.
- Exploration and codebase discovery may be delegated to a dedicated explorer subagent.
- Always use `rg` (ripgrep) for content search, never `grep`.
- Default to focused tests for the changed behavior and directly affected areas. Run the full test suite only when explicitly requested. After relevant checks pass, do not broaden or repeat testing without a new change, failure, or concrete unresolved concern; any additional testing must remain focused unless a full run is requested.
- In GitHub issues, PRs, and comments, describe the change and the result, not the steps taken: "Sessions now restart when the model changes", "Tested on macOS and Linux". Most sentences need no actor. When one does (a decision, a verification result, a merge), use first person sparingly: "I merged this after the retry test passed." Never narrate requests or approvals in third person ("Merge authorized by the user", "The user requested...").
- Write issues, PRs, and comments in plain words for a teammate who has not seen the chat. Follow "Writing PRs and issues" in `docs/team-workflow.md` and use the terms in `docs/GLOSSARY.md`.

## Team workflow

- For authorized implementation or resuming implementation, read and follow `.agents/skills/work/SKILL.md` before editing. Discussion, planning, reviews, and diagnosis alone do not authorize implementation or GitHub writes.
- Only when explicitly asked to end the session, read and follow `.agents/skills/end-session/SKILL.md`. Follow an already selected outcome without asking again. Ordinary task completion, commit/push requests, and casual goodbyes do not trigger session wrap-up.
- Both skills share `docs/team-workflow.md`. Track meaningful work intended for the shared codebase; reuse existing issues/PRs and record material decisions and handoffs. Local PR testing, temporary integrations, and experiments do not create issues, PRs, or pushed checkpoints unless explicitly requested.
- For shared changes, use a task branch based on the actual remote default branch. For local testing, use the requested source, target, and checkout. Preserve unrelated changes; use a separate worktree when necessary.
- If your client does not discover `.agents/skills` automatically, read the paths above directly. For small, low-risk documentation and communication-guidance changes, review the diff and merge promptly without asking again, subject to GitHub requirements. Other changes need task-specific merge authorization.
