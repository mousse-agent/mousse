# Handoff: managed browser setup composition

Worktree: exclusive `process-lifecycle` (`feat/platform-process-lifecycle`)
Base: `78d55f3` (reviewed native main-agent tab control) plus refresh merge `1ea57b6`.
This package owns the user-facing managed Chrome **setup** layer around the already reviewed `ManagedBrowserInstallerService`. It does **not** close G5 or replace in-app BrowserPanel tabs.

`MousseMainService`, `MmsProfilePlatform`, protocol/main, CLI dispatch/help/`daemonClient`, `BrowserPanel`, and `src/shared/platform.ts` were not modified. Root wires the exact APIs below after merge. Existing installer/worker were not edited; there is no concrete installer blocker for this composition.

## What this delivers

Installation-owned `BrowserSetupService` with host-injected root. First product path is **Stable Chrome for Testing only**. Renderer/model/CLI cannot supply path, URL, hash, channel, or version. Installation is **not** a model tool.

Daemon methods (capability `browser.setup.v1`):

| Method | Params | Result |
|---|---|---|
| `browser.setup.status` | `{}` | `BrowserSetupStatus` (no executable path, URL, hash, or metadata) |
| `browser.setup.install` | `{}` | `{ operationId, status }` immediately; one shared operation |
| `browser.setup.cancel` | `{ operationId }` (UUID v4) | `{ operationId, status }` immediately; raw install stays owned until the installer promise settles |

GUI and CLI authenticated connections only. Caller disconnect / Ctrl+C / socket close **does not** cancel the install. Explicit Cancel / `browser cancel <id>` does. Maximum duration is `DEFAULT_BROWSER_SETUP_MAX_DURATION_MS` (15 minutes). A ready active version is **not** replaced on this initial install path.

In-app Electron tabs keep working without this download. Status always includes `BROWSER_SETUP_IN_APP_NOTE`.

## Exact APIs root must import

```ts
import {
  BrowserSetupService,
  createBrowserSetupService,
  registerBrowserSetupMethods,
  DEFAULT_BROWSER_SETUP_SHUTDOWN_TIMEOUT_MS,
  BrowserSetupAdmissionError,
  BrowserSetupShutdownError
} from '../mms/browser'
import {
  BROWSER_SETUP_CAPABILITY,
  BROWSER_SETUP_METHODS,
  BROWSER_SETUP_IN_APP_NOTE
} from '../shared/browser/setup'
import { BrowserSetupPanel } from '../renderer/components/browserAutomation/BrowserSetupPanel'
import { runBrowser, BROWSER_HELP, prepareBrowserCommand } from '../cli/commands/browser'
import { createManagedBrowserInstaller } from '../mms/browser'
```

Construction (installation-owned, once per daemon):

```ts
const setup = createBrowserSetupService({
  root: join(this.getHomeDir(), 'browser'), // same root already passed as installationBrowserRoot
  installer: createManagedBrowserInstaller(),
  activity: {
    activeManagedSessions: () => {
      // Sum managed Chromium/worker ownership across profiles.
      // Exclude attached in-app tabs. Use BrowserBroker.getActiveCount()
      // (or equivalent managed-only count), never BrowserPanel tab counts.
      return managedCountAcrossProfiles
    }
  }
})
registerBrowserSetupMethods(this.domains, setup)
```

Register **before** domain seal / `MmsProtocolServer.start()`.

## Root hooks that this worktree cannot apply

### 1. Installation admission prefix

`src/mms/profiles/admission.ts` `isInstallationMethod` must treat setup as installation-scoped so multi-profile clients can call it without a personal bind (status/install are shared):

```ts
if (method.startsWith('browser.setup.')) return true
```

Without this, a bound profile still works (framed tests bind first). Unbound multi-profile CLI/GUI will get `profile_binding_required`.

### 2. GUI allowlist + platform union

`src/main/ipc/registerGuiIpc.ts` `PLATFORM_REQUEST_METHODS` and `src/shared/platform.ts` `PlatformRequestMethod` must include `...BROWSER_SETUP_METHODS`. Do not add setup methods to model/native tool catalogs.

GuiMmsController does not need `browser.setup.v1` as a special opt-in today (domain capabilities are auto-granted except `profiles-v1` / `browser-attached-v1`). Still add it to requested capabilities next to `browser.viewer.v1` for forward compatibility.

The panel takes a **typed setup request function**, not the full platform client:

```ts
<BrowserSetupPanel request={(method, params) => window.mousse.platformRequest.request(method, params)} />
```

Do **not** inject `profileId` / `threadId`. Unknown fields are rejected. Mount beside managed automation (BrowserPanel already has a Managed automation tab). Keep Manual browser unchanged.

### 3. Managed start fence

Call this **immediately before** managed Chrome start (`BrowserBroker.start` / first managed dispatch). Do **not** wrap attached in-app guests.

```ts
const admission = setup.admitManagedLaunch()
try {
  await broker.start()
} finally {
  admission.release()
}
```

`admitManagedLaunch()` throws `BrowserSetupAdmissionError` (`install_in_progress` or `admission_closed`). `install()` throws `replace_blocked` when admitted launches or host-reported managed sessions are non-zero and the tree is not already ready. Ready trees are never replaced.

Suggested wiring: extend `MmsBrowserPlatformConfig` with a `createManagedBackend` (or wrap `LazyManagedBrowserBackend.call`) from `MousseMainService.configureProfileBrowser`. This worktree did not edit `MmsProfilePlatform` / `MmsBrowserService`.

### 4. Daemon shutdown ownership

Synchronous close, then await raw installer settlement **before** releasing the installation owner lease:

```ts
setup.beginShutdown()
await setup.shutdown({ timeoutMs: DEFAULT_BROWSER_SETUP_SHUTDOWN_TIMEOUT_MS })
if (setup.getActiveCount() !== 0) {
  throw new Error('managed browser install still owned after shutdown')
}
```

Catch `BrowserSetupShutdownError` and do not move installation files / release the lease. A later `shutdown()` retries the same owned install. Do not construct a new setup service to "clear" a timed-out one.

`getActiveCount()` is unsettled install work + admitted launches. Caller RPC timeout does not clear it.

### 5. CLI dispatch

`src/cli/parseArgs.ts` `COMMANDS` add `'browser'`.
`src/cli/runCliMain.ts` `case 'browser': await runBrowser(args)`.
`src/cli/help.ts` `commandHelp('browser')` return `BROWSER_HELP`.
`src/cli/daemonClient.ts` `requestedCapabilities` add `BROWSER_SETUP_CAPABILITY`.

`prepareBrowserCommand` validates flags **before** `connectDaemonClient`. There is no filesystem installer CLI bypass.

```
mousse-cli browser status
mousse-cli browser install [--wait|--no-wait]
mousse-cli browser cancel <operation-id>
```

Install is an explicit user action. `--wait` (default) polls; Ctrl+C during wait returns 130 and **does not** cancel. Tool execution must never call `browser.setup.install`.

## Files owned here

- `src/shared/browser/setup.ts`
- `src/mms/browser/BrowserSetupService.ts`
- `src/mms/browser/registerBrowserSetupMethods.ts`
- `src/renderer/components/browserAutomation/BrowserSetupPanel.tsx`
- `src/renderer/components/browserAutomation/browserSetup.css`
- `src/cli/commands/browser.ts`
- `tests/platformBrowserSetup.test.ts`
- `tests/platformBrowserSetupCli.test.ts`
- Additive re-exports from `src/mms/browser/index.ts`, `src/shared/browser/index.ts`, `src/renderer/components/browserAutomation/index.ts`

Not modified: installer/worker, `MousseMainService`, `MmsProfilePlatform`, protocol, main IPC, CLI dispatch/help/daemonClient, BrowserPanel, Orb, workflow/agent owners.

## Qualification

Focused tests use an injected installer fake only. No Chrome download, no live user data.

| Command | Result |
|---|---|
| `npx vitest run tests/platformBrowserSetup.test.ts tests/platformBrowserSetupCli.test.ts --maxWorkers=1 --testTimeout=30000` | 2 files, **13 passed**. Fake installer only: shared operation across profiles (including framed `LocalMmsClient`), no ready-version replacement, launch/install fencing, cancel/shutdown raw ownership, shutdown timeout retains ownership, max-duration abort, capability/client/param admission, status DTO has no private paths, poller overlap/dispose, CLI parse-before-connect and wait-disconnect-does-not-cancel. |
| `npx tsc --noEmit -p tsconfig.node.json` | Passed |
| `npx tsc --noEmit -p tsconfig.web.json` | Passed |

## Remaining (root / other owners)

- Wire the five hooks above.
- Do not auto-install from native tools, workflow browser nodes, or model adapters.
- Sol continues to own native binding / main fixture / generic workflow tools.
- Other Grok workers own workflow runtime and `MmsWorkflowAgents`.
