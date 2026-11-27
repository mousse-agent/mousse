import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The sealed launch of a single request's process (docs/plans/one-shots-every-provider.md §5): an environment built
 * from an allowlist, the entry's own variables and the preset's narrow inputs, with the reserved roots applied last so
 * nothing can point them elsewhere; the entry's arguments through the preset's allowlist; the prompt never on the
 * command line (it goes over stdin or the protocol).
 */

/** What a sealed process inherits from Mousse's environment: how to find programs, reach the network, and its locale. */
const INHERITED = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ'
])

/** The folders a process reads its config and keeps its files in: each points into the place, set last. */
export const RESERVED_ROOTS = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR'] as const

const RESERVED = new Set<string>(RESERVED_ROOTS.map((name) => name.toUpperCase()))

/** Where each reserved root points, inside the place's `root` folder. */
export function reservedRoots(root: string): Record<(typeof RESERVED_ROOTS)[number], string> {
  const home = join(root, 'home')
  const tmp = join(root, 'tmp')
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_RUNTIME_DIR: join(root, 'run'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TMP: tmp,
    TEMP: tmp,
    TMPDIR: tmp
  }
}

export interface SealedEnvInput {
  /** Mousse's environment, read through the allowlist only. */
  base: NodeJS.ProcessEnv
  /** The entry's own variables (the ones the user set on it). */
  entry?: Readonly<Record<string, string>>
  /** The preset's narrow inputs: named credential variables or files, never a whole folder. */
  preset?: Readonly<Record<string, string>>
  /** The place's folder for the reserved roots (`reservedRoots`), made here. */
  root: string
}

/**
 * The sealed environment, in this order: the allowlist, the entry's variables, the preset's inputs, then the reserved
 * roots, which nothing before them can override. Windows names are matched without case.
 */
export function sealedEnv(input: SealedEnvInput): NodeJS.ProcessEnv {
  const env: Record<string, string> = {}
  const put = (name: string, value: string) => {
    for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key]
    env[name] = value
  }
  for (const [name, value] of Object.entries(input.base)) if (value !== undefined && INHERITED.has(name.toUpperCase())) put(name, value)
  for (const layer of [input.entry, input.preset]) {
    for (const [name, value] of Object.entries(layer ?? {})) if (!RESERVED.has(name.toUpperCase())) put(name, value)
  }
  const roots = reservedRoots(input.root)
  for (const path of new Set(Object.values(roots))) mkdirSync(path, { recursive: true, mode: 0o700 })
  for (const [name, value] of Object.entries(roots)) put(name, value)
  return env
}

/** A preset's rule for the entry's arguments: the ones a sealed launch may pass on. */
export type ArgumentAllowlist = (args: readonly string[]) => string[]

/**
 * A generic ACP agent's arguments are its command: the user chose them to start it, and Mousse has no agent-specific
 * knowledge to narrow them. The route is best-effort for this reason too (`isolation: env_only`).
 */
export const GENERIC_ACP_ARGUMENTS: ArgumentAllowlist = (args) => [...args]

