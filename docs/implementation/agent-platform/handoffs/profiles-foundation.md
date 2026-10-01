# Handoff: P01/P02 profile foundation

Package: P01/P02 foundation (paths, registry, staged migration)
Branch / worktree: feat/platform-profiles / C:/Users/bubbl/Documents/Projects/RYSPA/mousse-platform-worktrees/profiles
Base SHA: ce0667c1146d6e0f3af83bdd0faaab7fd4150854
Package SHA: 5ff2e3839db40d1060f7051d9e4b18e17b29ad16
Contract produced: C1@1.0.0 (`PROFILE_CONTRACT_ID` / `PROFILE_CONTRACT_VERSION`)
User-visible before/after: no user-visible change. Nothing is wired into MousseMainService, protocol, renderer, or the Liquid Glass Orb.

This is the first foundation handoff, not completion of Profiles or of the parallel plan. P03/P04, protocol binding, store injection, and UI remain unbuilt.

## Behavior delivered

Concrete C1 contract and implemented modules under the owned paths:

- Stable UUID v4 profile identities, slug/display metadata, integer revisions, active/archived lifecycle.
- `InstallationPaths` / `ProfilePaths` with canonical installation home, safe owned joins, and preserved endpoint identity (`mms.owner.json`, `mms.runtime.json`, `mms.sock`, Windows named-pipe hash of the installation home).
- `ProfileManager` with atomic `installation.json` + `profile.json`, create/list/get/update/archive/restore, revision conflicts, path ownership, and immutable `ProfileRuntime` / `ProfileScopedAccess`.
- Profile bind increments a per-manager epoch and never writes `process.env.MOUSSE_HOME` or an installation-wide current-profile file.
- Shared provider/auth paths stay installation-scoped (`auth.json`, `providers/`, repository leases, browser binaries). Personal settings/catalogs/control/channels/scheduled/thread-data use the profile root.
- `ProfileMigrationService`: dry-run inventory, resumable journal, staged copy with count/hash validation, mousse.conf split that preserves unknown keys, Git worktree retain-by-default, and Plus credential decrypt-at-old-path / re-encrypt-at-live-destination (never a `credentials.enc` byte-copy). Credentials are applied only after the Default root is promoted to `profiles/<id>/` because ControlStore key derivation includes the control directory path.

## Changed paths

- `src/shared/profiles/**` — frozen C1 types, errors, settings classification, fixtures
- `src/mms/profiles/**` — paths, manager, runtime, scoped access, migration
- `tests/platformProfiles*.test.ts`
- `docs/implementation/agent-platform/handoffs/profiles-foundation.md`

No other files were edited. `package.json`, `src/shared/types.ts`, `src/shared/settings.ts`, data/config stores, `MousseMainService`, protocol/preload/IPC, renderer, and existing tests are unchanged.

## Filesystem layout after a committed migration

```
$MOUSSE_HOME/
  installation.json          schema v2, default profile, index
  mousse.conf                installation keys only (mms, features, unknown)
  auth.json                  shared, unmoved
  mms.owner.json / mms.runtime.json / mms.sock
  repositories/              shared leases; registered Git worktrees retained in place
  migration/journal.json     resumable journal
  migration/snapshot/        pre-split originals
  profiles/<defaultId>/
    profile.json
    mousse.conf              personal keys (settings, providers, agents, scheduled, channels)
    thread-data/...
    control/credentials.enc  re-encrypted for this directory
    scheduled/ channels/ mcp-oauth/ ...
```

Absent `installation.json` means staged data is not authoritative.

## Tests and commands

Exact commands from this worktree after `npm ci` (local `node_modules`, not shared):

```
npx vitest run tests/platformProfiles.contract.test.ts tests/platformProfiles.paths.test.ts tests/platformProfiles.manager.test.ts tests/platformProfiles.migration.test.ts
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
```

Results at the package head: 15/15 focused tests passed; both typecheck projects passed. No `npm test` full suite was run (out of package scope). Pre-existing failures in the broader suite were not re-measured here and must not be relabeled from this work.

Covered: A/B identity/paths/CRUD/revision conflicts; shared `auth.json`; invalid IDs/traversal/symlink escapes; dry-run; idempotent re-run; crash before commit; crash after commit; ambiguous `.data` vs `thread-data`; ControlStore adapter decrypt/re-encrypt and byte-copy unreadability.

## Known limitations

- Stores still read `getMousseHomeDir()` / `process.env.MOUSSE_HOME`. This package only provides injectable paths.
- No protocol `profiles.bind`, event filtering, handshake capability, or renderer switcher (P03).
- Archive/restore exist; trash/delete/pause/background ingress isolation is P04.
- Git worktrees are retained at the legacy physical path with an ownership record. A Git-aware move/repair adapter can be injected later; the default adapter will not byte-move registered worktrees.
- Device identity vs Plus account split remains P03. Default receives the migrated control store as the compatibility target.
- Browser partition lifecycle stays with the existing `persist:mousse-browser` until P03 hands it to WG7.
- Multi-profile enablement must stay gated until G2 (protocol + store injection + A/B service tests).

## Shared-file insertion requests for WG0

Do not apply these in this worktree. Coordinator owns the following compositions.

### 1. `src/mms/MousseMainService.ts` (`create` / constructor)

After canonicalizing the **installation** home (daemon home, not a profile):

```ts
import {
  createInstallationPaths,
  createControlStoreCredentialAdapter,
  createRetainingGitWorktreeAdapter,
  ProfileManager,
  ProfileMigrationService
} from './profiles'

const installation = createInstallationPaths(homeDir)
const profileManager = ProfileManager.open(installation)
if (!profileManager.isInitialized()) {
  const migration = new ProfileMigrationService(installation, profileManager)
  await Promise.resolve(migration.run({
    adapters: {
      credentials: createControlStoreCredentialAdapter(),
      gitWorktrees: /* retain default, or a Git-aware adapter once available */
        createRetainingGitWorktreeAdapter()
    }
  }))
}
const runtime = profileManager.bind(requestedProfileRef ?? profileManager.getDefaultProfileId())
```

Keep the daemon `MOUSSE_HOME` as the installation home. Do **not** set `process.env.MOUSSE_HOME` when binding or switching a profile.

Pass `runtime.paths` / `installation` into store constructors instead of ambient path helpers.

### 2. Constructor argument map (current ambient → injected)

| Current construction | Requested injection |
|---|---|
| `ProviderAuthService` (`join(getMousseHomeDir(), 'auth.json')`) | `installation.authJson` |
| `ThreadStorageLayout()` / `ThreadDataStore` home | `runtime.paths.threadStorageHome` |
| `ControlStore(homeDir)` | `new ControlStore(runtime.paths.controlStoreHome)` |
| `MousseConfigStore.load(homeDir)` | split: installation conf at `installation.mousseConf`; profile conf at `runtime.paths.mousseConf`. Unknown keys stay on the installation file. |
| Channel runtime (`getChannelsDir()`) | `runtime.paths.channelsDir` |
| Scheduled runtime (`getScheduledDir()`) | `runtime.paths.scheduledDir` |
| `getProjectsIndexPath` / `getThreadsIndexPath` / `getActiveThreadPath` | `runtime.paths.projectsJson` / `threadsIndexJson` / `activeThreadJson` |
| `getMcpOAuthDir` / `getGeneratedAgentConfigRoot` | `runtime.paths.mcpOAuthDir` / `agentConfigsDir` |
| `LineEditStatsStore` | `runtime.paths.lineEditsJson` |
| `WorktreeManager` / `ThreadWorkspaceManager` repository leases | keep `installation.repositoriesDir` for identity/leases; new profile-owned workspaces under `runtime.paths.repositoriesDir`; honor `retainedLegacyRoots` from the migration journal |
| `ModeRegistry` roots that bypass `MOUSSE_HOME` | profile-scoped discovery under `runtime.paths` |

`MousseConf` classification is frozen in `src/shared/profiles/settingsClassification.ts`. Installation keys: `version`, `mms`, `features`. Profile keys: `settings`, `providers` (personal model selection, not the shared catalog), `agents`, `scheduled`, `channels`.

### 3. Protocol / IPC (WG0-owned files)

- Handshake: negotiate `profiles-v1`. Installation methods stay unclassified as profile-bound.
- `profiles.bind` sets an immutable connection binding + epoch. Redundant payload `profileId` must match.
- Event envelopes: `profileId`, stream kind, sequence, object revision. Filter before serialize and before event-ring replay.
- Legacy clients: Default only while `compatibility.singleProfileLegacyClients` is true.
- Do not relocate `mms.owner.json`, `mms.runtime.json`, `mms.sock`, or the Windows pipe identity.

### 4. Renderer / appStore (P03, not this package)

Switcher, selection epoch, draft flush, namespaced persistence. Out of scope here.

## Downstream consumers unblocked

- WG3 W02, WG5 I01+, WG6 B01 (profile path fake no longer required; use `createInstallationPaths` + `createProfilePaths` or `ProfileManager.bind`)
- WG7 browser partition work still waits for P03 ownership transfer
- WG0 can review C1 and plan store/protocol insertion without a competing schema

## Runtime / feature flags

None introduced. Do not enable multi-profile UI or protocol until G2 wiring lands.

## External dependencies

None added. Uses Node `crypto`/`fs`/`path`, existing `AtomicFs`, `withFileLock`, `ControlStore`, and `protocol/endpoint` hash helpers.

## Working tree

Owned files only. `node_modules` is local to this worktree from `npm ci` and is not committed.
