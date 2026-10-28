import { execFile, spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, hostname, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import type * as NodePty from 'node-pty'
import { windowsSessionEnvironment } from './environment'
import type { ProcessHost, SessionExit, SessionProcess, SessionRequest } from './host'
import { windowsPaths } from './sftp/paths'
import {
  cachedShell,
  readOpenSshShell,
  windowsCommandLine,
  type WindowsShell
} from './windowsShell'

/**
 * The host of Windows. Every session runs under the helper `sshd.exe` (`native/sshd-helper`), and everything a
 * device starts is in one Job object of the device.
 *
 * - **The helper.** VS Code's Windows server script looks for an ancestor process named `sshd` and stops without
 *   one; it then watches that process and exits when it is gone. The helper is that ancestor: it runs the command
 *   line it is given, in the environment a fresh logon of the user gets (built by the helper from the registry,
 *   never from the daemon's own environment), and exits with the program's code. The program runs with a copy of
 *   the daemon's token, so the redirection guard Windows gives programs named `sshd.exe` does not reach it.
 * - **The job.** Named `Local\MousseEditor-<scope>`, with no breakaway allowed, so a server that detaches itself
 *   (`Start-Process`) is still in it. A named job lasts only while a handle to it is open, and a daemon's handles
 *   end with the daemon, so a small keeper (the helper's `keep` mode, one per device) holds it: while the daemon
 *   runs, and after the daemon has gone for as long as anything is left in the job. A daemon that starts again
 *   reaches the job by its name, and a block after a restart still ends what the device started.
 * - **Outside the daemon's own job.** Node puts every child it starts in a job of its own that ends with the
 *   daemon. The keeper is started detached, so it is not in it, and the helper makes its program outside it before
 *   it puts it in the device's job: a quit, an update or a restart of Mousse is an ordinary end on Windows too.
 * - **Outside the install folder.** The keepers and helpers run from a copy in the profile's folder
 *   (`helperCopy`), since the installer of an update stops every program under the install folder.
 * - **Ending.** An ordinary end of a session ends only its helper, as sshd's session process goes: the script
 *   that watched it exits by itself, and a server it started keeps running for the editor's reconnection. A forced
 *   end (block, switch off, revoke, Net off) ends the whole job: one call of the helper's `end` mode, run
 *   asynchronously, never on the daemon's thread.
 *
 * Without a helper this host is not made (`systemProcessHost`), and a computer whose helper does not run keeps
 * carrying editor connections to its own OpenSSH server, as before.
 */

const OVERLAY = 'MOUSSE_SSHD_ENV'
const KEEPER_READY_MS = 15_000
const END_MS = 15_000
/** The helper's exit code when the daemon itself is in the job it was asked to end. */
const OWN_JOB = 4

/** The name of a device's job; the helper takes no other. */
export function jobName(scope: string): string {
  return `Local\\MousseEditor-${scope}`
}

/** Where this code sits in a checkout of Mousse: its source, or the bundle in `out/main` (and its `chunks`). */
const CHECKOUT_LAYOUTS = [
  ['src', 'mms', 'net', 'editor', 'endpoint'],
  ['out', 'main'],
  ['out', 'main', 'chunks']
]

/** The root of the Mousse checkout this code was loaded from, found from its own folder alone; none when packaged. */
function checkoutRoot(moduleFolder: string): string | undefined {
  if (/[\\/]app\.asar(?:[\\/]|$)/iu.test(moduleFolder)) return undefined
  const parts = moduleFolder.split(/[\\/]+/u).filter(Boolean)
  for (const tail of CHECKOUT_LAYOUTS) {
    const at = parts.length - tail.length
    if (at < 1 || !tail.every((part, index) => parts[at + index]!.toLowerCase() === part)) continue
    const root = resolve(moduleFolder, ...tail.map(() => '..'))
    try {
      if (
        (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown })
          .name === 'mousse'
      )
        return root
    } catch {
      // Not a checkout.
    }
  }
  return undefined
}

/**
 * The helper. A packaged app takes only its own `resources\editor-ssh\sshd.exe`. A checkout takes only
 * `native\sshd-helper\target\release\sshd.exe` under its own root, which is a fixed number of folders above this
 * code and has Mousse's `package.json`. No other folder is looked in: a copy planted higher up (`C:\native\...`,
 * which any account may create) is never run. Undefined when there is none.
 */
export function findSshdHelper(
  moduleFolder: string = dirname(fileURLToPath(import.meta.url)),
  resources: string | undefined = (process as { resourcesPath?: string }).resourcesPath,
  executable: string = process.execPath
): string | undefined {
  const packaged: string[] = []
  if (resources) packaged.push(join(resources, 'editor-ssh', 'sshd.exe'))
  // The daemon of an installed app runs its own executable; its resources sit beside it.
  if (/^mousse(?:-cli)?\.exe$/iu.test(basename(executable)))
    packaged.push(join(dirname(executable), 'resources', 'editor-ssh', 'sshd.exe'))
  const found = packaged.find((path) => existsSync(path))
  if (found) return found
  const root = checkoutRoot(moduleFolder)
  if (!root) return undefined
  const built = join(root, 'native', 'sshd-helper', 'target', 'release', 'sshd.exe')
  return existsSync(built) ? built : undefined
}

let ptyModule: { spawn?: typeof NodePty.spawn } | undefined | null
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

/**
 * The helper run from a copy in the profile's own folder (`<folder>\<version>\sshd.exe`, the version being the
 * start of the packaged file's hash), never from the install folder: the installer of an update stops every
 * process whose program is under the install folder, and a keeper or a session helper stopped that way would end
 * the device's job. The profile's folder is the user's own. Before each use the copy is read and hashed again
 * and must match the packaged file; one that does not (changed, or never made) is written again, and when it
 * cannot be (it is in use, the disk is full), the packaged file itself is used.
 */
export function helperCopy(packaged: string, folder: string): () => Promise<string> {
  const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
  let source: Promise<{ bytes: Buffer; sha: string }> | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let cleaned = false
  const resolveCopy = async (): Promise<string> => {
    try {
      source ??= readFile(packaged).then((bytes) => ({ bytes, sha: hash(bytes) }))
      const { bytes, sha } = await source
      const version = sha.slice(0, 16)
      const copy = join(folder, version, 'sshd.exe')
      if (!cleaned) {
        cleaned = true
        // Older versions are let go; one still running (a keeper from before an update) stays until it ends.
        void readdir(folder)
          .then((names) =>
            Promise.all(
              names
                .filter((name) => name !== version && /^[0-9a-f]{16}$/u.test(name))
                .map((name) =>
                  rm(join(folder, name), { recursive: true, force: true }).catch(() => undefined)
                )
            )
          )
          .catch(() => undefined)
      }
      const present = await readFile(copy).catch(() => undefined)
      if (present && hash(present) === sha) return copy
      await mkdir(dirname(copy), { recursive: true })
      const temporary = `${copy}.${randomBytes(6).toString('hex')}.tmp`
      await writeFile(temporary, bytes)
      try {
        await rename(temporary, copy)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
      const written = await readFile(copy)
      return hash(written) === sha ? copy : packaged
    } catch {
      return packaged
    }
  }
  // One check at a time, so two session starts do not write the copy together.
  return () => {
    const next = queue.then(resolveCopy, resolveCopy)
    queue = next.catch(() => undefined)
    return next
  }
}

export interface WindowsHostOptions {
  /** The helper `sshd.exe`. */
  helper: string
  /**
   * The profile's folder for a copy of the helper, which keepers and sessions then run from (`helperCopy`); without
   * one (tests), the helper itself is run.
   */
  folder?: string
  /** Tests try the helper again sooner than after 1, 5 and 30 minutes. */
  retryDelays?: number[]
  /** Tests run as the user with a throwaway home; the daemon uses the account it runs as. */
  account?: { user: string; home: string }
  /** Tests give a shell of their own instead of the computer's OpenSSH settings. */
  shell?: () => Promise<WindowsShell>
  /** Tests wait for no time between kill rounds. */
  pause?: (ms: number) => Promise<void>
}

export interface WindowsProcessHost extends ProcessHost {
  /**
   * Lets go of the keepers, as the daemon's exit does: each holds its job until nothing is left in it, and a host
   * made later (a daemon that started again) reaches the jobs by their names.
   */
  release(): void
  /** The scopes whose job this host holds now (tests end them when they finish). */
  held(): string[]
}

interface Keeper {
  process?: ChildProcess
  ready: Promise<void>
}

export function createWindowsHost(options: WindowsHostOptions): WindowsProcessHost {
  const helperPath = options.folder
    ? helperCopy(options.helper, options.folder)
    : () => Promise.resolve(options.helper)
  const retryDelays = options.retryDelays ?? [60_000, 5 * 60_000, 30 * 60_000]
  const daemon = String(process.pid)
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const info = userInfo()
  const account = options.account ?? { user: info.username, home: info.homedir || homedir() }
  const homeIsProfile = options.account !== undefined
  const shellOf = options.shell ?? cachedShell(() => readOpenSshShell(systemRoot))
  const pause =
    options.pause ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        timer.unref?.()
      }))
  const keepers = new Map<string, Keeper>()
  /** The helpers running now, by scope. */
  const programs = new Map<string, Set<{ kill(): void }>>()
  const ending = new Map<string, { again: boolean; done: Promise<number> }>()
  /** Whether the helper has been seen to work; undefined until the first try has finished. */
  let works: boolean | undefined

  function track(scope: string, program: { kill(): void }): () => void {
    const set = programs.get(scope) ?? new Set()
    set.add(program)
    programs.set(scope, set)
    return () => {
      set.delete(program)
      if (!set.size && programs.get(scope) === set) programs.delete(scope)
    }
  }

  /** A helper that cannot be started at all (gone, or refused by the system) leaves editors to the system's sshd. */
  function noteStartFailure(error: NodeJS.ErrnoException): void {
    if (['ENOENT', 'EACCES', 'EPERM', 'UNKNOWN'].includes(error.code ?? '')) {
      works = false
      scheduleTry()
    }
  }

  function startKeeper(scope: string): Keeper {
    const keeper: Keeper = { ready: Promise.resolve() }
    keeper.ready = (async () => {
      const helper = await helperPath()
      // Detached: outside the job Node keeps for its children, which ends with the daemon. The keeper has to outlive
      // the daemon, or a quit, an update or a restart would end every device's job.
      const child = spawnProcess(helper, ['keep', daemon, jobName(scope)], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        detached: true
      })
      keeper.process = child
      child.stdin!.on('error', () => {})
      // The keeper never holds the daemon open; its pipe closes when the daemon ends, which is what it waits for.
      child.unref()
      ;(child.stdin as unknown as { unref?: () => void }).unref?.()
      ;(child.stdout as unknown as { unref?: () => void }).unref?.()
      await new Promise<void>((resolve, reject) => {
        let text = ''
        const timer = setTimeout(() => {
          reject(new Error('The SSH helper did not answer.'))
          child.kill()
        }, KEEPER_READY_MS)
        timer.unref?.()
        child.stdout!.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8')
          if (text.includes('ready')) {
            clearTimeout(timer)
            resolve()
          }
        })
        child.once('error', (error) => {
          clearTimeout(timer)
          noteStartFailure(error)
          reject(error)
        })
        child.once('exit', () => {
          clearTimeout(timer)
          if (keepers.get(scope) === keeper) keepers.delete(scope)
          reject(new Error('The SSH helper ended.'))
        })
      })
    })()
    keeper.ready.catch(() => {
      if (keepers.get(scope) === keeper) keepers.delete(scope)
    })
    keepers.set(scope, keeper)
    return keeper
  }

  async function keep(scope: string): Promise<void> {
    const held = keepers.get(scope)
    if (held) {
      try {
        return await held.ready
      } catch {
        if (keepers.get(scope) === held) keepers.delete(scope)
      }
    }
    await (keepers.get(scope) ?? startKeeper(scope)).ready
  }

  /** What one short run of the helper printed; undefined when it failed (with its exit code). */
  async function ask(args: string[]): Promise<{ stdout: string; code: number }> {
    const helper = await helperPath()
    return new Promise((resolve) => {
      execFile(helper, args, { windowsHide: true, timeout: END_MS }, (error, stdout) => {
        const code = error ? Number((error as { code?: unknown }).code ?? 1) || 1 : 0
        resolve({ stdout: String(stdout), code })
      })
    })
  }

  /**
   * Ends everything in the job of `scope`: how many processes it ended, and how many are left (-1 when the helper
   * failed). A job that holds the daemon itself is left alone, and reported as nothing to end.
   */
  async function endJob(scope: string): Promise<{ ended: number; left: number }> {
    const { stdout, code } = await ask(['end', daemon, jobName(scope)])
    if (code === OWN_JOB) return { ended: 0, left: 0 }
    const [ended, left] = stdout.trim().split(/\s+/u).map(Number)
    if (code !== 0 || !Number.isInteger(ended) || !Number.isInteger(left))
      return { ended: 0, left: -1 }
    return { ended: ended!, left: left! }
  }

  /** The scopes of the device jobs that exist in this logon session, whoever made them and whenever. */
  async function listJobs(): Promise<string[]> {
    const { stdout, code } = await ask(['list', daemon])
    if (code !== 0) return []
    return stdout.split(/\r?\n/u).filter((line) => /^[0-9a-f]{8,64}$/u.test(line))
  }

  /**
   * The local drives, as SFTP's `/` lists them (`C:`): one short run of the helper, kept for 30 seconds. Nothing
   * waits on a drive that does not answer, and network drives are left out.
   */
  let drives: { at: number; value: Promise<string[]> } | undefined
  function driveRoots(): Promise<string[]> {
    if (!drives || Date.now() - drives.at > 30_000)
      drives = {
        at: Date.now(),
        value: ask(['drives', daemon]).then(({ stdout, code }) =>
          code === 0 ? [...stdout.trim()].filter((c) => /[A-Z]/u.test(c)).map((c) => `${c}:`) : []
        )
      }
    return drives.value
  }

  /**
   * Ends the job of `scope` until nothing is left, and resolves with how many processes were ended. One run per
   * scope at a time: a second request while one runs makes it look once more afterwards. A helper that was joining
   * the job while it ended is caught on the next round.
   */
  function endScope(scope: string): Promise<number> {
    const current = ending.get(scope)
    if (current) {
      current.again = true
      return current.done
    }
    const state = { again: false, done: Promise.resolve(0) }
    state.done = (async () => {
      let total = 0
      do {
        state.again = false
        for (let round = 0; round < 6; round++) {
          const { ended, left } = await endJob(scope)
          total += ended
          const helpers = programs.get(scope)
          for (const program of helpers ?? []) program.kill()
          if (left <= 0 && !helpers?.size) break
          await pause(40)
        }
      } while (state.again)
      return total
    })().finally(() => ending.delete(scope))
    ending.set(scope, state)
    return state.done
  }

  // Tries the helper: a keeper for a scope of its own, which is then ended. Until this has worked, the endpoint is
  // not offered, and editor connections go to the system's SSH server. A try that fails (an antivirus scan that
  // held the first start, a passing error) is made again after 1, 5 and 30 minutes.
  let tries = 0
  let trying = false
  let retry: ReturnType<typeof setTimeout> | undefined
  async function tryHelper(): Promise<void> {
    if (trying) return
    trying = true
    tries++
    const scope = randomBytes(16).toString('hex')
    try {
      await keep(scope)
      works = (await endJob(scope)).left === 0
    } catch {
      works = false
    } finally {
      trying = false
      const keeper = keepers.get(scope)
      keepers.delete(scope)
      keeper?.process?.stdin?.end()
    }
    if (!works) scheduleTry()
  }
  function scheduleTry(): void {
    if (retry || trying) return
    const delay = retryDelays[tries - 1]
    if (delay === undefined) return
    retry = setTimeout(() => {
      retry = undefined
      void tryHelper()
    }, delay)
    retry.unref?.()
  }
  void tryHelper()

  function environmentOf(request: SessionRequest, shell: WindowsShell): Record<string, string> {
    const env = windowsSessionEnvironment({
      user: account.user,
      home: account.home,
      shell: shell.path,
      computer: hostname().toUpperCase(),
      homeIsProfile,
      sshConnection: request.sshConnection,
      ...(request.pty ? { term: request.pty.term } : {}),
      requested: request.requested,
      scope: request.scope
    })
    // The helper passes on only the variables `OVERLAY` names; `SystemRoot` is for the helper alone.
    return { ...env, [OVERLAY]: Object.keys(env).join(';'), SystemRoot: systemRoot }
  }

  const listeners = (): {
    exit: Array<(exit: SessionExit) => void>
    close: Array<() => void>
    error: Array<(error: Error) => void>
  } => ({ exit: [], close: [], error: [] })

  function startPipes(
    helper: string,
    request: SessionRequest,
    line: string,
    env: Record<string, string>
  ): SessionProcess {
    const child = spawnProcess(helper, ['session', daemon, jobName(request.scope), line], {
      cwd: account.home,
      env,
      // The command line is passed as it is: it is already what the shell must read.
      argv0: `"${helper}"`,
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const untrack = track(request.scope, { kill: () => child.kill() })
    const finish = listeners()
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      untrack()
      noteStartFailure(error)
      for (const listener of finish.error) listener(error)
    })
    child.on('exit', (code, signal) => {
      untrack()
      for (const listener of finish.exit) listener({ code, signal })
    })
    child.on('close', () => {
      for (const listener of finish.close) listener()
    })
    return {
      input: child.stdin,
      output: child.stdout,
      errors: child.stderr,
      onExit: (listener) => finish.exit.push(listener),
      onClose: (listener) => finish.close.push(listener),
      onError: (listener) => finish.error.push(listener),
      resize: () => {},
      // Windows programs get no signals; Win32-OpenSSH ignores the request too.
      signal: () => {},
      // As sshd's session process ends: the pipes close and the helper goes, and nothing else is stopped.
      hangUp: () => {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        child.kill()
      },
      kill: () => child.kill()
    }
  }

  function startTerminal(
    helper: string,
    request: SessionRequest,
    line: string,
    env: Record<string, string>
  ): SessionProcess {
    const spawn = loadPty()
    if (!spawn || !request.pty) throw new Error('This computer cannot give a terminal here.')
    const terminal = spawn(helper, `session ${daemon} ${jobName(request.scope)} ${line}`, {
      name: request.pty.term,
      cols: request.pty.cols,
      rows: request.pty.rows,
      cwd: account.home,
      env
    })
    let exited = false
    const end = (): void => {
      if (exited) return
      try {
        terminal.kill()
      } catch {
        // The terminal already ended.
      }
    }
    const untrack = track(request.scope, { kill: end })
    const output = new PassThrough()
    const finish = listeners()
    // A character split between two SSH packets (a large paste) is decoded across them.
    const decoder = new StringDecoder('utf8')
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
    terminal.onData((data) => {
      if (!exited) output.write(data)
    })
    terminal.onExit(({ exitCode }) => {
      exited = true
      untrack()
      for (const listener of finish.exit) listener({ code: exitCode, signal: null })
      output.end(() => {
        for (const listener of finish.close) listener()
      })
    })
    return {
      input,
      output,
      onExit: (listener) => finish.exit.push(listener),
      onClose: (listener) => finish.close.push(listener),
      onError: (listener) => finish.error.push(listener),
      resize: (columns, rows) => {
        try {
          terminal.resize(Math.max(1, columns), Math.max(1, rows))
        } catch {
          // The terminal ended.
        }
      },
      signal: () => {},
      // Closing the terminal ends what runs on it, as a hang-up does; a detached server is not on it.
      hangUp: end,
      kill: end
    }
  }

  return {
    kind: 'windows',
    user: account.user,
    home: account.home,
    sftp: { paths: windowsPaths(account.home), listRoots: driveRoots },
    terminals: () => loadPty() !== undefined,
    ready: () => works === true,
    async start(request) {
      if (works === false) throw new Error('The SSH helper cannot run on this computer.')
      const [shell, helper] = await Promise.all([shellOf(), helperPath(), keep(request.scope)])
      const line = windowsCommandLine(shell, request.command, request.pty !== undefined)
      const env = environmentOf(request, shell)
      return request.pty
        ? startTerminal(helper, request, line, env)
        : startPipes(helper, request, line, env)
    },
    killScope: async (scope) => void (await endScope(scope)),
    async sweep(isAllowed) {
      // The jobs themselves are the list: one per device that has (or had, before a restart) anything running.
      const refused = (await listJobs()).filter((scope) => !isAllowed(scope))
      const counts = await Promise.all(refused.map((scope) => endScope(scope)))
      return counts.reduce((sum, count) => sum + count, 0)
    },
    scopes: () => [...programs.keys()],
    held: () => [...keepers.keys()],
    release() {
      for (const keeper of keepers.values()) keeper.process?.stdin?.end()
      keepers.clear()
    }
  }
}
