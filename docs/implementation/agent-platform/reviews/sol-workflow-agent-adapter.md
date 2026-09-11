# Sol review: workflow Agent/Instruction production adapter

Reviewed candidates: `0801b4e` and `50de6e173e682e65adeaf00c38bb5be1a656a209`

Qualification base: `22aa443` (including reviewed child recovery `017c4133bda9fa182a49533d943bd06a14f1ccfd` and stable child request IDs).

## Result

Qualified after fixes. Workflow admission persists exact resolved Agent snapshots, retry preparation uses those persisted pins, and native dispatch is constrained by the admitted workflow policy.

The review fixed two material authority gaps:

- Agent preparation now contributes every pinned builtin tool, MCP tool, and Skill capability to the installation policy. Dispatch then intersects grants with the exact admitted `allowedTools`, effects, and capabilities; a parent or child cannot recover tools omitted by its policy ceiling.
- Dispatch now verifies that every pinned native grant is still enabled and has the same revision/hash before starting provider work. Revocation fails with `capability_denied`; changed Skill or MCP material fails with `stale_revision`. Newly enabled grants do not expand the persisted snapshot.

A production parent-to-child test starts through `platform.workflowRuns`, waits for the parent's real approval, publishes a new Agent head, approves the parent, and proves the child executes the old transitive prompt exactly once from its persisted binding. The test exercises automatic admission composition and the stable child request ID rather than calling the preparation hook directly.

## Verification

- `npx vitest run tests/platformWorkflowAgents.test.ts --maxWorkers=1 --reporter=dot` — 1 file, 10 tests passed.
- `npx vitest run tests/platformWorkflowSubworkflowRecovery.test.ts --maxWorkers=1 --reporter=dot` — 1 file, 15 tests passed.
- `npm run typecheck` — node and web TypeScript projects passed.
- `npm run build:cli` — passed and generated `out/cli/index.js`.
- `git diff --check` — passed, with only expected LF-to-CRLF checkout notices.

No live providers, accounts, or network calls were used. Provider transport remained deterministic.

## Reviewed limits

- Agent-internal Skill and MCP grants persist identity, revision, and hash, but the Agent binding does not embed historical Skill bytes or MCP schemas. A changed installation therefore fails closed instead of replaying the historical material. Exact offline replay would require a native runtime integration-material binding through the orchestrator and `LlmClient`.
- The invocation record is deliberately marked `dispatched` before provider entry. A crash in that narrow pre-provider window can conservatively become `unknown_effect`; it will not replay a possibly sent mutation.
- External CLI Agent runtimes remain unsupported in workflow Agent nodes.
- Profile shutdown ownership is supplied by the coordinator/runtime: it stops admission, aborts active drivers, and awaits native calls. The adapter's own dispose boundary only prevents new adapter work.
