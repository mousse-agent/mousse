# Workspace feature validation

Implemented locally with subagents; no pushes or live GitHub create/clone operations were used during validation.

## Coverage

- HTTP(S) chat/plan/preview links open the built-in Browser view. Provider sign-in links retain their existing authentication behavior.
- Files keeps multiple subtabs mounted across action-tab switches, scoped by profile/project/thread.
- Text edits autosave after a debounce, with serialized writes, retry errors, and explicit disk/local conflict choices. The Save button is removed.
- Editor language selection uses the document extension and available Monaco language profiles.
- Open documents revalidate against disk every two seconds. Dirty editors retain local content on detected conflicts.
- File links support `mousse-file://open?path=<encoded>&line=42&column=7`, plus common Markdown path/line targets. Existing workspace path guards remain enforced.
- Project, thread, file-tree, file-subtab, terminal, browser, and agent drags attach titled blue references. Project/thread metadata paths are resolved by the active-profile daemon before attachment and send. References survive message serialization and render in both chat implementations.
- Git's non-repository view offers GitHub CLI availability/authentication feedback, create, and clone-to-empty-folder flows. Creation does not push commits.
- Terminal fitting skips hidden/zero-sized hosts and deduplicates PTY resize requests, preserving native scrollback behavior.

See [chat-links-and-references.md](chat-links-and-references.md) for link and drag payload contracts.

## Automated validation

- TypeScript node/renderer typecheck: passed.
- Production Electron/renderer/CLI build: passed.
- Focused feature/protocol/Markdown/attachment regression suites: 83 tests passed across 14 suites (see `tmp/feature-focused-tests.log`).
- Broader non-platform run: 992 tests passed; one CLI-launch test failed because this workspace inherited `MOUSSE_CLI`. That test passed when rerun with `MOUSSE_CLI` unset. See `tmp/feature-core-tests.log`.
- The unrestricted full suite exceeded the 300-second command limit and reported failures in browser/workflow integration suites. It is **not** recorded as passing; see `tmp/feature-integration-tests.log`.
- Editor cross-feature and profile workspace checks passed separately. A stale Markdown editor FilesPanel source-shape assertion was updated for the new per-file state model; that suite passed in the final focused run.

## Manual acceptance still recommended

1. Open several file subtabs, switch among Git/Browser/Terminal/Agents, and return. Verify explicit close, selection, previews, and syntax colors.
2. Type quickly while switching file tabs; verify saved bytes. Modify an open document externally, then repeat while it has local changes and exercise both conflict choices.
3. Click web and file/line links in agent output and plan content. Verify the active workspace and requested line.
4. Drag each supported resource into both chat composers; remove one, send an attachment-only message, and revisit the thread. Verify metadata paths in model context and titled links in the sent message.
5. Run a high-output terminal process, scroll upward, switch views, resize, and return. Verify scrollback remains usable and bottom-follow resumes when returned to the bottom.
6. With an authorized test GitHub account, exercise missing CLI, logged-out, create, and clone flows. Live remote operations were deliberately not performed here.
