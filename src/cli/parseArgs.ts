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
  'workspace', 'publish', 'undo', 'redo', 'fork', 'operation'
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
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()))
  })
}
