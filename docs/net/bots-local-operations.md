# Owner-local bot controls

The profile-bound `net.v1` IPC catalogue exposes `bots.list`, `configure`,
`qualify`, `stop`, `resume`, `grant` and `presence`. The emitted CLI uses
`mousse-cli bots` and binds `--profile` before requesting these methods. The
catalogue is local owner IPC; it is not registered as foreign generic RPC.

Configure requires existing owner-signed Space bot placement and matching local
bot keys. It accepts bounded adapter/revision/digest and numeric budget fields.
Reader configuration selects a project ID already registered in the same
profile; it accepts no filesystem path, credential, executable definition or
qualification boolean. Bot registration/key delegation is not exposed here.

Qualification repeats the existing independent installed adapter checks. The
default production native composition remains inactive, and qualify returns
`profile_unsupported` without installing provider evidence. Resume only clears
the owner stop flag; it does not qualify a runtime or repeat an execution.

List uses a bounded keyset cursor `{space,bot}` and returns at most 128 sanitized
owner configurations. A stored `qualified` flag records configuration review;
current placement, adapter support, membership, budget and private guards still
gate every effect independently. Presence selects one owned placement and an
authorized public channel, and returns the verified local presence view without
activity payloads or private execution details.

Grant requires a genuine stored independently signed encrypted permission
request and the exact owner/requester/bot audience. It signs the owner decision,
flushes the original outbox entry, and returns its actual ID and delivery state.
A lost response or unknown delivery does not produce a replacement signature;
repeating the same decision returns the original entry. Changing that decision
fails with `conflict`. Pending/unknown is not a terminal approval receipt.

`spaces post --mentions <bot-id,bot-id>` adds at most 16 distinct typed bot IDs
to the signed message references. Public channel authorization remains intact,
and actual encoded envelope validation bounds JSON escaping and all references
before the durable outbox enqueue. This command does not widen private access.

Local deterministic QA evidence does not qualify a paid provider. Production
registration, immutable provider billing/vault evidence and actual private
discovery/output qualification must retain their separate gates.

Focused evidence covers actual owner IPC and emitted CLI/daemon control of
task-owned protected profiles, rejection of substituted bindings and foreign
project IDs, inactive production qualification and signed public mentions with
encoded-size rejection before outbox growth. A separate real-ledger private
decision test verifies original unknown delivery followed by the same signed
event's stored acknowledgement; it makes no provider calls and does not claim
an emitted CLI private execution or paid provider qualification gate.
