# Task, subagent and storage lifecycle foundation

Status: proposed plan; no runtime changes authorized by this document. Baseline: `d0ad993ac8e9aa656055605f4143c357c57ec303` on `codex/issue-2-git-foundation` (PR #3, unmerged). This extends the Git foundation rather than replacing its receipt, recovery, workspace or workflow systems.

## Outcome and scope

Mousse keeps conversations and named agent context while bounding the resources needed to execute them. A task owns one authoritative workspace. Each child invocation receives an explicit workspace/access contract. Completed invocations can release processes and reconstructable checkouts without losing the ability to recall the same agent. Undo has an explicit retention window. Thread deletion accounts for every owned resource and remains recoverable until permanent purge.

The same daemon-owned contracts must serve GUI, CLI, workflows and future collaborative requests. Human attribution and resource authority can be attached to operations without introducing a second execution or cleanup system. Room UI, guest transport, conversation expiry, provider prompt-cache guarantees and rewriting user Git history are outside scope.

## Verified starting point

- Main-chat `spawn_agents` always calls `createSelectiveWorktree`; its assignment schema has no workspace/access option or child-instance name (`OrchestratorService.ts`, `shared/types.ts`).
- Workflow agents use the task workspace for sequential work and isolated worktrees for concurrent/fan-out paths (`WorkflowRunService.requiresIsolatedAgent`, `WorkflowWorkspace`, `MmsWorkflowAgents`). Separate invocation transcripts do not imply separate file trees.
- Mousse native child sessions persist messages, native context and assignment. Completed sessions reject further messages; restoration does not reconstruct a missing child worktree. Named agent definitions are distinct from named, recallable instances (`MousseAgentService`).
- Receipts pin before/after revisions indefinitely. `WorkspaceGcService` conservatively protects task/child/workflow refs and has no production cleanup caller. Thread purge only removes the trashed thread directory, not external worktrees or refs.
- `threads.delete` checks live runtime ownership, while `threads.trash` and `threads.purge` take different direct data-store paths. These must converge before automatic cleanup is enabled.
- Conversation compaction retains history. Optional transactional generations contain full snapshots without pruning. Conversation retention is intentional in this plan; general transcript deduplication is deferred.

Source paths below are relative to `src/mms` unless otherwise noted. Existing foundation acceptance tests must remain green.

## Invariants

1. Durable identity/context is independent of a process, directory or active invocation. Names resolve to stable IDs, never filesystem paths.
2. Each task has one authoritative workspace; a shared child owns no separate checkout. Only one admitted writer can modify a shared task workspace at a time, including the parent, editor saves, scripts and integration.
3. Every resource records its owner and all retention claims. A retention claim has a reason: current result, undo, redo, recall, conversation attachment, pending integration, conflict, recovery, trash restore or explicit user pin. No consumer maintains an independent deletion rule.
4. Cleanup requires proof that the exact resource is unused and either durably represented elsewhere or explicitly discarded. Unknown ownership/content is retained and reported, not guessed away.
5. Expired Undo is an unavailable capability, not deleted conversation history. Recovery and in-flight operations outrank expiry.
6. Lifecycle operations are journaled, idempotent and restartable. Admission, restore, recall, Undo, publish and cleanup use the same fencing and lock order. A stale inventory can never authorize deletion.
7. Cleanup only changes verified Mousse-owned resources. The primary checkout, user refs, other profiles/tasks and shared Git data remain protected.
8. Capability requests may only narrow inherited authority. An unsupported request fails; switching read-only to write requires a distinct explicit request. Only a human-controlled action can pin indefinitely or authorize discarding the sole copy of unpublished/conflicted/untracked/ignored work.
9. One daemon is the admission authority for a profile; other processes use its protocol. Lease loss invalidates episode and descendant sublease tokens. Recovery must establish valid ownership or a visible blocked state before another writer starts.

## Durable model and reuse

Extend existing task/workspace metadata and journal services. Introduce one lifecycle coordinator composed in `MmsProfileServices`; avoid a parallel job engine or a second source of Git truth.

Persist these concepts, either as additive records or fields on existing records:

- **Agent identity:** stable agent ID, thread-scoped unique name, definition/assignment snapshot, native context reference, last episode/result and lifecycle state. UI renaming changes a label/alias with collision validation, never identity. Retain historical aliases only when unambiguous.
- **Invocation (episode):** stable operation ID, agent ID, workspace/access request, resolved workspace ID/generation, pinned base, effective capabilities, execution state and result receipt. Recall creates a new episode rather than editing the completed episode.
- **Resource inventory:** resource ID/type, verified profile/repository/task owner, canonical identity, reconstruction manifest, generation, retention claims and materialization state. Cover task/child/workflow worktrees, owned refs, context/artifact associations, runtime files and trash records. Discover preexisting resources conservatively; do not trust directory names alone.
- **Retention state:** an append-only decision referencing immutable receipts, eligibility deadline, pin reasons and release operation. Keep compact receipts/audit information even after their Undo payload is released. Replayed old operations cannot recreate an expired pin.
- **Lifecycle operation:** intent, expected revisions/identities, phase, progress and completion. Purge recovery information lives outside the directory being purged. Durable per-resource progress permits partial cleanup without claiming everything was removed.

A claim graph is reconstructable from durable owners/journals; an index accelerates it but cannot override the source records. Migration or corruption ambiguity disables deletion for affected resources. Cross-thread artifact references count as claims.

Freeze the versioned claim kinds in Phase 1: `current-result`, `undo`, `redo`, `recall`, `conversation-attachment`, `pending-integration`, `conflict`, `recovery`, `trash-restore`, `user-pin`. Unknown claim versions fail closed. System claims end when their documented condition ends (for example, successful integration releases pending-integration); they cannot become invisible permanent pins. Recall claims exist while a retained agent identity promises the corresponding resume result. User pins require human action. Audit optional generation snapshots and compatibility files: old embedded actions/refs are historical data, not authority to resurrect released claims. General conversation/snapshot deduplication remains deferred and must be excluded from temporary-resource storage claims.

Use a stable profile/task-ID lifecycle gate and tombstone outside movable thread data. Existing execution, data and queue lock paths are inside the thread directory; moving it must not allow an old client to recreate that path and acquire a second lock. Every admission/data-write path validates the stable task generation and location mapping. Fence and drain writers before moving metadata, persist the new mapping, and reject stale path-based handles. Restore uses the same task ID with a new lifecycle generation. Schema compatibility checks must happen before legacy writers can open/create a task directory.

The ownership closure explicitly includes workflow-created invocation threads and their indexes/context, scheduler/run links, workflow workspace registration/staging records, and browser/runtime ownership outside the parent directory. A durable invocation thread that is also deliberately retained or referenced independently has its own claim; it cannot be blindly cascade-deleted.

## Workspace/access contract

Proposed logical tool surface (names are illustrative):

```ts
create_subagent({ name, task, workspace: 'shared' | 'isolated', access: 'read-only' | 'write' })
recall_subagent({ agent: idOrName, task, workspace, access, expectedAgentGeneration })
```

The daemon returns the actual binding and admission state. Names are scoped to the parent task, and tools can list available names/IDs. An omitted policy on the new API defaults to shared/read-only; old clients receive an explicit compatibility mapping to their previous isolated/write behavior until migrated. The model requests policy; the daemon validates and enforces it.

| Request | Semantics |
| --- | --- |
| shared/read-only | Inspect the current task tree without acquiring write ownership. May observe changes; results carry the observed generation and cannot claim exact-revision verification. |
| shared/write | Acquire exclusive task writer ownership. Parent mutation pauses while the child owns it. Sequential workflow writers use the same path. |
| isolated/read-only | Inspect a pinned, stable revision in a disposable checkout. No change integration. |
| isolated/write | Execute independently from a pinned base; capture a result and integrate through the existing pinned-revision receipt contract. |

Exact-revision reviews use isolated/read-only. Tests/builds that create output use isolated/write or shared/write; a label such as "reviewer" does not make shell commands read-only. Shared reads are explicitly non-snapshot observations. Receipt generation advances at checkpoints, not every filesystem write, so an unchanged generation never proves a consistent read. Verification requiring consistency must acquire a stable snapshot; adding a future dirty-write epoch would improve diagnostics but still needs external-write detection.

Access is enforced at tool, editor and process admission. Disallow mutating tools and arbitrary command execution for read-only invocations unless the adapter can enforce the required access. Git worktrees alone are not security sandboxes. Providers/CLI adapters lacking enforceable read-only support must reject that mode or offer a clearly identified supported mode; never silently advertise read-only or broaden access. Filesystem access and external-service permissions remain separate capabilities.

Any offered alternative requires a new explicit request. Audit every ingress: spawn/recall, sequential/fan-out workflow execution, editor save, script/tool calls, Undo, publish/integration, GUI/CLI, scheduled triggers, approvals, trash and purge. Existing workflow fan-out remains isolated during migration; compatibility mapping must not quietly serialize it into shared writing. Ownership is enforced before disk writes, not only when producing receipts afterward.

Shared writer ownership is transferred/delegated under a scoped lease token with a generation and parent episode, not recursively reacquired. When a parent awaits a child, orchestration can continue but parent mutations remain fenced. Cancellation/crash revokes the child token and requires recovery before a new writer. Multiple requested shared writers queue; independent parallel writing requires explicit isolation. A live invocation never silently changes workspace mode.

Define and test the acquisition order explicitly: stable lifecycle admission gate, scoped task/episode ownership, then short repository mutation lease. Never await a child, model, browser or process shutdown while holding the repository lease. Deletion first installs the admission fence, then requests cancellation and drains admitted work without holding locks that their completion paths need; only afterward acquires mutation ownership and revalidates inventory. Parent await must delegate/release writer permission before a shared child can start. Leases are not passed across process boundaries as trusted caller-supplied capabilities.

Retain one physical task execution lease while delegating logical child writer authority underneath it; adapt existing held-lease paths to validate both. Nested delegation cannot create a second physical owner. Revoking a token does not stop an already-running shell: await confirmed termination/drain of owned descendant processes and outstanding file/tool callbacks before handing write ownership to another episode. An uncertain drain blocks new writes and cleanup.

## Subagent completion, dormancy and recall

Separate agent states (available/dormant/retired) from episode states (queued/running/stopped/completed/failed/conflict). Completing one assignment does not destroy its agent identity.

On completion, persist context, result receipt and workspace manifest before stopping process/watchers/PTY/browser ownership. A shared child releases its invocation resources and lease only. An isolated child can release its checkout once all contents are accounted for. An unintegrated clean result may also hibernate: retain its result/base and pending integration claim without retaining checked-out files. Conflicted or uncaptured work stays materialized and visibly blocked from cleanup.

On recall, revalidate identity, current authorization, provider/adapter support and resource claims; acquire a new episode lease; reconstruct the required workspace; then restore context. Default recall starts against the current task revision and includes a machine-generated explanation of previous result versus current revision. Continuing an unintegrated branch is an explicit resume-result choice. Never replay old writes or revive old approvals. Stable identity preserves the agent's memory, not the old filesystem assumptions or provider-side prompt cache.

Native Mousse context is the initial supported recall path. CLI adapters need an explicit capability contract for resumable session export/import and cwd rebinding. Unsupported adapters retain transcript/assignment and clearly report a fresh process/context handoff rather than claim exact native-session continuation.

Recall invalidates old absolute checkout paths, file observations, runtime handles, capability tokens and approvals. Validate provider/model/context-format compatibility before native-session restoration; incompatibility gives an explicit blocked or fresh-context handoff choice, not silent corruption. Names/aliases never resolve to permanently retired identities, and agent/operation IDs are tombstoned along with thread IDs.

Only one context-writing episode may run per named agent at a time, even when two recalls request different isolated workspaces. Queue or reject a second recall with the current episode ID. Publish context using the expected agent/context generation and stable idempotency key; late completion from a cancelled episode cannot overwrite newer context. Concurrent independent continuation requires an explicit fork to a new agent identity, with clear lineage. Apply this to user messages, automatic retries and workflow recalls as well as the main agent's tool calls.

Record the parent conversation branch and context boundary that each episode consumed. Parent Undo or branch switching can invalidate a child's saved active context even while the full transcript remains retained. Mark that context diverged; recall must rebuild an appropriate active context for the selected branch, or use an explicit new-agent handoff/fork that discloses its historical source. Never silently restore instructions from an undone or unrelated branch into an otherwise normal recall. Test both filesystem divergence and conversation-only divergence.

## Safe workspace retirement

Inventory tracked changes, index/conflict state, nonignored and ignored files, untracked content, sparse configuration, links and external mounts. A clean Git status alone is insufficient. Each file class needs proof: captured durable result, retained auxiliary payload, explicitly reproducible managed output, or explicit discard authorization. Never blindly commit ignored files or secrets to Git. If capture/discard rules cannot account for a file, retain the checkout and explain why.

Combine a bounded filesystem walk with Git/index inspection, including `skip-worktree`, `assume-unchanged`, nested repositories, junctions/reparse points and volume boundaries. Never traverse `.git` into the shared repository or follow links outside the owned tree. Re-walk and compare immediately before mutation; unexpected content invalidates the plan. A reviewed allowlist defines reproducible outputs; ignore rules alone do not. Secret content must not be copied into conversations or qualification logs. Git's willingness to remove a worktree is not the retirement proof: ignored files can otherwise be lost.

Persist a reconstruction manifest (repository/base/result identity, sparse selection, expected tree, allowed dependency setup and retained auxiliary files). Verify it before retirement and verify reconstructed tree/content on recall. Dependency/build caches can be shared only through an explicit cache contract; arbitrary writable links must not bypass shared-writer ownership.

Before removal, verify that base/result objects are durably reachable through repository-level Mousse refs with matching retention claims; worktree-local HEAD is insufficient. Journal pin creation and verification before retiring the checkout, and recheck the pin immediately before recalled execution starts. New shared dependency caches are outside this plan. Audit existing dependency links under the access contract: no writable link into another task or unowned cache may bypass writer admission. Enforce canonical target checks for app-managed access; an adapter that cannot enforce requested restrictions cannot claim those capabilities. Preserve legitimate repository links as data without following them during cleanup.

Retirement runs under admission fencing and the established task/repository lease order. Check canonical path, repository common-directory identity, worktree registration, expected HEAD/ref values and symlink boundaries immediately before mutation. Use Git's worktree removal for verified clean/reconstructable owned trees; no blanket force deletion. Retain or report busy handles. Advance metadata only after verifying the postcondition, with retry recovery if the process stops between steps.

## Undo/Redo retention

Proposed initial product default: 30 days after an action becomes terminal. Make the duration configurable and allow explicit saved-checkpoint pins. This is a time bound, not a promise of a fixed byte ceiling. Conversations, child context and user-attached artifacts remain retained unless their owner is permanently deleted.

Track paired Undo/Redo eligibility and dependency closure, including compensation, integration contributions and context boundaries. Do not expire one half of a currently offered operation. When Undo is used, retain the matching Redo material for a fresh policy window. Before expiry, mark eligibility changes under ownership and journal them; release only claims no other consumer needs. Current task results and unpublished child results remain durable even if the ability to reverse older actions expires. Recovery/conflict/active-operation and explicit-pin claims override ordinary deadlines.

Expiry selects a dependency-closed oldest prefix, not arbitrary holes in a reversible chain. Refresh only the matching compensation pair; Undo/Redo cycling cannot extend the entire historical chain. Persist policy adoption time, deadlines and sweep progress. Clock rollback never accelerates expiry, and suspicious forward jumps suspend destructive sweeping for review instead of mass-releasing history. Apply bounded batches with observable outcomes.

The GUI/API exposes available, expired, pinned, and temporarily blocked states with reasons and deadlines. Current-head/generation checks still apply. Older audit rows remain intelligible after expiry; historical receipts are not rewritten to pretend payloads still exist. Existing history receives a migration grace period from adoption, rather than immediately expiring everything older than 30 days.

Historical conversation viewing remains available after Undo expiry. Code-aware fork-from-turn and arbitrary code revert are separate capabilities: an existing saved branch/checkpoint holds its own claim; creating a new exact-code fork after its code material expires must report unavailable, even if incidental Git reachability temporarily leaves the commit present. Offer an explicitly labeled conversation-only continuation on the current code instead of pretending the old code was restored. All action APIs, recovery and receipt replay consult retention state consistently.

Git reachability must be explicit: removing a Mousse retention ref may release zero bytes if a task/user branch, reflog or other claim still reaches the commits. Report logical Undo expiry separately from reclaimable checkout/artifact bytes and estimated Git storage. Ordinary conservative Git maintenance may reclaim unreachable objects later; never run aggressive shared-repository pruning or rewrite primary/user branch history. Replacing private execution history with new anchors is deferred until ancestry-sensitive integration/publish/recall contracts can prove safety. No hard Git-history storage guarantee is claimed in this phase.

## Complete, recoverable thread deletion

All `threads.delete`, `threads.trash`, `threads.restore`, `threads.purge`, GUI and CLI entry points use one coordinator. Workflow invocations, timers, pending questions/approvals, children, tools, browser work and editor saves participate in its admission fence. Existing live work must be stopped/drained through its owning service or deletion returns a visible pending/blocked state.

Two product operations:

- **Move to trash:** journal intent and ownership inventory, fence execution, persist final state, mark the task unavailable for new work, retain restore claims and move its metadata. Proposed grace period: 30 days. Reconstructable checkouts may be retired during that period; restoring rehydrates lazily before execution and revalidates pending operations rather than replaying effects.
- **Permanently delete:** act on an exact, reviewed trash inventory or an explicitly enabled automatic-trash policy. Automatic purge must not discard sole copies of unpublished/conflicted work; require an explicit discard decision for those. Revalidate claims, durably record `purge_started` outside the task before the first irreversible step, remove exclusive materialized resources, release owned refs using expected old values, release exclusive artifacts, then remove conversation/agent data and complete the external purge record. Resources retained by another owner remain and are reported. Restoration and cancellation are unavailable from `purge_started`; a crash afterward resumes cleanup rather than offering a partly destroyed task as restorable. Before that boundary a request may be cancelled safely.

Trash expiration and permanent-discard policy are separate from Undo expiry. Surface cleanup failures and retry them; hiding a sidebar item is not evidence that disk cleanup succeeded. Repository offline, permissions, symlinks, locked files or changed refs must produce bounded retries/blocked reasons, not unsafe fallbacks. New threads never reuse tombstoned IDs.

Restore always returns an idle task: no episode, network call, shell, integration or approval is automatically replayed. Purge re-derives its inventory under ownership; the earlier preview alone is never authority. Partial cleanup remains visible with the retained resources and blocked reasons. Trash and Undo sweeps have separate policies, and neither can authorize a sole-copy discard.

## Phased execution and acceptance gates

Each phase ends with focused tests and a reviewable checkpoint. Cross-cutting contracts are agreed in phase 1 so later phases do not invent incompatible storage rules. Until a deletion proof is available, keep the existing conservative retention behavior.

### Phase 1 — Ownership, inventory and lifecycle coordinator

Add the durable owner/claim/operation model, migration, dry-run inventory and common admission fence. Route every deletion entry point through it, initially without background destructive cleanup. Reuse existing leases, journal and repository identity helpers.

Phase 1 expands no destructive behavior: `threads.delete` maps to fenced reversible trash, `threads.trash` is the same operation, restore uses the stable location mapping, and permanent purge of lifecycle-managed tasks remains blocked until Phase 5's full proof exists. Remove direct store deletion entry points from caller access. No checkout retirement, ref release or new access defaults in this phase. Ambiguous/failed migrations block all destructive lifecycle mutations, including ref updates. Unsupported old binaries refuse lifecycle-managed mutations before opening storage.

Gate: complete inventory of a task with shared and isolated children/workflows, including generated invocation threads; legacy unknowns retained; duplicate/stale requests rejected; no delete/trash bypass while any owned execution remains active. Restart rebuilds claims and resumes an interrupted non-destructive operation. Queued old-path acquisition cannot recreate trashed data; crash after rename/before index update recovers; concurrent restore/purge agrees on one durable state. Specify delegation, context-CAS and irreversible purge boundaries here before later phases implement them.

### Phase 2 — Workspace/access policy and named episodes

Add tool/protocol/UI schemas and adapter capability checks. Bring main-chat delegation onto the same shared/isolated contract as workflows. Add named instance lookup and episode records, scoped writer delegation and current-revision reporting. Existing callers have an explicit migration mapping.

Gate: two shared readers; sequential parent/child writes; queued shared writers; parallel isolated writers; nested delegation; cancellation during checkpoint; confirmed descendant termination before ownership transfer; editor/tool/workflow write races; prohibited command escalation. Primary checkout unchanged. Exact-revision review never uses a moving shared tree, including writes before receipt generation changes. Duplicate names and cross-task name lookups fail predictably.

### Phase 3 — Undo expiry and retention claims

Implement policy, migration grace, logical eligibility transitions, pins and API/UI reasons. Keep compact audit and conversations. This first subphase releases no physical Git refs and makes no disk-reclamation claim.

Gate: fake-clock tests immediately before/at/after expiry, Undo->Redo retention, pinned records, active operations, pending crash recovery, conversation branches and unpublished results. Concurrent Undo and expiry have a single valid outcome. Retrying historical operations cannot resurrect expired claims. In a disposable test repository, make expired objects genuinely unreachable and collect them, then verify historical fork/revert admission is honest and conversations remain readable.

**Phase 3b — independently gated physical ref release:** complete an audit of every receipt/action/branch/recall reference and legacy snapshot reader. Prove that eligible refs are exclusively Mousse-owned and no live claim requires them; release via expected-old-value transactions under ownership. Test receipt replay, pending-integration protection, real reachability and crash recovery before enabling the sweeper. Never delete objects directly, expire user/primary reflogs or force aggressive shared-repository GC. Phase 4 needs the logical claim protections, not proof that unrelated Git objects have been physically collected.

### Phase 4 — Safe retirement and dormant-agent recall

Implement manifests, idle runtime disposal, verified checkout retirement and native-agent reconstruction. Keep named identity/context across completion and restart. Record adapter limitations. Shared children never remove the task workspace.

Gate: complete->retire->restart->recall same name with checkout absent; exact context continuity and verified new revision notice; concurrent recalls serialize and late context writes fail; parent Undo/branch switching cannot revive invalid active context; unintegrated-result recall; dirty/untracked/ignored/conflicted files protected; stale directory replaced externally is not removed; recall racing cleanup either waits or wins through fencing. No old commands are replayed.

### Phase 5 — Trash, restoration and complete purge

Enable recoverable trash with its independent policy and ownership-aware purge. Integrate exclusive artifact/runtime-file cleanup and clear GUI/API progress, blocked reasons, restore action and irreversible-purge preview. Retire safely reconstructable task workspaces in trash.

Gate: trash->restart->restore with workspace absent; fan-out workflow purge removes exclusive invocation threads/indexes/staging as well as worktrees; shared artifacts/refs survive; explicit unpublished discard versus automatic retention; crash and restore attempt at every deletion boundary; trash racing child completion callbacks; repeat purge idempotent; Windows locked-file retry; Linux path/symlink cases; unavailable repository cannot lead to false completion.

### Phase 6 — Full application and storage qualification

Exercise the built Electron app and authenticated daemon protocol. Repeat the existing Git/Undo/workflow regressions. Add deterministic many-thread/many-episode fixtures with measurable byte inventories: after hibernation, completed isolated checkout count falls to zero where manifests prove removal safe; recalled agents remain usable; permanent purge returns exclusive resource counts to baseline. Do not count retained conversations or ordinary user Git history as leaked temporary storage.

Run Windows and hosted Linux suites. Perform one bounded live-provider sequence for named creation, completion, dormancy and recall using the previously authorized OpenCode Go/DeepSeek test setup when implementation is authorized; keep secrets in memory. Include crash recovery and unchanged primary checkout in the report. Run storage tests repeatedly to detect accumulation rather than asserting one cleanup succeeded.

## Rollout and completion criteria

Inventory-only first; enable new admission policies next; enable retirement/purge only after their gates pass. Persist schema versions and block old binaries from mutating lifecycle-managed resources they cannot understand. Disabling automation stops new cleanup but cannot restore permanently purged data. A failed migration never triggers cleanup. Record reasons/claims in a GUI storage view without promising exact per-owner Git bytes in a shared object database.

Phases 2 and 3 may run in parallel only after Phase 1 freezes claim kinds, lock/delegation order and the caller audit. Phase 5 depends on Phase 4's verifier; retirement and purge of the same resources are serialized. Phases 1–3 can temporarily increase metadata storage and do not establish storage reduction. Phase 6 must report checkout/runtime reclamation separately from retained conversation generations, protected dirty/conflict trees and reachable Git ancestry.

Complete when ordinary shared delegation no longer allocates unnecessary child checkouts, named native agents can be recalled after their runtime/checkout is gone, Undo expiry is visible and recovery-safe, all deletion routes obey the same ownership boundary, and repeated qualification demonstrates no accumulation of reclaimable owned resources. Preserve the explicit remaining limit: Git ancestry still reachable from retained/user branches is not a bounded cache.

## Independent plan review

### Astra — completed, revised plan accepted for Phase 1

A separate `gpt-6-astra` subagent reviewed the draft against baseline source with high reasoning, then reread the revisions, including the final Grok-driven changes. Its final disposition: "No remaining material blocker found. The revised plan is consistent and ready for Phase 1 planning/implementation once authorized." This is architectural readiness, not implementation authorization or a substitute for the acceptance tests.

| Finding | Disposition in this plan |
| --- | --- |
| P1: movable thread directories also contain execution/data/queue locks | Added stable external task-ID gate/tombstone, location generation and stale-path writer rejection before trash/restore. |
| P1: delegated writer and deletion drain ordering could deadlock or permit a surviving shell to write | Added one physical task lease with logical child authority, no repository lease across waits, and confirmed descendant/callback drain before reassignment. |
| P1: workflow-created invocation threads could survive parent purge | Added explicit ownership edges for generated threads, indexes/context, run/staging records and independent-retention exceptions. |
| P2: historical fork could reference code released by expiry | Added separate code-fork/revert capability, saved-branch claims, explicit unavailable state and conversation-only alternative. |
| P2: simultaneous recall could overwrite context; parent Undo could revive old instructions | Added one context-writing episode per identity, generation CAS, idempotent publication and parent-branch/context divergence handling. |
| P2: receipt generation does not track every live file write | Defined shared reads as non-snapshot observations; unchanged generation is never verification proof. |
| P2: restore during a partially executed permanent purge could expose broken data | Added external durable `purge_started` boundary before irreversible work; restore/cancel forbidden thereafter, cleanup recovery retained. |

These decisions and tests are included in Phases 1–5. Thirty-day windows and default current-code recall remain explicit proposed product policies.

### Grok — completed, findings incorporated

The installed Grok CLI completed successfully with `--model grok-4.7 --reasoning-effort high --permission-mode plan --no-subagents --disable-web-search`, reviewing the complete initial draft supplied as text. It explicitly did not inspect source. An earlier model-list authentication warning did not prevent the review; no sign-in action is required for this completed run.

Grok's initial verdict was not ready until the ownership/cleanup contracts were made explicit; it stated that the phase order was sound and the plan would be ready phase-wise after those revisions. It has not issued a second-pass approval. The following dispositions address that review in this revision:

| Finding | Disposition |
| --- | --- |
| Access must never broaden, and every writer must be fenced | Added explicit new-request requirement for alternatives, token/ownership binding and complete ingress audit; no fan-out mode change during compatibility rollout. |
| Phase 1 might unintentionally expand deletion | Froze Phase 1 to inventory and fenced reversible trash/restore; blocked complete purge until Phase 5; no ref release, retirement or new access defaults. |
| Claim kinds, human pins, authority and lock order need normative definitions | Added a closed versioned enum, condition-based system claim release, human-only pins/discard, one daemon authority and source-record authorization. Retained the source-compatible task-before-repository ordering instead of Grok's illustrative repository-before-task order, which would conflict with existing mutation paths. |
| Logical Undo expiry and physical ref release need separate gates | Added Phase 3b, receipt/reader audit, expected-old-value release, dependency-prefix/paired semantics, persisted adoption time and clock-jump safeguards. |
| Clean Git status and Git removal do not protect ignored/hidden files | Added filesystem/index walk, ignored/skip-worktree/assume-unchanged checks, nested repositories, reparse/mount boundaries, revalidation, default-deny content accounting and no force fallback. |
| Worktree-local HEAD does not prove reconstructability | Required repository-level pins and verified manifests before removal and before recalled execution. |
| Purge ordering, restore semantics and identifiers need definition | Added fresh inventory authority, external irreversible boundary, idle restore, visible partial cleanup and tombstoned identities. Astra's review independently covered the irreversible boundary. |
| Recall needs fresh capabilities and one episode per identity | Added invalidation of old paths/observations/tokens/approvals, provider/context compatibility checks and the serialized context publication contract. |
| Snapshot generations and shared caches may undermine storage claims | Explicitly excluded new writable-cache sharing and general transcript-generation deduplication; audited legacy snapshot readers as non-authoritative for expired claims. |

Two recommendations were refined rather than copied literally. Shared readers remain non-snapshot even if a mutation epoch is later added, because external writes cannot be proven absent by receipt generation. Legitimate repository links are preserved as data with non-following cleanup and capability-aware canonical access checks, rather than banning every outward link regardless of use. No writable-link bypass is allowed. These decisions keep the plan honest about Git worktrees not being process sandboxes.
