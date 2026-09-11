# Production workflow Agent/Instruction adapter

This slice binds `agent` and `instruction` workflow nodes to the existing native `AgentDefinitionRegistry` / `AgentResolver` snapshot and `OrchestratorService.runAgentDefinition` LlmClient loop. It does not edit the workflow coordinator, `executionBindings`, profile composition, protocol, renderer, or browser owners. Root wires the adapter after import.

## Importable host API

```ts
import { MmsWorkflowAgents } from '../src/mms/platform/MmsWorkflowAgents'
import {
  WORKFLOW_AGENT_BINDINGS_FIELD,
  mergeWorkflowAgentBindings,
  mergeWorkflowAgentPreparation,
  mergeWorkflowAgentInstallationPolicy,
  type WorkflowAgentExecutionBindings
} from '../src/shared/workflows/agentExecutionBindings'

const agents = new MmsWorkflowAgents(services, async (context) =>
  (await this.workflowRuns.runtime.get(context.runId!, { profileId })).manifest
)
this.workflowRuns.configureAdapters({ agent: agents.agent, mcp: this.workflowIntegrations.mcp, skill: this.workflowIntegrations.skill })
agents.setBrowserRuntime(port) // same port as OrchestratorService / MmsAgentExecutionService
```

### Top-level admission merge

`prepareExecution` currently only calls `workflowIntegrations.prepare`. Compose both, then persist the merged bindings before engine admission:

```ts
prepareExecution: async (request, record) => {
  const integrations = await this.workflowIntegrations.prepare(request, record)
  const prepared = await agents.prepare(request, record)
  return mergeWorkflowAgentPreparation(integrations, prepared)
}
```

Exact additive field on `WorkflowExecutionBindings`:

```ts
agents?: WorkflowAgentExecutionBindings
// WORKFLOW_AGENT_BINDINGS_FIELD === 'agents'
```

```ts
interface WorkflowAgentExecutionBindings {
  version: 1
  profileId: string
  snapshotDigest: string
  pins: Array<{
    kind: 'main' | 'user'
    requestedDefinitionId?: string
    requestedRevision?: string
    definitionId: string
    revision: string
    snapshotHash: string
    runtimeKind: AgentRuntimeKind
  }>
}
```

Full resolved definition/settings live in a content-addressed artifact `workflow-agent-bindings/snapshots/{snapshotHash}.json`, referenced by `snapshotHash` / `snapshotDigest`. The adapter also indexes the admission by `requestId` so dispatch works before this field lands on `executionBindings`. Root should still merge the field so child recovery and public-run rejection stay consistent with Skill/MCP pins.

Do not accept `agents` from public run DTOs.

### Child inheritance hook

Child starts bypass coordinator `prepareExecution`. Before internal `WorkflowRunService.start`, call:

```ts
await agents.prepareInherited({
  parent: parent.executionBindings?.agents ?? { requestId: parent.requestId! },
  request,
  record
})
```

This copies only pins declared by the child graph from the parent's admitted snapshot. It does not resolve current model, integration, or agent heads. Fail closed if a required parent pin is missing.

Intersect child installation policy with the inherited parent policy using the existing `ExecutionPolicyService.snapshot` narrowing. Merge with the Skill/MCP child hook owned by the other worker:

```ts
mergeWorkflowAgentPreparation(childIntegrations, childAgents)
```

## What this adapter does

- Pins user-created native agent revisions (explicit node revision, else the published head at prepare time) and a host-derived `main` snapshot for instruction/main nodes.
- Verifies profile, thread, project, running manifest identity (run/turn/actor/source/cancellation/policy digest), and exact pin/hash on every invoke.
- Narrows advertised grants/effects to the inherited workflow policy. MCP requires `external` + `mcp.invoke`; write/script tools require `write`; browser tools require their catalog capability.
- Passes node instructions as labeled workflow context and node `outputSchema` through existing `compileAgentInstructions` / structured-output validation. Input is the user message.
- Preserves cancellation, clamps tool/elapsed budgets to the admitted policy, and uses the engine `idempotencyKey` as execution identity.
- Duplicate invoke with a completed key returns the stored output/usage and does not call the provider. A dispatched key without a durable result is `unknown_effect` and is not replayed. Cancelled/failed terminal records are also not replayed.
- Returns parsed model output plus token/cost usage. Failed/cancelled runs throw; they are never reported as success.
- External CLI runtimes fail at prepare with `executor_unavailable` and `hostBindings: ['qualified CLI process lifecycle']`. Unsupported native settings (persistent memory, selected files, unbound browser/delegation/sandbox) fail the same way.
- Model provider/model ids are taken from the pinned snapshot. Catalog lookup remains the installation-shared `SharedAgentModelLookup` / `ProviderAuthService`. Resume does not pick a later model or grant set.
- Workspace roots come from the verified project path or a run-private directory under the profile binding store. Caller `ExecutionContext` is not path authority.

`AgentResolver.resolveOwned` is the only agent-definition seam added: it resolves an already-owned settings/prompt snapshot without reading current registry heads. Invoke never calls the resolver.

## Root composition after merge

1. Construct one `MmsWorkflowAgents` per profile with the running-manifest callback above.
2. `configureAdapters({ agent: agents.agent })` (keep existing MCP/Skill adapters).
3. Call `agents.prepare` from top-level `prepareExecution` and merge with Skill/MCP bindings via `mergeWorkflowAgentPreparation`.
4. Call `agents.prepareInherited` from the child-admission hook, using the parent's persisted `agents` field (or parent `requestId` until that field exists).
5. Dispose with the coordinator. Optionally `setBrowserRuntime` with the same port bound on the orchestrator; browser-enabled definitions still fail closed until that port is present.
6. Do not pass renderer-supplied absolute paths, forged execution contexts, or live grant lookups into invoke.

## Validation

`tests/platformWorkflowAgents.test.ts` uses the real MMS profile services and scripted local `streamSimple` provider:

- instruction node through coordinator admission
- pinned user-agent node after draft/head mutation
- forged/foreign context isolation
- in-flight cancellation
- duplicate invocation and unknown-effect without replay
- policy-narrowed tool advertisement
- explicit CLI unsupported failure and child pin inheritance

No live accounts, provider network, browser download, or sending channels.

```
npx vitest run tests/platformWorkflowAgents.test.ts
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npm run build:cli
```
