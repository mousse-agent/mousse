# I04/A03 CLI materialization handoff

Branch: `feat/platform-integrations-ui`  
Reviewed A03 merge: `3e8f589307da2b6459d013c87b253ce987c4890d`

Implementation: `f7c69d9401d695280cc48534492aa34eae4e4722`

This follow-up closes the reviewed CLI qualification gap in the integrations and agent-definition seams. `AgentConfigManager.prepareExact(agentId, cliType, worktreePath, projectPath, grants)` resolves the immutable `EffectiveAgentGrants` against the current profile-owned Skill/MCP snapshots, verifies pinned revision/hash values, and materializes only the exact selected Skill roots and MCP servers. Missing or changed dependencies become error diagnostics and are never silently replaced.

`AgentExecutionMaterializer.prepare(...)` adds runtime-consumable files for Cursor (`.cursor/rules/mousse-agent.mdc`) and OpenCode (a dedicated `.mousse/agent-runtime/opencode.json` with the pinned agent prompt/model). It returns the generated MCP config path, runtime file paths, preparation diagnostics, and an owned `cleanup()` callback. Runtime files are marker-owned, contained by the worktree, atomically written, and preserved if a caller changes them after materialization.

`inspectCliCapabilities(input, options)` returns `{ runtimeKind, supported, consumedGrantIds, issues }`. `buildQualifiedCliInvocation` refuses unsupported or missing materialization, and `createQualifiedCliProcessRuntime` performs this check immediately before spawn. `CliProcessInvocation.cleanup` runs once after normal exit, cancellation, output overflow, spawn failure, or process crash, so the host can pass the materializer cleanup callback without deleting unowned files.

The qualified runtime matrix is deliberately conservative:

- Claude Code is qualified for `read`, `write`, `edit`, `bash`, `grep`, and `ls` mapped to the documented runtime names, plus MCP grants when the host supplies an exact `server/tool -> runtime tool` map and strict profile-owned MCP config. Unknown Mousse built-ins fail closed.
- Codex has documented ephemeral/ignored-user-config/sandbox/config controls but no qualified exact built-in or MCP tool allowlist. Any such grant fails with `unsupported_permission`.
- Cursor Agent documents that print mode has access to all tools and exposes no exact allowlist. Any built-in or MCP grant fails with `unsupported_permission`; pinned Skills remain materializable through the rules/skills paths.
- OpenCode’s installed command shim is malformed on this machine, and no exact permission surface was qualified. Any built-in or MCP grant fails closed. A profile-owned agent config is required for the qualified instruction path.

Root composition should create one `AgentExecutionMaterializer` from the profile-owned `AgentConfigManager`, then use `createQualifiedCliProcessRuntime({ prepareInvocation })`. The callback should call `materializer.prepare(...)`, call `inspectCliCapabilities` through `buildQualifiedCliInvocation` with its returned paths and exact Claude MCP map, and return the paths plus `cleanup: materialization.cleanup`. A `CliCapabilityError` carries the complete report; the host should preserve its `CLI_CAPABILITY_UNSUPPORTED` code/details in the execution result rather than flattening it to an opaque runtime error.

`AgentExecutionResult.error.details` is additive in the shared execution DTO for this report preservation. Root’s `AgentExecutionService` catch path should detect `CliCapabilityError`, set `code: 'CLI_CAPABILITY_UNSUPPORTED'`, `retryable: false`, and copy `error.report` into `details`.

The local fixture in `tests/platformAgentCliMaterialization.test.ts` proves exact Skill/MCP materialization, revision checks, marker-owned cleanup, real local process consumption of the qualified Claude MCP path, fail-closed Codex/Cursor capability reports, and cleanup after a real child process exits with a crash code. No provider request, live account, MCP endpoint, credential, or external agent run was used. Installed CLI audit: Claude Code `2.1.214`, Codex CLI `0.154.0`, Cursor Agent `2026.07.23-e383d2b`; OpenCode’s `opencode.cmd` points to a missing executable and was not treated as evidence.

Validation on this branch:

```text
npx vitest run tests/platformAgentExecution.test.ts tests/platformIntegrationMaterialization.test.ts tests/platformAgentCliMaterialization.test.ts --maxWorkers=2 --reporter=dot
  3 files, 21 tests passed
npm run typecheck
  passed
npm run build:cli
  passed
```

This handoff does not claim live provider qualification, native Mousse composition, run/history projection, token/cost usage from external CLI stdout, or exact permission support for Codex/OpenCode/Cursor.
