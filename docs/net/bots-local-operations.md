# Owner-local bot controls

The profile-bound `net.v1` IPC catalogue exposes `bots.add`, `list`, `configure`,
`qualify`, `stop`, `resume`, `grant` and `presence`. The emitted CLI uses
`mousse-cli bots` and binds `--profile` before requesting these methods. The
catalogue is local owner IPC; it is not registered as foreign generic RPC.

Configure requires existing owner-signed Space bot placement and matching local
bot keys. It accepts bounded adapter/revision/digest and numeric budget fields.
Reader configuration selects a project ID already registered in the same
profile; it accepts no filesystem path, credential, executable definition or
qualification boolean.

Registration uses `bots.add {id,space,name,profile,policy}`. `id` is an explicit
stable `RpcId`; the CLI requires `bots add <space-id> <name> --id <rpc-id>`.
Only `chat` and `reader` registration profiles are accepted. Optional CLI
`--visibility`, `--steer` and `--roles` select the existing signed audience policy.
Retain the request ID and repeat identical arguments after an unknown response;
changing the request bytes under that ID fails with `conflict`.

Add requires an unlocked encrypted key store and the actual current root-authority
device. A follower holding only a node delegation cannot issue a bot lease.
Space membership and the existing owner/admin or members-may-add policy still
gate placement. No remote path, key, provider, adapter definition or qualification
field is accepted. Registration does not configure or qualify a runtime.

The local journal reserves one bot/event identity before the actual atomic key
write. An identical retry derives that stored key instead of replacing it. The
root-signed bot lease, actual identity singleton write and leased journal commit
share the bounded SQL transaction; the signed original outbox and queued journal
share another. Limits are 4096 retained registration requests and 16 KiB per
journal, plus the existing key-store, identity, transaction and envelope limits.
Nothing automatically resumes pending registration at startup.

`registered` requires the exact accepted original and its signed historical Meta
placement, not a simulated ACK. Other results expose actual pending, unknown or
failed outbox state. Recovery first observes an indexed original, then may flush
only the existing signed outbox entry; it creates no second bot, lease or event.
Expired/revoked or changed leases deny new transmission. A historical accepted
receipt remains an observation, and never grants current runtime authority.

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

Local deterministic QA evidence does not qualify a paid provider. Immutable
provider billing/vault evidence and actual private
discovery/output qualification must retain their separate gates.

Focused evidence covers actual owner IPC and emitted CLI/daemon control of
task-owned protected profiles, rejection of substituted bindings and foreign
project IDs, inactive production qualification and signed public mentions with
encoded-size rejection before outbox growth. A separate real-ledger private
decision test verifies original unknown delivery followed by the same signed
event's stored acknowledgement; it makes no provider calls and does not claim
an emitted CLI private execution or paid provider qualification gate.

Registration evidence additionally covers actual owner IPC, emitted CLI plus
daemon, a genuine rootless enrolled follower denial, and foreign Space TLS
registration with the carrier closed after host commit but before its ACK.
Reconnect reconciles the exact original at one append attempt. Actual child
SIGKILL after encrypted key commit and after host commit proves protected restart
recovery with the same key, root-signed lease and signed original. An injected
precommit failure proves identity/journal rollback together. These task-owned
fixtures make no provider calls; Windows registration execution is unqualified.
