# Sol review: MCP lifecycle and process drain

Reviewed candidate: `6858d0ef75b473d21abc4328cfc1dd27512148f7` (implementation `9090e8c`)

Merged review baseline: `db72e2ab62ec21e8535c6aa669b9ac501172ee98`

Qualified implementation freeze: `94259c0604fc52084d533c5b2edcdbd42cd6fcdf`

Disposition: accepted after fixes to raw discovery/auth ownership, shutdown error delivery, OAuth callback admission, stdio write settlement, and fail-closed process-tree traversal. Root must still bind this API into the shared profile lifecycle before archive/removal is complete.

## Findings fixed

1. `resolveServer()` called raw registry discovery outside `McpOwnedWork`. An admitted list/call/auth request could therefore remain in discovery after manager drain reported idle, then resume against a removed profile. Raw resolution discovery now enters the manager barrier. A deferred fixture proves shutdown retains it, returns `profile_busy` on deadline, and prevents a late connection after release.
2. `authenticateServer()` only owned the inner SDK authorization promise. The method could leave that barrier and then revoke a late provider, update the provider map, or list tools after drain had observed idle. Authentication now owns its complete method lifetime, including late revoke and post-auth validation. User-initiated credential revocation likewise owns its discovery, file deletion, and connection restart lifetime.
3. An immediate client/transport close failure retained connection lifetime correctly, but `shutdown()` waited for that lifetime to become idle before reporting the error. Since failed close intentionally preserves the owner, the caller waited the full deadline. `McpOwnedWork.waitForIdle()` now accepts the current drain as a failure source, removes its timer/listener, and surfaces the close failure promptly. A later shutdown still retries the retained connection and succeeds.
4. The fixed OAuth callback server was constructed before SDK auth, but the code did not await the `listening` event. SDK discovery or `openExternal` could start before this profile actually owned port 8791. Authorization now awaits callback readiness. A simultaneous second-profile attempt fails on the bind collision before opening its redirect or writing credentials; the first profile retains and closes the listener during drain.
5. Stdio `send()` waited only for `drain` after backpressure. If the child pipe closed without emitting `drain`, a raw SDK request could remain owned forever. It now settles from the write callback and rejects on pipe error or close, with listeners removed exactly once. An injected transport fixture proves close-without-drain rejection.
6. Linux process-tree discovery stopped silently at its 256-identity safety bound. That could report a successful drain with uncaptured descendants. A saturated traversal now fails closed and retains ownership instead of returning a partial snapshot.

## Reviewed behavior

`beginShutdown()` synchronously closes admission and aborts manager-owned work before starting drain. Concurrent and repeated shutdown callers share the in-flight drain. Failed closes clear only their retry operation; they retain the connection map and lifetime owner. Successful closes release lifetime only after both SDK client and explicit transport close settle. Raw connect, list, call, authentication, late-client close, connection lifetime, transport close, and resolution discovery promises remain counted independently of abort/timeout wrappers.

Connections that complete after the fence are closed and never cached. A caller timeout limits only its wait and leaves original work owned. Pinned tool dispatch continues to recheck installation/config/tool identity, execution activity, current actor selection, and caller cancellation immediately before raw dispatch. The actor, isolation, schema, revocation, and local stdio protocol regressions pass unchanged.

The owned stdio transport preserves the SDK newline-delimited JSON framing and default environment behavior while retaining its exact `ChildProcess`. Close snapshots discoverable descendants with Linux start time or Windows creation time, signals the handle, escalates only while the exact handle is live, and waits for handle exit plus all captured identities. Close failure remains retryable.

OAuth fetches receive the combined manager/caller signal. The callback listener is awaited and closed, and an aborted provider deletes its profile-scoped stored session after any late SDK persistence finishes. Port collision is explicit and does not assign one profile's callback to another profile.

## Evidence

- Baseline: `npx vitest run tests/platformMcpLifecycleDrain.test.ts tests/platformIntegrationMcpRuntime.test.ts tests/platformIntegrationIsolation.test.ts tests/platformIntegrationActor.test.ts tests/platformIntegrationDomains.test.ts tests/platformIntegrationLifecycle.test.ts --maxWorkers=1 --minWorkers=1 --pool=forks --testTimeout=30000 --hookTimeout=30000` — 6 files, 45 tests passed.
- Qualified matrix with fixes: the same command — 6 files, 48 tests passed.
- Final lifecycle run: `npx vitest run tests/platformMcpLifecycleDrain.test.ts --maxWorkers=1 --minWorkers=1 --pool=forks --testTimeout=30000 --hookTimeout=30000` — 13 tests passed, including the real parent/grandchild stdio process fixture.
- `npm run typecheck` — node and web TypeScript projects passed.
- `npm run build:cli` — CLI bundle passed after tests and typecheck.
- `git diff --check` — passed; Git emitted only repository Windows line-ending notices.

All tests use injected promises/transports, local HTTP and OAuth servers, a local stdio fixture, and verified temporary roots. They make no live account, credential, model, browser, channel, or external MCP-server call.

## Remaining guarantees

`MmsProfileServices` and profile host composition have not been edited in this slice. Root must call `beginShutdown()` in the synchronous profile fence, include MCP counts in the activity inventory, and await `shutdown()` before releasing the runtime/root/installation lease.

Owned descendant termination is supported only on Windows and Linux. macOS and every other platform fail closed. Linux uses `/proc` parent/child discovery and exact start-time checks without process-group signals. A descendant that detaches or survives after its parent exits before it can be snapshotted is not portably rediscoverable. Windows depends on CIM creation identity plus exact-PID `taskkill /T`; the same naturally exited-parent/detached-descendant boundary remains. No unsupported platform is claimed.

Remote MCP cancellation closes local transport activity but cannot prove or undo effects already accepted by a remote server. Effectful calls must remain unknown on ambiguous transport failure and must not be retried automatically.

OAuth port 8791 is exclusive rather than queued: a concurrent second profile receives a bind failure and must retry after the current authorization ends. Session writes prevent post-abort credentials from remaining, but they are not a transactional crash-recovery journal; an operating-system crash during a write may leave malformed JSON, which current loading treats as an empty session.
