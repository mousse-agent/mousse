# Disk usage and retention

Mousse agent worktrees share Git objects and, when available, the repository's root
`node_modules`. Discovery-first agents use sparse checkouts containing their declared edit
files plus the transitive dependency/dependent blast radius. This avoids copying unrelated
tracked files or installing an identical dependency tree for every worker.

## New worktrees: parallel and sparse checkout

A thread's or subagent's new worktree is written by Git's parallel checkout (`checkout.workers=0`, one
worker per core) unless your Git config sets `checkout.workers` itself.

To give a large project's new worktrees only some of its paths, name a file of sparse-checkout
patterns in the project's Git config, and turn on Git's per-worktree settings so the sparse
checkout stays in Mousse's worktrees:

    git config extensions.worktreeConfig true
    git config mousse.sparseCheckout .mousse-sparse   # relative to the project's top folder, or absolute

The file holds one path per line (`#` starts a comment). Plain folder names use Git's faster cone
mode; a line with a pattern character (`*`, `?`, `[`, `!`, `\`) switches to Git's pattern mode.
Your own checkout of the project stays whole. A missing or empty file, or per-worktree settings
turned off, stops the new worktree before anything is made. If the file goes away later, a worktree
restored from its snapshot comes back whole.

## Packaging

Packaging commands delete the reproducible `release/` staging tree before building. This
prevents unpacked applications and installers from older builds accumulating indefinitely.
The cleanup is deliberately restricted to `<project>/release`; it never removes `tmp/`,
source, dependencies, user projects, conversations, recoverable agent branches, or Mousse
runtime data.

`tmp/` is user/developer-owned and has no automatic retention policy. Remove its contents
manually only after verifying they are no longer needed. Runtime worktree cleanup keeps a
worktree with uncommitted changes as it is, and removes a clean one only after keeping a copy of
what Git cannot write back; see `src/mms/worktree/verifiedCleanup.ts`.

Run `npm run disk:report` for a read-only category report. Symbolic links are not followed,
so a shared worktree dependency tree is counted once instead of once per agent.

## Old named agents

Named agents (created from the former Agents tab) no longer exist, and nothing creates new ones.
Data from earlier versions stays where it was: a task's `agent-episodes.json`, its saved agent
contexts, and the result branch of each isolated write episode. Lifecycle code still reads these
files, so Storage lists and protects the branches and trash and purge handle them like any other
task data. Nothing merges them automatically. To keep an old result, merge its retained branch by
hand, for example `git merge mousse/agent/<id>` from the project checkout (the branch name is in
`agent-episodes.json` under the episode's `binding.branch`, and `git branch --list "mousse/agent/*"`
shows what is left).
