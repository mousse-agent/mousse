# Integrations backend handoff (I01 / I02 / I03)

Worktree: `mousse-platform-worktrees/integrations`  
Branch: `feat/platform-integrations`  
Baseline: `666a3ba`  
This commit SHA: `5a6305144f143af1a92344bb4ea41693e5fa5a6e`

This is **backend + fixtures only**. Protocol/Add UI, preload/IPC, renderer, MousseMainService wiring, ProfileRuntime, and I04 CLI qualification are **not** done here. Do not treat this as a complete production integration until those land.

## What landed

Reproduced and fixed the I01 runtime defects, then added managed Skill/MCP lifecycle services (I02/I03 backend) behind injected profile context. Existing 3-arg constructors keep working via `createLegacySingleProfileContext()` until root wires ProfileRuntime.

### Defects

| # | Failure | Fix |
|---|---|---|
| 1 | Native writer used `.mousse/skills` and `.mousse/mcp.json`; discovery omitted those roots | Shared `nativePaths.ts`. Discovery now includes `{profileRoot}/integrations/skills`, `{profileRoot}/integrations/mcp.json`, `{project}/.mousse/skills`, `{project}/.mousse/mcp.json`. Does **not** crawl sibling profiles. |
| 2 | Skills refresh hit 30s cache | `SkillsRegistry.refresh()` / `invalidateDiscoveryCache()`. Lifecycle methods call `refresh()`. Protocol `skills.refresh` still calls `discover()` — root must patch. |
| 3 | Remote HTTP/SSE without static Authorization treated as OAuth | Auth modes `anonymous` / `static` / `oauth`. Anonymous connects until a real 401/auth challenge. |
| 4 | Connection key `source:name`; tool aliases collided | Keys: `profileId :: projectScope :: installationId :: configRevision :: authIdentity`. Tool aliases `mcp__{server}__{tool}__{8-hex-install-id}` plus reverse map. |
| 5 | `testServer` missing config returned `[]` success | Missing/disabled/unreachable/schema-incompatible → `{ success: false, errorCategory }`. Connected zero-tool server is success with `toolCount: 0`. |
| 6 | `Promise.race` timeout did not abort | `withAbortTimeout` + SDK `RequestOptions.signal`. Owned stdio children closed on timeout. No automatic replay of mutating calls. |
| 7 | Results flattened to 12k text | `McpToolCallResult` keeps text/image/resource_link/structuredContent/isError. Legacy `text` is a bounded summary, not a fake conversion of images. |
| 8 | Native children used main-agent gates | `LlmChatOptions.actor` (default main; `subagent: true` → mousse child). Recheck at call time via `isToolCallAllowed` using installation ids. Subagent build-mode no longer strips MCP tools. |
| 9 | MCP CRUD was Cursor-only | `McpLifecycleService` writes profile-owned `integrations/mcp.json` (and project `.mousse/mcp.json`). |
| 10 | Handwritten YAML/TOML subset | Skills frontmatter uses pinned `yaml@2.9.0` + Ajv. Codex TOML remains a bounded subset and **emits a diagnostic requesting a TOML parser dependency**. No eval. |

### Skill lifecycle (supported)

- Create template from name/description/instructions; exact body round-trip; Source/Preview DTO (`SkillEditorDto`).
- Import folder, single markdown/`SKILL.md`, or ZIP via `fflate` with traversal/ADS/device/absolute/drive rejection, bounded compressed/expanded bytes and file count, staged validation, atomic promotion, content hashes, executable assets listed but **not executed**.
- Update with revision conflict check; previous bytes pinned under `integrations/revisions/skills/`.
- Enable/disable; soft archive (copy then delete live package).
- Disabled managed packages overlay `enabled: false` and are filtered by `EffectiveIntegrationResolver`.

Not implemented here: Git URL import UI, Test-in-new-thread, editor, Add button.

### MCP lifecycle (supported)

- Create/update/read/enable/disable/delete (archive + settle + revoke OAuth).
- stdio command+argv+env refs; remote Streamable HTTP and legacy SSE.
- Anonymous / static header / OAuth modes; OAuth tokens stored under `{profileRoot}/secrets/mcp-oauth` (profile-isolated).
- Redacted public DTO (`redactMcpServerConfig` includes `auth.clientSecret`).
- URL must be http(s) without embedded credentials; headers reject CR/LF.
- Sampling/elicitation/roots are **not** advertised or auto-approved.

OAuth interactive login still uses the existing local callback on `127.0.0.1:8791`. Refresh/revoke/cancel APIs exist; live OAuth against external accounts was **not** exercised.

## Constructor / root wiring

Compatibility (current `MousseMainService` still compiles):

```ts
new SkillsRegistry()
new McpRegistry()
new McpManager(registry, settings, openExternal)
new AgentConfigManager(mcpRegistry, skillsRegistry, settings)
new LlmClient(settings, providerAuth, mcpManager, skillsRegistry, ...)
```

Preferred after ProfileRuntime exists:

```ts
const context = {
  profileId,
  profileRoot,          // profiles/<id>
  projectPath,          // optional
  secrets,              // IntegrationSecretAdapter
  artifacts             // optional image/artifact store
}

const skillsRegistry = new SkillsRegistry(context)
const mcpRegistry = new McpRegistry(context)
const mcpManager = new McpManager(registry, settings, openExternal, { context, clientFactory? })
const skillLifecycle = new SkillLifecycleService(skillsRegistry, context)
const mcpLifecycle = new McpLifecycleService(mcpRegistry, mcpManager, context)
const catalog = new IntegrationCatalog(skillsRegistry, mcpRegistry, mcpManager, settings, skillLifecycle, mcpLifecycle)

new AgentConfigManager(...).prepare(agentId, cliType, worktree, project, actor)
llmClient.chat(messages, onTool, { actor, signal, subagent, projectPath })
```

### Protocol patches root must make (do not claim done)

1. `skills.refresh` → `skillsRegistry.refresh({ projectPath })` (not `discover`).
2. Expose `SkillLifecycleService` / `McpLifecycleService` / `IntegrationCatalog` methods as new protocol families. Do **not** send raw env/headers/secrets to the renderer; use redacted DTOs.
3. Construct registries/managers with injected `profileId`/`profileRoot` from ProfileRuntime. Stop using `MOUSSE_HOME` as a selected-profile global.
4. Pass `LlmChatOptions.actor` for native Mousse children (`{ kind: 'agent', agentType: 'mousse', skillIds?, mcpServerIds?, mcpToolIds? }`).
5. `mcp.testServer` result now includes `errorCategory`, `toolCount`, `connected`. Treat `success: false` as failure in UI.
6. `mcp.callTool` / native tool results are typed; UI should render image/resource artifacts, not only `text`.
7. Settings enablement lists should store **installation ids**, not display names.
8. OAuth sessions: new files live at `{profileRoot}/secrets/mcp-oauth`. Legacy `{MOUSSE_HOME}/mcp-oauth` is not migrated.
9. Request a TOML parser dependency if Codex config must be fully compliant; current parser is explicitly a subset.
10. I04 still owns CLI materialization qualification across all agent types.

## Public APIs (backend)

Skills: `SkillsRegistry.discover/refresh/readSkill/readSkillRevision/invalidateDiscoveryCache`  
`SkillLifecycleService.create/update/read/enable/archive/importPackage/exportPackage/exportMarkdown`

MCP: `McpManager.listConfiguredServers/listTools/getEnabledTools/testServer/callTool/authenticateServer/revokeServer/restartServer/isToolCallAllowed/refresh/invalidateDiscoveryCache`  
`McpLifecycleService.create/update/read/enable/delete`  
`McpRegistry.writeManagedMcpConfig` (plus existing `writeCursorMcpConfig`)

Grants: `resolveEffectiveSkills` / `resolveEffectiveMcpServers` / `isMcpToolAllowedForActor`

## Tests

`npx tsc --noEmit -p tsconfig.node.json` — pass  

`npx vitest run tests/integrations.test.ts tests/platformIntegration*.test.ts tests/llmNativeToolLoop.test.ts tests/llmTextStream.test.ts tests/llmReasoningStreamOptions.test.ts` — **44 passed**

Coverage includes native path alignment, profile isolation, cache refresh, YAML parser, TOML subset diagnostic, anonymous connect, connection keys, tool alias isolation, testServer failure categories, abort, typed results, stdio fixture (`echo`/`picture`/`fail`/`hang`), child vs main grants, skill create/import/zip safety/revision pin/archive, MCP managed write + URL validation.

No live MCP accounts, API keys, or private config contents.

## Remaining (not this worktree)

- GUI Integrations settings / Add skill / Add MCP wizard (U01 + root).
- Protocol methods and DTO validation for lifecycle.
- ProfileRuntime injection and multi-profile daemon admission (P01/P03).
- I04 agent materialization/CLI evidence matrix.
- Git URL skill import.
- Artifact adapter for large images (interface exists; default is inline ≤100KB).
- Interactive OAuth against a real resource server.
- File watcher debounce for discovery (refresh is explicit).
