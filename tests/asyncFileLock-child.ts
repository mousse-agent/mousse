import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setReclaimHookForTests, withAsyncFileLock } from '../src/mms/platform/asyncFileLock'

// Holds the lock for `holdMs` and records when it entered and left, so the parent can check that
// two processes never held it at once. With a barrier directory, the child stops right after it
// judged the existing lock stale, says so, and continues only when the parent opens the barrier:
// two children then reclaim the same stale lock at the same moment.
const [lockPath, logPath, holdMs, barrier] = process.argv.slice(2)

if (barrier) {
  let waited = false
  setReclaimHookForTests((step, path) => {
    if (waited || step !== 'checked' || path !== lockPath) return
    waited = true
    writeFileSync(join(barrier, `ready-${process.pid}`), '')
    const pause = new Int32Array(new SharedArrayBuffer(4))
    while (!existsSync(join(barrier, 'go'))) Atomics.wait(pause, 0, 0, 5)
  })
}

void withAsyncFileLock(
  lockPath,
  async () => {
    appendFileSync(logPath, `start ${process.pid}\n`)
    await new Promise((resolve) => setTimeout(resolve, Number(holdMs)))
    appendFileSync(logPath, `end ${process.pid}\n`)
  },
  { waitMs: 20_000 }
).then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
)
