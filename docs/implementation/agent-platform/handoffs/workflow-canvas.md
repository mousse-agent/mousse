# Workflow canvas handoff (V01/V02/V03)

Package: **V01/V02/V03**  
Branch: `feat/platform-canvas`  
Worktree: `mousse-platform-worktrees/agents`  
Owner paths: `src/renderer/components/workflows/**`, workflow editor fixture files, workflow editor visual scripts, this handoff.

## Delivered surface

`WorkflowsWorkspace` hosts a profile-scoped workflow library and editor. The library has New workflow/template creation, import, search, tag/status/sort filters, draft/published/unpublished-change badges, diagnostics, last-run metadata, and a published-run input dialog. The editor has a complete shared W01 catalog palette, React Flow canvas, named control handles, local preventable connection diagnostics, unsupported-node preservation, keyboard delete/duplicate/undo/redo, snap grid, minimap, fit/zoom controls, auto-layout, accessible outline, inspector, safe binding/expression editors, script staging fields, agent definition/pinned-or-head controls, dependency diagnostics, source/canvas switching, invalid-source retention, visual-only identity handling, optimistic draft save/conflict handling, import/export, archive/duplicate capability gates, and revision history.

The run panel uses the injected execution port for schema-driven inputs, start draft/published runs, pause/resume/cancel, event and attempt traces, artifacts, approvals, ask-user answers, unknown-effect reconciliation, and capability-gated dry-run/breakpoint actions. Unsupported capabilities render a disabled reason. Fixture results are explicitly labeled `origin: 'fixture'` and never imply live model/script execution.

## Typed host ports

The host adapter imports `src/renderer/components/workflows/client.ts`.

`WorkflowDefinitionsClient` methods are profile-scoped:

```ts
list({ profileId, archived? })
get({ profileId, id })
getRevision?({ profileId, id, revisionId })
create({ profileId, name?, slug?, templateId?, bundle? })
saveDraft({ profileId, id, expectedDraftSemanticHash, expectedHeadRevisionId?, bundle, visualOnly? })
publish({ profileId, id, expectedDraftSemanticHash, expectedHeadRevisionId? })
archive?({ profileId, id })
duplicate?({ profileId, id })
importBundle({ profileId, bundle, conflict? })
exportBundle({ profileId, id, revision? })
validate({ profileId, id?, bundle, mode? })
listRevisions?({ profileId, id })
restoreRevision?({ profileId, id, revisionId, expectedDraftSemanticHash })
```

`WorkflowExecutionClient` methods are:

```ts
start({ profileId, definitionId, revisionId?, draft?, input, threadId?, projectId? })
get({ profileId, runId })
list?({ profileId, definitionId? })
pause?({ profileId, runId })
resume?({ profileId, runId })
cancel({ profileId, runId, reason? })
approve?({ profileId, runId, approvalId, nodeId, instanceKey, attempt, approved })
answer?({ profileId, runId, nodeId, instanceKey, data })
reconcile?({ profileId, runId, nodeId, instanceKey, attempt, decision })
subscribe({ profileId, runId }, listener)
dryRun?({ profileId, definitionId, revisionId?, draft?, input, threadId?, projectId? })
setBreakpoint?({ profileId, runId?, nodeId, enabled })
```

`WorkflowRunView` includes `origin: 'host' | 'fixture'`, state values including `unknown-effect` and `recovery-required`, event/attempt/artifact data, and exact approval/input/unknown-effect identities. The UI fences load, validation, save, revision-view, list/import/create, and subscription replies by profile/client/document generation. `WorkflowWorkspace` resets open document, filters, and run selection on profile or client changes.

## Root wiring required

Bind the real profile-aware workflow registry/runtime adapter to `WorkflowEditorHostPorts` at the host route. The bridge must preserve W01 `revisionId` separately from `semanticHash`; the run panel sends `head.revisionId` for published runs and leaves it undefined only for draft snapshots. Pass the real catalogs and optional `AgentDefinitionsClient` through `WorkflowsWorkspace`.

The current runtime review leaves nested durable loops/parallel joins/waits/retries and broader effect reconciliation as follow-up backend work. The UI exposes the runtime state and diagnostics honestly; it does not claim those semantics execute merely because their node types are present in the catalog. Do not add a fake success adapter in production.

No application route or package script is enabled by this branch. Root should add the intended route and, if desired, a `test:workflow-editor` script pointing at `scripts/run-workflow-editor-visual-check.mjs`.

## Verification evidence

From this worktree:

```text
npm test -- --run tests/platformWorkflowUi.test.ts tests/platformWorkflowUiEditor.test.ts --maxWorkers=2
  2 files, 15 tests passed
npm run typecheck
  tsconfig.node.json and tsconfig.web.json passed
node scripts/run-workflow-editor-visual-check.mjs
  library/new/connect/save/reload/source invalid+valid/run approval/dirty navigation/narrow layout/profile fence: passed
```

The hidden Electron fixture writes `.mousse-dev/workflow-editor-evidence/result.json`, `desktop.png`, and `narrow.png`. The current result is passed. The screenshots show the desktop canvas with palette/inspector/outline and the narrow stacked palette/canvas/inspector/run layout. Fixture runs are marked in the run panel as `Fixture result (no live model or script)`.

**Final commit SHA:** `34c9f01397fe8cfacf0842cfc4e414f4ddbfeeb6`
