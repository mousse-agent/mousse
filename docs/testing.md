# Testing

How the suite is organised, which command to run while working, and what must stay.

## Commands

| Command | Runs | When |
|---|---|---|
| `npm run test:changed` | Tests related to the working tree (staged, unstaged, untracked) | While editing |
| `npm run test:branch` | Tests related to everything since the branch left the remote default branch, plus the working tree | Large changes across several modules |
| `npm run test:related -- <files>` | Tests related to the named source files | Checking one module |
| `npm run test:plan` | Prints what `test:changed` would run and why, runs nothing | Checking the selection |
| `npm test` | Everything | Only for very large changes that affect multiple modules, see `docs/team-workflow.md` |
| `npm run test:unit`, `npm run test:process` | In-process or both process projects | Narrowing a failure |

Before a PR, run the named test files that cover the changed code (`npx vitest run tests/foo.test.ts`). `test:branch` and `test:related` follow imports, so a change to main, preload, CLI or build inputs selects most of the suite; use them for large changes, and check the selection with `test:plan` first. `npm test` is only for very large changes that affect multiple modules.

## How related tests are chosen

`scripts/test-select.mjs` takes the union of two sources and never intersects them:

1. **The import graph.** Vitest records what each test file imports, transitively. A test runs when it, or anything it imports, changed. This covers every in-process test without configuration.
2. **Runtime edges** in `tests/test-dependencies.json`. Some tests spawn the bundled CLI, run Electron with a fixture, or read data files. Their dependency is not an import, so a rule names it: `when` matches changed paths, `run` names test files, `projects` names a whole vitest project. Keep rules to such implicit edges; do not mirror imports.

Three outcomes short-circuit the graph:

- A change under `tests/setup`, `tests/support`, `tests/fixtures`, the manifest, a vitest or vite config, `package.json`, the lockfile, a `tsconfig` or the selector itself runs everything. The same list is `forceRerunTriggers` in `vitest.config.ts`, so `vitest run --changed` agrees.
- A change to documentation or repository metadata runs nothing.
- A changed file under `src/` or `scripts/` that no test imports and no rule names runs everything, with the path printed. That is the fail-closed case; add a rule when it is expected.

`tests/testSelect.test.ts` holds the truth table for the plan and checks that every rule still names an existing file.

## Projects

`unit` runs in-process tests with half the cores. After it finishes, `process` runs lightweight process fixtures with three workers. Finally, `heavy` runs at most two files that own browsers, multiple daemons or multi-profile TLS compositions. The groups run sequentially because Vitest requires distinct group orders for distinct worker budgets. `npm run test:process` runs both.

`tests/test-lanes.json` explicitly lists the process, service/TLS, daemon and browser resource categories; the latter three share the heavy budget. Tests outside that inventory remain in `unit`. Add new resource-owning files to the inventory after inspecting their fixtures and transitive helpers. A browser or process word in a mocked policy test does not determine membership. Changing the inventory triggers the full suite, and the selector checks that entries exist and do not overlap. Fork isolation and per-test deadlines remain enabled.

## Shared fixtures

- `tests/support/build.ts`: the CLI, browser worker and crash children are bundled once per source state into a cache under the temp directory and shared by every worker and every run. Use `productBuild()`, `crashChild()`, `cliChild()` or `sharedBuild()`; never read the checkout's `out/` directory from a test.
- `tests/support/gitBase.ts`: build a private committed base once per file and copy it into each fresh fixture root. Only the copies may gain worktrees, refs or mutable state; linked-worktree bases are rejected.
- `tests/support/daemon.ts`: `startDaemon()` launches the bundled CLI as a daemon and waits for its owner and runtime records; `runCli()` and `cliJson()` run commands with a timeout and an output bound.
- `tests/support/phaseTiming.ts`: set `MOUSSE_TEST_PHASE_TIMING=1` to print fixture phase durations as JSON records on stderr. Daemon startup, CLI operations and drain, plus lifecycle host/profile/socket setup and teardown are measured. Arguments, paths and credentials are not logged; observations are silent by default.
- `tests/support/tmp.ts`: `ownedTemp()` is a canonical temp directory with deferred disposers.

## What must stay

Some tests are the only place a real boundary is exercised. Shrink their fixtures, do not delete them, and do not replace the boundary with a fake:

- **Process death and recovery:** `net/chats/{crash,tasks,device}`, `net/store/crash`, `net/bots/local/registration-crash`, `net/spaces/host/process`, `net/spaces/private/tls`, `net/spaces/archive/private-rotation`, `net/identity/keyStore`, `net/enrollment/enrollment`, `net/bridge/dispatch/service`, `net/bridge/remote/remote`, `platformWorkflowDaemonCrash`, `platformWorkflowDurabilityMatrix` and `platformWorkflowSubworkflowRecovery` (the real-kill rows), `platformProfileMigrationCrash`, `platformUnixSocketRecovery`, `platformProcessLifecycle`, `platformManagedBrowserDrain`, `run/daemonEpoch`, `run/runEngineBoot`, `resourceLifecycleAcceptanceDaemon`, `resourceLifecycleQualificationPurgeDaemon`.
- **The bundled CLI against a real daemon, one per feature:** `net/daemon`, `net/spaces/daemon`, `net/spaces/archive/daemon`, `net/bridge/daemon`, `net/bots/local/daemon`, `net/bots/daemon/reader`, `net/cli/authority-daemon`, `net/cli/relay`, `net/rollback/daemon`, `net/cutover/control`, `platformWorkflowCli`.
- **Real Electron:** `net/chats/gui-electron` (the only preload isolation test), `net/chats/gui-renderer-lifecycle`, `renderer/*-electron`, `chatUndoFullShell`, `gitFoundationFullShell`, `resourceLifecycleFullShell`, `platformMainBundleImports`.
- **Real TLS and sockets:** `net/link/{secureChannel,mux}`, `net/transports/*`, `net/relay/accounting`, `net/sync/integration`, `net/plus/hosted-tls`, `mmsProtocolServer`, `platformMcpLifecycleDrain`.
- **Real SQLite and the native reader:** `net/store/{store,crash}`, `net/bots/runtime/nativeReader`, `net/bots/permissions/foreign-reader`, `net/chats/approvals`.
- **Real Chrome, where the platform allows it:** `platformBrowserWorker.*`, `platformManagedBrowserDrain`, `platformMainBrowserE2E`, `platformScheduledBrowserE2E`.
- **Named in the Windows CI job** (`.github/workflows/ci.yml`): moving or deleting one of those files silently removes it from that job.

## Adding tests for a feature

- Put the decision table at the module that decides it. A new option or branch usually adds rows there, not a new daemon-booting file.
- Above that module, add at most one happy path and one failure per tier the feature actually crosses (daemon in process, spawned process). Each `it.each` row counts. Most features add no spawned-process test.
- For a test above the deciding module, answer: which incorrect change would fail this test while every lower test still passed? If there is no specific answer, the test belongs lower or not at all.
- If the test spawns built output or reads a data file, add a rule to `tests/test-dependencies.json` and run `npm run test:plan` to see it selected. A test that reads a renderer source or stylesheet from disk counts: list it in the renderer rule, and `tests/testSelect.test.ts` fails until you do.
- Keep gates visible: `it.skipIf` or `it.runIf` with the reason, never an early `return` inside the test.
