# Sol review: production profiles and platform composition

## Reviewed revisions

- Previous reviewed integration base: `e40e0749eac0c3f8e07f8401101d5760146dcef5`
- Root profile/composition input: `94eadf62b683c505944aef231bf9c87f4fc0edb8`
- Root lifecycle/navigation input: `0e5a51dab4839be462477b9efb8f888c8c91944b`
- Merge baseline reviewed in this pass: `de5c08a249f065b95667e6fe84ae1d9c8918ed34`
- Review result: this commit on `feat/platform-integration`

The review covered the production `MousseMainService`/`ProfileHost` composition, profile protocol admission and lifecycle, `GuiMmsController`, `registerGuiIpc`, preload profile/platform surfaces, CLI binding, and Electron browser partitions. The earlier custom-event/localStorage profile preview remains a UI simulator and is not cited as production isolation evidence.

## Findings fixed

- The protocol server subscribed only to Default's runtime producers. It now wires every live profile idempotently, attaches profiles created or restored while running, and removes listeners on profile disposal.
- A single installation sequence counter exposed other profiles' event rate as cursor gaps and caused false resnapshots. Replay rings and cursors are now per profile audience; safe installation events are copied into each audience stream.
- `profiles.bind` could race requests admitted immediately after it. Binding mutations are serialized in wire order, later requests capture the resulting immutable binding, and a GUI window establishes a fresh subscription boundary after switching cursor namespaces.
- Default personal events were bridged through the base connection and per-window connection, while nondefault personal events used only the latter. Personal delivery now always uses the exact trusted window session and its own presentation state; the base connection carries installation events once. Settings, control, focus, turn/activity notification, transcript, question, and PTY routing use the bound window.
- Unknown/unbound renderer senders inherited the base Default binding. They now remain unbound, and browser IPC plus `will-attach-webview` fail closed until a trusted profile binding exists.
- GUI sessions requested only `profiles-v1`, so Agent, workflow-definition, and integration platform calls failed capability admission. Both base and window clients now request the four implemented platform capabilities.
- Installation-scoped profile lifecycle calls were rejected merely because their payload named the target `profileId`. Profile mismatch checks now apply to profile-scoped domains; lifecycle validators still constrain their own target parameters.
- Profile errors lost their typed code/details at the framed boundary. Revision conflicts now reach the production platform preload with their code and structured details.
- Archive and removal stopped a runtime before checking the caller's revision. They validate first and restart the still-active runtime if a concurrent mutation wins while shutdown awaits.
- Removal archived and moved a root while leaving its entry in the live installation index, so the next `profiles.list()` tried to read a missing `profile.json`. Removal now forgets the archived index entry before the recoverable trash move and rolls the index/runtime back if that move fails.
- `profiles.bind` exposed the absolute profile storage root to renderer clients. The public result now contains only the public profile DTO and binding epoch.
- A capable CLI without `--profile` stayed unbound in a multi-profile installation. It now resolves and binds the installation default, retaining compatibility with older daemons that lack profile methods.
- The personal-service cleanup regression fixture omitted the new platform facade, accidentally manufacturing a second cleanup error. It now verifies platform disposal together with every existing personal service.

## Verification

- `npm test -- tests/platformProfileRuntime.test.ts tests/platformDomainRegistry.test.ts --maxWorkers=2 --testTimeout=60000 --hookTimeout=60000` — 11 passed.
- `npm test -- tests/guiMmsController.test.ts tests/platformProfileRuntime.test.ts tests/platformDomainRegistry.test.ts tests/profileNavigationGuard.test.ts --maxWorkers=2 --testTimeout=60000 --hookTimeout=60000` — 21 passed in the three matching suites.
- `npm test -- tests/mmsProtocolServer.test.ts tests/platformProductionComposition.test.ts tests/platformProfiles.test.ts tests/platformProfiles.migration.test.ts --maxWorkers=2 --testTimeout=60000 --hookTimeout=60000` — 36 passed in the three matching suites.
- `npm test -- tests/platformProfileRuntime.test.ts tests/platformProfileStoreInjection.test.ts --maxWorkers=2 --testTimeout=60000 --hookTimeout=60000` — 15 passed.
- `npm test -- tests/platformProfiles.contract.test.ts tests/platformProfiles.manager.test.ts tests/platformProfiles.paths.test.ts tests/platformProfiles.migration.test.ts tests/platformProfileStoreInjection.test.ts tests/platformProfileAuth.test.ts tests/platformProfileRuntime.test.ts tests/platformProductionComposition.test.ts tests/guiMmsController.test.ts tests/platformDomainRegistry.test.ts --maxWorkers=2 --testTimeout=60000 --hookTimeout=60000` — 63 passed in 10 files.
- `npm run test:profile-production` — 7 production checks passed in two hidden offscreen Electron windows using the actual production preload, `registerGuiIpc`, `GuiMmsController`, framed server, `MousseMainService`, and Electron sessions. Evidence is written to `.mousse-dev/profile-production-evidence/result.json`.
- `npm run typecheck` — passed.
- `npm run build` — passed.

The Electron fixture proves two trusted bindings without path disclosure; forged profile rejection; platform capability admission and structured revision conflict details; independent profile settings; isolated transcript, question, PTY, control, and turn events plus snapshots; and cookie clearing confined to the sender's production profile partition. It uses temporary local homes and no live provider, model, account, channel, or network connection.

## Remaining qualification and wiring

- The full packaged application route, visible profile switcher, dirty-editor decision flow, window theme rendering, and operating-system notification behavior are not exercised by this backend/preload fixture. The separate simulated profile preview does not close those gates.
- Provider credentials are intentionally installation-shared, while profile Plus/account grants are personal. The focused auth suites cover cancellation and persistence contracts; no live account login was used here.
- Project-scoped managed MCP/SKILL write ownership needs the queued I04 audit: two profiles selecting the same repository currently target the same `.mousse` project paths. Trusted discovery can be shared, but grants and secrets must remain personal.
- Browser B03 worker packaging/takeover and a simultaneous multi-window visible browser surface remain separate work. This pass verifies trusted partition selection and cookie isolation in real Electron sessions.
- Settings/Integrations production UI composition and the app route commit being developed in core were outside this pass and remain separately reviewable.
- Workflow runtime recovery/adapters, Agent execution, and remaining production command wiring are unchanged and remain open in their respective workstreams.
