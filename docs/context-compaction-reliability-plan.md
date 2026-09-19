# Context, compaction, and task continuity remediation plan

Date: 2026-09-17

Status: implemented in the working tree; focused validation complete

Audited base commit: `6ab38bf5131e81c2959470bd2c8b6956f2585b48`, including the existing uncommitted working-tree changes

Primary incident: Avarnic Mousse thread `4fad9371-8aa5-43ae-986d-d7923b356a15`

## 1. Intended result and scope

Mousse must preserve the user's objective, corrections, constraints, outstanding work, and the origin of information across long tool loops, compaction, restart, model changes, and conversation branching. A build error may become a repair subtask; it must never silently become a user request. Completing that repair must not imply completion of the parent task.

This plan covers native transcript storage, summary generation, prompt assembly, context and usage accounting, compaction scheduling, main/subagent parity, steering, task and artifact bookkeeping, persistence/recovery, completion events, and the related UI and regression tests. It specifies recovery for already affected conversations. It does not authorize changes to the Avarnic application, automatic rollback of its changes, or resumption of its unfinished work.

The audit was read-only apart from creation of this document. Existing edits in Mousse belong to the current worktree and must be preserved when implementing the plan. Findings below distinguish reproduced defects, source-confirmed defects, and failure scenarios that still need an integration reproduction. Source line references describe the audited snapshot and may shift during implementation.

### Implementation record (2026-09-17)

The work packages below are implemented across the native-context core, main and subagent runtimes, durable thread storage/recovery, action bookkeeping, protocol/IPC surfaces, and context UI. The implementation includes archive-preserving typed compaction checkpoints, source-separated generated memory, active-request accounting, context-revision/model-bound measurements, subagent parity, atomic transcript/context publication, fail-closed generation recovery, revision-checked actions, truthful terminal events, queue admission provenance, and conversation boundary restore/snapshots for undo and branches.

Validation completed with TypeScript checks and green focused runs of 118 core reliability tests and 83 queue/native-loop tests (with overlap). The 50-compaction stress regression preserves the root objective and full native archive. The Windows browser-host E2E group still reports environment-level Electron request timeouts and `fs.watch` `EPERM` errors; those tests are called out in the handoff rather than represented as passing.

## 2. Incident evidence and interpretation

The thread's relevant user messages were:

| UTC time | User intent | Durable message ID |
| --- | --- | --- |
| September 16, 22:00:30 | Correct the `.env` target to the website at the repository root; explain the architecture. | `1ea18c5c-c2ca-4194-a48e-656584bbafa8` |
| September 16, 22:04:28 | “make it a single app, make everything svelte” | `f9171c2e-41d1-4674-9465-27193172a5e5` |
| September 16, 22:05:10 | “keep ur progress stored in a status / report file somewhere” | `60ac1250-d63e-4d5e-9c4e-c69e8758540b` |
| September 17, 00:02:41 | Ask whether two apps still exist. | `349af56f-7168-4746-891d-239c9fb06769` |
| September 17, 00:03:37 | “remove the nested app” | `3e09d4ba-f954-43a6-8c41-d826835afec0` |
| September 17, 00:37:58 | Ask why Calur marketing was changed; explicitly frame this as a question. | `e82a740f-3f86-4f8d-b45e-e20b659c8857` |

There were additional environment, quote-storage, and SQL requests between these messages. A correct task ledger must distinguish completed work, pending parent objectives, and later questions; it must not keep every historical request permanently active.

The model initially ended the consolidation turn with a narrow Vercel/Windows adapter report. It later acknowledged that the nested SvelteKit app remained. After the explicit removal request, it ended with “Implemented and verified the Calur marketing page fix.” When challenged, it claimed the user had only reported a build error. No such user message exists: the 404 came from the model's own build verification.

Porting the existing React Calur page was plausibly necessary to satisfy “make everything Svelte.” Source comparison indicates a substantial port of the existing design, so this audit does not classify every Calur edit as unauthorized redesign. Asset conversion and edits to the retired React route require a clearer necessity check. The unequivocal failures are loss of the governing objective, reporting completion against an incidental repair, and falsely attributing a build error to the user.

The saved thread contains 1,028 presentation messages and 1,005 native messages. There were 45 compaction events, including 16 during the removal turn. The durable context has `activeStartIndex: 950`, compaction generation `45`, and `tokensBefore: 39223`. That last number is recorded by the current estimator; it is not an independently measured post-compaction prompt size.

The final summary begins:

```text
Goal:

arget:1118
  process.nextTick(() => { throw err; });
...
Error: 404 /imgs/calur_image_1.png (linked from /calur/marketing)
...
Constraints / preferences:

(None explicitly recorded.)
```

The user goal and progress-file requirement are absent from the active summary. This is direct evidence of context corruption and strong evidence that compaction contributed to the later false explanation. It does not establish that compaction alone caused every earlier choice.

The requested `MIGRATION_STATUS.md` does exist in Avarnic. At audit time it says `Last updated: 2026-03-16`, although this thread's work happened in September, and lists `/calur/marketing` as a redirect while the current Svelte file implements a page. Thus the artifact was created but its bookkeeping became stale. The plan must preserve and refresh such an artifact, not merely remember that a file was once written.

Incident files are in the selected Mousse profile's `thread-data/repositories/<repository-id>/<thread-id>/messages.json` and `llm-context.json`. This incident directory has flat files and no manifest, generations, or journal; transaction/recovery rollout findings below are additional defects, not established causes of this incident. Keep the originals local. A committed regression fixture must be sanitized and reduced; do not commit profile exports, `.env` data, credentials, private tool output, or screenshots from the full thread.

## 3. Expanded audit findings

### Summary, provenance, and intent

| ID / priority | Finding and evidence | Required correction |
| --- | --- | --- |
| F01 / P0 | **Reproduced:** `buildStructuredSummary()` joins discarded messages, keeps the final 1,200 characters, and labels them `Goal`. It can begin mid-word. Tool output is included. [nativeContext.ts](../src/mms/orchestrator/nativeContext.ts#L239) | Replace character-tail summarization with source-linked structured state and bounded semantic/extractive summaries. |
| F02 / P0 | **Confirmed:** inline compaction does not explicitly carry prior summary state. The previous summary can enter the discarded text but is then removed by tail slicing. The durable path also retains only the last 1,200 characters of the previous summary under “Constraints.” [nativeContext.ts](../src/mms/orchestrator/nativeContext.ts#L175) | One compaction implementation must merge prior structured state with the newly archived range. |
| F03 / P0 | **Confirmed:** summaries are fabricated `user` messages and identified by a public text prefix. Hidden mode/workflow notices and internal wakes also use the user role. Genuine user input, host notices, and generated recollection are not durably distinguished in the native transcript. [nativeContext.ts](../src/mms/orchestrator/nativeContext.ts#L81), [OrchestratorService.ts](../src/mms/orchestrator/OrchestratorService.ts#L1672) | Introduce typed provenance; never infer message ownership or a compaction transaction from message text. Do not promote arbitrary summary/tool text into system authority either. |
| F04 / P1 | **Confirmed design gap:** the native schema has no durable objective/constraint ledger. Task tools exist, but are optional and task descriptions/statuses do not supply objective provenance or acceptance evidence. Main-thread completion is not reconciled against the governing objective. [types.ts](../src/shared/types.ts#L779), [TaskControlTools.ts](../src/mms/tasks/TaskControlTools.ts), [systemPrompt.ts](../src/mms/orchestrator/systemPrompt.ts#L50) | Persist source-linked objectives and progress independently of lossy summaries; project them into existing task tools rather than inventing a competing task list. |
| F05 / P1 | **Confirmed provenance weakness; crash scenario needs integration reproduction:** steer delivered after a tool is appended inside that tool result; plain-answer steer becomes a synthetic user message. Steer queue entries can be removed before the returned native snapshot is checkpointed. [steer.ts](../src/mms/orchestrator/steer.ts), [LlmClient.ts](../src/mms/orchestrator/LlmClient.ts#L1086), [OrchestratorService.ts](../src/mms/orchestrator/OrchestratorService.ts#L2949) | Persist accepted user steer with its source ID first, track delivery/acknowledgment separately, and preserve it through summaries without trusting marker-like tool text. |
| F06 / P1 | **Confirmed:** `extractLastUserText()` can select the summary when earlier real user messages have been compacted away. It feeds explicit skill selection at request construction. [LlmClient.ts](../src/mms/orchestrator/LlmClient.ts#L832), [LlmClient.ts](../src/mms/orchestrator/LlmClient.ts#L2281) | Select current genuine user input by provenance; retain applicable skill/mode obligations across compaction and retries. |

### Accounting, scheduling, and compaction validation

| ID / priority | Finding and evidence | Required correction |
| --- | --- | --- |
| F07 / P0 | **Confirmed in incident and code:** periodic compaction uses the sum of each provider call's processed tokens, including repeated cached prompt work. A ~42k prompt can cross a 256k interval after roughly six calls despite low occupancy. [toolLoopSafety.ts](../src/mms/orchestrator/toolLoopSafety.ts#L50), [LlmClient.ts](../src/mms/orchestrator/LlmClient.ts#L939) | Separate usage telemetry from context pressure; schedule from the actual assembled request budget. |
| F08 / P0 | **Reproduced:** `estimateActiveContextTokens()` trusts the newest retained assistant's old usage even after compaction. In a synthetic case the estimate remained 90,019 before and after shrinking the text to 408 estimated tokens. Clearing `lastTurnUsage` does not invalidate usage embedded in archived assistant messages. [nativeContext.ts](../src/mms/orchestrator/nativeContext.ts#L153) | Bind measurements to a request/context revision and invalidate after any prefix replacement. Keep original usage as archival telemetry. |
| F09 / P1 | **Confirmed:** pre-turn accounting adds prompt/tool estimates to an estimate that may already include those overheads from provider usage. Conversely the fallback loop estimate counts only messages, images have no allowance, and the reserve argument is ignored. [OrchestratorService.ts](../src/mms/orchestrator/OrchestratorService.ts#L2602), [nativeContext.ts](../src/mms/orchestrator/nativeContext.ts#L127) | One request budget including prompt, tools, supported media estimates, output headroom, and uncertainty; no duplicate counting. |
| F10 / P1 | **Confirmed:** measurement signatures include prompt/schema text but omit concrete model identity. `getContextInputs()` also prepares a different context shape from real chat: it uses the project getter and lacks the actual per-request browser/subagent/actor binding. [LlmClient.ts](../src/mms/orchestrator/LlmClient.ts#L1336), [LlmClient.ts](../src/mms/orchestrator/LlmClient.ts#L1519) | Build one immutable request envelope and measurement identity from the actual execution context. Preview metering must use the same inputs or clearly report an estimate. |
| F11 / P1 | **Confirmed:** migrated threads reject valid provider prompt measurements indefinitely because `legacyEstimated` disables the measured branch. Archive fidelity and measurement accuracy are different properties. [contextUsage.ts](../src/mms/orchestrator/contextUsage.ts#L50) | A valid measurement wins for its matching active request; expose legacy archive fidelity separately. |
| F12 / P0 | **Reproduced:** `applySafeBoundaryCompaction()` accepts any array, including `[]`, despite promising invalid results leave context intact. Exceptions collapse to an unchanged transcript without a reason. [toolLoopSafety.ts](../src/mms/orchestrator/toolLoopSafety.ts#L64) | Validate a typed candidate and return distinct committed/skipped/failed outcomes. Never accept an empty or semantically invalid replacement. |
| F13 / P1 | **Confirmed limitation:** the cut algorithm avoids starting on a tool result but does not verify complete call/result ID sets. Assistant calls and each result are checkpointed separately; interruption can persist an incomplete batch. [nativeContext.ts](../src/mms/orchestrator/nativeContext.ts#L225), [LlmClient.ts](../src/mms/orchestrator/LlmClient.ts#L1075) | Validate provider protocol boundaries, record tool execution states, and normalize interrupted requests before resend. Test crash/abort boundaries. |
| F14 / P1 | **Confirmed:** fixed 20k retained history is independent of model size or irreducible request overhead. There is no required reduction test; summary overhead or one huge batch can make compaction ineffective. [nativeContext.ts](../src/mms/orchestrator/nativeContext.ts#L13) | Compute a budgeted target, verify reduction, and handle oversized pinned content/tool batches explicitly. |

### Persistence, lifecycle, and user-visible bookkeeping

| ID / priority | Finding and evidence | Required correction |
| --- | --- | --- |
| F15 / P1 | **Reproduced helper failure:** if the retained suffix cannot exactly match the archive, `commitNativeMessages()` silently concatenates the full old archive and retained messages. A retained suffix plus one new message produced `Original, Recent, Recent, New message`. Exact JSON suffix search is also expensive. Actual callback timing causing this mismatch needs integration coverage. [nativeContext.ts](../src/mms/orchestrator/nativeContext.ts#L93) | Commit explicit message IDs/ranges against an expected revision; reject stale/mismatched commits and never guess by concatenation. |
| F16 / P0 | **Source-confirmed:** subagent compaction replaces `session.history` with the compacted array, and export/reload persist only that shortened array. Older native history is lost, unlike the main thread archive. [MousseAgentService.ts](../src/mms/agents/MousseAgentService.ts#L419), [MousseAgentService.ts](../src/mms/agents/MousseAgentService.ts#L583) | Give main and subagent sessions the same archive + active-view + compaction metadata model. |
| F17 / P1 | **Source-confirmed:** subagents lack pre-first-call compaction and the main thread's one-time context-overflow recovery. The shared loop only checks after at least one model call. [MousseAgentService.ts](../src/mms/agents/MousseAgentService.ts#L887), [LlmClient.ts](../src/mms/orchestrator/LlmClient.ts#L968) | Apply the same preparation and bounded overflow recovery to every session type. |
| F18 / P1 | **Confirmed:** the subagent meter remains its initial `0 / 128k`; its setter is unused. Subagent session usage stores aggregate processed tokens, not a usable prompt measurement. [MousseAgentChat.tsx](../src/renderer/components/MousseAgentChat.tsx#L23), [MousseAgentService.ts](../src/mms/agents/MousseAgentService.ts#L958) | Add scoped metering through service/protocol/preload/UI and store actual request measurements. |
| F19 / P1 | **Confirmed:** settings describe periodic compaction, while the popover says it starts at 95%. Compaction notes have only start/complete/unchanged; failures can read as “no older messages.” Pre-turn “complete” is emitted/persisted before assigning the compacted context. [SettingsPage.tsx](../src/renderer/components/SettingsPage.tsx#L654), [ContextUsagePopover.tsx](../src/renderer/components/ContextUsagePopover.tsx#L114), [OrchestratorService.ts](../src/mms/orchestrator/OrchestratorService.ts#L2583) | Align policy copy and emit terminal events only after a durable commit, with reasons and revision IDs. |
| F20 / P1 | **Confirmed storage gap:** flat files are individually atomic but a conversation/native/tasks update is not a single transaction by default. Missing and malformed JSON both fall back silently; a malformed native context can be rebuilt from lossy UI history. Native context shape/boundaries are not validated on load. [ThreadDataStore.ts](../src/mms/data/ThreadDataStore.ts#L431), [ThreadDataStore.ts](../src/mms/data/ThreadDataStore.ts#L536), [ThreadDataStore.ts](../src/mms/data/ThreadDataStore.ts#L852) | Publish one validated context checkpoint; distinguish missing, corrupt, and unsupported state; preserve recovery evidence. |
| F21 / P1, feature-gated | **Source-confirmed gaps:** generation storage exists but ordinary publication initializes action/branch arrays to empty and omits workspace data. Action services maintain separate flat files. The recovery service has no production caller found under `src`, and save recovery cannot infer every publish/journal crash gap. [ThreadDataStore.ts](../src/mms/data/ThreadDataStore.ts#L573), [ThreadGenerationStore.ts](../src/mms/data/ThreadGenerationStore.ts), [ThreadRecoveryService.ts](../src/mms/data/ThreadRecoveryService.ts) | Reuse and finish the existing transaction/recovery design; preserve all owned collections and wire startup reconciliation. Do not claim the incident used this disabled-by-default path. |
| F22 / P1, feature-gated | **Confirmed:** turn checkpoints hardcode compaction generation `0`, branch `main`, fidelity `exact`, and a safe-boundary sentence, including stopped/failed calls. The index is active-view length rather than a stable archive boundary. Fork validates only that the proof string exists. Branch activation/undo services change Git/metadata without restoring active native conversation state in the inspected services. [OrchestratorService.ts](../src/mms/orchestrator/OrchestratorService.ts#L2546), [ConversationBranchService.ts](../src/mms/actions/ConversationBranchService.ts#L37), [UndoService.ts](../src/mms/actions/UndoService.ts) | Persist validated before/after context references and coordinate code, conversation, summary, task state, and branch selection. |
| F23 / P1 | **Confirmed:** `turn-completed` is emitted in the LLM-call `finally`, before final response/task actions/checkpoint persistence, including non-abort failures. The server translates it to completed activity. [OrchestratorService.ts](../src/mms/orchestrator/OrchestratorService.ts#L2712), [server.ts](../src/mms/protocol/server.ts#L376) | Separate model-loop settlement from durable turn outcome and objective completion; keep ownership until finalization completes. |
| F24 / P1 | **Incident-confirmed:** the progress artifact has stale date/route claims, and the final response describes a leaf repair instead of the requested consolidation. Existing tests exercise mechanics and hand-authored summaries, not intent retention or completion fidelity. [nativeContext.test.ts](../tests/nativeContext.test.ts#L76), [contextCompactionSettings.test.ts](../tests/contextCompactionSettings.test.ts#L33) | Track artifact revisions and verification evidence; gate task completion on acceptance criteria; add behavioral and repeated-compaction evaluations. |
| F25 / P0 | **Source-confirmed acceptance gap; crash reproduction required:** queue provenance checks only for a `queueItemId` in presentation messages. If flat messages were saved but native context was not, acceptance can complete without the model durably receiving the instruction. Additionally, the loader's silent fallback can turn corrupt provenance into apparent non-acceptance instead of `unavailable`. [OrchestratorService.ts](../src/mms/orchestrator/OrchestratorService.ts#L1623), [OrchestratorService.ts](../src/mms/orchestrator/OrchestratorService.ts#L1733) | Acknowledge against committed user-event/context identity; preserve the distinction between absent and unreadable provenance. |
| F26 / P1, feature-gated | **Source-confirmed:** transactional hydration reads the queue frozen in a generation, while queue mutations update only top-level `queue.json`. Startup work detection can therefore read stale queued work. [ThreadDataStore.ts](../src/mms/data/ThreadDataStore.ts#L431), [ThreadDataStore.ts](../src/mms/data/ThreadDataStore.ts#L494), [ThreadRuntimeManager.ts](../src/mms/runtime/ThreadRuntimeManager.ts#L283) | Keep one live queue authority. Hydration must load the authoritative queue revision, not a historical snapshot. |
| F27 / P1, dormant recovery path | **Source-confirmed:** recovery does not treat `recovery_required` as settled for automatic reconciliation, so repeated calls append more identical records. It also reads the current manifest once before repairing multiple operations and can compare later repairs to stale state. [ThreadRecoveryService.ts](../src/mms/data/ThreadRecoveryService.ts#L10) | Make reconciliation idempotent, update the selected generation after each repair, and never republish an older generation. Preserve unresolved recovery decisions explicitly. |
| F28 / P1, action path | **Source-confirmed:** action optimistic concurrency compares `expectedJournalGeneration` with manifest journal sequence, although action services append journal records without publishing that manifest. Without a manifest it stays zero. The check occurs before action mutation locks. [handlers.ts](../src/mms/protocol/handlers.ts#L127), [UndoService.ts](../src/mms/actions/UndoService.ts#L25) | Validate an actual operation revision under the owning lock/lease, reject stale concurrent actions, and rehydrate/invalidate the live session after the committed operation. |
| F29 / P1 | **Source-confirmed:** optional native context cannot be explicitly cleared through the patch API (`undefined` means preserve); flat saves omit absent values and can leave stale context/session files behind. [ThreadDataStore.ts](../src/mms/data/ThreadDataStore.ts#L463), [ThreadDataStore.ts](../src/mms/data/ThreadDataStore.ts#L558) | Define preserve/replace/clear operations, tombstone cleared fields in the authoritative checkpoint, and reconcile compatibility projections. |
| F30 / P2 | **Source-confirmed:** queue removal may return `removed: null` when an item was claimed concurrently, but the UI ignores that result and clears the error. [handlers.ts](../src/mms/protocol/handlers.ts#L515), [QueuedMessages.tsx](../src/renderer/components/QueuedMessages.tsx#L202) | Return a typed removal outcome; refresh authoritative queue state and explain that the item has already started instead of implying removal. |

Existing protections must be retained: native provider blocks/signatures are preserved in the main archive; common suffix cuts avoid orphaned results; atomic file replacement, execution leases, queue claim provenance, and generation primitives already exist; subagents restore running sessions as interrupted instead of automatically replaying them. This plan extends those protections rather than treating every subsystem as absent.

## 4. Design contract

### 4.1 Separate the archive, task state, working memory, and provider request

Use four explicitly related representations:

1. **Canonical archive:** append-preserved native events with stable host IDs and typed origins. Keep original provider payloads, signatures, images, tool arguments/results, and usage intact. Archive retention/GC is a separate policy from compaction.
2. **Task state:** source-linked user objectives, constraints, corrections, decisions, acceptance criteria, progress artifacts, and unresolved questions. Existing task queue entries reference this state. Host lifecycle state cannot itself establish that the user's task is finished.
3. **Compaction checkpoint:** structured recollection of a specific archived range, plus pinned directive references and the boundary of an unchanged recent suffix. It is a derived index over the archive, not replacement evidence.
4. **Prepared request:** provider-compatible active messages plus selected prompt, skills, tool schemas, media, model parameters, and budget identity. It is constructed from one versioned snapshot and is the sole basis for metering and sending.

Proposed host-side types, with final naming chosen during implementation:

```ts
type MessageOrigin =
  | 'user' | 'user-steer' | 'assistant' | 'tool'
  | 'host-notice' | 'workflow-event' | 'delegated-report';

interface ContextEvent {
  id: string;
  sequence: number;
  turnId: string;
  origin: MessageOrigin;
  sourceMessageId?: string;
  queueItemId?: string;
  native: Message; // unmodified provider data, not overloaded with host IDs
}

interface Directive {
  id: string;
  sourceEventIds: string[];
  exactText: string;
  kind: 'objective' | 'constraint' | 'correction' | 'question';
  state: 'active' | 'satisfied' | 'superseded' | 'cancelled';
  supersededBy?: string;
  objectiveId?: string;
}

interface CompactionCheckpoint {
  schemaVersion: 2;
  id: string;
  generation: number;
  sourceRevision: string;
  coveredThroughEventId: string;
  retainedFromEventId: string;
  directiveIds: string[];
  summary: StructuredSummary;
  validation: { protocolValid: true; sourcesValid: true };
  estimateBefore: number;
  estimateAfter: number;
  createdAt: string;
}
```

`StructuredSummary` should have separate fields for objectives, user constraints, accepted decisions, verified progress, pending work, blockers, artifacts, and untrusted observations. Facts cite archive event IDs or versioned artifact evidence. “Unknown” must remain unknown; missing information must not become “none explicitly recorded.” Keep raw user directives verbatim where they define ongoing scope.

A user follow-up can add a constraint, change scope, replace an objective, ask a question, or cancel work. Do not treat the latest message automatically as a replacement goal. Equally, do not revive completed requests simply because they appeared earlier. Record explicit supersession links and evidence. Ambiguity remains a stated inference until resolved; tool output cannot authorize new work.

### 4.2 Preserve authority without fabricating a user

Store compaction metadata outside `Message[]`; stop interpreting `[Compacted conversation summary]` as a control signal. A real user may type that exact string without triggering archive mutation.

Provider adapters should compile host framing separately from summary data. Retain genuine user directives with their actual provenance, and present generated recollection/observations as clearly identified context data in a supported lower-authority representation. Do not solve F03 by pasting arbitrary summary contents into a system/developer instruction. Provider-specific role constraints need adapter tests; the canonical store must not depend on one provider's available roles.

Host-generated steer framing must reference a durably accepted user event. A webpage/tool result containing identical markers must remain tool data. Rebuilding a prompt, retrying, or compacting must preserve this distinction. Skill selection should read accepted user events and persisted applicable obligations, never summary prose.

### 4.3 One budget calculation

Maintain separate values for `activePromptTokens`, `reservedOutputTokens`, `measurementUncertainty`, cumulative `processedTokens`, and monetary usage. Cached input counts once toward a request's occupancy, and repeatedly processed input remains valid spend telemetry without becoming new context.

A provider measurement is usable only if its provider/model/API, prepared prompt/tool identity, context revision, and measured prefix boundary match. A matching measurement covers prompt/tool overhead once; estimate only newly appended material. After compaction, model switch, branch switch, or prompt/tool change, invalidate it and estimate the new assembled request until a matching measurement arrives. Keep historical assistant usage unchanged as evidence.

Recommended trigger:

```text
safeInputCeiling = modelContextWindow - reservedOutputTokens - uncertaintyAllowance
occupancyWatermark = min(configuredInputThreshold, floor(0.95 * modelContextWindow))
effectiveTrigger = min(safeInputCeiling, occupancyWatermark)
compact when assembled active prompt reaches effectiveTrigger
```

This intentionally changes the numeric setting from a processed-work interval to an active-input threshold. Version the setting, update labels/help/tests, and document migration. Treat “Model Max Context” as the model's safe input ceiling, never permission to consume all output headroom. Calibrate output reserve from actual provider/model request limits rather than an ignored constant. Do not silently remove explicit opt-out: with compaction disabled, return a clear overflow outcome when a request cannot fit.

Size recent-history retention from the remaining budget after mandatory directives, summary, prompt, tools, and reserves. Preserve useful recent tool batches; do not blindly reduce every model to 20k history. Add hysteresis and an archive-growth/reduction check. An unchanged transcript or unchanged irreducible batch must not trigger an endless compaction loop. Cooldowns must not permit over-budget provider requests.

### 4.4 Compaction is a validated transaction

Use one operation for pre-turn, mid-turn, overflow recovery, manual compaction if exposed, main sessions, and subagents:

1. Snapshot context/task revisions and capture a complete tool-batch boundary. Record the reason and budget.
2. Select the archived range and retain mandatory directives and unresolved work. Include previous structured memory explicitly.
3. Generate a bounded structured summary with a tool-free request through the existing provider abstraction. Use the active selected provider/model by default; any separate summarizer setting must be explicit. Track its usage separately and disable recursive compaction for the summarizer call.
4. Validate schema, source IDs, directive coverage, boundary integrity, role provenance, unchanged retained native data, and meaningful size reduction.
5. Recheck revision/steer/abort state. Discard or recompute a stale candidate; never overwrite newer input.
6. Atomically publish archive references, task state, checkpoint, invalidated measurements, and event outcome. Increment compaction generation exactly once.
7. Send the next model request from the committed revision. Emit `completed` only after persistence succeeds.

If semantic summarization fails, retain the original active context. A deterministic fallback may preserve exact directives and source-linked artifact/progress records while omitting verbose observations, but must pass the same validation. If no safe candidate fits, stop with a recoverable context-capacity error. Do not fall back to arbitrary tail slicing or deletion. A single oversized user message or tool batch needs explicit handling and an actionable outcome.

For huge tool output, keep full local evidence where appropriate and send bounded excerpts/reference IDs with a retrieval path; do not discard required tool protocol records or silently truncate user directives. Preserve image references and mark unavailable attachments. Never estimate image cost from base64 length; use adapter-supported estimates or a conservative uncertainty allowance.

## 5. Implementation work packages

### WP0 — Capture the incident and establish regression baselines

**Covers:** F01–F30 evidence; prerequisite to implementation.

- Add a sanitized incident fixture containing the root-site correction, parent migration objective, status-artifact requirement, nested-app removal, long tool logs, Calur 404, completion, and explanatory follow-up. Include unrelated completed requests to test relevance and supersession.
- Add deterministic tests that fail against the current implementation for lost directives, stale measurements, empty-candidate acceptance, unmatched-commit duplication, and subagent archive loss. Preserve existing native/signature/queue tests.
- Record active context and request identity at every replay step. Save snapshot hashes, event counts, and acceptance results; exclude sensitive content.
- Establish test helpers for interrupted multi-tool batches, mock provider overflow, summary failure, persistence fault injection, model switching, and reload.

**Acceptance:** the fixture reproduces the wrong summary without an external model call; new assertions expose the reported defects; a live-model evaluation is supplementary rather than the only regression test.

### WP1 — Introduce versioned context identity and durable intent

**Covers:** F03–F06, F15, F24. Depends on WP0.

**Primary files:** `src/shared/types.ts`, `src/mms/orchestrator/nativeContext.ts`, `ThreadSession.ts`, `OrchestratorService.ts`, `src/mms/tasks/TaskQueue.ts`, `TaskControlTools.ts`, and new narrowly scoped context/intent modules.

- Add v2 archive event IDs, context revisions, provenance, active-range/checkpoint references, and task-state links. Keep the provider-native representation byte-equivalent where serializable.
- Replace text-marker discovery and JSON suffix matching with typed append/compaction operations carrying expected revision and explicit boundaries. Reject unknown, duplicate, out-of-order, or stale event operations with a recoverable error.
- Bind visible user messages, hidden notices, workflow events, queued input, and steer to archive IDs. Preserve existing queue claim IDs and ownership locks.
- Store objectives/constraints/acceptance evidence in the existing thread task domain or an associated ledger; do not require users to invoke `create_task` just to preserve their request. Expose a bounded projection to the model.
- Track a requested progress document as an artifact: path, owning objective, last successful write event, content hash/revision, verification state, and UTC timestamp supplied by the host. Recognize external edits and reconcile before overwriting.
- Pin outstanding directives and applicable mode/skill obligations independently of summary wording. Use provenance to find the actual latest user request.

**Acceptance:** the incident's parent objective and status-file requirement survive 50 successive checkpoints/reloads; exact marker text typed by a user does not alter context metadata; completing a Calur repair leaves parent acceptance checks pending until verified.

### WP2 — Replace the compactor and validate provider boundaries

**Covers:** F01–F03, F12–F14. Depends on WP1.

**Primary files:** `nativeContext.ts`, `toolLoopSafety.ts`, `LlmClient.ts`, provider request compilation, new summary schema/service modules.

- Implement the shared transaction described in section 4.4. Both old compaction entry points must delegate to it or be removed after migration.
- Use structured, source-linked summaries with an explicit prior-state merge. Never summarize a summary's tail recursively.
- Protect active user directives, unresolved errors, accepted scope changes, pending tool/process handles, and report artifacts. Tool errors belong under observations/blockers, never under user goals.
- Validate complete tool-call/result ID groups, including multi-call batches and interruption outcomes. Preserve reasoning/tool signatures and provider-specific blocks; do not reconstruct hidden reasoning from UI text.
- Return typed outcomes such as `committed`, `skipped_no_reduction`, `skipped_stale_revision`, `failed_summary`, `failed_validation`, `failed_persistence`, and `capacity_exhausted`.
- Add summary timeout/cancellation, bounded retry, token budgeting, and diagnostics. Summary generation must have no mutation tools and no authority to change objective state by itself.

**Acceptance:** malicious or irrelevant tool text cannot replace user intent; empty/malformed/oversized/unsupported summary candidates cannot enter active context; failed generation preserves the previous valid context; repeated compaction remains source-grounded and bounded.

### WP3 — Unify request preparation, usage, and triggers

**Covers:** F07–F11, F14, F17, F19. Depends on WP1; integrates WP2.

**Primary files:** `LlmClient.ts`, `contextUsage.ts`, `toolLoopSafety.ts`, `OrchestratorService.ts`, `src/shared/settings.ts`, settings validation/configuration, provider usage normalization.

- Prepare one immutable request envelope with actual session project/worktree, mode, actor grants, loaded skills, browser binding, enabled tools, provider/model/API/effort, media, and context revision. Reuse it for budget calculation and the corresponding send.
- Replace full prompt text in persisted measurement signatures with a bounded content hash plus explicit identity fields. Preserve inputs needed for local debugging without copying all schemas into every measurement record.
- Attach prompt measurements to the exact request boundary, not a guessed `messages.length - 1`. Do not label aggregate trusted-agent usage as a last-request measurement. Abort/tool-result-only endings invalidate or correctly retain the last known boundary.
- Remove cumulative processed-token scheduling and choose the active-input policy in section 4.3. Apply it before the first provider request and between completed tool batches.
- Permit valid measurements on legacy archives; expose archive fidelity separately. Include media uncertainty and output reserve in all entry paths.
- On recognized provider context overflow, compact the current valid checkpoint and retry once. Count retries per failed request identity, avoid re-executing completed tools, and do not retry authentication/network errors through the overflow path. If compaction makes no safe reduction, return the capacity error.

**Acceptance:** a stable 42k prompt never compacts solely because repeated cached calls cross 256k processed tokens; near-capacity requests do compact; post-compaction estimates fall; prompt/tool overhead is counted once; model/project/skill/tool changes invalidate mismatched measurements.

### WP4 — Make persistence and recovery preserve one consistent checkpoint

**Covers:** F15, F16, F20–F22, F25–F29. Depends on WP1; coordinate existing transactional-store work.

**Primary files:** `ThreadDataStore.ts`, `ThreadGenerationStore.ts`, `ThreadJournal.ts`, `ThreadRecoveryService.ts`, `AtomicFs.ts`, `src/shared/threadActions.ts`, `src/mms/actions/*`.

- Reuse the existing immutable generation/manifest and journal primitives. Do not add an unrelated snapshot system. Publish native archive references, active view, structured summary, tasks, accepted-input provenance, and their presentation revision consistently.
- Define collection ownership. A thread-data save must preserve current actions, conversation branches, workspace, and subagent state unless its typed patch intentionally changes them. Do not publish empty placeholders over existing collections.
- Keep queue writes under the existing queue mutation lock; record which queue revision/provenance was observed. Avoid introducing a generation/queue lock-order deadlock or replacing newer queued input with a stale snapshot.
- Keep `queue.json` as the live queue authority during the initial transaction rollout, and treat generation queue contents as historical observations only. Hydration/startup must read the live queue through its existing domain API. If a later change moves queues into generation commits, migrate every reader/writer together. Claim completion must reference a committed user event in the native/context checkpoint, not only a presentation row.
- Journal enough intent/result identity to recover before staging, after generation rename, after manifest publication, and before/after the completion record. Wire reconciliation before a thread accepts new execution. A committed manifest must not later be called cancelled solely because a completion record is absent.
- Refactor publication into explicit recoverable steps: planned intent, running operation, durable generation, journaled result-generation identity, manifest compare-and-swap, terminal record. Handle the gap before result journaling through the generation's journal identity and checksums. Make repeated recovery a no-op, keep unresolved `recovery_required` stable, and update the current manifest after each repair.
- Distinguish absent legacy state from corrupt current state and unsupported schema versions. Validate message types, IDs, source references, active boundaries, finite token counts, compaction generation, and measurement identity. Preserve corrupt originals and report recovery status; do not silently overwrite them with lossy UI reconstruction.
- Add explicit preserve/replace/clear semantics to typed patches. A cleared context/session field must not reappear after reload from an old flat file. Retain recovery copies according to policy, and distinguish an intentional reset from accidental corruption.
- Publish compatibility flat files only as a projection of the committed checkpoint. During staged rollout, define the authoritative read path and prevent flag changes from reviving stale flat state. Keep previous valid generations for recovery under an explicit retention policy.
- Record turn **before and after** archive boundaries, branch IDs, compaction checkpoint IDs, fidelity, and validated protocol state. Remove hardcoded generation/proof fields. Fork/activate/undo must restore the matching conversation/task checkpoint as well as code; stopped/failed actions must not claim a completed safe boundary.
- Check the actual operation/journal revision while holding the existing thread operation/execution lease and Git coordination lock in a documented order. A second concurrent undo/fork using a stale revision must fail. Ensure advertised feature flags are enforced at the service boundary as well as the UI; do not expose partially integrated conversation operations.

**Acceptance:** injected crashes leave either the old complete checkpoint or the new complete checkpoint; reload never combines a new summary with an old boundary; queue items are neither lost nor duplicated; actions/branches survive unrelated saves; fork/undo cannot silently carry later instructions or summaries into an earlier branch.

### WP5 — Give subagents the same context lifecycle

**Covers:** F16–F18. Depends on WP1–WP4.

**Primary files:** `MousseAgentService.ts`, `MousseAgentSessionSnapshot`/usage types, protocol handlers/types/validators, preload and IPC, `MousseAgentChat.tsx`.

- Migrate the v1 flat `history[]` snapshot to a v2 native context plus task/assignment reference. Preserve all surviving history and explicitly mark any previously compacted missing prefix; do not claim to reconstruct lost provider state.
- Use the same append/compaction commit, request budget, overflow recovery, measurement, and event services as the main orchestrator. Preserve assigned provider/model/effort, worktree instructions, grants, and independent cache affinity.
- Archive older native history rather than overwriting it during compaction. Export/reload must preserve the archive, active boundary, summary generation, assignment, and latest matching request measurement.
- Add an agent- and thread-scoped context-usage endpoint with authorization/ownership validation. Implement protocol, IPC/preload, and UI polling/subscription with stale-response cancellation when switching agent/thread.
- Keep the existing interrupted-on-reload behavior; do not automatically replay tool effects or resume work because a context was migrated.

**Acceptance:** main and subagent replay of the same supported transcript produce equivalent active-context semantics; a restored near-limit subagent can compact before its first request; the meter reflects its assigned model and actual state rather than `0 / 128k`.

### WP6 — Correct completion, steer, and progress bookkeeping

**Covers:** F04–F06, F13, F19, F23–F25, F30. Depends on WP1/WP4; integrate WP2/WP3.

**Primary files:** `OrchestratorService.ts`, `LlmClient.ts`, `steer.ts`, `ThreadSession.ts`, task services, `src/mms/protocol/server.ts`, turn/runtime state and streaming adapters.

- Persist user input/steer acceptance before consumption. Track accepted, injected, and acknowledged IDs; retries and reloads must not lose guidance or inject it twice. A pending correction must invalidate a summary candidate based on an older task revision.
- Distinguish queue removal outcomes (`removed`, `already_claimed`, `not_found`) through protocol/preload/UI. On a concurrent claim, refresh state and report the real outcome. Do not reinterpret a failed removal as permission to cancel already-running work.
- Persist tool execution intent and outcome keyed by call ID. For an interrupted batch, represent unstarted calls as cancelled/not started; represent a started call with unknown outcome as unresolved. Never auto-replay an external side effect solely to reconstruct missing context.
- Keep `model_loop_settled`, `turn_finalizing`, `turn_completed/failed/stopped`, and `objective_completed` distinct. Emit durable terminal events after final response, task actions, required checkpoints, and persistence settle. Release the execution lease at the true end boundary.
- Before a completion response, reconcile acceptance criteria against actual evidence. If only a repair subtask is done, report partial progress and outstanding parent work. This is an evidence/response check, not an infallible classifier or a blanket ban on necessary file changes.
- Update requested status/report artifacts after meaningful milestones and before reporting completion. Use actual timestamps and verified route/build facts; record failure to update. Do not manufacture test success or overwrite user-authored sections without reconciliation.
- On a question such as “why did you change this?”, retrieve the relevant user directive and actual edit/build evidence. Explain necessity or admit the specific unnecessary change. Do not invent a different user request or automatically revert code.

**Acceptance:** failure is never published as successful completion; no parent task becomes complete from a successful incidental build repair alone; the incident follow-up receives an evidence-based explanation; status artifact and final report agree on verified outcomes and remaining diagnostics.

### WP7 — Expose useful diagnostics and stage rollout

**Covers:** F18–F20, F24, F30; release integration for all findings.

**Primary files:** context/settings UI, protocol event types, usage telemetry, local diagnostics, test/evaluation fixtures, release/migration documentation.

- Show active prompt usage, estimate/measurement status, output reserve, current model capacity, and processed-work telemetry as distinct values. State when media or legacy data makes an estimate uncertain.
- Show compaction reason, state, before/after estimates, generation, and error/skipped reason. An optional local detail view may show source-linked pinned objectives and summary quality status. Do not log raw prompts, secrets, or tool bodies into telemetry.
- Remove artificial UI delays once durable event ordering handles the transition. Persist terminal outcomes so reload does not leave a perpetual “Compacting” card.
- Track attempts/commits/failures, trigger reasons, token reduction, invariant failures, repeated attempts on the same revision, summary latency/usage, and archive growth. Distinguish storage generation from compaction generation.
- Release behind a single coherent v2 context capability, with reader compatibility and migration tested before writes are enabled. Never roll back by downgrading v2 data into lossy v1 summaries. Disable v2 writes if necessary while preserving readable archives and backups.

**Acceptance:** settings, runtime behavior, UI labels, and tests describe the same policy; users can understand why compaction occurred; diagnostic output proves which context revision reached the provider without exposing private content by default.

## 6. Required regression and evaluation matrix

| Test group | Required cases | Pass condition |
| --- | --- | --- |
| Incident replay | Consolidation objective, root `.env` correction, status requirement, nested removal, Calur tool 404, follow-up question | Tool error remains an observation; actual user intent is recoverable; final explanation does not attribute the error to the user. |
| Repeated summaries | 1, 2, 16, and 50 compactions; reload between each; prior checkpoint present | Active constraints and unresolved objectives survive; superseded/completed objectives do not reactivate; summary size stays within budget. |
| Provenance | User types the summary prefix; tool emits fake steer/summary instructions; hidden workflow notices; delegated reports | No marker text changes host state; only accepted user events can update user directives. |
| Summary failure | Timeout, abort, malformed schema, empty array, invalid source IDs, missing directives, fabricated facts, no reduction | Old valid context remains usable; exact failure reason recorded; generation unchanged. |
| Budget | Repeated cached calls with constant ~42k prompt; 256k setting; near-capacity prompt; small model; output reserve | Processed work cannot trigger compaction; occupancy/headroom can; no infinite loop or over-budget send. |
| Measurement validity | Compact 90k-measured history to a few hundred estimated tokens; switch model/provider/project/skills/tools; valid legacy measurement | Stale measurements are rejected; overhead counted once; matching legacy measurement is used. |
| Media and large batches | Images, empty text, one giant tool result, multi-tool batch, output larger than retained target | Uncertainty is explicit; protocol is valid; oversized content produces bounded references or a recoverable capacity outcome. |
| Archive commits | Repeated identical messages, unmatched suffix, appended messages during compaction, retry same commit | No duplicates/loss; stale candidate rejected; idempotent commit increments generation once. |
| Subagents | Compact, export, restore; first-call overflow; disabled compaction; assignment/model context | Surviving native archive retained; parity with main behavior; actual usage available to UI. |
| Cancellation/retry | Abort after assistant tool calls, between results, during summary, during persistence; provider overflow after tools | No orphaned request batch; effects are not silently repeated; completed evidence retained; outcome accurately marked. |
| Steering/queues | Guidance arrives while tools or summary run; crash after acceptance/before injection; replay claimed item | Guidance preserved exactly once with correct provenance and supersession; latest revision wins. |
| Persistence faults | Crash after each write/publish stage, invalid JSON/schema, missing versus corrupt state, flag toggles | One consistent checkpoint selected; originals retained; no silent downgrade or false completion. |
| Acceptance and queue authority | Presentation-only partial save, corrupt provenance, queued input after last generation publication, claim/removal race | No instruction acknowledged without native context; unreadable provenance stays unavailable; startup sees the live queue; UI reports actual removal outcome. |
| Recovery and clearing | Repeat reconciliation, multiple out-of-order repairable operations, explicit clear followed by reload, concurrent action requests | Recovery is idempotent; manifests never move backward; cleared fields stay cleared; stale operation revisions fail under lock. |
| Branch/undo | Before/after compaction, non-main branch, failed/stopped turn, reload after activation, unrelated save | Correct archive/task/summary checkpoint follows code state; actual validated boundary used; metadata preserved. |
| Bookkeeping | Parent objective plus repair subtask; failing typecheck; status artifact edited externally; pending report write | Partial/complete status follows evidence; report timestamp/contents agree; no false finalization. |
| UI/events | Main/subagent, model switch, rapid thread switch, compaction failure, reconnect during finalization | No stale meter, false 0/128k, perpetual spinner, duplicate event, or premature completion. |

Use deterministic reducers and mocked provider responses for invariants. Add property-based or generated sequences for event append/compact/reload/steer/branch transitions if the existing test setup supports them without disproportionate dependencies. Semantic evaluations should use fixed rubrics and pinned model/provider identities, recording variance instead of relying on one successful run.

The behavioral rubric for the Avarnic case must accept a necessary Svelte port and reject an unrequested visual redesign or unneeded legacy edit. It must require explaining the actual migration instruction, not reward a blanket apology that rewrites history. Ask-only follow-ups must not start edits.

## 7. Migration and recovery of existing conversations

1. Inventory schema versions, archive fidelity, compaction generation, active boundary validity, and whether the summary looks like a legacy tail. Detection is a recovery signal, not proof that every summary or task is wrong.
2. Before changing a conversation, preserve a recoverable original checkpoint and verify the session is idle or acquire its existing ownership lease. Do not race an active turn.
3. Convert surviving native messages to v2 events with stable migration IDs and source mappings. Link presentation/user IDs where evidence permits; mark ambiguous mappings rather than guessing. Preserve originals, including the corrupt summary, as audit evidence outside the active prompt.
4. Rebuild pending directives and a structured checkpoint from the archive and available status/task evidence. Prefer actual user events. Treat previously generated summaries and status files as claims to verify. Never reconstruct missing native tool calls, signatures, or hidden reasoning from decorative UI cards.
5. For subagents whose earlier archive was already discarded, mark the missing prefix and retain surviving assignment/history. Search available backups/generations if present. Do not claim full recovery when the evidence no longer exists.
6. Validate the repaired active request and invalidate stale measurements. Publish one atomic migration generation with counts, source hashes, limitations, and recovery outcome. A second migration run must be a no-op.
7. Resume only under the normal user/queue workflow. Repairing context must not automatically rerun tools, revert application files, or mark tasks complete.

For the named incident, enough main-thread archive remains to restore the actual consolidation/removal intent and answer why Calur was touched. The latest user message is an explanatory question; recovery must preserve that immediate response mode. Application completeness still requires separate repo verification and is outside this document-only task.

## 8. Delivery sequence and release gates

| Delivery slice | Contents | Dependency / gate |
| --- | --- | --- |
| A | WP0 regression fixture and failing tests; explicit validation of existing compaction candidates | Review incident reproduction before replacing semantics. |
| B | WP1 identity/provenance/task state and WP4 reader/transaction foundation | v1 reads and original archives remain recoverable; concurrent queue/steer tests pass. |
| C | WP2 safe summary transaction plus WP3 request budgeting | All P0 regressions pass; 50-cycle intent retention and no-reduction tests pass. |
| D | WP5 subagent parity and WP6 completion/steer/artifact bookkeeping | Main/subagent restart, overflow, failure, and status reporting pass together. |
| E | Complete WP4 branch/recovery integration; WP7 UI, migration, diagnostics | Crash/branch tests, UI behavior, feature-flag compatibility, and recovery rehearsal pass. |
| F | Opt-in canary, then default enablement | Sanitized replay and a controlled real long-running task meet behavioral rubric; no unresolved P0 or P1 in this plan. |

If an interim fix must ship before the full v2 path, stop invoking the unsafe tail compactor, retain original context while it fits, and return a recoverable capacity error when it cannot. Do not deploy only a lower compaction frequency and describe intent preservation as fixed. Existing conversation data must remain readable. Changes to the user's live settings or thread data are implementation actions, not part of this planning turn.

Run the relevant focused suites per slice, then `npm run typecheck` and the broader test suite at integration. Run platform-sensitive atomic-write/lock/recovery checks on Windows and another supported platform before release. Benchmark a long transcript comparable to the incident to detect quadratic suffix matching, repeated full-archive copying, generation write amplification, and unbounded disk growth. Optimize with indexed IDs/chunks or coalesced presentation writes only while preserving durable acceptance/tool-result boundaries.

Definition of done:

- Every finding F01–F30 has implemented coverage or a documented, reviewed resolution; no high-priority gap is hidden behind a passing structural test.
- The active objective, corrections, and unresolved work survive repeated compaction and restart with traceable sources.
- Main and subagent compaction preserve surviving archives and provider protocol integrity.
- Context occupancy, processed usage, model identity, output reserve, and archive fidelity are distinct and correctly presented.
- A failed/aborted/ineffective compaction cannot mutate the last valid checkpoint or claim success.
- Queue/steer acceptance, task progress, report artifacts, completion events, and branch checkpoints agree with durable state.
- Existing corrupted conversations can be diagnosed and safely migrated without invented history or automatic tool replay.
- A real long-running canary completes and explains the user's governing objective accurately, including when incidental build failures occur.

## 9. Audit verification record

The primary auditor inspected the summary builder, active-context projection, commit logic, token estimators, loop triggers, request preparation, usage display, main-turn finalization, steer handling, task tools, subagent checkpoint/export paths, storage generation/journal/recovery primitives, action boundaries, the saved incident, and the current Avarnic status artifact. Independent read-only exploration cross-checked persistence/branching and subagent/usage paths; conclusions were reconciled with source evidence.

The following existing focused suites were run against the unchanged implementation:

```powershell
npm test -- tests/nativeContext.test.ts tests/toolLoopSafety.test.ts tests/contextUsage.test.ts tests/contextCompactionSettings.test.ts tests/contextOverflowRecovery.test.ts tests/mousseAgentDurableSessions.test.ts
```

Result: **6 test files passed, 36 tests passed**. These are a baseline, not proof that the defects are fixed. Several tests currently encode the old trigger/summary representation and must change along with behavioral regression additions.

Additional in-memory probes loaded the actual TypeScript implementations via the installed TypeScript transpiler, without changing source files or calling a provider:

| Probe | Observed current behavior |
| --- | --- |
| User objective followed by long Calur error text, then compaction | `goalPreserved: false`; generated Goal starts inside the error text. |
| Retained assistant with 90k recorded usage after compaction | Measured estimate remained `90019`; new text estimate was `408`. |
| Summary commit whose retained messages include a newer append | Archive became `Original, Recent, Recent, New message`. |
| Compaction callback returns an empty array | Empty result accepted. |

These probes establish concrete function-level failures. Crash, queue-consumption, branch activation, and release-rollout scenarios in the matrix still require the specified integration tests. No live thread was repaired, no settings were changed, and no application implementation was modified during document preparation.
