# Final requirement audit — merged core `3fc2f1c`

Audit date: 2026-09-11  
Reviewed checkout: `3fc2f1c` (`feat/platform-core`, merged implementation baseline)
Latest commit: `Merge reviewed background workflow recovery`
Documents used: `docs/agents-workflows-profiles-browser-architecture.md`, `docs/parallel-worktree-implementation-plan.md`  
Not used as missing-code evidence: `docs/implementation/agent-platform/status.md` (historical; only G0 boxes were kept current)

This audit maps every F/P/U/A/W/V/I/B/M/Q package to production source in this SHA, the strongest reviewed evidence, and any remaining product or qualification limit. It does not claim G1–G7 closed. `status.md` unchecked boxes are not treated as absent implementations.

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
| implemented/reviewed | Production source is composed in this SHA; a named Sol review plus focused tests exist. Remaining work is not a missing implementation. |
| partially implemented | Production source exists, but a named required behavior is still incomplete in this SHA. |
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

| Pkg | Class | Production source (this SHA) | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| F00 | implemented/reviewed | Integration baseline + this core SHA | G0: clean typecheck, 125 files / 857 tests, app+CLI build (recorded in `status.md` historical G0; do not treat later boxes as current) | None for code. Original master dirty `package.json` / lock / vitest / worktree test remain excluded and must be reconciled later, not overwritten. |
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
| W03 | implemented/reviewed | `WorkflowInvocationResolver.ts`, `MmsWorkflowChatBridge.ts`, GUI/CLI slash, graph nodes (loops/join/subworkflow/error/wait) | `sol-workflow-cli-slash.md` — 6 files / 71 tests including built CLI children (`platformWorkflowCli`, `threadMessageQueue`, `cliSessionCommands`, `cliLaunch`, `protocolValidation`, `platformWorkflowInvocation`) | Renderer chat interaction is typecheck/build only. Busy one-shot CLI reports queued acceptance and exits (`sol-workflow-cli-slash.md`). Completion/argument forms and run cards are UX remaining, not missing admission. |
| W04 | implemented/reviewed | Channel/control lifecycle, resumable channel/schedule slash ingress, and composed `MmsWorkflowBrowser` | `sol-channel-control-lifecycle.md`; `sol-workflow-background-ingress.md`; `sol-workflow-browser-production.md` | Typed non-slash schedule targets are a possible later product extension. Combined scheduled-browser shutdown evidence is qualification. |

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
| M03 | qualification-only / experimental | `src/mms/browser/modelAdapters/**` | `sol-browser-model-adapters.md` — 1 file / 5 tests + 19 combined; **no capability row is Available** | Provider-native schemas are **experimental**. Generic M01 tools are the required product path. Do not block release on BrowserGym or paid-model rows. |

### WG8 qualification

| Pkg | Class | Production source | Strongest evidence | Remaining requirement |
|---|---|---|---|---|
| Q01 | implemented/reviewed | `tests/fixtures/agent-platform/**`, `tests/fixtures/browser/**`, isolated Electron scripts (`test:orb`, `test:agent-editor`, `test:workflow-editor`, `test:profile-production`) | Those scripts and domain tests | Not a live-model harness. Sufficient for component gates. |
| Q02 | qualification-only | Cross-feature tests exist as separate suites | Many named reviews above; merged core `3fc2f1c` | Final combined-suite result on the dependency overlay is pending. Do not re-audit by checkbox. |
| Q03 | qualification-only (not started) | Local Chrome action/observation fixtures exist; **no BrowserGym adapter source** | Architecture §10.10 / plan Q03; `sol-browser-model-adapters.md` | BR-02 evaluation job. Not a user-visible editor/runtime feature. Optional/experimental vs shipping generic browser tools. |
| Q04 | qualification-only | Desktop/CLI build paths and usage/support documentation exist | Repeated reviewed builds plus `usage-and-support.md` | Windows/Linux packaged install, upgrade/migration, missing-browser, and live Plus server qualification. G7. |

## User-original required vs optional/experimental vs qualification

**User-original required (architecture §1.1 AW/PR/IN/BR):** file-backed workflows; `/name` in app and CLI; instructions + revision-pinned scripts; Agents/Workflows subtabs; Agent Editor with orb; visual workflow editor; multi-profile personal ownership; shared providers/models; Add skill create/upload and MCP connect; Mousse-owned browser on the **existing in-app Electron guest** plus managed CLI/headless.

**Present in this SHA for those required paths:** Agents/Workflows workspace, orb+editor, canvas/source/run panel, GUI/CLI slash receipts, profile host + partitions, Settings Add skill/upload/Add MCP, attached-tab E2E with no managed fallback, managed setup for CLI/headless.

**Optional / experimental / fail-closed (do not expand scope):** OS sandboxed scripts; M03 provider-native adapters; BrowserGym/WebArena leaderboards; persistent native-agent browser workspaces; vision/B2 coordinate tools as a second loop; macOS advertised packaging; workflow marketplace/cloud runner; live external CLI grant fidelity beyond capability reports.

**Release qualification (not missing product source):** packaged app, live Plus/OAuth/channel servers, two-instance GUI, visible headed OS input, combined E2E-01..12, Linux install matrix, operator doc refresh.

## Remaining work

The seven previously named implementation items are merged and fixed. Remaining work is bounded qualification or an explicitly documented product limit:

1. **Combined release qualification:** run the repository suite, typechecks, app/CLI builds, and selected cross-feature Electron/browser fixtures on the final dependency overlay. Green focused reviews establish behavior; this combined run establishes the release candidate.
2. **Packaged and environment qualification:** packaged Windows/Linux install and upgrade, two concurrent GUI instances, live Plus/OAuth/channel interoperability, and visible headed OS input. These are environment gates, not absent production paths.
3. **CLI queued acceptance:** when a busy-thread slash invocation is durably queued, the one-shot CLI may print the stable request ID and exit. The accepted run remains observable/cancellable by that ID. Waiting in the same process is a future CLI UX extension, not a missing workflow admission requirement.
4. **Agent Try Run:** editor Try Run intentionally uses its documented scratch workspace and has no public per-run list/cancel RPC. Runtime capability reporting and host-wide drain remain honest. Selected-project Try Run and fine-grained public control are future product extensions, not missing original Agent Editor/runtime requirements.
5. **Experimental rows:** OS sandbox execution, provider-native browser adapters, BrowserGym/WebArena, and installed third-party CLI fidelity beyond fail-closed capability reports remain optional or experimental as documented.

## Explicit non-blockers

- Liquid Glass Orb: implemented and reviewed; root-owned; this audit must not change it.
- Managed Chromium as a substitute for the in-app tab: forbidden; already proven not to occur on the main E2E path.
- `status.md` empty G1–G7 / F01–Q04 boxes: stale ledger, not missing code.
- Live provider, live Plus, live Discord/Telegram, BrowserGym, packaged Windows/Linux: qualification or experimental.
- Materialization crash-cleanup durability and hostile-filesystem races: documented limits, not new packages.

Root finish path: reconcile the user dependency overlay and finish the combined qualification on the integrated SHA. No further implementation merge from the seven audited items is pending.
