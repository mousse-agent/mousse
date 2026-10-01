# Sol review: workflow CLI and slash ingress

Reviewed base: `df4f29b88c6991aca1f439c5d17deeb8976c9cb1`

CLI implementation: `f3bd9301fa7b55d0b4716a469361be1a6f99bddd`

Candidate head: `58e3de8694298c8773285927b298a1e975074f14`

Integration merge: `10245293bdebd1406a16f22c78a6873e4463e0ee`

Review fix: `b2f06ed`

## Findings fixed

- A stored slash receipt checked its request digest but did not bind the pinned definition revision, typed input, trusted source, title, or cancellation state. A valid-looking corrupted receipt could redirect a queued command before admission. Version-2 receipts hash the complete authority-bearing body and fail before runtime admission when any field changes.
- Queue recovery trusted the queue item's display content independently from the receipt. Execution now requires recovered content to exactly match the receipt's original command, preventing corrupted queue provenance from being linked to a valid run.

The existing design generates stable caller request IDs before admission, persists pinned revisions and policies before execution, serializes profile admission, rejects changed retries, validates exact approval/input/effect identities, differentiates foreground cancellation from watch interruption, and atomically persists the user command with its run link. GUI/CLI source comes from the admitted protocol connection rather than the request's `source` field.

## Evidence

```text
npm run build:cli
  passed
npx vitest run tests/platformWorkflowCli.test.ts tests/threadMessageQueue.test.ts tests/cliSessionCommands.test.ts tests/cliLaunch.test.ts tests/protocolValidation.test.ts tests/platformWorkflowInvocation.test.ts --maxWorkers=2 --reporter=dot
  6 files, 71 tests passed
npx vitest run tests/platformWorkflowCli.test.ts --maxWorkers=2 --reporter=dot
  1 file, 10 tests passed after the final authority-binding change
npm run typecheck
  passed
npm run build
  passed; Vite reported the pre-existing generated-CSS warning
```

The workflow fixture starts the production-composed owned MMS daemon and launches separate built CLI children. It exercises profile binding, durable retry across publication changes, real approved Node execution, bounded history/trace, stale approval rejection, foreground cancellation, detached watch interruption, queued host reconstruction, admission-before-transcript fault replay, stop-and-clear tombstones, and receipt/content tampering. It uses no provider, live account, channel, or shell command construction.

## Remaining work and qualification limits

- The hidden Electron chat surface was not exercised. Renderer retry/error/profile guards have typecheck and build evidence only and need production-route interaction coverage.
- Windows console Ctrl+C delivery itself is not simulated; exported command logic is driven with a real `AbortSignal` against the framed daemon.
- A busy one-shot CLI slash invocation reports queued acceptance and exits. It cannot follow that receipt through later admission or cancel it by request ID.
- Receipt retention and garbage collection remain undefined. Tombstones must outlive the supported replay window.
- Main-agent execution segments, completion/argument forms, interactive run cards, debugger navigation, schedules/channels, and packaged-install CLI qualification remain open.
- Runtime capabilities depend on production adapter composition. This review does not claim model, MCP, Skill, browser, or external CLI execution from ingress success.
- Host reconstruction is an explicit admission-boundary fault/restart fixture, not an operating-system process-kill test; separately reviewed runtime fixtures carry crash evidence.

No release gate closes from this checkpoint.
