# Profiles production vertical slice

Branch: `feat/platform-profiles`

This handoff composes the reviewed C1 profile storage/migration work into the running MMS. `MousseMainService.create()` remains the single installation owner. It initializes or resumes migration before personal services, keeps provider authentication/catalog state at the installation root, and attaches one `ProfileHost` with lazy per-profile service promises.

## Runtime APIs

`MousseMainService.getProfileServices(profileIdOrSlug): Promise<MmsProfileServices>` returns the attached Default service for the default profile and a cached, independently initialized `MmsProfileServices` for every other active profile. Each personal service has explicit profile roots, `UserQuestionService`, `ModeRegistry`, MCP/Skills integration context, control root, channels, schedules, projects, threads, PTY manager, and generated agent config roots. ProviderAuth and installation repository leases are shared.

`MousseMainService.getInstallationHost()` returns the host seam. `ProfileHost` exposes `manager`, `getProfileServices`, `getLive`, `activeProfileCount`, `disposeProfile(profileIdOrSlug)`, `dispose()`, `previewRemove()`, and `remove()`. `disposeProfile` is idempotent for non-default services; shared providers and the owner lease remain owned by `MousseMainService`.

The domain registry exposes `profiles.list`, `profiles.status`, `profiles.create`, `profiles.update`, `profiles.bind`, `profiles.archive`, `profiles.restore`, `profiles.removePreview`, and `profiles.remove`. `profiles.bind` accepts only an ID or slug, validates active status, increments a connection epoch, and changes the server-owned binding. A profile request is routed from the immutable binding captured at request admission. Legacy clients remain Default-only while there is one active profile; upgraded clients request `profiles-v1` and must bind before personal operations once multiple profiles exist.

`LocalMmsClient` now throws `MmsProtocolError` with enumerable `code` and optional `details`, preserving daemon codes such as `profile_binding_required`, `profile_archived`, `profile_mismatch`, and `profile_revision_conflict` through main/preload IPC.

CLI invocations accept `--profile <id|slug>` and bind before provider/settings/turn operations. GUI preload exposes `window.mousse.profiles` for list/status/bind/create/update/archive/restore/remove preview/remove. The app includes a profile switcher, profile-local renderer workspace persistence, store reset on epoch/profile change, and profile-specific browser partitions (`persist:mousse-profile-<uuid>`). Main IPC obtains the binding from the trusted sender session; renderer parameters never select filesystem roots.

The per-window GUI path keeps a `PresentationState`, activity tracker, turn-state map, and MMS session for each trusted sender. Personal IPC replies default to the sender's profile, while installation listeners remain global. Protocol events from window sessions are delivered directly to the matching sender after checking its profile binding; questions, PTY/control events, transcript updates, late responses, and replay snapshots therefore cannot cross profiles. Event gaps emit `window-resnapshot` and recover through `snapshotThreadForSender` on the same bound session.

`DomainHandlerRegistry` provides `onConnectionClosed(listener): unsubscribe` and `notifyConnectionClosed(connectionId)`. The server invokes the notification on socket close and immediately before a `profiles.bind` replacement invalidates an old binding. It also provides the optional `onProfileDisposed` / `notifyProfileDisposed` seam, used by profile archive/remove cleanup. Root integration registrations should make their returned `disconnect(connectionId)` idempotent because a rebind is followed by eventual socket close.

New feature clients use the bounded preload bridge `window.mousse.platformRequest.request(method, params)`. Main IPC allowlists the workflow, agent-definition, integration snapshot, Skills, and MCP method families, validates JSON parameters and a 512 KiB limit, then dispatches through the trusted sender session. Daemon `code` and `details` survive the main/preload boundary as structured `PlatformRequestError` fields; arbitrary legacy method names are rejected with `platform_method_not_allowed`.

## Verification

Focused production checks:

- `npx vitest run tests/platformProfileRuntime.test.ts --maxWorkers=2` — service composition, shared provider instance, isolated questions/modes/roots, secret resolver isolation, framed client binding, and structured archive rejection.
- `npx vitest run tests/platformProfiles.contract.test.ts tests/platformProfiles.paths.test.ts tests/platformProfiles.manager.test.ts tests/platformProfiles.migration.test.ts --maxWorkers=2` — 17 migration/identity/path tests passed.
- `npx vitest run tests/platformDomainRegistry.test.ts tests/platformProfileStoreInjection.test.ts --maxWorkers=2` — 14 protocol/store prerequisite tests passed.
- `npx vitest run tests/mmsProtocolServer.test.ts tests/guiMmsController.test.ts tests/protocolValidation.test.ts --maxWorkers=2` — 44 existing protocol/client/UI lifecycle tests passed.
- `npm run typecheck` — node and renderer projects pass after `npm ci --no-audit --no-fund`.

`node scripts/run-profile-isolation-visual-check.mjs` — hidden/offscreen Electron **harness**, with a URL/localStorage/CustomEvent simulation and fixture-only preload. Its passing checks cover that harness's dirty switch logic, event filtering, themes, partition markers, and a hardcoded `revision_conflict` envelope surviving Electron IPC/contextBridge cloning. It does **not** exercise production `registerGuiIpc`, `GuiMmsController`, MMS routing, the real switcher, or the application browser host. Those production two-window checks remain required; this harness cannot close G2. Screenshots are in `.mousse-dev/profile-isolation-evidence/`.

## Composition limits for root

Root should compose the existing agent-definition, workflow, and integration lifecycle domain registrations into the same `DomainHandlerRegistry`; this slice does not implement those feature handlers. Root should preserve the `profiles-v1` capability negotiation and invoke `getProfileServices` for feature service construction. Root can subscribe its integration cleanup to `onConnectionClosed` and profile disposal to `onProfileDisposed`; no GUI/domain registry edits are required.

Final implementation commits before this continuation: **a82e1232654fbc3431e38c7873be7fe9cd78a69b**, renderer async fencing **afd1f37d23353e4c2d85eaa6e54d40d5690769ff**, browser view detach fix **783728263d55c981789cb0410c5281660d3af245**, and prior handoff docs **4a9bdeb**, **f75ddc9**, **e8af267**. The continuation commit containing per-window routing, lifecycle notifications, bounded platform bridge, and hidden Electron fixture is recorded in the final handoff message after commit.
