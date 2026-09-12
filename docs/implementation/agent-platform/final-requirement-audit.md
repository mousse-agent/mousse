# Agent platform requirement audit

Audit updated: 2026-09-12. Integrated production source remains `778aa39`; qualification-only changes and final fixture corrections are integrated in the original checkout through `11184d0`, with the user's dependency overlay preserved. Architecture and plan: [design](../../agents-workflows-profiles-browser-architecture.md), [parallel AI workgroups](../../parallel-worktree-implementation-plan.md).

The package map records implementation ownership and reviewed evidence. The compound matrix below records the stricter cross-feature checks added after the initial audit. Component passes and code presence do not imply that G7 or live-provider certification is complete.

## Exact compound acceptance

| Scenario | Current evidence and boundaries |
|---|---|
| E2E01 Agent editor save/restart/run | `a4422c8`, `platformEditorCrossFeature.test.ts`, [review](reviews/sol-e2e01-02-editor-cross-feature.md): real Electron editor-to-MMS save/publish, restart, production renderer load, native Try Run, provider inputs, durable run, and thread messages; provider response is scripted. |
| E2E02 canvas/source/publish/export/import | Same fixture and review: rendered workflow canvas/source/layout, save/publish, completed Electron download, file-input import, stable node IDs/edges/editor state, restart durability, and zero workflow execution on import. |
| E2E03 GUI/CLI slash parity | `87b1df4`, `platformWorkflowCli.test.ts`, [review](reviews/e2e03-parity.md): exact revisions, arguments, validation, and execution through real GUI RPC and built CLI. |
| E2E04 script/condition/parallel Agents/join/artifact | `358136c`, `platformWorkflowCrossFeature.test.ts`; [workspace review](reviews/sol-workflow-workspace-correction.md) at `da11a17`. Real script CWD, separate registered Git worktrees, exact Agent prompts, ordered output, durable artifact, clean primary repository. Provider I/O is scripted; native project tools are real. |
| E2E05 profile switch during activity | `2b415db`, `platformProfileCrossFeature.test.ts`; [review](reviews/sol-e2e05-07-profile-composition.md). Real profile services/bindings and late-event fencing; local fixture browser/provider actors. |
| E2E06 shared repository/provider | Same compound fixture proves separate personal ownership, one cross-profile mutation lease, and attributed provider use. |
| E2E07 Plus logout isolation | Same compound fixture proves A-only revocation with B/shared-provider state retained; the Plus service is a local contract fixture. |
| E2E08 Skill and three MCP transports | `d12b6ff`, `platformIntegrationCrossFeature.test.ts`, Sol accepted 1/1: actual anonymous/OAuth HTTP and stdio calls for main/child actor scopes, exact Skill bytes, schema restrictions, and live revocation. OAuth tokens are preseeded; this is scripted actor dispatch, not live model/OAuth enrollment. |
| E2E09 form with takeover/resume | `dffba45`, `platformMainBrowserE2E.test.ts`; [review](reviews/sol-e2e09-browser-handoff.md). Same actual Electron guest, preserved cookie, stale-ref rejection, renewed lease, real form POST, no managed fallback. |
| E2E10 kill daemon after effect | `5432d0d`, `platformWorkflowDaemonCrash.test.ts`, Sol accepted 1/1. SIGKILL actual built Node daemon after script append; restart same home, retain pinned run, recover unknown-effect, never duplicate marker. Must run with current rebuilt CLI in final suite. |
| E2E11 kill migration process | `dd38cd4`, `platformProfileMigrationCrash.test.ts`; [review](reviews/sol-e2e11-profile-migration-crash.md). Actual process termination around promotion and credential migration, then exact recovery. |
| E2E12 close GUI during scheduled browser | `a191817`, `platformScheduledBrowserE2E.test.ts`; [review](reviews/sol-scheduled-browser-e2e.md). Durable required approvals survive GUI closure and resolve from a replacement authenticated GUI. |

## Final candidate qualification

Original-checkout typecheck and app/CLI rebuild passed with the preserved upgraded dependencies. At final head `11184d0`, focused browser/editor verification passed 18/18. The final parallel combined suite passed 220 files and 1,576 tests, with three contended daemon/watch tests failing and one skip; their isolated single-worker rerun passed 30/30. Previous 211-file/1,528-pass evidence belongs to the previous candidate. Current-source Windows 17/17 directory-package checks and earlier Linux Node/native/migration plus desktop/CLI AppImage builds are recorded in the [Windows](reviews/final-windows-package.md) and [Linux](handoffs/linux-qualification.md) reports, with exact source and environmental limits.

Q03 is required. The [reviewed evaluation harness](reviews/sol-browser-evaluation.md) supports scripted conformance, strict injectable HTTP decisions, observation-mode projection, cumulative budgets, end-state verification, and reproducible reporting. Through `11184d0` it covers the full selected task/model/mode/repeat matrix, bounded profile-scoped PNG payloads, document-ready initial observations, staged upload artifact metadata/IDs, and published download-name verification; focused tests pass 17/17. Its local protocol adapter is not an executed external BrowserGym environment. Three-repeat conformance produced 145/145 successful actions, 44/46 successful supported tasks, zero false success and zero duplicate effects. Two failed navigation trials remain in evidence; after readiness synchronization the navigation follow-up passed 10/10 tasks and 15/15 actions. Broad-run Wilson lower bounds of 0.974/0.855 do not qualify the proposed targets. No live model is certified by this evidence.

## Method

- Production presence is established from source and callers, not ledger checkboxes.
- Strongest evidence is an exact Sol review plus named tests. Component/hidden-Electron evidence is not packaged visible-app acceptance.
- Reviewed implementation freezes listed below are merged in this checkout. Remaining qualification is tracked separately from product gaps.
- Existing in-app browser must remain the same actual Electron guest. Managed Chromium is CLI/scheduled/headless only. No silent substitution. Main/E2E evidence: `78d55f3` / `ab68e66` / review `16de106` (`reviews/sol-main-browser-e2e.md`, `tests/platformMainBrowserE2E.test.ts`).
- Profiles must separate all personal state; providers/models stay installation-shared.
- MCP Add skill create/upload and MCP connect paths must be real product journeys (they are, with remaining live-OAuth/packaged qualification).

## Classification

| Label | Meaning |
|---|---|
| implemented/reviewed | Production source is composed in the integrated source; a named Sol review plus focused tests exist. Remaining work is not a missing implementation. |
| partially implemented | Production source exists, but a named required behavior is still incomplete in the integrated source. |
| qualification-only | Behavior is implemented and reviewed; remaining work is combined/packaged/live-provider/Linux evidence. |
| documented limitation | Behavior is intentionally unavailable or bounded and fails honestly; it is not a missing original requirement. |

## Final named implementation closures

| Prior item | Merged implementation and evidence |
|---|---|
| 1. Workflow Browser composition | `4866946`, `d309324`, and read-policy correction `ea8f45b`, merged through `2552f87`. `MmsWorkflowBrowser` is owned by `MmsProfilePlatform`; the old inline adapter is gone. `platformMainBrowserE2E.test.ts` proves the same Electron guest, two exact durable approvals, verified action trace, preserved cookie, and no managed fallback. Review: `sol-workflow-browser-production.md`. |
| 2. Channel/scheduled workflow ingress | `d680e2d` plus recovery fix `d0cfd9d`, merged at `3fc2f1c`. Stable channel message and schedule occurrence receipts survive reconstruction; post-admission observation abort does not cancel the run. Review: `sol-workflow-background-ingress.md` (4 production tests + 49 channel/scheduler regressions). |
| 3. Workflow Agent grant ceiling | `4e82573`, merged through `5944816`. Parent/child pins, stale revisions, model/tool ceilings, and durable preparation are covered by `platformWorkflowAgents.test.ts` and `platformWorkflowSubworkflowRecovery.test.ts`. Review: `sol-workflow-agent-adapter.md`. |
| 4. Managed Browser setup review | `d8cd19e`, merged through `6059b40`. Setup admission and retry ownership are retained; attached guests remain independent. Review: `sol-browser-setup-composition.md` (15 setup/CLI + 3 daemon tests, both TypeScript projects and CLI build). |
| 5. Profile removal inventory | `cdbfb67`, merged through `4d762d5`. Preview exposes composed `getOwnedActivity()` and archive/remove still uses the full retryable drain barrier. Review: `sol-profile-preferences-preview.md` (16 profile manager/migration regressions). |
| 6. Profile-scoped favorites and quick actions | `091e266` plus async race fix `7d8991f`, merged through `74d0d7e`. Storage keys, migration, event ownership, and async continuations are profile-bound. Review: `sol-profile-preferences-preview.md` (3 focused tests). |
| 7. Unavailable sandbox presentation | `091e266`, merged through `65bc959`. New agents default to `workspace`; the editor disables `sandboxed`; explicit legacy sandbox definitions continue to fail closed. |

## Package map

### WG0 foundation

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| F00 | implemented/reviewed | Integration baseline + this core SHA | G0: clean typecheck, 125 files / 857 tests, app+CLI build (recorded in `status.md` historical G0; do not treat later boxes as current) | The original checkout has been fast-forwarded with all five user-overlay file hashes preserved. Current combined checks use the upgraded dependency overlay. |
| F01 | implemented/reviewed | `src/shared/{profiles,agents,workflows,integrations,browser,execution}`, `src/mms/protocol/**`, domain registration in `MousseMainService.ts` | `reviews/sol-foundation.md` | No missing contracts. Hostile-payload vectors already exist as domain tests. |
| F02 | implemented/reviewed | `src/renderer/components/editors/MarkdownDocumentEditor.tsx`, `integrations/IntegrationsWorkspace.tsx`, `AgentsWorkspace.tsx`, `workflows/**`, Settings extraction | `sol-foundation.md`; `sol-integrations-app-ui.md`; `handoffs/app-agents-workspace.md` | None for extraction. Packaged Settings route is Q04. |
| F03 | implemented/reviewed | Per-worktree home/userData/port/browser/artifact roots; `tests/platformDevelopmentRuntime.test.ts` | Foundation review + 2 isolation tests in `platformDevelopmentRuntime.test.ts` | Two concurrent GUI instances on one machine remain qualification, not missing isolation code. |
| F04 | implemented/reviewed | Root composition in `MousseMainService.ts`, `MmsProfilePlatform.ts`, GUI IPC, CLI | Named reviews and merged closures above | No missing composition from the seven audited items. Combined suite and packaged evidence remain qualification. |

### WG1 profiles

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| P01 | implemented/reviewed | `src/mms/profiles/{paths,ProfileHost,ProfileRuntime,ProfileManager}.ts`, `MmsProfileServices.ts`, store injection | `reviews/sol-profile-production.md` (63 focused tests; `npm run test:profile-production` 7 two-window preload checks); `tests/platformProfiles.paths.test.ts`, `platformProfileStoreInjection.test.ts` | Shared providers/catalog remain installation-owned (`SharedAgentModelLookup`, provider auth). No missing path injection. |
| P02 | implemented/reviewed | `src/mms/profiles/migration/**` | `reviews/sol-profile-recovery.md` — 7 files / 52 tests (`platformProfiles.contract/paths/manager/migration`, store injection, runtime, auth) | Packaged upgrade/live-account migration is Q04. Git worktrees retained with explicit ownership by design. |
| P03 | implemented/reviewed | Profile switcher, browser partitions, profile workspace, profile-keyed favorites/quick actions, Plus auth | `sol-profile-production.md`; `sol-auth-agent-domain.md`; `sol-browser-panel-lifetime.md`; `sol-profile-preferences-preview.md` | Plus refresh-token interoperability and visible packaged journeys are qualification. |
| P04 | implemented/reviewed | `MmsProfileServices.beginShutdown` / `getOwnedActivity`, `ProfileHost.previewRemove`, retryable archive/remove drain | Lifecycle reviews plus `sol-profile-preferences-preview.md` | Live Discord/Telegram/relay TCP teardown and combined packaged isolation remain qualification. |

### WG2 editor and agents

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| U01 | implemented/reviewed | `src/renderer/components/editors/MarkdownDocumentEditor.tsx` | `tests/platformMarkdownEditor.test.ts`, `tests/fileEditor.test.ts`; Agent Editor Monaco Source/Preview in `npm run test:agent-editor` | None for extraction. |
| A01 | implemented/reviewed | `src/mms/agentDefinitions/{AgentDefinitionRegistry,AgentResolver,registerMethods}.ts`, `src/shared/agents/**` | `sol-auth-agent-domain.md`; `tests/platformAgentDefinitions.test.ts`, `platformAgentDomains.test.ts` | Production lookups are live catalog adapters (`SharedAgentModelLookup`). Static fixtures were contract-only; composition superseded that remaining note. |
| A02 | implemented/reviewed | Agent editor/workspace and root-owned Liquid Glass Orb | `sol-agent-ui.md`; `npm run test:agent-editor`; `npm run test:orb`; `sol-profile-preferences-preview.md` | New definitions default to workspace mode and the unavailable sandbox option is disabled. Packaged visible-route evidence is Q04. |
| A03 | implemented/reviewed | `MmsAgentExecutionService.ts`, `nativeRuntime.ts`, `cliRuntime.ts`, `runtimePolicy.ts` | `sol-agent-production-execution.md`; `sol-agent-execution.md`; `sol-agent-runtime-policy.md`; `sol-agent-cli-materialization.md`; `sol-native-browser-runtime-binding.md` (`platformNativeBrowserRuntime.test.ts` + 3 files / 41 combined) | Documented unsupported: selected-project Try Run (scratch dir), public per-run list/cancel RPC, persistent memory, native CLI browser binding, live installed CLI consumption. Capability reports fail closed. Do not promise those knobs. |

### WG3 workflow runtime

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| W01 | implemented/reviewed | `src/mms/workflows/{compiler,registry,schema}/**`, `examples/workflows/summarize-files/**`, `src/shared/workflows/**` | `tests/platformWorkflowCompiler.test.ts`, `platformWorkflowSchema.test.ts`, `platformWorkflowRegistry.test.ts`, `platformWorkflowExample.test.ts`; definition/canvas reviews | None for format/compiler. |
| W02 | implemented/reviewed | `WorkflowRunService.ts`, `ScriptRunner.ts`, `ApprovalService.ts`, `ArtifactStore.ts`, child admission | `sol-workflow-runtime-continuation.md` (17 files / 143, then 3/60 runtime/domain); `sol-workflow-runtime-durability.md`; `sol-workflow-production-runs.md` (5 files / 35 + `npm run test:workflow-editor` 50 Electron checks); `sol-workflow-child-composition.md`; `sol-workflow-child-recovery.md` | Sandboxed scripts fail closed (`UnconfiguredSandboxAdapter`, coordinator preflight `executor_unavailable`). That is required honesty, not a missing sandbox product. OS sandbox backend is optional/experimental. |
| W03 | implemented/reviewed | `WorkflowInvocationResolver.ts`, `MmsWorkflowChatBridge.ts`, GUI/CLI slash, graph nodes (loops/join/subworkflow/error/wait) | `sol-workflow-cli-slash.md` — 6 files / 71 tests including built CLI children (`platformWorkflowCli`, `threadMessageQueue`, `cliSessionCommands`, `cliLaunch`, `protocolValidation`, `platformWorkflowInvocation`) | Exact GUI RPC/built-CLI parity is covered by E2E03. Busy one-shot CLI reports durable queued acceptance and exits; it does not silently discard the run. |
| W04 | implemented/reviewed | Channel/control lifecycle, resumable channel/schedule slash ingress, and composed `MmsWorkflowBrowser` | `sol-channel-control-lifecycle.md`; `sol-workflow-background-ingress.md`; `sol-workflow-browser-production.md` | E2E12 now proves GUI closure/replacement and durable approval waits. Typed non-slash schedule targets remain a possible later extension. |

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
| B01 | implemented/reviewed | `src/browser-worker/**`, `BrowserBroker.ts`, `BrowserSetupService.ts` | Browser daemon/drain/installer reviews plus `sol-browser-setup-composition.md` | Official catalog download on every supported OS/arch and headed packaged discovery are Q03/Q04 qualification. |
| B01a | implemented/reviewed | `src/main/browser/AttachedBrowserHost.ts`, `src/main/browser/automation/**`, `AttachedBrowserConnectionBackend.ts` | `sol-browser-attached-executor.md`; `sol-attached-browser-main-integration.md`; `sol-browser-command-transport.md`; **`sol-main-browser-e2e.md` on `78d55f3` / `ab68e66`** — `tests/platformMainBrowserE2E.test.ts` 1/1: native `browser_open`/`browser_act` through framed MMS + owning GUI connection into the **same** hidden webview; cookies retained; takeover/resume; **no managed fallback**; guest survives automation release; daemon count 0 | Do not replace this guest with managed Chromium. Hidden-window screenshots may be `screenshot-unavailable` by design. |
| B02 | implemented/reviewed | `src/browser-worker/observation/**` | `sol-browser-frames.md`; `tests/platformBrowserWorker.observation.test.ts` | Nested OOPIF / closed shadow remain explicit unsupported. |
| B03 | implemented/reviewed | `src/browser-worker/action/**` | `sol-browser-actions.md`; `tests/platformBrowserWorker.actions.test.ts` (real Chrome, uploads/downloads/takeover/crash recovery recorded in later combined 18-test runs) | Packaged/macOS/Linux headed: qualification. |
| B04 | implemented/reviewed | installer/update/rollback, process-tree, setup composition | `sol-browser-installer.md`; packaging/bounds tests; `sol-browser-setup-composition.md` | Packaged binary certification is Q04 qualification. |

### WG7 browser tools / viewer / adapters

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| M01 | implemented/reviewed | Browser session/router/tools, native binding, and profile-owned workflow Browser binding | Browser automation/routing/native reviews; `sol-workflow-browser-production.md`; main E2E | GUI and GUI workflows use the selected attached tab; non-GUI uses managed Chromium. Silent substitution is rejected. |
| M02 | implemented/reviewed | `BrowserPanel.tsx` (canonical tabs + `KeepMounted`), `BrowserAutomationViewer.tsx`, human handoff | `sol-browser-panel-lifetime.md` (22 lifetime checks + 11 `browserTabs.test.ts`); `sol-browser-viewer.md`; `sol-browser-human-handoff.md` (review recorded `16de106`) | Visible headed OS mouse/focus is qualification. Handoff observations are in-memory across daemon restart by design. |
| M03 | qualification-only / experimental | `src/mms/browser/modelAdapters/**` | `sol-browser-model-adapters.md` — 1 file / 5 tests + 19 combined; **no capability row is Available** | Provider-native schemas are **experimental**. Generic M01 tools are implemented; supported-model quality certification remains in required Q03 qualification. |

### WG8 qualification

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| Q01 | implemented/reviewed | `tests/fixtures/agent-platform/**`, `tests/fixtures/browser/**`, isolated Electron scripts (`test:orb`, `test:agent-editor`, `test:workflow-editor`, `test:profile-production`) | Those scripts and domain tests | Not a live-model harness. Sufficient for component gates. |
| Q02 | implemented; combined qualification active | Real MMS/Electron compound fixtures listed above | E2E03-12 accepted; E2E01/02 final verification | Current-source combined suite and remaining editor compound checks. |
| Q03 | implemented harness; qualification incomplete | `scripts/evaluation/browser/**`, `tests/fixtures/browser/evaluation/**` | `9969523`, 16 focused tests, full-catalog report; `sol-browser-evaluation.md` | Live-model quality, actual external benchmark environment, visual model ablations, stable confidence/performance targets. Required gate, not optional. |
| Q04 | partial qualification | Portable Windows/Linux qualification harnesses and operator docs | Windows directory package 17/17; Linux Node/native/migration plus both AppImage builds | Current-source artifact matrix, Linux certified Chrome and packaged Electron PTY, installer/upgrade, live Plus contract interoperability. |

## User-original required vs optional/experimental vs qualification

**User-original required (architecture §1.1 AW/PR/IN/BR):** file-backed workflows; `/name` in app and CLI; instructions + revision-pinned scripts; Agents/Workflows subtabs; Agent Editor with orb; visual workflow editor; multi-profile personal ownership; shared providers/models; Add skill create/upload and MCP connect; Mousse-owned browser on the **existing in-app Electron guest** plus managed CLI/headless.

**Present in the integrated source for those required paths:** Agents/Workflows workspace, orb+editor, canvas/source/run panel, GUI/CLI slash receipts, profile host + partitions, Settings Add skill/upload/Add MCP, attached-tab E2E with no managed fallback, managed setup for CLI/headless.

**Optional / experimental / fail-closed (do not expand scope):** OS sandboxed scripts; M03 provider-native adapters; persistent native-agent browser workspaces; vision/B2 coordinate tools as a second loop; macOS advertised packaging; workflow marketplace/cloud runner; live external CLI grant fidelity beyond capability reports.

**Release qualification (not missing product source):** packaged app, live Plus/OAuth/channel servers, two-instance GUI, visible headed OS input, final combined E2E-01..12 run, Linux install matrix, operator doc refresh.

## Remaining work and product boundaries

1. Finish E2E01/02 compound editor verification and the current original-checkout combined typecheck/build/suite. Review source corrections before merging them.
2. Refresh current-source Windows package evidence. Linux evidence currently proves Node CLI/native behavior and AppImage construction; certified Linux Chrome, packaged Electron daemon/native ABI, installation/upgrade, and visible desktop acceptance remain unqualified.
3. Q03 requires model/environment qualification beyond local scripted executor conformance. Preserve unsupported rows and complete failure traces. Provider-native adapters remain Experimental; local fixture results must never become a live-model certification claim.
4. Live Plus/OAuth/channel compatibility must use the actual available server/account contract. Local fixtures establish isolation and lifecycle behavior, not remote interoperability.

The editor Try Run uses a scratch workspace; selecting arbitrary projects and public fine-grained preview cancellation remain unavailable. Sandboxed scripts fail closed because no OS sandbox backend is installed. Persistent Agent memory and third-party CLI grant fidelity beyond capability reports remain explicit limits. Native workflow Agent nodes now use real isolated Git worktrees when mutating; this is distinct from editor Try Run.

The root-owned Liquid Glass Orb is implemented and reviewed. GUI browser automation uses the existing in-app Electron guest; substituting managed Chrome is forbidden. CLI/background automation uses managed Chrome after explicit setup. Profiles own personal state while provider credentials and the model catalog remain installation-shared.

Earlier gate checkboxes in the delivery ledger are historical. This audit does not close G7 until the exact candidate's required evidence is recorded.
