# Using the Mousse agent platform

This guide describes the implemented product paths. The [architecture](../../agents-workflows-profiles-browser-architecture.md) explains the design; the [worktree plan](../../parallel-worktree-implementation-plan.md) explains delivery ownership. The [delivery ledger](status.md) records verification and remaining qualification.

## Profiles

Use the profile selector in the app header to create or switch profiles. Each profile owns its threads, projects, Plus account, preferences, agents, workflows, integrations, schedules, channels, browser storage, and renderer workspace. Provider connections, provider credentials, and the model catalog remain shared by the installation. Model selections and favorites are personal preferences.

Switching profiles changes the window's authenticated binding. Other profiles can continue background work. Archiving/removing a profile first stops and drains its owned work; unsuccessful cleanup retains ownership so the operation can be retried. Removal moves the owned profile root into installation trash. Shared repositories are retained.

The first profile receives migrated legacy personal data. Legacy renderer favorites and quick actions migrate only to the default profile, preserving any subsequent edits. Profiles organize users within one trusted OS installation; they are not separate operating-system security accounts.

## Agents

Open **Agents → Agents**, create an Agent, and choose a model. Edit the prompt using the shared Markdown editor's Source and Preview tabs. Palette arrows and appearance controls customize the liquid glass Orb; the settings panel scrolls independently on desktop.

Save drafts while editing and publish a version to use it from workflows. Settings cover model/runtime selection, prompt/context, tools, Skills, MCP, browser access, workspace access, scripts, approvals, budgets, output, and appearance. Unsupported runtime capabilities are reported explicitly. A workflow pins the published Agent revision at admission; later edits do not silently change that run.

Try Run uses an isolated scratch workspace. Persistent memory and selecting arbitrary project files for that preview are not currently supported. Native Mousse Agents execute in workflow Agent/Instruction nodes; external CLI Agent runtimes in those nodes are unsupported. Sandboxed scripts require an OS sandbox backend and remain unavailable; the editor offers workspace execution for supported script use.

## Workflows

Open **Agents → Workflows** to create, import, edit, publish, or run a workflow. The canvas supports a node palette, typed bindings, conditions, transforms, scripts, Agents, tools, Skills/MCP, browser operations, loops, parallel branches, waits, and child workflows. Source editing, validation, version history, export, and run inspection use the same stored definition.

Publish a workflow before invoking it from chat:

```text
/<workflow_slug> --argument value
/workflow <workflow_slug> --argument value
```

The explicit `/workflow` form resolves a workflow/Skill naming collision. App and CLI use the same resolver. Structured CLI commands are also available:

```text
mousse-cli workflow list
mousse-cli workflow run <slug-or-id> --input '{"argument":"value"}'
mousse-cli workflow history
mousse-cli workflow show <run-id>
mousse-cli workflow watch <run-id>
mousse-cli workflow cancel <run-id>
```

Use `mousse-cli workflow --help` for approval, input, trace, and recovery commands. A run retains its definition, Agent, and dependency identities. Stored script bytes execute directly after the required approval. Browser actions and other external effects also obey run policy. Waiting, cancelled, failed, and uncertain effects are distinct states; an uncertain external effect is not silently retried.

A script configured for the thread workspace runs in the authoritative thread checkout. Parallel mutating Agent branches receive separate registered Git worktrees; they do not write into the primary checkout or share a provider conversation. Workspace metadata and mutation leases are validated before execution.

The Run panel shows the durable execution state and pending approvals/inputs. Child workflow waits retain their relationship to the parent. Changing an enabled integration or revoking a grant can stop a pinned run; pinning does not override a user's subsequent revocation.

## Skills and MCP

Open **Settings → Integrations**. Use **Add skill** to write a Skill or import supported Markdown/package/folder content. The Skill editor reuses Source/Preview editing. Save and enable the Skill for the intended actor.

Use **Add MCP** to configure stdio or a supported remote transport. Configure authentication, explicitly test the connection, and enable it for the intended actor. The connection panel distinguishes configured, connecting, authentication-required, verified, failed, and cancelled states. A failed or cancelled login is not presented as a working connection.

Skill/MCP installations, enablement, and MCP authentication belong to the current profile. LLM provider credentials and the model catalog remain installation-shared. CLI materialization is limited to the runtime's reported capabilities. Live external CLI/OAuth interoperability should be qualified for the particular installed runtime/server.

## Browser Use

Open a tab in Mousse's Browser panel, select the intended thread, and choose **Use with agent**. Enable the browser tools in integration settings for the main agent or the published Agent being used. GUI automation controls that existing Electron tab, retaining its page, cookies, and identity.

Use **Take control** to interact manually and **Resume agent** to return control. An agent's human-handoff request appears with its reason. Releasing automation leaves the human tab available. The selected tab must belong to the same profile/thread and authenticated GUI connection; an absent or stale selection reports a setup error.

CLI and background automation use managed Chrome for Testing. Install it explicitly from the Browser panel's managed setup section or the CLI:

```text
mousse-cli browser status
mousse-cli browser install
mousse-cli browser cancel <operation-id>
```

Setup is shared by the installation and has one owned operation. Closing a status viewer or interrupting CLI monitoring does not cancel the installation; use the operation's Cancel action. In-app tabs work without this download. Model tool execution never installs Chrome automatically.

The supported production path uses Mousse's bounded generic browser tools. Provider-native computer-use adapters are experimental until their exact model/API combination is qualified. Browser task completion cannot be inferred from a click being dispatched: actions report verified, failed, blocked, unverified, or uncertain outcomes.

## Verification boundaries

Reviewed Windows/local fixtures exercise real Electron guests, the framed daemon protocol, native model-loop integration with a scripted provider, real managed Chromium, profile isolation, workflow durability, and process cleanup. Linux evidence separately covers Node CLI/native behavior and AppImage construction. These tests do not prove live provider quality, live Plus/OAuth/channel interoperability, or untested operating-system/package combinations. See the current ledger and individual review reports for exact passing commands and remaining checks.
