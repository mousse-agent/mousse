# Chats to Spaces binding contract (v1)

Status: adopted by the owner on 2026-10-03. This is [PLAN](PLAN.md) §4.10 in implementable form. I recorded the owner’s explicit decision to adopt this reviewed contract and continue P1. This satisfies the P0 coordination gate; it does not claim teammate agreement. P7 still requires the Chats backend on the remote default branch. No Chats backend is changed here.

## Verified local boundary

I inspected `src/shared/chats.ts`, `src/mms/chats/ChatStore.ts` and `AgentChatService.ts` on `origin/codex/local-micro-commits` during P0. That branch stores one UUID backing thread/workspace per chat, permits person `self` only, uses UUID local message/run identities, and contains local agent handoffs. These files are not on this integration branch's base (`8729d0c`, PR #43). P7 MUST re-inspect the actually merged backend before implementing; cached branch details are integration evidence, not a merged behavior claim.

## Publication and durable binding

Only a local Group can be published; a direct chat remains local in v1. The authenticated profile user owns the action. Publishing creates or selects an owner-authorized space and creates one `space.channel`. It copies **no** local history, Group scratch files, old backing-thread transcript, resources, prompts, definition secrets or approvals. Earlier history stays in the local chat store with a visible local-only boundary.

Store `(profileId, localChatId) -> (spaceId, channelStreamId, publicationId, state)` in a profile-scoped binding table. The net space/channel IDs are fresh typed random IDs, never derived from a local UUID, workspace or name. The publication operation has a durable idempotency key and signed append event ID before network I/O. Freeze the Group's local execution dispatch while publication is in progress; a concurrent send cannot race into the local first-agent path.

States are `local -> publishing -> published`, with a definitive rejection returning to `local`. A lost response keeps `publishing`; retry queries/re-appends under the same key/bytes and adopts the original space/channel. The durable operation journal and binding commit share `net.db`; the local ChatStore projection is materialized afterward and can be repaired from that journal. A crash after host creation must not create another channel or resume local execution. If an effect occurred but its identity/result cannot be recovered, expose uncertain publication for owner reconciliation. Never guess that a missing local JSON field proves the host did nothing. Deleting/unbinding a local projection does not automatically delete the shared channel or convert a published Group back into a local executable chat.

Local participants are not automatically space members; publication neither invites people nor certifies bot definitions. Each bot added to the published channel requires a separate owner-signed bot identity/delegation, a qualified profile and a budget. A definition appearing in a Group grants no network execution rights. Joining uses the space invite/meta process. The owner reviews which members/bots to add.

## Identity mapping and storage adapter

| Local concept | Network binding |
|---|---|
| Person `self` on authenticated GUI/local IPC | The profile's pinned `usr_` identity; never an externally supplied `self` impersonation |
| Remote person | Verified `usr_` from current membership; local participant projection retains that typed ID |
| Local agent definition/revision | Owner-local reference mapped explicitly to a registered `bot_`; a definition ID/name/slug is not a bot ID |
| Device | `nod_` verified against its delegation/roster; display name/address is not identity |
| Local Group UUID | Immutable local presentation ID with space/channel binding; never used as `spc_`/`str_` |
| Network message | `evt_` ID plus `(stream, authority epoch, seq)` position; preserve author identity and signed bytes |
| Client message retry | Profile/chat/client-key -> stable generated `evt_`, exact bytes, outbox state; conflicting text under the same client key rejects |
| Bot execution | `exe_` plus `(space, bot, trigger evt_)`; separate local backing-thread UUID mapping |

P7 MUST provide a network chat storage adapter/projection. It cannot pass remote persons or net event IDs through the unchanged local ChatStore validator, replace all remote people with `self`, or rename signed event IDs to look like UUIDs. The adapter reads net streams/current meta and overlays local binding/projection metadata; local-only ChatStore remains the source for pre-publication history. A schema change, if chosen, must version/migrate local records and preserve old local behavior instead of weakening every validator. Network events/outbox/cursors remain in `net.db`; cached Chats projections are rebuilt and are not alternate authorities/dedup ledgers.

Validate the binding's profile, membership, descriptor epoch and channel on every read/send. A GUI's authenticated `self` may author only as this profile's user/node. Renderer-supplied author, participant, device and file paths never establish authorization. Removed participants may remain identified in historical messages; do not map them to a current person with the same display name. Current membership gates new reads/writes; private participants/keys gate private work-thread projection. Readable history projection is never executable mention replay.

## Dispatch and backing threads

A published Group sends through the net outbox/host append path. Unmentioned messages call no agent. Mentions use structured `refs.mentions` resolved to actual registered bot IDs, with deduplicated bounded targets; textual slugs alone do not bypass bot admission. Bot-authored messages trigger no bot, including local handoffs inherited from the old Group implementation. Multiple mentions produce separate execution keys and outcomes; failure of one bot does not make another run twice.

Each admitted mention creates one `space.thread` for public visibility or a `space.private` work stream for private visibility. Its execution/trigger/parent-channel bindings are durable and idempotent. The bot owner's node creates a **separate** local backing thread and workspace per execution, distinct from the Group's thread/workspace and from another bot's run. Context continuity is through the authorized compartment store, not by sharing Group threads or provider sessions. Network participants cannot address those local backing threads directly; progress/results are published under the execution's output binding. A crash after thread/workspace creation follows [runtime recovery](bot-runtime.md), never the local chat's automatic retry behavior.

`chats.assignDevice` becomes Bridge dispatch target selection for a published Group's bot/task. It verifies target node identity/capabilities, repo binding and execution policy. Selecting a display device does not migrate the bot or expose resources; an actual bot placement change uses stop-and-transfer. Shared browser, PTY and file resources remain local-only. Their IDs/handles/URLs are never copied into network messages, snapshots, archives or a remote provider session. Sending a normal message attachment follows stream-scoped blobs/sealing; it does not grant remote filesystem access.

## Presentation and acceptance

The Chats UI is the only chat surface. It displays the local-only/publication boundary; `publishing`/uncertain publication; message `pending`, `unknown`, `sent`, `failed`; space offline; private stream marker; bot online/reconnecting/offline; expired mentions and uncertain runs. A message's `sent` state is a durable host append acknowledgement, not completion of a bot run. Private progress/snippets appear only to authorized participants. Public presence reveals only “working (private)”.

P7 focused acceptance must cover publication retries/crash reconciliation without duplicate channels/history copying, remote person/event projection without identity substitution, no execution on unmentioned/bot-authored messages, two mentions with distinct backing threads/workspaces, private result routing, local-only resource exclusion, and Bridge device selection. The owner’s adoption satisfies the §4.10 P0 exit decision, separately from these future implementation tests.
