import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { NetError } from '../../../shared/net/errors'
import { sshEnvironment } from '../transports/ssh'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** The executable does not exist. */
  missing: boolean
}

export interface RunOptions {
  /** A document or secret for the child's stdin. It is never part of argv. */
  stdin?: string | Buffer | Readable
  timeoutMs: number
  signal?: AbortSignal
  /** Output beyond this many bytes is dropped, never buffered. */
  maxBytes?: number
  env?: NodeJS.ProcessEnv
}

/** Runs one local binary with an argv array (never a shell) and bounded output. */
export function runProcess(
  binary: string,
  args: string[],
  options: RunOptions
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new NetError('cancelled'))
      return
    }
    const limit = options.maxBytes ?? 256 * 1024
    const child = spawn(binary, args, {
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: options.env ?? sshEnvironment()
    })
    let stdout = '',
      stderr = '',
      timedOut = false,
      missing = false,
      settled = false
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill()
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 2000)
      timer.unref()
      child.once('exit', () => clearTimeout(timer))
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)
    function done(error?: NetError): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve({ code: child.exitCode, stdout, stderr, timedOut, missing })
    }
    function abort(): void {
      stop()
      done(new NetError('cancelled'))
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout!.on('data', (chunk: Buffer) => {
      if (stdout.length < limit) stdout += chunk.toString('utf8')
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8 * 1024)
    })
    child.stdout!.on('error', () => {})
    child.stderr!.on('error', () => {})
    child.once('error', (error: NodeJS.ErrnoException) => {
      missing = error.code === 'ENOENT'
      done()
    })
    child.once('close', () => done())
    const { stdin } = options
    if (stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      if (typeof stdin === 'string' || Buffer.isBuffer(stdin)) child.stdin.end(stdin)
      else {
        stdin.on('error', () => stop())
        stdin.pipe(child.stdin)
      }
    }
  })
}
