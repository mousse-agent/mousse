# Sol review: native agent runtime policy

Reviewed core: `f3207b54d2ac19cb7a748d57676818909ba1909c`  
Candidate: `93e5d2b`  
Core merge: `55916cf`  
Reviewed implementation freeze: `a691155`

## Findings fixed

- `projectPath` was promoted to a canonical filesystem root when the trusted host supplied no roots. A renderer/request path can no longer create authority; native filesystem tools fail closed until the host binds workspace roots.
- Context lineage rejected a foreign definition only for profile-agent memory. Every supplied definition identity is now checked before dispatch. Selected-file snapshots are filtered to configured paths and required file lists report the exact missing paths.
- `maxContextTokens` admitted one oversized recent history entry and did not share its bound with project context, files, attachments, and memory. Host snapshot sources now consume one UTF-8/4 budget before history is selected; fixed system instructions remain outside this context-source budget.
- A requested zero-turn budget still contacted the provider. Exact exhaustion of turn, input, output, or cost budget now prevents the next retry/fallback attempt and reports the actual exhausted limit.
- Successful fallback results reported the final attempt's nonzero usage instead of cumulative usage. Input, output, total tokens, and cost now come from aggregate attempt accounting.
- Recovery backoff ignored cancellation. Backoff now clears its timer and rejects with `AbortError` as soon as the run signal aborts.
- Approval cancellation could hang when the host callback synchronously aborted and returned a never-settling promise. The abort listener is installed before invoking the callback, and the wait races cancellation. Tool arguments and canonical paths are still revalidated immediately before dispatch.
- `fallbacks.allowHigherCost=false` was ignored because resolved model capabilities carry no price data. Native fallback now fails closed unless higher cost is explicitly allowed; a future host may instead supply cost-qualified fallback models. CLI fallback is also rejected because the process adapters do not implement selection or aggregate attempt accounting.
- The core I04 `CliCapabilityError` report was flattened into `RUNTIME_ERROR`. `AgentExecutionService` now preserves `CLI_CAPABILITY_UNSUPPORTED`, its message, and the exact capability report in `error.details.report`.

## Adversarial coverage added

- unrelated definition context, extra selected-file exclusion, and shared context truncation
- zero-turn admission before any provider call
- cancellation during a synchronously cancelling, permanently pending approval callback
- cancellation during a 60-second fallback backoff without dispatching the fallback provider
- fallback cost qualification failure
- exact I04 CLI capability report preservation

The real native tests use `LlmClient` with a deterministic local model transport. Filesystem and shell effects stay in owned `mousse-agent-runtime-policy-*` temporary roots and cleanup verifies the prefix before recursive removal.

## Remaining integration work and limits

- Root still needs to compose the production profile-owned `LlmClient`, durable cancellation/run history, trusted workspace roots, host context snapshots, and the approval callback through `MousseAgentService`/the orchestrator lifecycle. This branch does not own that lifecycle.
- Workspace-mode bash is an explicitly enabled unsandboxed process. Its cwd is checked, but shell commands and subprocesses can address paths outside the workspace. `sandboxed` mode and network isolation continue to fail closed.
- Filesystem containment revalidates canonical paths immediately before execution, but check and use remain separate OS operations, so a hostile local filesystem actor can race symlink changes.
- The context limit covers host context sources using a conservative UTF-8 byte estimate. Fixed system instructions, tool schemas, and granted Skill instructions are outside that setting and remain subject to the provider context window.
- MCP calls are classified conservatively as mutating for unattended policy. Their external idempotency cannot be inferred from the MCP schema.
- External CLI output still cannot provide authoritative token/cost/tool accounting. This review preserves I04 capability diagnostics but does not qualify live external CLIs.
- No live provider, model, account, MCP endpoint, or channel was used. No Orb files were changed.

## Validation

```text
npx vitest run tests/platformAgentRuntimePolicy.test.ts tests/platformAgentExecution.test.ts tests/platformAgentCliMaterialization.test.ts --maxWorkers=2 --minWorkers=1
  3 files, 32 tests passed

npx vitest run tests/platformAgentRuntimePolicy.test.ts tests/platformAgentExecution.test.ts tests/platformAgentCliMaterialization.test.ts tests/platformAgentDefinitions.test.ts tests/platformAgentDomains.test.ts tests/llmNativeToolLoop.test.ts tests/toolLoopSafety.test.ts tests/toolPathSafety.test.ts tests/planModeTools.test.ts tests/quickActionTools.test.ts tests/platformIntegrationMcpRuntime.test.ts tests/agentSpawning.test.ts tests/agentLifecycleStatus.test.ts tests/subagentModelSettings.test.ts tests/mousseAgent.test.ts tests/mousseAgentChat.test.ts --maxWorkers=2 --minWorkers=1
  16 files, 152 tests passed

npm run typecheck -- --pretty false
  passed: tsconfig.node.json and tsconfig.web.json

npm run build:cli
  passed: out/cli/index.js built

git diff --check
  passed; Git emitted line-ending conversion notices only
```
