# Final requirement audit — frozen core `06af7cf`

Audit date: 2026-09-11  
Frozen checkout: `06af7cf7805d8349f4b3c35bbbf7b1cccc771a81` (`feat/platform-integrations-ui`, clean at inspection)  
Latest commit: `feat(browser): compose installation setup with app CLI and launch lifecycle`  
Documents used: `docs/agents-workflows-profiles-browser-architecture.md`, `docs/parallel-worktree-implementation-plan.md`  
Not used as missing-code evidence: `docs/implementation/agent-platform/status.md` (historical; only G0 boxes were kept current)

This audit maps every F/P/U/A/W/V/I/B/M/Q package to production source in this SHA, the strongest reviewed evidence, and the specific remaining requirement. It does not implement, re-run suites, or claim G1–G7 closed. `status.md` unchecked boxes are not treated as absent implementations.

## Method

- Production presence is established from source and callers, not ledger checkboxes.
- Strongest evidence is an exact Sol review plus named tests. Component/hidden-Electron evidence is not packaged visible-app acceptance.
- Known unmerged candidates are **in-flight named owner**, not rediscovered blockers. Root merges them and runs the full suite.
- Existing in-app browser must remain the same actual Electron guest. Managed Chromium is CLI/scheduled/headless only. No silent substitution. Main/E2E evidence: `78d55f3` / `ab68e66` / review `16de106` (`reviews/sol-main-browser-e2e.md`, `tests/platformMainBrowserE2E.test.ts`).
- Profiles must separate all personal state; providers/models stay installation-shared.
- MCP Add skill create/upload and MCP connect paths must be real product journeys (they are, with remaining live-OAuth/packaged qualification).

## Classification

| Label | Meaning |
|---|---|
| implemented/reviewed | Production source is composed in this SHA; a named Sol review plus focused tests exist. Remaining work is not a missing implementation. |
| partially implemented | Production source exists, but a named required behavior is still incomplete in this SHA. |
| qualification-only | Behavior is implemented and reviewed; remaining work is combined/packaged/live-provider/Linux evidence. |
| in-flight named owner | Candidate exists in another worktree and may be unmerged here. Do not treat as missing. |

## In-flight candidates (do not rediscover)

| Owner / worktree | Candidate | Frozen SHA status | Remaining root action |
|---|---|---|---|
| Sol / `agents` HEAD `4e82573` (merge `903bd66` onto `06af7cf`) plus dirty `src/mms/protocol/server.ts` | `MmsWorkflowAgents` grant-ceiling / parent-child pinned binding. Review: `agents/docs/implementation/agent-platform/reviews/sol-workflow-agent-adapter.md`. Tests: `tests/platformWorkflowAgents.test.ts` (10), `tests/platformWorkflowSubworkflowRecovery.test.ts` (15). | Production `src/mms/platform/MmsWorkflowAgents.ts` is already composed in `MmsProfilePlatform`. Review hardens grant intersection and stale-revision fail-closed. | Merge the reviewed agents freeze. Do not rewrite the adapter. |
| Sol / `profiles` uncommitted `src/mms/platform/MmsWorkflowBrowser.ts`, `tests/platformWorkflowBrowser.test.ts`, `reviews/sol-workflow-browser-production.md` (branch HEAD `5159e2d`) | Policy/admission bridge for workflow Browser nodes. GUI requires the selected Electron-attached tab for the same thread and never falls back to managed Chromium. | This SHA still installs an inline `workflowRuns.configureAdapters({ browser })` in `MousseMainService.configureProfileBrowser` (lines 265–273) that does not walk pinned child graphs or Settings enablement. | Apply the review’s composition hook; **remove** the inline adapter so it cannot overwrite the validated binding. |
| Sol / `browser` HEAD `06af7cf` with dirty `src/mms/browser/BrowserSetupService.ts` | Review of managed setup `0ccfd71` composed by root `06af7cf`. Handoff: `handoffs/browser-setup-composition.md`. Tests: `tests/platformBrowserSetup.test.ts`, `tests/platformBrowserSetupCli.test.ts`. | Setup service, CLI `browser` command, and `BrowserSetupPanel` are already composed. In-app tabs do not require this download (`BROWSER_SETUP_IN_APP_NOTE`). | Finish the Sol review; keep attached guests independent of managed install. |
| Grok / `workflow-runtime` HEAD `21f4284` plus uncommitted `src/mms/platform/MmsWorkflowChat.ts`, `tests/platformWorkflowBackgroundIngress.test.ts`, `handoffs/workflow-background-ingress.md` | Channel/scheduled slash ingress with host-owned message/occurrence IDs hashed into receipts. | Frozen `WorkflowRunAdmission.source` is `'gui' \| 'cli'` only (`src/mms/workflows/registerRunMethods.ts`). `MmsWorkflowChatBridge` likewise accepts only GUI/CLI. | Merge the candidate; then root suite. RPC starts stay GUI/CLI. |

## Package map

### WG0 foundation

| Pkg | Class | Production source (this SHA) | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| F00 | implemented/reviewed | Integration baseline + this core SHA | G0: clean typecheck, 125 files / 857 tests, app+CLI build (recorded in `status.md` historical G0; do not treat later boxes as current) | None for code. Original master dirty `package.json` / lock / vitest / worktree test remain excluded and must be reconciled later, not overwritten. |
| F01 | implemented/reviewed | `src/shared/{profiles,agents,workflows,integrations,browser,execution}`, `src/mms/protocol/**`, domain registration in `MousseMainService.ts` | `reviews/sol-foundation.md` | No missing contracts. Hostile-payload vectors already exist as domain tests. |
| F02 | implemented/reviewed | `src/renderer/components/editors/MarkdownDocumentEditor.tsx`, `integrations/IntegrationsWorkspace.tsx`, `AgentsWorkspace.tsx`, `workflows/**`, Settings extraction | `sol-foundation.md`; `sol-integrations-app-ui.md`; `handoffs/app-agents-workspace.md` | None for extraction. Packaged Settings route is Q04. |
| F03 | implemented/reviewed | Per-worktree home/userData/port/browser/artifact roots; `tests/platformDevelopmentRuntime.test.ts` | Foundation review + 2 isolation tests in `platformDevelopmentRuntime.test.ts` | Two concurrent GUI instances on one machine remain qualification, not missing isolation code. |
| F04 | partially implemented | Root composition in `MousseMainService.ts`, `MmsProfilePlatform.ts`, GUI IPC, CLI | This audit; ongoing merge queue | G7 combined candidate evidence after in-flight merges. Root-owned. Do not start another speculative audit. |

### WG1 profiles

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| P01 | implemented/reviewed | `src/mms/profiles/{paths,ProfileHost,ProfileRuntime,ProfileManager}.ts`, `MmsProfileServices.ts`, store injection | `reviews/sol-profile-production.md` (63 focused tests; `npm run test:profile-production` 7 two-window preload checks); `tests/platformProfiles.paths.test.ts`, `platformProfileStoreInjection.test.ts` | Shared providers/catalog remain installation-owned (`SharedAgentModelLookup`, provider auth). No missing path injection. |
| P02 | implemented/reviewed | `src/mms/profiles/migration/**` | `reviews/sol-profile-recovery.md` — 7 files / 52 tests (`platformProfiles.contract/paths/manager/migration`, store injection, runtime, auth) | Packaged upgrade/live-account migration is Q04. Git worktrees retained with explicit ownership by design. |
| P03 | partially implemented | `ProfileSwitcher.tsx` mounted from `App.tsx`; `profileBrowserPartition()` in `src/main/browser/browserPolicy.ts`; `BrowserViewManager.ts` uses it; `appStore.activateProfile` namespaces `mousse-profile-<id>-workspace`; persist `partialize` is empty for the installation key `mousse-workspace-state`; Plus auth in `src/mms/control/auth/**` | `sol-profile-production.md`; `sol-auth-agent-domain.md` (59 auth/domain tests + 8 control vectors); `sol-browser-panel-lifetime.md` (profile-keyed guest destroy) | **Integrity:** `src/renderer/lib/modelFavorites.ts` still uses global `mousse.modelFavorites`; `src/renderer/lib/quickActions.ts` still uses `mousse.quickActions.v1`. Namespace both by bound `profileId`. Plus refresh-token lifecycle is qualification (`sol-auth-agent-domain.md`). Visible dirty-editor/theme/OS-notification journeys are qualification. |
| P04 | partially implemented | `MmsProfileServices.beginShutdown` / `getOwnedActivity` include MCP, channels, control, platform (agent+browser+artifacts), orchestrator, scheduler, PTY, headless. Owner binding reviewed. | `sol-profile-drain-composition.md` (48 combined / 10 drain); `sol-profile-integration-owner-binding.md` (15 drain, including failed-channel-close retry); `sol-mcp-lifecycle.md` (13 drain); `sol-channel-control-lifecycle.md`; `sol-owned-work-lifecycle.md` (27 focused + 39 queue); `sol-managed-browser-drain.md` | **Integrity:** `ProfileHost.previewRemove` still reports only `activeTurns`, enabled schedules, and channels (`src/mms/profiles/ProfileHost.ts` ~249–266). `remove()` refuses only `activeTurns > 0`. Drive preview/remove admission from `getOwnedActivity()` all-zero. Live Discord/Telegram/relay TCP teardown is qualification. E2E-05/06/07/11 combined packaged isolation is Q02/Q04. |

### WG2 editor and agents

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| U01 | implemented/reviewed | `src/renderer/components/editors/MarkdownDocumentEditor.tsx` | `tests/platformMarkdownEditor.test.ts`, `tests/fileEditor.test.ts`; Agent Editor Monaco Source/Preview in `npm run test:agent-editor` | None for extraction. |
| A01 | implemented/reviewed | `src/mms/agentDefinitions/{AgentDefinitionRegistry,AgentResolver,registerMethods}.ts`, `src/shared/agents/**` | `sol-auth-agent-domain.md`; `tests/platformAgentDefinitions.test.ts`, `platformAgentDomains.test.ts` | Production lookups are live catalog adapters (`SharedAgentModelLookup`). Static fixtures were contract-only; composition superseded that remaining note. |
| A02 | implemented/reviewed | `src/renderer/components/agentDefinitions/**`, `AgentsWorkspace.tsx` (Agents/Workflows subtabs), root-owned `src/renderer/components/orb/LiquidGlassOrb.tsx` (do not change) | `sol-agent-ui.md`: 4 files / 42 tests; `npm run test:agent-editor` 28 hidden Electron checks; `npm run test:orb` | **Honesty:** `AgentSettingsForm.tsx` still offers `sandboxed` and `src/shared/agents/defaults.ts` defaults to it, while `runtimePolicy.ts` fails closed (`SANDBOX_UNAVAILABLE`). Workflow inspector already disables the option. Hide/disable sandboxed in the Agent Editor and default to `workspace`. Orb/layout is implemented; do not reopen Orb work. Packaged visible-route is Q04. |
| A03 | implemented/reviewed | `MmsAgentExecutionService.ts`, `nativeRuntime.ts`, `cliRuntime.ts`, `runtimePolicy.ts` | `sol-agent-production-execution.md`; `sol-agent-execution.md`; `sol-agent-runtime-policy.md`; `sol-agent-cli-materialization.md`; `sol-native-browser-runtime-binding.md` (`platformNativeBrowserRuntime.test.ts` + 3 files / 41 combined) | Documented unsupported: selected-project Try Run (scratch dir), public per-run list/cancel RPC, persistent memory, native CLI browser binding, live installed CLI consumption. Capability reports fail closed. Do not promise those knobs. |

### WG3 workflow runtime

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| W01 | implemented/reviewed | `src/mms/workflows/{compiler,registry,schema}/**`, `examples/workflows/summarize-files/**`, `src/shared/workflows/**` | `tests/platformWorkflowCompiler.test.ts`, `platformWorkflowSchema.test.ts`, `platformWorkflowRegistry.test.ts`, `platformWorkflowExample.test.ts`; definition/canvas reviews | None for format/compiler. |
| W02 | implemented/reviewed | `WorkflowRunService.ts`, `ScriptRunner.ts`, `ApprovalService.ts`, `ArtifactStore.ts`, child admission | `sol-workflow-runtime-continuation.md` (17 files / 143, then 3/60 runtime/domain); `sol-workflow-runtime-durability.md`; `sol-workflow-production-runs.md` (5 files / 35 + `npm run test:workflow-editor` 50 Electron checks); `sol-workflow-child-composition.md`; `sol-workflow-child-recovery.md` | Sandboxed scripts fail closed (`UnconfiguredSandboxAdapter`, coordinator preflight `executor_unavailable`). That is required honesty, not a missing sandbox product. OS sandbox backend is optional/experimental. |
| W03 | implemented/reviewed | `WorkflowInvocationResolver.ts`, `MmsWorkflowChatBridge.ts`, GUI/CLI slash, graph nodes (loops/join/subworkflow/error/wait) | `sol-workflow-cli-slash.md` — 6 files / 71 tests including built CLI children (`platformWorkflowCli`, `threadMessageQueue`, `cliSessionCommands`, `cliLaunch`, `protocolValidation`, `platformWorkflowInvocation`) | Renderer chat interaction is typecheck/build only. Busy one-shot CLI reports queued acceptance and exits (`sol-workflow-cli-slash.md`). Completion/argument forms and run cards are UX remaining, not missing admission. |
| W04 | in-flight named owner (partial in this SHA) | Channel/control lifecycle composed (`ChannelService`, `MmsControlService`). Recovery/unknown-effect in W02. Browser runner currently the inline adapter above. | `sol-channel-control-lifecycle.md`; W02 continuation; Grok handoff `workflow-background-ingress.md` (unmerged) | Merge trusted channel/schedule slash ingress. Then compose `MmsWorkflowBrowser`. Typed schedule *targets* beyond slash-in-prompt remain a follow-on if product still requires non-slash scheduled graphs. E2E-12 (GUI close during scheduled browser) is Q02 after those merges. |

### WG4 workflow editor

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| V01 | implemented/reviewed | `WorkflowCanvas.tsx`, `WorkflowPalette.tsx`, `WorkflowInspector.tsx`, `WorkflowsWorkspace.tsx` | `sol-workflow-production-runs.md` / canvas evidence; `npm run test:workflow-editor` 50 hidden Electron checks | Packaged visible canvas is Q04. |
| V02 | implemented/reviewed | `WorkflowSourceEditor.tsx`, history, import/export, binding editors | Same Electron fixture: canvas↔source save, published schema, dirty/profile guards | Multi-window save-conflict packaged qualification. |
| V03 | implemented/reviewed | `WorkflowRunPanel.tsx`; concurrent `pendingApprovals/Inputs/Conditions` from continuation review | `sol-workflow-runtime-continuation.md` public DTO/UI; production-runs client tests | 250-node virtualization measurement, reduced-motion/high-contrast packaged checks: qualification/polish, not missing debugger source. |

### WG5 skills and MCP

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| I01 | implemented/reviewed | `src/mms/integrations/**` (native paths, actor, connection identity, refresh invalidation, anonymous/OAuth/stdio states) | `sol-integration-isolation.md` (11 files / 65); `sol-integrations-backend.md`; `tests/platformIntegration{Actor,Discovery,Isolation,Lifecycle,McpRuntime,Materialization}.test.ts` | None of the original six defects remain unimplemented. Live remote servers are qualification. |
| I02 | implemented/reviewed | `SkillLifecycleService.ts`; Settings `IntegrationsWorkspace` Add skill / Upload (`SkillDialogs.tsx` create + zip/md/folder import); `SettingsPage.tsx` mounts it | `sol-integrations-app-ui.md`: `platformIntegrationUi.test.ts` + 29 hidden Electron checks (Monaco save, directory upload, profile guards) | Packaged Settings journey and live Git-revision pin are qualification. Paths are real, not stubs. |
| I03 | implemented/reviewed | `McpLifecycleService.ts`, `McpConnectionDialog.tsx` stdio/HTTP/SSE, None/static/OAuth | Same UI review (failed/cancelled OAuth presentation); `sol-mcp-lifecycle.md` (callback port exclusivity, drain) | Live provider OAuth/refresh interoperability is qualification. Connect/test/enable/delete are real. |
| I04 | implemented/reviewed (fail-closed capability reports) | Materialization in `src/mms/integrations/agents/**`, `agentDefinitions/cliRuntime.ts` | `sol-integration-isolation.md` (two profiles, same repo, no shared package/config bytes; exact grants); `sol-agent-cli-materialization.md` | Installed Claude/Codex/OpenCode/Cursor consumption is **qualification**, not a silent success path. Crash-durable materialization cleanup is explicitly unimplemented and must not be claimed. |

### WG6 browser worker

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| B01 | implemented/reviewed | `src/browser-worker/**`, `BrowserBroker.ts`, `BrowserSetupService.ts` | `sol-browser-daemon-composition.md`; `sol-managed-browser-drain.md`; `sol-browser-installer.md`; `sol-browser-worker-installer-resolution.md` (`platformBrowserWorkerBinaryResolver.test.ts` + lifecycle, real Chrome) | Official catalog download on every OS/arch and headed packaged discovery: Q03/Q04. In-flight Sol setup review. |
| B01a | implemented/reviewed | `src/main/browser/AttachedBrowserHost.ts`, `src/main/browser/automation/**`, `AttachedBrowserConnectionBackend.ts` | `sol-browser-attached-executor.md`; `sol-attached-browser-main-integration.md`; `sol-browser-command-transport.md`; **`sol-main-browser-e2e.md` on `78d55f3` / `ab68e66`** — `tests/platformMainBrowserE2E.test.ts` 1/1: native `browser_open`/`browser_act` through framed MMS + owning GUI connection into the **same** hidden webview; cookies retained; takeover/resume; **no managed fallback**; guest survives automation release; daemon count 0 | Do not replace this guest with managed Chromium. Hidden-window screenshots may be `screenshot-unavailable` by design. |
| B02 | implemented/reviewed | `src/browser-worker/observation/**` | `sol-browser-frames.md`; `tests/platformBrowserWorker.observation.test.ts` | Nested OOPIF / closed shadow remain explicit unsupported. |
| B03 | implemented/reviewed | `src/browser-worker/action/**` | `sol-browser-actions.md`; `tests/platformBrowserWorker.actions.test.ts` (real Chrome, uploads/downloads/takeover/crash recovery recorded in later combined 18-test runs) | Packaged/macOS/Linux headed: qualification. |
| B04 | implemented/reviewed | installer/update/rollback, process-tree, setup composition | `sol-browser-installer.md`; `tests/platformBrowserPackaging.test.ts`, `platformBrowserFixtureBounds.test.ts`; root `06af7cf` setup composition | Packaged binary certification is Q04. Sol setup review in-flight. |

### WG7 browser tools / viewer / adapters

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| M01 | implemented/reviewed | `BrowserSessionManager.ts`, `BrowserBackendRouter.ts`, `src/mms/orchestrator/browser/**`, `mainBrowserBinding.ts` | `sol-browser-automation.md`; `sol-browser-backend-routing.md`; `sol-native-browser-runtime-binding.md`; main E2E above | GUI → attached selected tab; non-GUI → managed. Silent backend substitution is rejected in daemon/E2E fixtures. Workflow node policy bridge is the in-flight `MmsWorkflowBrowser`. |
| M02 | implemented/reviewed | `BrowserPanel.tsx` (canonical tabs + `KeepMounted`), `BrowserAutomationViewer.tsx`, human handoff | `sol-browser-panel-lifetime.md` (22 lifetime checks + 11 `browserTabs.test.ts`); `sol-browser-viewer.md`; `sol-browser-human-handoff.md` (review recorded `16de106`) | Visible headed OS mouse/focus is qualification. Handoff observations are in-memory across daemon restart by design. |
| M03 | qualification-only / experimental | `src/mms/browser/modelAdapters/**` | `sol-browser-model-adapters.md` — 1 file / 5 tests + 19 combined; **no capability row is Available** | Provider-native schemas are **experimental**. Generic M01 tools are the required product path. Do not block release on BrowserGym or paid-model rows. |

### WG8 qualification

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| Q01 | implemented/reviewed | `tests/fixtures/agent-platform/**`, `tests/fixtures/browser/**`, isolated Electron scripts (`test:orb`, `test:agent-editor`, `test:workflow-editor`, `test:profile-production`) | Those scripts and domain tests | Not a live-model harness. Sufficient for component gates. |
| Q02 | qualification-only | Cross-feature tests exist as separate suites | Many named reviews above; **no single candidate SHA has E2E-01..12 combined** | After in-flight merges, root runs the combined suite. Do not re-audit by checkbox. |
| Q03 | qualification-only (not started) | Local Chrome action/observation fixtures exist; **no BrowserGym adapter source** | Architecture §10.10 / plan Q03; `sol-browser-model-adapters.md` | BR-02 evaluation job. Not a user-visible editor/runtime feature. Optional/experimental vs shipping generic browser tools. |
| Q04 | qualification-only (not started) | Desktop/CLI build paths exist | G0 build evidence only | Windows/Linux packaged install, upgrade/migration, missing-browser, Plus server contract, operator docs. G7. |

## User-original required vs optional/experimental vs qualification

**User-original required (architecture §1.1 AW/PR/IN/BR):** file-backed workflows; `/name` in app and CLI; instructions + revision-pinned scripts; Agents/Workflows subtabs; Agent Editor with orb; visual workflow editor; multi-profile personal ownership; shared providers/models; Add skill create/upload and MCP connect; Mousse-owned browser on the **existing in-app Electron guest** plus managed CLI/headless.

**Present in this SHA for those required paths:** Agents/Workflows workspace, orb+editor, canvas/source/run panel, GUI/CLI slash receipts, profile host + partitions, Settings Add skill/upload/Add MCP, attached-tab E2E with no managed fallback, managed setup for CLI/headless.

**Optional / experimental / fail-closed (do not expand scope):** OS sandboxed scripts; M03 provider-native adapters; BrowserGym/WebArena leaderboards; persistent native-agent browser workspaces; vision/B2 coordinate tools as a second loop; macOS advertised packaging; workflow marketplace/cloud runner; live external CLI grant fidelity beyond capability reports.

**Release qualification (not missing product source):** packaged app, live Plus/OAuth/channel servers, two-instance GUI, visible headed OS input, combined E2E-01..12, Linux install matrix, operator doc refresh.

## Highest-priority remaining work (max 10)

Only user-visible or integrity items. Smallest concrete action. In-flight work is listed as merge/compose, not rewrite.

1. **Compose `MmsWorkflowBrowser` and delete the inline workflow browser adapter.** Integrity: GUI workflow Browser nodes must keep the selected Electron tab and must not fall back to managed Chromium; pinned child graphs need Settings-gated admission. Action: merge Sol profiles candidate; apply the composition hook in `MmsProfilePlatform.prepareExecution`; remove `MousseMainService.configureProfileBrowser` lines that `configureAdapters({ browser })`.
2. **Merge Grok workflow-background-ingress.** User-visible AW-02: channel/scheduled `/name` currently cannot use GUI/CLI receipts because frozen admission is GUI/CLI-only. Action: merge `MmsWorkflowChat.ts` + `platformWorkflowBackgroundIngress.test.ts`; keep host-owned message/occurrence IDs; then root suite.
3. **Merge Sol `MmsWorkflowAgents` grant-ceiling freeze (`4e82573`).** Integrity: parent/child must not recover tools omitted by the admitted ceiling; Skill/MCP head changes fail closed. Action: merge agents review; do not reimplement.
4. **Finish Sol review of managed setup `0ccfd71`/`06af7cf`.** User-visible CLI/headless install; must not alter attached guests. Action: land review diffs in `BrowserSetupService.ts` only as needed; keep `BROWSER_SETUP_IN_APP_NOTE`.
5. **Wire `previewRemove` / remove admission to `getOwnedActivity()`.** Integrity P04: UI/API can understate MCP/browser/agent/PTY/control work and start removal on turn-idle profiles. Action: refuse while any composed count is nonzero; archive/remove already drain — make the preview match.
6. **Namespace `modelFavorites` and `quickActions` by profileId.** PR-01: two profiles in one renderer currently share those keys. Action: same pattern as `mousse-profile-${id}-workspace`.
7. **Stop offering unavailable sandboxed agent scripts.** User-visible honesty: Agent Editor select + default `sandboxed` vs fail-closed runtime. Action: disable option, default `workspace`, keep `UnconfiguredSandboxAdapter` fail-closed.
8. **CLI busy-thread slash follow-through.** AW-02: one-shot CLI prints queued acceptance and exits (`sol-workflow-cli-slash.md`). Action: wait/cancel by `--request-id` against the existing receipt; do not invent a second ingress.
9. **Honest Try Run controls.** A03: no public list/get/cancel for a single editor run (`sol-agent-production-execution.md`). Action: either add the small RPC the review deferred, or disable per-run cancel in UI and document host-wide drain. Do not fake per-run cancel.
10. **Root combined qualification after 1–4.** Q02/Q04: typecheck, repository tests, app+CLI build, focused E2E already named above, on the merged SHA. Not a new implementation wave.

## Explicit non-blockers

- Liquid Glass Orb: implemented and reviewed; root-owned; this audit must not change it.
- Managed Chromium as a substitute for the in-app tab: forbidden; already proven not to occur on the main E2E path.
- `status.md` empty G1–G7 / F01–Q04 boxes: stale ledger, not missing code.
- Live provider, live Plus, live Discord/Telegram, BrowserGym, packaged Windows/Linux: qualification or experimental.
- Materialization crash-cleanup durability and hostile-filesystem races: documented limits, not new packages.

Root finish path: merge the four named candidates, apply the two frozen integrity patches (previewRemove, favorites/quickActions), hide sandboxed agent mode, then run the suite on the integrated SHA.
