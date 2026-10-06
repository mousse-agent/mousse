# Mousse: shared collaboration with explicit agent requests

Planning baseline: September 22, 2026. Inspected `mousse-agent/mousse`, default branch `master`, commit `0db2721a6244db53208db27d540767ed4aa5c764`.

This is a proposed product and implementation plan, not an implementation or a claim of release readiness. The repository was cloned into the previously empty workspace. Source and selected tests were inspected; dependencies were not installed and the application and tests were not run. Historical verification reports describe earlier commits and are not current test results.

## 1. Product definition

Mousse is a shared project workspace where people discuss work and explicitly ask a coding agent to carry it out. The team can see the request, follow execution, clarify it, inspect the result, and continue the work together.

The defining rule is **shared conversation, explicit action**. Sending a normal message records conversation. Sending an explicit request to Mousse authorizes that request. Background conversation never becomes a task or interrupts an active task merely because an agent interprets it as useful.

The direct connection to the existing product is its execution engine: Mousse already orchestrates agents, owns their terminals, persists their conversations, isolates code work, and tracks results. Collaboration gives a team a shared way to use that engine.

Confirmed direction from the conversation: collaborative coding, a shared conversational surface, and explicit invocation. The following are proposed defaults to make the plan concrete, rather than recovered requirements:

- Native Mousse rooms are the primary experience; Discord and Telegram can become additional ways into those rooms.
- One host machine runs the repository and MMS daemon. Other participants connect to it. The host can later be an always-on machine.
- Each room is bound to one project in one hosting profile. Several rooms may use the same project.
- An independent coding request creates an execution thread; explicit follow-ups continue that thread.
- New shared coding tasks require isolated worktrees. Personal chat keeps its existing behavior.
- The first release targets a small trusted development team using Mousse clients. A browser-only guest client is a later delivery choice.

## 2. What the current code actually provides

| Area | Observed implementation | Consequence for this plan |
|---|---|---|
| Service ownership | `MousseMainService` owns the installation; `MmsProfileServices` composes profile services. | Add collaboration to the daemon's existing service graph. |
| Clients | Electron and CLI use the framed local protocol; Electron main owns presentation and IPC. | Extend the client boundary without moving execution into the renderer. |
| Conversations | `ChatMessage` has role/content and action lineage; `Thread` has project/model/worktree metadata. Neither defines team membership or a human author identity. | Add team conversation records and attributable requests. |
| Execution | `OrchestratorService`, `ThreadSession`, runtimes and durable queues support thread-owned work and concurrency. | Reuse execution threads behind room tasks. |
| Context | `ThreadData.llmContext` is the canonical native model transcript. UI messages are presentation data. | Room conversation must be an explicitly constructed context input, separate from the execution transcript. |
| External channels | Telegram, Discord and loopback webhook adapters are registered. Sessions map a platform/chat/thread to one Mousse thread. | Adapters are useful infrastructure, but their present mapping is not a team room model. |
| Invocation today | `DiscordAdapter.handleMessage` forwards ordinary non-bot messages. `ChannelRouter.handleInboundOwned` authenticates, handles recognized commands, then dispatches ordinary text; `runChannelTurnOwned` runs ordinary input in agent mode. | Introduce explicit invocation before exposing a room as an execution surface. |
| Channel permissions | `ChannelAuth` supports platform user allowlists/pairing; session menus can browse profile projects and threads. | Room membership and project restrictions must also cover commands and menus. |
| Remote access | Control Protocol 2.0 has pairing, encrypted relay sessions, method scopes, redaction and idempotency. Its grant identifies a device with broad scopes. | Reuse transport concepts; add team identities and resource-specific authorization. |
| Remote events | `RemoteSessionDispatcher.wireEvents` forwards the attached profile bus to read-scoped peers after redaction. | Filter events, replay and snapshots by room membership before making guest sharing available. |
| Workspaces | `ThreadWorkspaceManager` provisions worktrees, rejects a dirty primary checkout, and coordinates repository leases. Thread worktrees are currently opt-in; the composer catches provisioning failure and continues its send path. | Shared mutation admission must require a ready worktree in the daemon and must not fall back to the primary checkout. |
| Review/integration | `ThreadActionService`, `PublishService` and journals track checkpoints, undo and explicit publishing to a selected local branch. | Build task review on these operations. Local publishing is not a GitHub PR or deployment. |
| Other platform work | Agent definitions, workflows, browser execution, integrations, schedules and profiles already exist. | Use them when requested; do not rebuild them as part of collaboration. |

Important documentation discrepancies: `docs/ARCHITECTURE.md` opens with a local-only claim although remote-control code is composed into `MmsProfileServices`. `channels-plan.md` describes an older Electron-main layout. `CLIENT_CONNECTION_SPEC.md` is a draft HTTP contract, while current control code implements Protocol 2.0 relay sessions. Implementation decisions must follow verified code and reconcile these documents.

Principal source anchors:

- [Service composition](../src/mms/MmsProfileServices.ts), [installation ownership](../src/mms/MousseMainService.ts).
- [Message/thread/queue types](../src/shared/types.ts), [native context](../src/mms/orchestrator/nativeContext.ts).
- [Channel routing](../src/mms/channels/ChannelRouter.ts), [Discord ingress](../src/mms/channels/adapters/DiscordAdapter.ts), [session mapping](../src/mms/channels/ChannelSessionManager.ts).
- [Remote dispatcher](../src/mms/control/relay/remoteDispatcher.ts), [pairing types](../src/shared/controlTypes.ts).
- [Workspace provisioning](../src/mms/workspace/ThreadWorkspaceManager.ts), [composer send behavior](../src/renderer/components/OrchestratorChat.tsx), [publishing](../src/mms/actions/PublishService.ts).

## 3. The first complete user journey

1. The host opens a Git project, creates a shared room, and invites a teammate with a defined role.
2. Both people post normal messages. Mousse records and synchronizes them without starting a model turn.
3. A member explicitly addresses Mousse: “Add the Avarnic visualizer feature to the website.” The composer visibly changes to an agent request before submission. A quoted or pasted `@Mousse` string is ordinary text.
4. Mousse records who requested the work, the project, the instruction, and the conversation context included at that moment. One task card appears in the room.
5. The daemon admits the task, provisions its execution thread and isolated workspace, and runs the existing orchestrator. All members permitted to view the task see the same status.
6. The team keeps talking. Messages do not enter the running task. A person must explicitly send a task follow-up, answer a pending question, or use a task control to affect execution.
7. The result includes a summary, changed files, verification performed, and a link to inspect the execution. A completed code task is ready for review; publishing its changes is a separate authorized operation.
8. A permitted teammate can request a revision in that task. The follow-up retains task context and workspace, with the new human author recorded.

An explicit request should normally start immediately within its granted scope. Do not add an obligatory planning/confirmation dialog before every task. Missing project binding, missing permissions, unclear required input, or unavailable isolation should produce a concrete blocked state.

## 4. Conversation and execution model

Introduce a collaboration domain rather than overloading the existing `Task` type, which the orchestrator already uses internally.

| Record | Minimum responsibility |
|---|---|
| `CollaborationPrincipal` | Stable human identity with verified device/platform bindings. Clients cannot nominate their own authenticated author. |
| `Room` | Hosting profile, project, name, state, membership revision and authoritative sequence. |
| `RoomMembership` | Principal, role, room, grant/revocation metadata. |
| `RoomMessage` | Server-assigned author, text/attachments, timestamp, sequence, reply target and revision. Ordinary messages are non-executable. |
| `AgentRequest` | Explicit instruction, requester, room, task target, request ID, idempotency key and immutable context snapshot reference. |
| `CollaborationTask` | Request, execution thread ID, project/workspace reference, status, controller, results and publication state. |
| `TaskControl` | An attributed follow-up, steer, stop, answer, retry or publish command addressed to one task and revision. |
| `RoomEvent` | Durable event envelope for messages, requests, task updates, membership and audit changes. |

Use `roomId` for the collaboration concept. Retain “channel adapter” for Telegram/Discord/webhook transport. A room contains many requests and tasks; each task owns an existing execution thread. An adapter route maps to a room, then each explicit request maps to its task thread.

### Request admission

Separate `messages.post` from `requests.create` in daemon APIs. Only the latter can admit execution. A selected mention or explicit agent action in the native composer creates a structured request; server validation verifies the envelope, membership and target. No LLM-based “is this a task?” classifier is needed.

Admission freezes the requester, project, context, relevant policy, and request identity. Persist a durable accepted request before dispatch. Use an outbox/reconciliation record to join room admission to existing thread queue acceptance; a crash between the two must recover the same task rather than create a new one.

Carry the request and principal identity through the queue, execution thread, audit events and results. Keep internal orchestration wakes distinct from human requests, tied to the already-authorized task.

### Context rules

- Default context is a bounded, visible room/reply history up to a recorded sequence, plus explicitly selected messages and attachments.
- Store message revision IDs or immutable content snapshots so later edits cannot change an admitted request.
- Label discussion as attributed context and the explicit instruction as the request. Do not convert every room message into an executable user turn.
- New room messages do not silently steer or expand an admitted task. Explicit follow-ups capture their own context boundary.
- Preserve the existing native transcript for ongoing task reasoning. Do not use legacy UI-message migration to ingest a team room.
- Expose an “Included context” view on the task. Avoid invisible cross-room retrieval in the first release.
- Summary/compaction is derived context with provenance; it cannot create permission or turn suggestions into decisions.

## 5. Hosting, identity and permissions

Keep one authoritative MMS host per shared room for the first release. The repository, worktrees, terminals and provider credentials stay on that host. Host cost and provider usage should be visible in task reporting where current accounting supports them.

A profile remains a host-side data/configuration boundary. A teammate is a principal with room membership, not a second profile sharing the first profile's credentials.

Suggested roles:

| Capability | Viewer | Member | Maintainer | Host owner |
|---|---|---|---|---|
| View authorized room/task output | Yes | Yes | Yes | Yes |
| Post discussion and create requests | No | Yes | Yes | Yes |
| Control own requested tasks | No | Yes | Yes | Yes |
| Take over/control another member's task | No | No | Yes, attributed | Yes |
| Publish task code to the selected branch | No | No | Yes | Yes |
| Manage room membership/project binding | No | No | Yes | Yes |
| Manage host providers, installations or unrestricted terminals | No | No | No | Yes |

Membership is checked on reads, writes, snapshots, search, attachments, diffs, event subscription, replay and task controls. Hide unauthorized resources before building a response, not just in the UI. Restrict room task files to their authorized project/workspace.

Existing device scopes do not provide these guarantees. Add a guest collaboration grant, resolved to a server-owned principal and allowed rooms. Retain the existing personal remote-control path for owner devices. Guest clients must not bypass room checks using broad legacy `threads.*`, `files.*`, `queue.*`, `pty.*` or orchestrator methods.

Reuse `ExecutionPolicyService` restrictions where supported, and explicitly audit older orchestrator/CLI/tool paths for coverage. A permission object is ineffective if a terminal, browser, script or subagent can escape its project authority. Trusted-team MVP support is not a claim that arbitrary installed CLI agents are a hardened multi-tenant sandbox.

For shared tasks, revocation cancels pending requests and stops active work at the next enforceable boundary; preserve already-produced changes for an authorized maintainer. Record uncertainty for an in-flight external operation. Recheck membership before starting queued work and before sensitive controls.

Question answers and approvals have a task/request identifier, expected revision, authorized responder and durable resolution. Two people cannot resolve the same pending input differently. Existing ordinary orchestrator questions are documented as memory-only; add task-level durable question records and reconcile them with the runtime on restart.

## 6. Execution and code integration

- An independent request creates one thread and, for code mutation, one required worktree. Reuse existing thread/repository leases and queue claims.
- A follow-up addresses the existing collaboration task explicitly and runs in its thread. Same-task operations serialize; separate tasks can run concurrently within a host capacity limit.
- Require a valid project/repository binding before code execution. A dirty primary checkout or provisioning error blocks the shared task with the existing error; it cannot silently run in the primary checkout.
- Child agents integrate into the task workspace. Audit `complete_task` and `WorktreeManager` target selection so child completion cannot publish to the shared primary branch indirectly.
- Preserve action checkpoints, undo history and failed worktrees. Recovery reattaches where supported or marks work interrupted; it does not invent completion.
- Deduplicate accepted requests durably using room, authenticated principal, client idempotency key, and payload digest. Changed payload with the same key is a conflict.
- Do not promise exactly-once external effects. A crash after an unconfirmed side effect enters recovery-required state and is not blindly replayed.
- A code task separates execution completion, verification result and publication state. A passing build is evidence, not proof that a feature meets every requirement.
- Publish uses a specific task, source revision and target branch. Recheck the target and room authority under the existing mutation locks. Conflicts become visible task state.

Proposed task execution states: accepted, queued, running, waiting for input, completed, failed, cancelled, interrupted, recovery required. Track review/publication separately so “completed” is never confused with “merged.”

## 7. Persistence, synchronization and remote clients

Use a profile-owned collaboration store with per-room locking, durable sequenced events, and an atomic snapshot/checkpoint strategy based on existing `AtomicFs`, journal and generation patterns. Keep room storage separate from execution transcript and queue files. There is no demonstrated need to replace all current storage for this release.

Each accepted command records its receipt and resulting room event consistently. Delivery to the execution queue and task-result delivery use durable, deduplicated reconciliation. On recovery, rebuild materialized room/task state before resuming pending dispatch.

Use authoritative room sequences for ordering. Client-generated IDs reconcile optimistic messages with acknowledgements. Reconnect either replays authorized events after a cursor or supplies an authorized snapshot plus a new cursor. Cursor scope includes the room and membership generation; revoked access cannot use an old cursor to read retained data.

The current remote event ring is useful for transport reconnection, but is not a durable room history or a room authorization boundary. Filter before sending and before replaying. Apply backpressure and bounded progress updates so streamed tool output does not starve conversation.

Add a remote collaboration client below the Electron UI boundary, reusing the current control protocol where compatible. Keep connection/host identity attached to every request and subscription. A remote room must not use local file, browser or terminal IPC accidentally. The first milestone can qualify two authenticated clients in a local fixture; the release gate requires two actual machines over the supported remote path.

Current relay code references the separate Mousse Plus/control system. That server and the external client implementation are not present in this checkout. Inspect their matching versions and prove pairing, reconnect and room grant behavior before committing to a release date. Do not build a second remote HTTP stack solely because an older draft spec exists.

When the host is offline, clients show disconnected state and retain unsent drafts. A request is “accepted” only after host persistence acknowledges it. The first release does not promise execution or cloud-backed room synchronization while the host is off.

## 8. UI changes

Extend the existing application with a Shared area alongside personal project threads. Reuse visual components where possible, but keep room message posting separate from `OrchestratorChat`'s execution send handler.

- Room header: project, host availability, members, permissions and invitation action.
- Conversation: named authors, replies, messages, request cards and compact task updates.
- Composer: ordinary message by default; selecting Mousse or an explicit request action visibly switches the submission target. Existing task selection distinguishes a new task from a follow-up.
- Task detail: original request, requester, included context, status, execution conversation, changed files, verification and allowed controls.
- Active work: continue viewing room conversation while task detail is open; expose questions and errors without forcing navigation.
- Controls: stop, retry, follow up, answer and publish are bound to the exact task. Permissions are enforced by the daemon as well as reflected by the UI.
- Reconnect: clear pending/acknowledged state, replay without duplicate cards, and an explicit interrupted/recovery state when needed.

A native invitation opens an authenticated join flow. Merely knowing a room ID or possessing a copied URL does not grant execution authority. Presence and typing indicators may follow after the durable two-person workflow works; they are not prerequisites for correctness.

## 9. External channel behavior

The native shared-room path is the complete MVP. Adapters are a subsequent integration slice using the same collaboration APIs.

For Discord/Telegram shared groups, capture provider-verified direct mentions/commands as explicit requests. Extend `InboundChannelMessage` with verified sender binding, provider message identity, room route and explicit invocation metadata. Plain text mentions inside quotations or forwarded text do not qualify. Replies alone are discussion unless an explicit task action is selected.

Normal allowed group messages can be room context when the platform actually delivers them. Do not claim complete room history if bot permissions or platform delivery only provide mentions. Display the context available to the request.

Keep private agent DMs as explicit agent conversations. Migrate existing group routes to a visible invocation policy before enabling shared behavior; do not silently retain execute-every-message behavior for a shared room.

Scope `/threads`, project selection, model changes, `/stop`, `/steer`, workflow commands and menus to the member's room and tasks. A group member must not browse or rebind to arbitrary host threads.

Webhook input requires an authenticated integration identity. A payload's arbitrary `userId` is not sufficient proof of a human identity. Add stable message IDs and replay protection for adapter requests.

Slack is a possible later adapter, not a current implementation dependency. The Slack-like interaction in the idea does not require a Slack integration.

## 10. Implementation sequence and exit criteria

| Phase | Deliverable and principal code areas | Exit criterion |
|---|---|---|
| 0. Establish baseline | Reconcile architecture docs; use the `package.json` Node requirement; run current typecheck/tests/build in isolated development storage; inspect companion relay/client versions. | Current failures are recorded separately and the supported remote path is known. |
| 1. Collaboration domain | Add `src/shared/collaboration/` and `src/mms/collaboration/` with room, principal, membership, message, request, task and event contracts; register through `domainRegistry` and `MmsProfileServices`. | Two identified fixture clients post durable room messages; posting never calls the orchestrator; authorization and restart tests pass. |
| 2. Explicit execution slice | Add request admission, immutable context builder, durable dispatch reconciliation and task-to-thread mapping. Extend queue/request provenance and required worktree admission. | One explicit request produces one attributable isolated task; ordinary conversation and duplicate delivery produce no extra run. |
| 3. Native product surface | Add shared-room sidebar/view, explicit composer target, task detail, output projection, questions and controls; extend preload/IPC/client APIs. | Two local clients can discuss, request, observe, answer and revise work with correct authorship and no conversation-triggered execution. |
| 4. Real remote collaboration | Extend control grants, trusted actor context, guest method boundary, room-filtered events/replay and remote client routing; implement compatible companion-service changes. | Two machines complete the same workflow; room A cannot read/control room B or private host data; revocation and reconnect pass. |
| 5. Review and reliability | Wire diffs, evidence and explicit publish; durable question resolution; crash recovery and task control revision checks; audit child merge targets and tool authority. | Demonstrate safe failure/restart at admission, dispatch, execution and publication boundaries, including conflicts and uncertain effects. |
| 6. External adapters | Route shared Discord/Telegram messages and explicit requests through collaboration admission; scope slash commands, menus and replies. | Discussion stays discussion; a verified explicit invocation runs once in the correct project and returns to the correct conversation. |
| 7. Release qualification | Packaging, migrations, real two-person usage, diagnostics and updated docs. | The acceptance scenarios below pass on the supported release build. |

Phases 1–5 are dependencies of a credible native shared-workspace MVP. Phase 6 can ship later. A same-machine demo at phase 3 must not be reported as finished multiplayer support. Phase 7 qualifies whichever adapter scope is included in that release.

Keep the core change as a collaboration service and a small execution bridge, rather than adding all behavior to the already large `OrchestratorService` and `OrchestratorChat` files.

## 11. Verification and rollout

Extend relevant existing tests: `channels.test.ts`, `controlDispatcher.test.ts`, `controlMmsIntegration.test.ts`, `threadMessageQueue.test.ts`, `threadDataMutation.test.ts`, `threadWorkspace.test.ts`, `threadScopedEvents.test.ts`, protocol validation and profile isolation tests. Add focused collaboration integration fixtures using real daemon connections and temporary repositories.

Required end-to-end scenarios:

1. Two users post 100 ordinary room messages; zero requests, model turns or code edits are admitted.
2. One explicit request yields one task with correct author, context boundary and project/worktree.
3. Duplicate submission, delayed acknowledgement and reconnect all recover that same task.
4. Ordinary discussion during execution does not steer it; an explicit task follow-up does.
5. Two requests run without sharing writable task workspaces; same-task controls serialize.
6. A forged author, unauthorized room ID, old guest API, stale cursor or inaccessible attachment is rejected.
7. Revoking a member prevents further reads/actions and handles their queued/running work according to policy.
8. Simultaneous question answers resolve once; a daemon restart preserves a valid waiting state.
9. A dirty checkout/provisioning failure blocks shared code execution; the primary checkout is unchanged.
10. Crash at every request/queue handoff boundary does not cause duplicate accepted work; unknown external effects remain explicit.
11. Child-agent completion only integrates inside the task workspace; publication requires the permitted separate action.
12. Publication conflicts retain recoverable state; an outdated approval cannot publish a changed source revision.
13. The host disconnects/restarts; clients distinguish drafts, accepted tasks, interrupted tasks and completed results correctly.
14. Personal threads, existing owner-device access, profiles, schedules, workflow execution and undo continue to behave as before.
15. If adapters ship, verified mentions run while normal messages, quoted mentions and unauthorized slash controls do not.

Roll out behind a collaboration capability flag. Preserve existing private threads and original data; sharing/importing legacy conversation is an explicit operation with a clear history scope. Version new grants and schemas so older clients cannot receive unsupported guest authority. Disabling collaboration hides admission and remote room access while retaining recoverable room/task records.

Measure accidental invocation rate, duplicate admissions, reconnect consistency, authorization denials, accepted-to-start latency and successful request-to-reviewed-result journeys. The first two should remain zero in qualification. Set performance targets after baseline measurements rather than inventing latency or concurrency claims.

## 12. Scope boundaries and remaining decisions

The plan deliberately delivers one coherent workflow: people discuss a project, explicitly request work, and collectively inspect the result. Initial scope excludes automatic task extraction, always-on interpretation of team conversation, a general Slack replacement, distributed multi-host repository ownership, a new agent runtime, arbitrary third-party multi-tenant execution, and mandatory Slack/mobile/web clients.

Before implementation, record these product choices as decisions; the proposed defaults above allow technical planning to proceed:

- Native shared rooms versus an external-chat-first launch.
- Owner machine versus always-on host as the initial supported hosting experience.
- Whether maintainers may control all tasks, and whether members may publish or only request work.
- Default included-context window and explicit history exposure when sharing an existing conversation.
- Who supplies provider credentials and pays for execution; this plan assumes the host's configured providers.
- Guest client distribution and the availability of the companion relay/control service.

The codebase supports an incremental extension. The substantial new work is the attributable conversation/request domain, resource-scoped remote access, and a usable shared client experience—not rebuilding orchestration.
