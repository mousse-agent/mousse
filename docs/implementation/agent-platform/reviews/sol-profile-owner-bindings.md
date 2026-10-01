# Sol review: profile process and native-agent owner bindings

Reviewed core: `56a53e2497fc4444a42a60e2f2f4bb0edc204509`

Qualified implementation freeze: `34d8a7a05a024cbe3833b687674208d03a41215f`

Disposition: accepted after binding the already-reviewed terminal/headless process owners and the native Agent Editor run owner into profile and installation drain. This remains a profile-lifecycle checkpoint; the separately owned MCP, channel/control, and browser bindings are still required before P04 can be closed.

## Findings fixed

1. `MmsProfileServices.beginShutdown()` closed RPC, orchestrator, and scheduler admission but left PTY, headless runner, and native-agent admission open until later disposal. A request already inside another profile-owned component could therefore create one of those owners after teardown had begun. The service now closes all three admissions synchronously before its first await.
2. `finishStop()` did not await `PtyManager.shutdown()` or `HeadlessAgentRunner.shutdown()`. Profile removal or installation shutdown could release the runtime/root while a real owned child or grandchild was alive. Both shutdowns now participate in the retained, retryable stop operation.
3. The host activity snapshot omitted PTYs, headless processes, and native agent runs. It now reports exact live owner counts from the three production lifecycle barriers, including owners retained after a deadline or failed signal.
4. Process lifecycle reports `shutdown_timeout` when it cannot observe process exit/transport close. The profile boundary now maps that nested failure to the structured `profile_busy` wire contract while retaining the runtime and original stop operation for retry.
5. `MmsProfilePlatform` had no synchronous admission hook or inventory for its new `MmsAgentExecutionService`. It now closes native-agent admission in `beginShutdown()`, reports its active count, and reuses that hook in disposal. The existing disposer continues to await native-agent cancellation and final durable writes.

## Lifecycle assessment

The installation and profile host invoke `MmsProfileServices.beginShutdown()` before yielding. That single fence now reaches personal RPCs, native agent runs, workflow/orchestrator work, scheduler ticks, PTYs, and headless agents. `finishStop()` starts their awaited shutdowns together, so cancellation is delivered promptly while the profile runtime, profile root, installation lease, and composing-cache entry remain owned until every bound subsystem settles.

A caller deadline limits only that caller's wait. The underlying stop promise and subsystem owners remain live and fenced. A later stop retries a subsystem whose shutdown operation rejected; successful platform disposers are removed individually, and the service is marked stopped only after all bound owners and MCP teardown succeed. The native agent fixture exercises this through the same owned-work barrier used by `tryRun`, without invoking a model or transport.

The real Windows process fixture launches a headless PowerShell/node child and grandchild in a nondefault profile, removes that profile, and observes both PIDs gone. It repeats the tree under the default profile and verifies installation shutdown also waits for both descendants. A separate retained-owner fixture combines a native-agent run and PTY handle, proves a short deadline returns `profile_busy` without evicting the nondefault runtime, proves new native admission is closed, then completes both owners and successfully retries shutdown.

## Evidence

- `npx vitest run tests/platformProfileDrain.test.ts --maxWorkers=1 --testTimeout=60000 --hookTimeout=30000` — 12 tests passed.
- `npx vitest run tests/platformProcessLifecycle.test.ts tests/platformOwnedWorkLifecycle.test.ts tests/platformProfileRuntime.test.ts --maxWorkers=1 --minWorkers=1 --pool=forks --testTimeout=60000 --hookTimeout=30000` — 27 tests passed, 1 platform-specific test skipped.
- `npm run typecheck` — node and web TypeScript projects passed.
- `npm run build:cli` — CLI bundle passed.
- `git diff --check` — passed; Git emitted only the repository's Windows line-ending notices.

All fixtures use temporary local roots, local processes, deferred promises, injected transports, and mocked provider initialization. They make no live account, credential, model, channel, browser, or external-server call.

## Remaining guarantees

MCP connection/discovery/OAuth/request ownership and stdio process-tree shutdown are still pending their separate reviewed binding. Channel and control ingress still need their reviewed lifecycle APIs bound. Browser ownership remains with root composition. None is claimed by this freeze.

`previewRemove()` remains a summary of ordinary turns plus configured schedules/channels rather than the complete composed owner inventory; extending its shared DTO is outside this bounded lifecycle binding. The internal activity snapshot and structured timeout details do include the three newly bound owners.

On Windows, a hostile detached descendant that survives after its recorded parent exits naturally cannot be rediscovered by the reviewed process implementation without a Job Object or equivalent durable process-group owner. On POSIX, descendant identity and group ownership retain the limitations recorded in the process-lifecycle review. This freeze does not strengthen those guarantees.

The current native execution service supports the Mousse runtime path. Additional CLI/browser/delegation execution bindings and packaged acceptance remain separate production work.
