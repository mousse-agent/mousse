# Sol production workflow runs review

Reviewed integration base: `3e8f589307da2b6459d013c87b253ce987c4890d`  
Reviewed candidate: `3afd39ca96d9c93751924fb5bb63a944b9be6deb`  
Candidate merge: `8083b2b54630ec922079a488a2b0893f627f81c8`  
Review fix: `0ca59b4fe8e6a850b4f888881546da40742c855a`

## Findings fixed

- **Start request identity was optional at the public client boundary.** The coordinator persisted and replayed request identities correctly, but a typed caller could omit the ID and the renderer client would generate one at transport-call time. A retry could therefore create a second durable run. `WorkflowStartRequest.requestId` is now required, the client forwards the caller-owned value unchanged, and the run panel generates and retains one UUID for a logical start until admission succeeds.
- **Sandboxed scripts passed admission without a sandbox adapter.** The preflight check covered node-family adapters but treated every script as the built-in trusted-local executor. A sandboxed script could create its execution thread and durable run before failing. Preflight now rejects it with `executor_unavailable` before any thread or run is created.

## Reviewed behavior

The coordinator pins the exact published revision or saved draft hash, validated input, actor, policy, source and owning thread in a durable admission record before dispatch. Same-profile replay of an identical request ID returns the original run and thread after reconstruction or later publication; a changed digest conflicts. Partial thread initialization is repaired without replacing existing messages. Project reads reject traversal and per-segment symlinks, open bounded regular files, compare handle identity, and recheck containment and ownership.

Profile startup restores admitted work and durable root timers. Timer callbacks use deferred control admission, retry temporary lease contention, and subscriptions/timers are disposed with the profile service. Run-domain methods bind profile/run/revision/approval identities and return bounded views. The desktop client prevents overlapping polls, ignores late unsubscribed results, does not replace a newer control response with an older poll, and stops terminal polling. The editor preserves a start UUID after transport failure, keeps required-input forms editable, retains typed/incomplete JSON, and uses the published schema for library runs.

No paid model, account, channel, MCP endpoint, or browser service was used. The framed production fixture uses profile stores, MMS framing, the application execution client, the real workflow engine, approval persistence and a local Node child process.

## Verification

```text
npx vitest run tests/platformWorkflowCoordinator.test.ts tests/platformWorkflowRunDomains.test.ts tests/workflowExecutionClient.test.ts tests/platformWorkflowUi.test.ts tests/platformProductionComposition.test.ts --maxWorkers=2 --reporter=dot
  5 files, 35 tests passed

npm run typecheck
  node and web TypeScript projects passed

npm run test:workflow-editor
  50 hidden Electron checks passed
```

The Electron fixture exercised canvas/source save, typed input validation, duplicate-click admission, draft and published schema selection, profile/dirty-navigation guards, history/read-only restoration, and populated narrow and desktop graphs with rendered edges. I inspected `.mousse-dev/workflow-editor-evidence/desktop.png` and `narrow.png`; nodes and connections are visible, controls have usable dark-theme contrast, and the narrow graph remains populated. This controlled renderer fixture is explicitly fixture-labelled; framed MMS tests provide separate production-host evidence.

## Remaining scope

- The queued W02 candidate `0423d96eda7474602fcaf4ef8c072330cf1e87f6` still needs review and reconciliation. It owns real sandbox dispatch, concurrent waits, pinned instruction resources, corrupt-inventory diagnostics, collision-safe staging and durable pause. The current compiler catalog grants every script node `script.trusted-local` even when its `executionMode` is `sandboxed`; W02 must define and test the final sandbox capability contract rather than inheriting trusted-local authority.
- Current public views project one pending approval/input/unknown effect. Concurrent per-instance waits from W02 need additive DTO/domain/UI projections, including authoritative nested `nodeId`, without guessing from renderer data.
- Agent, Skill, MCP, tool and browser adapters are not installed in production composition. Exact profile policy, actor grants, cancellation ownership and adapter recovery remain required. Unavailable adapter families fail admission truthfully.
- Root recovery errors are not yet part of the desktop event projection. Trace/history paging still loads complete journals before bounding the response. Breakpoint and dry-run controls remain optional and are not production-composed.
- Slash ingress, structured CLI commands, main-agent workflow tools, schedules/channels, real packaged acceptance and full external adapter fixtures remain open. This checkpoint does not close the implementation goal or a release gate.

