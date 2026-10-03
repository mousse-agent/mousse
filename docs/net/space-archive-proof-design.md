# Remaining archive proof adapters

This is a proposed supported design, not an implemented permission or a
qualification claim. The owner-local archive front door continues to reject
foreign controllers, foreign recipients and bot execution receipt histories.

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
bindings. It is unsuitable as the archive verifier's callback. Archives already
replay into an isolated ledger and deny all private-key adoption. A new
read-only adapter can reuse `BotRecordAuthorization` with that isolated identity,
Meta and store, deriving immutable execution bindings only from original signed
acceptance, parent opening and mentioned human trigger records.

The adapter must receive the already verified private control for sealed receipt
history, retain exact original bytes/signatures/positions, validate historical
bot owner/host/key, roles and steering policy at each original auth position,
and reject duplicate acceptance, missing/substituted triggers, wrong audience
or malformed receipt placement. Public ancestry and Host placement use the
original signed descriptor for each Space epoch. This port must never invoke
the provider, adopt keys, copy approval/grant/budget rows, promote a runtime
qualification or modify destination execution bindings while validating.

Signed terminal receipts prove a historical statement by their authenticated
bot; they do not independently prove the provider's external effect happened.
Existing destination uncertain/nonterminal executions still require genuine
reconciliation and may deny activation. Qualification needs original real
signed public and sealed receipts, missing/bad actor-policy-audience proofs,
unknown provider outcomes and restoration without execution replay. The current
front door composes no such verifier and keeps its denial.
