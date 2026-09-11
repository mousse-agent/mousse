# Handoff: bounded process lifecycle for profile isolation/deletion

Package: process-lifecycle prerequisite (not P04)
Branch / worktree: `feat/platform-process-lifecycle` / `C:/Users/bubbl/Documents/Projects/RYSPA/mousse-platform-worktrees/process-lifecycle`
Base SHA: `25b1142f3da3d6c63a176af719ffd91b92a5b2a7` (reviewed combined core)
Implementation SHA: `56cf164c` (`feat(terminals): add bounded process lifecycle drain for profile teardown`)
Sol review: see `docs/implementation/agent-platform/reviews/sol-process-lifecycle.md`.

App/CLI composition, MMS, profile host/services, orchestrator/LLM, protocol, package manifests, and the Liquid Glass Orb were not modified. Root implements profile/service/orchestrator barriers concurrently and must bind these APIs.

## Behavior delivered

`PtyManager` and `HeadlessAgentRunner` keep a second ownership set besides the UI session map. `kill()` / `killAll()` / `killByThreadId()` still remove sessions immediately and return void (legacy thread-switch/UI behavior). Ownership remains until **observed** process exit **and** close. Shutdown never invents successful exit metadata because a kill signal was sent.

Public APIs on **both** runners:

| Method | Sync/async | Meaning |
|---|---|---|
| `beginShutdown(): void` | synchronous | Close admission; signal every still-owned worker (including previously `kill()`ed ones). Idempotent no-op after `stopped`. |
| `getActiveCount(): number` | synchronous | Count of owned workers that have not both exited and closed. |
| `shutdown({ timeoutMs? }?): Promise<void>` | awaited | Calls `beginShutdown` if needed, then waits for every remaining handle. Concurrent callers share the same in-flight promise. Completed shutdown is idempotent. |

Default `timeoutMs` is `DEFAULT_PROCESS_SHUTDOWN_TIMEOUT_MS` (15_000). At the midpoint a force signal is sent (`taskkill /T /F` on Windows, `SIGKILL` on POSIX). Timeout throws `ProcessShutdownError` (`code: 'shutdown_timeout'`) with `remaining[]` and **retains ownership** so root can retry or diagnose. Windows shutdown awaits the owned `taskkill` process itself. Parent exit/close does not settle ownership while that tree operation is pending, and the numeric PID is never targeted again after parent close. Admission stays closed (`shutting-down`); there is no reopen/reconnect on a stopped or shutting-down object (`spawn` / `create` / `write` / `resize` / `loadScrollbacks` / `getOutputSince` throw `ProcessAdmissionError`, `code: 'admission_closed'`).

## Exact APIs root must call

Import the existing runners; optional constructors stay empty in production.

```ts
import { PtyManager } from './terminals/PtyManager'
import { HeadlessAgentRunner } from './terminals/HeadlessAgentRunner'
import {
  DEFAULT_PROCESS_SHUTDOWN_TIMEOUT_MS,
  ProcessAdmissionError,
  ProcessShutdownError
} from './terminals/processLifecycle'
```

Bind **synchronously** before any `await`, then await drain **before** profile archive/removal:

```ts
ptyManager.beginShutdown()
headlessRunner.beginShutdown()
// ...other profile/service/orchestrator barriers...
await Promise.all([
  ptyManager.shutdown({ timeoutMs: DEFAULT_PROCESS_SHUTDOWN_TIMEOUT_MS }),
  headlessRunner.shutdown({ timeoutMs: DEFAULT_PROCESS_SHUTDOWN_TIMEOUT_MS })
])
if (ptyManager.getActiveCount() !== 0 || headlessRunner.getActiveCount() !== 0) {
  throw new Error('terminal workers still owned after shutdown')
}
```

Catch `ProcessShutdownError` and do not move profile files. A later `shutdown()` retries the same owned set. Do not construct a new runner to "clear" a timed-out one.

`getActiveCount()` is the preview count for these two worker classes. It includes handles already removed from `list()` / `has()` / `isAlive()` by `kill()`.

## Process identity and trees

All signals use a recorded integer PID. Windows: `taskkill` argv is exactly `['/PID', String(pid), '/T']` plus `'/F'` when forced — never `/IM`, never a concatenated command string (`windowsTaskkillArgs`). POSIX: signal the recorded PID only; **never** `kill(-pid)`, because these shells are not placed in a new process group and that would hit the daemon/test group. Linux additionally walks `/proc/<pid>/task/*/children` of that exact PID (bounded). macOS and other POSIX without `/proc` signal only the recorded PID.

Headless Windows `ChildProcess.kill()` is skipped when a PID is recorded, because `TerminateProcess` on the PowerShell parent can orphan descendants before `taskkill /T`.

## Exit vs close

- Headless: `ChildProcess` `'exit'`/`'error'` publishes final exit **once** via `WorkerHandle.recordExit`; `'close'` is a distinct `recordClose`. Shutdown waits for both because output/file writers may remain after exit.
- PTY: `node-pty` `onExit` is both exit and close. There is no later stdio/handle event. Descendant writers are addressed by PID-tree kill, not a second PTY event.

`WorkerHandle` now exposes `closed`, `recordClose()`, `waitForExit()`, `waitForClose()`.

## What this does not do

- Does **not** mark P04 or profile isolation/deletion complete.
- Does not stop scheduler, channels, Plus/control, workflow/browser runs, or questions. Root owns those barriers.
- Does not change orchestrator thread-switch, `killByThreadId`, or public `kill`/`killAll` signatures.
- Test-only `adoptTransportForTests` / injected `spawn` / `spawnPty` / `treeSignaler` must not be used in production composition.

## Evidence

Disk before `npm ci`: 4.56 GB free. After: 3.00 GB (~1.56 GB). Independent worktree `node_modules`. Electron postinstall ran; Chrome was not downloaded. `package.json` / lockfile unchanged.

Wrapper `MOUSSE_HOME` was a temp directory under `%TEMP%`. Tests also force a per-test temp home and never read `~/.mousse`.

| Command | Result |
|---|---|
| `npx vitest run tests/platformProcessLifecycle.test.ts --maxWorkers=1 --minWorkers=1 --pool=forks --testTimeout=60000 --hookTimeout=30000` | 13 passed, 1 skipped (POSIX SIGTERM-ignore). Includes real PowerShell/node child+grandchild heartbeats, real `node-pty` PTYs, prior-`kill()` ownership, awaited tree termination, PID-reuse retry fencing, and injected timeout/spawn-error evidence. |
| `npx vitest run tests/ptyLiveness.test.ts tests/headlessCommand.test.ts tests/agentLifecycleStatus.test.ts --maxWorkers=1 --minWorkers=1 --pool=forks` | 3 files, 38 passed. |
| `npm run typecheck` | Passed (`tsc` node + web). |
| `npm run build:cli` | Passed after tests/typecheck; CLI-spawning tests were not run during the build. |

Real-process fixtures live in `tests/fixtures/agent-platform/process-lifecycle/**` (heartbeat Node child, PowerShell owned-temp remover). Cleanup resolves absolute containment under `os.tmpdir()` in TypeScript, then native PowerShell (`-File` + positional argv, reparse refusal). Fixture PIDs are written by the children; the test runner PID is rejected.

## Honest limitations / cross-platform gaps

- This worktree ran on **Windows**. Linux `/proc` descendant walk and the POSIX ignore-`SIGTERM` then `SIGKILL` test are **unexecuted** here (`describe.skipIf(win32)`).
- POSIX group kill is intentionally **not** used. Unrelated groups are not signaled. macOS and other POSIX platforms without Linux `/proc` now fail closed instead of certifying descendant cleanup. Linux rejects an inventory that exceeds the bounded 256-process walk.
- Windows `node-pty` ConPTY `AttachConsole` helper can print `AttachConsole failed` when `IPty.kill()` races a dying console. Shutdown still waits for `onExit` and `taskkill /T` on the recorded PID; tests proved heartbeat descendants gone.
- Force-kill at timeout/2 does not invent exit; a process that never emits exit/close still times out with remaining ownership.
- `getOutputSince` / `loadScrollbacks` refuse after shutdown starts (no reconnect). Scrollback for a live UI `kill()` of a PTY is still cleared immediately (legacy). Headless scrollback is cleared on close only while shutting down.
- Profile archive/remove, MMS `stop`, and orchestrator finalize still use void `kill()` today. Root must switch those paths to `beginShutdown` + `await shutdown`.
