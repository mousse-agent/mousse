import { execFile, spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CUA_INSTALL_PS1, CUA_INSTALL_SH, cuaInstallCommand, type ComputerDriverSource, type ComputerUseStatus } from '../../shared/computerUse'
import { trackChildProcess } from '../diagnostics/liveCounts'
import { OwnedStdioClientTransport } from '../integrations/mcp/ownedStdioTransport'
import { mousseVersion } from '../appVersion'

/**
 * Cua Driver as Mousse uses it (`src/shared/computerUse.ts`): found on this computer (the path the person chose, the
 * PATH, or the installer's own folder), installed on request with the official installer, and run as one MCP server
 * (`cua-driver mcp`) that every turn's computer tools share. One per service: the desktop is one, whichever profile asks.
 */

/** How long a found driver's version is trusted before Settings or a turn looks again. */
const STATUS_TTL_MS = 60_000
/** How long `cua-driver --version` may take. */
const VERSION_TIMEOUT_MS = 8_000
/** How long the installer may run before it is stopped. */
const INSTALL_TIMEOUT_MS = 10 * 60_000
/** How long starting the MCP server and its first listing may take. */
const CONNECT_TIMEOUT_MS = 30_000
/** Longest error line kept. */
const MAX_ERROR = 300

export interface DriverTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface DriverCallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
  structuredContent?: unknown
}

export interface ComputerUseDriverOptions {
  /** The setting now: whether computer use is on, and the driver the person chose. */
  settings(): { enabled: boolean; driverPath?: string }
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  /** Whether a file is there. Tests replace it. */
  exists?(path: string): boolean
  /** `cua-driver --version`'s output, or a thrown error. Tests replace it. */
  version?(path: string): Promise<string>
  /** Runs the official installer; resolves when it exits 0. Tests replace it. */
  runInstaller?(platform: NodeJS.Platform): Promise<void>
  /** An MCP client connected to `path mcp`. Tests replace it. */
  connect?(path: string): Promise<DriverConnection>
}

/** What the tools need of a running driver. */
export interface DriverConnection {
  listTools(): Promise<DriverTool[]>
  instructions(): string | undefined
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<DriverCallResult>
  close(): Promise<void>
}

function line(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The driver's file names on `platform`: Windows looks for the `.exe`. */
function binaryNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['cua-driver.exe'] : ['cua-driver']
}

/** Where the official installer puts the driver by default. */
export function defaultDriverPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [join(local, 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe')]
  }
  return [join(home, '.local', 'bin', 'cua-driver'), '/usr/local/bin/cua-driver', '/opt/homebrew/bin/cua-driver']
}

/** The driver to use and where it came from, or undefined when there is none. A chosen path is the only one tried. */
export function locateDriver(input: { chosen?: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; exists?: (path: string) => boolean }): { path: string; source: ComputerDriverSource } | undefined {
  const exists = input.exists ?? isFile
  if (input.chosen) return exists(input.chosen) ? { path: input.chosen, source: 'chosen' } : undefined
  const names = binaryNames(input.platform)
  const pathVar = input.env.PATH ?? input.env.Path ?? ''
  for (const dir of pathVar.split(input.platform === 'win32' ? ';' : delimiter)) {
    if (!dir.trim()) continue
    for (const name of names) {
      const candidate = join(dir.trim().replace(/^"|"$/g, ''), name)
      if (exists(candidate)) return { path: candidate, source: 'path' }
    }
  }
  for (const candidate of defaultDriverPaths(input.platform, input.env, input.home)) if (exists(candidate)) return { path: candidate, source: 'default' }
  return undefined
}

/** `cua-driver 0.38.0 — ...` → `0.38.0`. */
export function parseDriverVersion(output: string): string | undefined {
  return /cua-driver\s+v?(\d+\.\d+\.\d+[\w.+-]*)/i.exec(output)?.[1] ?? /\bv?(\d+\.\d+\.\d+[\w.+-]*)/.exec(output)?.[1]
}

function runVersion(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(path, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve(`${stdout}\n${stderr}`)
    })
  })
}

function runInstaller(platform: NodeJS.Platform): Promise<void> {
  const [command, args] = platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${CUA_INSTALL_PS1} | iex`]] as const
    // pipefail: a failed download fails the install, instead of an empty script exiting 0.
    : ['/bin/bash', ['-c', `set -o pipefail; curl -fsSL ${CUA_INSTALL_SH} | /bin/bash`]] as const
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
    trackChildProcess(child, 'installer')
    let tail = ''
    const keep = (chunk: Buffer) => { tail = (tail + chunk.toString('utf8')).slice(-4_000) }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(tail.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? `The installer stopped with code ${code}.`))
    })
  })
}

async function connectDriver(path: string): Promise<DriverConnection> {
  const transport = new OwnedStdioClientTransport({ command: path, args: ['mcp'] })
  const client = new Client({ name: 'mousse', version: mousseVersion() }, { capabilities: {} })
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
  } catch (error) {
    // A driver that started but never answered must not stay running.
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
    throw error
  }
  return {
    listTools: async () => {
      const tools: DriverTool[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: CONNECT_TIMEOUT_MS })
        for (const tool of page.tools) tools.push({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema as Record<string, unknown> })
        cursor = page.nextCursor
      } while (cursor && tools.length < 500)
      return tools
    },
    instructions: () => client.getInstructions(),
    // No timeout of its own: a driver action can take a while (a script, a recording), and the turn's stop aborts it.
    callTool: async (name, args, signal) => await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 10 * 60_000 }) as DriverCallResult,
    close: async () => { await client.close() }
  }
}

export class ComputerUseDriver {
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly home: string
  private cached: { key: string; at: number; status: ComputerUseStatus } | undefined
  /** Counts looks, so an older look that ends after a newer one changes nothing. */
  private looks = 0
  private installing: Promise<ComputerUseStatus> | undefined
  private installError: string | undefined
  private connection: { path: string; ready: Promise<DriverConnection> } | undefined
  private tools: { path: string; list: DriverTool[] } | undefined

  constructor(private readonly options: ComputerUseDriverOptions) {
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    this.home = options.home ?? homedir()
  }

  /** The driver now, as Settings shows it. `refresh`: look again now, not from the last minute's answer. */
  async status(refresh = false): Promise<ComputerUseStatus> {
    const { enabled, driverPath } = this.options.settings()
    const base = { enabled, installable: cuaInstallCommand(this.platform) !== undefined, ...((command) => (command ? { installCommand: command } : {}))(cuaInstallCommand(this.platform)) }
    if (this.installing) return { ...base, state: 'installing' }
    const key = driverPath ?? ''
    if (!refresh && this.cached && this.cached.key === key && Date.now() - this.cached.at < STATUS_TTL_MS) return { ...this.cached.status, ...base }
    const look = ++this.looks
    const found = locateDriver({ chosen: driverPath, platform: this.platform, env: this.env, home: this.home, exists: this.options.exists })
    let status: ComputerUseStatus
    if (!found) {
      status = { ...base, state: 'missing', ...(driverPath ? { path: driverPath, source: 'chosen' as const, error: 'No file there.' } : {}), ...(this.installError ? { error: this.installError } : {}) }
    } else {
      try {
        const version = parseDriverVersion(await (this.options.version ?? runVersion)(found.path))
        status = version ? { ...base, state: 'found', path: found.path, source: found.source, version } : { ...base, state: 'broken', path: found.path, source: found.source, error: "It ran but didn't say its version." }
      } catch (error) {
        status = { ...base, state: 'broken', path: found.path, source: found.source, error: line(error) }
      }
    }
    if (look !== this.looks) return status
    this.cached = { key, at: Date.now(), status }
    // Another driver than the one running now: the next call starts that one.
    if (this.connection && this.connection.path !== status.path) void this.close()
    return status
  }

  /** The last answer of `status`, without looking (for a listing, which can't wait). Undefined before the first look. */
  known(): ComputerUseStatus | undefined {
    const { driverPath } = this.options.settings()
    if (this.installing) return undefined
    if (!this.cached || this.cached.key !== (driverPath ?? '')) {
      // Look now for the next listing; this one counts as unknown.
      void this.status().catch(() => undefined)
      return undefined
    }
    if (Date.now() - this.cached.at >= STATUS_TTL_MS) void this.status().catch(() => undefined)
    return this.cached.status
  }

  /** Runs the official installer once at a time, then looks again. */
  install(): Promise<ComputerUseStatus> {
    if (this.installing) return this.installing
    if (cuaInstallCommand(this.platform) === undefined) return this.status()
    this.installError = undefined
    const work = (async () => {
      try {
        await (this.options.runInstaller ?? runInstaller)(this.platform)
      } catch (error) {
        this.installError = `The installer failed: ${line(error)}`
      } finally {
        this.installing = undefined
      }
      // The installer may have added its folder to the PATH of new processes only: its default folder is looked in too.
      return await this.status(true)
    })()
    this.installing = work
    return work
  }

  /** The driver's path when it runs and computer use is on; undefined otherwise. */
  async ready(): Promise<string | undefined> {
    const status = await this.status()
    // The switch as it is now: it may have been turned off while the driver was being checked.
    return this.options.settings().enabled && status.state === 'found' ? status.path : undefined
  }

  private async connect(path: string): Promise<DriverConnection> {
    if (this.connection?.path === path) return await this.connection.ready
    if (this.connection) void this.close()
    const ready = (this.options.connect ?? connectDriver)(path)
    const entry = { path, ready }
    this.connection = entry
    ready.catch(() => { if (this.connection === entry) this.connection = undefined })
    return await ready
  }

  /** The driver's tools and its own instructions. */
  async listTools(): Promise<{ tools: DriverTool[]; instructions?: string }> {
    const path = await this.ready()
    if (!path) throw new Error(this.unavailable(await this.status()))
    const connection = await this.connect(path)
    if (this.tools?.path !== path) this.tools = { path, list: await connection.listTools() }
    const instructions = connection.instructions()
    return { tools: this.tools.list, ...(instructions ? { instructions } : {}) }
  }

  /** Runs one of the driver's tools. A driver that went away is started again by the next call, never this one. */
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<DriverCallResult> {
    const path = await this.ready()
    if (!path) throw new Error(this.unavailable(await this.status()))
    const connection = await this.connect(path)
    try {
      return await connection.callTool(name, args, signal)
    } catch (error) {
      if (signal.aborted || !/closed|not connected|EPIPE/i.test(line(error))) throw error
      // Never sent again by itself: the action (a click, typing) may have run before the driver went away. The next
      // call starts the driver again.
      await this.close()
      throw new Error(`Cua Driver stopped during ${name}; it may or may not have run. Check the window, then try again.`)
    }
  }

  /** Why the computer tools can't run now, for the agent. */
  unavailable(status: ComputerUseStatus): string {
    if (!status.enabled) return 'Computer use is off in Settings → Computer use.'
    if (status.state === 'installing') return 'Cua Driver is being installed. Try again in a minute.'
    if (status.state === 'broken') return `Cua Driver didn't start${status.error ? `: ${status.error}` : ''}. Ask the user to check Settings → Computer use.`
    return 'Cua Driver is not installed. Ask the user to install it in Settings → Computer use.'
  }

  async close(): Promise<void> {
    const current = this.connection
    this.connection = undefined
    this.tools = undefined
    if (!current) return
    try {
      await (await current.ready).close()
    } catch {
      // It never started, or is gone already.
    }
  }
}
