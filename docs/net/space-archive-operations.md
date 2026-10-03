# Space archive operator contract

This implementation is a trusted local library. It has no renderer, peer RPC,
daemon method or CLI path registration yet. Production composition must provide
real per-Space quiescence and recovery ports before exposing the actions below.

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

Private activation requires an exact signed fresh `participants.changed`
control for every private stream, a higher key epoch, new writer nonce prefixes,
the new meta epoch/seq1 boundary, current controller authority and the exact
prepared stored bytes. The recovery port must use fresh key material and
reconcile existing executions to terminal states. There is no default recovery
attestation. The concrete fresh-key port and private restore are **unqualified**;
the current test proves that activation without it fails closed. Earlier-epoch
private control history that the existing private validator cannot reconstruct
also fails closed.

Focused evidence uses task-owned real encrypted ledgers and actual identities:
public export/restore/move, source retirement, hidden restart recovery, abandoned
local event retention, atomic activation rollback on underdeclared recovery
cost, structural/authentication tampering and private ciphertext with old-key
adoption denied. Historical private participant evidence remains verifiable
after a signed member removal without granting the removed member current
membership or adopting their destination pin during hidden import. This is not
yet the production CLI/daemon move gate. New-epoch
remote content replay, live-job/served-stream drain, private fresh-key restoration
and packaged archive workflows still require their actual composition tests.

Retirement is operational fencing, not partition-safe live migration. A copied
unretired old host may serve stale authority until members observe the higher
owner-signed descriptor. Members must receive the final descriptor and refreshed
join information through the normal authenticated protocol.
