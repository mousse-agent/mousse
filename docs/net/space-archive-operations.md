# Space archive operator contract

The protected root-authority profile exposes archive operations through owner-bound
local `net.v1` IPC and the emitted CLI. These methods are not generic peer RPCs.
The production composition supplies actual Space/bot fences and transport task
cancellation; caller assertions cannot replace those ports.

`SpaceArchiveHost` installs the Host lifecycle fence. Its mandatory
`quiesce(space, signal)` must cancel/drain Space runs, admissions, uploads and
output, and invalidate served streams before activation or retirement. Resolving
a timer or using an empty callback does not qualify production quiescence.

| Action | Required boundary | Durable result |
| --- | --- | --- |
| freeze | Current host and owner; signed owner event | `frozen`; existing verified reads remain available |
| export | Frozen head, actual quiescence, task/operator selected local destination | `exported`, only after fsync and independent full verification |
| retire | Exact verified completed export digest and frozen boundary | Closed `retiring` fence and signed evidence outside the Space, then bounded deletion and `retired` |
| import restore | Explicit owner trust, independently verified archive, frozen existing Space if present | Hidden `importing`, then `importedFrozen`; serves no imported data |
| import move | Restore checks plus verified source retirement evidence | Same hidden import boundary |
| activate | Current owner root signature, destination node lease/transport/routes, strictly higher epoch than archive and all locally held epochs, actual recovery | Stream pointers, reconstructed meta, descriptor at new meta seq1 and `activeNew` commit together |

The intermediate `importing` and `retiring` journal states are local recovery
fences. They grant no serving or writes. An interrupted export becomes
`failedFrozen`; an interrupted activation becomes `importedFrozen`. Neither
state automatically resumes mutations. Archive-held generations and their
authenticated projection carry survive an actual ledger restart. Ordinary wire
snapshot stages continue to use their existing disposable lifetime.

The container is a new SQLite database with exactly `streams`, `records`,
`rosters` and `refs`, plus a manifest and content-addressed stored blobs. It
contains original envelope/signature bytes, signed descriptor history, frozen
heads, retained boundaries, public roster evidence for authenticated membership,
blob metadata and hashes. Public projections are rebuilt by replay. Private
controls and ciphertext are verified without invoking key adoption.

Bridge data, other Spaces, outbox rows, invitation bearer/proof material,
execution grants, budgets, executor/provider keys, private nonce counters and
decrypted caches are excluded. Original signed metadata may contain public
invitation authorization evidence necessary to authenticate historical joins;
it contains no bearer token. Retirement keeps execution dedup/outcome and local
identity records, and preserves unrelated authority. An older restore preserves
locally held abandoned generations rather than rewriting their signatures.

Limits are explicit qualification bounds: 128 streams, 1,000,000 records,
512 MiB SQLite file, 4,096 blobs with 512 MiB total stored bytes, and 512 public
rosters with 16 MiB encoded evidence. Signed manifest bodies are at most 64 KiB;
the containing document including its base64 signature wrapper is at most
192 KiB. Combined contents must satisfy every bound. Import and
activation additionally allow 64 streams, 64 distinct authenticated historical
members and 64 KiB
stream descriptions. Every visibility commit remains at most 500 charged rows
and 1 MiB. A prepared recovery port declares its row/byte cost; the coordinator
checks both the reserved total and its actual transaction charge delta.

The owner-local commands are:

```sh
mousse-cli spaces freeze <space-id> "consistent archive cut"
mousse-cli spaces export <space-id> <new-archive-directory>
mousse-cli spaces retire <space-id>
mousse-cli spaces import <archive-directory> --archive-mode restore
mousse-cli spaces import <archive-directory> --archive-mode move
mousse-cli spaces activate <space-id>
mousse-cli spaces archive-status [space-id] [--after <space-id>] [--limit 16]
```

All commands accept `--profile`. Paths are local operator inputs, bounded to
4,096 UTF-8 bytes, with canonical directory and regular-file checks. Export
creates a new directory and refuses replacement. Retirement retains its original
signed evidence in the ledger and atomically publishes `retirement.json` beside
the archive; move verifies that evidence. IPC returns bounded phase/digest
metadata rather than manifests, keys, paths or full signed retirement documents.
Status uses a direct keyset query with at most 32 results. A profile owns one
archive operation at a time; async waits abort after five seconds and preserve
failed fences. Remaining unscoped RPCs, uploads, jobs or nonterminal executions
deny the operation with stores intact. An exact indexed original may reconcile a
lost acknowledgement; archive code never sends that mutation again.

Durable journal states seed Space, bot and transport fences before listeners or
saved binding jobs start after restart. Exported sources can serve verified
frozen reads again. Imported generations remain hidden; explicit activation
commits visibility, rebuilt metadata, the higher Root-signed descriptor at meta
seq1, fresh private controls and `activeNew` in one bounded transaction.

Private activation requires an exact signed fresh `participants.changed`
control for every private stream, a higher key epoch, new writer nonce prefixes,
the new meta epoch/seq1 boundary and ordinary current controller authorization.
The concrete adapter supports only the local root owner's human controller and
own-root recipients with current leases. It allows at most eight private streams,
64 original controls totaling 128 KiB, and 64 KiB fresh signed control bytes.
Foreign controllers and foreign recipients remain explicitly unsupported, even
when a foreign roster is globally cached. A conflicting later local key epoch
also fails closed. No old wrapped secret is unwrapped or adopted during archive
recovery; only authenticated public control history is reconstructed.

The actual protected keystore atomically saves the fresh key, nonce prefixes and
exact signed controller original before SQL adoption. Its binding covers the
archive operation/digest, original stream and immutable activation target
`{space,owner,hostNode,hostTransportKey,epoch}`. An explicit restart retry can
refresh the Root-signed descriptor's routes while preserving that exact target,
key and original signature. It cannot substitute another node/key/epoch or
regenerate a controller event. Activation checks the committed first control's
original bytes and actual transaction charges before its visibility flip.

Focused evidence includes actual owner-bound IPC public/private restore,
transaction rollback and original retry, actual TLS publication cancellation,
ignored-abort wait denial, unscoped upload denial, cached foreign recipient denial
and a deterministic Native reader's held grant ownership/fence race. The
protected-key primitive survives a physical SIGKILL after bundle persistence
and before SQL, preserving identical keys, nonce prefixes and signed originals.
The macOS and Linux arm64 Node 24.20 emitted CLI/two-daemon gate also passes:
actual protected node enrollment, public/private export, source retirement,
root handoff, hidden
move import, physical daemon SIGKILL immediately after the protected bundle,
locked restart, current route refresh and identical-original higher-epoch
activation. A subsequent serialized actual MMS lifetime opens and writes with
the preserved fresh private key; another emitted daemon restart retains the
active journal. The extended macOS MOVE regression also re-exports the actual moved
public/private history, replays it through a hidden restore, activates epoch 3
and verifies the preserved original ciphertext/signatures plus another fresh
key and writer prefixes. A composed same-host regression covers three Space
epochs, original control history carry, tampered ciphertext key epochs, gaps,
regressions, final head mismatch and wrong signed descriptor owner/epoch/Host.
Archive replay uses independently verified original Root-signed descriptor
placement for each epoch without changing the live stream descriptors. Control
counts and bytes remain cumulative across epochs; ordinary wire snapshots keep
their existing single-epoch continuity. The private creation/content probe uses actual internal MMS
services, since this task adds archive commands rather than a private-post CLI.

Provider receipt histories remain unsupported by this front door until an
independent original execution-proof verifier is composed. No paid provider is
called or qualified. Foreign-controller recovery, ASAR archive workflows and
Windows archive daemon qualification remain unqualified by these checks. Linux
multi-epoch archive qualification is pending. The earlier Linux MOVE
Linux run uses a source snapshot at `9dcb6079` with the portable QA temporary-root
guard, a pinned Node 24.20.0 container, matching isolated Linux dependencies and
network disabled except loopback. It qualifies this source daemon workflow;
Linux Electron and packaged application archive workflows remain unqualified.

Retirement is operational fencing, not partition-safe live migration. A copied
unretired old host may serve stale authority until members observe the higher
owner-signed descriptor. Members must receive the final descriptor and refreshed
join information through the normal authenticated protocol.
