import { spawn } from 'node:child_process'

/** What a Git process left: as `spawnSync` reports it. */
export interface GitProcess {
  status: number | null
  stdout: string
  stderr: string
  error?: NodeJS.ErrnoException
  /** `stdout` as the bytes Git wrote, for output that is not text (`cat-file --batch`). */
  stdoutBytes: Buffer
}

/** The output limit `spawnSync` and `execFileSync` use when none is given. */
const DEFAULT_MAX_BUFFER = 1024 * 1024

/**
 * Runs `git argv` without blocking and reports it as `spawnSync` would: output past `maxBuffer` (on either stream)
 * or a run past `timeout` stops Git and is an `ENOBUFS` or `ETIMEDOUT` error, with the output read so far.
 */
export function runGitProcess(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; maxBuffer?: number; timeout?: number }): Promise<GitProcess> {
  const limit = options.maxBuffer ?? DEFAULT_MAX_BUFFER
  return new Promise((settle) => {
    const child = spawn('git', argv, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outSize = 0
    let errSize = 0
    let error: NodeJS.ErrnoException | undefined
    const stop = (code: 'ENOBUFS' | 'ETIMEDOUT'): void => {
      if (error) return
      error = Object.assign(new Error(`spawnSync git ${code}`), { code, syscall: 'spawnSync git' })
      child.kill()
    }
    const timer = options.timeout ? setTimeout(() => stop('ETIMEDOUT'), options.timeout) : undefined
    child.stdout!.on('data', (chunk: Buffer) => { outSize += chunk.length; if (outSize > limit) stop('ENOBUFS'); else out.push(chunk) })
    child.stderr!.on('data', (chunk: Buffer) => { errSize += chunk.length; if (errSize > limit) stop('ENOBUFS'); else err.push(chunk) })
    child.on('error', (spawnError) => { error ??= spawnError })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      // As `spawnSync`: the exit code even when the output was cut off; none for a process that was killed or never started.
      const started = !error || error.code === 'ENOBUFS' || error.code === 'ETIMEDOUT'
      const bytes = Buffer.concat(out)
      settle({ status: started ? code : null, stdout: bytes.toString('utf8'), stdoutBytes: bytes, stderr: Buffer.concat(err).toString('utf8'), ...(error ? { error } : {}) })
    })
    if (options.input !== undefined) {
      // Git may stop reading early (a refusal); what it did not read is dropped, as with `spawnSync`.
      child.stdin!.on('error', () => undefined)
      child.stdin!.end(options.input)
    }
  })
}

/**
 * The error `execFileSync` throws for a Git run that failed: the message names the command and Git's own output, and it
 * carries `status`, `stdout` and `stderr` (and the cause when Git was stopped or never started).
 */
export function gitRunError(argv: readonly string[], ran: GitProcess): Error & { status: number | null; stdout: string; stderr: string } {
  return Object.assign(new Error(`Command failed: git ${argv.join(' ')}${ran.stderr ? `\n${ran.stderr}` : ''}`, ran.error ? { cause: ran.error } : undefined), { status: ran.status, stdout: ran.stdout, stderr: ran.stderr, ...(ran.error?.code ? { code: ran.error.code } : {}) })
}
