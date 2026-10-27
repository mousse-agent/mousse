import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const POLL_MS = 200
/** Most bytes read from the trace file in one pass; a hook that runs Git in a loop writes a lot. */
const READ_BYTES = 1024 * 1024
/** A line longer than this is not a trace event worth keeping. */
const MAX_PENDING_BYTES = 1024 * 1024

export interface HookTraceEvent {
  name: string
  /** Set when the hook has ended. */
  exitCode?: number
}

/**
 * Follows Git's own trace of the programs it starts (`GIT_TRACE2_EVENT`) while a command
 * runs, to tell the user which hook is running and how it ended. Only the top-level
 * process's hooks count: a Git command a hook runs itself writes to the same file under a
 * session id nested below it (`parent/child`). Best effort throughout: when the file cannot
 * be read, output still streams and errors still show.
 */
export class HookTrace {
  private cursor = 0
  private remainder: Buffer = Buffer.alloc(0)
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private reading: Promise<void> = Promise.resolve()
  private readonly running = new Map<string, string>()
  private failed: Required<HookTraceEvent> | null = null

  private constructor(
    private readonly dir: string,
    readonly file: string,
    private readonly onEvent: (event: HookTraceEvent) => void
  ) {}

  /** Environment that makes Git write the trace. */
  get env(): Record<string, string> {
    return { GIT_TRACE2_EVENT: this.file }
  }

  /** The first hook that exited non-zero, once the run has ended. */
  get failedHook(): Required<HookTraceEvent> | null {
    return this.failed
  }

  static async start(onEvent: (event: HookTraceEvent) => void): Promise<HookTrace | null> {
    let dir: string | undefined
    try {
      dir = await mkdtemp(join(tmpdir(), 'mousse-trace-'))
      const file = join(dir, 'trace2.json')
      await writeFile(file, '')
      const trace = new HookTrace(dir, file, onEvent)
      trace.timer = setInterval(() => void trace.poll(), POLL_MS)
      trace.timer.unref?.()
      return trace
    } catch {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      return null
    }
  }

  private poll(): Promise<void> {
    this.reading = this.reading.then(() => this.readNew()).catch(() => undefined)
    return this.reading
  }

  private async readNew(): Promise<void> {
    const handle = await open(this.file, 'r').catch(() => null)
    if (!handle) return
    try {
      for (;;) {
        const buffer = Buffer.alloc(READ_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, READ_BYTES, this.cursor)
        if (bytesRead === 0) return
        this.cursor += bytesRead
        this.consume(buffer.subarray(0, bytesRead))
        if (bytesRead < READ_BYTES) return
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  private consume(bytes: Buffer): void {
    let data = Buffer.concat([this.remainder, bytes])
    for (let end = data.indexOf(0x0a); end !== -1; end = data.indexOf(0x0a)) {
      this.line(data.subarray(0, end).toString('utf8'))
      data = data.subarray(end + 1)
    }
    this.remainder = data.length > MAX_PENDING_BYTES ? Buffer.alloc(0) : data
  }

  private line(text: string): void {
    if (!text.startsWith('{')) return
    let record: Record<string, unknown>
    try {
      record = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    const sid = typeof record.sid === 'string' ? record.sid : ''
    if (sid === '' || sid.includes('/') || typeof record.child_id !== 'number') return
    const key = `${sid}#${record.child_id}`
    if (record.event === 'child_start' && record.child_class === 'hook' && typeof record.hook_name === 'string') {
      this.running.set(key, record.hook_name)
      this.emit({ name: record.hook_name })
    } else if (record.event === 'child_exit') {
      const name = this.running.get(key)
      if (name === undefined) return
      this.running.delete(key)
      const exitCode = typeof record.code === 'number' ? record.code : -1
      if (exitCode !== 0 && !this.failed) this.failed = { name, exitCode }
      this.emit({ name, exitCode })
    }
  }

  private emit(event: HookTraceEvent): void {
    try {
      this.onEvent(event)
    } catch {
      /* a consumer's failure must not stop the trace */
    }
  }

  /** Reads what the process wrote last, stops following and deletes the file. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.poll()
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The error text for a failed hook: its name and exit status, then everything Git printed. */
export function withHookFailure(output: string, hook: Required<HookTraceEvent> | null): string {
  if (!hook) return output
  return `${hook.name} hook failed (exit ${hook.exitCode}):\n${output}`
}
