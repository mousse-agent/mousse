# U01 / A01 foundation handoff

Owner: Grok agents/editor worktree (`feat/platform-agents`).
Packages: **U01** Markdown editor extraction, **A01** definition registry and resolver.
Orb, palettes, Agent Editor chrome, protocol/preload/IPC, app routing, stores, and orchestrator were not modified.

## Completed in this package

### U01 — MarkdownDocumentEditor

- Extracted a controlled `MarkdownDocumentEditor` from the FilesPanel Monaco + ReactMarkdown path.
- Source/Preview are accessible tabs (`role="tablist"`). Source bytes and the last Monaco selection are preserved across switches by keeping the editor mounted and snapshotting/restoring the selection.
- Props: `value`, `onChange`, `onSave`, `readOnly`, `validationMessages`, `variableSuggestions`, theme via existing `applyEditorTheme`, `automaticLayout`, and focus restore on Source.
- The component performs no file writes and no daemon/service calls.
- Preview skips raw HTML, blocks remote/file/blob/`javascript:` images, and does not leave unsafe `href`s. Relative images are omitted unless a caller opts in, so FilesPanel cannot fetch the renderer origin as a side effect.
- `FilesPanel` uses the extracted editor for Markdown only. HTML iframe preview, binary, PDF/image/video assets, and the generic Monaco editor remain.
- `DocumentPanel` stays read-only and unowned.

Evidence: `tests/platformMarkdownEditor.test.ts`. Source-preservation and preview-policy tests are behavioral. Tab/preview markup tests use `renderToStaticMarkup` only and are **not** a keyboard/focus/Monaco interaction pass.

### A01 — definitions and resolver

- New types live in `src/shared/agents/**`. They are distinct from runtime `Agent` in `src/shared/types.ts`.
- Stable UUID identity, slug, runtime kind (`mousse` | `claude-code` | `codex` | `opencode` | `cursor-agents-cli`).
- Settings groups from architecture 5.3: identity, instructions/`system.md`, primary/fallback models and capability overrides, output, context/memory, skills/MCP/tools, browser, delegation, workspace/script, approval, limits, recovery, examples.
- Visual metadata is an opaque `Record<string, unknown>`. Orb types and implementation remain root-owned.
- `AgentDefinitionRegistry` is constructed with an injected `profileId` + `profileRoot`. It never reads `process.env.MOUSSE_HOME`.
- Drafts, immutable published revisions (SHA-256 directory, exclusive write), optimistic concurrency on `draftHash`, archive (list-hidden, revisions retained), duplicate, directory/JSON import/export, path/size safety, semantic vs visual hashes.
- `AgentResolver` returns a pinned revision, compiled instructions, model refs/capability profile, effective grants, and dependency hashes. Lookups are injectable. Missing models, unsupported CLI settings, and missing integrations fail with codes (`MODEL_CAPABILITY_MISSING`, `SETTINGS_UNSUPPORTED`, `DEPENDENCY_MISSING`) instead of fake success.
- Built-in CLI engine IDs are the existing `AgentTypeId`s. Runtime `AgentRegistry` is unchanged. This package does not start a second native agent loop.

Evidence: `tests/platformAgentDefinitions.test.ts` (A/B isolation, pin-while-edited, archive, prompt/path safety, model capability, missing integrations, inherited vs explicit grants, draft conflicts).

## Not done (later wiring; do not treat as complete)

- Agent library UI, Agent Editor 50/50 layout, and the liquid glass orb (root-owned).
- Protocol methods `agentDefinitions.*`, preload/IPC, `appStore`, `App.tsx` routing, AgentsWorkspace.
- Wiring `AgentResolver` into `MousseAgentService` / CLI spawners / workflow Agent nodes (`A03`).
- Profile path contract from P01: host should construct `new AgentDefinitionRegistry({ profileId, profileRoot })` from ProfileRuntime, never from `MOUSSE_HOME`.
- Shared model catalog (P01/P04): inject `AgentModelLookup` over the live catalog. `StaticAgentModelLookup` is a test/dev adapter, not a production success path.
- C5 integrations: inject `AgentIntegrationLookup` over Skills/MCP managers. Static lookup is a fake for development tests only.
- Create-from-mode copy after profile scoping (`draftFromModePrompt` exists; Markdown modes remain separate and unwired).
- CSS for editor chrome; the extracted editor reuses existing `files-*` classes.

## Root wiring instructions

1. Do **not** import this registry from the renderer. Keep execution in MMS.
2. Compose in `MousseMainService` / ProfileRuntime:
   `createAgentDefinitionServices({ profileId, profileRoot, modelLookup, integrationLookup })`.
3. Attach `AgentRunnerPort` implementations that call existing native/CLI spawners and record `definitionId` + `definitionRevision` on the runtime `Agent`. Use `describeRuntimeAgentLink`.
4. Add `agentDefinitions.*` protocol methods through the contracts owner. Validate UUID, revision preconditions, and profile binding in that layer.
5. Agent Editor (A02) should consume `MarkdownDocumentEditor` for the system prompt. Pass validation/variable props; do not put daemon calls in the editor.
6. Reject unavailable models and unsupported CLI knobs in UI using resolver issues; do not silently coerce.

## Files touched

- `src/renderer/components/editors/**`
- `src/renderer/components/FilesPanel.tsx`
- `src/shared/agents/**`
- `src/mms/agentDefinitions/**`
- `tests/platformMarkdownEditor.test.ts`
- `tests/platformAgentDefinitions.test.ts`
- `docs/implementation/agent-platform/handoffs/agents-foundation.md`
