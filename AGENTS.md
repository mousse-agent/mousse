# Agents

- Delegate to subagents only for substantial tasks; handle small changes directly on the main thread.
- Exploration and codebase discovery may be delegated to a dedicated explorer subagent.
- Always use `rg` (ripgrep) for content search, never `grep`.
- While working, run focused tests for the changed behavior and directly affected areas. The pre-PR test rule lives only in "Verify" in `moostack/skills/work/SKILL.md`; run it through `node scripts/verify.mjs`. Hosted CI runs only basic checks.
- In GitHub issues, PRs, and comments, describe the change and the result, not the steps taken: "Sessions now restart when the model changes", "Tested on macOS and Linux". Most sentences need no actor. When one does (a decision, a verification result, a merge), use first person sparingly: "I merged this after the retry test passed." Never narrate requests or approvals in third person ("Merge authorized by the user", "The user requested...").
- Write issues, PRs, and comments in plain words for a teammate who has not seen the chat. Follow "Writing PRs and issues" in `docs/team-workflow.md` and use the terms in `docs/GLOSSARY.md`.

## Team workflow

- For authorized implementation or resuming implementation, read and follow `moostack/skills/work/SKILL.md` before editing. Discussion, planning, reviews, and diagnosis alone do not authorize implementation or GitHub writes.
- Reviews, audits, and diagnosis read the latest remote default branch. Run `git fetch` first; if the checkout is behind, read a detached worktree at the remote default branch instead, or state how many commits behind the reviewed code is. A finding about code the default branch has already changed or removed is not a finding.
- Before presenting a final plan or starting a substantial implementation, read and follow `moostack/skills/check-related-work/SKILL.md`. It only reads issues, PRs and branches.
- Before planning a new subsystem, a replacement for one, or a change to how parts of the system talk to each other, read and follow `moostack/skills/design/SKILL.md`. It ends in a design document and a decision, then hands to `slice`.
- Before starting work that will not fit one PR, read and follow `moostack/skills/slice/SKILL.md`. It plans slices that each merge on their own.
- When reviewing a PR, diff or plan, asking for a review, or answering review findings, read and follow `moostack/skills/review/SKILL.md`. One pass; a re-check reads only the fix.
- A council (several independent reviewers) runs only after the human agrees to it, for heavy core changes: `moostack/skills/council/SKILL.md`. Never start one on your own judgment.
- When asked for a retro, or why work took so long, read and follow `moostack/skills/retro/SKILL.md`.
- Before writing or changing tests for a feature or fix, and when reviewing a PR's tests, read and follow `moostack/skills/test-the-claim/SKILL.md`. It decides what to test, at which level, and what not to write.
- When asked to build, publish or install a nightly, read and follow `moostack/skills/nightly-build-release/SKILL.md`. It keeps fixing failures until a nightly is published.
- Before building, restyling or reviewing UI in `src/renderer`, read and follow `moostack/skills/mousse-ui/SKILL.md`.
- When the cause of a bug or a failing test is not known after a first look, a fix did not work, or a failure comes and goes, read and follow `moostack/skills/debug/SKILL.md` before trying another fix.
- When the user says "fixed" or "fixed it" after a long debugging session, follow `moostack/skills/debug-journal/SKILL.md`.
- When adding, retiring or re-tiering models in `src/mms/models/models.json`, or changing its `namingProviders`, read and follow `moostack/skills/update-model-catalog/SKILL.md`.
- To post screenshots or videos on a PR or issue, follow `moostack/skills/gh-attach-images/SKILL.md`. Never commit them to the repository.
- Only when explicitly asked to end the session, read and follow `moostack/skills/end-session/SKILL.md`. Follow an already selected outcome without asking again. Ordinary task completion, commit/push requests, and casual goodbyes do not trigger session wrap-up.
- These skills share `docs/team-workflow.md`. Track meaningful work intended for the shared codebase; reuse existing issues/PRs and record material decisions and handoffs. Local PR testing, temporary integrations, and experiments do not create issues, PRs, or pushed checkpoints unless explicitly requested.
- For shared changes, use a task branch based on the actual remote default branch. For local testing, use the requested source, target, and checkout. Preserve unrelated changes; use a separate worktree when necessary.
- Skills live in `moostack/skills/<name>/` (listed in `moostack/README.md`). No client discovers that folder on its own, so read the paths above directly. For small, low-risk documentation and communication-guidance changes, review the diff and merge promptly without asking again, subject to GitHub requirements. Other changes need task-specific merge authorization.
