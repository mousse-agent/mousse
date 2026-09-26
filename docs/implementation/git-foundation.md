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

## Final qualification

2026-09-26, Windows, Node 24.20. Checks ran against the completed working-tree changes on `codex/issue-2-git-foundation`, based on checkpoint `dbf7fc7475446c99c11ab7182d14be99b7a2b505`; this is not a claim that that checkpoint alone contains the final tested diff.

| Check | Result | Evidence |
| --- | --- | --- |
| Node and renderer typecheck | Pass | `frozen-typecheck.log` |
| Production renderer/main/CLI build | Pass | `frozen-build.log` |
| Full Vitest, four workers | 241 files passed, 4 failed, 1 skipped; 1717 tests passed, 4 failed, 2 skipped; four unhandled Windows watcher errors | `frozen-test.log`, 304 seconds |
| Actual rendered Undo/Redo controls, opt-in browser test | Pass, rerun against final production | `ui-final.log`, 46 seconds |
| Whitespace validation | `git diff --check` passes | Final local check |

All 34 non-browser tests in the new `gitFoundation*` suites passed in the full run. The additional rendered-control test passed separately (35 new foundation tests total). Expanded existing workflow tests also passed, including sequential agents and generic tools, explicit fresh verification, concurrent integrated results and retained model output after conflict. No tests were skipped to hide a foundation failure. The browser test is opt-in because agent-browser is an external local qualification tool, not a package dependency.

Remaining full-suite failures:

| Test | Current failure | Baseline evidence |
| --- | --- | --- |
| `platformBrowserWorker.actions` upload case | Test asks for `Files`; browser exposes `Choose files` | Identical isolated failure reproduced on clean `0db2721` in `baseline-upload.log` |
| `platformMainBrowserE2E` | `orchestrator.send` timeout | Same test failed in initial local run and hosted clean baseline; identical cause not established across operating systems |
| `platformProfileCrossFeature` switch case | 30-second timeout | Same test failed in initial local run and hosted clean baseline |
| `platformScheduledBrowserE2E` | 90-second timeout | Same test failed in initial local run and hosted clean baseline |

Four unhandled `EPERM` watcher errors are associated with the profile/scheduled browser failures. The earlier approval-channel timing failure passed both its isolated rerun and the final full run. The earlier workflow symlink, staging deadlock, old conflicting-workflow fixture and non-Git expectation failures no longer occur.

Independent assessment: the Git foundation acceptance paths exercised here pass, with no outstanding foundation blocker found in focused review. The application suite remains red; this evidence is not a blanket release or hosted-CI signoff. Root owns the final commit, push, PR and hosted check comparison.
