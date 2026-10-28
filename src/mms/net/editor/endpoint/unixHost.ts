import { spawn as spawnProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir, userInfo } from 'node:os'
import { basename } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type * as NodePty from 'node-pty'
import {
  readSystemEnvironments,
  runtimeDirectory,
  SCOPE_VARIABLE,
  unixLoginEnvironment
} from './environment'
import type { ProcessHost, SessionExit, SessionProcess, SessionRequest } from './host'
import { posixPaths } from './sftp/paths'
import { readProcesses, ScopeKiller, type ProcessRow } from './scope'

/**
 * The host of Linux and macOS: programs start as the user the daemon runs as, in a clean login environment, each
 * session's program leading a process group of its own (as under `sshd`), and a device's scope is stopped by the
 * marker and the tree (`scope.ts`).
 */

/** The signals an SSH `signal` request may name (RFC 4254 section 6.9). */
const SIGNALS = new Set([
  'ABRT',
  'ALRM',
  'FPE',
  'HUP',
  'ILL',
  'INT',
  'KILL',
  'PIPE',
  'QUIT',
  'SEGV',
  'TERM',
  'USR1',
  'USR2'
])

let ptyModule: { spawn?: typeof NodePty.spawn } | undefined | null
/** `node-pty` is loaded when a client asks for a terminal; it has no build for every system, and may not load. */
function loadPty(): typeof NodePty.spawn | undefined {
  if (ptyModule === undefined) {
    try {
      ptyModule = createRequire(import.meta.url)('node-pty') as { spawn?: typeof NodePty.spawn }
    } catch {
      ptyModule = null
    }
  }
  return typeof ptyModule?.spawn === 'function' ? ptyModule.spawn : undefined
}

export interface UnixHostOptions {
  platform?: NodeJS.Platform
  /** Tests run as a throwaway user and home; the daemon uses the account it runs as. */
  account?: { user: string; home: string; shell: string; uid?: number }
  /** Tests replace how processes are read and signalled. */
  scope?: ConstructorParameters<typeof ScopeKiller>[0]
  /** Tests give a `TZ` and `TMPDIR` of their own. */
  daemonEnvironment?: { TZ?: string | undefined; TMPDIR?: string | undefined }
  /** Tests do not want the system's `/etc/environment` and `/etc/default/locale`. */
  systemEnvironmentFiles?: string[]
}

function accountOfDaemon(): { user: string; home: string; shell: string; uid?: number } {
  const info = userInfo()
  return {
    user: info.username,
    home: info.homedir || homedir(),
    shell: info.shell || '/bin/sh',
    ...(info.uid >= 0 ? { uid: info.uid } : {})
  }
}

function signalTo(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone.
  }
}

export function createUnixHost(options: UnixHostOptions = {}): ProcessHost {
  // A daemon that was started from an editor's terminal carries the marker of that device, and so would everything it
  // starts (agents, terminals, helpers), and a block of the device would stop them all. Its own environment is
  // cleaned here; what it already started cannot be, so the sweep never stops the daemon's own tree either.
  delete process.env[SCOPE_VARIABLE]
  const platform = options.platform ?? process.platform
  const account = options.account ?? accountOfDaemon()
  const kills = new ScopeKiller(
    options.scope ?? {
      snapshot: (): Promise<ProcessRow[]> => readProcesses(platform)(),
      signal: (pid, signal) => process.kill(pid, signal)
    }
  )

  async function environmentOf(request: SessionRequest): Promise<Record<string, string>> {
    const linux = platform === 'linux'
    const runtimeDir = linux ? await runtimeDirectory(account.uid) : undefined
    return unixLoginEnvironment({
      platform,
      user: account.user,
      home: account.home,
      shell: account.shell,
      sshConnection: request.sshConnection,
      ...(request.pty ? { term: request.pty.term } : {}),
      ...(linux ? { system: await readSystemEnvironments(options.systemEnvironmentFiles) } : {}),
      ...(runtimeDir ? { runtimeDir } : {}),
      daemon: options.daemonEnvironment ?? { TZ: process.env.TZ, TMPDIR: process.env.TMPDIR },
      requested: request.requested,
      scope: request.scope
    })
  }

  /** `sshd`'s command line: a shell request runs the user's shell as a login shell, an exec runs `shell -c command`. */
  function commandLine(request: SessionRequest): { file: string; args: string[]; argv0: string } {
    const name = basename(account.shell)
    return request.command === undefined
      ? { file: account.shell, args: [], argv0: `-${name}` }
      : { file: account.shell, args: ['-c', request.command], argv0: name }
  }

  const finishers = (): {
    exit: Array<(exit: SessionExit) => void>
    close: Array<() => void>
    error: Array<(error: Error) => void>
  } => ({ exit: [], close: [], error: [] })

  function startPipes(request: SessionRequest, env: Record<string, string>): SessionProcess {
    const line = commandLine(request)
    const child = spawnProcess(line.file, line.args, {
      cwd: account.home,
      env,
      argv0: line.argv0,
      // A program of its own session and process group, as under sshd: a signal to it does not reach the daemon.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const pid = child.pid
    if (pid !== undefined) kills.track(request.scope, pid)
    const listeners = finishers()
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      if (pid !== undefined) kills.untrack(request.scope, pid)
      for (const listener of listeners.error) listener(error)
    })
    child.on('exit', (code, signal) => {
      if (pid !== undefined) kills.untrack(request.scope, pid)
      for (const listener of listeners.exit) listener({ code, signal })
    })
    child.on('close', () => {
      for (const listener of listeners.close) listener()
    })
    return {
      input: child.stdin,
      output: child.stdout,
      errors: child.stderr,
      onExit: (listener) => listeners.exit.push(listener),
      onClose: (listener) => listeners.close.push(listener),
      onError: (listener) => listeners.error.push(listener),
      resize: () => {},
      signal: (name) => {
        if (pid !== undefined && SIGNALS.has(name)) signalTo(pid, `SIG${name}` as NodeJS.Signals)
      },
      hangUp: () => {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
      },
      kill: () => {
        if (pid === undefined) return
        signalTo(-pid, 'SIGKILL')
        signalTo(pid, 'SIGKILL')
      }
    }
  }

  function startTerminal(request: SessionRequest, env: Record<string, string>): SessionProcess {
    const spawn = loadPty()
    if (!spawn || !request.pty) throw new Error('This computer cannot give a terminal here.')
    const line = commandLine(request)
    // `node-pty` cannot set `argv[0]`, so a login shell is asked for with `-l`, which every shell takes.
    const args = request.command === undefined ? ['-l'] : line.args
    const terminal = spawn(line.file, args, {
      name: request.pty.term,
      cols: request.pty.cols,
      rows: request.pty.rows,
      cwd: account.home,
      env
    })
    const pid = terminal.pid
    kills.track(request.scope, pid)
    const output = new PassThrough()
    const listeners = finishers()
    // A multi-byte character can be split between two SSH packets (a large paste): it is decoded across them.
    const decoder = new StringDecoder('utf8')
    let hungUp = false
    const input = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        try {
          const text = decoder.write(chunk)
          if (text) terminal.write(text)
        } catch {
          // The terminal is gone; what was typed has nowhere to go.
        }
        callback()
      }
    })
    // After a hang-up nobody reads the output any more: a program that ignores SIGHUP must not fill the daemon's memory.
    terminal.onData((data) => {
      if (!hungUp) output.write(data)
    })
    terminal.onExit(({ exitCode, signal }) => {
      kills.untrack(request.scope, pid)
      for (const listener of listeners.exit)
        listener({ code: signal ? null : exitCode, signal: signal ? signalName(signal) : null })
      output.end(() => {
        for (const listener of listeners.close) listener()
      })
    })
    return {
      input,
      output,
      onExit: (listener) => listeners.exit.push(listener),
      onClose: (listener) => listeners.close.push(listener),
      onError: (listener) => listeners.error.push(listener),
      resize: (columns, rows) => {
        try {
          terminal.resize(Math.max(1, columns), Math.max(1, rows))
        } catch {
          // The terminal ended.
        }
      },
      signal: (name) => {
        if (SIGNALS.has(name)) signalTo(pid, `SIG${name}` as NodeJS.Signals)
      },
      // The terminal's program leads its own session: a hang-up of the group is what closing the terminal does.
      hangUp: () => {
        hungUp = true
        signalTo(-pid, 'SIGHUP')
        // And the pseudo-terminal's controlling side is closed, as closing a terminal does: a program that ignores
        // SIGHUP no longer has anywhere to write.
        try {
          ;(terminal as unknown as { destroy?: () => void }).destroy?.()
        } catch {
          // Already closed.
        }
        output.destroy()
      },
      kill: () => {
        signalTo(-pid, 'SIGKILL')
        signalTo(pid, 'SIGKILL')
      }
    }
  }

  return {
    kind: 'unix',
    user: account.user,
    home: account.home,
    sftp: { paths: posixPaths(account.home) },
    terminals: () => loadPty() !== undefined,
    async start(request) {
      const env = await environmentOf(request)
      return request.pty ? startTerminal(request, env) : startPipes(request, env)
    },
    killScope: async (scope) => void (await kills.kill(scope)),
    sweep: (isAllowed) => kills.sweep(isAllowed),
    scopes: () => kills.tokens()
  }
}

const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  6: 'SIGABRT',
  9: 'SIGKILL',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM'
}
function signalName(signal: number): string {
  return SIGNAL_NAMES[signal] ?? `SIG${signal}`
}
