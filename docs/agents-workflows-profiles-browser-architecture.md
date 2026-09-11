# Mousse Agents, Workflows, Profiles, Integrations, and Browser Use Architecture

## 1. Purpose and design status

This specification defines a coherent expansion of Mousse: reusable agents, executable workflows, multiple local profiles, dependable Skills and MCP connections, and a browser automation runtime implemented by Mousse. It is intended for engineering, product design, and AI implementation workgroups. The companion [parallel worktree implementation plan](parallel-worktree-implementation-plan.md) assigns delivery ownership, dependencies, worktrees, and acceptance gates.

The implementation baseline is repository commit **205fab2d3799b347f8709a32b4352933d68d83e0**, inspected with the working tree on September 11, 2026. The working tree already contained changes to package manifests, test configuration, a worktree test, and a dependency cleanup script. Those changes are not part of this proposal. Source code takes precedence where older repository documentation describes an earlier architecture.

Statements in section 2 describe inspected behavior. Sections 3–12 specify proposed behavior. Section 10.1 separates externally documented browser approaches from the architecture recommended for Mousse. Performance numbers and delivery gates are engineering targets, not measurements of an implementation that already exists.

Navigation: [Current architecture](#2-current-architecture-and-verified-gaps) · [System design](#3-system-design-and-ownership) · [Profiles](#4-mousse-profiles) · [Agents](#5-agents-library-and-agent-editor) · [Workflow format](#6-workflow-file-format) · [Workflow runtime/editor](#7-workflow-invocation-execution-and-visual-editing) · [APIs](#8-shared-apis-events-approvals-and-artifacts) · [MCP/Skills](#9-mcp-and-skills-reliability-and-product-design) · [Browser research/design](#10-browser-use-research-and-mousse-design) · [Quality](#11-quality-requirements-and-rollout) · [Decisions](#12-decisions-alternatives-and-unresolved-validation).

### 1.1 Required outcomes

| ID | Requirement | Concrete completion condition |
|---|---|---|
| AW-01 | Store workflows in files | Versioned, validated workflow bundles round-trip through source and node editors and run without the GUI. |
| AW-02 | Invoke workflows from the main agent | Typing **/workflow_name arguments** in app or CLI creates the same durable workflow run; slash completion discovers available workflows. |
| AW-03 | Combine instructions and executable code | Instructions reach the intended agent; script nodes execute the stored, revision-pinned code directly with structured inputs/results. |
| AW-04 | Agents and Workflows subtabs | The Agents workspace has exactly these two library subtabs and retains access to existing active-agent views. |
| AW-05 | Rich Agent Editor | Desktop editor has a fixed left half with a liquid glass orb and palette arrows; the right half scrolls and contains Source/Preview prompt editing, model selection, and the settings in section 5. |
| AW-06 | Visual Workflow Editor | Users create, inspect, edit, validate, run, and debug typed node graphs with agents, code, conditions, functions, and the node catalog in section 7. |
| PR-01 | Multiple profiles | Threads, projects, Plus identity, preferences, channels, schedules, workflows, and agents have independent ownership and visibility. |
| PR-02 | Shared providers and models | Provider connections, model catalog, and provider credential configuration remain installation-scoped; profile model selections and favorites remain personal. |
| IN-01 | Dependable Skills and MCP | Add/create/upload/connect flows work end to end, with accurate enablement, diagnostics, invocation, and profile isolation. |
| BR-01 | Browser use from scratch | Mousse owns perception, references, execution, recovery, policy, traces, and model adapters; supported models can use the browser in app and CLI. |
| BR-02 | Industry-informed quality | A reproducible evaluation suite measures grounded actions, task completion, cost, latency, recovery, and isolation against documented baseline approaches. |

### 1.2 Scope decisions

The first full release targets Windows and Linux, matching the existing distribution paths. macOS adapters must compile where relevant but require their own packaging and browser certification before being advertised. Profiles are local identities within an installation; using separate operating-system accounts remains the boundary for mutually untrusted users.

“From scratch” means implementing the browser agent machinery and browser-control abstraction in Mousse. Chromium and its Chrome DevTools Protocol (CDP) remain the rendering and transport foundation. Browser Use, Stagehand, Skyvern, and Playwright MCP are research references and possible evaluation baselines, not production browser-agent dependencies. Playwright may be a development-only UI/evaluation dependency.

This feature does not require a workflow marketplace, cloud workflow runner, new billing service, or training a foundation model. Existing Mousse Plus connectivity is extended to carry profile ownership; a new remote-control plane is outside scope.

## 2. Current architecture and verified gaps

### 2.1 Runtime and client boundaries

Mousse is an Electron/React/TypeScript application with an Electron-free Mousse Main Service (MMS). The normal GUI and CLI are clients; the daemon owns execution. Preserve that ownership when introducing all new runtime features.

| Existing area | Evidence in repository | Consequence for this design |
|---|---|---|
| Daemon ownership | [MousseMainService.ts](../src/mms/MousseMainService.ts), [daemonOwner.ts](../src/cli/daemonOwner.ts), [main/index.ts](../src/main/index.ts) around line 264 | Construct execution services in MMS, never in a second GUI-owned runtime. |
| Local protocol | [protocol/types.ts](../src/mms/protocol/types.ts), [handlers.ts](../src/mms/protocol/handlers.ts), [validators.ts](../src/mms/protocol/validators.ts), [server.ts](../src/mms/protocol/server.ts) | Extend allowlisted, runtime-validated methods and sequenced events; TypeScript alone is insufficient validation. |
| GUI bridge | [registerGuiIpc.ts](../src/main/ipc/registerGuiIpc.ts), [protocolEventBridge.ts](../src/main/mms/protocolEventBridge.ts), [preload/index.ts](../src/preload/index.ts) | Feature DTOs cross these bridges; secrets and executable service objects do not. |
| Config and paths | [MousseConfigStore.ts](../src/mms/config/MousseConfigStore.ts), [SettingsStore.ts](../src/mms/settings/SettingsStore.ts), [paths.ts](../src/mms/data/paths.ts) | Current home/config access is installation-oriented. Inject immutable profile paths rather than changing process environment on a switch. |
| Execution and integrations | [LlmClient.ts](../src/mms/orchestrator/LlmClient.ts), [McpManager.ts](../src/mms/integrations/mcp/McpManager.ts), [SkillsRegistry.ts](../src/mms/integrations/skills/SkillsRegistry.ts) | Reuse the tool loop and adapters, but make actor and profile context explicit. |
| Git/thread recovery | [existing architecture](ARCHITECTURE.md), [thread undo design](thread-undo-architecture.md), existing workspace/lease tests | Workflow effects participate in durable thread history and repository locks; external effects are not falsely described as Git-undoable. |
| Plus/control | [control storage](../src/mms/control/storage/controlStore.ts), [CLI login](../src/cli/commands/login.ts), [CLI logout](../src/cli/commands/logout.ts), [ConnectionsSection.tsx](../src/renderer/components/ConnectionsSection.tsx) | Plus auth, grants, pairings, and remote commands require profile ownership too. Older “local-only” architecture prose does not describe all current control functionality. |

The current package manifest specifies Node **>=22.19.0**, React 19, Electron 43, TypeScript, Zustand, Monaco, and the MCP SDK. The older README prerequisite of Node 18 is not the implementation baseline. There is no workflow engine or node editor dependency in the inspected source/manifest.

### 2.2 UI reuse and differences from the requested product

| Area | Current behavior | Required change |
|---|---|---|
| Agents | [AgentsPanel.tsx](../src/renderer/components/AgentsPanel.tsx), around lines 28 and 214, displays running agent sessions and terminals. | Add a definition library; retain the runtime panel as run details. Do not reinterpret runtime Agent records as editable definitions. |
| Navigation | [MainViewTabs.tsx](../src/renderer/components/MainViewTabs.tsx), [MainViewPanel.tsx](../src/renderer/components/MainViewPanel.tsx) route the Agents view. | Introduce AgentsWorkspace with Agents/Workflows subtabs and internal detail routes. |
| Markdown editing | [FilesPanel.tsx](../src/renderer/components/FilesPanel.tsx), around lines 164–223, uses Monaco with Edit/Preview. [DocumentPanel.tsx](../src/renderer/components/DocumentPanel.tsx) is read-only. | Extract the existing editing behavior into MarkdownDocumentEditor and use Source/Preview labels. |
| Model selection | [ModelFamilyMenu.tsx](../src/renderer/components/ModelFamilyMenu.tsx), [ModelFamilySettingsFields.tsx](../src/renderer/components/ModelFamilySettingsFields.tsx) | Reuse search, provider/family grouping, variants, favorites, and capability-aware fields. |
| Appearance | [useTheme.ts](../src/renderer/hooks/useTheme.ts), [shared/settings.ts](../src/shared/settings.ts) | Existing theme, accent, and acrylic settings support the surrounding surfaces. A liquid glass orb is new work. |
| Profile | [ProfileSection.tsx](../src/renderer/components/ProfileSection.tsx), shared settings around line 50 | Today this is essentially username/activity presentation, not multi-profile ownership. |
| Skills | [SettingsPage.tsx](../src/renderer/components/SettingsPage.tsx), around lines 1420–1477; preload around line 472 | Discovery, enablement, read/refresh/open-folder exist. Create/import/update/delete APIs and an obvious Add button are missing. |
| MCP | SettingsPage around lines 1223–1358; preload around line 446 | Some connect/auth/test/restart/config APIs exist, but a coherent Mousse-owned Add/Edit/Inspect/Test flow is missing. |
| Slash commands | [channelCommands.ts](../src/shared/channelCommands.ts), [ChatComposer.tsx](../src/renderer/components/ChatComposer.tsx), [OrchestratorChat.tsx](../src/renderer/components/OrchestratorChat.tsx) | Extend the command catalog and server dispatch; frontend-only prompt substitution would leave CLI behavior inconsistent. |
| Browser | [BrowserPanel.tsx](../src/renderer/components/BrowserPanel.tsx), [BrowserViewManager.ts](../src/main/browser/BrowserViewManager.ts), [browserPolicy.ts](../src/main/browser/browserPolicy.ts) | Existing webviews, WebContentsView support, navigation, and element attachments are not an autonomous browser tool runtime. |

### 2.3 Defects and isolation risks to resolve first

These findings are specific implementation work, not an assertion that every MCP or skill currently fails:

1. Native integration materialization writes to Mousse-specific locations, while discovery in **src/mms/data/paths.ts** omits corresponding native roots. Discovery and materialization must agree on **.mousse/skills** and **.mousse/mcp.json**.
2. The skill refresh protocol path calls discovery without invalidating the registry's short-lived cache. A user-requested refresh must observe the just-installed or just-edited skill.
3. Remote MCP connection logic currently tends to treat HTTP/SSE without a static Authorization header as requiring OAuth. Anonymous, static-header, and OAuth connections need distinct states.
4. MCP connection identity is based on discovered server identity without sufficient profile/project/config revision ownership. Two projects or profiles can otherwise select the wrong live connection.
5. Native Mousse subagent integration selection goes through code that uses main-agent enablement gates. Effective permissions must use the calling actor's identity.
6. BrowserPanel hardcodes **persist:mousse-browser**. Cookies, storage, and browser cleanup must become profile-specific across both browser implementations.
7. **mousse-workspace-state**, model favorites, quick actions, and sidebar widths use global renderer persistence. In-memory snapshots and late events likewise lack profile identity.
8. Existing pending user questions have restart limitations. Durable workflow approvals cannot inherit an in-memory-only implementation and claim resumability.
9. Plus authentication has development fallback paths that can synthesize account credentials or a login transaction after an unsuccessful server exchange, while status can infer enrollment from token presence. See [desktopPkce.ts](../src/mms/control/auth/desktopPkce.ts), [cliHeadless.ts](../src/mms/control/auth/cliHeadless.ts), and [MmsControlService.ts](../src/mms/control/MmsControlService.ts). Production failures must remain failures; mock success belongs only in an injected test adapter or an explicit development-only mode.

## 3. System design and ownership

### 3.1 Service topology

~~~mermaid
flowchart TD
  GUI["Electron app: editors, browser viewer, run panels"]
  CLI["CLI: chat, workflow commands, diagnostics"]
  CONTROL["Existing Plus/control ingress"]
  PROTOCOL["MMS protocol and validated dispatch"]
  HOST["InstallationHost"]
  SHARED["Shared provider catalog, provider credentials, repository locks"]
  PROFILE["ProfileRuntime(profileId)"]
  LIB["Agent and workflow registries"]
  THREAD["ThreadRuntime and main-agent tool loop"]
  FLOW["WorkflowEngine and durable run store"]
  INTEGRATION["Profile Skills and MCP managers"]
  BROWSER["BrowserSessionManager and policy"]
  WORKER["Mousse browser worker"]
  CHROME["Managed Chromium process"]
  GUI --> PROTOCOL
  CLI --> PROTOCOL
  CONTROL --> PROTOCOL
  PROTOCOL --> HOST
  HOST --> SHARED
  HOST --> PROFILE
  PROFILE --> LIB
  PROFILE --> THREAD
  PROFILE --> FLOW
  PROFILE --> INTEGRATION
  PROFILE --> BROWSER
  FLOW --> THREAD
  FLOW --> INTEGRATION
  FLOW --> BROWSER
  BROWSER --> WORKER
  WORKER --> CHROME
~~~

**InstallationHost** is the proposed decomposition of the current service, not a second daemon. It retains the one installation owner lease, protocol listener, shared provider catalog/credentials, browser binary inventory, and repository coordination. It constructs lazily loaded **ProfileRuntime** instances. Each profile runtime owns its projects, threads, schedulers, channel sessions, integrations, libraries, approvals, usage attribution, and browser-session metadata.

GUI windows and CLI sessions select a profile independently. There is no mutable installation-wide “current profile” used to route execution. A background schedule continues against the profile captured when it was created, even when every visible window switches elsewhere.

### 3.2 Core identities

| Entity | Meaning | Identity and lifetime |
|---|---|---|
| Profile | Local owner of personal state | Stable UUID; display name and slug can change. |
| AgentDefinition | Reusable agent behavior and visual identity | Stable UUID plus immutable revision hash. |
| AgentRun | One invocation of a definition or built-in runtime agent | Existing execution identity extended with profile/definition revision. |
| WorkflowDefinition | Executable graph, input/output contract, instructions, assets | Stable UUID plus semantic revision hash. |
| WorkflowRun | Durable execution of one resolved workflow revision | UUID; immutable owner, inputs reference, actor, and trigger. |
| NodeAttempt | A scheduled attempt of a node instance | Run + node + iteration path + attempt number. |
| IntegrationInstallation | One installed skill or configured MCP server | Profile-owned identity, source provenance, revision. |
| BrowserSession | A browser workspace owned by a profile and run/thread | UUID, backend, context, control lease, lifecycle generation. |
| Artifact | File/image/report produced or consumed by a run | Opaque ID; resolved within authorized profile paths. |

Keep existing runtime Agent and agent type IDs backward-compatible. New APIs use **agentDefinitions.\*** so that **agents.list** can continue meaning active runtime agents.

### 3.3 Immutable execution context

~~~typescript
type ExecutionContext = Readonly<{
  profileId: string;
  projectId?: string;
  threadId: string;
  turnId: string;
  runId?: string;
  actor: {
    kind: "main" | "agent" | "workflow" | "scheduler" | "channel";
    definitionId?: string;
    definitionRevision?: string;
  };
  policySnapshotId: string;
  source: "gui" | "cli" | "schedule" | "channel" | "control";
  cancellationId: string;
}>;
~~~

All execution services receive this context from validated dispatch. Tools do not choose their own profile by reading globals or accepting arbitrary paths. Cancellation signals are process objects resolved from the ID and never serialized as executable values.

Effective authority is the intersection of installation policy, profile preferences, project trust, run authorization, agent grants, and node/tool restrictions. An agent prompt, workflow asset, skill manifest, MCP tool description, or webpage can request a capability but cannot grant it.

### 3.4 Proposed module boundaries

~~~text
src/shared/
  profiles/       profile DTOs and settings split
  agents/         definitions, model capability references
  workflows/      format, nodes, bindings, run DTOs
  integrations/   installation and diagnostic DTOs
  browser/        observations, actions, session DTOs
src/mms/
  profiles/       ProfileManager, ProfileRuntime, migration, scoped paths
  agentDefinitions/  registry, resolver, prompt compiler
  workflows/     registry, compiler, scheduler, runners, journal
  execution/     policy, durable approvals, artifact access, script runner
  browser/       session manager, model adapter, policy, worker broker
  integrations/  existing MCP/Skills implementation extended in place
src/browser-worker/
  cdp/           transport, targets, frame/context management
  observation/   AX/DOM processing, reference map, screenshot geometry
  actions/       input, forms, files, waits, verification
src/renderer/features/
  profiles/ agents/ workflows/ integrations/ browser/
src/renderer/components/editors/
  MarkdownDocumentEditor.tsx
~~~

These paths are proposed ownership seams. Extract small adapters from existing large files; do not duplicate the existing service or replace all UI infrastructure as a prerequisite.

## 4. Mousse Profiles

### 4.1 Data ownership matrix

| Data | Scope | Rules |
|---|---|---|
| Provider definitions, endpoints, installed model catalog | Installation | Shared across profiles, including catalog refresh and provider capability information. |
| Provider API keys and provider subscription OAuth | Installation | Shared provider connection by explicit product policy. Renderer sees only connection status and masked identifiers. |
| Preferred provider/model, effort, favorites | Profile | Personal selection points into shared catalog; choosing a default does not change another profile. |
| Provider rate-limit pool | Installation | Attribute consumption by profile; shared credentials imply shared provider quota. A profile budget is not a separate upstream quota. |
| Mousse Plus account, refresh tokens, device grants, pairings | Profile | Separate from provider subscriptions. Logout or revocation affects the selected profile's account and grants. |
| Threads, messages, queues, tasks, agent runs, usage history | Profile | All IDs are resolved within profile ownership before reads, subscriptions, or mutations. |
| Projects and recent paths | Profile | Two profiles may independently register the same filesystem repository. Project listings are not shared. |
| Repository identity and mutation leases | Installation | The same Git common directory must still share a lock across profiles. No transcript or personal project metadata belongs here. |
| Thread/agent worktrees and checkpoints | Profile-owned workspace roots | Coordinate mutations through shared repository identity; preserve existing lease order. |
| Agents, workflows, versions, run history, drafts | Profile | Optional project-scoped bundles become available only after that profile trusts/imports the project. |
| Skills, MCP definitions, grants, OAuth tokens, discovery selection | Profile | Binary downloads may be cached globally; connection sessions and activation are not shared. |
| Channels, pairing maps, routing, schedules, timezone | Profile | Jobs and messages bind their owner at creation/ingress. Never route by foreground profile. |
| Theme, accent, acrylic, layout, notifications, quick actions | Profile | Installation-level defaults may seed a new profile once, then values are independent. |
| Browser cookies, cache, IndexedDB, service workers, downloads | Profile/browser context | A manual browser and an agent session share state only through an explicit within-profile browser workspace selection. |
| Application updates, install path, binary cache, owner lease | Installation | Not duplicated per profile. |
| Window bounds, OS integration | Client/install as appropriate | Window selection is presentation state; theme and panel layout follow the window's profile. |

The shared provider connection is clearly labeled **Shared across profiles** in settings. Removing it shows dependent agents/workflows across the installation only as permitted administrative metadata. Missing credentials create actionable dependency errors; the system never silently switches another profile to a different provider.

### 4.2 Storage layout

~~~text
MOUSSE_HOME/
  installation.json              schema version, profile index, migration state
  mousse.conf                    installation-owned configuration after migration
  auth.json                      shared provider credentials, existing format retained
  mms.owner.json                 existing installation owner/fencing record
  mms.runtime.json               existing daemon discovery record
  mms.sock                       existing Unix endpoint; Windows uses named pipe
  providers/                     shared catalog/cache if needed
  repositories/<repositoryId>/   shared identity and coordination leases
  browser-binaries/<buildId>/    verified browser distributions
  profiles/<profileId>/
    profile.json                 display metadata and revision
    mousse.conf                  profile settings, agents defaults, jobs, channels
    projects/                    profile project registry and metadata
    threads/                     current durable thread storage layout
    repositories/                profile-owned thread/agent workspaces
    agents/<definitionId>/       draft, revisions, head manifest
    workflows/<definitionId>/    draft, revisions, head manifest
    workflow-runs/<runId>/       manifest, journal, node results
    integrations/
      skills/                    managed SKILL.md packages
      mcp.json                   Mousse-owned server definitions
      state/                     connection diagnostics and installation metadata
    secrets/                     profile credential references/encrypted records
    control/                     Plus/self-hosted control credentials and grants
    scheduled/                   runtime state and execution history
    channels/                    routing, pairing, inbox/outbox state
    browser/<workspaceId>/       persistent Chromium user data where selected
    artifacts/                   run outputs, screenshots, downloads
    drafts/                      durable editor drafts
    presentation/                daemon-backed preferences where appropriate
~~~

This is a logical target. Preserve internal thread-generation structures while changing their root through injected storage paths. Do not flatten or regenerate existing histories.

Keep installation owner/discovery files and the home-derived Windows pipe identity stable during profile migration. Moving them without a transition that fences both old and new paths can let an older client attempt to start a competing daemon before the new profile handshake rejects it. Profile storage changes do not require moving the installation endpoint.

Credentials use the existing credential-storage abstraction where suitable, extended with namespace/associated-data binding to installation or profile. GUI-only Electron encryption cannot be the sole mechanism because CLI/daemon must function without Electron. Provide a platform credential-store adapter and an explicit supported headless storage mode. A passphrase-locked store pauses dependent background work until unlocked; a plaintext fallback must not silently masquerade as encrypted storage.

Profiles prevent accidental mixing through Mousse interfaces. They are not a sandbox against another program running under the same OS account. Trusted local scripts and external CLIs can access that OS account's files unless an actual OS/container sandbox is selected. A cosmetic profile PIN must not be marketed as cryptographic isolation.

### 4.3 Profile lifecycle and selection

**Create:** ask for name, optional avatar/color, and optional appearance seed. Generate a UUID and initialize empty profile stores atomically. Do not copy chats, Plus tokens, browser cookies, integrations, or schedules. Shared providers/models are immediately available.

**Select:** each GUI window has one selected profile and a monotonically increasing selection epoch. CLI uses **--profile <slug-or-id>**, then a profile-specific client preference, then a persisted default. Once a command starts, its profile is fixed. A request for a non-existent or ambiguous slug fails before creating a thread.

**Switch:** suspend new commands in that window; persist local editor drafts; detach old subscriptions; increment epoch; clear personal in-memory caches; unmount profile browser/terminal surfaces; rebind the protocol session; hydrate profile preferences; fetch an authoritative snapshot; subscribe from its event cursor; reveal the ready UI. Discard any old-profile response or event even if its thread ID resembles a current selection. A failed switch restores the previous binding with its saved draft or displays a retryable profile-loading screen, never a half-mixed UI.

**Background work:** switching a window does not cancel runs or change channel routing. The switcher shows counts of work in other profiles without leaking titles or content. A profile can explicitly pause its schedules/channels and cancel its runs.

**Delete:** require no active work, stop ingress and owned processes, revoke owned remote grants, then tombstone the profile and move its data to a recoverable trash location within the installation. Retention and final deletion are separate actions. Never delete shared providers or user repositories. Deletion must enumerate exact owned roots and reject symlink/path escapes.

### 4.4 Protocol and control isolation

The upgraded handshake negotiates a **profiles-v1** capability. Installation methods such as provider catalog queries are separately classified. Profile-bound methods use a connection binding established by **profiles.bind**; any redundant profile ID in a payload must match it. Control/remote callers receive only the profile scopes contained in their grants. An owner token authenticates an installation client but does not substitute for profile routing.

Event envelopes contain profile ID, stream kind, sequence, and object revision. Filter before serialization and before event-ring replay. Use installation events only for safe shared data, such as provider connection status without secrets. Per-profile sequence streams avoid leaking other profiles' activity through counters. Resnapshot responses include the profile and cursor they represent.

Legacy clients may use the migrated Default profile only while the installation remains in single-profile compatibility mode. Once multiple profiles are enabled, a client that cannot negotiate profile binding gets an explicit upgrade-required error. It must not accidentally receive the last GUI-selected profile.

Plus/self-hosted control grants must bind to a profile, account, device, and allowed operations. Existing unscoped grants migrate only to Default or require re-pairing if ownership cannot be established. Multiple profiles can share physical device identity while using distinct account registration/grant records. Server compatibility must be checked before enabling simultaneous multi-account relay connections; never multiplex accounts through an unscoped legacy session.

Remove implicit production mock-success fallbacks in account exchange/enrollment. Validate server-returned account/token responses, track enrollment acknowledgment separately from local token presence, and report failed/offline authentication truthfully. Tests use an explicit mock adapter; an unreachable hosted service cannot become a fabricated connected profile.

### 4.5 Migration and rollback

Migration is an installation-wide transaction:

1. Acquire the installation migration lease; stop new writes, scheduler ticks, channel ingress, and control dispatch. Drain or mark in-flight operations recovery-required using existing recovery facilities.
2. Inventory actual legacy files, browser partitions, control storage, repository/worktree metadata, renderer persistence keys, and credentials. Record version, hashes, sizes, and original locations.
3. Create a Default profile UUID and a staging destination. Copy data into the new layout, preserving IDs, journals, timestamps, permission metadata, and Git worktree registration.
4. Repoint workspace metadata carefully. Registered Git worktrees cannot simply be moved as ordinary directories: use a supported Git move/repair sequence under the repository lease or retain their legacy physical location with an explicit profile ownership record until migration is proven.
5. Split config through a reviewed field classification map. Keep provider auth installation-scoped. Move Plus/channel/MCP identity state into Default. Current ControlStore encryption derives its key partly from the control-directory path: decrypt Plus credentials using the original store, re-encrypt under the destination namespace in staging, and verify readback before retiring the source. Byte-copying credentials.enc into a new directory is insufficient. Apply equivalent handling to every location-bound encrypted record. Unknown fields are preserved and reported, not discarded.
6. Validate project/thread/run counts, transcript hashes, queue contents, scheduled definitions, credential reference resolvability, browser storage ownership, and repository status.
7. Publish one installation manifest selecting schema v2 and Default. Use same-filesystem temporary files, atomic rename, and durability primitives appropriate to the platform. An absent committed manifest means staged data is not authoritative.
8. Restart services against injected profile paths. Only Default imports the old renderer keys, once. Existing browser storage is assigned to Default, never copied to every profile.
9. Retain the verified legacy snapshot and migration journal. An interruption resumes by completed step and hash; it never blindly repeats moves.

Rollback before any v2 writes restores the legacy manifest and roots. After v2 writes, do not run an old binary on stale legacy data. Restore the full pre-migration snapshot with an explicit loss-of-new-data choice, or deploy a forward fix. A reversible UI feature flag is not a data-schema downgrade strategy.

## 5. Agents library and Agent Editor

### 5.1 Information architecture

The main **Agents** tab opens a workspace with **Agents** and **Workflows** subtabs. The Agents library includes a prominent **New agent** button, search, tags, provider/model filter, favorites, and sort by name/recently edited/last run. Cards show orb thumbnail, name, short purpose, model, enabled state, and any missing dependencies.

Selecting a card opens the Agent Editor. Back returns to the same filter and scroll position. Built-in templates can be duplicated into editable definitions. Existing runtime sessions remain accessible from an **Active runs** button/drawer and from thread tool cards, using the current AgentsPanel and AgentsTasksView. A definition's run history links to these runtime views.

The **Workflows** subtab has its own list/card library with **New workflow**, Import, search, tags, profile/project scope, and draft/published/invalid status filters. Listings show name, purpose, slash command, published revision, dependency health, last-run status, and last edited time. Clicking a listing opens its node editor; New workflow offers blank and sample templates. Back restores the library's filters and scroll position. A separate run-history action opens executions without replacing the editable definition.

### 5.2 Desktop composition and liquid glass orb

~~~text
Agents / Workflows
< Agents     Research reviewer                 Saved       Test     Run
+--------------------------------+--------------------------------+
| FIXED LEFT HALF                | SCROLLABLE RIGHT HALF          |
|                                | Identity                       |
|        liquid glass orb        | Name / purpose / tags          |
|                                | System prompt                  |
|      <  Aurora palette  >      | [Source] [Preview]             |
|                                | Model and reasoning            |
|      Name and purpose          | Knowledge / tools / skills     |
|      Palette controls          | Browser / delegation           |
|                                | Limits / output / advanced     |
+--------------------------------+--------------------------------+
~~~

At desktop widths of at least 1100 CSS pixels, the content area is a true 50/50 split. The left panel remains fixed inside the editor viewport; only the right pane scrolls. The header remains visible. The left orb should occupy roughly 45–65% of its pane's width with a bounded maximum; it must not compete with text editing.

The orb uses a deterministic palette seed, translucent layered gradients, soft internal refraction-like motion, a restrained highlight, and optional pointer parallax. Start with CSS/canvas primitives; add a shader only if visual review shows a material benefit within the frame budget. No network image generation is needed for this component.

Previous/next buttons cycle named palettes such as Aurora, Lagoon, Ember, Pearl, Violet, and Graphite; the active palette name is always textual. Advanced appearance offers custom two-to-four color stops, luminance, translucency, motion intensity, and reset. Palette changes update the draft immediately and persist with the definition's visual metadata, independent of its execution revision.

Respect reduced-motion preferences with a static orb and disable pointer parallax. Provide an opaque, high-contrast fallback, accessible button labels, keyboard arrow operation when palette controls are focused, and a visible focus ring. Suspend rendering while hidden. On narrower windows stack a compact orb/identity header above the settings form rather than forcing an unusable split.

### 5.3 Agent settings

| Group | Fields and interactions | Runtime meaning and default |
|---|---|---|
| Identity | Name, unique slug, purpose, tags, enabled, favorite | Slug is a human reference; stable ID is authoritative. New definitions are enabled after valid save. |
| Instructions | Source/Preview Markdown editor, variable insertion, prompt size estimate, examples | Prompt revision is pinned when a run starts; model-generated edits remain draft until saved. |
| Primary model | Provider/model family/variant, reasoning effort, supported speed/context choices | References shared catalog; fields appear only when supported. |
| Fallbacks | Ordered fallback models, retry-on categories, allow higher cost | Off by default. Never silently fall back across data-residency or capability restrictions. |
| Response | Language, tone, verbosity, citation preference, Markdown/JSON/schema output | Preferences compile into instructions; schema output is validated separately. |
| Context | Current thread, selected files, project instructions, attachment policy, max context budget | Explicit sources with provenance. A missing source creates a warning or blocking dependency according to required/optional status. |
| Memory | Off/thread/profile-agent memory, retention, inspect/reset | Default thread-only. Profile memory excludes other profiles and is never included merely because a shared model was selected. |
| Skills | Searchable selected skills, inherited/explicit enablement, revision behavior | Resolved against the effective actor grants; initial default inherits profile selections. |
| MCP and tools | Server/tool selection, built-in allowlist, capability summary | The UI shows effective grants and reasons for denied entries. A server toggle is not carte blanche for future tools. |
| Browser | Disabled/structured/hybrid/native adapter, browser workspace, domain restrictions, trace retention | Disabled by default for a new generic definition; enabled intentionally or by an explicit browser template. |
| Delegation | Allowed child definitions, max concurrent children, max depth, aggregate budget | Default no recursive delegation; bounded depth and a shared parent budget prevent multiplicative run growth. |
| Workspace | Read-only/current thread worktree/dedicated child worktree, permitted roots | Default follows thread policy. Never mutate the primary checkout merely because a workflow asks. |
| Code | Script capability, interpreter allowlist, execution mode, network/filesystem requests | Defaults follow profile trust; executable code cannot gain authority from prompt text. |
| Human interaction | Ask-user capability, approval policy, unattended behavior | Reuse existing run authorization; persist new workflow-critical approvals. |
| Limits | Max turns, tool calls, elapsed time, input/output tokens, cost, artifact size | Finite defaults; parent/workflow limits cap child values. Unsupported cost estimates remain marked unknown. |
| Recovery | Retry count/backoff, transient-error categories, stop condition, final-report template | Conservative retry; ambiguous external effects require reconciliation. |
| Testing | Sample prompts, expected schema/assertions, fixture context, isolated test run | Test conversations are separate runs and do not pollute production agent memory by default. |
| Versioning | Revision list, diff, duplicate, export, archive | Runs keep historical revisions even after definition archival. |

**MarkdownDocumentEditor** is a controlled component with value, onChange, readOnly, validation markers, variable completions, and theme props. It owns no file writes or daemon calls. Preserve exact source across Source/Preview switches; preview rendering must not execute raw HTML, scripts, or remote image requests without the application policy. FilesPanel, Agent Editor, Skill Editor, and workflow instructions share this component.

### 5.4 Definition and invocation contract

An agent bundle contains **agent.json**, **system.md**, optional examples, and visual metadata. The definition stores a runtime kind: native Mousse or an existing supported CLI adapter. Native Mousse supports the full settings model. CLI adapters publish a compatibility report; unsupported controls are disabled or rejected rather than falsely guaranteed.

Use **AgentResolver** to return a pinned definition, compiled prompt, model capability profile, effective grants, and dependency hashes. Prompt composition order is application/runtime rules, profile/project context, definition instructions, workflow node instructions, and current task. Retrieved skills and website text are labeled external context; they cannot override runtime rules.

An Agent node invokes this resolved definition through existing agent execution paths. It records definition ID/revision on the runtime agent. Editing or archiving the definition affects subsequent runs only. Deleting a model or skill leaves historical runs viewable and makes dependent future runs show a repair action.

## 6. Workflow file format

### 6.1 Canonical bundle

Use a JSON manifest and ordinary sibling assets as the v1 canonical format:

~~~text
release-review/
  workflow.json
  instructions.md
  scripts/collect.mjs
  schemas/report.schema.json
  fixtures/sample-input.json
  workflow.lock.json
  editor.json
~~~

JSON is already a repository/config convention and has an unambiguous parser. Avoid introducing YAML execution semantics in v1. A future YAML import/export adapter may produce the same canonical intermediate representation; it must never become a second runtime.

**workflow.json** contains semantic graph data. **editor.json** contains node positions, viewport, collapsed groups, and visual annotations. **workflow.lock.json** pins external agent, skill, tool-schema, subworkflow, and asset dependencies for publication/export. Lock contents include hashes and identities, not credentials.

Discovery checks profile-managed workflows and explicitly trusted project **.mousse/workflows/** directories. Project discoveries are profile-owned registry entries; finding a file does not enable it or execute code. Local files may be edited outside Mousse, but registry updates validate and atomically publish a new revision.

### 6.2 Manifest contract

| Field | Requirement |
|---|---|
| schemaVersion | Integer 1; unknown major versions open read-only with a clear upgrade message. |
| id | Stable UUID, independent of folder/display name. |
| name / slug / description | Display metadata; lowercase slash slug using letters, digits, underscore, and hyphen, maximum 64 characters. |
| inputSchema / outputSchema | Bounded JSON Schema subset, local references only; schemas validated at import and before/after execution. |
| instructionsFile | Relative Markdown asset supplied to the main agent as workflow context. |
| entryNodeId | Exactly one entry in each graph/subgraph. |
| nodes / edges | Typed nodes and explicit control edges; data binding is separate from control flow. |
| limits | Finite duration, step, loop, concurrency, token, cost, and artifact limits. |
| permissions | Requested capabilities, not self-granted authorization. |
| dependencyPolicy | Pinned dependencies for published runs; draft resolution reports exact versions before launch. |
| extensions | Namespaced data preserved on save; unknown executable node types cannot run. |

JSON Schema support initially covers objects, arrays, strings, numbers, booleans, enums, required properties, bounded lengths, and local definitions. Reject remote references, recursive/unbounded schemas, prototype keys, oversized graphs, and excessively expensive patterns. Select and pin a maintained schema validator through the foundation workgroup; do not build a partial validator and claim complete JSON Schema compliance.

### 6.3 Complete small workflow example

This example defines a direct script followed by a conditional and a native main-agent summary. The script performs no model call. The example is a proposed v1 format, not an existing executable CLI feature.

~~~json
{
  "schemaVersion": 1,
  "id": "555634aa-1b02-4d11-af52-a526df216daf",
  "name": "Summarize files",
  "slug": "summarize_files",
  "description": "Collect selected text files and summarize non-empty input.",
  "instructionsFile": "instructions.md",
  "inputSchema": {
    "type": "object",
    "properties": {
      "files": {
        "type": "array",
        "items": { "type": "string" },
        "minItems": 1,
        "maxItems": 20
      }
    },
    "required": ["files"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": { "summary": { "type": "string" } },
    "required": ["summary"],
    "additionalProperties": false
  },
  "entryNodeId": "start",
  "limits": { "maxSteps": 12, "timeoutMs": 180000, "maxConcurrency": 1 },
  "permissions": { "capabilities": ["workspace.read", "script.trusted-local", "model.invoke"] },
  "nodes": [
    { "id": "start", "type": "start", "version": 1, "config": {} },
    {
      "id": "collect",
      "type": "script",
      "version": 1,
      "inputs": { "files": { "ref": "input", "pointer": "/files" } },
      "config": {
        "runtime": "node",
        "file": "scripts/collect.mjs",
        "fileInputs": [
          {
            "pointer": "/files",
            "source": "thread-workspace",
            "destination": "input-dir",
            "rewrite": "relative-staged-paths",
            "maxTotalBytes": 200000
          }
        ],
        "executionMode": "trusted-local",
        "workingDirectory": "thread-workspace",
        "timeoutMs": 30000,
        "outputSchema": {
          "type": "object",
          "properties": {
            "count": { "type": "integer", "minimum": 0 },
            "text": { "type": "string", "maxLength": 200000 }
          },
          "required": ["count", "text"],
          "additionalProperties": false
        }
      },
      "effect": "read",
      "retry": { "maxAttempts": 1 }
    },
    {
      "id": "has-content",
      "type": "condition",
      "version": 1,
      "config": {
        "expression": {
          "op": "gt",
          "args": [
            { "ref": "node", "nodeId": "collect", "pointer": "/count" },
            { "literal": 0 }
          ]
        }
      }
    },
    {
      "id": "summarize",
      "type": "agent",
      "version": 1,
      "inputs": { "text": { "ref": "node", "nodeId": "collect", "pointer": "/text" } },
      "config": {
        "agent": { "kind": "main" },
        "instructions": "Summarize input.text. Return an object with one string field named summary.",
        "outputSchema": {
          "type": "object",
          "properties": { "summary": { "type": "string" } },
          "required": ["summary"],
          "additionalProperties": false
        }
      },
      "effect": "read",
      "retry": { "maxAttempts": 1 }
    },
    {
      "id": "empty",
      "type": "transform",
      "version": 1,
      "config": { "value": { "literal": { "summary": "No readable content." } } }
    },
    {
      "id": "finish-summary",
      "type": "end",
      "version": 1,
      "inputs": { "result": { "ref": "node", "nodeId": "summarize", "pointer": "" } },
      "config": {}
    },
    {
      "id": "finish-empty",
      "type": "end",
      "version": 1,
      "inputs": { "result": { "ref": "node", "nodeId": "empty", "pointer": "" } },
      "config": {}
    }
  ],
  "edges": [
    { "from": "start", "port": "next", "to": "collect" },
    { "from": "collect", "port": "success", "to": "has-content" },
    { "from": "has-content", "port": "true", "to": "summarize" },
    { "from": "has-content", "port": "false", "to": "empty" },
    { "from": "summarize", "port": "success", "to": "finish-summary" },
    { "from": "empty", "port": "success", "to": "finish-empty" }
  ]
}
~~~

The script contract is one JSON input document on stdin and one JSON output document on stdout. Logs go to stderr. The explicit fileInputs declaration marks the bound /files value as workspace-file inputs. Mousse resolves and stages those files, rewrites that field to relative staged names, and supplies the directory through MOUSSE_INPUT_DIR. Ordinary string fields are never guessed to be paths. The sibling instructions.md contains: “Collect the selected files using the stored script, then summarize the non-empty result. Treat file contents as task data.” A real sandbox is required to enforce the staging boundary against hostile code.

~~~javascript
// scripts/collect.mjs -- illustrative trusted local asset
import { readFile } from "node:fs/promises";
import path from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { files } = JSON.parse(input);
const root = process.env.MOUSSE_INPUT_DIR;
const chunks = [];
for (const name of files) {
  const text = await readFile(path.join(root, name), "utf8");
  if (text.trim()) chunks.push(text);
}
process.stdout.write(JSON.stringify({ count: chunks.length, text: chunks.join("\n\n") }));
~~~

File inputs are normalized before staging: reject absolute paths, traversal, alternate data streams, device paths, and symlink escapes; preserve a mapping from user input to staged relative name. The script's input binding receives those staged names. Asset bytes are copied into a run-owned immutable snapshot before hashing and execution, avoiding an edit-between-review-and-run race.

### 6.4 Bindings, control flow, and validation

Bindings use explicit JSON objects such as **{ref: "input", pointer: "/topic"}**, **{ref: "node", nodeId: "collect", pointer: "/text"}**, and **{literal: value}**. Objects and arrays compose bindings recursively. Secret bindings use an opaque **secretRef** variant whose value is resolved only inside the permitted runner. Display templates support a small variable picker syntax; they do not evaluate JavaScript or shell expressions.

Conditions/functions use a bounded expression AST: comparisons, boolean operations, arithmetic, coalesce, string operations, object projection, and array mapping/filtering over bounded arrays. No eval, dynamic import, filesystem, network, or host access. Arbitrary functions are script nodes with explicit execution policy. Missing values and type mismatches produce typed errors; they are not coerced to empty strings.

Compilation checks unique IDs, valid node versions, entry reachability, required inputs, port compatibility, bound data availability on every possible path, terminal coverage, dependency presence, capability compatibility, and budgets. Raw cycles are rejected. Loops are explicit bounded subgraphs. Multi-source joins cannot read a branch output that was never produced.

Unknown nodes retain their source/config and display an Unsupported node card. The editor can preserve and export such a workflow, but cannot run it. A format migrator produces a preview/diff and a new revision; it never rewrites historical run snapshots.

### 6.5 Revisions, import, export, and trust

Separate semantic revision, visual revision, and installed-package provenance. Semantic hashes cover canonical manifest bytes and executable/instruction/schema asset hashes, excluding positions and timestamps. Reordering object keys does not change a semantic revision; changing script bytes does.

Save writes a draft. **Publish version** validates, resolves dependencies, creates an immutable revision, and advances an atomic head manifest. Run defaults to the published revision; **Run draft** explicitly snapshots and validates the draft first. Optimistic revision preconditions prevent two editor windows silently overwriting each other.

Export is a directory or **.mousse-workflow.zip** containing the manifest/assets/lock/editor data. Import stages before installation and enforces entry count, decompressed-byte, compression-ratio, path, symlink, executable-content, and schema limits. Show name conflicts, requested capabilities, dependencies, and code in a reviewable preview. Import never runs install hooks or package-manager commands.

Project workflow slugs take precedence only after an explicit per-profile project selection; otherwise an ambiguity requires selection. Keep the namespace in completion labels. No imported workflow can shadow a built-in command.

## 7. Workflow invocation, execution, and visual editing

### 7.1 Slash invocation and CLI parity

Create a shared command tokenizer/catalog and an MMS **WorkflowInvocationResolver**. The GUI provides completion and argument forms, but MMS performs authoritative resolution and validation. The CLI's existing catch-all “Unknown command” branch must consult this catalog before rejecting a workflow.

| Input | Meaning |
|---|---|
| **/summarize_files --files '["README.md"]'** | Resolve a visible published workflow by slug; parse named values using its input schema. |
| **/review_release prepare notes for version 2** | Bind remaining text to a declared string input designated as the workflow's rest argument. |
| **/workflow review_release --version <revision> ...** | Explicit workflow namespace and optional revision. |
| **/skill code-review ...** | Explicit skill invocation; preserve supported legacy skill aliases when unambiguous. |
| **//review_release ...** | Literal leading slash text, with one slash removed before ordinary submission. |
| **mousse-cli --profile work workflow run review_release --input-file input.json** | Noninteractive structured equivalent, with no shell interpretation of workflow inputs. |
| **mousse-cli --profile work chat "/review_release ..."** | Same resolver, validation, run record, and errors as the app. |

Built-ins and aliases are reserved across app, CLI, and channels, including existing **help**, **new/reset**, **threads/thread**, **model/models**, **stop**, **steer**, **agents/tasks**, **skills**, and CLI session commands. Publication rejects reserved slugs. If a legacy skill and a workflow share a name, show both with explicit namespace choices; do not silently change which one runs. Preserve the original invocation in the transcript.

The tokenizer handles quoted strings, escaped quotes, booleans, numbers, repeated flags for array fields where declared, and **--** for the remaining text. It performs no environment expansion, globbing, command substitution, or shell execution. JSON-valued flags must be valid JSON. Unknown fields and missing required inputs produce an argument form in the GUI or a structured CLI error before any script or model call.

Completion cards show name, description, scope, revision, input hint, and missing dependencies. Completing the slash name can open a compact input form, but users can keep typing. A workflow run card in chat shows phase, current node, elapsed time, budget, outputs, and controls.

Noninteractive CLI supports **--json**, **--wait**, and **--no-wait**. **--no-wait** returns a durable run ID after acceptance. **--wait** streams progress and returns exit code 0 for success, 1 for execution failure, 2 for invalid invocation/dependencies, 3 for waiting for required human input in noninteractive mode, 4 for cancellation, and 5 for recovery-required. These codes are proposed additions to document in CLI help. Ctrl+C cancels the owned foreground run using existing signal semantics; disconnecting a monitoring client alone does not cancel it.

### 7.2 Relationship to the main agent

A slash workflow is an explicit execution command. MMS compiles and starts the graph, posts a run card, and supplies the main agent with the workflow's instructions, inputs, and progress. The model performs Agent/Instruction nodes and can explain progress or propose recovery; it does not improvise the graph scheduler or skip required script/approval nodes.

The main agent also receives **list_workflows**, **inspect_workflow**, and **run_workflow** tools for natural-language requests. Starting through these tools uses the same resolver and authority as slash invocation. Inspection returns concise metadata first, then selected instructions/assets; it does not dump every workflow into every prompt.

For a main-agent node in the initiating thread, execute a bounded segment under the existing ThreadSession with an inherited execution lease token. Do not recursively call ordinary orchestrator.send while already holding that thread's execution lease. Child agent nodes use separate child sessions and propagate parent cancellation, profile, policy, and budget.

Retain existing Markdown modes as a separate main-agent behavior selector. Fix their home/profile discovery and singleton ownership, but do not silently convert repository **agents/*.md** modes into workflows. Offer **Create agent from mode** as an explicit copy action with a compatibility preview.

### 7.3 Node catalog

All executable nodes have a version, input/output contract, effect classification, timeout, and policy requirements. The following catalog defines the full requested release; the implementation plan stages it into vertical slices.

| Category | Node | Semantics |
|---|---|---|
| Entry/output | Start, End | Validate workflow inputs; return exactly one selected terminal result per root execution path. |
| Instructions | Instruction, Prompt template | Build labeled instructions/context. Instruction can call a selected agent; a pure template does not call a model. |
| Agents | Main agent, User agent | Resolve a native/CLI definition revision, pass explicit context, validate structured output, retain child transcript. |
| Deterministic code | Script | Run a stored asset directly through ScriptRunner. |
| Functions | Transform, Select fields, Filter, Reduce, Format | Evaluate the bounded expression AST; no arbitrary host code. |
| Integrations | Built-in tool, MCP tool | Call a pinned tool identity/schema with typed bindings through central policy/dispatcher. |
| Skills | Load skill | Attach a resolved skill revision to a named downstream agent context; loading instructions does not execute scripts. |
| Browser | Browser session, Observe, Action, Extract, Browser task | Create/reuse a profile session, perform deterministic steps or a bounded agent browser loop, return artifacts and verified results. |
| Branching | Condition, Switch | Evaluate typed predicates; emit one selected control port and mark others skipped. |
| Iteration | For each, Bounded repeat | Run a subgraph with item/index or loop state; require maximum iterations and duration. |
| Parallelism | Parallel, Join | Launch isolated branches with max concurrency; join policy is all-success, collect-results, or first-success. |
| Composition | Subworkflow | Invoke a pinned workflow with separate run linkage; enforce depth and dependency-cycle limits. |
| Interaction | Ask user, Approval | Persist prompt/action proposal and answer schema; pause without manufacturing a response. |
| Timing | Delay, Wait for condition | Persist wake-up/deadline and re-evaluate; no long-held in-process sleep as durable state. |
| Files/artifacts | Read input, Write artifact, Render report | Access scoped artifacts or authorized workspace files; publish typed artifact references. |
| Resilience | Try/Catch, Finally, Fail | Explicit subgraph error boundaries and cleanup; cleanup cannot erase an ambiguous external effect. |
| Annotation | Note, Group | Editor-only documentation, no runtime effect. |

Timers, schedules, and channel/webhook triggers reference workflow definitions through the existing scheduler/channel ingress. They are not hidden always-on listeners launched by opening a graph. The editor can display trigger bindings without storing live service credentials inside the bundle.

### 7.4 Graph semantics and concurrency

Compile the definition into an immutable intermediate representation. Node execution order is determined by control tokens and data dependencies, not by canvas position. A node becomes ready only after its selected predecessors complete and its inputs are available. Each invocation receives a unique instance key containing the nesting/iteration path.

A condition marks unchosen branches skipped. An all-success join waits for the branches launched by its corresponding Parallel node, not for statically unreachable branches. **collect-results** returns ordered success/error entries. **first-success** cancels remaining branches, waits for cancellation settlement, and includes any already-committed external effects in the run report.

Default maximum parallelism is four node instances per workflow and a configurable installation resource budget across profiles. Apply fair scheduling so one profile's long workflow cannot starve another. Parallel model calls share parent token/cost limits; parallel mutating agents use separate worktrees. Two scripts must not concurrently write the same workspace without declared disjoint ownership or serialization.

Bounded repeat exposes previous iteration output explicitly. For-each preserves input order in its collected result regardless of completion order. A failed item follows the selected fail-fast/collect-errors policy. Recursive subworkflow references and unbounded loop expansion fail compilation.

### 7.5 Durable run state and recovery

~~~mermaid
stateDiagram-v2
  [*] --> queued
  queued --> running
  running --> waiting_input
  running --> waiting_timer
  running --> cancelling
  running --> succeeded
  running --> failed
  running --> recovery_required
  waiting_input --> running
  waiting_timer --> running
  waiting_input --> cancelling
  waiting_timer --> cancelling
  cancelling --> cancelled
  cancelling --> recovery_required
  recovery_required --> running: reconciled
  recovery_required --> failed: cannot resume
  succeeded --> [*]
  failed --> [*]
  cancelled --> [*]
~~~

The durable run manifest records owner, workflow revision, dependency lock, input artifact, thread/project, trigger ID, policy snapshot, limits, current state, journal sequence, and timestamps. Node attempts record input/output hashes, effect intent, effect outcome, process/child IDs, timeout, retry reason, and compensation metadata.

Write **attempt-prepared** before dispatching an effect, then **attempt-completed** with the result reference. A run lease with heartbeat and fencing prevents an old daemon/worker from publishing results after another owner recovers the run. Use immutable result files and an atomic manifest selecting committed journal progress. Derived UI traces can be rebuilt from the journal.

Exactly-once execution of arbitrary external effects is not promised. Read/pure nodes may retry from durable inputs. For an API offering idempotency keys, persist one before dispatch and reuse it on a retry. If an external write times out or the daemon crashes between effect and acknowledgment, mark the attempt **outcome-unknown**, inspect provider state if possible, and require reconciliation before replay.

Script exit, agent completion, and tool transport success are separate from the workflow's business success condition. Validate outputs and postconditions. A nonzero script exit, malformed JSON, missing artifact, wrong schema, or failed browser postcondition is an explicit node failure.

Cancellation stops new scheduling, aborts calls where supported, terminates owned process trees through platform adapters, requests child-agent cancellation, and checkpoints settled results. After a bounded grace period, mark noncancelable external work unknown/recovery-required. The UI must not claim that a network effect was reversed merely because Cancel was clicked.

An approval or timer wait persists the logical thread reservation and releases execution resources at a checkpoint. New messages in the same thread can steer/cancel/answer the run; unrelated work queues or forks into another thread. On resume, reacquire leases in the established thread-before-repository order and verify workspace/context revisions before executing.

Retry-from-node creates a new continuation/run lineage with validated prior outputs; it never edits old journal records. Compensation is an explicit handler and may itself fail. Git undo can compensate repository changes using existing thread actions, while browser submissions, sent messages, payments, and remote writes remain external effect records.

### 7.6 ScriptRunner and direct code execution

**ScriptRunner** receives an immutable asset snapshot, interpreter identity, structured input, working directory token, granted environment names, policy context, and AbortSignal. Use argument arrays and a platform subprocess adapter; never concatenate model input into a shell command. PowerShell, Bash, and Python support is added as explicitly configured interpreters after the initial Node runner.

Stdout is one bounded JSON result; stderr is bounded diagnostic text. Set limits for stdin bytes, stdout/stderr bytes, elapsed time, memory/process resources where the adapter can enforce them, and output artifact bytes. Large results go to an artifact file with validated metadata. Track interpreter version and executable checksum/path for reproducibility.

Execution modes are **trusted-local** and **sandboxed**. Trusted-local runs reviewed code with the OS user's authority, scrubbed environment, and run-owned staging paths; these reduce mistakes but are not a security sandbox. Sandboxed execution must use an actual supported OS/container isolation adapter and declare its filesystem/network/process restrictions. If that adapter is unavailable, the run fails with **SANDBOX_UNAVAILABLE**; it never downgrades silently.

No in-daemon eval, Node vm as a security boundary, auto-install hooks, or hidden dependency installation is allowed. If a script requires a package/runtime, dependency preflight reports the missing requirement and the Add/Setup flow installs only after an explicit user action. Permission grants bind to the reviewed executable content hash and scope; changed code invalidates applicable trust.

### 7.7 Scheduler, channels, and unattended work

Replace prompt-only schedule runner coupling with a typed target: **prompt**, **agentDefinition**, or **workflowRevision**. Capture profile, project, thread/create-thread policy, timezone, input values, dependency revision, and unattended authorization at schedule creation. Fix the existing gap where a schedule's project/thread metadata is not passed into its isolated runner.

Reuse scheduler claim/heartbeat/fencing concepts. A scheduled workflow has a deterministic trigger ID so a repeated tick cannot create duplicate runs. Missed schedules follow skip, run-once, or bounded catch-up policy. Timezone/DST handling remains explicit and tested.

Channel connections and pairings select a profile before command parsing. A webhook or message cannot choose another profile through its text. For shared platform bot identities, routing must have one canonical credential owner and an explicit destination map; otherwise reject duplicate use of the same token across profiles. A single installation listener may dispatch to profile-scoped webhook routes to avoid port conflicts.

Unattended runs may use previously granted scoped capabilities. If new approval/login input is required, persist **waiting_input**, notify only the owning profile's configured surfaces, and expire by policy. Absence of a GUI or elapsed time is never approval.

### 7.8 Workflow Editor layout and interactions

Use **@xyflow/react** as the proposed canvas library, with Mousse's graph model as the authoritative data structure. React Flow supports custom nodes and keyboard/accessibility behavior; serialize through an explicit Mousse adapter rather than making library-specific node state the workflow format. [^18] and [^19] document the relevant primitives.

The editor contains a 240-pixel searchable component palette on the left, a flexible graph canvas, a 320–400-pixel inspector on the right, and an expandable bottom panel for validation, run traces, and assets. Both sidebars can collapse. The top toolbar offers Back, name/scope, draft/saved status, Undo/Redo, Validate, Inputs, Run, Run draft, Publish version, and an overflow menu for import/export/history.

The palette groups nodes by purpose and includes installed user agents, selected MCP tools, skills, and reusable subworkflows. Drag or keyboard insertion creates a node with a stable ID. Ports distinguish control and typed data. Invalid connections show an explanation immediately; server compilation is still authoritative.

The inspector edits the selected node's settings, input bindings, output schema, retry policy, effect class, and timeout. Instructions use MarkdownDocumentEditor; scripts open the code asset editor with a file tab and runtime requirements. A schema-aware binding picker lists only values available on the selected path.

Provide canvas pan/zoom, fit, minimap, snap-to-grid, optional auto-layout, multi-select, duplicate, copy/paste, grouping, undo/redo, and find-node. Clipboard data is validated on paste. Auto-layout updates visual metadata only. Keep execution revision unchanged when only moving a node.

A Source view exposes workflow.json with schema validation. Invalid source remains a recoverable draft; it does not overwrite the last valid graph. Source-to-graph and graph-to-source round trips preserve unknown metadata. Switch only after parse success or retain the invalid source with a visible status.

The graph has an accessible structured outline/table alternative for selecting nodes, editing inputs, and creating edges without dragging. Include meaningful tab/tabpanel roles in shared TabBar, keyboard help, focus restoration, screen-reader announcements, and non-color status indicators.

Run mode overlays a read-only graph with queued/running/waiting/succeeded/failed/skipped states. Selecting a node shows sanitized input/output, duration, retries, artifacts, child run, and error details. Execution does not mutate the draft. A test mode can use recorded/mock tool fixtures, but **dry-run** must mean validation and execution preview only; it must not perform model calls, shell commands, or remote writes unless the user starts a separately labeled test run.

## 8. Shared APIs, events, approvals, and artifacts

### 8.1 Method families

| Family | Proposed operations | Ownership and behavior |
|---|---|---|
| profiles | list, create, get, update, bind, pause, archive, restore | Installation dispatch validates ownership and binding; metadata results are intentionally limited. |
| agentDefinitions | list, get, saveDraft, validate, publish, duplicate, archive, import, export, test | Profile registry, revision preconditions, dependency diagnostics. |
| workflows | list, get, saveDraft, validate, publish, import, export, inspect | Profile/project visibility and source/asset limits. |
| workflowRuns | start, get, list, subscribe, cancel, answer, reconcile, retry | Durable run ownership, idempotent start request IDs, bounded replay. |
| skills | list/read/refresh plus create, import, update, validate, enable, archive, export | Managed package operations; external discoveries remain read-only unless explicitly imported. |
| mcp | Existing diagnostics plus create, update, remove, inspectTools, connect, disconnect | Profile-owned server definitions and server-side secret references. |
| browserSessions | create, list, get, observe, act, takeControl, releaseControl, close | Session/control lease ownership and capability checks. |
| approvals | get, listPending, respond | Durable action hash, profile, expiry, authorized responder. |
| artifacts | stat, readChunk, export | Opaque references; bounded reads; owner validation on every access. |

Keep existing public operations where possible and add aliases/migrations deliberately. Update shared types, protocol allowlist, validators, handlers, LocalMmsClient, Electron IPC, preload, and event bridge together through a single contracts owner.

### 8.2 Error contract

Every error has **code**, safe **message**, **retryable**, **correlationId**, and optional typed **details**. Useful codes include **PROFILE_MISMATCH**, **PROFILE_NOT_READY**, **REVISION_CONFLICT**, **WORKFLOW_NOT_FOUND**, **COMMAND_AMBIGUOUS**, **INVALID_GRAPH**, **DEPENDENCY_MISSING**, **MODEL_CAPABILITY_MISSING**, **PERMISSION_REQUIRED**, **SANDBOX_UNAVAILABLE**, **BUDGET_EXCEEDED**, **STALE_OBSERVATION**, **TARGET_DETACHED**, **MCP_AUTH_REQUIRED**, **EFFECT_OUTCOME_UNKNOWN**, and **RECOVERY_REQUIRED**.

Validation errors include JSON pointer/node ID and remediation; transport/internal errors do not expose raw secrets, environment dumps, or another profile's paths. Clients map codes to Retry, Repair dependency, Open source, Sign in, Review action, or Resume recovery rather than showing a generic toast.

### 8.3 Durable approval and authorization

An approval record contains the requesting profile/run/node, action class, resource/origin, sanitized proposed action, content/argument hash, policy version, expiry, and requested scope. Grant matching runs in MMS. Existing explicit authorization can satisfy matching actions without repeated prompts. New scope or changed material content requires a new decision.

Responses use approval ID plus expected revision and one-use nonce. A response from another profile/client scope, a replayed response, or an expired nonce fails. Approvals survive daemon restart, but browser actions must reobserve the page after resume and confirm the target/proposal still matches before execution.

The same service handles workflow approvals, MCP permission expansion, and browser effects. This is execution policy, not a blanket confirmation before every ordinary read, edit, or harmless browser navigation.

### 8.4 Events and large payloads

Use events such as **agentDefinitions.changed**, **workflows.changed**, **workflowRuns.updated**, **workflowNodes.updated**, **integrations.changed**, **browserSessions.updated**, and **approvals.requested**. All personal events include profile ID and revision; reconnection starts from an authoritative snapshot/cursor.

The current protocol frame limit is 4 MiB. Screenshots, recordings, full tool results, and archives travel as artifact references and bounded chunk reads, not giant JSON/base64 events. Chunk reads use byte offset, length, content hash, and owner checks; a read range cannot bypass file scope. Bound subscriber queues and coalesce UI progress updates so traces cannot starve cancellation or chat responses.

## 9. MCP and Skills reliability and product design

### 9.1 Integration architecture

Retain existing MCP SDK transports and discovery adapters. Introduce one **IntegrationCatalog** for managed installations plus external discoveries, and one **EffectiveIntegrationResolver** for profile/project/actor grants. The same resolution result determines the tools advertised to the model and those permitted at execution.

Keep three distinct concepts: discovered, installed, and enabled. A discovered external config is visible with provenance but is not silently rewritten. A managed installation has a stable ID and revision. Enablement can be inherited or overridden by an agent/workflow run within the profile's policy.

For CLI agents, materialize the resolved integration set in the owned workspace using existing AgentConfigManager adapters. Include native Mousse roots in discovery. Never overwrite unrelated CLI config or remove files that the materializer did not create. Generated file manifests and hashes determine cleanup ownership.

### 9.2 Skills: Add, Create, Upload, Edit

Consolidate the current separate Tools/Skills settings entry points into a proposed **Integrations** settings area with **Skills**, **MCP connections**, and **Built-in tools** sections. WG0 owns the navigation/extraction change; existing deep links redirect to their corresponding section. This is a proposed navigation change, not a description of the current settings layout.

Place a persistent **Add skill** button in Settings → Integrations → Skills and in the skill picker used by Agent Editor. The empty state has the same primary action. The menu offers **Create skill**, **Import folder**, **Upload ZIP**, and **Import from Git URL**; a single SKILL.md file can be imported as a minimal package.

The Create flow asks for name, when-to-use description, and scope, then opens a skill editor with Source/Preview instructions and a package tree for scripts, references, and assets. Provide starter instructions with placeholders, metadata validation, optional examples, a Test in new thread action, and Save/Enable controls. Save never runs a script.

Agent Skills defines a SKILL.md entry with required name/description metadata and optional sibling resources. Mousse should use a standards-capable bounded YAML parser for front matter and validate the documented field constraints, rather than extending the existing handwritten subset indefinitely. Experimental fields such as allowed-tools remain compatibility metadata subject to Mousse grants. [^11]

Imports stage packages, reject traversal/symlink/device-path attacks and archive bombs, parse metadata, summarize executable assets, and show duplicate/replacement choices. Git import resolves a specific revision and verifies the requested subdirectory before installation; do not auto-pull a moving branch at run time. Preserve package license/provenance.

Installed cards show enabled status, source, scope, version/hash, required tools/runtimes, consumers, and health. Actions include Edit, Duplicate, Export, Refresh, Test, Disable, and Archive. External discoveries show **Import a copy** instead of a misleading Save action. A replacement publishes atomically and keeps old revisions for existing runs.

Discovery uses normalized canonical paths and explicit precedence: agent/run pin, profile-selected project installation, profile-managed installation, then enabled external discoveries. Duplicate names show their sources. Resolve by stable ID internally and use explicit selection when names collide.

A user refresh invalidates caches before discovery and emits one profile-scoped change event. Cache keys include profile, project, roots revision, and relevant file metadata; file watcher changes debounce into a bounded rescan. Skill bodies load on demand so large libraries do not consume the entire model context.

### 9.3 MCP: Add/Connect wizard

Place **Add MCP connection** above the server list, also reachable from Agent Editor. The wizard has these steps:

1. **Connection:** name and Remote URL or Local command. Offer Paste config and Import discovered connection as alternatives.
2. **Transport:** Streamable HTTP preferred for new remote connections; stdio for local processes; legacy SSE explicitly labeled for compatibility.
3. **Authentication:** None, secret-backed headers/token, or OAuth. Secret values are entered through dedicated fields and stored outside exported config.
4. **Inspect:** validate executable/arguments or URL, connect, negotiate protocol/capabilities, list tools with pagination, and display permissions/data destinations.
5. **Enable:** choose main agent, selected user agents, and project scope; show effective grants.
6. **Finish:** save a native Mousse connection and show a verified connection result. Optional tool invocation is a separate explicit test action with validated arguments.

The MCP specification defines stdio and Streamable HTTP, with legacy HTTP+SSE compatibility. Use negotiated protocol versions and the official SDK rather than inventing a transport. Treat transport disconnect separately from cancellation; a lost response does not prove that a tool did not execute. [^12]

Try anonymous access when configured as None. Enter OAuth only on configured authorization or a relevant challenge; report authentication failure distinctly from DNS/TLS/HTTP/protocol/schema errors. OAuth credentials bind to profile, canonical server/resource identity, client identity, and scopes, with PKCE/state and issuer/resource validation as required by the negotiated flow. Never pass one server's token to a redirected unrelated origin. [^13]

### 9.4 MCP runtime correctness

Key connection pools by **profileId + projectScope + installationId + configRevision + authIdentity**. Deduplicate concurrent connection attempts with one promise/state machine. Use stable installation IDs rather than mutable display names; tool aliases include a collision-resistant short identity suffix when needed.

Connection states are **disabled**, **discovered**, **connecting**, **connected**, **auth-required**, **degraded**, and **error**. A missing server is an error, not a successful zero-tool test. A valid server with zero tools can still be connected and may expose resources/prompts; report that accurately.

Preserve tool input schemas, output schemas, structuredContent, content blocks, resource links, image artifacts, and isError. Map these to model-adapter result types and UI artifacts without stringifying image base64 into text. Paginate tool discovery and invalidate on list-changed notifications. MCP's tool contract documents schema/content/error distinctions; use its annotations as hints, not authority for automatic execution. [^14]

Propagate AbortSignal into supported SDK requests. On timeout, cancel the underlying call where supported, stop owned stdio children when required, and settle connection state. A Promise.race timer alone is insufficient. Never automatically replay an uncertain mutating tool call; an idempotent read may retry under bounded policy.

Support reconnect/backoff with jitter, configurable deadlines, server stdout contamination diagnostics, stderr log truncation, missing executable/env detection, tool-schema incompatibility, and expired OAuth refresh handling. Do not auto-approve server-initiated sampling/elicitation/roots access; negotiate only implemented capabilities and route supported requests through profile policy.

The server inspector shows tool schemas, required inputs, last health check, latency, transport, authenticated account label, redacted logs, and Restart/Reconnect/Disable/Delete. Deletion disables future access first, settles active calls, removes only owned configuration/credential references, and preserves run history.

### 9.5 Integration acceptance matrix

| Journey | Required result |
|---|---|
| Create skill → Save → Enable → invoke from main agent | Newly saved body loads immediately with correct provenance. |
| Upload skill with script → select in native child agent | Same pinned package visible in that child's owned context, with child grants. |
| Edit skill while a workflow runs | Current run retains pinned bytes; next run sees the new revision. |
| Same skill/server name in two profiles/projects | No connection/body/tool alias cross-contamination. |
| Anonymous remote MCP | Connect and list/call allowed tool without OAuth prompt. |
| OAuth MCP | Correct profile account, cancellation, expiry, refresh, revoke, and relogin behavior. |
| stdio MCP missing command or malformed stdout | Actionable diagnosis and no leaked orphan process. |
| Tool returns structured object, image, resource link, isError | Correct data reaches model/UI with bounded artifacts and failure semantics. |
| Disabled tool invoked by a model/CLI child | Execution refuses even if an old schema remains in model context. |
| Refresh after create/edit/delete | Authoritative new catalog; no 30-second stale result. |

## 10. Browser use: research and Mousse design

### 10.1 Research findings

There is no defensible single “best browser use” ranking across all websites, models, permissions, latency budgets, and benchmarks. The useful comparison is architectural: what the model observes, how it identifies targets, how actions execute, how completion is verified, and how failures and credentials are handled. The sources below were accessed on September 11, 2026; moving documentation/main branches must be rechecked and pinned during implementation.

| System / primary source | Documented approach | Strength relevant to Mousse | Limitation / interpretation |
|---|---|---|---|
| Browser Use | Its DOM service obtains DOM snapshots/document data and accessibility information, including frame-aware AX retrieval. Agent configuration offers vision and execution controls. [^1] [^2] | Combine semantic structure, geometry, frames, and optional vision; keep browser state as a first-class execution input. | Source architecture is evidence of a technique, not proof of task success on Mousse's target workloads. Its Python agent runtime is not adopted. |
| Stagehand | Separates natural-language action selection from replaying an observed Action; documents self-healing and caching. Current v4 documentation limits server-side caching to Browserbase-backed usage. [^3] [^4] | Turn discovered actions into explicit, inspectable steps and reuse validated deterministic actions when the page still matches. | Cache locality/availability varies by product version. Mousse needs its own local cache and validity rules rather than assuming hosted behavior. |
| Playwright | Actionability checks include unique targeting, visibility, stability, event reception, enabled/editable state as appropriate. [^5] | A model's chosen target still needs deterministic actionability and postcondition checks. | These primitives reduce flaky input; they do not reason about the user's goal or establish authorization. |
| Playwright MCP | Exposes structured accessibility snapshots and browser tools; its maintainers discuss the context-cost tradeoff between persistent MCP introspection and concise CLI/skill operations. [^6] | Structured browser use can work without a vision model; return targeted observations rather than repeated full trees. | “No vision needed” describes the structured path, not universal coverage of canvas/image-heavy sites. |
| Skyvern | Describes LLM/computer-vision browser workflows and a workflow builder, using browser automation underneath. [^7] | Visual grounding and workflow composition belong together when sites vary. | Vendor capability claims are not independently reproduced here. Do not copy a multi-agent architecture before measuring whether it improves cost-adjusted outcomes. |
| OpenAI computer use | The application executes ordered requested actions and returns updated screenshots through the documented computer-use result loop. [^8] | Native model tool formats need an adapter and accurate screenshot geometry; a generated call is not an already-executed action. | Model/API/schema support changes. Mousse's generic tool loop cannot assume every provider SDK passes native computer-use items through. |
| Anthropic browser use | The documented client toolset supports element references and viewport coordinates, page reading, tab context, and optional higher-risk members. The application implements the executor. [^9] | A provider-native browser interface can map onto the same semantic/visual runtime. | Input validation and policy enforcement still belong to the application; API-declared limits are not sufficient enforcement. |
| Google Gemini computer use | Uses a model/action/result loop and client execution environment, with version-specific coordinates and safety decisions. [^10] | Isolate coordinate and result serialization per adapter; carry provider-required confirmations through Mousse's approval service. | Legacy and current model variants differ. Do not hardcode one coordinate scale or ignore a required confirmation. |
| BrowserGym | Provides a common research environment for multiple browser-task benchmarks, including WebArena, VisualWebArena, and WorkArena. [^20] | Evaluate one executor/model configuration against diverse tasks with a reproducible harness. | Benchmark results depend on task setup and evaluation rules; they do not establish reliability on every live site. |

The recommended synthesis is **semantic-first browser control with selective vision, explicit actions, bounded recovery, and durable evidence**. This is an engineering inference from the documented patterns, not a claim that a particular vendor implementation has been reproduced or surpassed.

Three approaches were considered. Screenshot-only control covers visual widgets but pays repeated image/context cost and has coordinate fragility. DOM/AX-only control is efficient and inspectable but cannot fully understand canvas layouts or visual ambiguity. A hybrid path lets ordinary tool-calling models use structure and lets image-capable or native computer-use models request screenshots when structure is insufficient.

Do not optimize solely for click success. A successful click can select the wrong record, submit a duplicate form, or fail to achieve the task. Measure end-state correctness, duplicate effects, recovery quality, human intervention, and total cost separately.

### 10.2 Build boundary and backend choice

**Product decision, clarified 2026-09-11: Browser Use must operate Mousse's existing in-app browser tabs.** In the GUI, the default target is the selected, authorized tab already displayed in BrowserPanel, backed by an **Electron-attached backend**. Users watch the actual page, take control, and resume the agent in that same tab. Support for this surface is a release requirement, not a later optional backend.

An MMS-owned **managed Chromium backend**, controlled by a dedicated Mousse browser worker, supports CLI, scheduled, and explicitly headless runs. Both backends use the same BrowserSessionManager, tool contracts, policy, and observation/action semantics. Managed sessions are accessible from the same BrowserPanel tab strip through a viewer when no embedded page exists. Closing the GUI preserves managed runs; it interrupts attached runs. Never silently replace a selected embedded tab with a separate browser context or transfer its cookies to managed Chromium.

The browser worker owns CDP transport, target/frame tracking, observation extraction, element references, actionability, input execution, and postcondition checks. It contains no model credentials and makes no model calls. MMS owns the model loop, policy, budget, approval, artifacts, and durable run state.

CDP exposes the browser primitives required for target/context management, DOM/accessibility observation, and input. Some domains/methods are experimental or vary with Chromium version; pin a tested browser build and capability-test methods rather than treating tip-of-tree protocol documentation as a stable binary contract. [^15] [^22] [^16] [^17] [^23]

Use a private inherited pipe/handle transport where supported, implemented by a platform adapter. If a supported platform requires a local debug endpoint, bind loopback, keep its address/token out of logs and renderer payloads, and protect broker access. The debug channel is privileged browser access; it is never exposed as a public service.

Preserve the existing BrowserPanel webviews for the initial integration. Electron main registers only guests observed through the owning window's `did-attach-webview` event, after `will-attach-webview` enforces the bound profile partition and remote-page restrictions. An opaque UI tab ID maps to that trusted guest registration; renderer-supplied webContents IDs are never sufficient authority. The unused single-tab BrowserViewManager must not become a second automation browser. A future embedding migration must retain the same public tab/session identity and acceptance tests.

Electron main owns the guest's debugger transport and lifecycle. Its typed backend adapter implements the common observation, action, wait, extraction, and control protocol, reusing Mousse's deterministic extraction/action primitives where possible. Electron's debugger API provides commands and target-session events; navigation readiness and debugger detachment require explicit handling. Raw CDP, arbitrary evaluation, native handles, and model credentials are never exposed to the renderer, page, or model. [Electron debugger API](https://www.electronjs.org/docs/latest/api/debugger), [webContents guest lifecycle](https://www.electronjs.org/docs/latest/api/web-contents).

The daemon communicates with the attached executor through an authenticated, connection-owned backend bridge. Registration is bound to profile ID, window/client identity, connection epoch, and trusted guest identity. Every command additionally binds session, thread/run ownership, document generation, observation, and control lease. Reconnect, profile switch, guest destruction, or debugger detachment revokes the old registration before further dispatch. Pending actions that may already have reached the page return `unknown-effect`; recovery never repeats a consequential action merely because its reply was lost.

The initial backend contract includes:

| Concern | Electron attached | Managed Chromium |
| --- | --- | --- |
| User surface | Existing live BrowserPanel tab and its current page state | BrowserPanel session tab with worker viewer |
| Target selection | Explicit eligible in-app tab; profile and thread ownership checked by host | Explicit managed workspace or isolated new context |
| Login/storage | Existing profile-partitioned embedded browser state | Separate profile-owned managed workspace; no automatic cookie copying |
| Authority | MMS policy plus trusted window/guest registration and control lease | MMS policy plus owned worker/session and control lease |
| Human takeover | Revoke agent lease, fence queued input, enable normal embedded-page input | Revoke agent lease, fence queued input, enable viewer input |
| Resume | Disable human input, issue a new lease and fresh observation | New lease and fresh observation from the worker |
| GUI close/crash | Disconnect attached session, retain evidence, interrupt dependent run | Detach viewer while daemon-owned execution can continue |
| Tab close/navigation | Invalidate handles/refs; close or reobserve the same identity as appropriate | Equivalent invalidation through worker target lifecycle |
| Unsupported methods | Explicit capability/error; no silent fallback to another tab/backend | Explicit capability/error for the certified binary |

BrowserPanel must remain mounted, or retain its guest owner independently, when users switch to another Mousse main view. Agent control cannot depend on the Browser view being visibly selected. While an agent lease is active, keyboard, pointer, toolbar navigation, element picking, and devtools paths must obey the same control ownership. The visible Take Control action remains available. Profile changes revoke attached registrations before the new profile can mount pages; pinned tabs do not bypass profile or thread/run admission checks.

Required release evidence uses the real Electron app and an owned local fixture: manually open a tab; let an agent observe and fill that very page; verify the change in its live viewport; take control while a click is pending; verify no stale agent input reaches the page; edit manually; resume using fresh refs; switch main views and profiles; close/reopen the GUI. Also prove managed CLI continuity and denied cross-profile session/artifact access. A screenshot-only viewer test or a standalone Chrome success does not satisfy the in-app tab requirement.

An Electron backend uses sandboxed web contents, no Node integration in remote pages, context isolation, validated IPC senders, permission handlers, and navigation/new-window controls, following Electron's documented security boundaries. No Mousse application preload or dev-GUI evaluation bridge is exposed to websites. [^21]

### 10.3 Browser lifecycle and profile ownership

**BrowserBinaryManager** resolves a certified installed binary or an app-managed pinned distribution. The setup screen shows version, location, download size, and readiness; missing binaries produce an explicit setup requirement. Distribution updates use verified metadata/checksums and an atomic activation, with rollback to a previously certified build. Packaged offline behavior and the CLI installer must be tested independently.

A **BrowserWorkspace** represents persisted login/storage state within one Mousse profile. A **BrowserSession** represents one automation/control lifetime. Default runs use an ephemeral browser context. Selecting “Remember this browser workspace” creates a persistent workspace with a stable ID. Concurrent reuse of persistent state is serialized through a workspace lease; never start two Chromium processes writing one user-data directory.

Contexts isolate cookies, local/session storage, IndexedDB, service workers, cache, permissions, and download routing. A browser session is keyed by profile, workspace, run/thread, browser process generation, and context ID. Raw CDP IDs are internal; the model sees opaque tab/session references.

Lifecycle states are **starting**, **ready**, **agent-controlled**, **human-controlled**, **waiting-approval**, **disconnected**, **recovering**, and **closed**. Each state transition updates the durable session record and revokes obsolete control/reference tokens.

MMS owns managed browser child processes by launch identity, process start time, and broker token. Worker shutdown closes only its owned contexts/processes. A GUI disconnect removes a managed viewer without ending its run; it revokes Electron-attached sessions and interrupts their dependent operations. A worker/browser crash interrupts pending actions and triggers recovery evaluation; in-memory DOM refs are never reused after restart. Attached tabs retain their current profile partition; the ephemeral-context default applies to newly created managed sessions.

Legacy browser data is assigned only to Default during profile migration. Both **BrowserPanel** webview partition creation and **BrowserViewManager/browserPolicy** must stop using a universal partition. Manual cookie/cache clearing targets a selected profile/workspace and reports whether active runs must pause.

### 10.4 Observation pipeline

An observation contains:

~~~typescript
type BrowserObservation = {
  sessionId: string;
  tabId: string;
  generation: number;
  observationId: string;
  documentId: string;
  capturedAt: string;
  url: string;                 // sanitized for the caller
  title: string;
  viewport: {
    cssWidth: number;
    cssHeight: number;
    deviceScaleFactor: number;
    scrollX: number;
    scrollY: number;
  };
  tabs: Array<{ id: string; title: string; url: string }>;
  elements: Array<{
    ref: string;
    frameRef: string;
    role?: string;
    name?: string;
    text?: string;
    bounds?: { x: number; y: number; width: number; height: number };
    states: string[];
  }>;
  screenshot?: {
    artifactId: string;
    pixelWidth: number;
    pixelHeight: number;
    cssToImageScaleX: number;
    cssToImageScaleY: number;
    cropOriginCss?: { x: number; y: number };
  };
  truncated: boolean;
  continuation?: string;
  warnings: string[];
};
~~~

The worker first resolves the selected tab and frame tree, samples document/navigation identity, and collects AX/DOM/layout state. It combines semantic roles/names with visible text and interactive elements, retaining headings, form labels, validation messages, dialogs, and navigation landmarks. DOM nodes missing useful accessibility metadata receive bounded text/geometry fallback.

Observation extraction is not atomic across all CDP methods. Sample document/layout epochs before and after collection; retry once if navigation or major mutation made the result inconsistent. Mark a partial frame/detached subtree explicitly instead of fabricating completeness.

The reducer removes script/style content and unrelated hidden controls, deduplicates repeated text, limits attribute lengths, and prioritizes the viewport and requested region. It must not remove the label/error text that explains a form field. Return a targeted subtree or search result when possible; attach full artifacts only for inspection.

Start with a target budget of roughly 12,000 characters for default structured observations, configurable by model context. Return truncation and a continuation cursor. Keep selectors, raw HTML, and page JavaScript internal by default. Treat text and image content as untrusted page data in model prompts.

The reference store maps an opaque ref to session generation, tab, frame, document, backend DOM identity, semantic fingerprint, and observation ID. References are scoped to what was actually observed. They are not stable across navigation, context replacement, or arbitrary page rerender.

Support ordinary and out-of-process iframes through target/frame session mapping. Track open shadow roots where observable. Closed shadow DOM and canvas widgets may require vision; inaccessible content produces a limitation/handoff rather than bypassing web security. Cross-origin page data stays within the authorized browser session and origin policy.

Screenshot capture is on demand for visual models or when the structured observation is insufficient. Store exact crop/scale/viewport metadata so model coordinates can be transformed correctly. Mask password values in DOM/AX output; screenshots can still reveal sensitive visible content, so redact known regions or pause before sending when a safe mask cannot be established. Do not promise that arbitrary sensitive text can always be detected automatically.

### 10.5 Action API and execution transaction

Expose a small core tool set to generic tool-calling models:

| Tool | Inputs | Output |
|---|---|---|
| browser_open | URL, ephemeral/persistent workspace choice | Session/tab and initial observation. |
| browser_tabs | list/new/switch/close, explicit tab ID | Scoped tab list/state. |
| browser_observe | tab, region/ref, depth, optional screenshot | Bounded observation and fresh refs. |
| browser_find | text/role/name query, scope | Matching observed elements with context. |
| browser_act | typed action, observation ID, ref/coordinate, expected result | Verified outcome, changed state summary, artifacts. |
| browser_wait | explicit condition and bounded timeout | Condition result and fresh observation if changed. |
| browser_extract | schema and observed region | Validated extraction with provenance; deterministic extraction by default, model synthesis explicitly attributed. |
| browser_request_human | reason, required operation | Durable handoff state. |

Actions include navigate/back/forward/reload, click/double-click/hover, fill/type/key, select/check/uncheck, scroll, drag, upload, download acknowledgment, and supported dialog handling. Navigate and tab mutations share the same policy and journaling path as other actions even when exposed through a convenience tool.

Prefer semantic refs. Coordinate actions require an image-capable/native adapter, the exact screenshot observation, and verified geometry; convert through that observation's scale/crop transform and reject out-of-bounds coordinates. Never guess which tab a coordinate refers to.

Every action follows this sequence:

1. Validate profile, session, run actor, control lease, action schema, observation generation, and policy scope.
2. Resolve the target. If stale, return **STALE_OBSERVATION** with instructions to reobserve; do not silently target the nearest matching label.
3. Check actionability: unique live target, correct frame/document, visible and enabled/editable where needed, stable geometry, scrolling, and hit testing for occlusion.
4. Classify the effect and match existing authorization. If required, persist a concrete approval before dispatch; after approval refresh and revalidate.
5. Write the action intent and idempotency/recovery metadata.
6. Dispatch trusted input primitives through CDP. For fill, honor focus/events and verify the resulting value; do not set arbitrary DOM properties as an invisible shortcut.
7. Wait for a specific postcondition: target state/value, navigation/document change, expected text, download, or bounded stability. Network-idle alone is insufficient for applications with persistent connections.
8. Record result, observation/artifact references, timing, and effect outcome; return concise evidence to the model.

The default model loop performs one state-changing action per fresh observation. Batches are allowed only for validated dependent primitives, such as focus followed by typing in the same field, and stop on navigation, stale refs, policy boundary, or failure. Provider-native ordered batches are adapted member by member; a gated action prevents later members from running.

Actionability reduces misclicks but does not prove intent. For example, a form submission requires evidence that the target account/item and entered values match the authorized proposal. Verify the resulting page/record before reporting business success.

### 10.6 Model compatibility and adapters

Publish a capability record per provider/model/adapter version:

| Tier | Required capabilities | Enabled behavior |
|---|---|---|
| B0: unavailable | No reliable tool calling, or failed conformance | Browser tools hidden with an explanation in settings. |
| B1: structured | Tool calling and validated structured arguments/results | DOM/AX observation and semantic actions; no screenshot coordinate fallback. |
| B2: hybrid | B1 plus image input and passing screenshot tests | Semantic actions with selective screenshots, visual extraction, and coordinate fallback. |
| B3: native | Provider-native browser/computer-use protocol supported by the adapter | Native action/result serialization mapped onto the same executor/policy. |

Model visibility in a provider catalog is not proof of browser support. The capability record includes tested date, model ID, endpoint, SDK/adapter revision, supported image types/sizes, coordinate convention, tool batching, required continuation items, and known limitations. User-facing status is **Available**, **Experimental**, or **Unavailable** based on conformance tests.

Use existing native Mousse tool calling for B1/B2. Add adapter interfaces around request building, action decoding, result encoding, and state continuation for B3. Preserve provider-required response IDs/tool call IDs and continuation items; never translate away required safety decisions. The currently installed OpenAI/Anthropic/Pi dependencies must be checked against these native schemas before enabling an adapter. A package being installed does not establish compatibility.

Generic tools work across supported providers without pretending every model has a vendor-native browser tool. Native adapter launch order is driven by conformance tests, not model marketing names. Pin explicit model versions in release evaluations and revalidate aliases when their behavior changes.

A main agent may delegate a browser task to a compatible user-created agent if explicitly configured, with the same profile and budget. Do not silently send screenshots to a different provider merely because the selected model lacks vision.

### 10.7 Security, authorization, and data boundaries

Browser authority is narrower than full desktop authority. A webpage cannot request shell execution, read arbitrary local files, change Mousse settings, enable skills, connect MCP servers, or reveal provider credentials. Browser tools are mediated capabilities, not a raw CDP tunnel offered to the model.

Navigation policy validates schemes, canonical hostnames, redirects, new windows, downloads, and frame destinations. Default external navigation permits HTTP(S) under the chosen policy; local development origins are explicitly allowed for coding tasks. Block file URLs, browser-internal URLs, credential-bearing URLs, and unapproved private/link-local metadata destinations. A localhost development grant specifies host/port rather than granting the entire local network.

Navigation checks are not a complete network sandbox. Browser subresources, WebSockets, service workers, DNS changes, and redirects require tested request interception and, for strict egress isolation, a managed proxy/firewall/container boundary. If strict network isolation is requested and unavailable, report that capability as unavailable rather than claiming that a URL allowlist enforces it.

Website content remains untrusted even when retrieved from an authenticated page. Keep task instructions and policy in distinct prompt sections, tag observations with provenance, and forbid page text from expanding authority. Prompt-injection detection can provide a signal but is not relied on as a perfect classifier.

Credential entry uses user takeover or an origin-bound secret handle. The model can request “fill saved login” without receiving the secret value. Do not include cookies, bearer tokens, authorization headers, password fields, or full network bodies in ordinary diagnostics. Clipboard access is session-scoped and explicit; never read the system clipboard by default.

File upload requires an authorized artifact/path grant, exact destination origin, MIME/size checks, and a user-visible filename. The worker receives only a staged file path for the selected upload. Downloads enter a quarantine/artifact directory with generated names and original-name metadata; never auto-open executable downloads.

Maintain authority across long tasks. Routine navigation and preparation proceed under the user's task authorization. New consequential effects, credential use, or provider-required confirmations route through durable approval when existing authorization does not cover them. CAPTCHA, MFA, passkeys, and unsupported login flows hand control to the user; do not build anti-bot bypass or credential extraction as a reliability shortcut.

Arbitrary page JavaScript execution is disabled by default. Built-in observation/extraction code uses a narrow internal implementation. An advanced script capability, if added, must be separately granted, origin-scoped, reviewed, logged, and unable to access MMS or host APIs. The dev-GUI evaluate bridge is never repurposed for this.

### 10.8 Browser viewer and human takeover

The Browser tab shows manual tabs and agent sessions with an explicit control owner, profile, site, and run link. Agent session cards offer **Watch**, **Take control**, **Pause**, **Resume**, **Open run**, and **Close session**. While the agent owns control, viewer input is disabled; while a human owns control, queued model actions are fenced.

The managed backend renders a throttled screenshot stream in the app with correct viewport geometry. Human clicks/keys go through the authenticated broker under a human control lease. Desktop deployments may also reveal the owned Chromium window. Headless CLI deployments can wait for an authorized app/control viewer, or remain paused with a durable handoff; do not promise that a headless browser can always be transformed into a native headed window.

Takeover revokes the agent lease, settles/interrupts the current action, and records a handoff boundary. Human interaction never becomes hidden model authorization for subsequent different actions. Resume captures a new observation, invalidates previous refs, and gives the model a concise statement that the page may have changed.

The trace panel shows observed URL/title, action and target, verified outcome, timing, sanitized errors, screenshots where retained, and approvals. Redaction happens before model/renderer transmission, not merely in the visible trace. Users can export a sanitized trace or delete retained browser artifacts by profile/workspace.

### 10.9 Recovery and limits

| Failure | Behavior |
|---|---|
| Element rerendered/detached | Return stale-target result, refresh the relevant observation, and allow at most a bounded replan. |
| Click intercepted by overlay | Report occluder; observe dialog/overlay rather than force-clicking through it. |
| SPA never becomes network-idle | Use application/element/navigation postcondition with deadline. |
| Tab closes or popup opens | Update tab registry and require explicit target selection; do not execute in whichever tab is active. |
| Browser/worker crashes | Fence actions, preserve intent journal, launch/reconnect only to owned processes, reobserve. |
| Submission acknowledgment lost | Mark unknown effect; inspect resulting state before any repeated submission. |
| Authentication expires | Pause for owning profile's login flow; preserve run state. |
| Repeated identical action/observation | Stop after a bounded no-progress threshold and provide failure context or handoff. |
| Unsupported canvas/closed shadow widget | Use certified vision path or human takeover; do not fabricate a DOM ref. |
| Budget exhausted | Pause/fail at a safe boundary and report consumed/remaining resources. |

Initial defaults are 100 browser actions per task, 15 minutes elapsed, three consecutive no-progress cycles, two replans for a stale-target class, and one mutating action in flight per session. These are tunable proposals and subordinate to tighter workflow/agent/profile limits. Changing defaults requires evaluation evidence.

Persist URLs, logical task state, and selected browser workspace, but do not claim deterministic restoration of a live web application after a crash. An open checkout or editor may have changed server-side. Recovery must inspect reality and distinguish resume from restart.

### 10.10 Evaluation and performance plan

Build a fixture site suite with deterministic end-state verifiers before evaluating live sites. Include forms, dynamic lists, menus, virtualized tables, nested/out-of-process iframes, open shadow DOM, canvas controls, drag/drop, uploads/downloads, popups, authentication expiry, overlays, and navigation races.

Separate three layers:

1. **Executor conformance:** recorded typed actions on deterministic fixtures; verify exact state changes, stale-ref rejection, no duplicate writes, cancellation, and cookie/profile isolation without an LLM.
2. **Agent task evaluations:** the same tasks across B1, B2, and native adapters with fixed prompts, model revisions, budgets, and environment seeds.
3. **External benchmarks:** adapters for BrowserGym-hosted task suites or equivalent reproducible benchmark harnesses; follow each benchmark's observation/action rules and keep test leakage out of tuning.

Report task success with confidence intervals, action success, false-success rate, duplicate side effects, human intervention, median/p95 wall time, tokens/images per successful task, retries, crash recovery, and maximum resource usage. Use at least three trials for nondeterministic model comparisons, and preserve all traces needed to audit failures. More repetitions are required when confidence intervals are too wide for a release decision.

Proposed gates are 100% passing deterministic ownership/policy tests; at least 99% executor success on supported fixture actions across repeated runs; at least 90% end-to-end success on the curated supported-task set; zero false-success or duplicated consequential effects in the release fixture suite; and an explicit Experimental label for adapters below the task gate. These do not imply zero failures on arbitrary websites.

Performance targets on a documented reference machine are p95 structured observation under 1 second on the fixture suite, p95 executor overhead under 300 ms excluding page waits, and no sustained UI stalls over 100 ms during trace streaming. Measure browser memory by active profile/context and cap idle contexts. Heavy full-page captures or inaccessible cross-origin frames are reported separately.

Use semantic-only, screenshot-only, and hybrid ablations to establish whether the proposed complexity improves success per cost. Cache an action only with origin, page signature, target fingerprint, and adapter/schema revision; verify actionability/postconditions on every replay. Never cache secret values, stale refs, or authorization decisions as reusable cross-profile data.

## 11. Quality requirements and rollout

### 11.1 Cross-feature acceptance scenarios

| ID | Scenario | Expected result |
|---|---|---|
| E2E-01 | Create agent with orb palette and Markdown prompt, save, restart, run | Visual preferences persist; exact prompt source/model revision used; active session remains accessible. |
| E2E-02 | Create workflow in canvas, edit source, publish, export/import | Semantic equivalence and stable IDs; visual state preserved independently; no code executes during import. |
| E2E-03 | Invoke identical slash command from GUI and CLI | Same resolved revision/arguments/validation and execution semantics. |
| E2E-04 | Run script → condition → two agents → join → artifact | Script bytes executed directly; branches isolated; deterministic output order; run trace complete. |
| E2E-05 | Switch A to B during chat/workflow/browser activity | B sees only B data; A continues with A grants; late A responses/events are discarded. |
| E2E-06 | A and B use same repository and shared provider | Personal projects/threads isolated; one repository mutation lock; shared provider quota correctly attributed. |
| E2E-07 | A logs out of Plus while B is connected | Only A's account/control grants revoked; provider credentials and B account remain usable. |
| E2E-08 | Add skill and anonymous/OAuth/stdio MCP, invoke from main and child | Exact enabled installation and actor grants apply at schema publication and execution. |
| E2E-09 | Browser agent completes a form with takeover and resume | Human/agent input never races; resume uses fresh refs; final state verified. |
| E2E-10 | Kill daemon after external action dispatch, before result journal | Recovery marks unknown effect and never blindly repeats the action. |
| E2E-11 | Restart during profile migration | One authoritative layout; no lost threads, duplicate schedules, or cross-profile credential copies. |
| E2E-12 | Close GUI during scheduled browser workflow | Managed backend continues or waits durably for required input; Electron-attached backend reports its limitation. |

### 11.2 Operational targets

Profile switching should show a loading shell within 100 ms and reach an authoritative ready snapshot within 2 seconds for a representative installation of 1,000 thread metadata records; do not load every transcript. Agent/library search should respond within 100 ms for 1,000 definitions. Graph interaction should remain responsive at 250 nodes; virtualize trace rows and perform graph validation off the renderer's hot path.

Default retention is configurable: retain run metadata and final artifacts until user deletion; propose 7 days for detailed browser screenshots and 30 days for verbose integration logs. Apply profile byte quotas and active-run protection. Never collect another profile's data to satisfy a cache eviction heuristic. User exports specify whether screenshots, source code, or sensitive artifacts are included.

Log correlation IDs spanning profile, thread, workflow run, node attempt, tool call, browser action, and worker generation. Do not log secrets or raw prompts by default in installation-wide logs. Diagnostic bundles are generated per profile with redaction and a reviewable inventory.

### 11.3 Release phases

**Foundation:** establish contracts, path injection, profile-aware dispatch, shared editor extraction, and integration regression fixes behind internal flags. **Private alpha:** enable agents, core workflows, Add Skill/MCP flows, and managed browser fixtures in a Default profile. **Multi-profile beta:** migration, stale-event defenses, Plus/control routing, background execution, and browser isolation pass together. **General release:** the full node catalog, GUI/CLI parity, supported browser adapters, recovery, packaging, and cross-feature gates pass.

Feature flags can hide incomplete UI or disable new execution. They cannot permit schema-incompatible clients, bypass profile checks, silently downgrade sandbox requirements, or disable effect journaling. Maintain independent emergency switches for browser action execution and MCP invocation that stop new calls while preserving recovery state.

## 12. Decisions, alternatives, and unresolved validation

| Decision | Chosen direction | Alternative and reason |
|---|---|---|
| Runtime owner | Existing MMS daemon with installation/profile composition | Per-window agents would split history, scheduling, credentials, and recovery. |
| Profile routing | Immutable per-request/run context and connection binding | Mutable MOUSSE_HOME/current-profile globals race background work. |
| Providers | Shared catalog and credentials; personal selections | Duplicating provider credentials contradicts the requested sharing model. |
| Plus identity | Profile-owned account/grants with compatibility gate | Reusing one unscoped control session leaks account authority. |
| Workflow format | JSON manifest + assets + lock + editor metadata | YAML-only and UI-library serialization introduce avoidable ambiguity/coupling. |
| Runtime semantics | Compiled control/data graph with explicit loops | Letting a model “interpret” a graph cannot guarantee script/approval execution order. |
| Code | Direct subprocess execution with honest trust/sandbox mode | In-process eval and Node vm do not provide the required isolation. |
| Graph canvas | React Flow with Mousse-owned intermediate representation | Building drag/zoom/accessibility infrastructure adds work without improving core execution. |
| Browser | Existing in-app tabs through Electron-attached executor; managed Chromium for CLI/scheduled/headless, one MMS contract | Users and agents share the current in-app page; managed execution provides independent daemon continuity. Both executors are built by Mousse. |
| Browser perception | Structured observations with selective vision | Single-modality approaches have avoidable coverage/cost tradeoffs. |
| Native model support | Versioned adapters plus conformance | A blanket provider/model allowlist becomes stale and hides SDK limitations. |
| Modes | Preserve, profile-scope, optional copy to definitions | Automatically treating all existing Markdown modes as agents/workflows changes behavior. |

Implementation must validate four items before their corresponding gates: the exact Plus server contract for multi-account/device grants; platform browser packaging/pipe transport; real sandbox adapters and headless secret storage; and exact installed SDK support for native browser/computer-use schemas. The specified fallback is explicit unavailability or a supported generic browser tier, not silently weakened guarantees.

No vendor benchmark was rerun for this document. The research establishes design patterns and a measurement plan, while release claims require the evaluation evidence above.

## Sources

The numbered links below are the source notes for external factual claims. Official documentation without a publication date is identified by its version/path and access date. Repository links on main are moving sources; the browser workgroup must record immutable commit SHAs when implementing or comparing them.

1. Browser Use, [DOM service source](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/service.py), main branch, accessed September 11, 2026. DOM/layout and frame-aware accessibility extraction.
2. Browser Use, [Agent parameters](https://docs.browser-use.com/customize/agent/all-parameters), living documentation, accessed September 11, 2026. Agent/vision controls and execution limits.
3. Browserbase, [Stagehand v4 Act](https://docs.stagehand.dev/v4/basics/act), accessed September 11, 2026. Natural-language selection, deterministic action replay, self-healing.
4. Browserbase, [Stagehand v4 Caching actions](https://docs.stagehand.dev/v4/best-practices/caching), accessed September 11, 2026. Cache behavior and applicability.
5. Microsoft, [Playwright Auto-waiting](https://playwright.dev/docs/actionability), accessed September 11, 2026. Actionability and retrying assertions.
6. Microsoft, [Playwright MCP repository](https://github.com/microsoft/playwright-mcp), main branch, accessed September 11, 2026. Accessibility-driven tooling and context-cost discussion.
7. Skyvern, [Skyvern repository](https://github.com/Skyvern-AI/skyvern), main branch, accessed September 11, 2026. Vision-based browser workflows and builder.
8. OpenAI, [Computer use guide](https://developers.openai.com/api/docs/guides/tools-computer-use), accessed September 11, 2026. Action/result loop and application-owned execution.
9. Anthropic, [Browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool), accessed September 11, 2026. References, coordinates, tab state, executor responsibility.
10. Google, [Gemini API Computer use](https://ai.google.dev/gemini-api/docs/computer-use), accessed September 11, 2026. Model variants, client execution, coordinate and safety handling.
11. Agent Skills, [Specification](https://agentskills.io/specification), accessed September 11, 2026. SKILL.md metadata and package conventions.
12. Model Context Protocol, [Transports, specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), accessed September 11, 2026.
13. Model Context Protocol, [Authorization, specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), accessed September 11, 2026.
14. Model Context Protocol, [Tools, specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), accessed September 11, 2026.
15. Chromium, [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/), accessed September 11, 2026. Protocol versioning and browser control.
16. Chromium, [CDP Accessibility domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/), tip-of-tree, accessed September 11, 2026.
17. Chromium, [CDP DOMSnapshot domain](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/), tip-of-tree, accessed September 11, 2026.
18. xyflow, [React Flow Accessibility](https://reactflow.dev/learn/advanced-use/accessibility), accessed September 11, 2026.
19. xyflow, [React Flow NodeProps](https://reactflow.dev/api-reference/types/node-props), accessed September 11, 2026.
20. ServiceNow Research, [BrowserGym repository](https://github.com/ServiceNow/BrowserGym), main branch, accessed September 11, 2026. Common framework and benchmark inventory.
21. Electron, [Security](https://www.electronjs.org/docs/latest/tutorial/security), accessed September 11, 2026.
22. Chromium, [CDP Target domain](https://chromedevtools.github.io/devtools-protocol/tot/Target/), tip-of-tree, accessed September 11, 2026.
23. Chromium, [CDP Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/), tip-of-tree, accessed September 11, 2026.

[^1]: Browser Use, [DOM service source](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/service.py), main branch, accessed September 11, 2026. DOM/layout and frame-aware accessibility extraction.
[^2]: Browser Use, [Agent parameters](https://docs.browser-use.com/customize/agent/all-parameters), living documentation, accessed September 11, 2026. Agent/vision controls and execution limits.
[^3]: Browserbase, [Stagehand v4 Act](https://docs.stagehand.dev/v4/basics/act), accessed September 11, 2026. Natural-language selection, deterministic action replay, self-healing.
[^4]: Browserbase, [Stagehand v4 Caching actions](https://docs.stagehand.dev/v4/best-practices/caching), accessed September 11, 2026. Cache behavior and applicability.
[^5]: Microsoft, [Playwright Auto-waiting](https://playwright.dev/docs/actionability), accessed September 11, 2026. Actionability and retrying assertions.
[^6]: Microsoft, [Playwright MCP repository](https://github.com/microsoft/playwright-mcp), main branch, accessed September 11, 2026. Accessibility-driven tooling and context-cost discussion.
[^7]: Skyvern, [Skyvern repository](https://github.com/Skyvern-AI/skyvern), main branch, accessed September 11, 2026. Vision-based browser workflows and builder.
[^8]: OpenAI, [Computer use guide](https://developers.openai.com/api/docs/guides/tools-computer-use), accessed September 11, 2026. Action/result loop and application-owned execution.
[^9]: Anthropic, [Browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool), accessed September 11, 2026. References, coordinates, tab state, executor responsibility.
[^10]: Google, [Gemini API Computer use](https://ai.google.dev/gemini-api/docs/computer-use), accessed September 11, 2026. Model variants, client execution, coordinate and safety handling.
[^11]: Agent Skills, [Specification](https://agentskills.io/specification), accessed September 11, 2026. SKILL.md metadata and package conventions.
[^12]: Model Context Protocol, [Transports, specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), accessed September 11, 2026.
[^13]: Model Context Protocol, [Authorization, specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), accessed September 11, 2026.
[^14]: Model Context Protocol, [Tools, specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), accessed September 11, 2026.
[^15]: Chromium, [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/), accessed September 11, 2026. Protocol versioning and browser control.
[^16]: Chromium, [CDP Accessibility domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/), tip-of-tree, accessed September 11, 2026.
[^17]: Chromium, [CDP DOMSnapshot domain](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/), tip-of-tree, accessed September 11, 2026.
[^18]: xyflow, [React Flow Accessibility](https://reactflow.dev/learn/advanced-use/accessibility), accessed September 11, 2026.
[^19]: xyflow, [React Flow NodeProps](https://reactflow.dev/api-reference/types/node-props), accessed September 11, 2026.
[^20]: ServiceNow Research, [BrowserGym repository](https://github.com/ServiceNow/BrowserGym), main branch, accessed September 11, 2026. Common framework and benchmark inventory.
[^21]: Electron, [Security](https://www.electronjs.org/docs/latest/tutorial/security), accessed September 11, 2026.
[^22]: Chromium, [CDP Target domain](https://chromedevtools.github.io/devtools-protocol/tot/Target/), tip-of-tree, accessed September 11, 2026.
[^23]: Chromium, [CDP Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/), tip-of-tree, accessed September 11, 2026.
