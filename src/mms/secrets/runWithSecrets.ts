import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensurePrivateDirectory } from '../data/privateAcl'
import { killProcessTree } from '../execution/processTree'
import { maskCommandOutput, type SecretMasker } from './secretMasking'
import { botSecretContainment, botSecretEnv, type BotSecretContainment } from './botSecretCommand'

/** The most output a command keeps before masking; past it the end is cut. */
export const SECRET_RUN_MAX_OUTPUT = 256 * 1024
export const SECRET_RUN_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000
export const SECRET_RUN_MAX_TIMEOUT_MS = 10 * 60 * 1000

export interface SecretForCommand {
  name: string
  value: string
  /** `env`: the variable NAME holds the value. `file`: a private file holds it and NAME_FILE holds the file's path. */
  as: 'env' | 'file'
}

export interface SecretRunResult {
  exitCode: number | null
  /** Already masked: no form of a given secret is in it. */
  output: string
  timedOut: boolean
  stopped: boolean
  truncated: boolean
}

/**
 * Runs one shell command with secrets in its environment or in private files, and returns its output masked. The
 * files live in a folder only this account can open, under the profile's secret folder, and are deleted when the
 * command ends whatever the outcome. The value never reaches the command line, so other processes cannot read it there.
 *
 * `contain`: a personal bot's command (`botSecretCommand.ts`). It never gets the service's environment: only the bot's
 * locked command environment plus the named secrets. Where Mousse has a sandbox for it (Linux with bubblewrap) it runs
 * there, with only the bot's folders (`folders`, writable) besides the system's, and no network; elsewhere it runs as
 * the bot's other commands do there, from its files folder in a process group of its own. Without it (a thread's
 * agent), the command runs as before.
 */
export async function runWithSecrets(input: {
  command: string
  cwd: string
  secrets: SecretForCommand[]
  mask: SecretMasker
  /** Where private files go: a folder under the profile's secret folder. */
  scratchRoot: string
  timeoutMs?: number
  signal?: AbortSignal
  baseEnv?: NodeJS.ProcessEnv
  contain?: { scratch: string; folders: readonly string[]; containment?: BotSecretContainment }
}): Promise<SecretRunResult> {
  const containment = input.contain ? input.contain.containment ?? botSecretContainment() : undefined
  const env: NodeJS.ProcessEnv = input.contain ? botSecretEnv(input.baseEnv ?? process.env, input.contain.scratch) : { ...(input.baseEnv ?? process.env) }
  let folder: string | undefined
  if (input.secrets.some((secret) => secret.as === 'file')) {
    ensurePrivateDirectory(input.scratchRoot)
    folder = mkdtempSync(join(input.scratchRoot, 'run-'))
  }
  try {
    for (const secret of input.secrets) {
      if (secret.as === 'env') {
        env[secret.name] = secret.value
      } else {
        const path = join(folder!, secret.name)
        writeFileSync(path, secret.value, { mode: 0o600, flag: 'wx' })
        env[`${secret.name}_FILE`] = path
      }
    }
    const longestForm = Math.max(0, ...input.secrets.map((secret) => secret.value.length * 3))
    return await new Promise<SecretRunResult>((resolve) => {
      const windows = process.platform === 'win32'
      let child: ReturnType<typeof spawn>
      try {
        // A bot's where Mousse has a sandbox: in it, with its folders and the private folder of its secret files only.
        // Otherwise (a thread's agent, or a bot's elsewhere) a shell: on POSIX in a process group of its own.
        child = containment?.sandbox === 'bubblewrap'
          // eslint-disable-next-line mousse/no-console-window -- bubblewrap is Linux only.
          ? spawn(containment.program, containment.args(input.command, { cwd: input.cwd, writable: input.contain!.folders, readOnly: folder ? [folder] : [] }), { cwd: input.cwd, env, detached: true })
          : windows
            ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${input.command}"`], { cwd: input.cwd, env, windowsVerbatimArguments: true, windowsHide: true })
            // eslint-disable-next-line mousse/no-console-window -- POSIX only: Windows takes the branch above.
            : spawn('/bin/sh', ['-c', input.command], { cwd: input.cwd, env, detached: true })
      } catch (error) {
        // Node's refusal quotes the environment it was given: only its code is kept.
        const code = (error as NodeJS.ErrnoException)?.code
        resolve({ exitCode: null, output: `The command could not start${code ? ` (${code})` : ''}.`, timedOut: false, stopped: false, truncated: false })
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      let truncated = false
      let timedOut = false
      let stopped = false
      let settled = false
      const keep = (chunk: Buffer): void => {
        if (size >= SECRET_RUN_MAX_OUTPUT) {
          truncated = true
          return
        }
        const room = SECRET_RUN_MAX_OUTPUT - size
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk
        if (part.length < chunk.length) truncated = true
        chunks.push(part)
        size += part.length
      }
      child.stdout?.on('data', keep)
      child.stderr?.on('data', keep)
      const kill = (): void => {
        if (child.pid) killProcessTree(child.pid)
        else child.kill('SIGKILL')
      }
      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, Math.min(Math.max(input.timeoutMs ?? SECRET_RUN_DEFAULT_TIMEOUT_MS, 1_000), SECRET_RUN_MAX_TIMEOUT_MS))
      const onAbort = (): void => {
        stopped = true
        kill()
      }
      if (input.signal?.aborted) onAbort()
      else input.signal?.addEventListener('abort', onAbort, { once: true })
      const finish = (exitCode: number | null, extra?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onAbort)
        let output = maskCommandOutput(Buffer.concat(chunks).toString('utf8'), input.mask)
        // A cut can leave the start of a secret at the very end, too short to match: drop as much as the longest form.
        if (truncated) output = `${output.slice(0, Math.max(0, output.length - longestForm))}\n...[output cut]`
        if (extra) output = `${output}${output ? '\n' : ''}${extra}`
        resolve({ exitCode, output, timedOut, stopped, truncated })
      }
      // Only the error's code: its message can quote what the command was started with.
      child.on('error', (error) => finish(null, `The command could not run${(error as NodeJS.ErrnoException).code ? ` (${(error as NodeJS.ErrnoException).code})` : ''}.`))
      child.on('close', (code) => finish(code))
    })
  } finally {
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
}
