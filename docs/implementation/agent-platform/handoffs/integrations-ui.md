# Integrations UI handoff (I02/I03)

Package: **I02/I03 renderer lifecycle UI**  
Branch: `feat/platform-integrations-ui`  
Worktree: `mousse-platform-worktrees/integrations`

## Delivered

`src/renderer/components/integrations/IntegrationsWorkspace.tsx` exports a profile/project-scoped Integrations workspace with Skills and MCP connections tabs. It provides searchable cards, provenance/scope/status/diagnostics, explicit managed versus external discovery treatment, refresh through `snapshot({ refresh: true })`, empty/loading/error states, and stable installation-ID selection.

Skill flows use the frozen client for create, update, enable/disable, archive, import, export ZIP/Markdown, and editor reads. Creation includes name, description, license, compatibility, scope, starter instructions, and enable-on-save. Upload accepts SKILL.md, ZIP, or a browser folder selection; packages are bounded to 360 KiB compressed / 480 KiB encoded, reject unsafe relative paths, preserve nested files, and never execute assets. The editor reuses `MarkdownDocumentEditor` with Source/Preview, exact source state, package tree, diagnostics, keyboard save, dirty-close confirmation, revision conflict retention, and optional typed Test in new thread.

MCP flows support stdio executable plus argv/cwd, Streamable HTTP, legacy SSE, anonymous/static/OAuth auth, environment/header replacement controls, explicit enable-on-save, allowed/denied tool lists, test connection, enable/disable, delete, and OAuth start/cancel/revoke. Secrets use password inputs; masked read values are never copied into writes, and unchanged `env`, `headers`, and `auth` objects are omitted. Replacement controls collect complete objects. Test results distinguish connected-zero-tools from failure and render structured error categories.

## Host API

The workspace props are:

```ts
interface IntegrationsWorkspaceProps {
  client: IntegrationPlatformClient
  profileId: string
  projectId?: string
  projects?: Array<{ id: string; name: string }>
  initialTab?: 'skills' | 'mcp'
  onTestSkill?: (params: {
    profileId: string
    projectId?: string
    installationId: string
    revision: string
  }) => Promise<unknown>
}
```

`onTestSkill` is optional and is hidden when absent; the UI never fabricates a test result. Root should pass the real main-agent/thread callback when available.

The injected client is `src/shared/integrationPlatform.ts` / `src/renderer/services/integrationPlatformClient.ts`. All calls preserve `profileId` and `projectId`: `snapshot`, `createSkill`, `updateSkill`, `skillEditor`, `enableSkill`, `archiveSkill`, `importSkill`, `exportSkill`, `createMcp`, `updateMcp`, `readMcp`, `enableMcp`, `deleteMcp`, `testMcp`, `beginMcpAuth`, `cancelMcpAuth`, and `revokeMcpAuth`.

## Async and security boundaries

Workspace snapshot loads are fenced by client/profile/project generation and reset tab, search, selection, and dialogs at a boundary. Skill editor reads and MCP test requests have local generation fences. OAuth controls remain cancellable and are disabled independently from ordinary save state. External discovery cards are read-only and never pass unmanaged IDs to managed CRUD. No localStorage catalog, raw filesystem path, secret log, URL credential, or fake success adapter is used.

The isolated fixture client under `tests/fixtures/agent-platform/integration-editor-client.ts` is explicitly fixture-only. Backend temporary-profile lifecycle/domain coverage already exists in `platformIntegrationDomains` and `platformIntegrationLifecycle`; the hidden Electron fixture uses the isolated client to exercise renderer interaction and is labeled as fixture evidence rather than production bridge proof.

## Verification

```text
npm test -- --run tests/platformIntegrationUi.test.ts --maxWorkers=2
  3 tests passed
npm run typecheck
  tsconfig.node.json and tsconfig.web.json passed
node scripts/run-integration-editor-visual-check.mjs
  workspace, Add skill, create/edit, Source/Preview, MCP create/edit/test,
  profile switch and narrow layout passed
```

The Electron fixture writes `.mousse-dev/integration-editor-evidence/result.json`, `desktop.png`, and `narrow.png`; the current result is passed. It uses no live accounts or secrets.

## Root wiring remaining

Mount `IntegrationsWorkspace` from Settings with the profile-bound `IntegrationPlatformClient`, current project ID and project list. Add the intended Settings navigation/deep links and host requester/preload/MMS registration. Root should keep OAuth disposal on profile rebinding and daemon shutdown as required by the integration-domain bridge. No package script was added; the visual command is available at `scripts/run-integration-editor-visual-check.mjs`.

**Implementation commit:** `e11cb57980da69ef0ad10dd30f8d238baddcedf1`
