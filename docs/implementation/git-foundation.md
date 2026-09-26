# Git task workspace foundation

Issue: https://github.com/mousse-agent/mousse/issues/2

## Shared contract

`ThreadWorkspaceManager` persists an owned task binding for a thread and project. `WorkspaceResolver` returns that binding for writable execution and subsequent read-only turns. File/Git protocol reads resolve the same task. Independent threads get independent worktrees; the registered primary checkout is not the task's writable root. Provisioning uses committed primary HEAD and leaves any human tracked or untracked edits in primary. Non-Git projects remain usable with explicit unsupported Git/undo capability.

`ThreadActionService` records turn admission and checkpoints owned edits. Immutable `ChangeReceipt` records live in `ThreadJournal`, with before/after SHAs, actor/run/action attribution, first-parent introduced commits, child contributions, external effects and retained refs. Workspace metadata caches the resulting HEAD/generation. Actions describe conversation boundaries; receipts describe code effects. A parent turn may reference intermediate snapshot and integration receipts, and completion order determines the latest action.

`ChildAgentIntegrationService` checks source/destination revisions and repository identity, merges the pinned result with `--no-ff`, and records one integration receipt. Child ancestry is attribution, not an additional undo list. Conflicts preserve Git conflict state and child results. Operation IDs permit retries without a second merge.

Chat uses the resolver at execution, captures an owned dirty parent before spawning, pins child bases/results and integrates through the shared service. Workflow execution uses the same binding. Trusted sequential workflow nodes use the parent under its writer lease; divergent nodes receive isolated worktrees and explicit integration. Attempt results persist `ExecutionWorkspaceRevision` with read/write SHAs and receipt ID. Compensation receipts invalidate dependent observations as `output-stale`; redo does not silently rerun tests or external effects.

Thread leases cover a writer's lifetime. Repository leases cover Git metadata operations. An already-held thread lease must be passed and validated rather than reacquired. Expected journal generation and pinned revisions reject stale operations.

## Compensation and recovery

Undo/redo create new commits. They reverse first-parent units, so a merge of multiple child commits is reversed once. Latest eligible unpublished actions require matching HEAD and an idle workspace. External effects remain listed and are not rolled back.

Undo journals its intent before Git, records the compensation, restores conversation context while holding ownership, and only then completes. `UndoService.recoverPending` and the `operations.recover` protocol reconcile interrupted operations without repeating Git. Presentation messages remain in the durable transcript with hidden state; native messages are archived for redo. Fault tests must cover the receipt-write gap as well as `context_pending`.

Publish accepts reviewed source and target SHAs, checks them under ownership and records the exact merged revision. Repeating the same completed operation returns its result, including through the protocol with the original journal generation. GC treats task, agent, workflow and change refs as retained promises, preserves unpublished work, and revalidates a fresh issued inventory before deletion. Managed agent/task retirement has no durable release proof yet, so GC conservatively retains those branches/worktrees even if their current tree equals the base.

## Behavioral acceptance coverage

| Acceptance | Executable evidence |
| --- | --- |
| Actual main-agent tool write, read-only follow-up and GUI file API agree; two tasks and primary stay isolated | `tests/gitFoundationProtocol.test.ts` with real MMS socket/client and temporary home; only provider output substituted |
| Parent admission, midturn snapshot, multi-commit child, final parent checkpoint, public undo/redo | `tests/gitFoundationProtocol.test.ts`; exact tree checks and durable hidden transcript |
| Merge-aware undo/redo including surrounding parent commits | `tests/gitFoundationUndo.test.ts`; real Git, exact tree IDs, clean index and retained ancestry |
| Pinned result receipt, stale source/target, conflict retention and duplicate retry | `tests/gitFoundationIntegration.test.ts` |
| Process exits after receipt and context phase; retry and stale-head recovery | `tests/gitFoundationRecovery.test.ts` plus bundled crash child; real durable writes and exit code 86 |
| Checkpoint, revert, integration and publish exits before/after receipt; nested checkpoint completion order | `tests/gitFoundationOperationRecovery.test.ts`; fresh-service recovery, exact HEAD and no duplicate receipt |
| Public recovery after exit restores hidden context once and supports redo | `tests/gitFoundationProtocol.test.ts` |
| Reviewed publish, idempotent restart replay, task/ref retention and stale GC inventory | `tests/gitFoundationPublishGc.test.ts` |
| Sequential model or generic workflow tool write reaches a real script; old verification stales after undo and a deliberate new run is fresh | `tests/platformWorkflowWorkspace.test.ts`; only model/provider responses are substituted |
| Concurrent disjoint workflow results integrate; conflicting results survive | `tests/platformWorkflowWorkspace.test.ts`; real tool, worktree, checkpoint and integration paths |
| Human dirty primary state stays outside a new task | `tests/threadWorkspace.test.ts` |
| Queued writer rechecks HEAD before capturing dirty inputs; nested editor APIs journal saves and reject stale saves | `tests/gitFoundationProtocol.test.ts` |
| Provisioning interrupted after worktree creation restores retained ref and completes intent; completed checkpoints cannot replay execution | `tests/gitFoundationWorkspaceLifecycle.test.ts` |
| Rendered Undo/Redo controls issue actual daemon requests and preserve Git/transcript behavior | `tests/gitFoundationUi.test.ts`, opt in with `MOUSSE_FOUNDATION_BROWSER_BIN` |

The renderer qualification bundles the actual `ThreadChangeControls` component, drives its buttons with a dedicated agent-browser session and bridges its API calls to an authenticated MMS socket. It asserts real Git bytes and hidden/restored transcript state. This is a connected component test; it does not claim a full Electron shell usability test. The live `OrchestratorChat` renders this persistent control so redo remains reachable after hiding the affected messages.

## Verification ledger

All runtime fixtures use temporary `MOUSSE_HOME` and temporary Git repositories. Logs are outside the repository in `C:/Users/avrsa/AppData/Local/Temp/mousse-foundation-sol/`. No package-lock changes were needed. Tests do not commit, switch or push the shared task branch.

Baseline reference is `0db2721a6244db53208db27d540767ed4aa5c764`. Production edits were already present at the first local inspection; initial local checks are a concurrent dirty snapshot, not a clean baseline. Root supplied clean hosted baseline evidence from https://github.com/mousse-agent/mousse/actions/runs/35509349520 (typecheck passed; 19 tests failed across 15 files).

Initial local observations:

- `npm ci`: exit 0; `npm-ci.log`.
- `npm run typecheck`: exit 0; `initial-typecheck.log`.
- `npm run build`: exit 0; `initial-build.log`.
- Full Vitest with four workers: 233 files passed / 6 failed; 1676 tests passed / 6 failed / 6 skipped; four unhandled Windows watcher errors. `initial-test.log`.
- Local failures included browser upload naming, browser/profile/scheduled timeouts, workflow input symlink handling, and the old dirty-primary rejection expectation. Hosted baseline also failed browser/profile/scheduled and workflow symlink cases; that overlap alone does not prove every local failure has the same cause. The obsolete dirty-primary assertion was replaced with stronger committed-base and preserved-human-edits checks under the chosen contract.
- Initial new fault tests caught a receipt-to-compensation recovery gap and inconsistent integration replay response. Both passed after core fixes (`foundation-third.log`).
- Subsequent independent fault tests exposed and verified fixes for the queued-writer stale HEAD bug and nested source-staging lease deadlock. Critical current protocol/workflow/coordinator rerun: 36/36 passed (`current-critical.log`).
- Browser upload naming failure reproduced identically on the detached clean baseline supplied by root (`baseline-upload.log`): the unlabeled input exposes `Choose files`, while the old test requests `Files`. The approval-channel test failed under a broad concurrent run and passed alone (`approval-isolated.log`); it is timing-sensitive, without clean-baseline proof.
- The final combined verification is recorded below after production edits stabilize.

## Independent review and practical limits

Reviewed the changed resolver/admission paths, thread-before-repository lock order, validated held-lease reuse, immutable receipt/replay checks, merge compensation, recovery reconstruction, managed conflict abort, workflow input staging and renderer action routing. The behavioral tests exercise these relationships rather than matching source text. No additional foundation correctness blocker was found in this final focused review after the reported fixes.

Git worktrees are not process sandboxes. Ignored files, files outside the worktree, network calls and other external effects are not reverted by code undo. Main/workflow mutation receipts conservatively retain possible external-effect evidence; they do not claim an exhaustive audit of every side effect. Non-Git main execution explicitly lacks Git undo capability; non-Git workflow agents use scratch without inventing a Git binding. Read-only modes continue to rely on their existing tool policy.

Recovery tests cover durable operation boundaries, including exits before/after receipt persistence. They do not prove automatic repair of arbitrary disk corruption, interrupted Git index writes, or concurrent external Git processes. Ambiguous dirty/conflict states fail closed and keep evidence for recovery. Managed worktree retirement remains conservative retention rather than automated reclamation. Room UI and guest transport are outside this implementation.

## Initial qualification (before all-checks remediation)

2026-09-26, Windows, Node 24.20. Checks ran against the completed working-tree changes on `codex/issue-2-git-foundation`, based on checkpoint `dbf7fc7475446c99c11ab7182d14be99b7a2b505`; this is not a claim that that checkpoint alone contains the final tested diff.

| Check | Result | Evidence |
| --- | --- | --- |
| Node and renderer typecheck | Pass | `frozen-typecheck.log` |
| Production renderer/main/CLI build | Pass | `frozen-build.log` |
| Full Vitest, four workers | 241 files passed, 4 failed, 1 skipped; 1717 tests passed, 4 failed, 2 skipped; four unhandled Windows watcher errors | `frozen-test.log`, 304 seconds |
| Actual rendered Undo/Redo controls, opt-in browser test | Pass, rerun against final production | `ui-final.log`, 46 seconds |
| Whitespace validation | `git diff --check` passes | Final local check |

All 34 non-browser tests in the new `gitFoundation*` suites passed in the full run. The additional rendered-control test passed separately (35 new foundation tests total). Expanded existing workflow tests also passed, including sequential agents and generic tools, explicit fresh verification, concurrent integrated results and retained model output after conflict. No tests were skipped to hide a foundation failure. The browser test is opt-in because agent-browser is an external local qualification tool, not a package dependency.

Historical full-suite failures at that checkpoint:

| Test | Current failure | Baseline evidence |
| --- | --- | --- |
| `platformBrowserWorker.actions` upload case | Test asks for `Files`; browser exposes `Choose files` | Identical isolated failure reproduced on clean `0db2721` in `baseline-upload.log` |
| `platformMainBrowserE2E` | `orchestrator.send` timeout | Same test failed in initial local run and hosted clean baseline; identical cause not established across operating systems |
| `platformProfileCrossFeature` switch case | 30-second timeout | Same test failed in initial local run and hosted clean baseline |
| `platformScheduledBrowserE2E` | 90-second timeout | Same test failed in initial local run and hosted clean baseline |

Four unhandled `EPERM` watcher errors are associated with the profile/scheduled browser failures. The earlier approval-channel timing failure passed both its isolated rerun and the final full run. The earlier workflow symlink, staging deadlock, old conflicting-workflow fixture and non-Git expectation failures no longer occur.

Independent assessment: the Git foundation acceptance paths exercised here pass, with no outstanding foundation blocker found in focused review. The application suite remains red; this evidence is not a blanket release or hosted-CI signoff. Root owns the final commit, push, PR and hosted check comparison.

## All-checks remediation and full application qualification

The subsequent mandate included every historical application failure. CI now builds the application, CLI and browser worker before testing, installs pinned certified Chrome, configures supported Linux sandbox helpers, and runs Electron under Xvfb with two workers. It does not disable the browser sandbox. Browser consent fixtures grant actual authenticated consent; asynchronous revocation and external-effect confirmation use explicit barriers. Child logging uses direct file descriptors so inherited pipes do not masquerade as a live Chromium process. POSIX shutdown retains captured process identities through parent exit, and crashed-daemon socket recovery checks ownership and listener state before cleanup.

Full-shell testing found an additional correctness defect: Undo restored code and daemon context while the renderer merged the authoritative snapshot with retired messages. Restoration events now carry explicit replacement semantics through the protocol, Electron bridge, preload and profile-scoped renderer store. Ordinary hydration still preserves a live streaming tail. Redo also retains the original presentation bounds, including receipt recovery, so subsequent Undo restores the same context boundary.

`gitFoundationFullShell.test.ts` launches the actual built Electron main entrypoint, production renderer/preload and normally started owned daemon. A small driver activates the real Undo/Redo buttons and checks visible messages, daemon messages, task bytes and primary HEAD through **two full cycles**. Its only synthetic setup is a durable task/action/context seed; it does not substitute UI components or transport handlers. It has no opt-in or external browser dependency. Like existing CLI/Electron tests, it requires `npm run build` first. The test reproduced the stale transcript before the fix (`checks-full-shell-regression-red.log`) and passed after it (`checks-full-shell-regression-green.log`, 21.15 seconds).

Independent manual full-shell evidence also covers a task chat slash invocation, real Node workflow execution in the isolated task, approval through the authenticated production preload API, and verification changing to `output-stale` after UI Undo while retaining durable output. Browser navigation and form input ran in the application's actual Electron webview against a local HTTP fixture. These checks used temporary `MOUSSE_HOME`, `MOUSSE_ELECTRON_USER_DATA` and `MOUSSE_REPO_ROOT`. The GUI was launched directly with Electron: `scripts/start.mjs` deliberately clears `MOUSSE_HOME` and is unsuitable for isolated qualification. Both temporary daemons were stopped through `service stop`; the local fixture server was also stopped.

### Live provider qualification

With explicit user authorization, the manual `git-foundation-live-provider.ts` fixture used the existing OpenCode Go subscription and the **dynamically verified** `opencode-go/deepseek-v4.1-flash` model. The credential was read into an in-memory credential-store boundary; no model/provider/tool response was mocked and no credential value was saved to the repository, test home or evidence. The original saved credential file remained byte-for-byte unchanged.

Through authenticated `LocalMmsClient` → MMS → native provider → actual tools, the model wrote exact task bytes; Undo restored base bytes; Redo restored the model edit; and a subsequent read-only turn returned the expected verification response. That follow-up asserts the response, not a separately retained read-tool trace; deterministic protocol tests independently verify the read tool's task routing. Primary bytes and HEAD were unchanged. `checks-live-provider-result.json` records all assertions passing. The first manual harness incorrectly tried to undo the earlier edit after a later read-only turn; that run is retained separately. The corrected order tests latest-turn semantics without changing production behavior.

This live check is deliberately outside the automatic suite: it consumes an authorized subscription and is not a CI prerequisite. To repeat with authorization, run `node tests/fixtures/build-git-foundation-qualification.mjs live-provider`, set `MOUSSE_LIVE_EVIDENCE` to a file outside the repository, then run `node .mousse-dev/quality-full-shell/live.mjs`. The fixture makes two bounded orchestrator turns in a temporary Git repository and removes that temporary application home after shutdown. A tool-using turn can involve several provider requests. Deterministic tests remain the primary regression gate.

### Final independent Windows results

2026-09-26, Windows, Node 24.20. Final production source was built/typechecked at `4f16836fe6d28430d698e884440f90e6ddf03c85`; checkpoint `32a88a40563caedeab35abc3fafa69a15458de27` then committed the already-present final browser fixture and full-shell regression. The full run tested that frozen source/test content. Only this documentation and the separate manual live-provider fixture/build helper were added afterward.

| Command or qualification | Result | Evidence in external coordination directory |
| --- | --- | --- |
| `npm run typecheck` | Pass, exit 0 | `checks-quality-final-typecheck.log` |
| `npm run build` | Pass, exit 0 | `checks-quality-final-build.log` |
| `npm test -- --maxWorkers=2`, temporary home and `MOUSSE_FOUNDATION_BROWSER_BIN` enabled | **250 files passed, 1 platform-only file skipped; 1,737 tests passed, 3 platform-only tests skipped; zero failures or unhandled errors**; 518.67 seconds | `checks-quality-final-full.log` |
| Actual full Electron Undo/Redo, two cycles | Pass standalone and in final suite | `checks-full-shell-regression-green.log`, final full log |
| Manual full-shell workflow/browser smoke, built `38ac910` | Pass; actual UI, preload, owned daemon, workflow script and Electron webview; final suite subsequently exercises the browser/workflow paths against final code | `checks-full-shell-workflow-before.json`, `checks-full-shell-workflow-undone.json`, `checks-full-shell-browser.json`, screenshot `.png` |
| Authorized OpenCode Go / DeepSeek V4.1 Flash | Pass: real edit, Undo/Redo, read-only follow-up response, primary preservation and saved-credential byte equality | `checks-live-provider-result.json` |
| `git diff --check` | Pass | Final local check |

The three Windows skips are two POSIX non-cooperative process cases and the Unix-socket recovery test. They require Linux semantics and execute in the hosted Linux job; no failing application test was disabled. The standalone rendered-control test was explicitly enabled locally, and the new full-Electron test runs by default without that opt-in. The earlier four application failures and watcher errors are resolved in the final Windows run. Hosted Linux status remains root-owned evidence; these Windows results do not substitute for the final hosted checks or authorize a merge.

### Hosted Linux qualification

[Hosted run 36221211321](https://github.com/mousse-agent/mousse/actions/runs/36221211321) tested checkpoint `32a88a40563caedeab35abc3fafa69a15458de27`: both Workflow tools and Application checks passed. Application typecheck/build passed; the full suite passed **250 files and 1,738 tests**, with one file/two tests skipped, in 307.35 seconds. The skips are the Windows-only path-collision case and the external-agent-browser component test; the full Electron application regression runs normally on Linux. The POSIX descendant-termination and Unix-socket recovery regressions both execute there. This supersedes the historical red hosted checks recorded above. Final documentation/manual-fixture publication will receive its own current-head CI run, recorded on the PR.
