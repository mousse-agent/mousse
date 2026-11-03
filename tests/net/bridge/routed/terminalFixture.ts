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

/** Waits until every terminal that has ended has recorded its thread's turn, which it does in the thread's folder. */
export async function terminalTurnsRecorded(manager: unknown): Promise<void> {
  const owned = (manager as { ownedTaskTerminals: Map<string, { drain: Promise<void> }> })
    .ownedTaskTerminals
  await Promise.all([...owned.values()].map((owner) => owner.drain))
}

/** Makes a computer's terminals fake ones. Nothing here reads or prints the process environment. */
export function fakeShells(
  manager: unknown,
  cleanups: Array<() => void | Promise<void>>,
  /** Runs as each shell starts, before the owner has been told it exists. */
  onSpawn?: (shell: Spawned) => void
): Spawned[] {
  const spawned: Spawned[] = []
  // A shell that is still running would hold the owner's shutdown. Its end records the thread's turn
  // in the thread's folder, so every shell ends, and that record is written, before any folder made
  // ahead of a shell is removed: cleanups run newest first, and this one is added as each shell starts.
  const endAll = async () => {
    for (const shell of spawned) shell.pty.exit(0)
    await terminalTurnsRecorded(manager)
  }
  ;(manager as { spawnPty: unknown }).spawnPty = (
    shell: string,
    args: string[],
    options: Spawned['options']
  ) => {
    const pty = new FakePty()
    const entry = { shell, args, options, pty }
    spawned.push(entry)
    cleanups.push(endAll)
    onSpawn?.(entry)
    return pty
  }
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

