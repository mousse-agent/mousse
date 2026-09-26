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

Publish accepts reviewed source and target SHAs, checks them under ownership and records the exact merged revision. Repeating the same completed operation returns its result. GC treats task and change refs as retained promises, preserves unpublished work, and revalidates a fresh issued inventory before deletion.

## Behavioral acceptance coverage

| Acceptance | Executable evidence |
| --- | --- |
| Writer, read-only resolution and GUI file API agree; two tasks and primary stay isolated | `tests/gitFoundationProtocol.test.ts` with real MMS socket/client and temporary home |
| Parent admission, midturn snapshot, multi-commit child, final parent checkpoint, public undo/redo | `tests/gitFoundationProtocol.test.ts`; exact tree checks and durable hidden transcript |
| Merge-aware undo/redo including surrounding parent commits | `tests/gitFoundationUndo.test.ts`; real Git, exact tree IDs, clean index and retained ancestry |
| Pinned result receipt, stale source/target, conflict retention and duplicate retry | `tests/gitFoundationIntegration.test.ts` |
| Process exits after receipt and context phase; retry and stale-head recovery | `tests/gitFoundationRecovery.test.ts` plus bundled crash child; real durable writes and exit code 86 |
| Reviewed publish, idempotent restart replay, task/ref retention and stale GC inventory | `tests/gitFoundationPublishGc.test.ts` |
| Sequential model tool write reaches a real workflow script; verification stales after undo | `tests/platformWorkflowWorkspace.test.ts`; only model/provider responses are substituted |
| Concurrent disjoint workflow results integrate; conflicting results survive | `tests/platformWorkflowWorkspace.test.ts`; real tool, worktree, checkpoint and integration paths |
| Human dirty primary state stays outside a new task | `tests/threadWorkspace.test.ts` |

Protocol tests prove GUI-client connectivity, not a rendered browser click. Renderer interaction verification must be recorded separately; source text checks alone are not evidence of a working button.

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
- Sequential workflow and reviewed publish/GC tests passed in focused runs. The final combined verification must be recorded below after production edits stabilize.

## Remaining qualification

Implementation and independent verification are in progress. Do not interpret focused passing tests as a full application release qualification. Final combined results, unresolved failures and actual renderer evidence belong here before issue completion.
