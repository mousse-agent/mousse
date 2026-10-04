# Hosted device invitation rejection and recovery

I reproduced the one-hour Devices invitation failure with native Plus head
`29d5bc269385c05da92c4fc787de40c2ce60f351` and the actual companion
`36bee27ec9f485a838a3206a4d5c91d3d58e114c`. The companion rejects rendezvous
expiry beyond ten minutes. Native enrollment requires exact equality between
its signed authorization expiry and the outer rendezvous expiry. A rejected
request stayed in encrypted `plus/connector` custody, and renewal remained
blocked after shutdown, restart and unlock.

I corrected the owned combined candidate based on `d9913e43`: Devices uses
native enrollment's existing ten-minute default. I did not shorten Space's
inner invitation; `prepareSpaceRendezvous` already bounds hosted discovery to
599,000 milliseconds.

For the final `/v1/net/rendezvous` response only, I distinguish structured HTTP
400 `error.code = bad_request` from uncertain failures. The companion's
transaction rejects this operation without publishing its rendezvous or
consuming its challenge. An unchanged committed retry returns its retained
operation receipt before revalidating the challenge. Both memory and Postgres
store implementations roll back ordinary exceptions; I inspected those
implementations, but did not run Postgres qualification here.

After a definite rejection I reread protected custody and remove only the
same pending original. I retain originals on transport failure, response loss,
503, malformed 400, other rejection codes, and changed custody. I do not infer
a failed mutation from a local validation error or a different endpoint.

## Verification

I ran these focused checks on macOS with Node 24.20.0:

- Twelve profile cases passed: eleven in the profile run and the subsequently
  added changed-custody case separately. The two rejection/reopen cases failed
  against the original code before the correction.
- Both source and web TypeScript checks and changed-production-source ESLint
  passed. I reviewed the whitespace and final diff.
- Actual native service, companion control service/policy and WebSocket gateway
  ran over controlled loopback HTTP/WS with an ephemeral protected profile.
  The one-minute control invitation and renewal passed. The rejected one-hour
  request released its pending original and allowed renewal. GUI-equivalent
  `{ name: 'New device' }` issued a ten-minute invitation whose signed inner
  expiry equaled its outer expiry, followed by successful renewal.
- I physically discarded an HTTP response after the actual server committed a
  rendezvous. The native hosted primitive retained its original through
  NetService shutdown/restart/unlock and refused renewal until reconciliation.
  Its exact retry returned the same ticket and expiry; server rendezvous count
  increased once, and renewal then passed. This verifies hosted custody/replay,
  not a complete lost-response retry through enrollment's outer invite builder.

Local evidence: `/tmp/mousse-plus-rendezvous-recovery-red.log`,
`/tmp/mousse-plus-rendezvous-recovery-green.log`,
`/tmp/mousse-plus-recovery-custody-guard-green.log`, and
`/tmp/mousse-pr61-plus-recovery-interop.log`. The controlled probe source is
`/private/tmp/mousse-pr61-plus-recovery-probe/probe.ts`.

## Explicit disconnect recovery and its response-loss limit

At native checkpoint `be44e377` and companion `36bee27e`, I subsequently
reproduced an expired original using the supported two-second challenge
lifetime. The unchanged retry returned
HTTP 410 `expired`, retained protected custody and still blocked renewal. With
native/control/gateway clock hooks advanced by 610,000 milliseconds, I also
verified the challenge was pruned and the registration lease expired. Retry
returned HTTP 403 `revoked`, and custody remained retained. The lease check
rejects before challenge lookup, so pruning is not the established cause of
that rejection. This accelerated test is not elapsed wall-clock or
production-clock qualification.

For both states I verified the existing explicit `net.plus.disconnect` flow:
a transport failure before revocation preserved custody; an acknowledged retry
confirmed hosted revocation before clearing custody. Fresh account-authorized
binding/registration then permitted an invitation and renewal. The Devices
control invokes the same owner-local method. I did not qualify its browser
sign-in UI as part of these probes.

I also discarded the disconnect response **after** the actual server committed
revocation. Native custody correctly remained retained, but retry failed:
`resolveConnectorActor` calls `registration(..., allowExpired = true)` before
checking bearer hash; that registration check rejects a revoked record.
Although `revokeRegistration` itself accepts an already-revoked matching record,
that method is never reached on the connector retry. Native maps the resulting
HTTP 403 to `forbidden` and cannot clear its pending original.

Consequently an acknowledged explicit disconnect is a verified recovery path,
but lost revocation acknowledgement is a separate reproduced merge blocker.
A general 403 does not prove successful revocation: the same registration gate
covers generation, connector expiry and binding/identity state. I retained
custody and left the active companion/source owner branch untouched. Recovery
needs an endpoint-specific authenticated replay for the exact registration and
generation, or another separately verified account-authorized reconciliation
path. A revoke replay must verify bearer possession, acknowledge confirmed
revocation and keep revoked connectors denied elsewhere. Wrong bearer and
wrong registration/generation must remain denied. Credential-expiry and
pruned-record recovery need separate contracts. These changes require the
companion owner's work and human sensitive review.

Evidence: `/tmp/mousse-pr61-expired-recovery-interop.log`,
`/tmp/mousse-pr61-pruned-recovery-interop.log`, and
`/tmp/mousse-pr61-revoke-loss-interop.log`, with corresponding controlled probe
sources under `/private/tmp/mousse-pr61-*-recovery-probe` and
`/private/tmp/mousse-pr61-revoke-loss-probe`. These probes use actual control
service and gateway with ephemeral profile/account custody and clean up their
owned resources.

## Remaining gates

This is not complete historical pending-operation recovery. I verified HTTP
410 `expired` for an old challenge and HTTP 403 `revoked` for an expired
registration lease. I retain those originals. Acknowledged
explicit disconnect recovers the tested states; lost revocation acknowledgement
remains blocked as described above.
I also do not claim complete outer-enrollment response-loss retry, production
account login, production TLS, database, paid-provider, or platform rollout
qualification. The optional Plus feature and combined candidate remain draft
pending the other human teammate's sensitive review. I left the other
teammate's source PR #60 untouched.
