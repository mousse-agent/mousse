import { appendFileSync } from 'node:fs'
import { withAsyncFileLock } from '../src/mms/platform/asyncFileLock'

// Holds the lock for `holdMs` and records when it entered and left, so the parent can check that
// two processes never held it at once.
const [lockPath, logPath, holdMs] = process.argv.slice(2)

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
