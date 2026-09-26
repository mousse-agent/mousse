import type { ChildProcess } from 'node:child_process'

/** Wait for the fixture process to release its resources before removing its root. */
export async function terminateChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const finish = (error?: Error) => {
      clearTimeout(timer)
      child.off('close', closed)
      child.off('error', failed)
      if (error) reject(error)
      else resolve()
    }
    const closed = () => finish()
    const failed = (error: Error) => finish(error)
    child.once('close', closed)
    child.once('error', failed)
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      timer = setTimeout(() => finish(new Error(`Fixture child ${child.pid} did not exit after termination`)), 3_000)
    }, 3_000)
    child.kill()
  })
}
