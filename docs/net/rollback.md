# Profile-local opt-in and rollback

I bind `netBridge` and `netSpaces` to profile-local `net_service_config` in the Net database. Their typed defaults live in `src/shared/featureFlags.ts`. They are separate from installation-wide `MousseConfigStore.features`: one profile's opt-in or rollback never rewrites another profile's configuration. An enabled configuration predating these fields requires fresh explicit opt-in; missing flags are never silently enabled.

`net init` and `bridge join` explicitly opt the selected profile into both domains. Enrollment, keys, routes and authorization still undergo the existing validation. Native provider qualification remains independently denied by default. Domain admission checks cover owner-local Bridge/Spaces/Bots/Chats network methods, registered Bridge RPCs before durable admission, Space enrollment, stream/blob serving, dials, incoming carriers and post-await activation. Constructors can read and retain existing stores while domain recovery/admission remains inactive.

`net disable` accepts an empty owner-local, profile-bound DTO. It persists `enabled:false` and both flags false before synchronously fencing admissions, aborting the lifetime signal, stopping renewal, closing gateways/supervisors/sessions, and starting concrete domain and transport cancellation. It awaits actual owned jobs, provider/run ownership, uploads, connection producers and draining sessions with a five-second bound. The disable operation is outside the mutation queue and the task set it drains, so it cannot wait for itself.

Status and doctor remain readable. Status returns `restartRequired:true` for the disabled service instance. Other network requests, including same-instance init/join, return the existing `cancelled` error. The CLI maps that error to exit 130. Restart clears the instance fence but preserves disabled intent: unlocking keys does not activate listeners, jobs or sessions. Fresh explicit init/join is required to opt in again.

A deadline or failed drain returns `outcome_uncertain`; it does not close the Net database, release unresolved ownership, erase outbox IDs, rewrite signed originals, claim an external provider effect settled, or replay a mutation. Actual late work remains owned and can finish against its original ledger. Status retains the uncertainty warning; an MMS restart is required before any re-enable. An uncertain provider ledger may independently prevent shutdown/recovery under its existing contract.

## Focused evidence

I ran real Node 24.20 TCP/TLS sessions and owner-framed MMS IPC on macOS, plus a production emitted `out/cli/index.js` daemon and separate CLI processes built from the same candidate source. The checks are in `tests/net/rollback/`:

- `service.test.ts`: active enrolled peer closure; off persistence/restart; protected unlock without activation; explicit re-enable; preflags migration denial; actual RPC handler that ignores cancellation past five seconds, retains active ownership/open SQL, then finishes exactly once.
- `ipc.test.ts`: exact pending outbox bytes/signature/state and acknowledged history retained; wrong-profile/unknown-field/unbound denials; disabled local methods; unaffected second profile and installation features; ordinary local Chats retained; zero bot/execution records.
- `features.test.ts`: independently persisted domain-off flags gate actual profile admissions; Bridge RPC denial precedes durable aliases; the other domain remains usable.
- `daemon.test.ts`: emitted CLI disable/status/doctor/error routing, real daemon stop/restart/unlock/re-enable, exact original public history/outbox comparison and unchanged emitted binary hash.

After integrating the reviewed unchanged-tunnel/foreground-lifetime dependency (`5eaad179`, local cherry `72c4ca14`), I rebuilt the owned production CLI and ran 19 focused checks across seven files. They all passed: the four rollback files above, `tests/net/transports/configure-transition.test.ts`, `tests/electronDaemonLifetime.test.ts`, and `tests/net/bots/profile/service.test.ts`. This includes a real owned fake cloudflared process and signed-route transition; it does not add a new live Cloudflare qualification. Combined log: `/private/tmp/mousse-net-rollback-combined.log` (42.49 seconds). Node source typechecking passed; scoped source ESLint reports zero errors and two existing warnings. The repository ESLint configuration excludes tests.

I also reproduced the existing oversized Bridge snapshot test's `peer_offline` failure on the unchanged `878356b1` base. Its source `too_large` escapes ordinary session dispatch and closes the carrier. This rollback work does not fix or qualify that separate failure. Baseline evidence is `/private/tmp/mousse-net-rollback-unchanged-baseline.log`; diagnostic candidate evidence is `/private/tmp/mousse-net-rollback-source-origin.log`.

These checks do not qualify Linux/Windows rollback, packaged Electron/ASAR rollback, the full renderer, a paid provider, or default-on release. Human review remains a release gate. This is a draft implementation for issue #44, not merge authorization.
