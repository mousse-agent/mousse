# B01a private daemon → Electron main command transport

Package: bounded reverse-command transport for in-app attached browser control.
Worktree: `process-lifecycle`
Base: `89df8bd` (refreshed exclusive worktree `d9cba4d`)
Implementation SHA: `63376b3`

This slice transports typed `BrowserWorkerRequest` / `BrowserWorkerResponse` from the daemon to one authenticated GUI connection. It does **not** implement the Electron-attached executor, trusted guest registry, BrowserPanel, GuiMmsController, production composition, or the Liquid Glass Orb. G5 remains open.

## Trust boundary (do not over-claim)

Authentication is the installation **owner token**. `clientType` is a declaration from that authenticated peer, not separate cryptographic proof of Electron. Every local owner-token holder already shares the bearer trust boundary. `browser-attached-v1` is an **opt-in grant** (`requestedCapabilities` + `clientType=gui` + injected router). It is not GUI-role cryptographic authentication. Sibling local clients with the owner token can lie about `clientType`; do not treat the capability as a sandbox.

Legacy capability behavior is unchanged: advertised capabilities other than `profiles-v1` and `browser-attached-v1` are still granted even if unrequested. `browser-attached-v1` is advertised on hello only when a command router is injected, and granted only under the opt-in rule above.

## Why not events

The local protocol is client request/response plus **broadcast** sequenced events. Server-initiated targeted RPC must not use `event` / `EventSequenceRing`. Sibling subscribers would receive the command, and replay after reconnect is dangerous for mutations. Command frames (`server_req` / `client_res` / `server_cancel`) never enter event sequencing, subscriptions, completed-response replay rings, renderer event bridges, or public CLI method allowlists.

## Exact root integration

```ts
import { ConnectionCommandRouter } from '../mms/protocol/connectionCommands'
import { MmsProtocolServer } from '../mms/protocol/server'
import { BROWSER_ATTACHED_V1_CAPABILITY } from '../shared/browser/connectionCommands'

const commandRouter = new ConnectionCommandRouter()
const server = new MmsProtocolServer({ mms, ownerToken, commandRouter })

// GuiMmsController per-window LocalMmsClient (not createLocalMmsClient / CLI):
client = new LocalMmsClient({
  ...,
  clientType: 'gui',
  requestedCapabilities: [PROFILES_V1_CAPABILITY, BROWSER_ATTACHED_V1_CAPABILITY, ...]
})
client.setAttachedBrowserCommandHandler(async (command, { signal }) => {
  // Root: look up trusted registrationId/epoch from did-attach-webview.
  return attachedBackend.dispatch(command.request, { signal, registration: command })
})

// After a trusted did-attach-webview, using the daemon-assigned connection id
// (never a renderer-supplied identity):
const result = await commandRouter.dispatch({
  connectionId,              // from the authenticated GUI connection
  registrationId,
  registrationEpoch,
  expectedBinding: { profileId, epoch },
  request: browserWorkerRequest, // typed; never generic CDP/evaluate
  signal,
  timeoutMs
})
```

`dispatch` validates the live profile binding/epoch on every call. Capture connection ids from the existing `HandlerContext.connection.id` (tests use an owned `fixture.inspectConnection` domain callback). Do not add a production identity-bypass API.

### Result statuses

| `status` | `dispatched` | Meaning |
|---|---|---|
| `completed` | true | Matching `client_res` with a typed `BrowserWorkerResponse` |
| `rejected` | false | Never sent (missing connection/capability/binding, malformed, backpressure, shutdown) |
| `cancelled` | false/true | Abort/timeout/handler reject for a **non-mutation**, or abort before send |
| `unknown-effect` | true | Mutation (`act` / `human.act` / tab/session/control mutators) was written, then timeout/abort/disconnect/rebind. **Do not retry or replay.** |
| `disconnected` | false/true | Non-mutation interrupted by socket close |

`beginShutdown()` / `getActiveCount()` / `shutdown({ timeoutMs })` exist on the router and on `LocalMmsClient` (`beginCommandShutdown` / `getActiveCommandCount` / `awaitCommandShutdown`). A caller timeout or wrapper cancel is **not** proof the remote handler or page effect stopped. `getActiveCount()` stays up until a matching settlement ack or an explicit disconnected/rebind/dispose disposition. Root profile drain must not treat client wrapper cancellation as backend/guest close proof.

Cancellation sends `server_cancel` **once**. It is a request, not completion.

## Bounds

- 8 outstanding commands per connection, 32 global
- Inner request/result ≤ 1 MiB, under the existing 4 MiB frame and 2 MiB outbound backlog
- Allowlisted method: `browser.attached.dispatch` only
- Duplicate command ids do not execute twice; settled acks may be resent on the same connection; reconnect clears that cache (no destructive replay)

## Files

- `src/mms/protocol/types.ts` — envelope kinds and bounds
- `src/mms/protocol/validators.ts` — parse `server_req` / `client_res` / `server_cancel`
- `src/mms/protocol/connectionCommandValidate.ts` — exact-key fail-closed parsers
- `src/mms/protocol/connectionCommands.ts` — `ConnectionCommandRouter`, `ClientCommandReceiver`
- `src/mms/protocol/server.ts` — injectable `ProtocolServerOptions.commandRouter`, attach after hello, revoke on close/rebind/profile dispose **before** `notifyConnectionClosed` / new work
- `src/mms/protocol/client.ts` — optional main-only handler; CLI/base `createLocalMmsClient()` does not install one
- `src/mms/protocol/index.ts` — re-exports
- `src/shared/browser/connectionCommands.ts` — capability/method/mutation constants
- `tests/platformBrowserConnectionCommands.test.ts`
- `tests/fixtures/agent-platform/browser-command-transport/ownedTemp.ts`
- this handoff

Not modified: `MousseMainService.ts`, `MmsProfileServices.ts`, `domainRegistry.ts`, main/preload/renderer, other shared browser files, package/build config, MCP/channels/terminal helpers, Orb.

## Qualification

- `npx vitest run tests/platformBrowserConnectionCommands.test.ts --maxWorkers=1 --testTimeout=30000`: 12/12 passed
- Combined with related protocol/profile-binding suites (`mmsProtocolServer`, `mmsProtocolFraming`, `protocolValidation`, `platformDomainRegistry`, `platformProfileRuntime`): 6 files / 67 tests passed
- `npm run typecheck`: both TypeScript projects passed
- `npm run build:cli` after tests (not raced with suites that spawn `out/cli`): passed

Owned temporary MMS homes under `mousse-browser-cmd-*`, loopback/named-pipe fixtures only. No live accounts, providers, or browser downloads.

## Remaining work (root / other owners)

- Register the router on the production `MmsProtocolServer`
- GuiMmsController: request `browser-attached-v1` and install the main-only handler per window
- Trusted `did-attach-webview` registration ids/epochs
- ElectronAttachedBrowserBackend composition
- Profile drain: await `commandRouter.shutdown` **and** backend/guest close proof separately
- BrowserPanel / in-app tab executor / G5 evidence
