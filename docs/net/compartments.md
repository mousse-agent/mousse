# Bot compartments and storage contract (v1)

Status: P0 normative consumer contract. Implementation belongs to P1 storage and P6 context/runtime binding. Guarantees apply to qualified `chat` and `reader` profiles; `operator` has the owner's full machine access. See [bot runtime](bot-runtime.md) and [Chats binding](chats-binding.md).

## Identity and epochs

A compartment is an immutable audience-scoped context identity. It owns conversation turns, summaries/compaction, memory, provider session/cache identifiers, scratch notes, tool-output summaries and local thread bindings. It is not a provider-global session, a directory derived from text, or the Group's shared workspace.

v1 opaque IDs use the fixed ASCII tuples `cmp1/public/<botId>/<spaceId>` and `cmp1/private/<botId>/<streamId>/<visibilityEpoch>`. IDs are validated typed net IDs; the epoch is a positive safe integer written in base-10 without leading zeros. No display name, user-controlled path or provider ID is part of this codec. The admitted profile owns every row; the store validates a binding before interpreting an ID and never treats the tuple as a filesystem path. A public ID is stable per `(bot, space)`; a private ID is stable per `(bot, private stream, visibility epoch)`.

`visibilityEpoch` and encryption `keyEpoch` are distinct monotonic counters. `participants.changed` MUST carry both and the exact canonical participant set (sorted unique `usr_`/`bot_` IDs), authenticated by the private-stream control rules. The projection pins the participant-set hash for each visibility epoch: base64url SHA-256 of the protocol's canonical JSON of that sorted ID array. Any addition **or removal** of a user/bot increments the visibility epoch by one and rotates the encryption key; the next run starts a fresh empty compartment. Adding/removing/revoking a node of an existing participant rotates `keyEpoch` without changing the participant set or `visibilityEpoch`. Rewrapping an existing key to that participant's new node changes neither. An identical participant list is not a visibility change; inconsistent epoch/set pairs fail closed. `CompartmentStore.privateId` MUST take `visibilityEpoch`, never `keyEpoch`.

Fresh means no earlier private turns, summaries, memory, session continuation, hidden prompt cache, scratch notes or backing-thread history are loaded. A participant addition therefore cannot reveal old context through a later model answer even though private-stream history remains readable to a node that has old keys. Existing participants may explicitly reshare selected messages into the new epoch as new signed messages; the context builder loads only those new messages. Retaining an old compartment for audit does not authorize reading it during a new run. Visibility changes invalidate live context bindings/approvals and cancel runs before further tools/output; unresolved effects become uncertain. Adding a participant never silently carries context through a running session.

## Context and output

The stable compartment audience binding is `(profile, space, bot, privateStream?, visibilityEpoch?, participantHash?)`. Public compartments do not bind permanently to a single work thread or output stream. Each admission separately persists an immutable execution binding `(execution, compartment, outputStream, backingThreadId, workspaceId, definitionRevision, profileDigest)` and supplies those fields through `BotRunRequest`. This lets two public runs use one authorized public compartment and distinct execution/workstream/backing-thread identities without rebinding the compartment. A private execution must match its compartment's private stream and visibility epoch. The context builder takes that host-created execution binding from the admission transaction. It may load only:

- that compartment's state; and
- verified public channel history of the same space currently readable by the bot owner.

For a private run, the triggering private message and attachments must be from its current visibility epoch. No automatic older-private-stream replay, local Group history, cross-space turns, profile-global memory, unrelated ThreadDataStore histories, provider sessions or other compartments' tool outputs. Public runs never read private state, including after restart/fallback/compaction. Public context fetched during a private run does not permit its answer to be public. The binding is checked at context load, provider session resume, every append, approval and publication.

All result text, durable tool summaries, deltas, errors containing derived content and attachments go only to the bound output stream. `visibility: private` binds a `space.private` work stream between owner, steering member when different, and bot; no mixed public-reply/private-thread mode. A private run's public presence is only `workingPrivate`; no tool names, prompt, title, snippet or error text. Owner notifications convey a private-run indicator and authorized link, not content. Logs carry opaque execution/correlation IDs and codes, never messages, prompts, private-derived summaries or session secrets. Public `thread.opened`/receipt metadata must not reveal a private title; private details are sealed.

Declassification occurs only when a participant explicitly authors a new public message quoting selected private text. The runtime cannot automatically quote, summarize, forward a private result, or change the output binding at a tool's request. Public replies cannot select a private `replyTo` in order to retrieve its hidden text. Bot-authored messages never trigger other bots in v1, even when mentions appear in their text.

## What is stored where

| Data | Owner/store | Network/export behavior |
|---|---|---|
| Signed public events and private ciphertext, cursors, stream descriptors, participant/epoch projection | Profile `net/net.db`, always scoped by `space_id` | Host/member replicas; space archives include only authorized space-scoped event/manifest data |
| Stable compartment identity/participant hash/visibility epoch and per-execution output/thread bindings | Executor `net.db` private local tables | Never host-authoritative context; bot placement transfer only through its authenticated scoped manifest; omitted from space export |
| Conversation turns, private decrypted context, memory, compaction, tool summaries | Executor local compartment store, under a profile-owned root and opaque compartment binding | Never uploaded as plaintext or included in host/space export; private local files mode 0600/directories 0700, profile backup handled as sensitive local data |
| Native provider-visible transcript/session data | Dedicated local backing thread plus compartment-owned provider-cache/session reference | Never reused by another compartment or copied to the Group backing thread; no provider-global resume IDs |
| Stream content keys and bot/session private keys | `KeyStore` and encrypted-at-rest local key records | Only authenticated participant-node wrapping or protected placement transfer; no plaintext keys in logs/archive |
| Private attachment | Encrypt before hash; `net/blobs` stores ciphertext and stream-scoped refs | Host/archive gets ciphertext only; decrypted temp material confined to current compartment and cleaned after use |
| Execution dedup, budget reservations, rate/concurrency accounting, approval consumption, pending outbox | Executor local `net.db` | Not a host space archive; preserve across restart/placement transfer |
| Ordinary project files/worktree | Existing workspace services on executor | Shared filesystem effects are outside compartment isolation; network bot workspaces remain separate from local Group workspace |

Table names may be chosen in P1 but these ownership/export constraints are normative. Local decrypted compartment files and ThreadDataStore are not SQLite-atomic with admission. Persist planned IDs in admission, then materialize idempotently; reconciliation must never convert a discovered transcript into permission to retry uncertain work. Cross-profile access is rejected even if IDs coincide. A compartment reader enforces its server binding rather than accepting a renderer-supplied root/path or trusting a request's `compartment` string.

Private local caches are access-controlled by profile and audience, with encryption-at-rest when the keystore/backend supports it; the wire's sealed-content guarantee does not assert universal encrypted local transcripts. OS compromise or an owner-access operator can read local state. Shared provider infrastructure receives plaintext model inputs and must be disclosed in setup; sealing protects transport/host storage, not the selected model provider.

## Lifetime, changes and transfer

Changing bot `visibility` from public to private selects the proper private binding; changing back selects the existing public compartment. Neither copies state across the boundary. A profile/definition change does not imply permission to re-use a less-restricted provider session; abort any incompatible active run and require a newly validated binding. Bot removal, member removal and key revocation stop context loads/publications using revoked access immediately once the signed change is applied.

`drop` releases the local context/session cache only after no live execution uses it, and does not drop executions, budget or receipt dedup rows. Retention/deletion cannot make an old trigger executable. A placement transfer may carry scoped compartments only after quiescence and verification of their audience and bindings on the destination; missing context starts fresh but missing ledger follows the explicit recovery policy. The source remains fenced. A restored host's space snapshot is display/authorization evidence and cannot hydrate or execute an old compartment run.

v1 does not compartmentalize project-file contents. An operator privately editing a project can leave changes that a later public reader sees. Reader qualification excludes daemon secrets/context stores but cannot label ordinary project data with its conversational origin. Setup must state this limit. Owner-only operator runs have no compartment confidentiality guarantee against their own tools; protocol output still follows its bound visibility.

P6 conformance must prove public/private session separation through model retries, fallback, restart, compaction and participant changes, check output routing including errors/deltas/attachments, and exercise real path/symlink boundaries. P0 only freezes the contract.
