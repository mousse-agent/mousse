# Sol Agent UI integration review

## Review boundary

- Branch: `feat/platform-integration`
- Reviewed base: `7ffa018da732226ddddf273f8695dbee48affd4b`
- Exact Agent UI handoff: `6e7d66c` (`6d792d2` implementation)
- Integration merge: `2ca3e29`
- Reviewed code head: `79cd26f20ad1265fc1893e6a46d5c7f3ebf3f1bc`
- Review date: 2026-09-11 (Asia/Calcutta)

The exact Agent UI handoff was merged without pushing or changing `master`. The merge retained the already reviewed root orb correction; this pass did not modify any file under `src/renderer/components/orb/**`.

## Findings fixed

- The editor offered a runtime selector and sent `runtimeKind`, but `SaveAgentDraftInput` and `AgentDefinitionRegistry.saveDraft` could not persist it. The authoritative input and registry now support a runtime change, validate the runtime at the trust boundary, re-run compatibility checks against the destination runtime, and include it in the resulting semantic hash. Compatibility tests cover a Mousse-to-Codex change, a safe change back to Mousse with native-only settings, persistence, and rejection of an unknown runtime.
- An open editor retained its previous record while a new profile/definition load was pending. The editor now clears the record and draft before loading, and the workspace keys and resets its editor/library state at the profile/client boundary.
- Late create/import and try-run results could update navigation or status after the profile, definition, or client changed. Those paths now compare the originating boundary before applying results. The existing list/load gate remains in place.
- Duplicate and archive performed their mutations before the dirty-navigation decision. They now wait until the user discards local edits, report port errors in the editor, and ignore late results after a boundary change.
- Export could silently download the registry draft while unsaved local edits were visible. Export is now disabled with an explanation until those edits are saved or discarded.
- A successful publish reloaded the record but could leave the shared saving state set. Starting the authoritative reload now clears that state.
- The requested `test:agent-editor` package script is registered. Its Electron check now uses trusted keyboard/mouse input to edit Monaco, selects text, crosses Preview and returns to Source, verifies that the selection is restored by replacing it, saves through Ctrl+S, reloads exact source and visual metadata, and changes profiles while an editor is open.

## Verification

| Command | Result |
| --- | --- |
| `npx vitest run tests/platformAgentDefinitions.test.ts tests/platformAgentUi.test.ts tests/platformMarkdownEditor.test.ts tests/fileEditor.test.ts` | 4 files and 42 tests passed. |
| `npm run typecheck` | Passed for node and renderer TypeScript projects. |
| `npm run test:agent-editor` | 28 hidden Electron checks passed with no captured renderer errors. This exercised real Monaco editing, Source/Preview selection restoration, Ctrl+S save, reload, profile reset, unavailable-model blocking, exact desktop split, dirty navigation, and narrow overflow. |
| Screenshot inspection | `desktop.png` shows the exact half split with a stable full orb and scrollable settings; `narrow.png` shows a coherent stacked editor without horizontal overflow. |
| `npm run build` | Passed for main, preload, renderer, and CLI. |
| `git diff --check` | Passed before the code commit. |

Evidence is written to `.mousse-dev/agent-editor-evidence` using an isolated Electron `userData` directory. No live account, model, channel, or production profile was used. Per the bounded review instruction, the full suite was not repeated while other runtime workers were active.

The build retains the pre-existing CSS parser warning caused by `p-*/m-*/space-*` inside the comment at `src/renderer/styles/global.css:142`. This review did not change that unrelated file.

## Remaining bridge work

- A02 is reusable UI, not an enabled product route. Root still needs to mount it with the execution profile, add protocol/preload/IPC handlers, and bind the client to profile-owned registries and real catalogs. The hidden fixture qualifies the component behavior and Monaco integration, not that absent daemon bridge.
- `ModelFamilyMenu` still owns global `mousse.modelFavorites` local storage. Profile-scoped favorites require a host/menu API change.
- Directory/zip import remains an MMS concern; the renderer accepts a bounded JSON bundle only.
- Last-run sorting needs A03 run-history enrichment. Try-run remains an honest port call and the fixture returns blocked because no executor is attached.
- A03 execution, runtime records, and production save/restart persistence across the daemon remain unimplemented. The registry-side `runtimeKind` save gap is closed in this pass, but the future protocol bridge must carry the new optional field unchanged and enforce `expectedDraftHash`.

This pass qualifies the merged Agent UI component and registry contract for the next integration stage. It does not mark A02 or the wider agent-platform plan complete.
