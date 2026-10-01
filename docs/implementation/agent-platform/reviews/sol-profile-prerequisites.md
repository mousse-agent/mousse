# Sol profile prerequisite integration review

## Review boundary

- Branch: `feat/platform-integration`
- Reviewed base: `5815c64641cb1a7c55c44a49154addf3e6694372`
- Exact core handoff: `50e343464608ac0b7f178aa27df0097e47268f79`
- Integration merge: `a79bb11`
- Reviewed code head: `2391a9ae1e8b2866fe96bc9b2b30a37c834d1720`
- Review date: 2026-09-11 (Asia/Calcutta)

The exact core handoff, including storage injection `91e5bbe` and the `MmsProfileServices` extraction, was merged without pushing or changing `master`. This pass did not modify the orb or the root-owned control/auth implementation.

## Findings fixed

- Channel authorization used prototype-aware dictionary operations. An unpaired user ID such as `toString` could therefore appear approved, while `__proto__` could corrupt an approval map. Pairing, rate-limit, pending, and approval maps now load into null-prototype records and use own-key checks. A regression covers both inherited and prototype-setter user IDs.
- Captured channel environment credentials were reapplied to the config returned by `getConfig`, and an unrelated `updateConfig` could then persist those environment tokens into `mousse.conf`. Persistence now restores the stored token/port beneath the environment overlay. The store captures only the three channel environment variables it consumes. Tests verify that the legacy token remains usable but absent from disk after an update; personal stores still inherit no channel environment.
- Dotted config reads traversed inherited prototype properties even though writes rejected prototype segments. Reads now require own keys and flattened listings omit prototype-sensitive keys.
- A profile config could be bound to the installation config's same path, allowing the profile-scoped persist to overwrite installation sections. `loadProfile` now rejects aliased/canonical-equal roots.
- Profile writes could read shared feature flags but could not update them through the scoped dotted API. `features.*` now routes to the installation writer just like `mms.*`; tests verify live reads from another profile and installation-only persistence.
- Thread trash used an indirect local containment wrapper. Every move and recursive purge now calls the shared `assertOwnedPath` helper directly for the trash root/path and, in strict personal mode, the original thread path. Windows junction regressions prove that an outside target survives both a proposed move and a tampered recursive purge.
- `MmsProfileServices.stop` stopped attempting cleanup after the first failure and then became permanently idempotent, leaving later personal services active. It now attempts scheduled, channel, MCP, control, and config cleanup, then reports the single error or an aggregate. `MousseMainService` continues to stop the shared provider and release the exact installation lease in its `finally` block. A regression forces the first cleanup to fail and verifies every later cleanup still runs.

## Verification

| Command | Result |
| --- | --- |
| `npx vitest run tests/platformProfileStoreInjection.test.ts` | 8 tests passed after the containment/config/auth changes. |
| Six-file focused run over profile injection, channels, trash, owner lease, local protocol, and thread mutation | 6 files and 81 tests passed. This includes authenticated protocol flow, replay/backpressure/disconnect behavior, and owner cleanup. |
| Final focused run over profile injection, channels, trash, and owner lease | 4 files and 51 tests passed; the profile prerequisite file now contains 9 tests. |
| `npm run typecheck` | Passed for node and renderer TypeScript projects. |
| `git diff --check` | Passed before the code commit. |

All new filesystem checks use temporary roots and fixture credentials. No live account, provider, channel, or model was used. The full suite and build were intentionally not repeated for this node-only prerequisite pass while other runtime workers were active.

## Remaining composition work

- The default `MousseMainService` remains the compatibility facade over one legacy profile and one installation owner. No profile activation, switcher, runtime cache, or connection-to-profile binding is implemented here.
- Startup migration and scoped `MousseConfigStore.loadInstallation`/`loadProfile` composition must land together. The current compatibility bootstrap still uses the legacy full config.
- Orchestrator/LLM questions and modes, managed integration constructor contexts, profile-filtered event replay, renderer presentation state, real per-profile provider login, and browser partitions remain pending.
- `MmsProfileServices` intentionally receives the installation-owned provider catalog and domain registry and never initializes/stops them or acquires/releases the installation lease. This pass verifies the lifecycle seam and failure cleanup, not concurrent production profile activation.
- Strict personal trash containment is enabled through personal `ThreadDataStore` composition. Legacy repository transcript discovery remains available only to the compatibility profile until migration disables it.

This pass qualifies the captured storage roots and service-extraction prerequisites for composition work. It does not mark profile activation or the wider agent-platform plan complete.
