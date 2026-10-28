/** What the terminal tests share: a shell that is not one, and the output a shell makes. */

/** A shell that is not one: what the owner would start is recorded, and its output and end are the test's. */
export class FakePty {
  readonly written: string[] = []
  readonly resizes: Array<[number, number]> = []
  killed = false
  pid = undefined
  private readonly onDataCallbacks: Array<(data: string) => void> = []
  private readonly onExitCallbacks: Array<(event: { exitCode: number; signal?: number }) => void> =
    []
  onData(callback: (data: string) => void) {
    this.onDataCallbacks.push(callback)
    return { dispose: () => undefined }
  }
  onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
    this.onExitCallbacks.push(callback)
    return { dispose: () => undefined }
  }
  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }
  kill(): void {
    this.killed = true
    this.exit(137)
  }
  say(data: string): void {
    for (const callback of this.onDataCallbacks) callback(data)
  }
  exit(exitCode = 0): void {
    for (const callback of this.onExitCallbacks.splice(0)) callback({ exitCode })
  }
}

export interface Spawned {
  shell: string
  args: string[]
  options: { cwd: string; env: Record<string, string | undefined> }
  pty: FakePty
}

/** Makes a computer's terminals fake ones. Nothing here reads or prints the process environment. */
export function fakeShells(
  manager: unknown,
  cleanups: Array<() => void | Promise<void>>
): Spawned[] {
  const spawned: Spawned[] = []
  ;(manager as { spawnPty: unknown }).spawnPty = (
    shell: string,
    args: string[],
    options: Spawned['options']
  ) => {
    const pty = new FakePty()
    spawned.push({ shell, args, options, pty })
    return pty
  }
  // A shell that is still running would hold the owner's shutdown.
  cleanups.push(() => {
    for (const shell of spawned) shell.pty.exit(0)
  })
  return spawned
}

/** A burst of output the way a shell makes it: chunks of every size from a few bytes to tens of KiB. */
export function burst(total: number): string[] {
  const chunks: string[] = []
  let sent = 0
  let seed = 7
  while (sent < total) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const size = Math.min(total - sent, 1 + (seed % 40_000))
    chunks.push(`${sent}:`.padEnd(size, 'y'))
    sent += size
  }
  return chunks
}

