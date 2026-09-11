# Browser daemon composition (attached GUI + managed assembly)

Worktree: exclusive `profiles` (`feat/platform-profiles`)
Base preserved: `33323cd` (core lifetime/checkpoint) and reviewed artifacts; transport API from `8fb50f6` / `b82fe15`. Protocol, `MmsProfileServices`, `MousseMainService`, main/preload/renderer, broker/worker, and existing router/artifact internals were not rewritten.

This is the importable production daemon service and exact method contract for root. It does **not** close G5. Root still binds protocol registration, GUI allowlist, native tool loop, and Electron guest close proof.

## What root imports

```ts
import { MmsProfilePlatform } from '../mms/platform/MmsProfilePlatform'
import { registerBrowserMethods } from '../mms/browser/registerBrowserMethods'
import {
  BROWSER_GUI_METHODS,
  BROWSER_ATTACHMENT_METHODS,
  BROWSER_VIEWER_CAPABILITY,
  BROWSER_VIEWER_CLIENT_METHODS
} from '../shared/browser/host'
import { BROWSER_ATTACHED_V1_CAPABILITY } from '../shared/browser/connectionCommands'
import { ConnectionCommandRouter } from '../mms/protocol/connectionCommands'
```

`platform.browser` is lazy. Construction does not start Chromium or the managed worker.

```ts
const commandRouter = new ConnectionCommandRouter()
const server = new MmsProtocolServer({ mms, ownerToken, commandRouter })

registerBrowserMethods(main.domains, async (profileId) => {
  const services = await main.getProfileServices(profileId)
  services.platform.setBrowserCommandRouter(commandRouter)
  services.platform.configureBrowser({
    installationBrowserRoot, // installation-shared binaries
    workerModulePath: browserWorkerModulePath(applicationRoot)
  })
  return services.platform.browser
})
```

Add **only** `BROWSER_GUI_METHODS` to the GUI/renderer allowlist. `BROWSER_ATTACHMENT_METHODS` are main-only (`clientType=gui` + `browser-attached-v1`). Do not put them on the public renderer platform.

GuiMmsController per-window client must request `browser-attached-v1` and `browser.viewer.v1`, and install `setAttachedBrowserCommandHandler`.

## Attachment contract (main-only)

`browser.attachments.register`

- Params (exact keys; optional `profileId` must match the binding): `{ registrationId: UUID v4, registrationEpoch: positive int, uiTabId: identifier, threadId?: identifier }`
- Requires authenticated `HandlerContext.connection`, `clientType=gui`, capability `browser-attached-v1`, profile from trusted binding only
- Returns `{ uiTabId, registrationId, registrationEpoch, profileId, profileEpoch, artifactRoot }`
- `artifactRoot` is this profile’s `BrowserArtifactService` worker staging root (`profileRoot/browser/worker-artifacts`). Main may pass it to the attached executor. Never copy it into viewer/model DTOs
- Same `uiTabId` from another connection fails. Same owner replacing a tab revokes the old registration (no command replay) and transfers guest-proof obligation
- Bounds: 128 / connection, 512 / profile

`browser.attachments.unregister` `{ registrationId, registrationEpoch }` — same connection/binding only. Call this **after** actual guest deregistration/drain, not as a renderer assertion.

`browser.attachments.select` `{ uiTabId, threadId }` — thread must exist on the bound profile; target must belong to this GUI connection. A tab bound to another thread is not silently reassigned. Selection is host input, never model tool args.

Connection close/rebind revokes dispatch and selection. It does **not** prove the guest stopped.

## Native / workflow hook

```ts
const result = await services.platform.browser.dispatch(context, name, args)
```

`context` / `policy` are trusted host values. GUI uses the explicit selected tab; missing selection is `setup_required` and does **not** start managed Chromium. CLI/scheduled default to managed. `BrowserSessionManager.authorize` remains the policy authority.

## GUI viewer methods (allowlist)

| Method | Params | Result |
|---|---|---|
| `browser.sessions.list` | `{ threadId }` | `{ sessions: BrowserSessionPublicRecord[], selected?: { backend: 'electron-attached', uiTabId } }` |
| `browser.sessions.get` | `{ threadId, sessionId? }` | `BrowserViewerSnapshot` (no `controlLeaseId`) |
| `browser.sessions.observe` | `{ threadId, sessionId, tabId? }` | snapshot |
| `browser.sessions.takeControl` | `{ threadId, sessionId }` | snapshot |
| `browser.sessions.resume` | `{ threadId, sessionId }` | snapshot (fresh generation/observation) |
| `browser.sessions.close` | `{ threadId, sessionId }` | snapshot |
| `browser.sessions.humanAction` | `{ threadId, sessionId, tabId, generation, observationId, action }` | snapshot |
| `browser.artifacts.read` | `{ threadId, sessionId, artifactId }` | `{ artifact, mediaType, byteLength, bytesBase64 }` PNG only, ≤ 1_500_000 bytes |

Root `BrowserViewerClient` mapping is `BROWSER_VIEWER_CLIENT_METHODS` in `src/shared/browser/host.ts`. There is no `artifactUrl`; read bytes instead of a path. `subscribe` stays a root poll/event bridge.

Context/policy are derived from the GUI binding plus `BrowserSessionManager.trustedSessionScope` (new narrow getter: validates profile+thread ownership, then returns the session’s exact thread/run). A native-run session on the same thread is viewable; operations reuse that run scope. Attached sessions are operable only by the owning GUI connection. Listings omit artifact paths, connection ids, and control leases.

## Disposal / guest drain (root must finish)

Platform order: browser backends + `sessions.closeAll` **then** artifact owner dispose. Failed attached closes stay `disconnected` / unproven; they are not rewritten as closed.

`getActiveCount()` includes unproven attached registrations. Empty transport counts are **not** guest-close proof. `platform.dispose()` / profile drain fail closed with `profile_busy` until:

1. `browser.attachments.unregister` from the live owning connection after main drained the guest, or
2. `browser.acknowledgeAttachedGuestClosed({ registrationId, registrationEpoch })` from Electron main when the connection is already gone

`browser.pendingAttachedGuestAcks()` lists outstanding proofs. Root-main must call one of those after real guest/executor close. Do not treat router idle as profile removal.

Managed broker: `call`/`start`/`close` only. Started lazily on first managed dispatch.

## Files

- `src/shared/browser/host.ts` — method names, DTOs, bounds
- `src/mms/browser/MmsBrowserService.ts`
- `src/mms/browser/AttachedBrowserConnectionBackend.ts`
- `src/mms/browser/registerBrowserMethods.ts`
- `src/mms/platform/MmsProfilePlatform.ts` — lazy assembly, command-router setter, dispose order
- `src/mms/browser/automation/BrowserSessionManager.ts` — `listThreadSessions` + `trustedSessionScope` only
- `tests/platformBrowserDaemonComposition.test.ts`
- `tests/fixtures/agent-platform/browser-daemon-composition/fakeAttachedExecutor.ts`

Not modified: `protocol/**`, `MmsProfileServices.ts`, `MousseMainService.ts`, main/preload/renderer, `BrowserBroker`, worker, `BrowserBackendRouter`, `BrowserArtifactService` internals, deps/build, Orb.

## Qualification

- `npx vitest run tests/platformBrowserDaemonComposition.test.ts tests/platformBrowserBackendRouting.test.ts --maxWorkers=1 --testTimeout=30000`: 12/12 passed
- Framed `LocalMmsClient` + real `ConnectionCommandRouter` + fake attached executor: register/select, same-tab routing through `BrowserSessionManager`/`BrowserToolDispatcher`, observation + PNG artifact scope, takeover/resume generation, sibling connection/profile denied, disconnect/rebind cannot replay or reroute, GUI without a target does not spawn managed Chromium
- `npx tsc --noEmit -p tsconfig.node.json`: passed
- `npx tsc --noEmit -p tsconfig.web.json`: passed
- `npm run build:cli`: passed after tests

Owned temp homes only. No browser download, live accounts, or models.

## Remaining (root / other owners)

- Register `registerBrowserMethods` on production `MousseMainService` before domain seal
- Inject `commandRouter` on `MmsProtocolServer`
- GuiMmsController: capabilities, main-only attachment RPCs, `BrowserViewerClient` over GUI methods
- Electron attached executor (Sol) + trusted `did-attach-webview` ids
- Call unregister/ack after actual guest drain; await that separately from `commandRouter.shutdown`
- Native loop: `platform.browser.dispatch` with host context/policy
- G5 in-app acceptance against the live BrowserPanel page
