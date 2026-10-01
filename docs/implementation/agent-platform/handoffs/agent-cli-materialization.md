# I04/A03 CLI materialization handoff

Reviewed A03 merge: `3e8f589307da2b6459d013c87b253ce987c4890d`

Implementation: `f7c69d9401d695280cc48534492aa34eae4e4722`

Reviewed integration checkpoint: recorded in `docs/implementation/agent-platform/reviews/sol-agent-cli-materialization.md`

`AgentConfigManager.prepareExact(agentId, cliType, worktreePath, projectPath, grants)` resolves immutable `EffectiveAgentGrants` against current profile-owned Skill/MCP snapshots, verifies pinned revision/hash values, and materializes only selected roots and servers. Missing or changed dependencies become blocking diagnostics.

`AgentExecutionMaterializer.prepare(...)` can add runtime files for Cursor and OpenCode. It returns generated paths, diagnostics, Claude's collision-resolved MCP tool-name map, and an owned `cleanup()` callback. Runtime files are contained by the worktree, atomically written, and never overwrite a pre-existing path. Cleanup removes only exact content written by this invocation and preserves caller changes.

`inspectCliCapabilities(input, options)` returns `{ runtimeKind, supported, consumedGrantIds, issues }`. `buildQualifiedCliInvocation` refuses unsupported or missing materialization, and `createQualifiedCliProcessRuntime` performs this check immediately before spawn. Process cleanup runs after normal exit, cancellation, output overflow, spawn failure, or process crash.

The qualified matrix is conservative:

- Claude Code can qualify for `read`, `write`, `edit`, `bash`, `grep`, and `ls`, plus MCP grants when the host supplies a strict profile-owned MCP config and the materializer's exact stable-grant-to-runtime-name map. Unknown built-ins fail closed.
- Codex, Cursor Agent, and OpenCode fail closed even with an empty grant set because the inspected runtimes retain built-in capabilities for which Mousse has no qualified exact allowlist.
- No inspected CLI exposes a qualified exact Skill allowlist. Any Skill grant fails with `unsupported_permission`; copying a Skill package is not treated as proof that the runtime will limit itself to that package. Skill traversal rejects symlinks, non-file nodes, and packages over 10,000 files or 100 MiB before copying.

Claude and Codex receive the user prompt over stdin, preventing option-shaped prompt text from being parsed as process arguments. Exported legacy builders remain compatibility helpers; production must use the qualified builder immediately before spawn.

Root composition should create one `AgentExecutionMaterializer` from the profile-owned `AgentConfigManager`, then use `createQualifiedCliProcessRuntime({ prepareInvocation })`. The callback passes returned paths, `claudeMcpToolNames`, and `materializationErrors` into `buildQualifiedCliInvocation`, and supplies `cleanup: materialization.cleanup`.

`AgentExecutionResult.error.details` is additive in the shared DTO. The production `AgentExecutionService` catch path still needs to preserve a `CliCapabilityError` as `CLI_CAPABILITY_UNSUPPORTED`, `retryable: false`, with `error.report` copied into `details`.

The local fixture proves exact Skill/MCP materialization, revision checks, symlink rejection, collision preservation, authoritative Claude tool-name mapping, stdin prompt transport, fail-closed reports, and cleanup after a real local child exits with a crash code. It uses no provider request, live account, MCP endpoint, credential, or external agent run. Installed CLI audit: Claude Code `2.1.214`, Codex CLI `0.154.0`, Cursor Agent `2026.07.23-e383d2b`; OpenCode's shim points to a missing executable and was not evidence.

```text
npx vitest run tests/platformAgentExecution.test.ts tests/platformIntegrationMaterialization.test.ts tests/platformAgentCliMaterialization.test.ts --maxWorkers=2 --reporter=dot
  3 files, 21 tests passed
npm run typecheck
  passed
npm run build:cli
  passed
```

This handoff does not claim live provider qualification, native composition, run/history projection, external-CLI token/cost usage, or exact permission support for Codex/OpenCode/Cursor.
