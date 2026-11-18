import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { engineLimits, packagedBuild } from '../limits'
import type { AppPipe } from './appChannel'

const BINARY = process.platform === 'win32' ? 'mousse-helper.exe' : 'mousse-helper'

/** Where this code sits in a checkout of Mousse: its source, or the bundle in `out/main` (and its `chunks`). */
const CHECKOUT_LAYOUTS = [
  ['src', 'mms', 'netEngine', 'helper'],
  ['out', 'main'],
  ['out', 'main', 'chunks']
]

function checkoutRoot(moduleFolder: string): string | undefined {
  if (/[\\/]app\.asar(?:[\\/]|$)/iu.test(moduleFolder)) return undefined
  const parts = moduleFolder.split(/[\\/]+/u).filter(Boolean)
  for (const tail of CHECKOUT_LAYOUTS) {
    const at = parts.length - tail.length
    if (
      at < 1 ||
      !tail.every((part, index) => parts[at + index]!.toLowerCase() === part.toLowerCase())
    )
      continue
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
 * The helper binary (design §1). An installed app runs only its own `resources/net-helper/mousse-helper[.exe]`
 * (beside its executable too, for the daemon an installed app runs). A checkout runs `MOUSSE_NET_HELPER`, else the
 * one `scripts/build-net-helper.mjs` built. Undefined when there is none: networking is not in this build.
 */
export function findNetHelper(
  options: {
    packaged?: boolean
    resources?: string
    executable?: string
    env?: NodeJS.ProcessEnv
    moduleFolder?: string
  } = {}
): string | undefined {
  const packaged = options.packaged ?? packagedBuild()
  const resources = options.resources ?? (process as { resourcesPath?: string }).resourcesPath
  const executable = options.executable ?? process.execPath
  if (packaged) {
    const candidates: string[] = []
    if (resources) candidates.push(join(resources, 'net-helper', BINARY))
    if (/^mousse(?:-cli)?(?:\.exe)?$/iu.test(basename(executable)))
      candidates.push(join(dirname(executable), 'resources', 'net-helper', BINARY))
    return candidates.find((path) => existsSync(path))
  }
  const named = (options.env ?? process.env).MOUSSE_NET_HELPER?.trim()
  if (named) return existsSync(named) ? named : undefined
  const root = checkoutRoot(options.moduleFolder ?? dirname(fileURLToPath(import.meta.url)))
  const built = root && join(root, 'native', 'net-helper', 'target', 'package', BINARY)
  return built && existsSync(built) ? built : undefined
}

const FILE_KEY_VARIABLE = 'MOUSSE_NET_ENGINE_INSECURE_FILE_KEY'

/**
 * Whether the identity key goes to a plain file instead of the OS keystore (`MOUSSE_NET_ENGINE_INSECURE_FILE_KEY=1`): for
 * tests and development runs only, where no keystore can be unlocked (a daemon started over SSH on macOS). Like the
 * owner checks' controls, an installed app ignores it and says so: its keys always go to the keystore.
 */
export function readInsecureFileKey(
  env: NodeJS.ProcessEnv,
  packaged = packagedBuild()
): { on: boolean; problems: string[] } {
  const raw = env[FILE_KEY_VARIABLE]?.trim()
  if (!raw) return { on: false, problems: [] }
  if (packaged)
    return { on: false, problems: [`${FILE_KEY_VARIABLE} is ignored by an installed app`] }
  if (raw !== '1')
    return {
      on: false,
      problems: [`${FILE_KEY_VARIABLE}=${JSON.stringify(raw)} is not 1; the keystore is used`]
    }
  return { on: true, problems: [] }
}

let fileKey: { on: boolean; problems: string[] } | undefined

/** Whether this process keeps new identity keys in a file (read once; see `readInsecureFileKey`). */
export function insecureFileKey(): boolean {
  fileKey ??= readInsecureFileKey(process.env)
  return fileKey.on
}

/** What was wrong with the file-key variable, reported with the limits. */
export function insecureFileKeyProblems(): readonly string[] {
  fileKey ??= readInsecureFileKey(process.env)
  return fileKey.problems
}

/**
 * The address the helper listens on: every interface (`0.0.0.0`), or `MOUSSE_NET_ENGINE_HELPER_LISTEN_IP` (checks that run
 * every computer on one machine listen on `127.0.0.1`).
 */
export function helperListenIp(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOUSSE_NET_ENGINE_HELPER_LISTEN_IP?.trim() || '0.0.0.0'
}

/** The helper's id for a profile: 32 hex digits (a profile's UUID without its dashes, else a digest of it). */
export function helperProfileId(profileId: string): string {
  const plain = profileId.replace(/-/g, '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(plain)
    ? plain
    : createHash('sha256').update(profileId).digest('hex').slice(0, 32)
}

/** One run of a helper: its stdio as the app channel's pipe, how it ended, and a kill. */
export interface LaunchedHelper {
  pipe: AppPipe
  /** Settles when the process is gone, with what it said on stderr last. */
  exited: Promise<{ code: number | null; signal: string | null; stderr: string }>
  kill(): void
  pid?: number
}

/**
 * The helper's environment: the app's, without the app's own `MOUSSE_NET_*` variables the helper does not know
 * (it refuses to start on one; `MOUSSE_NET_ENGINE_*` and `MOUSSE_NET_HELPER` it ignores).
 */
export function helperEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const name of ['MOUSSE_NET_QA_OPT_IN', 'MOUSSE_NET_REPO']) delete out[name]
  return out
}

/** The arguments of a helper for `state`; the identity key goes to a plain file only when `insecureFileKey`. */
export function helperArgs(state: string, command: string[], insecureFileKey: boolean): string[] {
  return [...(insecureFileKey ? ['--insecure-file-key'] : []), '--state', state, ...command]
}

/** Runs `init` for a new endpoint; rejects with what the helper said. */
export function initEndpoint(
  binary: string,
  state: string,
  profile: string,
  insecureFileKey: boolean
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      binary,
      helperArgs(state, ['init', '--profile', profile], insecureFileKey),
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: helperEnv(),
        windowsHide: true
      }
    )
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => (stderr = (stderr + text).slice(-4096)))
    const timer = setTimeout(() => child.kill(), engineLimits().helperInitDeadlineMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(error.message))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(lastLine(stderr) || `init exited ${code}`))
    })
  })
}

export function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return (lines[lines.length - 1] ?? '').replace(/^error:\s*/i, '')
}

/**
 * Starts `serve --app` for `state` and wraps its stdin and stdout as the app channel's pipe. `port` fixes the port
 * it listens on from then on (without it, the port of its first start is kept).
 */
export function launchHelper(
  binary: string,
  state: string,
  insecureFileKey: boolean,
  port?: number
): LaunchedHelper {
  const child = spawn(
    binary,
    helperArgs(
      state,
      [
        'serve',
        '--app',
        '--listen-ip',
        helperListenIp(),
        ...(port === undefined ? [] : ['--port', String(port)])
      ],
      insecureFileKey
    ),
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: helperEnv(),
      windowsHide: true
    }
  )
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text: string) => (stderr = (stderr + text).slice(-4096)))
  const closeListeners: Array<() => void> = []
  let closed = false
  const closeOnce = () => {
    if (closed) return
    closed = true
    for (const listener of closeListeners.splice(0)) listener()
  }
  const exited = new Promise<{ code: number | null; signal: string | null; stderr: string }>(
    (resolvePromise) => {
      child.on('error', (error) => {
        stderr += `\n${error.message}`
        closeOnce()
        resolvePromise({ code: null, signal: null, stderr })
      })
      child.on('exit', (code, signal) => {
        closeOnce()
        // What the helper wrote last on its way out arrives before its streams close.
        child.stderr.once('close', () => resolvePromise({ code, signal, stderr }))
        if (child.stderr.closed) resolvePromise({ code, signal, stderr })
      })
    }
  )
  // A write to a helper that is gone is lost with it; the pipe closes on its exit.
  child.stdin.on('error', () => undefined)
  child.stdout.on('end', closeOnce)
  const pipe: AppPipe = {
    write: (bytes) => (closed || child.stdin.destroyed ? true : child.stdin.write(bytes)),
    onDrain: (listener) => void child.stdin.on('drain', listener),
    onData: (listener) => void child.stdout.on('data', (chunk: Buffer) => listener(chunk)),
    onClose: (listener) => (closed ? setImmediate(listener) : void closeListeners.push(listener)),
    // Closing stdin is the helper's cue to send GOAWAY and exit (§1).
    close: () => {
      if (!child.stdin.destroyed) child.stdin.end()
    }
  }
  return {
    pipe,
    exited,
    pid: child.pid,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }
}
