# Profiles production vertical slice

Branch: `feat/platform-profiles`

This handoff composes the reviewed C1 profile storage/migration work into the running MMS. `MousseMainService.create()` remains the single installation owner. It initializes or resumes migration before personal services, keeps provider authentication/catalog state at the installation root, and attaches one `ProfileHost` with lazy per-profile service promises.

## Runtime APIs

`MousseMainService.getProfileServices(profileIdOrSlug): Promise<MmsProfileServices>` returns the attached Default service for the default profile and a cached, independently initialized `MmsProfileServices` for every other active profile. Each personal service has explicit profile roots, `UserQuestionService`, `ModeRegistry`, MCP/Skills integration context, control root, channels, schedules, projects, threads, PTY manager, and generated agent config roots. ProviderAuth and installation repository leases are shared.

`MousseMainService.getInstallationHost()` returns the host seam. `ProfileHost` exposes `manager`, `getProfileServices`, `getLive`, `activeProfileCount`, `disposeProfile(profileIdOrSlug)`, `dispose()`, `previewRemove()`, and `remove()`. `disposeProfile` is idempotent for non-default services; shared providers and the owner lease remain owned by `MousseMainService`.

The domain registry exposes `profiles.list`, `profiles.status`, `profiles.create`, `profiles.update`, `profiles.bind`, `profiles.archive`, `profiles.restore`, `profiles.removePreview`, and `profiles.remove`. `profiles.bind` accepts only an ID or slug, validates active status, increments a connection epoch, and changes the server-owned binding. A profile request is routed from the immutable binding captured at request admission. Legacy clients remain Default-only while there is one active profile; upgraded clients request `profiles-v1` and must bind before personal operations once multiple profiles exist.

`LocalMmsClient` now throws `MmsProtocolError` with enumerable `code` and optional `details`, preserving daemon codes such as `profile_binding_required`, `profile_archived`, `profile_mismatch`, and `profile_revision_conflict` through main/preload IPC.

CLI invocations accept `--profile <id|slug>` and bind before provider/settings/turn operations. GUI preload exposes `window.mousse.profiles` for list/status/bind/create/update/archive/restore/remove preview/remove. The app includes a profile switcher, profile-local renderer workspace persistence, store reset on epoch/profile change, and profile-specific browser partitions (`persist:mousse-profile-<uuid>`). Main IPC obtains the binding from the trusted sender session; renderer parameters never select filesystem roots.

## Verification

Focused production checks:

- `npx vitest run tests/platformProfileRuntime.test.ts --maxWorkers=2` — service composition, shared provider instance, isolated questions/modes/roots, secret resolver isolation, framed client binding, and structured archive rejection.
- `npx vitest run tests/platformProfiles.contract.test.ts tests/platformProfiles.paths.test.ts tests/platformProfiles.manager.test.ts tests/platformProfiles.migration.test.ts --maxWorkers=2` — 17 migration/identity/path tests passed.
- `npx vitest run tests/platformDomainRegistry.test.ts tests/platformProfileStoreInjection.test.ts --maxWorkers=2` — 14 protocol/store prerequisite tests passed.
- `npx vitest run tests/mmsProtocolServer.test.ts tests/guiMmsController.test.ts tests/protocolValidation.test.ts --maxWorkers=2` — 44 existing protocol/client/UI lifecycle tests passed.
- `npm run typecheck` — node and renderer projects pass after `npm ci --no-audit --no-fund`.

The Electron fixture screenshot suite was not run in this worktree because it requires a display-capable Electron session. The renderer surface is covered by the profile switcher and namespaced store contract; root should run the hidden Electron fixture on its composed branch.

## Composition limits for root

Root should compose the existing agent-definition, workflow, and integration lifecycle domain registrations into the same `DomainHandlerRegistry`; this slice does not implement those feature handlers. Root should preserve the `profiles-v1` capability negotiation and invoke `getProfileServices` for feature service construction. A future root pass should route profile-tagged GUI events from per-window sessions through the window binding map; the daemon protocol ring already filters replay/live events by binding.

Final implementation commits: **a82e1232654fbc3431e38c7873be7fe9cd78a69b**, renderer async fencing **afd1f37d23353e4c2d85eaa6e54d40d5690769ff**, and browser view detach fix **783728263d55c981789cb0410c5281660d3af245**.
