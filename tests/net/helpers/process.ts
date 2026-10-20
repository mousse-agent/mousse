import type { ChildProcess } from 'node:child_process'

export async function until<T>(
  probe: () => Promise<T> | T,
  ready: (value: T) => boolean,
  timeout = 20000
): Promise<T> {
  const deadline = Date.now() + timeout
  do {
    const value = await probe()
    if (ready(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 40))
  } while (Date.now() < deadline)
  throw new Error('Network daemon fixture timed out')
}
export async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await done
}
