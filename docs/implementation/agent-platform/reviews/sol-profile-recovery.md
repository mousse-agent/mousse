# Sol review: P02/P04 profile recovery

Reviewed candidate: `9c13da9761942db7c5bb66270b8508797b0be9fc`

Qualified implementation freeze: `c64fd49e3acdd84643611a26022adb4913c84c27`

Disposition: accepted for the profile-owned P02 migration and deletion-recovery slice after fixes below. This does not close P04 or the profile release gate.

## Findings fixed

1. A process failure after the staging profile rename but before the `promote-staging` completion write left a live generated root that pre-commit rollback did not remove. The migration now exposes an exact post-action/pre-completion fault seam, persists the staged tree digest before rename, and removes the live root only when that digest verifies the interrupted promotion.
2. An existing malformed or non-committed `installation.json` was treated as absence and could be overwritten. Existing manifests now fail closed unless the manager validates the full committed profile contract and Default record.
3. Migration journals accepted out-of-order completed steps and incomplete structural fields. Recovery now requires a unique ordered prefix, a current step adjacent to that prefix, valid core fields, and a valid optional Default profile ID.
4. Legacy MCP OAuth state was copied to `profile/mcp-oauth`, while the composed integration runtime resolves `profile/secrets/mcp-oauth`. Migration, the path classification, and new-profile layout now agree on `secrets/mcp-oauth`. New profiles also create the generated `agent-configs` directory.
5. Pending deletion recovery could forget an archived index entry when both the profile root and trash destination were missing. It now preserves the marker and fails startup closed. Marker filename/destination/profile identity, archived fallback record, UUID token, duplicate profile markers, symlink markers/destinations, active targets, and duplicate roots are validated before mutation.
6. The archived-record fallback could identify a record other than the indexed profile when `profile.json` was unavailable. `forgetArchived` now validates the fallback through the manifest entry and the normal profile-record parser.
7. Profile, migration, and trash roots could trust an owned root whose ancestor was redirected through a reparse point. Profile path construction and destructive migration/removal entry points now verify canonical containment under the installation home.

## Evidence

- `npx vitest run tests/platformProfiles.contract.test.ts tests/platformProfiles.paths.test.ts tests/platformProfiles.manager.test.ts tests/platformProfiles.migration.test.ts tests/platformProfileStoreInjection.test.ts tests/platformProfileRuntime.test.ts tests/platformProfileAuth.test.ts --maxWorkers=2 --minWorkers=1` — 7 files, 52 tests passed.
- `npm run typecheck` — both node and web TypeScript projects passed.
- Added restart/fault evidence for the post-rename/pre-journal promotion window, rollback and rerun, malformed manifest preservation, non-prefix journal rejection, missing-root deletion refusal, profile-directory reparse escape, and complete new-profile OAuth/generated-config layout.
- Existing evidence continues to cover legacy `settings.json` and browser copy, path-bound control credential re-encryption/readback, committed rollback acknowledgement, crash before/after commit, same-repository per-profile project records, shared provider-auth identity, profile-owned settings/runtime stores, event routing, and truthful profile-scoped Plus auth.

No build was needed because this slice changes TypeScript source/tests and no generated build artifact. Tests use temporary local homes, fixture credentials, filesystem state, and loopback/local process composition only.

## Remaining limits and required host seams

P04 remains incomplete. `ProfileHost.disposeProfile()` currently delegates to `MmsProfileServices.stop()`. That stop path disposes the platform workflow services, scheduler ticks, channels, MCP sessions, control service, and config watcher. It does not yet prove that all ordinary orchestrator turns, native/external agents, headless runners, PTYs, managed browser sessions, and pending personal questions have been cancelled and awaited before archive/removal. `previewRemove()` counts active orchestrator turns and reports enabled schedules/channels, but it does not expose all owned workflow/agent/browser/PTY/question activity or reject every such active resource.

Root integration must install one awaited lifecycle owner before `disposeProfile`, archive, or remove can publish success. That owner must stop admission and channel/control ingress for the profile; cancel and await workflow runs, ordinary turns, agents/headless workers, browser sessions, PTYs, scheduler work, and questions; persist recovery-required state for effects that cannot be proven cancelled; expose those counts to `previewRemove`; and restart the still-active profile runtime if a revision race or index rollback occurs. `DomainHandlerRegistry.notifyProfileDisposed(profileId)` is currently called by the archive/remove domain handlers after the profile operation; integrations subscribe through `onProfileDisposed`, but this best-effort notification is not an awaited pre-removal stop barrier.

Startup deletion recovery runs before profile services are composed, so an active indexed target is refused rather than stopped. Corrupt or conflicting pending markers deliberately block startup for operator repair; there is no quarantine/repair command yet. The removal journal covers its own marker/index/root boundaries, but no exhaustive injected native filesystem error matrix has been run for every `atomicWriteJsonSync`, `renameSync`, and `unlinkSync` call.

Same-repository isolation is qualified at the profile metadata layer: two profile-owned `ProjectManager` instances create independent records for the same path, while `WorktreeManager` receives the shared installation home for repository coordination. Full concurrent cross-profile mutation fencing remains a root/WG8 integration gate. Provider authentication/catalog objects are shared by identity, while profile settings and model selections are stored under separate profile roots; shared quota attribution and all external provider behaviors remain unqualified.

Legacy browser migration copies the existing browser root into Default and retains the source. Correct assignment of every historical Electron partition/cache location and managed-browser shutdown during deletion remain P03/B04/root acceptance work. Live user accounts, external providers, hosted channels, paid models, and packaged-platform migration were not exercised.
