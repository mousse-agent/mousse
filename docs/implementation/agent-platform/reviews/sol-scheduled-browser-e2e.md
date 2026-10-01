# Sol verification: scheduled Browser workflow after GUI close

Reviewed 2026-09-11 from core `4bedbf507bfbc2e1421a2b99eabbcfaa00347db8` in the isolated process-lifecycle worktree.

## Finding fixed

`WorkflowRunService.executeInstance` created a durable approval record for an external scheduled/channel effect and then immediately failed because the source was unattended. That made every scheduled Browser session fail before browser dispatch, so it could neither wait for a later authenticated operator nor satisfy E2E-12. The special immediate-failure branch was removed. The existing approval record, request digest, expiry, consume-once checks, and `unattended` notification marker remain unchanged; no tool, capability, or effect grant was widened.

The existing background-ingress regression now expects the scheduled/channel script to wait durably and explicitly denies the exact pending approval. The run then fails through the ordinary denied-approval path.

## E2E-12 evidence

`tests/platformScheduledBrowserE2E.test.ts` and its Electron fixture exercise production services:

1. Start `MousseMainService`, framed MMS, the real scheduler, and an actual hidden Electron GUI bound to the profile.
2. Publish and trigger a scheduled `browser-session` to `browser-action` workflow.
3. Verify the first external node is durably `waiting-approval` and managed Chromium has not dispatched.
4. Close the owning Electron GUI and verify the run remains waiting.
5. Attempt an explicitly GUI-attached `browser_open` with no selected guest. It returns `setup_required`, and managed dispatch remains untouched.
6. Start a replacement authenticated Electron GUI, approve both pending records by their exact run/node/instance/attempt identities, and observe terminal success.
7. Verify the authoritative runtime output reports a dispatched, verified navigation in a `managed-chromium` session.

The fixture reuses the reviewed certified Chrome installation at the core worktree read-only. Profile state, browser user data, journals, artifacts, Electron user data, and the local HTTP site are isolated beneath one guarded temporary root. It performs no download and uses no live provider or account.

## Commands

```text
npx vitest run tests/platformScheduledBrowserE2E.test.ts
1 file, 1 test passed

npx vitest run tests/platformWorkflowBackgroundIngress.test.ts
1 file, 4 tests passed

npx tsc --noEmit -p tsconfig.node.json --pretty false
passed
```

## Limits

- Scheduled/headless Browser execution uses managed Chromium. An attached Electron guest is available only to an owning live GUI selection; loss of that selection fails `setup_required` and is never substituted with managed Chromium.
- This is hidden Electron and local HTTP qualification. It does not claim visible packaged input behavior or live provider/channel interoperability.
