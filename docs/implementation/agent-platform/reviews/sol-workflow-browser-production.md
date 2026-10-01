# Sol review: production workflow browser binding

Reviewed 2026-09-11 on `feat/platform-profiles` from child-composition review `017c4133bda9fa182a49533d943bd06a14f1ccfd`, after merging root production baseline `50de6e1` as `5159e2d`. The reviewed implementation is `4866946`.

## Findings fixed

- Added `MmsWorkflowBrowser`, a profile-owned workflow adapter that uses the existing `MmsBrowserService.workflow` dispatcher. This preserves the service's source-aware target resolution: GUI runs require the selected Electron-attached tab for the same thread and never fall back to managed Chromium; non-GUI runs retain the explicitly managed target path.
- Admission now walks the pinned current graph, inline subgraphs, and pinned transitive child workflow revisions. It grants only the exact enabled browser tool names and corresponding browser capabilities. Disabled or missing Settings entries fail before durable admission.
- Invocation validates the full immutable running manifest binding (profile, project, thread, run, actor, source, cancellation, and policy), the engine's `workflow.browser` authorization, and the exact durable attempt/idempotency key against the stored compiled run snapshot. Ambiguous duplicate node IDs fail closed.
- The downstream browser policy contains only the resolved browser tool, capability, and actual browser effect. It removes the already-consumed engine approval for this one dispatch, avoiding the former second `external` approval rejection while retaining the engine's external-effect authorization boundary.
- Current Settings are checked immediately before and after dispatch. Cancellation and profile disposal also fail closed. A browser action is successful only with `outcome: verified`; failed, blocked, unverified, or unknown dispatched outcomes cannot become successful workflow node output.

## Production composition

`MmsProfilePlatform` now constructs one helper per profile using the lazy browser service and authoritative runtime snapshot:

```ts
const workflowBrowser = new MmsWorkflowBrowser(
  services,
  () => this.browser,
  (context) => this.workflowRuns.runtime.get(context.runId!, { profileId })
)
```

`prepareExecution` passes the integration/tool policy through browser preparation before the Agent preparation merge. The coordinator receives `workflowBrowser.adapter`, profile disposal owns the helper, and the older `MousseMainService` adapter overwrite was removed. No child hook is required because top-level preparation includes pinned transitive child graphs and the reviewed child admission path narrows the inherited parent policy.

## Qualification

```text
npx vitest run tests/platformWorkflowBrowser.test.ts tests/platformBrowserDaemonComposition.test.ts --maxWorkers=2 --minWorkers=1
2 files, 5 tests passed

npx tsc --noEmit -p tsconfig.node.json --pretty false
passed

npx tsc --noEmit -p tsconfig.web.json --pretty false
passed

npx vitest run tests/platformMainBrowserE2E.test.ts --maxWorkers=1 --minWorkers=1
1 file, 1 test passed

npx vitest run tests/platformWorkflowBrowser.test.ts --maxWorkers=2 --minWorkers=1
1 file, 3 tests passed
```

The focused helper fixture uses real profile services, settings, workflow registry compilation/revisions, and runtime-shaped manifest/attempt bindings with a local fake browser workflow port. The production Electron fixture additionally releases and re-registers the same real webview guest, starts a published browser-session to browser-action graph through the authenticated GUI MMS connection, approves both durable engine waits, and verifies the navigation outcome in the authoritative runtime trace. The guest identity and same-origin cookie survive, and the managed backend is never attempted. The provider used by the earlier native half remains a deterministic local fixture; no live account or network provider is used.

The final policy correction also proves that a read-only `browser_observe` attempt is accepted under a read-only run ceiling while `browser_act` is rejected under that same ceiling.

## Remaining scope

- This slice deliberately does not change browser backend/session lifecycle, workflow engine recovery, Agent bindings, native browser tools, renderer behavior, or the Orb.
