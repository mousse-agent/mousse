# Sol review: process lifecycle prerequisite

Reviewed base: `25b1142f3da3d6c63a176af719ffd91b92a5b2a7`

Reviewed candidate: `e7074bddf91e494bb317b5ad5481d335debd0d96`

## Findings fixed

- Windows tree termination was fire-and-forget. `taskkill` was unreferenced and the lifecycle settled solely from the parent transport's exit/close. Shutdown now observes the tree operation, and it remains in `getActiveCount()` and timeout diagnostics.
- ConPTY local kill could terminate the console parent before `taskkill /T` captured descendants. Windows PTYs with a recorded PID now use the awaited tree operation as their authoritative signal.
- A force or retry pass could target a reused numeric PID after parent close. Once the exact transport has exited and closed, the controller never issues another PID signal. Repeated `beginShutdown()` and concurrent `shutdown()` calls do not duplicate signals.
- Signal failures were swallowed. A failed tree signal is retained in the ownership snapshot, times out, and can be retried while the exact transport remains alive.
- Unsupported POSIX cleanup could report success. Platforms without Linux `/proc` reject tree cleanup. Linux rejects a descendant inventory beyond the 256-process bound.

## Evidence

- `npx vitest run tests/platformProcessLifecycle.test.ts --maxWorkers=1 --minWorkers=1 --pool=forks --testTimeout=60000 --hookTimeout=30000`: 13 passed, 1 skipped on Windows. Real PowerShell/Node and ConPTY fixtures verify child and grandchild heartbeat cessation. A deterministic race closes the parent before its delayed tree signal completes; active count stays nonzero and no later signal targets the reusable PID.
- `npx vitest run tests/ptyLiveness.test.ts tests/headlessCommand.test.ts tests/agentLifecycleStatus.test.ts --maxWorkers=1 --minWorkers=1 --pool=forks`: 3 files, 38 passed.
- `npm run typecheck`: passed.

## Remaining limits

- macOS and non-Linux POSIX descendant termination is unavailable and fails closed; production support needs an owned process group or equivalent platform primitive.
- Linux `/proc` behavior was not run on this Windows host. The walk is bounded and fails closed when over bound, but `/proc` disappearance and permission races are not independently fixture-qualified here.
- Windows uses an exact recorded PID with `taskkill /T`; it does not retain a native process handle or creation-time token. The controller closes the retry/force PID-reuse path by never targeting after observed parent close. A process that deliberately detaches and lets its parent exit naturally before shutdown cannot be rediscovered by parent PID; hostile-detach containment requires a Windows Job Object at spawn time.
- These runners cover terminal/headless ownership only. Root composition must call `beginShutdown()` synchronously and await `shutdown()` before profile deletion, alongside all other profile-owned service barriers.
