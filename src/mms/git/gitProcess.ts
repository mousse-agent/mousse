import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { mousseGitEnv } from './gitEnv'

/** After a stopped process is asked to end, how long it has before its whole process group is killed. */
const KILL_GRACE_MS = 2_000
/** After a stopped process is asked to end, how long to wait for its output pipes to close. */
const KILL_SETTLE_MS = 5_000
/** Output kept per stream for classifying a failure; the end is kept because Git prints its verdict last. */
const RETAINED_BYTES = 1024 * 1024
/** A physical line longer than this is passed on as its first this-many characters; the rest of it is dropped. */
const MAX_PARTIAL_LINE = 4096

export interface GitRun {
  ok: boolean
  /** Exit status; null when the process was stopped or never reported one. */
  code: number | null
  /** Stopped because it printed nothing for `silenceMs`. */
  stalled: boolean
  /** Stopped because the caller's signal aborted. */
  cancelled: boolean
  /** The process has ended and its pipes are closed; false only when a stopped process outlasted the wait for it. */
  exited: boolean
  stdout: string
  /** stdout then stderr, for messages and classification. */
  output: string
}

export interface GitLine {
  text: string
  /** Ended with a carriage return: a progress line the next one overwrites. */
  transient: boolean
}

export interface GitRunOptions {
  env?: Record<string, string>
  /** Stop the process when it prints nothing for this long. */
  silenceMs?: number
  /** Stop the process, and everything it started, when this aborts. */
  signal?: AbortSignal
  /** Called for every line either stream prints, as it arrives. */
  onLine?: (line: GitLine) => void
}

/**
 * Git's own messages in English, so failures can be classified. Only the message
 * locale is forced: hooks and credential helpers keep the user's locale, except where
 * the user set `LC_ALL`, which would otherwise win over `LC_MESSAGES`.
 */
export function englishMessagesEnv(): Record<string, string> {
  return { LC_MESSAGES: 'C', LANGUAGE: 'C', ...(process.env.LC_ALL ? { LC_ALL: 'C' } : {}) }
}

/** Keeps the last `limit` bytes of a stream. */
class TailBuffer {
  private chunks: Buffer[] = []
  private size = 0
  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.limit && this.chunks.length > 0) {
      const excess = this.size - this.limit
      const first = this.chunks[0]
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.size -= excess
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/** Splits a stream into lines. `\r`, `\n` and `\r\n` all end one; empty lines are dropped. */
class LineSplitter {
  private readonly decoder = new StringDecoder('utf8')
  private partial = ''
  /** The current line was too long and has been passed on; what follows it up to the next line break is dropped. */
  private discarding = false
  constructor(private readonly emit: (line: GitLine) => void) {}

  /**
   * An overlong line is never cut into several lines: a secret that straddles a cut would reach the
   * consumer as two halves that neither look like a credential. Only its head is kept, and the consumer
   * redacts that head as a whole.
   */
  write(chunk: Buffer): void {
    let text = this.partial + this.decoder.write(chunk)
    this.partial = ''
    if (this.discarding) {
      const end = text.search(/[\r\n]/)
      if (end === -1) return
      this.discarding = false
      text = text.slice(end)
    }
    const pattern = /\r\n|\n|\r/g
    let start = 0
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      this.line(text.slice(start, match.index), match[0] === '\r')
      start = match.index + match[0].length
    }
    this.partial = text.slice(start)
    if (this.partial.length > MAX_PARTIAL_LINE) {
      this.line(this.partial.slice(0, MAX_PARTIAL_LINE), false)
      this.partial = ''
      this.discarding = true
    }
  }

  end(): void {
    if (!this.discarding) this.line(this.partial + this.decoder.end(), false)
    this.partial = ''
  }

  private line(text: string, transient: boolean): void {
    if (text.trim() === '') return
    try {
      this.emit({ text, transient })
    } catch {
      /* a consumer's failure must not stop Git's output from being read */
    }
  }
}

/**
 * Runs Git and reports its exit status. Unlike simple-git, a non-zero exit with an empty stderr
 * (a hook that exits 1 quietly, a merge that stops on conflicts) is a failure here, output is
 * streamed line by line instead of buffered whole, and a process that goes silent or whose
 * signal aborts is stopped together with everything it started (hooks, credential helpers, ssh)
 * before the result is returned. The result settles only after the process has closed, so Git
 * no longer holds the repository when the caller restores state and releases its lease.
 *
 * The process tree ends with the process group on POSIX (the child leads its own) and with
 * `taskkill /T` on Windows, where a hook's shell and its children are not in the same group.
 */
export function runGit(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitRun> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      resolvePromise({ ok: false, code: null, stalled: false, cancelled: true, exited: true, stdout: '', output: '' })
      return
    }
    const child = spawn('git', args, {
      cwd,
      env: mousseGitEnv({ ...process.env, ...englishMessagesEnv(), ...options.env }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Leads its own process group on POSIX, so a stop reaches hooks and helpers too.
      detached: process.platform !== 'win32'
    })
    const stdout = new TailBuffer(RETAINED_BYTES)
    const stderr = new TailBuffer(RETAINED_BYTES)
    const onLine = options.onLine
    const splitters = onLine ? [new LineSplitter(onLine), new LineSplitter(onLine)] : []
    let stalled = false
    let cancelled = false
    let stopping = false
    let settled = false
    let silence: NodeJS.Timeout | undefined
    let fallback: NodeJS.Timeout | undefined
    let escalate: NodeJS.Timeout | undefined
    let treeKilled: Promise<void> | undefined

    const killGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        /* the group is already gone */
      }
    }
    const clearTimers = (): void => {
      if (silence) clearTimeout(silence)
      if (fallback) clearTimeout(fallback)
      if (escalate) clearTimeout(escalate)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (code: number | null, exited = true): void => {
      if (settled) return
      settled = true
      clearTimers()
      // A run that finished on its own just as the stop arrived succeeded; a forced stop never exits 0.
      const succeeded = code === 0
      // Nothing a stopped process started may outlive the result.
      if (stopping && process.platform !== 'win32') killGroup('SIGKILL')
      for (const splitter of splitters) splitter.end()
      const out = stdout.text()
      const err = stderr.text()
      resolvePromise({
        ok: succeeded,
        code,
        stalled: stalled && !succeeded,
        cancelled: cancelled && !succeeded,
        exited,
        stdout: out,
        output: [out, err].filter(Boolean).join('\n')
      })
    }
    const stop = (): void => {
      if (stopping) return
      stopping = true
      if (silence) clearTimeout(silence)
      if (process.platform === 'win32') {
        // `/T` walks the process tree, `/F` is the only way to end a console-less process.
        treeKilled = new Promise<void>((done) => {
          if (!child.pid) return done()
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          killer.on('error', () => done())
          killer.on('close', () => done())
        })
      } else {
        // Let Git remove its lock files, then end the whole group.
        killGroup('SIGTERM')
        escalate = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      }
      // A grandchild holding the pipes must not hold the repository lease.
      fallback = setTimeout(() => finish(null, false), KILL_SETTLE_MS)
    }
    function onAbort(): void {
      cancelled = true
      stop()
    }
    const arm = (): void => {
      if (options.silenceMs === undefined || stopping) return
      if (silence) clearTimeout(silence)
      silence = setTimeout(() => {
        stalled = true
        stop()
      }, options.silenceMs)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
      splitters[0]?.write(chunk)
      arm()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
      splitters[1]?.write(chunk)
      arm()
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimers()
      reject(error)
    })
    child.on('close', (code) => {
      // On Windows the tree is gone only once taskkill has finished with it.
      if (treeKilled) void treeKilled.then(() => finish(code))
      else finish(code)
    })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    arm()
  })
}
