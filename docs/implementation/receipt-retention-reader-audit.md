# Receipt retention reader audit

Phase 3 expires logical capabilities independently of physical refs. The immutable task journal is the only expiry authority. Neither surviving Git objects nor old JSON snapshots make an expired action eligible again.

| Reader / writer | Retention contract |
| --- | --- |
| `UndoService`, `RedoService` | Historical admission is checked under task/repository ownership. Pending recovery wins over sweeping. Completion refreshes only its matching compensation pair, once per compensation ID. |
| `CodeRevertService` | New historical code reverts consult expiry. An already admitted pending operation is protected until recovery settles. |
| `ConversationBranchService` | New exact-code forks consult expiry. Existing saved branches retain their own refs. Explicit current-code continuation restores conversation context without claiming historical code. |
| `ThreadActionService`, `ChangeReceiptService` | Actions and receipts stay readable. Replayed expired receipts return their immutable audit record without recreating workspace/retention refs. Pending checkpoint recovery prevents expiry. |
| `PublishService`, `ChildAgentIntegrationService`, workflow checkpoint/integration | Current task, worker and workflow branch/result refs remain independent claims. Receipt contributions form an expiry dependency closure. Pending operations prohibit physical receipt release. |
| `ResourceInventory` | Reads current journal/owners. Expired receipt refs keep their source association with their Undo/Redo claim removed; every other claim remains. Unknown source/schema blocks release. |
| `WorkspaceGcService` | Continues conservatively retaining every receipt namespace. It is not used for expiry or receipt ref deletion. |
| `ThreadGenerationStore`, `ThreadDataStore` | Historical generations and flat action projections are conversation/recovery data. They do not recreate receipt refs or retention authority; the current journal remains separate. |
| GUI history and protocol | Read-only request-local eligibility projection shows available, expired, pinned and blocked states. Historical APIs enforce admission independently of stale GUI data. |
| Named-agent/workspace retirement | Recall/manifest/episode refs are distinct from receipt refs and stay retained by their durable owner. No named-agent or worktree branch ref is eligible for this service. |

`ReceiptRefReleaseService` additionally requires a current registered task workspace, matching canonical repository identity, a fresh profile-wide inventory with no ambiguity, exclusive ownership of the exact receipt refs, and no live claim on those refs. It journals intent, deletes the expected before/after values in one Git reference transaction, verifies absence and journals completion. A restart retries a prepared operation; a changed or symbolic ref blocks release. It never deletes objects, runs Git GC, touches user/primary refs or expires reflogs. Reported Git bytes are unknown: task/user ancestry may still reach every commit.

Authenticated local GUI admission is the existing product boundary for saved pins and policy changes. CLI, remote-control and model/internal dispatch cannot supply a `human` method parameter to bypass it. This does not claim OS-level protection from an already-authorized local process impersonating the existing GUI handshake.
