# A02 Agent library and editor handoff

Owner: Grok agents/editor worktree (`feat/platform-agents`).
This package builds reusable production UI. It does **not** enable the Agents tab until root binds profile context and `agentDefinitions.*` protocol methods.

Orb components were consumed, not modified.

## Completed here

- `AgentDefinitionsClient` port: async `list/get/create/saveDraft/publish/archive/duplicate/importBundle/exportBundle/validate/tryRun` with `profileId` and draft/revision preconditions.
- `AgentsLibrary`: prominent New agent, import, search, tags, runtime/model filters, favorites, sort, cards with compact `LiquidGlassOrb`, name/purpose, model, enabled, issues, draft/published. `activeRunsSlot` preserves current runtime session UI. No `localStorage` library cache.
- `AgentEditor`: header/breadcrumb, save draft, publish, duplicate/export/archive, validation links, 50/50 desktop split (`1fr 1fr` at ≥1100px, identity does not scroll, settings does), narrow stacked outer scroll. `OrbAppearanceEditor` writes visual metadata only. `MarkdownDocumentEditor` uses instance path `agent-definitions/{id}/system.md`. Dirty navigation dialog. `REVISION_CONFLICT` offers reload vs keep edits. Async gate drops late responses after profile/definition switch or unmount.
- All `AgentDefinitionSettings` groups with product labels, progressive sections, structured JSON for schema/fixture context, and CLI unsupported reasons from `getRuntimeCompatibility` / `collectUnsupportedCliSettings`. Missing model stays selected and blocks publish/try-run.
- WG4 helpers: `AgentDefinitionPicker`, `AgentDefinitionReadOnlySummary`.
- Isolated fake client lives only under `tests/fixtures/agent-platform/agent-editor-client.tsx` for tests/fixtures. Production components never construct it.

## Port contract (root wiring)

Mount after profile binding:

```ts
<AgentDefinitionsWorkspace
  profileId={executionProfileId}
  client={agentDefinitionsClient}
  catalogs={catalogsFromSharedProvidersAndProfileIntegrations}
  activeRunsSlot={<AgentsPanel />}
/>
```

Bind `client` to new protocol methods. Do not point it at a success-faking adapter. `saveDraft` must send `expectedDraftHash`. `tryRun` must call a real runner or return an honest blocked result.

Renderer import/export only parses JSON size/shape; MMS registry remains authoritative. The renderer never imports `src/mms/agentDefinitions`.

## Script registration request

Please add to `package.json`:

```json
"test:agent-editor": "node scripts/run-agent-editor-visual-check.mjs"
```

Runner: `scripts/run-agent-editor-visual-check.mjs`
Check: `scripts/check-agent-editor-visuals.cjs`
Evidence: `.mousse-dev/agent-editor-evidence`

This mirrors `npm run test:orb` and does not modify the orb harness.

## Unresolved gaps (do not call A02 done in product)

1. App routing / `MainViewPanel` / `AgentsPanel` / protocol / preload / IPC are root-owned and unwired.
2. `ModelFamilyMenu` still reads/writes global `localStorage` key `mousse.modelFavorites`. This package did not add another global store. Profile-scoped favorites need a menu API change from root.
3. `saveDraft` registry shape has no `runtimeKind`; the UI port accepts optional `runtimeKind` for the host to persist when the registry grows.
4. Last-run sort uses optional `lastRunAt` on list rows. Host should join run history when A03 exists.
5. Directory-folder import is not a renderer filesystem walk; pass a JSON bundle through the port. Zip/directory packaging is host/MMS.
6. Try-run is a port call. Isolated tests block honestly. Production execution is A03 + root runner wiring.
7. Monaco in the hidden Electron fixture may log worker noise; the check ignores monaco/worker errors only.

Do not claim the whole A02 production flow is enabled until the daemon bridge is connected.
