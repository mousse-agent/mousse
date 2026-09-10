# Mousse Parallel AI Workgroup Implementation Plan

## 1. Delivery objective

Implement the [Agents, Workflows, Profiles, Integrations, and Browser Use architecture](agents-workflows-profiles-browser-architecture.md) through bounded AI workgroups working in separate Git worktrees. This plan specifies execution order, branch ownership, shared contracts, acceptance evidence, integration rules, and recovery from stalled or conflicting work.

The plan is for implementation work, not permission to execute arbitrary user workflows or publish a release. The two planning documents do not create implementation worktrees, change application behavior, or deploy anything. The coding phase starts from a coordinator-recorded integration baseline.

The inspected baseline is **205fab2d3799b347f8709a32b4352933d68d83e0** with existing working-tree changes. Source files, not older architecture prose alone, establish the baseline. The current package requires Node **>=22.19.0**. Existing source supports daemon-owned execution, local clients, threads/worktrees, integrations, scheduling/channels, and Plus/control, but not the proposed workflow engine or profile ownership.

Navigation: [Workgroups/worktrees](#2-workgroups-and-worktree-topology) · [Contracts/gates](#3-contract-first-milestones) · [Work packages](#4-bounded-work-packages) · [Parallel schedule](#5-three-worker-parallel-execution-schedule) · [Testing](#6-acceptance-and-testing-strategy) · [AI handoffs](#7-coordination-artifacts-and-worker-instructions) · [Merge/cleanup](#8-merge-queue-conflict-handling-and-worktree-lifecycle) · [Risks](#9-risks-and-explicit-contingency-paths) · [Traceability](#10-requirement-to-package-traceability) · [Release checklist](#11-final-release-candidate-checklist).

### 1.1 Success criteria

The final release must satisfy AW-01 through AW-06, PR-01/PR-02, IN-01, and BR-01/BR-02 in the architecture document. In practical terms:

- App and CLI run the same revision-pinned workflow through **/name**, including stored executable scripts, user agents, branching, loops, parallel joins, durable waits, and recovery.
- Agents and Workflows have the specified library/editor experiences; the agent prompt reuses the extracted Source/Preview Markdown editor and the liquid glass orb has fixed-left/scrolling-right desktop layout.
- All personal resources and background activity are profile-scoped, including Plus/control, browser storage, caches, events, integrations, and drafts; providers/models remain shared.
- A user can create/upload a Skill or connect an MCP server and immediately use the exact enabled integration from the main agent and supported child agents.
- Mousse's own browser worker passes executor, model-adapter, isolation, recovery, and packaging gates in app and CLI.

### 1.2 Delivery model

Use one coordinating/integration agent plus **up to three active implementation agents** by default. Workgroups are durable logical owners, not a requirement to keep nine agents running at once. A workgroup can be resumed with a new bounded task after its earlier package merges.

With more capacity, the same dependency graph permits additional workers. Never increase parallelism by assigning two agents the same mutable file or by allowing feature workers to invent separate contracts. With less capacity, keep the coordinator role and serialize packages in topological order.

Use small reviewable vertical slices. Most work packages should produce two to four focused commits/PRs; high-risk migration/browser packages should expose an early fixture-backed proof before broader integration. AI elapsed-time estimates are not reliable release dates. Re-estimate after the foundation and first end-to-end workflow/browser slices using observed throughput and review load.

## 2. Workgroups and worktree topology

### 2.1 Logical workgroups

| Group | Role | Branch prefix / worktree | Primary ownership |
|---|---|---|---|
| WG0 | Coordinator, contracts, integration | **feat/platform-integration**, **integration/** | Shared contracts, composition/bridge registrations, dependency manifests, merge queue, release gates. |
| WG1 | Profiles and migration | **feat/platform-profiles**, **profiles/** | Profile services/paths/migration, profile UI/state controller, account/control ownership. |
| WG2 | Agents and shared editor | **feat/platform-agents**, **agents/** | Markdown editor extraction, agent registry/resolver/editor/orb, model settings adapter. |
| WG3 | Workflow format and runtime | **feat/platform-workflow-runtime**, **workflow-runtime/** | Format compiler, registry, execution engine, node runners, run journal, workflow ingress module. |
| WG4 | Workflow Editor | **feat/platform-workflow-editor**, **workflow-editor/** | Canvas, palette, inspector, Source view, validation/run presentation, accessible outline. |
| WG5 | Skills and MCP | **feat/platform-integrations**, **integrations/** | Existing MCP/Skills implementation, managed CRUD/import, integration UX, CLI materialization. |
| WG6 | Browser worker and executor | **feat/platform-browser-core**, **browser-core/** | CDP/Chromium lifecycle, observations, refs, actionability, execution, recovery. |
| WG7 | Browser model adapters and viewer | **feat/platform-browser-experience**, **browser-experience/** | MMS browser orchestration, provider adapters, viewer, human takeover, browser tools. |
| WG8 | Evaluation, fault testing, packaging | **feat/platform-validation**, **validation/** | Shared fixture harness, cross-feature E2E, adversarial/fault suites, release evidence. |

Create only the worktrees needed for active work and near-term handoffs. Each worktree has its own branch, node_modules, build outputs, runtime home, browser data, and fixture repositories. Workers share Git object history but not runtime data.

### 2.2 Mandatory file ownership

| Files / areas | Single owner | Coordination rule |
|---|---|---|
| package.json, package-lock.json, TypeScript/Vite/Vitest config | WG0 | Workers request a dependency/test-harness change with justification; WG0 updates once and publishes the commit. |
| src/shared/types.ts, settings.ts, channelCommands.ts, controlTypes.ts | WG0 | New domain types live in domain modules; WG0 owns aggregate exports and legacy compatibility. |
| src/shared/profiles, agents, workflows, integrations, browser contracts | WG0 after domain review | Domain worker proposes the contract; once frozen, changes require an explicit contract revision. |
| src/mms/MousseMainService.ts | WG0 | Domain workers provide constructors/registration functions; WG0 composes them. |
| src/mms/protocol/types.ts, validators.ts, handlers.ts, server.ts, eventRing.ts, client.ts | WG0 | Add domain validators/handlers through registered modules. Profile event/protocol changes land before enabling multi-profile execution. |
| src/main/ipc/registerGuiIpc.ts, src/preload/index.ts, protocolEventBridge.ts | WG0 | Feature workers deliver adapter functions and exact insertion requests. |
| src/renderer/App.tsx, stores/appStore.ts, top-level view routing | WG0 | WG1 supplies switch/state adapters; WG2/WG4 supply workspace views. |
| SettingsPage.tsx | WG0 | Extract integration sections once, then WG5 owns the extracted files. No parallel monolith edits. |
| src/renderer/styles/app.css and global.css | WG0 | Features use scoped styles; shared token changes use a small coordinated patch. |
| FilesPanel.tsx and new MarkdownDocumentEditor | WG2 for extraction package | Extraction merges before other editors consume it; no separate copies. |
| src/mms/data and config stores | WG1 during path-injection window | WG0 agrees exact files; other workers defer constructor/config changes until the profile paths commit lands. |
| src/mms/integrations/** | WG5 | WG1 provides paths/context contract; WG5 applies it internally. |
| src/mms/orchestrator/LlmClient.ts and OrchestratorService.ts | WG0 | WG2/WG3/WG5/WG7 implement domain dispatcher functions; only coordinator performs shared loop/ingress surgery. |
| src/mms/scheduled and channels | WG3 for typed workflow targets after profile foundation | WG1 supplies routing context; WG0 resolves any shared constructor conflicts. |
| src/mms/control/** and profile-facing ConnectionsSection | WG1 | Contract/bridge exports remain WG0-owned; coordinate external-server dependencies explicitly. |
| BrowserPanel.tsx | WG7 after WG1 partition patch | WG1 first lands isolated partition lifecycle change; WG7 then owns viewer adaptation. |
| BrowserViewManager.ts and browserPolicy.ts | WG1 for profile partitioning, then WG7 for optional adapter | Ownership transfers at a recorded merge commit, never simultaneously. |
| tests/** | Feature owner for new domain-prefixed files; WG8 for shared fixtures/E2E | Existing test files get an explicit owner if two packages need edits. |

File ownership is enforced through a coordinator ledger and changed-path checks before merge. It is not a request to avoid necessary work: workers can propose patches to owned hotspots, but the current owner applies/integrates them.

### 2.3 Worktree creation runbook

These are PowerShell commands to execute during the coding phase. First capture the baseline without modifying the current checkout:

~~~powershell
$MousseRepo = (Resolve-Path 'C:\Users\bubbl\Documents\Projects\RYSPA\mousse').Path
$MousseBase = (git -C $MousseRepo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve Mousse baseline' }
git -C $MousseRepo status --short
git -C $MousseRepo worktree list --porcelain
$MousseWorktrees = Join-Path (Split-Path $MousseRepo -Parent) 'mousse-platform-worktrees'
New-Item -ItemType Directory -Path $MousseWorktrees -Force | Out-Null
$MousseIntegration = Join-Path $MousseWorktrees 'integration'
git -C $MousseRepo worktree add -b feat/platform-integration $MousseIntegration $MousseBase
if ($LASTEXITCODE -ne 0) { throw 'Integration worktree creation failed' }
~~~

The coordinator records whether existing uncommitted work is intentionally excluded or has been integrated through its own reviewed commit. Never stash, commit, reset, clean, or overwrite another person's working changes automatically. The documents themselves must be available in the integration baseline or copied as reviewed documentation commits before worker dispatch.

After the required contract/foundation commit has merged, create a worker from the integration branch's current recorded SHA:

~~~powershell
$MousseContractBase = (git -C $MousseIntegration rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve integration revision' }
$MousseWorker = Join-Path $MousseWorktrees 'workflow-runtime'
git -C $MousseRepo worktree add -b feat/platform-workflow-runtime $MousseWorker $MousseContractBase
if ($LASTEXITCODE -ne 0) { throw 'Worker worktree creation failed' }
git -C $MousseWorker status --short
~~~

Use a unique suffix if a branch/worktree already exists; inspect and resume an existing owned worktree instead of using **-B** or force. Git's worktree model permits concurrent branch checkouts with separate working state; lifecycle operations should use Git's own worktree commands. [Git worktree documentation](https://git-scm.com/docs/git-worktree)

### 2.4 Runtime isolation for implementation

In each worker shell, set a unique runtime home before running Mousse:

~~~powershell
$MousseWorkerHome = Join-Path $MousseWorktrees 'runtime\workflow-runtime'
New-Item -ItemType Directory -Path $MousseWorkerHome -Force | Out-Null
$env:MOUSSE_HOME = $MousseWorkerHome
Set-Location -LiteralPath $MousseWorker
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Baseline typecheck failed' }
~~~

The variable is per worker process. This development isolation does not justify switching a production daemon's MOUSSE_HOME to select a profile.

Do not use the user's normal **~/.mousse**, real Plus account, production bot token, ordinary browser profile, or primary coding repository as a test fixture. Create disposable fixture repositories under that worker's runtime/test area. Mock providers are the default for automated tests; live provider evaluations are a separately budgeted test job with dedicated credentials.

The current dev script supports MOUSSE_HOME, but no dedicated per-worktree GUI port/userData setting is established by this plan. WG0 must implement and verify those overrides in F03 before concurrent GUI sessions. Until then, allow only one GUI development session at a time; daemon/unit work can remain parallel. Isolate Electron userData/localStorage as well as MMS home or profile-switch tests will interfere across worktrees.

Never share node_modules between worktrees: native modules and postinstall/build scripts can change their contents. Browser binaries may use a verified immutable shared cache; browser user-data directories, downloads, and debug channels are per worker.

## 3. Contract-first milestones

### 3.1 Contracts that unblock parallel work

| Contract | Producer / reviewers | Minimum frozen content | Consumers |
|---|---|---|---|
| C1 Profile context | WG0 + WG1 | IDs, path accessors, binding/epoch, installation/profile settings classification, event ownership | All groups |
| C2 Definitions | WG0 + WG2/WG3 | Agent/workflow IDs/revisions, dependency refs, draft/publication semantics, registry interfaces | UI/runtime/integrations |
| C3 Workflow format | WG0 + WG3/WG4 | Schema, node types/ports, binding AST, compiler diagnostics, semantic vs visual revisions | Editor/runtime/CLI |
| C4 Execution policy | WG0 + WG3/WG5/WG7 | Actor/grant resolution, effect classes, durable approvals, budgets/cancellation/artifacts | Every executor |
| C5 Integrations | WG0 + WG5 | Managed installation identity, connection state, public redacted DTO, effective actor grants | Agent/workflow editors/runtime |
| C6 Browser | WG0 + WG6/WG7 | Session/lease/generation, observation/ref/action/result, worker broker and artifact protocol | Browser core/adapters/viewer |
| C7 Protocol/UI bridge | WG0 | Methods/validators/events, capability negotiation, optimistic concurrency, errors | All clients |
| C8 Validation harness | WG8 + WG0 | Isolated fixture home, fake clock, fault points, mock tools/provider/browser, evidence format | All groups |

A contract is frozen when a concrete type/schema file, fixture vector, validation behavior, and owner are merged. A meeting note or prose-only interface is not enough. Initial implementations can use deterministic fakes behind these contracts; they may not ship fake success through a production path.

### 3.2 Milestone gates

| Gate | Meaning | Required evidence |
|---|---|---|
| G0 Baseline | Reproducible base and clean integration worktree | Recorded SHA/dirty inventory, baseline typecheck/test/build results, owner ledger. |
| G1 Foundations | Domain seams and common contracts usable | C1–C8 initial contracts, shared editor extraction, profile path fakes, test/dev isolation. |
| G2 Ownership | Profile identity enforced before feature enablement | A/B service/protocol/event/storage tests; shared providers and repository locking; migration dry-run/recovery fixtures. |
| G3 First workflow slice | Stored code + main/user agent works in app/CLI | Import/publish/slash/run/trace/cancel vertical slice with pinned revision and structured result. |
| G4 Creation UX | Editors and Add flows work end to end | Agent orb/editor, core workflow canvas/source, skill creation/upload, anonymous/OAuth/stdio MCP journeys. |
| G5 Browser alpha | Mousse-owned executor works with generic model tools | Managed Chromium app/CLI run, structure/vision, refs, verified actions, takeover, isolation. |
| G6 Full automation | Full workflow catalog and background recovery | Loops/joins/subworkflow/waits/errors, typed schedules/channels, browser nodes, crash and unknown-effect handling. |
| G7 Release candidate | Supported-platform product passes cross-feature gates | Packaged Windows/Linux evidence, Plus/profile compatibility, browser task metrics, no release-blocking defects. |

G2 is a prerequisite to turning on multiple profiles for users. Workers can develop under a single-profile adapter before G2, but no feature merges a new global personal-state cache.

### 3.3 Dependency graph

~~~mermaid
flowchart TD
  F["F00-F03: baseline, contracts, seams, isolated harness"]
  P["P01-P02: profile paths, stores, migration"]
  A["A01-A02: definitions and Agent Editor"]
  W1["W01: workflow format/compiler"]
  W2["W02: core engine and scripts"]
  W3["W03-W04: ingress, full nodes, background recovery"]
  V["V01-V03: canvas/source/debugger"]
  I["I01-I04: integration reliability and Add flows"]
  B1["B01: managed browser/transport"]
  B2["B02-B03: observations/actions/recovery"]
  M["M01-M03: browser tools/adapters/viewer"]
  P3["P03-P04: switch, Plus/control, full migration audit"]
  Q["Q01-Q04: end-to-end qualification"]
  F --> P
  F --> A
  F --> W1
  F --> I
  F --> B1
  W1 --> W2
  W1 --> V
  P --> P3
  P --> W2
  A --> W3
  W2 --> W3
  I --> W3
  B1 --> B2
  B2 --> M
  P --> M
  M --> W3
  V --> Q
  P3 --> Q
  W3 --> Q
  M --> Q
  I --> Q
~~~

The critical path is profile/contract foundations → core workflow/agent/integration execution → browser executor and model binding → cross-feature recovery and packaging. The graph editor can begin against compiler fixtures while the engine is being implemented. Browser transport can begin against C1/C6 fakes while profile migration progresses.

## 4. Bounded work packages

Each package has a concrete deliverable and a downstream handoff. “Review ready” means committed code at an exact SHA, tests/evidence, an ownership-clean diff, and no undocumented production stub.

### WG0: coordination and foundation

**F00 — Freeze baseline and dispatch ledger**

- Inspect AGENTS.md, source architecture, existing dirty files, active branches/worktrees, and runtime processes. Preserve the user's changes.
- Record the selected base, package-lock provenance, Node/npm/Git versions, current test failures, and installed platform capabilities.
- Run baseline **npm run typecheck**, **npm test**, and **npm run build** once in the integration checkout after dependencies are available. Record failures by command/test; do not relabel new failures as pre-existing.
- Create the package/owner/dependency/evidence ledger described in section 7. Dispatch only independent work with explicit file boundaries.
- **Exit:** G0 evidence exists; workers can distinguish their regressions from the base.

**F01 — Shared contracts and domain registration seams**

- Publish C1–C7 initial DTOs, schemas, mock vectors, error types, artifact references, and revision preconditions.
- Add domain handler/tool registration seams around protocol dispatch and the large LlmClient dispatcher without changing existing behavior.
- Preserve normal CLI/Electron as clients and the one MMS owner rule. Make context required at new execution boundaries.
- Add negative vectors for profile mismatch, unknown fields, oversized payloads, forged resource IDs, stale revisions, and absent capabilities.
- **Depends on:** F00; domain review can run concurrently. **Exit:** G1 contract portion; feature workers compile against real imports.

**F02 — UI/module extraction and shared dependency ownership**

- Integrate WG2's U01 Markdown editor extraction; improve shared TabBar semantics where needed.
- Extract Skills/MCP settings sections to WG5-owned feature files without redesigning them yet.
- Add the proposed Integrations settings navigation grouping and redirect existing Tools/Skills entry points; leave detailed section UX to WG5.
- Add lazy feature routing and registration points for AgentsWorkspace, WorkflowEditor, profile switch controller, and browser viewer.
- Choose/pin schema parser/validator, YAML parser, archive handling, React Flow, and dev-only UI harness dependencies after focused compatibility checks. Record licenses and production/dev classification.
- **Exit:** existing UI behavior passes regression checks; each feature has a clean editing boundary.

**F03 — Isolated development and evaluation infrastructure**

- Add/verify per-worktree Electron userData and renderer-port overrides, strict port collision behavior, isolated MMS home, and browser debug/artifact roots.
- Integrate C8 fixture/bootstrap support and dedicated UI/E2E runner/config. Existing Vitest's Node **tests/**/*.test.ts** setup alone is not an interactive browser/editor test harness.
- Keep ordinary builds/tests deterministic; live model calls and browser binary downloads do not happen implicitly in unit tests.
- **Exit:** two independent app/daemon instances on test data cannot share cookies/localStorage/sockets; worker runbook commands verified.

**F04 — Ongoing integration and release control**

- Own shared registration edits, contract revisions, dependency upgrades, merge queue, cross-domain fixes, and gate evidence.
- Recheck architectural isolation after shared-loop/bridge changes. Never accept “frontend connected to a mock” as completion of a runtime feature.
- Publish feature flag states and compatibility constraints for every integration candidate.
- **Exit:** G7 satisfied and a reviewable release candidate exists; actual publishing follows the project's release authorization.

### WG1: profiles

**P01 — Inject installation/profile paths and compose runtimes**

- Replace ambient/mutable home reads and module-import-time auth paths with InstallationPaths/ProfilePaths and explicit service construction.
- Classify every config key; keep provider catalog/credentials/MMS infrastructure shared. Make default model, favorites, engine preferences, integrations, schedules/channels personal.
- Audit modeRegistry, question services, dev-GUI bridge state, thread maps, caches, and constructors. Fix ModeRegistry roots that bypass MOUSSE_HOME.
- Keep existing ThreadStorageLayout/generations/journals/trash/queue locks; add a profile root parameter rather than rewriting persistence formats.
- Preserve installation owner/discovery records and endpoint identity during profile migration; an endpoint relocation requires explicit dual-path fencing and is unnecessary for this feature.
- **Depends on:** C1/F01. **Evidence:** simultaneous A/B calls and background tasks use correct stores; shared provider object/catalog and repository leases remain shared.
- **Handoff:** ProfileRuntime factory, path map, constructor migration instructions, and scoped test harness to all groups.

**P02 — Transactional migration and ownership validation**

- Implement dry-run inventory, Default creation, staged copy/re-encryption, verification, manifest commit, and resumable migration journal.
- Map real legacy paths, including **thread-data/standalone**, **thread-data/repositories**, legacy project **.mousse/.data**, control, scheduled runtime, integration OAuth, and browser partition data.
- Treat Git worktrees with Git-aware move/repair or retain an explicitly owned legacy path; verify registrations and cleanliness.
- Decrypt Plus credentials at the old location and re-encrypt for the new storage namespace before retiring the source: current ControlStore key derivation includes its control directory path, so copying credentials.enc to a new directory can make it unreadable.
- Implement profile ID/resource ownership checks in domain stores; WG0 wires protocol filtering and handshake.
- **Evidence:** crash at every migration boundary, disk-full, repeated migration, unknown config fields, bad credentials, and old-client behavior.
- **Handoff:** G2 migration fixtures, rollback instructions, exact authoritative path map.

**P03 — Switcher, renderer state, and Plus/control ownership**

- Build create/switch/edit/archive profile UX, immutable connection binding, selection epoch, draft flush, cache reset, rehydration, and snapshot/subscription handoff.
- Namespace appStore persistence, modelFavorites, quickActions, panel sizing, theme state, and editor drafts; update auxiliary AgentsTasks window.
- Assign legacy webview and WebContentsView storage only to Default and then transfer BrowserPanel ownership to WG7.
- Split physical installation/device identity from Plus account credentials, profile registration/grants, pairings, and relay sessions. Verify the actual hosted/self-hosted server contract; add a capability gate or explicit re-pairing path when required.
- Remove implicit production fallback credentials/transactions in desktop and CLI authentication. Validate server responses, preserve failed/offline status, and require actual enrollment acknowledgment before reporting enrollment; mock success uses an injected test adapter or explicit development-only mode.
- **Depends on:** P01/P02, F02, C7. **Evidence:** A→B switch during late events, pending approvals, active terminal/browser, failed switch, logout, and duplicate account identities.
- **Handoff:** profile browser-partition adapter and source-file ownership transfer to WG7.

**P04 — Background services, deletion, and isolation audit**

- Coordinate immutable scheduler/channel/control ingress context with W04. Define duplicate bot credential handling and profile-specific routes on shared listeners.
- Add profile pause/archive/trash/restore; stop owned work before deletion and retain shared provider/repository data.
- Audit logs, artifact reads, exported diagnostics, searches, pagination, notifications, event replay, command IDs, and legacy protocol clients for leaks.
- Verify same-repository cross-profile mutation fencing and post-migration recovery with WG8.
- **Exit:** PR-01/PR-02 and E2E-05/06/07/11 pass; no unscoped personal singleton remains in supported paths.

### WG2: shared editor and agents

**U01 — Extract the existing Markdown editor**

- Extract controlled Monaco Source/Preview editing from FilesPanel; keep DocumentPanel's read-only behavior deliberate.
- Preserve source bytes, selections/drafts, theme handling, GFM/highlight preview, safe link/image handling, resize, focus, and read-only support.
- Expose validation/variable-completion props without embedding daemon calls in the component.
- **Can start after:** F00 using agreed component props. **Evidence:** source→preview→source exact preservation, file editor regression, keyboard/focus and theme checks.
- **Handoff:** merged component/example fixture consumed by agent, skill, and workflow editors.

**A01 — Definition registry and runtime resolver**

- Implement agent bundle schema, stable ID/slug, draft/publish/revision/archive/import/export, visual versus execution revision, and optimistic concurrency.
- Implement model reference/capability adapter and effective-context compilation; resolve skill/MCP dependencies through C5.
- Preserve runtime AgentRegistry semantics and existing CLI engine IDs. Introduce a definition resolver invoked through existing native/CLI execution adapters.
- Keep Markdown modes separate; add explicit create-from-mode copy after profile scoping.
- **Depends on:** C1/C2/C4/C5 and P01 path contract; fake integration resolver allowed during development.
- **Evidence:** pinned running definition, unsupported CLI settings, model removal, dependency failure, cross-profile definition lookup.

**A02 — Agent library, editor, and orb**

- Build library search/filter/favorites/create/duplicate/archive, definition details, and active-run links.
- Build the specified 50/50 desktop editor: fixed orb panel with palette carousel arrows; independently scrolling rich settings form.
- Implement named/custom palettes, deterministic visual metadata, reduced motion, high contrast, hidden-view suspension, and responsive narrow layout.
- Reuse ModelFamilyMenu/SettingsFields and U01; cover all settings groups from architecture section 5.3 with capability-aware controls.
- **Evidence:** create/edit/restart/run journey, palette persistence, Source/Preview, keyboard navigation, dirty draft restoration, unsupported fields, layout at desktop/narrow/high-DPI sizes.
- **Handoff:** Agent node picker and read-only definition summary components for WG4.

**A03 — Native/CLI agent execution qualification**

- Wire definition revisions into AgentRun records, child prompts, effective grants, worktree policy, delegation limits, and parent budgets/cancellation.
- Test native Mousse end to end; publish explicit capability reports for Claude Code, Codex, OpenCode, and Cursor adapters instead of promising unsupported knobs.
- Verify orphan/cancel/restart behavior and current AgentsPanel/AgentsTasksView access.
- **Depends on:** A01/A02, I04, W02 execution hooks. **Exit:** AW-05 and the agent portion of AW-03/AW-06.

### WG3: workflow runtime

**W01 — Format, registry, compiler, and portable examples**

- Implement the complete v1 manifest/bundle contract, semantic/visual hashes, publication lock, file watchers, safe discovery/import/export, and revision preconditions.
- Implement node registry, ports, bounded binding/expression AST, schema validation, graph reachability/control/data-path checks, and explicit loop/subworkflow rules.
- Add valid fixtures for every node class and invalid fixtures for unsupported nodes, cycles, branch-output misuse, missing dependencies, traversal, and oversized graphs.
- Turn architecture section 6.3 into a fully executable example bundle, with staged file binding explicitly represented in node input metadata.
- **Depends on:** F01/C3 and C1 paths. **Handoff:** compiler/registry packages and diagnostic fixtures for WG4 and CLI; no renderer imports.

**W02 — Durable core engine, policy, artifacts, and ScriptRunner**

- Implement queued/running/waiting/terminal run state, node attempts, immutable results, journal/manifest commits, leases/fencing, budgets, cancellation, and status events.
- Implement Start/End, Script, Transform, Condition, main/user Agent, Tool/MCP, and Artifact nodes. Use fake runner contracts before real adapters merge, then replace fakes in the production composition.
- Implement the shared policy/approval/artifact services under C4; WG0 wires their registration. Approval answers persist with profile/action/revision/expiry binding.
- Implement direct Node script execution: immutable asset copy, staged inputs, argv, environment allowlist, structured stdout, bounded stderr/artifacts, abort/process-tree control.
- **Depends on:** W01/P01; requires A01/I01 for integrated node paths. **Evidence:** script bytes executed without model generation, restart at dispatch/commit boundaries, missing output, invalid JSON, timeout, duplicate start ID.
- **Handoff:** stable runner interfaces, run-store fixtures, and first vertical slice for G3.

**W03 — Unified command ingress and full graph control**

- Implement shared command tokenizer/catalog integration: dynamic workflow/skill names, reserved aliases, explicit /workflow and /skill namespaces, argument binding, literal slash, scope/version resolution.
- Supply GUI and CLI adapters; WG0 edits existing composer, OrchestratorChat, CLI session parser, and MMS send registration.
- Implement loops/map, Parallel/Join policies, Subworkflow, Try/Catch/Finally/Fail, delays/waits, and node-level repair/retry lineage.
- Prevent main-agent reentrant thread-lock acquisition; pin workflow resolution at acceptance, not after a queued command eventually runs.
- **Depends on:** W02, A01, C7. **Evidence:** app/CLI contract vectors, skill collisions, skipped branches, first-success cancellation, nested budgets, loop bounds, stable join order.

**W04 — Scheduler/channel/browser binding and unknown-effect recovery**

- Replace prompt-only scheduled execution with typed targets carrying profile/project/thread/revision/input/policy.
- Bind channel/control ingress before slash resolution, retain existing claims/heartbeat/fencing, and deduplicate trigger IDs.
- Add Browser node runners through M01; support durable human waits, wake-up deadlines, approvals, and resume after GUI disconnect.
- Implement unknown-effect reconciliation and explicit compensation lineage; integrate repository effects into existing thread undo/publish history without claiming external effects are undoable.
- **Depends on:** W03, P03, I03, M01/M02. **Exit:** full AW-01/02/03 runtime, G6, E2E-04/10/12.

### WG4: Workflow Editor

**V01 — Canvas and node/property editing**

- Build library list/detail navigation, blank/template creation, palette, typed custom nodes/ports, inspector, controls/minimap, and agent/MCP/skill pickers.
- Keep React Flow objects behind a Mousse-format adapter. Add node/edge via drag or keyboard; preserve IDs and stable semantic data.
- Implement core nodes first using W01 fixtures and actual compiler diagnostics; no bespoke frontend-only validation language.
- **Depends on:** F02, U01, C3/W01. **Evidence:** create graph→save→reload→compile, incompatible edge explanation, scoped library/dependency selection, keyboard outline.

**V02 — Source, versions, import/export, and complete catalog**

- Add Source editor with valid/invalid draft separation, schema diagnostics, asset tabs, binding picker, input form, publication history/diff, visual-only saves, and conflict handling.
- Add advanced loop/parallel/subworkflow/error/wait/browser inspectors and corresponding accessible outline controls.
- Import/export through registry APIs; show executable assets and missing dependencies. No runtime work occurs on import or dry-run.
- **Depends on:** V01/W03 and final node contracts. **Evidence:** canvas↔source↔bundle semantic roundtrip, unknown node preservation, malformed source recovery, multi-window save conflict.

**V03 — Run debugger and polish**

- Implement immutable execution overlay, run/node timelines, sanitized inputs/outputs, artifacts, child links, budget display, cancellation, approvals, and recovery/continue UI.
- Keep drafts independent of active runs, persist user layout, virtualize traces, and measure interaction at 250 nodes.
- Verify focus/tab semantics, reduced motion, high contrast, narrow windows, selection/zoom after navigation, and Source/Preview reuse.
- **Depends on:** W02/W04 events, M02 viewer links. **Exit:** AW-04/AW-06 and G4/G6 editor evidence.

### WG5: Skills and MCP

**I01 — Reproduce and fix runtime defects**

- Add targeted regression fixtures for native .mousse discovery/materialization mismatch, stale skills refresh, anonymous MCP OAuth gating, missing-server test success, connection identity collision, tool-name collision, and child/main grant mismatch.
- Implement profile/project/config/auth-aware connection keys, explicit actor resolution, cancellable calls with cleanup, and redacted public DTOs.
- Preserve MCP structured content, images/resource links, errors, pagination/list updates, and server lifecycle diagnostics.
- **Can start:** regression fixtures after F00; implementation after C1/C4/C5 and path ownership handoff.
- **Evidence:** each reproduced failure passes for the intended behavior; no accidental API fallback or hidden credential leak.

**I02 — Managed Skill lifecycle and editor**

- Add native profile/project roots, standards front-matter parser/schema, create/import folder/file/ZIP/Git, staged validation, revisions, update/archive/export, immediate cache invalidation, and provenance.
- Build prominent Add skill action and create/upload/editor/test flows using U01.
- Keep external discoveries read-only until explicitly copied. Validate archives and generated cleanup manifests.
- **Depends on:** I01/F02/U01/P01. **Evidence:** save→enable→invoke, upload nested resources, replacement during run, duplicate names, traversal/archive bomb, Git revision pinning.

**I03 — MCP Add/Connect/Inspect lifecycle**

- Add native Mousse config CRUD and wizard for stdio/Streamable HTTP/legacy SSE, None/static secret/OAuth, config import, test/list/enable, diagnostics, and deletion.
- Use SDK negotiation/OAuth flows with profile/resource binding, bounded callbacks, redirect validation, refresh/revoke, and secret references.
- Separate connection test from tool execution and distinguish connected-empty from missing server.
- **Depends on:** I01/F02/P01. **Evidence:** anonymous/OAuth/stdio fixture servers, cancel during connect/auth/call, token expiry, config edit/restart, static auth redaction.

**I04 — Agent materialization and compatibility**

- Materialize exactly the resolved profile/actor set for native Mousse and each supported external CLI convention.
- Verify generated configs use environment/secret references, do not overwrite unrelated files, and cleanup removes only owned files.
- Implement capability handling for optional MCP features and unknown skill fields; no silent authorizations from metadata.
- **Depends on:** I02/I03/A01. **Exit:** IN-01 with main/child app/CLI evidence and the full integration acceptance matrix.

### WG6: browser worker and executor

**B01 — Managed browser lifecycle and private transport**

- Build an Electron-free worker entrypoint, versioned broker, process ownership/fencing, certified Chromium resolver, isolated profile/workspace user data, and private CDP transport.
- Implement session/context/tab lifecycle, persistent workspace exclusive-writer lease, ephemeral defaults, child cleanup, and GUI-independent lifetime.
- Probe actual Chromium/CDP capabilities at startup; record binary version and protocol support. Return explicit unavailable status for unsupported transport/platform builds.
- Add Windows/Linux launch tests, browser crash/process cleanup fixtures, and offline/missing-binary handling. Do not add a third-party browser-agent runtime.
- **Depends on:** C1/C6/F03; profile path fake is sufficient initially.
- **Handoff:** BrowserBackend conformance fixture and managed worker usable by WG7 without a model.

**B02 — Observation pipeline and element references**

- Implement target/frame mapping, AX/DOM/layout collection, partial/inconsistent snapshot handling, visible semantic reduction, query/subtree observations, bounded pagination, and artifact screenshots.
- Maintain session/document/generation-scoped refs and semantic fingerprints; track rerender/navigation and invalidate accordingly.
- Support iframe/OOPIF and observable shadow-root cases, accessible names/form errors/dialogs, viewport/crop/DPI geometry, and redaction hooks.
- Keep raw CDP/HTML/JavaScript behind the worker boundary. Page content is data; it never becomes an MMS instruction.
- **Depends on:** B01. **Evidence:** stale refs, moving targets, detached frames, duplicate labels, truncation, high DPI/crop, visual-only fallback, profile cookie separation.

**B03 — Actionability, input, verification, and recovery**

- Implement typed navigation/click/fill/type/key/select/check/scroll/drag/upload/download/dialog actions.
- Validate control lease/ref/observation, check actionability/hit target, execute, wait for explicit postconditions, and return verified or uncertain outcomes.
- Add action journaling before dispatch, unknown-effect handling, cancellation/timeout settlement, no-progress limits, crash reconnection, and bounded recovery.
- Implement strict policy hooks for origin/redirect/file/network handling. Distinguish best-effort navigation filtering from an actual strict egress sandbox.
- **Depends on:** B02/C4. **Evidence:** local fixture end-state verifiers, no duplicate submit after lost acknowledgment, input cancellation, overlay handling, human lease fencing.
- **Handoff:** executor ready for B1/B2 generic model tool tests and workflow Browser runners.

**B04 — Platform hardening and advanced capability certification**

- Complete browser binary installation/update/rollback, owned process-tree lifecycle, strict sandbox/egress adapters where supported, and resource/retention limits.
- Evaluate optional Electron-attached backend only after managed backend gates; its GUI dependency must remain visible in capability results.
- Work with WG8 on packager/installer integration, which WG0 applies in shared build files.
- **Depends on:** B03 and packaged fixture feedback. **Exit:** BR-01 executor portion, supported-platform matrix, explicit unsupported cases.

### WG7: browser tools, model adapters, and viewer

**M01 — BrowserSessionManager and generic model tools**

- Implement MMS session orchestration, profile/run ownership, budget/cancellation linkage, observation artifacts, tool catalog and dispatcher adapter.
- Expose the small structured tool set with semantic refs and B1 capability gating; add B2 vision/coordinate use only with correct observation transforms.
- Integrate Browser workflow nodes and user-agent browser preferences through C2/C3/C4.
- Do not send raw provider credentials to the worker or make a GUI-owned model loop.
- **Depends on:** C6/B01 broker for development; B03 for release behavior, P01/I01/A01 contracts.
- **Evidence:** main-agent/child/workflow app and CLI runs against the same worker with same profile/authority.

**M02 — Viewer, takeover, trace, and manual browser migration**

- Adapt BrowserPanel after P03's ownership transfer; distinguish manual tabs and managed agent sessions.
- Implement watch, take control, pause/resume, session close, action history, sanitized artifact viewing, and run links.
- Fence human and agent input using lease generations; reobserve on resume; handle GUI close, headless wait, and reconnect.
- Scope existing browser IPC/partitions/clear-cookie controls to profile/workspace; WG0 applies bridge registration changes.
- **Depends on:** P03/M01/B03. **Evidence:** takeover during pending click, stale queued input, high-DPI hit mapping, reconnect, two profiles, auxiliary windows.

**M03 — Native adapters and supported model catalog**

- Implement independent adapter modules for supported provider-native schemas, each with request building, call decoding, ordered batch handling, result encoding, and continuation state.
- Verify actual installed SDK/endpoint support. Preserve required provider safety decisions and call IDs; stop a batch at approval/failure and do not execute later members.
- Publish B0/B1/B2/B3 capability records with exact model/adapter/browser revisions, test date, coordinate conventions, limitations, and Available/Experimental/Unavailable labels.
- Use official source pages from architecture section 10; pin schema/version fixtures at implementation time. A dated guide does not guarantee account/model access.
- **Depends on:** M01/B03; parallel adapter work is allowed only in separate provider files with the coordinator's explicit assignment.
- **Exit:** BR-01 supported-model experience and BR-02 adapter evaluation evidence.

### WG8: validation and release evidence

**Q01 — Shared fixture and UI harness**

- Build isolated homes/profiles/repos, fake clock/scheduler, mock provider/tool runners, MCP fixture servers, browser fixture sites, and durable fault-injection hooks.
- Implement deterministic end-state validators and structured run/evidence output; provide helper APIs without shipping test shortcuts in production.
- Add Electron/editor interactive tests in a separately configured harness and CDP/browser executor tests independent of live models.
- **Can start after:** F00 with C8 agreement; WG0 owns config/dependency changes.
- **Handoff:** reusable fixtures for every package, plus a minimal sample test and cleanup/ownership assertions.

**Q02 — Cross-feature ownership and recovery**

- Execute E2E-01 through E2E-12 from architecture section 11 with combined real services and fixture integrations.
- Inject faults around profile migration, journal writes, worker dispatch/result, scheduler claim/heartbeat, approval response, reconnect, and browser submission acknowledgment.
- Include mismatched-profile IDs, stale event cursors, artifact range reads, revoked grants, changed dependencies, old protocol clients, and same-repository concurrent mutations.
- **Depends on:** P02/P03, W02/W04, I03, M02. **Exit:** G2/G6 recovery and isolation evidence, failures assigned to owning group.

**Q03 — Browser evaluation and performance**

- Build reproducible structured-only, screenshot-only, and hybrid runs across the fixture suite; pin models/browser/tool schema/prompt/input seeds and per-run budgets.
- Integrate a BrowserGym or equivalent benchmark adapter under each benchmark's rules. Keep calibration tasks separate from held-out release tasks.
- Report success/confidence intervals, false success, duplicate effects, human interventions, latency, token/image cost, retry/recovery, and resources.
- Verify architecture section 10.10 targets and publish unsupported cases rather than optimizing only a vendor leaderboard metric.
- **Depends on:** B03/M01/M03. **Exit:** BR-02 evidence and supported-model certification recommendations.

**Q04 — Packaged acceptance and operator documentation**

- Test Windows desktop/CLI and Linux desktop/headless artifacts from the same candidate SHA, including clean install, upgrade/migration, missing browser, offline mode, native dependencies, and service startup/shutdown.
- Test profile-scoped Plus/control through the available server contract. If external compatibility is unavailable, document the exact blocked capability and keep it disabled; local profile work can still proceed.
- Update existing ARCHITECTURE, CONFIGURATION, CLI, STARTUP, and relevant troubleshooting documents to describe shipped behavior. Do not overwrite this design with unverified “complete” claims.
- Provide installation/migration recovery instructions, privacy/retention controls, browser diagnostics, model support matrix, and release notes.
- **Exit:** G7 candidate evidence; coordinator approves code integration and obtains any separately required release publication approval.

## 5. Three-worker parallel execution schedule

The schedule below is dependency-driven. A wave ends when its required handoffs merge, not after a fixed number of hours. The coordinator remains active on WG0/F04 in every wave. Workers can finish early and take another ready package; they do not edit a blocked consumer against an invented interface.

| Wave | Worker slot A | Worker slot B | Worker slot C | Coordinator output / gate |
|---|---|---|---|---|
| 0: baseline and seams | WG2 U01 shared Markdown editor | WG8 Q01 fixture/harness bootstrap | WG5 I01 regression reproductions only | F00/F01 contracts, F02 extraction/dependencies, F03 isolation; G0/G1. |
| 1: foundational engines | WG1 P01/P02 profile paths and staged migration | WG3 W01 format/compiler/registry | WG6 B01 managed browser/transport | Merge small path/contracts commits early; C1/C3/C6 fixtures stable. |
| 2: core services | WG1 P03 switcher/Plus and browser partition handoff | WG3 W02 engine/scripts/approvals | WG5 I01 fixes + I02/I03 managed Add flows | Protocol binding/filtering wired; G2 evidence; core run APIs integrated. |
| 3: creation and actuation | WG2 A01/A02 definitions/library/orb | WG4 V01 canvas against compiler/runtime fixtures | WG6 B02/B03 perception/actions | Integrate actual Agent/Tool runners into W02; G3 runtime prerequisites and G4 UI review. |
| 4: product integration | WG3 W03 commands/full graph control | WG7 M01/M02 browser tools/viewer | WG5 I04 CLI/native qualification | Wire slash paths/model dispatcher and pass G3; generic browser alpha G5. |
| 5: automation breadth | WG3 W04 schedules/channels/browser/recovery | WG4 V02/V03 source/full catalog/debugger | WG2 A03 delegation/CLI execution | Integrated G4/G6 scope; run targeted combined tests after each merge. |
| 6: hardening | WG1 P04 isolation/deletion/migration audit | WG6 B04 platform/sandbox hardening | WG7 M03 native adapters | Q02 fixture cases can be run by coordinator; ownership/compatibility defects triaged. |
| 7: release evidence | WG8 Q02/Q03/Q04 qualification | Highest-priority defect owner | Next independent defect owner | Exact-candidate typecheck/test/build/E2E/package matrix; G7. |

Wave 0's I01 assignment intentionally stops at reproduced defects in owned test files until path/context contracts are ready. Wave 1's B01 can use a profile path fake; it cannot enable production sessions before P01 integration. Wave 2's W02 can use an AgentRunner fake for engine tests; G3 waits for the real A01 adapter in wave 3 and the shared app/CLI command path in wave 4. G4's Source editor evidence follows V02 in wave 5.

W04 may begin scheduler/error-node work after W03 while M01/M02 finish, but its Browser runner portion waits for their merged contract implementation. V02 advanced node UI follows the W03 node schemas; source/version work may start earlier.

Q01 provides reusable test harnesses at the start. WG8's later qualification work is not the first time features are tested: every owning group runs its focused behavior tests and the coordinator runs combined gate checks throughout.

### 5.1 Ready queue and scheduling policy

The coordinator selects a package only when its contracts, required baseline commits, writable file ownership, test fixture availability, and acceptance condition are clear. Prefer work that unblocks two or more downstream groups, then complete vertical slices, then polish.

A worker waiting on a contract may implement agreed fixtures, test cases, pure helpers, or a read-only source audit within its scope. It must not create a competing schema or refactor another group's hotspot to stay busy.

Split a package further if its patch grows difficult to review or if it spans unrelated risk. For example, anonymous MCP support and structured MCP result preservation can be separate I01 commits; browser process launch and DOM reduction must be separate B01/B02 commits.

### 5.2 Suggested integration sequence

Use this ordering for shared changes even if workers finish out of order:

1. Baseline/dependencies → domain contracts and handler seams → shared editor/settings extraction.
2. Path injection and installation/profile settings split → service/resource ownership → protocol binding/events.
3. Agent/workflow/integration registries → direct script engine → actual agent/tool node adapters.
4. Slash app/CLI resolver → workflow library/editor → run cards and durable approvals.
5. Browser process/observations/actions → tools/viewer/adapter → workflow browser nodes.
6. Typed schedules/channels/control routing → full recovery/migration → packaging/evaluation.

Do not merge a UI toggle that exposes an unimplemented backend. Hide it behind a disabled capability with a truthful explanation until its service path and acceptance test merge.

## 6. Acceptance and testing strategy

### 6.1 Existing tests to preserve and extend

| Domain | Existing repository checks | New behavior tests |
|---|---|---|
| Process/protocol | architectureIsolation, mmsOwnerLease, mmsProtocolServer, mmsProtocolFraming, protocolValidation, protocolIpcChannels, guiMmsController | Profile binding, event replay filtering, capability negotiation, large artifact chunking, stale client rejection. |
| Threads/workspaces | threadStorageMigration, threadGenerationStore, threadDataMutation, threadExecutionLease, threadRuntime, concurrentTurns, threadScopedEvents, repositoryIdentityLease | Two-profile same-repo use, profile migration faults, workflow reservation/reentrancy, durable continuation. |
| Agents | agentSpawning, subagentModelSettings, mousseAgentDurableSessions, agentLifecycleStatus | Definition/run separation, pinned revisions, capability-specific settings, delegation budgets, active-run UI continuity. |
| UI/editor | fileEditor, modelVariants, modelEfforts, appearanceSettings, browserTabs, chatModes, slashCommandPopoverStyles | Interactive Source/Preview, split layout/orb controls, source/canvas roundtrip, draft conflicts, profile switch with late events. |
| Integrations | integrations, fileCredentialStoreSecurity | Native roots, refresh invalidation, anonymous/OAuth/stdio, explicit actor grants, cancellation, rich result content, secure CRUD/import. |
| Scheduler/channels/control | scheduledJobs, channels, cliSessionCommands, controlStorage, controlAuth, controlMmsIntegration | Typed context, trigger dedup, per-profile Plus/account grants, channel routing, restart/approval waits. |
| Tools/worktrees | toolPathSafety, toolLoopSafety, worktreeReadiness, worktreeCompletion, workspaceGc | Script staging/process control, graph budgets, unknown effects, no unsafe cleanup, explicit compensation. |

These are existing filename stems under **tests/**, not new test commands or proof that the future feature is already covered. New proposed files should use clear domain prefixes and live where F03/Q01 configure their runner.

### 6.2 Meaningful test layers

**Pure/contract tests:** schema vectors, tokenizer, binding evaluation, graph compiler, hashes, ownership checks, state transitions, retry classification, and coordinate transforms. These should be deterministic and fast.

**Service integration tests:** real temporary filesystem and service composition with fake providers/tools/clock. Test migration, concurrent profiles, journals/leases, scheduler claims, MCP fixture servers, script subprocess cancellation, and event replay.

**UI tests:** mount/interact with actual components and, where needed, run Electron against a fixture MMS. Verify controls change persisted/runtime behavior, not only that text appears in source. Existing static/render assertions do not establish editor keyboard or browser takeover behavior.

**Browser executor tests:** run the real Mousse worker/Chromium against local fixture pages without an LLM. Assert exact page/backend state and trace events.

**Model evaluations:** dedicated, bounded job with fixed model/provider/browser revisions and cost cap. A provider outage is recorded separately from an executor bug, but user-visible failure behavior must still pass.

**Packaged tests:** clean install and upgrade paths for desktop/CLI, including browser binary resolution, path permissions, native modules, sandbox support, and headless operation. Development builds alone do not satisfy this layer.

### 6.3 Commands and evidence

Run focused tests during development, then the repository-required checks for the review-ready commit:

~~~powershell
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
npx vitest run tests/integrations.test.ts tests/protocolValidation.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Focused checks failed' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'Patch whitespace check failed' }
~~~

The test list above is an example for an integration/protocol slice. Workers select the relevant existing and new tests for their change. Do not rerun every expensive live-model evaluation after a CSS adjustment.

Before integrating a completed feature package, run **npm test** and the affected build target where required by the repository. For the exact release candidate, WG0/WG8 run **npm run typecheck**, **npm test**, **npm run build**, the configured UI/browser fixture suites, and platform packaging checks. The repository currently has **npm run build:cli** for CLI-focused changes.

F03/Q01 must introduce the actual E2E/evaluation script names. Until those scripts are merged, this plan uses their descriptive names; workers must not report a nonexistent **npm run test:e2e** as a completed check.

Record command, working directory, runtime home, code SHA, Node/browser/model versions, timestamp, exit status, and artifact/log path. A passing result belongs to that SHA. A merge/rebase that changes relevant code invalidates that portion of the evidence.

### 6.4 Release-blocking failures

Any cross-profile data/credential/control leak, new daemon ownership violation, destructive migration/data loss, duplicate consequential effect after recovery, fake-success status, or silent sandbox/authority downgrade blocks release.

Also block the affected feature on app/CLI workflow disagreement, invalid source/canvas roundtrip, missing required Add flows, broken native Mousse integration discovery, broken cancellation that leaks processes, inaccessible primary editor controls, or browser adapter capability claims without conformance evidence.

Unsupported external CLI/model/platform capabilities may remain explicitly unavailable if the product support matrix states that limitation. The mandatory managed browser path, native Mousse agents, core app/CLI workflow invocation, and personal profile boundaries cannot be removed from scope to declare completion.

## 7. Coordination artifacts and worker instructions

### 7.1 Coordinator ledger

During implementation, add a small versioned ledger under a coordinator-owned documentation directory, for example **docs/implementation/agent-platform/**. It contains:

| Artifact | Contents |
|---|---|
| baseline.md | Base SHA, included/excluded dirty changes, tool versions, known failures. |
| ownership.md | Writable paths per active worker, temporary file leases, explicit ownership transfers. |
| contracts.md | C1–C8 versions, defining commits, consumers, pending change requests. |
| work-packages.md | Package status, dependencies, branch/worktree, worker identity, next bounded action. |
| evidence.md | Gate/test results with exact SHAs and artifact locations. |
| decisions.md | Accepted implementation deviations with reason, alternatives, compatibility impact. |

Only WG0 updates the central ledger. Workers submit their handoff in a package-owned file such as **handoffs/W02.md**, so concurrent status reporting does not itself create merge conflicts.

Package states are **ready**, **running**, **review-ready**, **changes-requested**, **merged**, **blocked**, and **superseded**. “Merged” and “gate passed” are separate states: several merged packages may be needed for one gate.

### 7.2 Copyable worker task contract

~~~text
Package: <W02 or another single bounded package>
Objective: <observable behavior to deliver>
Base SHA: <exact integration commit>
Worktree: <absolute owned worktree>
Branch: <owned branch>
Read first:
  AGENTS.md
  docs/agents-workflows-profiles-browser-architecture.md sections <...>
  docs/parallel-worktree-implementation-plan.md package <...>
Required contracts: <C1@commit, C3@commit, ...>
Writable paths: <explicit paths/globs and test files>
Shared files owned by WG0: <list relevant hotspots>
Inputs/fixtures: <merged files and revisions>
Deliver:
  <implementation slice>
  <behavior tests>
  <documentation or diagnostic fixture>
Acceptance:
  <specific observed outcomes and negative cases>
Do not:
  change application-wide current profile or MOUSSE_HOME on switch
  construct MMS in Electron/normal CLI
  create a second contract or bypass validation
  edit outside ownership without a coordinator handoff
  use real user credentials/data/browser profiles for tests
Report:
  exact commit SHA, changed paths, checks, evidence, limits, next consumer
Stop/escalate only:
  missing contract, ownership conflict, external dependency, or concrete blocker
~~~

This template applies to AI workgroups themselves. It is separate from the AgentDefinition/workflow format being implemented inside Mousse.

### 7.3 Contract change request

When a worker finds that a contract cannot express a required case, send a bounded request containing:

1. The failing scenario and why existing fields/semantics cannot represent it.
2. Proposed type/schema delta and an example request/result/error.
3. Backward compatibility, migration, and validator implications.
4. Affected consumers and tests.
5. Whether independent work can continue while the coordinator decides.

WG0 records an accepted decision and lands one shared-contract commit. All affected workers merge that commit before using the new shape. A breaking change requires an explicit version/capability strategy; “TypeScript compiles” is not sufficient backward compatibility.

### 7.4 Review-ready handoff

~~~text
Package:
Branch / worktree:
Base SHA:
Head SHA:
Behavior delivered:
User-visible before/after:
Changed paths:
Contract versions consumed/produced:
Database/filesystem migration:
Runtime/feature flags:
Tests and exact commands:
Evidence artifacts:
Known limitations:
External dependencies:
Shared-file insertion requests for WG0:
Downstream consumers unblocked:
Working tree clean: yes/no, with explanation
~~~

Do not submit “implemented, please test” as a handoff. The worker owns focused validation. Do not claim completion based only on mocks when the package acceptance calls for real service wiring.

### 7.5 Stalled worker or context loss

The coordinator requests a concise checkpoint of current commit, uncommitted diff, tests, remaining work, and blocker. Preserve the worktree. If reassignment is needed, explicitly stop the previous worker before granting another writer ownership.

A successor reads the package handoff and the actual diff, verifies the base/contracts, then resumes. Do not restart from the original prompt, discard partial work, or repeat already-passing broad checks unless changes or missing evidence justify it.

## 8. Merge queue, conflict handling, and worktree lifecycle

### 8.1 Integration policy

The integration branch is the only source of truth for the combined feature. Workers update from recorded integration commits at package boundaries or contract changes; avoid constant rebasing during active implementation.

Before integration, WG0 verifies branch ancestry, ownership-clean changed paths, contract version, test evidence, feature flag state, and the actual diff. Shared-file insertion requests are applied by WG0 and validated together with the feature branch.

Merge one branch at a time. Prefer ordinary merge commits for package lineage; do not mix merging a branch with cherry-picking its same commits later. A coordinated unpublished worker branch may be rebased, but no force-push or history rewrite is required by this plan.

### 8.2 Reviewable merge commands

Run in the integration worktree after the worker marks its head stable:

~~~powershell
$MousseFeatureBranch = 'feat/platform-workflow-runtime'
$MousseFeatureHead = (git -C $MousseIntegration rev-parse $MousseFeatureBranch).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Feature branch is missing' }
$MousseDirty = git -C $MousseIntegration status --porcelain
if ($MousseDirty) { throw 'Integration worktree must be clean before merge' }
git -C $MousseIntegration log --oneline HEAD..$MousseFeatureHead
git -C $MousseIntegration diff --stat HEAD...$MousseFeatureHead
git -C $MousseIntegration merge --no-ff --no-commit $MousseFeatureHead
if ($LASTEXITCODE -ne 0) { throw 'Merge needs an explicit conflict review' }
~~~

Then inspect **git diff --cached**, run affected checks against the combined tree, and commit only when they pass. **--no-ff --no-commit** keeps the integration result reviewable before committing. Git documents the merge options and conflict handling. [Git merge documentation](https://git-scm.com/docs/git-merge)

If checks fail, fix the combined result with the owning worker/coordinator or use **git merge --abort** from the previously clean integration tree. A merge abort is not a reason to delete the worker branch. Keep failure evidence attached to the package.

### 8.3 Conflict rules

Resolve conflicts semantically. For protocol registration, verify method names, payload validation, ownership, event filtering, and client bridge parity rather than concatenating both sides. For package-lock changes, WG0 regenerates with the agreed package manifest/package manager; workers do not hand-merge arbitrary lockfile fragments.

For migration changes, re-run the relevant data fixtures after resolution. For visual/editor state, verify both draft persistence and run immutability. For browser/runtime conflicts, re-run the minimal action/recovery fixture that exercises the changed contract.

A contract mismatch is returned as changes-requested rather than patched independently in each consumer. The coordinator can retain a good feature behind a disabled flag while a dependency is repaired, but cannot bypass a release-blocking invariant to make the merge green.

### 8.4 Worktree cleanup

Remove a worktree only when the package is merged, the branch head is an ancestor of the retained integration/release branch, the worktree is clean, owned app/daemon/browser processes are stopped, and needed evidence/drafts are retained.

Resolve and inspect the exact absolute worktree path under the declared worktree root before removal. Use **git worktree remove <exact-path>** without force. If Git refuses, inspect the reason; do not replace it with recursive shell deletion. Keep the branch until release qualification or the repository's normal retention point.

Runtime homes may contain test diagnostics and browser state. Their cleanup is a separate retention action after verifying the resolved path stays under the specific worker runtime root. Do not run a computed recursive deletion on the user's normal Mousse home or use broad process-name termination.

## 9. Risks and explicit contingency paths

| Risk | Early probe / owner | Contingency that preserves the requirements |
|---|---|---|
| Existing uncommitted code differs from pinned baseline | F00 | Record/include through reviewed commits; do not silently overwrite or omit required fixes. |
| Profile refactor touches many global stores/singletons | P01 plus source inventory | Land path/context seams first; keep user multi-profile enablement gated until G2. |
| Control credentials stop decrypting after relocation | P02 | Decrypt with old path binding and re-encrypt in staging; verify readback before manifest commit. |
| Plus server lacks profile/account multiplexing contract | P03/Q04 | Preserve local profile functionality; disable unsupported concurrent remote binding and specify needed server change/re-pairing. |
| Native SDK lacks current browser schema support | M03 | Certify B1/B2 generic tools where supported; keep native tier unavailable until adapter/SDK is verified. |
| CDP/OOPIF behavior differs by Chromium build | B01/B02 | Pin builds, capability probe, fixture-test; show limited capability rather than reusing stale refs. |
| Browser binary increases installer complexity | B04/Q04 | Verified managed download plus documented offline package path; test CLI and GUI separately. |
| No real sandbox on a platform | W02/B04 | Explicit trusted-local mode for authorized code; refuse sandbox-required runs rather than silently downgrading. |
| Workflow joins/loops deadlock or consume unbounded budget | W01/W03 | Compile explicit control semantics, bounded nesting/iterations, shared budgets, and negative fixtures. |
| Recovery repeats an external write | W02/W04/B03 | Durable intent, idempotency where supported, unknown-effect reconciliation before retry. |
| Frontend state or browser cookies leak on profile switch | P03/M02/Q02 | Generation fencing, cache/persistence audit, separate browser ownership, authoritative resnapshot. |
| Shared files produce merge churn | WG0 | Domain extraction, one writer per hotspot, contract freezes, small insertion requests. |
| “Add” UI succeeds but integration is unusable | I02/I03/Q02 | Create→enable→invoke journeys using real fixture services from main and child agents. |
| Browser benchmark success hides unsafe false completion | Q03 | Independent end-state verifiers, false-success/duplicate-effect metrics, complete failure traces. |

The coordinator may reorder independent packages and split oversized work. Changes to ownership, scope, supported capabilities, data semantics, or acceptance gates are recorded in decisions.md and reflected in the architecture. Reducing a claimed support matrix is acceptable only when the required core feature remains fulfilled and the limitation is explicit.

## 10. Requirement-to-package traceability

| Requirement | Primary packages | Integration gate | Required review evidence |
|---|---|---|---|
| AW-01 Workflow files | W01, V02 | G3/G6 | Manifest/assets/lock roundtrip, import/export, version pinning, invalid-format cases. |
| AW-02 Slash app/CLI | W03, WG0 bridge edits | G3/G6 | Shared parser vectors, real app/CLI invocation, reserved/skill collisions, typed errors. |
| AW-03 Instructions and direct code | A01/A03, W02/W04 | G3/G6 | Actual script execution, pinned prompt/code, structured outputs, effect recovery. |
| AW-04 Two subtabs and preserved runtime access | A02, V01, WG0 routing | G4 | Agents/Workflows navigation and existing active agent detail journey. |
| AW-05 Agent Editor/orb/settings | U01, A01/A02/A03 | G4 | Fixed/scroll layout, palette arrows, editor reuse, model/settings persistence and execution. |
| AW-06 Node editor | W01/W03, V01/V02/V03 | G4/G6 | Full node catalog, type validation, accessible outline, source/canvas/run separation. |
| PR-01 Personal profiles | P01/P02/P03/P04, Q02 | G2/G7 | Data/credential/browser/event/control isolation, migration/recovery, background routing. |
| PR-02 Shared providers/models | P01/P04, A01, Q02 | G2/G7 | Shared catalog/auth, personal selections/favorites, shared quota attribution. |
| IN-01 MCP/Skills work and Add flows | I01/I02/I03/I04, U01 | G4/G7 | Native discovery, refresh, create/upload/connect, main/child invocation, auth/results/cancellation. |
| BR-01 Browser from scratch | B01/B02/B03/B04, M01/M02/M03 | G5/G7 | Own CDP worker, generic/native tools, app/CLI, takeover, profile/session boundaries. |
| BR-02 Industry-informed quality | Q01/Q03/Q04 | G7 | Pinned primary sources/adapters, reproducible fixture/benchmark evidence, performance/support matrix. |

## 11. Final release-candidate checklist

- [ ] All requirement IDs above have linked implementation commits and passing acceptance evidence.
- [ ] Existing active-agent, thread/worktree/undo, provider, scheduler/channel, and Plus/control behavior is preserved or explicitly migrated.
- [ ] New profile selection never mutates an installation-wide execution home/current-profile variable.
- [ ] Shared credentials/catalog and personal defaults/accounts are classified consistently in service, protocol, UI, export, and migration.
- [ ] Workflow graph/source/files agree; required code and approval nodes cannot be skipped by model interpretation.
- [ ] Script/browser/MCP outcomes distinguish success, failure, cancellation, and unknown external effect.
- [ ] Add Skill and Add MCP journeys pass in packaged app and supported CLI/native-child paths.
- [ ] Browser tool/model support reflects exact conformance results; unsupported capabilities are truthfully gated.
- [ ] Migration backup/restart/re-encryption/worktree-registration and downgrade behavior are documented and tested.
- [ ] Source/Preview editors, orb controls, node outline, and takeover controls pass keyboard/high-contrast/reduced-motion checks.
- [ ] Exact-candidate typecheck, repository tests, build, UI/browser fixtures, and Windows/Linux package acceptance pass.
- [ ] Runtime/evaluation artifacts are isolated from real user data; diagnostics and exports are profile-scoped and redacted.
- [ ] No package is marked complete solely because its branch merged; combined gates are verified.
- [ ] Release notes and operational documentation describe the shipped behavior and known limits.
- [ ] Worktree cleanup retains all unmerged work and required evidence; actual release publication is handled separately.

The implementation is complete when these observable behaviors and gates pass on the integrated candidate, with the documented support matrix. Progress reports should name the next unmet requirement or gate rather than a percentage inferred from files written.
