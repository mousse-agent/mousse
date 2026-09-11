# Sol integrations app UI review

Reviewed integration base: `c05de1df3863af749afd8201fb30735b52c4b732`  
Reviewed candidate: `66cb8642a00414f273dc7ef4db42d17355ab2485`  
Candidate merge: `8af9133`  
Review fix: `62a0b08e5da93e74b9ee015b7ab15a34cfa9bab9`

## Findings fixed

- **Project-managed MCP servers were rendered as read-only.** I04 records profile-owned project servers with source `generated-agent`, while the UI inferred ownership from an older source-name list. The lists now consume the domain's explicit `managed` flag and retain a compatibility fallback for older records. This also prevents an external discovery whose source resembles a managed source from becoming editable when the domain explicitly reports `managed: false`.
- **Dialogs could disappear while an admitted mutation was still running.** Backdrop, Escape, and close actions remained active during create, update, archive, and toggle requests. The request could then succeed after the dialog vanished without refreshing the catalog, leaving a ghost mutation in the current view. Skill and MCP dialogs now keep the admitted operation visible until its fenced completion handler refreshes or reports the result.

## Verification

All backend fixtures use temporary roots or local fixture processes. No live MCP provider, OAuth account, model, or network service was used.

```text
npx vitest run tests/platformProductionComposition.test.ts tests/platformNavigationGuards.test.ts tests/platformIntegrationUi.test.ts tests/platformIntegrationDomains.test.ts tests/platformMarkdownEditor.test.ts --maxWorkers=2 --reporter=dot
  5 files, 30 tests passed

npm run typecheck
  passed

npm run build
  passed (existing daemonShutdown chunk and CSS optimizer warnings remain)

node scripts/run-integration-editor-visual-check.mjs
  29 hidden Electron checks passed, zero renderer errors

npm run test:agent-editor
  31 hidden Electron checks passed
```

The production/domain fixtures cover framed MMS payload acceptance, omitted secret preservation, exact argv and cwd clearing, revision conflicts, local MCP lifecycle, package bounds, and navigation guards. The Electron integration fixture covers physical Monaco editing, exact saved bytes, stale catalog revisions, directory upload, MCP edits, failed/cancelled OAuth presentation, profile navigation guards, and the populated narrow layout. The Agent Editor fixture independently regressed physical Monaco Source/Preview selection and exact-byte save behavior after the shared resize observer change.

Screenshots `.mousse-dev/integration-editor-evidence/desktop.png`, `narrow-mcp.png`, and `narrow.png` were inspected. The desktop and populated narrow MCP views use the dark theme coherently, remain within the viewport, and preserve the single-column narrow form. The final narrow screenshot intentionally shows the empty second profile after the isolation exercise.

## Remaining scope

- The renderer fixture uses an isolated client; framed MMS tests provide separate domain evidence. This checkpoint does not prove the complete production Settings route and backend in one packaged Electron journey.
- Live OAuth interoperability, callback/refresh behavior, and cancellation against real providers remain unqualified.
- Skill Test depends on a supplied production callback and is not a complete native execution qualification. Installed native/CLI convention coverage remains part of A03.
- Packaged application acceptance and broader accessibility qualification remain open. This review does not close the full implementation goal or a release gate.
