# Archive proof adapters and remaining gates

The foreign audience and controller sections describe proposed ports, not
implemented permissions. The owner-local front door continues to reject those
operations. The original bot receipt adapter below is implemented and checked
with deterministic Native chat execution; it does not qualify a paid provider.

## Current foreign audience

`SpaceArchiveRecovery.recipients` currently accepts only the local owner's
Root and current roster. The ordinary `SpaceCurrentIdentity` proof is scoped to
an active Space and rejects frozen metadata. Its pinned-roster shortcut also
cannot establish fresh archive authorization. Historical archive roster bytes
must never satisfy a current-proof request.

A separate trusted `prepareArchiveAudience({archive, operation, target, signal})`
port would receive the branded verified archive and the exact immutable target
`{space, owner, hostNode, hostTransportKey, epoch}`. Its result would contain
bounded public recipient node/agreement keys and a synchronous `assertCurrent()`
validator. The validator must bind each foreign Root to the signed frozen
membership, the operation/digest/target, a genuine authenticated current roster
response, its nonce, authenticated source and bounded monotonic freshness.

The missing protocol must establish who can provide current proof after the
old Space is frozen or retired. An old globally cached foreign roster, a copied
old host, and a newly invented callback do not establish that fact. Either a
trusted actual foreign Root-authority response or a separately verified current
Space-authority proof with explicit frozen-operation scope is needed. It must
reject substituted roots, changed participants, revocations, lease expiry,
recovery/version regression, conflicting rosters and disconnected/stale proof
sources. Checks run again before protected key sealing and inside activation's
SQL transaction. The proof remains scoped; it grants no global identity pin,
read, executor or provider permission. Async proof jobs must settle before
quiescence can succeed. Crash/restart requires a fresh response.

## Foreign controller

Fresh recipient proof does not let the owner sign for another controller.
Support additionally needs an actual authenticated controller-side producer. It
must verify the owner-signed target/current routes and archive operation, persist
a fresh protected key/nonce bundle, and sign the exact future meta epoch/seq1
`participants.changed` original. Retry returns the same original; it cannot
create another key, event or nonce namespace. Only public controls and wrapped
fresh keys leave that producer. No old archive key is unwrapped or adopted.

The destination must independently verify the current controller lease and
member Root, exact operation/digest/target/participants, ordinary private
control authorization, monotonic key/visibility epochs and nonce prefixes
distinct from every authenticated historic control. The first control,
visibility flip and journal completion remain one bounded SQL transaction.
An actual foreign controller/recipient workflow with bundle-persistence crash,
restart, revoked/stale/substituted proofs and unknown-response original retry
is required before removing the unsupported gate.

## Original bot execution receipts

`BotProfileService.verifyHistory` uses live profile Spaces and can persist client
bindings. The archive verifier instead uses `ArchiveBotReceiptVerifier` with a
fresh isolated SQL ledger, historical Meta and identities, exact original record
pointers and the unchanged pure `BotRecordAuthorization` gate.

The first pass verifies original node/bot signatures, historical Meta and ordinary
private control, nonce and writer authorization. It indexes bounded pointers to
receipts and parent openings and retains only independently verified public
private controls. Bot receipt policy is deferred during this pass, which cannot
produce a verified archive. The mandatory second pass derives each execution
binding from its unique original acceptance, signed parent opening and mentioned
human trigger. It verifies every indexed receipt before an optional extra denial
callback runs. Missing, duplicate or substituted bindings cannot be filled by a
caller callback. The pointer and opening indexes each allow at most 65,536 rows;
actual SQL writes are charged against the normal transaction bounds.

The second pass uses the original Root-signed descriptor placement for each
Space epoch, historical owner/member roles and steering policy, genuine bot
leases and both trigger/output audiences. A sealed receipt receives its exact
preceding already verified control, including when its stream sorts before the
trigger stream. No old secret is adopted. No executor, approval/grant ledger,
budget, provider state or destination execution binding is imported or invoked.
Original `bot.permission.*` stream records remain explicitly unsupported,
including human grants/denials; the verifier does not silently skip them.

Actual composed protected profiles verify signed public receipts, sealed output
from a public trigger, sealed human-trigger/output history and public receipts
triggered by a foreign member over TLS. Each restore retains original bytes and
signatures, adds fresh private controls when needed, and leaves provider calls,
budget rows and executions unchanged. Invalid actor leases, historical steering,
openings, acceptance/trigger bindings, receipt placement, private audiences and
writer prefixes are rejected. These are deterministic immutable Native chat QA
runs without approval requests; reader-grant archive support is unqualified.

Signed terminal receipts prove historical statements by their authenticated bot,
not independent settlement of an external provider effect. A genuine Native call
with missing charge evidence leaves an uncertain destination execution after its
provider task settles. The owner-local adapter denies import before changing the
local reference, journal, records or generations, and repeats the uncertain check
at quiescence, recovery preparation and the final activation transaction.
Nonterminal destination executions also require genuine reconciliation. No paid
provider, foreign private-current proof, foreign controller or packaged archive
workflow is qualified by this evidence.
