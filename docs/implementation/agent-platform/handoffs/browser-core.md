# Handoff: B01/B02 + B03 transport/executor prerequisite

Package: B01, B02, B03-prereq (WG6 browser-core)
Branch / worktree: `feat/platform-browser` / `C:/Users/bubbl/Documents/Projects/RYSPA/mousse-platform-worktrees/browser`
Base SHA: `7ffa018da732226ddddf273f8695dbee48affd4b`
Head SHA: `38455b666cfdae8aa6a010fd2dee973b82b2e70a`
Working tree clean after commit: yes (handoff SHA pin follows as a docs commit if needed)

## Behavior delivered

Mousse now owns an Electron-free browser worker and an MMS-owned versioned broker. The worker launches **Chrome for Testing** with a private `--remote-debugging-pipe` (no public TCP debug listener), isolates user-data per profile/workspace, produces bounded untrusted observations with opaque refs, and executes the shared typed action catalog through a lease/generation/observation transaction.

App/CLI composition, protocol, UI, and the Liquid Glass Orb remain root-owned and were not modified.

## Exact APIs root must wire

Import from `src/mms/browser/index.ts`. Do not construct the broker from a renderer-supplied filesystem path or from `process.env` as a profile selector.

```ts
import {
  BrowserBroker,
  createAllowHttpPolicy,
  createFilesystemArtifactPort,
  createFilesystemJournalPort
} from '../mms/browser'
import type { BrowserBrokerConfig, BrowserPolicyPort, BrowserArtifactPort, BrowserJournalPort } from '../mms/browser'
```

### `BrowserBrokerConfig` (all roots absolute and injected)

| Field | Required | Meaning |
|---|---|---|
| `profileRoot` | yes | Immutable profile tree root. Recorded at worker init; never used to pick the active profile. |
| `browserRoot` | yes | Managed binaries (`binaries/certified/`), user-data, workspace locks, worker journals. |
| `artifactRoot` | yes | Screenshot bytes only. DTOs carry `artifactId`, never filesystem paths. |
| `policy` | yes | `BrowserPolicyPort.authorize({ profileId, method, action?, url?, sessionId? })` |
| `artifacts` | no | Defaults to `createFilesystemArtifactPort(artifactRoot)` |
| `journal` | no | Defaults to `createFilesystemJournalPort(browserRoot)` |
| `workerModulePath` | child-process | Bundled Electron-free worker (`out/browser-worker/index.mjs`). |
| `transport` | no | `'child-process'` (production) or `'in-process'` (tests). Default child-process. |
| `requestTimeoutMs` | no | Default 60s. |

### Broker methods

- `start(): Promise<CapabilityReport>` — handshake, binary resolve, capability probe report.
- `call(request: BrowserWorkerRequest, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<BrowserWorkerResponse>`
- `close(): Promise<void>` — shutdown worker; kills only the owned child PID tree.
- `capabilityReport` — last `CapabilityReport` or `null`.

`BrowserWorkerRequest` is the frozen C6 envelope (`version: 1`, `id`, `profileId`, `method`, `params`). Broker validates it with `validateBrowserWorkerRequest` in `src/shared/browser/envelope.ts` (additive; `types.ts` / `geometry.ts` / `validation.ts` unchanged).

### Worker methods (C6)

`session.open` / `session.close` / `tabs.list` / `tabs.new` / `tabs.close` / `tabs.switch` / `observe` / `find` / `act` / `wait` / `extract` / `control.take` / `control.release`

`session.open` params: `{ url?, persistent?, workspaceId?, runId?, threadId? }`. `workspaceId` is an identifier, not a path. Persistent workspaces take a single-writer lock.

`observe` params include `{ sessionId, tabId?, includeScreenshot?, visibleOnly?, continuation?, maxElements?, deviceScaleFactor?, clip? }`.

### Child-process worker bundle (WG0 insertion)

This worktree cannot change `package.json` / CLI build. Root should add an esbuild entry equivalent to:

```
node scripts/check-browser-worker-bundle.mjs
```

which writes `out/browser-worker/index.mjs`. Spawn with `MOUSSE_BROWSER_WORKER=1`. Tests already bundle on the fly for the child-process IPC case.

### Coordinator requests (no new runtime npm deps)

1. Compose `BrowserBroker` in MMS from injected F03/P01 roots (`browserRoot` / `artifactRoot` / profile browser dir). Never `MOUSSE_HOME` as profile selection.
2. Add the worker bundle to the CLI/daemon build.
3. Keep policy/approval/artifact stores on the MMS side; worker never receives provider credentials.
4. No Playwright / Puppeteer / BrowserUse / Stagehand packages.

## Ownership paths

Writable here: `src/browser-worker/**`, `src/mms/browser/**`, `tests/platformBrowserWorker*.test.ts`, `tests/fixtures/browser/**`, `scripts/check-browser-worker-*.mjs`, `docs/implementation/agent-platform/handoffs/browser-core.md`.

Additive shared: `src/shared/browser/envelope.ts`, `src/shared/browser/index.ts`. Root contracts, geometry semantics, and `BrowserReferenceStore` public API are preserved (`invalidateDocument` / `invalidateFrame` / `hasObservation` added).

Not touched: `package.json` / lock, MMS composition, `LlmClient`, protocol/server, main/preload, UI, orb, workflow/profile/integration sources.

## Binary / version / protocol matrix

| Item | Qualified in this worktree |
|---|---|
| Distribution | Chrome for Testing **Stable 153.0.8010.36** (revision **1681091**) |
| Platform qualified | **win64** (Windows 10+ host, Node 22.23.2) |
| Download | `https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.36/win64/chrome-win64.zip` |
| SHA256 | `8edfaa0923c11a30a9315a5e7e5794c5efb60146edea7e3f749f7fdc2aa026cb` |
| Catalog | `https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json` (2026-09-10) |
| Transport | `--remote-debugging-pipe` only; Chromium ASCIIZ (NUL-terminated JSON). No `--remote-debugging-port`. |
| CDP | Flattened sessions (`Target.attachToTarget` + `sessionId`). `Browser.getVersion` at launch. |
| Headless | `--headless=new`, `windowsHide: true` |
| User data | Injected `browserRoot/user-data/{profileId}/...` only. No discovery of the user's Chrome profile. |
| linux64 / mac-* | Resolver/install paths implemented, **not** launched in this worktree. |
| Missing binary | `setup_required` (verified). |

Install/cache lives under `.mousse-dev/browser-binaries` (gitignored). Receipt: `.mousse-dev/browser-binaries/binaries/SHA256-153.0.8010.36-win64.txt` and `binaries/certified/metadata.json`.

## Tests and evidence

```powershell
npm run typecheck
npx vitest run tests/platformBrowserWorker.framing.test.ts tests/platformBrowserWorker.lifecycle.test.ts tests/platformBrowserWorker.observation.test.ts tests/platformBrowserWorker.actions.test.ts tests/platformBrowserContracts.test.ts --maxWorkers=2
```

Evidence (this SHA, 2026-09-11 local):

- `tsc --noEmit` both `tsconfig.node.json` and `tsconfig.web.json`: pass
- Vitest: **5 files, 30 tests passed**, ~26s, `--maxWorkers=2`
- Real managed Chromium against `tests/fixtures/browser/site/**` on loopback:
  - lifecycle start/close
  - two-profile cookie isolation
  - persistent workspace lock
  - stale refs after navigation
  - screenshot crop + deviceScaleFactor 2 geometry vs `geometry.ts`
  - form fill + click end-state `saved:Ada:pwlen=0`
  - overlay click refusal
  - human takeover fences agent act
  - disconnect does not auto-replay
  - bundled child-process IPC open/close
- CDP/IPC framing and generation fencing: no Chromium required
- Existing `platformBrowserContracts` (refs/geometry/actions): pass

Local logs (not committed): `.mousse-dev/logs/npm-ci.log`, `.mousse-dev/logs/browser-worker-install.json`.

## B03 remaining (explicit, not pretended)

Certified now: navigate/back/forward/reload, click/double-click/hover, fill/type/key, select, check, scroll, dialog (`Page.handleJavaScriptDialog`), wait/find/extract, takeover cancel, unknown-effect on disconnect after dispatch.

**Not certified / rejected `unsupported`:**

- `drag`
- `upload` (needs MMS-staged artifact file grant / `DOM.setFileInputFiles` path)
- image-point coordinate clicks (geometry transform exists; dispatch path not certified)
- download acknowledgment / quarantine
- crash reconnect onto an existing user-data dir with generation bump
- OOPIF: warning `unsupported-oopif` / `iframe-observation-limited`; closed shadow DOM unsupported
- no-progress cycle limiter, approval persistence (C4 W02/M01)
- Electron-attached backend
- Packaged installer / update / rollback (B04)

## Downstream

WG7 (M01/M02) can drive the same worker from MMS tools/viewer without a model. Root owns composition, protocol methods, and BrowserPanel. Do not attach this worker to the user's everyday browser profile.
