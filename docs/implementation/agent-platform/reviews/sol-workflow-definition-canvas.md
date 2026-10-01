# Sol review: workflow definitions, invocation, and canvas

## Reviewed range

- Integration base: `b46eb908db1d78a621fb39db3dc045073667f74c`
- Canvas implementation: `050fcdec7b6bd411277052b4fe679ead54883298`
- Workflow definition bridge: `7aa54fa`
- Workflow invocation resolver: `48c56e646f1c5cbfba93a3c30bbb59dba7387657`
- Those three implementations were already ancestors of the reviewed base. The review commit below contains only fixes and qualification evidence.

## Findings fixed

1. Missing required inputs disabled the whole schema form, so the user could not supply the values needed to enable Run. The form now remains editable while the Run action alone reports and enforces missing fields.
2. Draft execution did not carry a semantic identity. `WorkflowStartRequest` is now a discriminated contract: `draft: true` requires `expectedDraftSemanticHash` and forbids a revision ID. The editor runs only saved drafts and sends the current saved hash; an unsaved local buffer must be saved first.
3. Run, pause, resume, cancel, dry-run, breakpoint, approval, ask-user, and reconciliation promises could update the wrong workflow after profile, definition, execution-client, run, or unmount changes, and rejected promises could become unhandled. These actions now share a guarded success/error path. Subscription callbacks have the same boundary checks. Breakpoint and ask-user local state reset when the run identity changes.
4. Editor duplicate/export/archive/restore actions lacked rejection handling and generation checks. Client/profile/definition changes now invalidate the generation synchronously, and all four operations ignore stale completions. Revision conflicts remain structured in the editor conflict flow.
5. The library Run dialog retained an old manifest, hash, revision, run, and error while loading another profile or definition. It now clears those values at the request boundary. Agent summaries also consume rejected lookups without an unhandled promise.
6. Native button, search, outline-select, React Flow control, and edge-label styling rendered bright controls against the dark workspace. Workflow-scoped styles now provide dark surfaces, visible text/focus, and consistent disabled states without changing shared app controls.
7. The narrow evidence capture could show a blank-looking canvas because the page remained scrolled elsewhere. The fixture scrolls the canvas into view and requires at least two model nodes plus a visible rendered React Flow node before capturing.
8. The Electron fixture now exercises graph undo/redo, a schema with a required input, disabled Run before input, enabled editing and Run after input, a saved draft run accepted only with its hash, and populated narrow rendering. A repeatable `test:workflow-editor` package script was added.

## Verified behavior

- Definition-domain JSON transport preserves binary assets with explicit wire encoding, bounds and validates package paths/digests, restores an immutable historical revision into the draft without moving the published head, and rejects stale profile/revision writes.
- The invocation resolver preserves built-ins, treats `//` literally, pins published revisions, supports quoted and negative values without shell evaluation, and requires explicit `/workflow` or `/skill` selection for a name collision.
- Canvas graph edits, connection creation, layout-only semantic stability, undo/redo, save/reload, invalid-source retention, valid-source application, draft execution identity, dirty navigation, and profile switching passed in a hidden Electron renderer.
- Visual inspection of `.mousse-dev/workflow-editor-evidence/desktop.png` and `narrow.png` confirmed readable dark controls and labels and a populated two-node graph in the narrow viewport.

## Remaining gaps

- Production MMS composition and the real workflow execution client/run bridge remain outside this pass. The host must reject a draft request whose `expectedDraftSemanticHash` no longer names the saved draft.
- The existing runtime follow-up still owns nested durable loops, parallel joins, waits/retries, durable admission/no-wait, and accurate attempt/artifact snapshot projection. This review does not infer those semantics from the editor catalog.
- Optional pause/resume, dry-run, breakpoint, approval, ask-user, and unknown-effect controls remain capability-gated until production adapters expose them.
- Project workflow discovery remains disabled until explicit managed import/selection is implemented.
- The fixture exercises source synchronization through the renderer fixture control and confirms Monaco mounts. It does not qualify physical Monaco keyboard focus or IME behavior.

## Verification

- `npx vitest run tests/platformWorkflowDomains.test.ts tests/platformWorkflowRegistry.test.ts tests/platformWorkflowInvocation.test.ts tests/platformWorkflowUi.test.ts tests/platformWorkflowUiEditor.test.ts --maxWorkers=2`
  - 5 files passed, 38 tests passed.
- `npm run typecheck`
  - Node and web TypeScript projects passed.
- `npm run test:workflow-editor`
  - 33 hidden Electron checks passed, including graph undo/redo, source save/run, required input interaction, saved-draft hash admission, narrow populated graph, and profile fencing.
