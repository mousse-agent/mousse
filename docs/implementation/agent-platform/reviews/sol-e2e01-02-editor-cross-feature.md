# Sol qualification: E2E01/02 editor cross-feature persistence

Date: 2026-09-11

Baseline: `dd38cd45a79cc74aa2c1897a41762dfd25afad9b`

## Result

The Electron fixture connects the production Agent and Workflow editor components through their production renderer clients, a trusted main-process IPC bridge, `GuiMmsController`, framed `LocalMmsClient`, and a real `MousseMainService` profile.

For E2E01 it creates an Agent through the rendered library/editor, selects a real catalog model, changes the accessible Orb palette control, enters an exact multiline Monaco prompt, saves, and publishes. It then stops the protocol and service, recreates them over the same home, loads the persisted definition through the production renderer client, and runs it from the real `TryRunPanel`. A scripted provider is the only external boundary. The assertions cover the exact model and system prompt received by the provider, completed UI result, durable profile-owned run record, and durable user/assistant thread messages.

For E2E02 it creates a blank Workflow in the rendered editor, uses the canvas auto-layout action, changes the source manifest, returns to the canvas, saves, publishes, exports through Electron's completed `DownloadItem`, and imports through the real file input. The backend assertions establish a second persisted definition with stable node IDs, edges, and editor visual state. The workflow run inventory stays empty before and after restart, proving import did not execute the workflow.

The fixture owns its MMS lease, waits for Electron termination on timeout, and wraps both launches and the restart boundary in service/protocol cleanup.

## Evidence

- `npx vitest run tests/platformEditorCrossFeature.test.ts --maxWorkers=1 --minWorkers=1 --reporter=verbose`: 1 passed in 13.33 seconds; the real Electron test body completed in 5.20 seconds.
- `npx tsc --noEmit -p tsconfig.node.json --pretty false`: passed.
- `git diff --check`: passed.

## Limits

The model response is scripted and all persistence and transport remain local; no live model, account, credential, or network service is used. The fixture exercises the actual editor workspaces and production clients in a purpose-built Electron page rather than the full application shell. The post-restart page renders the persisted Agent summary, palette, and production `TryRunPanel`; it does not reopen the full Monaco editor after restart. Workflow execution is deliberately absent because E2E02 qualifies semantic import without execution.
