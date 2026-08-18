import { fstatSync } from 'fs'

export type OutputMode = 'text' | 'json'

export interface CliGlobals {
  homeDir: string
  mode: OutputMode
  print: boolean
  provider?: string
  model?: string
  apiKey?: string
  continueSession: boolean
  sessionId?: string
  version: boolean
  help: boolean
}

export interface ParsedArgs {
  globals: CliGlobals
  command: string | null
  subcommand: string | null
  positional: string[]
  flags: Map<string, string | boolean>
  raw: string[]
}

const GLOBAL_FLAGS: Record<string, { key: keyof CliGlobals | 'home'; alias?: string; hasValue?: boolean }> = {
  print: { key: 'print', alias: 'p' },
  mode: { key: 'mode', hasValue: true },
  provider: { key: 'provider', hasValue: true },
  model: { key: 'model', hasValue: true },
  'api-key': { key: 'apiKey', hasValue: true },
  continue: { key: 'continueSession', alias: 'c' },
  session: { key: 'sessionId', hasValue: true },
  home: { key: 'home', hasValue: true },
  version: { key: 'version', alias: 'v' },
  help: { key: 'help', alias: 'h' }
}

const COMMANDS = new Set([
  'schedule', 'agents', 'channels', 'config', 'service',
  'workspace', 'publish', 'undo', 'revert-code', 'redo', 'fork', 'operation'
])

function defaultGlobals(): CliGlobals {
  return {
    homeDir: '',
    mode: 'text',
    print: false,
    continueSession: false,
    version: false,
    help: false
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const globals = defaultGlobals()
  const flags = new Map<string, string | boolean>()
  const positional: string[] = []
  let i = 0

  while (i < argv.length) {
    const arg = argv[i]

    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      const spec = GLOBAL_FLAGS[name]

      if (spec) {
        if (spec.hasValue) {
          const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i]
          applyGlobal(globals, spec.key, value)
          if (spec.key !== 'home') {
            flags.set(name, value)
          }
        } else {
          applyGlobal(globals, spec.key, true)
        }
        i++
        continue
      }

      if (eq !== -1) {
        flags.set(name, arg.slice(eq + 1))
        i++
        continue
      }

      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        flags.set(name, next)
        i += 2
        continue
      }

      flags.set(name, true)
      i++
      continue
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const cluster = arg.slice(1)
      let handled = false
      for (const char of cluster) {
        const entry = Object.entries(GLOBAL_FLAGS).find(([, spec]) => spec.alias === char)
        if (!entry) continue
        handled = true
        const [name, spec] = entry
        if (spec.hasValue) {
          const value = argv[++i]
          applyGlobal(globals, spec.key, value)
          if (spec.key !== 'home') flags.set(name, value)
        } else {
          applyGlobal(globals, spec.key, true)
        }
      }
      if (handled) {
        i++
        continue
      }
    }

    positional.push(arg)
    i++
  }

  let command: string | null = null
  let subcommand: string | null = null
  let rest = positional

  if (positional.length > 0 && COMMANDS.has(positional[0])) {
    command = positional[0]
    subcommand = positional[1] ?? null
    rest = positional.slice(subcommand ? 2 : 1)
  }

  return {
    globals,
    command,
    subcommand,
    positional: rest,
    flags,
    raw: argv
  }
}

function applyGlobal(globals: CliGlobals, key: keyof CliGlobals | 'home', value: unknown): void {
  if (key === 'home') {
    globals.homeDir = String(value)
    return
  }
  if (key === 'mode') {
    const mode = String(value)
    if (mode === 'text' || mode === 'json') {
      globals.mode = mode
    }
    return
  }
  if (key === 'print' || key === 'continueSession' || key === 'version' || key === 'help') {
    globals[key] = Boolean(value)
    return
  }
  if (key === 'provider' || key === 'model' || key === 'apiKey' || key === 'sessionId') {
    globals[key] = String(value)
  }
}

export function flagString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' ? value : undefined
}

export function flagBool(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true || flags.get(name) === 'true'
}

export function readStdinIfPiped(): Promise<string> {
  return new Promise((resolve) => {
    if (isInteractiveStdin()) {
      resolve('')
      return
    }
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()))
  })
}

function isWindowsConsoleCharacterDevice(fd: number): boolean {
  if (process.platform !== 'win32') return false
  try {
    return fstatSync(fd).isCharacterDevice()
  } catch {
    return false
  }
}

/** Electron's Windows GUI/CUI host can inherit a console character handle without
 * libuv setting process.stdin.isTTY. It is still interactive, not a closed pipe. */
export function isInteractiveStdin(): boolean {
  if (process.stdin.isTTY) return true
  return isWindowsConsoleCharacterDevice(0)
}

/**
 * Mark stdio as TTY when Electron left isTTY unset on a real Windows console.
 * Without this, readline runs with terminal:false (no echo / broken prompt) even
 * though the user launched mousse-cli from cmd/PowerShell interactively.
 * Does not invent setRawMode; pi-tui is used only when libuv exposes raw mode.
 */
export function ensureWindowsConsoleTty(
  streams: {
    stdin: NodeJS.ReadStream
    stdout: NodeJS.WriteStream
    stderr: NodeJS.WriteStream
  } = process
): boolean {
  if (process.platform !== 'win32') return false
  let patched = false
  if (!streams.stdin.isTTY && isWindowsConsoleCharacterDevice(0)) {
    Object.defineProperty(streams.stdin, 'isTTY', { value: true, configurable: true })
    patched = true
  }
  if (!streams.stdout.isTTY && isWindowsConsoleCharacterDevice(1)) {
    Object.defineProperty(streams.stdout, 'isTTY', { value: true, configurable: true })
    patched = true
  }
  if (!streams.stderr.isTTY && isWindowsConsoleCharacterDevice(2)) {
    Object.defineProperty(streams.stderr, 'isTTY', { value: true, configurable: true })
    patched = true
  }
  if (patched && typeof streams.stdin.resume === 'function') {
    streams.stdin.resume()
  }
  return patched
}

export interface ShouldUseReadlineTerminalOptions {
  /** Override platform (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform
  /**
   * When true, the process is Electron main (not ELECTRON_RUN_AS_NODE).
   * Defaults to detecting `process.versions.electron`.
   */
  isElectronMain?: boolean
  /** Override env (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv
}

/**
 * Whether readline should opt into its own TTY/raw-mode editor.
 * Packaged Electron on Windows can report isTTY + setRawMode while still
 * swallowing echo once Node disables ENABLE_ECHO_INPUT. Stay in cooked mode
 * there so the console host echoes printable keys. Override with
 * MOUSSE_FORCE_READLINE_TERMINAL=1.
 */
export function shouldUseReadlineTerminal(
  interactive = isInteractiveStdin(),
  options: ShouldUseReadlineTerminalOptions = {}
): boolean {
  if (!interactive) return false
  const env = options.env ?? process.env
  if (env.MOUSSE_FORCE_READLINE_TERMINAL === '1') return true
  const platform = options.platform ?? process.platform
  const isElectronMain =
    options.isElectronMain ??
    (Boolean(process.versions.electron) && env.ELECTRON_RUN_AS_NODE !== '1')
  if (platform === 'win32' && isElectronMain) return false
  return true
}
