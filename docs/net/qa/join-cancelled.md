# Intermittent local Space join cancellation

I reproduced a local connection replacement race on the integration baseline
`f10720be`, using independent protected profiles and actual direct WebSocket/TLS.
The regression is in `tests/net/spaces/local.test.ts`:
`keeps a slow local join connection alive when the background resume tick runs`.

I let the quarantined join finish and commit its signed membership receipt, then
paused the first domain-session dial before it opened. I invoked the same
`SpaceLocalService.resume()` callback that the three-second background timer
invokes, and released the dial. Before the fix the local `spaces.join` request
failed with `NetError('cancelled')`. No caller abort, deadline, transport
reconfiguration, disable, shutdown, or roster replacement was injected.

The interleaving is:

1. `spaces.join` commits admission and creates an `awaitingMeta` binding.
2. Its explicit `client.connect()` starts a Space supervisor, which is still
   connecting. The local background jobs map does not own that connection.
3. `resume()` sees the binding and a supervisor that is not yet open, and starts
   its own `client.connect()` for the same Space.
4. The second connection calls `client.disconnect()`. That aborts the first
   controller; `SpaceProfileService.connect()` closes its supervisor. The
   supervisor rejects its first-open promise with `cancelled`, failing the
   original local join despite the already committed Host receipt.

I keep a per-Space join reservation from preparation through authenticated meta
loading, and release it in `finally`. Background resume skips reserved Spaces.
The same regression now completes membership/meta setup with one domain dial
and exactly one Host admission receipt. It also disconnects after completion and
checks that normal background reconnect still works.

I separately reproduced a reconfiguration interruption in the regression
`retries the initial join session after local transport reconfiguration`. I
completed admission, paused reads on the subsequent actual TLS channel, observed
the normal session being created, and called `net.transport.configure` on the
joining node. Before the fix, `activate()` closed that opening session with
`cancelled`, making the Space supervisor block instead of retry. I changed only
the two teardown codes in `activate()` to `route_unreachable`. The regression
now retries first-open internally, completes meta loading on its second dial,
and retains the one original Host receipt. Shutdown/disable and actual caller
cancellation retain their existing behavior.

A slow dial can cross the ordinary resume interval; CPU load is one way to make
that interleaving more likely. I did not recreate load average 60 or reproduce
the historical separate-process soak failure. The supplied historical failure evidence does not identify an abort
source, so I cannot prove that every earlier occurrence was this race. My evidence proves this specific product cause and its fix.

## Cancellation sources I inspected

This inventory covers admission and the subsequent initial meta connection,
both of which are awaited by the local command. Unrelated RPC/blob operations
have separate cancellation paths and are not part of this join.

| Source | How it can reach the command |
| --- | --- |
| CLI input and signals (`src/cli/commands/spaces.ts`, `net.ts`) | Interrupted hidden/piped invitation input produces `cancelled`. After input, SIGINT/SIGTERM abort the CLI loop's signal, but that signal is not forwarded to the daemon join request. `netCliFailure` preserves the received code; it does not turn a timeout or `disabled` into `cancelled`. |
| Local lifetime (`SpaceLocalService`) | A stopped service rejects new/queued requests and checks again after admission. Background job deadlines abort their controllers after ten seconds; leave/archive/close also abort those jobs. The join itself has no background-job controller. The reproduced race creates a competing background job that disconnects the join's controller. |
| Admission client (`spaces/client/service.ts`) | An optional caller signal is forwarded to the join controller; its abort listener and signalled mux sends can reject `cancelled`. The ten-second handshake timer rejects `deadline_exceeded` before aborting cleanup (the earlier `6d67b65b` fix). A `space.join.result` error code is propagated unchanged. `close()` disconnects domain controllers, not the separate admission controller. |
| Host and quarantine (`host/service.ts`, `enrollment/quarantine.ts`) | Host admission is synchronous/transactional and has no native abort or direct `cancelled` throw. Its catch serializes a port/identity/storage error code. `EnrollmentGateway.close()` fails a pending gateway with `cancelled` and closes a handed-off normal session with that code. `EnrollmentQuarantine.close()` does the same for node enrollment, which is not the Space client exchange. Preauth deadlines are `deadline_exceeded`. Peer socket closure is an offline/unreachable error. |
| Node lifetime/configuration (`NetService`) | Stopped instance/runtime guards produce `cancelled`. Disable/shutdown abort `shutdownSignal`, close gateways, close supervisors and sessions, and begin domain disposal. `shutdownSignal` is used by accepted TLS channels; outbound joins use their own signal. `activate()` formerly closed existing sessions/supervisors with their default `cancelled` code; it now uses retryable `route_unreachable`. Transport restart can also close sockets. Domain connect attaches its caller signal to `session.close()`. |
| Roster/route maintenance (`NetService.refreshPeers`, sync session) | `refreshPeers()` creates missing same-user supervisors; it does not close all sessions or call `activate()`. Signed route adoption updates stored routes without closing sessions. Sync roster revalidation can close with the actual identity error (such as `revoked`, `bad_delegation`, or `roster_conflict`), rather than a blanket `cancelled`. |
| Space session ownership (`SpaceProfileService`, client) | Starting a second Space connection closes the previous supervisor. Client `connect()` first calls `disconnect()`, aborting the previous controller and closing its session/subscriptions. Archive and domain disposal also close these sessions. The Space profile's stopped guard and signal listener can reject `cancelled`. This is the reproduced source. |
| Supervisor/session (`sync/supervisor.ts`, `session.ts`) | Explicit `close()` defaults to `cancelled`; supervisor close aborts its dial and rejects first-open, while session close rejects opening and active subscriptions. An optional session signal also fails with `cancelled`. Supervisor renewal does not itself close sessions. Handshake timeouts use `deadline_exceeded`, heartbeat loss uses `peer_offline`, and retryable connection errors are retried. |
| Route phases and transports (`link/routeManager.ts`, `secureChannel.ts`, transports) | Parent cancellation yields `cancelled` during route connect/phases, direct DNS/dial, TLS, relay, memory, and runtime WebSocket dial. Route cleanup cancels losing attempts. Each phase marks itself settled before aborting its children, so its own deadline remains `deadline_exceeded`; losing attempts cannot replace a successful result. An opened channel closes on its parent abort. Relay/transport-manager stopped guards can also throw `cancelled`. |
| Mux (`link/mux.ts`) | A pre-aborted or interrupted signalled send yields `cancelled`. Cancelling a partial send also closes the connection with `route_unreachable`. Close without an explicit error and ordinary peer end use unreachable/offline codes; byte-progress watchdogs use `deadline_exceeded`. |
| Local IPC (`protocol/client.ts`) | The CLI's twenty-second request timeout rejects an ordinary `Error('Request timeout: spaces.join')`, not `NetError('cancelled')`; connection loss likewise uses an ordinary local error. |
| Default-off feature gate (`NetService.assertFeature`) | An unopted Space command is rejected as `disabled` before join execution. It does not cause the reproduced cancellation. Explicit disable of an active instance does cancel existing work as described above. |

I do not claim a fix for every possible cancellation. The product changes are in
`SpaceLocalService.ts` and the two teardown codes plus their explanatory comment
in `NetService.activate()`. `NetService.ts` is the only shared seam file I edited.

## Verification record

I used Node 24.20.0 and ran only focused tests. The final command was:

```sh
npx vitest run tests/net/spaces/client/service.test.ts tests/net/spaces/client/join-timeout.test.ts tests/net/enrollment/enrollment.test.ts tests/net/service.test.ts tests/net/spaces/cli.test.ts tests/net/cli/spaces-routing.test.ts tests/net/spaces/local.test.ts
```

It passed 43 tests in seven files, with zero failures/skips. The earlier run
before adding the reconfiguration regression passed 42 tests. Source Node
TypeScript passed. Changed-source lint passed with zero errors and one existing
`no-floating-promises` warning on unchanged `NetService.ts:279`.
`npm run format:net` and `npm run format:net:check` both completed successfully.

The focused resume reproduction initially failed (one failed/six skipped), then
passed (one passed/six skipped). After adding the post-completion reconnect
assertion, the full local test file passed seven tests. The reconfiguration
regression had five targeted runs: an initial fixture timed out; the next
reproduced `cancelled`; a draft fixture then completed the join but counted a
background dial created by pre-admitting before the local request; after I
removed that pre-admission and counted admission/domain dials separately, the
corrected regression reproduced `cancelled` again on the old teardown code and
passed after the fix (one passed/seven skipped). Each failing targeted run was
one failed/seven skipped. I changed no pre-existing test assertion.
