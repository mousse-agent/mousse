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

## I04 isolation and materialization completion

The I04 follow-up is implemented in the same backend worktree. Project-managed Skills and MCP files are now profile-owned under `profileRoot/integrations/projects/<stable-project-id>`, where the project identity is a canonical-path hash shared only as a namespace key. Two profiles can register the same repository without sharing package bytes, state, secrets, grants, or managed config files. Legacy repository `.mousse` Skills/MCP files remain visible as `managed: false` read-only discoveries; they are never selected from settings by display name. An actor must carry the exact external installation id to trust one explicitly. Resolver grants use installation/registry ids only, so equal display names cannot bypass ambiguity.

`McpConnectionKey` now includes the profile id, stable project identity, installation id, per-server connection revision, and auth identity. Per-server revisions exclude unrelated entries in the same config document. Project lifecycle installation ids include the stable project identity; profile-global installations remain profile-owned. Secrets and enablement state stay in profile storage and are not written to repository `.mousse` files.

`AgentConfigManager.prepare()` now materializes the exact resolved actor set for native Mousse, Claude Code, Codex, OpenCode, and Cursor. It merges supported JSON/TOML config forms while preserving unrelated entries, converts literal env/header values to environment references, reports unsupported OAuth/legacy-SSE capability cases, and records selective cleanup ownership. Cleanup removes only generated server keys/skill folders and removes an entire config only when Mousse created it. Existing user-owned files are preserved even when their names collide; generated skills receive a deterministic namespaced folder in that case.

## I04 verification

`tests/platformIntegrationIsolation.test.ts` uses two real profile contexts against one repository plus two project contexts with the same Skill name. It verifies separate managed roots, unchanged repository `.mousse` files, exact-id grants, no name grants, child profile fences, and connection-key separation. `tests/platformIntegrationMaterialization.test.ts` runs all five agent types against real temporary files, preserving unrelated JSON/TOML content, materializing selected MCP/Skill entries, masking literal secrets, reporting unsupported capabilities, and cleaning only owned entries.

Validated commands:

```text
npm run typecheck
npx vitest run tests/integrations.test.ts tests/platformIntegrationActor.test.ts tests/platformIntegrationDiscovery.test.ts tests/platformIntegrationDomains.test.ts tests/platformIntegrationIsolation.test.ts tests/platformIntegrationLifecycle.test.ts tests/platformIntegrationMaterialization.test.ts tests/platformIntegrationMcpRuntime.test.ts tests/llmNativeToolLoop.test.ts tests/llmTextStream.test.ts tests/llmReasoningStreamOptions.test.ts --maxWorkers=2
```

The integration/backend suite passes 11 files and 64 tests; both Node and web TypeScript projects pass. Remaining work is root-owned protocol/ProfileRuntime composition and renderer UI wiring. I04 did not modify `registerMethods.ts`, renderer files, Orb, MMS host, or package manifests.

## Remaining (not this worktree)

- GUI Integrations settings / Add skill / Add MCP wizard (U01 + root).
- Protocol methods and DTO validation for lifecycle.
- ProfileRuntime injection and multi-profile daemon admission (P01/P03).
- I04 agent materialization/CLI evidence matrix.
- Git URL skill import.
- Artifact adapter for large images (interface exists; default is inline ≤100KB).
- Interactive OAuth against a real resource server.
- File watcher debounce for discovery (refresh is explicit).
