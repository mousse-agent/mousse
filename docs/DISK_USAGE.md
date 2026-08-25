# Disk usage and retention

Mousse agent worktrees share Git objects and, when available, the repository's root
`node_modules`. Discovery-first agents use sparse checkouts containing their declared edit
files plus the transitive dependency/dependent blast radius. This avoids copying unrelated
tracked files or installing an identical dependency tree for every worker.

Packaging commands delete the reproducible `release/` staging tree before building. This
prevents unpacked applications and installers from older builds accumulating indefinitely.
The cleanup is deliberately restricted to `<project>/release`; it never removes `tmp/`,
source, dependencies, user projects, conversations, recoverable agent branches, or Mousse
runtime data.

`tmp/` is user/developer-owned and has no automatic retention policy. Remove its contents
manually only after verifying they are no longer needed. Runtime worktree cleanup remains
reference-aware and refuses dirty worktrees; see `WorkspaceGcService`.

Run `npm run disk:report` for a read-only category report. Symbolic links are not followed,
so a shared worktree dependency tree is counted once instead of once per agent.
