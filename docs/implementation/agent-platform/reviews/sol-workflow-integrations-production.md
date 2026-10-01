# Sol review: production workflow MCP and Skill integrations

Reviewed candidate: `405ad326e89b0c223ab76e06173486c393bd7602`

Merge checkpoint in the retained profile branch: `9a4dc19`

Qualified implementation freeze: `af02bd9b5e38dcd26ce364c0fba2dbaf7a0623ca`

Disposition: accepted after the fixes below for top-level profile-owned workflow Skill loading and MCP execution. This does not close W02, W03, I04, P04, or a release gate.

## Findings fixed

1. Workflow preparation used `McpManager.getEnabledTools`, which enumerated and connected every enabled MCP installation even when the graph referenced only one. This contradicted the claimed admission boundary and could start unrelated local processes. `getEnabledToolsForServer` now applies the same profile/actor/selection/tool gates to one exact installation and connects only that server during preparation and dispatch revalidation. A real stdio fixture records process startup and proves an enabled unrelated server remains stopped.
2. Durable coordinator admission files bounded and structurally checked reads, but their host-prepared policy, execution bindings, definition revision, and ownership fields were not covered by an integrity digest. A valid-shape file mutation could therefore survive the original caller-request digest. New admission records include a canonical SHA-256 over the complete prepared record, excluding the digest field itself, and replay rejects a changed record before creating another run or thread. The 16 MiB write bound includes this digest.

## Security and recovery assessment

Public `workflowRuns.start` rejects `executionBindings`; only coordinator preparation supplies pins. The engine request digest includes the prepared bindings and installation policy. Adapter scope checks bind profile, project, thread, run, turn, actor, source, cancellation ID, and the recomputed immutable policy snapshot to the running manifest. Skill bytes and content hash remain pinned across edit and graceful host restart, while current installation enablement is checked again at load time.

MCP dispatch validates the pinned installation, configuration revision, tool and schemas before transport. `McpManager.callTool` rechecks the connected configuration, owning run callback, current profile selection and tool authorization after asynchronous connection setup and immediately before `client.callTool`. Cancellation reaches an in-flight stdio request, and replay of the same durable admission does not issue a second tool call.

The engine writes an external-effect intent before entering the MCP adapter. Consequently schema, revocation, configuration, or cancellation failures detected inside the adapter may resolve conservatively as `unknown-effect` even when the fixture proves no transport call occurred. This is safe and does not auto-retry an external effect. A future typed pre-dispatch result can reduce reconciliation work only if the engine can distinguish it durably from a transport attempt.

## Evidence

- `npx vitest run tests/platformWorkflowIntegrations.test.ts tests/platformWorkflowCoordinator.test.ts tests/platformIntegrationMcpRuntime.test.ts tests/platformIntegrationActor.test.ts --maxWorkers=2 --minWorkers=1` — 4 files, 39 tests passed: 10 workflow integration cases and 29 coordinator/MCP/actor regressions.
- `npm run typecheck` — node and web TypeScript projects passed.
- `npm run build` — Electron main, preload, renderer, and CLI builds passed. Vite emitted the pre-existing CSS parser warning and dynamic/static import chunk warning; neither failed the build.

The framed integration suite uses real profile services, local protocol clients, and a local stdio MCP fixture with independent process/call/cancellation logs. It covers one observed external call across idempotent retry, pinned Skill bytes after edit/restart, explicit historical Skill revision, profile isolation, caller binding rejection, context/policy ownership, asynchronous revocation, configuration/schema rejection before observed dispatch, cancellation, and unrelated-server non-start. No model, user account, hosted channel, third-party server, or production credential was used.

## Remaining limits

Skill registry discovery still reads the referenced current Skill before the new 1 MiB admitted-content check. Historical revision reads and general discovery need their own pre-allocation bounds rather than relying on the post-read binding limit.

Child workflow admission does not run the top-level preparation hook. Integration-bearing child workflows therefore remain fail closed until the parent admission resolves transitive child revisions and dependency pins and narrows them through inherited authority. This review does not recommend bypassing that grant or resolving a child against its current head during execution.

The admission record digest detects accidental or partial corruption; it is not a keyed authenticity mechanism against an attacker who can rewrite the profile store and recompute hashes. Existing canonical-root, regular-file, identity, and size checks remain the local storage boundary.

Process-kill recovery during an in-flight MCP effect was not added here. Existing workflow unknown-effect crash recovery remains the governing behavior, and the adapter does not automatically replay external calls. Skill package resources/execution, OAuth interoperability, broader schema dialects, output artifact projection, Agent/main-agent/browser adapters, schedules/channels, packaged acceptance, and the complete profile deletion lifecycle remain separate work.
