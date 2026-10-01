# Sol review: workflow child composition

## Revisions

- Candidate: `289e03d`
- Candidate merge: `e6fffcf`
- Review fixes: `186668bc202700283759aa653d75c1dca77fb6eb`, `0537a04d5f412f5afa85dc6eb99db4bba21bb0fc`

The review covered coordinator child scheduling/recovery, engine child admission and usage propagation, transitive MCP/Skill/project-tool preparation, and focused runtime tests. It did not modify or review the concurrently developed `MmsWorkflowAgents` implementation.

## Findings fixed

1. **A child could weaken the parent's approval requirements.** The child request omitted `approvalEffects`, so a child MCP node could execute after its explicit graph approval without the required external-effect approval. Child installation and run policies now always include the parent snapshot's approval effects. Any host `prepareChildAdmission` override is intersected with the parent tools, effects, capabilities, the child's compiled permissions, and remaining budgets; additional approval requirements are unioned. The framed test now observes and accepts a distinct approval for the child MCP node before the local stdio call occurs.

2. **Child usage was not crash-atomic across the parent manifest and checkpoint.** The previous implementation incremented the manifest and then wrote the `subworkflowUsageCharged` flag. A crash between those files could charge again. The checkpoint now first stores the child identity and absolute target totals, the manifest is assigned those totals, and the checkpoint finally marks the charge consumed. Recovery can repeat either remaining write without addition. Existing succeeded/failed/cancelled resume tests continue to prove terminal usage is charged once; this review did not add a separate process-kill fixture at each of the two new storage boundaries.

3. **Project tools used only by a transitive child were absent from parent admission.** `MmsWorkflowTools.prepare()` now traverses the same pinned transitive child records as MCP/Skill preparation. A real framed parent-to-child Pi `read` workflow proves the child inherits the exact admitted tool and still requires its external-effect approval.

4. **Tracked coordinator promises could create unhandled rejection chains.** `track()` used an ignored rejecting `finally()` promise, and several child watch/nudge paths supplied uncaught promises. Settlement cleanup now uses handled `then` branches and reports watch/nudge errors through the coordinator error hook.

5. **Child runs had no stable admission request identity.** Child requests now derive a deterministic UUID from the profile, parent run ID, and exact parent instance key. The identity is unique across loop/nested instances and remains exact across retries and host reconstruction, allowing Agent preparation records to be durably indexed without mutable child inputs.

## Verified candidate behavior

- Deferred child input and approval controls wake the parent without a second public parent resume.
- Child timers reconstruct after host recreation; linked child identities are reused rather than re-admitted.
- Actual child-process kill cases preserve input, approval, timer, and unknown-effect waits.
- Parent cancellation settles its owned child.
- Parent admission snapshots include transitive pinned Skill/MCP bytes and configuration identities; an edited current Skill head does not change the child.
- Missing/conflicting pins and unrelated child pointers fail closed.
- Terminal child token/cost/tool/artifact usage is projected once and parent limits apply.

## Agent-binding composition hook

Root should keep `MmsWorkflowCoordinatorOptions.prepareChildAdmission` and compose the frozen Agent adapter additively:

```ts
prepareChildAdmission: async (request, parent, child) => {
  const integrations = workflowIntegrations.prepareChildAdmission(request, parent, child)
  const agents = workflowAgents.prepareInherited({
    parent: parent.executionBindings?.agents ?? { requestId: parent.requestId! },
    request,
    record: child
  })
  return mergeWorkflowAgentPreparation(integrations, agents)
}
```

The engine applies its parent-policy ceiling after this callback, so the Agent merge may add immutable binding data but cannot widen runtime authority. Root must validate the optional durable `executionBindings.agents` field and include it in existing size/digest checks. The fallback `{ requestId }` must only support explicitly defined backward compatibility; a child that needs an Agent pin must fail closed when its parent admission has no corresponding snapshot.

## Qualification

- `npx vitest run tests/platformWorkflowCoordinator.test.ts tests/platformWorkflowSubworkflowRecovery.test.ts tests/platformWorkflowIntegrations.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=30000` — 3 files, 41 tests passed.
- `npx vitest run tests/platformWorkflowDurabilityMatrix.test.ts tests/platformWorkflowRuntime.test.ts tests/platformWorkflowRunDomains.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=30000` — 3 files, 60 tests passed.
- `npm run typecheck` — node and web TypeScript passed.
- `npm run build` — Electron and CLI build passed; pre-existing mixed-import and malformed generated-CSS warnings remain.

No provider, account, channel, or browser was used. The MCP fixture is a local stdio child.

## Remaining scope

- Concurrent child waits remain authoritative on the child run while the parent view mirrors one selected wait.
- The final Agent binding schema, preparation, execution, and reconstruction path requires its separate review after root composition.
- Packaged cross-platform child execution and a combined Agent/MCP/Skill/browser/project-tool workflow remain release qualification work.
