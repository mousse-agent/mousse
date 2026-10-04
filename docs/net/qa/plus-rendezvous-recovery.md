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

## Remaining gates

This is not complete historical pending-operation recovery. Once an old
challenge expires, the companion can return HTTP 410 `expired`; after pruning
it can return HTTP 403 `forbidden`. I retain those originals. Profiles already
stuck in those states still need a separately verified recovery mechanism.
I also do not claim complete outer-enrollment response-loss retry, production
account login, production TLS, database, paid-provider, or platform rollout
qualification. The optional Plus feature and combined candidate remain draft
pending the other human teammate's sensitive review. I left the other
teammate's source PR #60 untouched.
