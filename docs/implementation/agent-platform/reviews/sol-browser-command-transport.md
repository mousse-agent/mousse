# Sol review: attached browser command transport

Reviewed implementation: `63376b3`

Candidate documentation head: `8fb50f6a904b48fd6bed544f3ee80763d5532fed`

Refreshed core: `7c9f531` (merge `7d44686`)

Disposition: accepted after the fixes recorded in this commit.

## Findings fixed

- Reverse-command parsing validated the worker envelope but left every method's `params` object open-ended. The transport now applies exact method-specific key sets and bounds for all 15 browser worker methods, reusing the reviewed action, wait, target, URL, and upload validators. Unknown nested fields, invalid identifiers, invalid booleans/enums, unsafe dimensions/counts/timeouts, and oversized text fail before a frame is sent or a handler is called.
- A mutation handler that executed and then returned a malformed result was classified as safely cancelled because `malformed_command` was treated as proof of non-execution. Only receiver admission closure or a missing handler now provides that proof; malformed mutation results are `unknown-effect` and remain non-replayable.
- Profile disposal removed the authenticated connection handle permanently. A GUI that subsequently bound the same socket to another live profile could therefore never receive attached commands. Disposal now settles existing work, invalidates the old binding, and retains the connection; a serialized `profiles.bind` clears the invalidation before new work. The framed fixture proves the disposed epoch is denied and the rebound epoch works.
- Caller-supplied transport timeouts accepted fractions and values that overflow Node timers. Explicit timeouts are now safe integers from 1 through 120000 ms and fail before dispatch otherwise.
- Arbitrarily large handler exception messages could make the client response itself invalid, leaving daemon-side raw ownership waiting until timeout or disconnect. Error code/message output is now bounded before framing.
- Reverse responses had no client-side outbound backlog bound. They now use the protocol's 2 MiB pressure limit and disconnect on overflow. Once a socket generation is unbound, residual decoded command frames are no longer dispatched, so pressure-triggered or ordinary disconnect cannot cause unobservable follow-on mutations.

## Security and ownership assessment

The command router targets one daemon-assigned authenticated connection ID. Every call rechecks that connection's current profile ID and epoch, the opt-in `browser-attached-v1` grant, the registration ID/epoch shape, the inner request profile and request ID, and the per-connection/global limits. A response must return on the originating socket and match command ID, registration ID/epoch, and inner request ID. Rebind and disconnect settle the old command before a later response can be associated with replacement work.

Command frames remain outside events, subscription sequencing, replay rings, public method dispatch, and ordinary CLI handler installation. The framed two-GUI/profile/sibling-CLI fixture confirms only the selected GUI executes the command and no event cursor advances.

The owner token is the authentication boundary. `clientType: gui` is a bearer declaration and is not cryptographic proof of Electron main. Any local owner-token holder can make that declaration and request the capability. Root must use the trusted connection ID from `HandlerContext`, never a renderer claim, and the Electron handler must validate `registrationId`, `registrationEpoch`, `profileId`, `profileEpoch`, and `uiTabId` against the trusted webview registry before dispatch.

Timeout and abort settle the caller once and send at most one cancel frame. For a sent mutation they report `unknown-effect`; there is no retry. Router raw ownership remains active until an acknowledgement or explicit disconnect/rebind/profile-dispose disposition. The client receiver separately retains its handler promise after cancellation until actual settlement, so profile shutdown must await both sides and the attached guest/backend close proof.

## Evidence

```text
npx vitest run tests/platformBrowserConnectionCommands.test.ts --maxWorkers=1 --testTimeout=30000 --reporter=dot
  1 file, 13 tests passed

npx vitest run tests/platformBrowserConnectionCommands.test.ts tests/mmsProtocolServer.test.ts tests/mmsProtocolFraming.test.ts tests/protocolValidation.test.ts tests/platformDomainRegistry.test.ts tests/platformProfileRuntime.test.ts --maxWorkers=1 --testTimeout=30000 --reporter=dot
  6 files, 68 tests passed

npm run typecheck
  both node and web TypeScript projects passed

npm run build:cli
  passed after the CLI-spawning protocol tests completed
```

Fixtures use owned temporary MMS homes and loopback/named-pipe connections. They do not use accounts, providers, browsers, or external network access.

## Remaining work and limits

- Root still must inject one router into the production protocol server, request the capability only from `GuiMmsController`, capture the daemon-assigned connection ID, and bind it to the trusted webview registration lifecycle.
- This transport deliberately does not authenticate GUI role beyond the installation owner token. Registration validation belongs to the root-owned attached executor/registry and is required before product use.
- The response envelope and browser worker success/error envelope are exact and byte bounded. Method-specific success payload semantics continue to be checked by the consuming browser backend/session boundary rather than duplicated in this transport.
- Router shutdown/cancellation is not attached browser or webview close proof. Production profile drain must wait for command-router raw settlement, client receiver raw settlement, and backend/guest teardown independently.
- No main/preload/renderer bridge, BrowserPanel behavior, artifact URL integration, live attached browser acceptance, or G5 completion is claimed here.
