import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'

/**
 * How Mousse's extension runs Pi's `bash` tool on Linux and macOS, so that a Pi that dies leaves
 * nothing it started running.
 *
 * Pi's own shell runs detached, in a process group (and session) of its own, so that Pi can kill a
 * command's whole tree on abort or timeout. When Pi dies, those groups are reparented and nothing
 * links them to Pi. Here each command still gets its own group, but it starts as a small gate
 * (`/bin/sh -c`, with `BASH_ENV` and `ENV` removed, so no startup file runs) that waits for one line
 * on its stdin. The engine records the group first (`/pi/group`); only then is the go line written,
 * and the gate `exec`s Pi's shell exactly as Pi runs it (`bash -c <command>`, the startup
 * variables restored, stdin at end of file). If Pi dies first, the gate's stdin closes and it exits
 * without starting the shell. So every group that runs anything is one the engine knows and kills
 * when Pi dies.
 *
 * What it cannot contain: a command that itself starts a new session or group (`setsid`, a
 * daemon that double-forks). Only an OS-level container (a cgroup) would.
 *
 * Windows keeps Pi's own shell: `taskkill /T` follows the tree, and the engine finds a dead Pi's
 * children by their parent id.
 */

export interface ShellExecOptions {
  onData: (data: Buffer) => void
  signal?: AbortSignal
  /** Seconds. */
  timeout?: number
  env?: NodeJS.ProcessEnv
}

export interface ContainedShellOptions {
  /** Records a group with the engine; resolves once recorded. A rejection runs nothing; `signal` aborts the request. */
  report(pgid: number, signal?: AbortSignal): Promise<void>
  /** The group's command ended (best effort; it lets the engine retire an emptied group). */
  ended?(pgid: number): Promise<void>
  /** The shell the command runs in (default `/bin/bash`, else `bash` on PATH). */
  shell?: string
  /** The gate's shell (default `/bin/sh`). */
  gate?: string
  /** `env`, which hands the command the exported functions the gate ran without (default `/usr/bin/env`). */
  envPath?: string
  /** Test seams. */
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  killGroup?: (pgid: number) => void
  detached?: boolean
}

/** Pi's grace for output still arriving after the shell exited, reset by each chunk (`child-process.js`). */
const EXIT_STDIO_GRACE_MS = 100

/** Pi's timeout limit (`bash.js`): the largest delay `setTimeout` accepts. */
const MAX_TIMEOUT_MS = 2_147_483_647
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000

/** Pi's timeout check: none, or a finite positive number of seconds up to the limit. */
export function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid timeout: must be a finite number of seconds')
  const ms = timeout * 1000
  if (ms > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`)
  return ms
}

/** Startup variables the gate must not see; restored for the shell. */
const STARTUP_VARIABLES = ['BASH_ENV', 'ENV']

/**
 * The gate: one line on stdin, then Pi's shell with the startup variables back and stdin at end of
 * file. `$0` is the shell, `$1` the command; nothing is interpolated into the script.
 */
const GATE_SCRIPT = [
  // The gate's environment holds no exported function (they are moved to the arguments below), so
  // nothing a bash-as-sh would import runs here; `command` and the special built-ins are the shell's.
  'IFS= command read -r _ || exit 125',
  ...STARTUP_VARIABLES.map((name) => `if command [ -n "\${MOUSSE_GATE_${name}+x}" ]; then ${name}=$MOUSSE_GATE_${name}; export ${name}; fi; unset MOUSSE_GATE_${name}`),
  // `$@`: Pi's shell and its arguments, behind `env NAME=VALUE…` when there are functions to restore.
  'exec "$@" </dev/null'
].join('\n')

/** An exported shell function as bash passes it (`BASH_FUNC_name%%`, older `BASH_FUNC_name()`). */
function isExportedFunction(name: string): boolean {
  return name.startsWith('BASH_FUNC_') && (name.endsWith('%%') || name.endsWith('()'))
}

function defaultShell(): string {
  return existsSync('/bin/bash') ? '/bin/bash' : 'bash'
}

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

/** Resolves with the exit code once the output is drained, as Pi's `waitForChildProcess` does. */
function waitForChild(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    let exited = false
    let exitCode: number | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let stdoutEnded = child.stdout === null
    let stderrEnded = child.stderr === null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      child.stdout?.removeListener('end', onStdoutEnd)
      child.stderr?.removeListener('end', onStderrEnd)
      child.stdout?.removeListener('data', onData)
      child.stderr?.removeListener('data', onData)
    }
    const finalize = (code: number | null) => {
      if (settled) return
      settled = true
      cleanup()
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve(code)
    }
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS)
    }
    const onData = () => {
      if (exited && !settled) arm()
    }
    const after = () => {
      if (exited && stdoutEnded && stderrEnded) finalize(exitCode)
    }
    const onStdoutEnd = () => { stdoutEnded = true; after() }
    const onStderrEnd = () => { stderrEnded = true; after() }
    const onError = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null) => {
      exited = true
      exitCode = code
      after()
      if (!settled) arm()
    }
    const onClose = (code: number | null) => finalize(code)
    child.stdout?.once('end', onStdoutEnd)
    child.stderr?.once('end', onStderrEnd)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
    child.once('close', onClose)
  })
}

/** `BashOperations` whose every command runs in a group the engine recorded first. */
export function containedBashOperations(options: ContainedShellOptions) {
  const spawn = options.spawn ?? nodeSpawn
  const kill = options.killGroup ?? killGroup
  return {
    exec: async (command: string, cwd: string, { onData, signal, timeout, env }: ShellExecOptions): Promise<{ exitCode: number | null }> => {
      const timeoutMs = resolveTimeoutMs(timeout)
      if (signal?.aborted) throw new Error('aborted')
      try {
        await access(cwd)
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`)
      }
      const base = env ?? process.env
      const gateEnv: NodeJS.ProcessEnv = { ...base }
      for (const name of STARTUP_VARIABLES) {
        delete gateEnv[`MOUSSE_GATE_${name}`]
        if (base[name] !== undefined) gateEnv[`MOUSSE_GATE_${name}`] = base[name]
        delete gateEnv[name]
      }
      const functions: string[] = []
      for (const name of Object.keys(gateEnv)) {
        if (!isExportedFunction(name)) continue
        functions.push(`${name}=${gateEnv[name]}`)
        delete gateEnv[name]
      }
      const shellCommand = [options.shell ?? defaultShell(), '-c', command]
      const run = functions.length ? [options.envPath ?? '/usr/bin/env', ...functions, ...shellCommand] : shellCommand
      const child = spawn(options.gate ?? '/bin/sh', ['-c', GATE_SCRIPT, 'mousse-gate', ...run], {
        cwd,
        detached: options.detached ?? process.platform !== 'win32',
        env: gateEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      const pid = child.pid
      const exited = waitForChild(child)
      child.stdin?.on('error', () => {})
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      const detach = () => {
        child.stdout?.removeListener('data', onData)
        child.stderr?.removeListener('data', onData)
      }
      if (!pid) {
        child.stdin?.end()
        await exited.catch(() => {})
        detach()
        throw new Error('The shell did not start')
      }
      let timedOut = false
      const onAbort = () => kill(pid)
      const timer = timeoutMs !== undefined ? setTimeout(() => { timedOut = true; kill(pid) }, timeoutMs) : undefined
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        try {
          await options.report(pid, signal)
        } catch (error) {
          // Not recorded: the gate gets no go line and starts nothing.
          child.stdin?.end()
          kill(pid)
          await exited.catch(() => {})
          throw signal?.aborted ? new Error('aborted') : error
        }
        if (signal?.aborted) {
          child.stdin?.end()
          kill(pid)
          await exited.catch(() => {})
          throw new Error('aborted')
        }
        child.stdin?.end('go\n')
        const exitCode = await exited
        if (signal?.aborted) throw new Error('aborted')
        if (timedOut) throw new Error(`timeout:${timeout}`)
        return { exitCode }
      } finally {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        detach()
        void options.ended?.(pid).catch(() => {})
      }
    }
  }
}
