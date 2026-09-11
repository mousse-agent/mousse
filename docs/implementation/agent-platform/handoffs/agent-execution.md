# A03 agent execution

Commit `f7d7099306ed60d2f2cd7db255ca614b11d9ce56` introduced the profile-fenced `AgentExecutionService` and shared execution contract. The follow-up native qualification adds the real `LlmClient` provider seam and `createNativeAgentRuntime` in the current worktree.

`AgentExecutionService.run()` accepts a resolved immutable definition plus `{ profileId, threadId, projectPath, input, signal, budget }`. It rejects profile mismatches, preserves input bytes after blank validation, clamps caller budgets to definition limits, starts no deadline timer when no adapter is registered, treats `maxElapsedMs: 0` as unlimited, and returns completed/failed/cancelled status with runtime history and usage. It does not manufacture a provider system message in history.

The trusted native seam is `LlmChatOptions.trustedAgent` in `src/mms/orchestrator/LlmClient.ts`:

```ts
{
  systemPrompt: string
  grants: EffectiveAgentGrants
  budget: AgentExecutionBudget
}
```

`createNativeAgentRuntime(llm)` passes the resolved model provider/model/effort, system prompt, project/thread scope, grants, budget, and abort signal into that seam. `LlmClient` uses the existing provider stream and tool loop, advertises only granted built-in/MCP tools, rejects forged returned tool calls before dispatch, loads granted skills, and reports turn/tool/input/output/cost/time limits through `limitExceeded`. Provider messages remain the source of truth for history; the adapter maps user/assistant/tool-result messages and leaves the provider system prompt in the provider request context.

`createCliProcessRuntime` is a real child-process adapter. `buildSupportedCliInvocation` uses documented runtime channels: Claude Code `--system-prompt`, `--max-turns`, `--allowedTools`, and optional `--mcp-config`; Codex `exec -c developer_instructions=...`; OpenCode `OPENCODE_CONFIG_CONTENT` with a named agent and `prompt`, selected by `--agent`; Cursor requires a materialized rules file because its print CLI has no system-prompt option. The adapter no longer injects Mousse-only environment variables and never concatenates system instructions into the user prompt.

Validation in this pass: `tests/platformAgentExecution.test.ts` 8 tests, `tests/llmNativeToolLoop.test.ts` 6, `tests/providerStreamStall.test.ts` 7, `tests/platformAgentDefinitions.test.ts` 22, plus node and web TypeScript checks. The provider fixture exercises serialized system/user separation, filtered advertised tools, forged returned tool rejection, budget termination, and abort propagation through the real stream loop.

Remaining root wiring is deliberate: bind `createNativeAgentRuntime` to the profile-owned `LlmClient`; provide profile-owned MCP/skill registries and the existing `AgentConfigManager` materialized files to CLI invocation builders; materialize Cursor rules in the isolated worktree; and persist execution/run history through the production coordinator. Codex/OpenCode/CLI tool permission enforcement must remain in their supported config/permission materializers; this package does not claim that an arbitrary external CLI honors grants without those bindings.
