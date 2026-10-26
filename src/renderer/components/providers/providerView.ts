import type { BinarySource, InstallOwner, InstanceSnapshot } from '../../../shared/harness/status'
import type { HarnessDriverKind, ProviderScope } from '../../../shared/harness/types'

/**
 * What the providers page shows for a snapshot, as plain functions (no React), so the wording and
 * the scope rules are testable. Status copy itself comes only from `describeStatus`.
 */

/** How the page presents each kind of runtime. A data table: nothing here branches on a driver. */
export interface DriverInfo {
  label: string
  /** Logo id for `ProviderIcon`. */
  iconId: string
  /** `agent`: an agent CLI Mousse runs; `api`: a model API the Mousse agent calls. */
  family: 'agent' | 'api'
  /** One line in the Add dialog. */
  description: string
  /** More than one instance makes sense (a second account with its own home). */
  multiInstance: boolean
  /** Models can be added by id (Antigravity serves a fixed list). */
  customModels: boolean
  /** The vendor home a default instance shares with the user's terminal. */
  homeHint?: string
  /**
   * Added from a command the user enters (program, arguments, variables) rather than found on
   * this computer; the Add dialog names it with `addLabel` and never as "another account".
   */
  customCommand?: boolean
  addLabel?: string
}

export const DRIVER_INFO: Record<HarnessDriverKind, DriverInfo> = {
  claude: {
    label: 'Claude Code',
    iconId: 'claude',
    family: 'agent',
    description: "Anthropic's Claude Code, signed in through its own sign-in.",
    multiInstance: true,
    customModels: true,
    homeHint: '~/.claude'
  },
  codex: {
    label: 'Codex',
    iconId: 'openai',
    family: 'agent',
    description: "OpenAI's Codex CLI, signed in through your terminal (codex login).",
    multiInstance: false,
    customModels: true,
    homeHint: '~/.codex'
  },
  antigravity: {
    label: 'Antigravity',
    iconId: 'google',
    family: 'agent',
    description: "Google's official Antigravity agent, with its own Google sign-in.",
    multiInstance: false,
    customModels: false
  },
  cursor: {
    label: 'Cursor',
    iconId: 'cursor',
    family: 'agent',
    description: "Cursor's agent, signed in with your Cursor account or an API key. Cursor approves its tools itself.",
    multiInstance: true,
    customModels: false
  },
  acp: {
    label: 'ACP agent',
    iconId: 'acp',
    family: 'agent',
    description: 'Any agent that speaks the Agent Client Protocol, started from a command you enter.',
    multiInstance: true,
    customModels: false,
    customCommand: true,
    addLabel: 'Custom command'
  },
  pi: {
    label: 'Model API',
    iconId: 'pi',
    family: 'api',
    description: 'A model API the Mousse agent calls directly.',
    multiInstance: false,
    customModels: true
  }
}

export function isApiInstance(snapshot: Pick<InstanceSnapshot, 'driver'>): boolean {
  return DRIVER_INFO[snapshot.driver].family === 'api'
}

/** Logo for an instance: API instances by provider (`pi:openai` → OpenAI), agents by driver. */
export function iconIdOf(snapshot: Pick<InstanceSnapshot, 'driver' | 'instanceId'>): string {
  return isApiInstance(snapshot) ? snapshot.instanceId : DRIVER_INFO[snapshot.driver].iconId
}

/** Version label as T3 Code shows it; Antigravity's release tag becomes a date. */
export function formatVersion(version: string | undefined): string | undefined {
  const trimmed = version?.trim()
  if (!trimmed) return undefined
  const antigravity = /^agy_acp_server_(\d{4})(\d{2})(\d{2})_\d+(?:_(\w+))?$/.exec(trimmed)
  if (antigravity) {
    const [, year, month, day, candidate] = antigravity
    return `${year}-${month}-${day}${candidate ? ` ${candidate}` : ''}`
  }
  return /^\d/.test(trimmed) ? `v${trimmed}` : trimmed
}

const SOURCE_LABELS: Record<BinarySource, string> = {
  path: 'Found on PATH',
  managed: 'Installed by Mousse',
  override: 'Custom path',
  bundled: 'Bundled with Mousse'
}

const OWNER_LABELS: Partial<Record<InstallOwner, string>> = {
  npm: 'npm',
  pnpm: 'pnpm',
  bun: 'Bun',
  brew: 'Homebrew',
  winget: 'winget',
  standalone: 'its own installer'
}

/** "Found on PATH · installed with npm": where the executable came from. */
export function binarySourceLabel(binary: NonNullable<InstanceSnapshot['binary']>): string {
  const owner = binary.owner ? OWNER_LABELS[binary.owner] : undefined
  return owner ? `${SOURCE_LABELS[binary.source]} · installed with ${owner}` : SOURCE_LABELS[binary.source]
}

/**
 * The instance's editable settings. The snapshot carries them as `config` once the daemon reports
 * it; until then only an executable override can be read (from `binary`).
 */
export interface InstanceConfigView {
  displayName?: string
  home: 'default' | 'private'
  binaryPath?: string
  args: string[]
  env: Record<string, string>
  movedTo?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function instanceConfigOf(snapshot: InstanceSnapshot): InstanceConfigView | undefined {
  const raw = (snapshot as InstanceSnapshot & { config?: unknown }).config
  if (!isRecord(raw)) return undefined
  const env = isRecord(raw.env)
    ? Object.fromEntries(Object.entries(raw.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
  return {
    ...(typeof raw.displayName === 'string' ? { displayName: raw.displayName } : {}),
    home: raw.home === 'private' ? 'private' : 'default',
    ...(typeof raw.binaryPath === 'string' && raw.binaryPath ? { binaryPath: raw.binaryPath } : {}),
    args: Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string') : [],
    env,
    ...(typeof raw.movedTo === 'string' && raw.movedTo ? { movedTo: raw.movedTo } : {})
  }
}

/** The executable override: from the config when reported, else from an override binary. */
export function binaryOverrideOf(snapshot: InstanceSnapshot): string | undefined {
  const config = instanceConfigOf(snapshot)
  if (config) return config.binaryPath
  return snapshot.binary?.source === 'override' ? snapshot.binary.path : undefined
}

/** The switch, in T3 Code's layering: device is a ceiling, a project only narrows it. */
export interface SwitchState {
  checked: boolean
  /** The device has it off, so a project cannot turn it on. */
  locked: boolean
  /** The project sets its own value ("Overridden for this project"). */
  overridden: boolean
  deviceEnabled: boolean
}

export function switchStateOf(snapshot: Pick<InstanceSnapshot, 'enabled'>, scope: ProviderScope): SwitchState {
  const { enabled } = snapshot
  if (scope.kind === 'device') return { checked: enabled.device, locked: false, overridden: false, deviceEnabled: enabled.device }
  return {
    checked: enabled.effective,
    locked: !enabled.device,
    overridden: enabled.project !== undefined,
    deviceEnabled: enabled.device
  }
}

/** Newest `checkedAt` of the snapshots (ms), for "Checked 2 min ago". */
export function lastCheckedAt(snapshots: readonly InstanceSnapshot[]): number | null {
  let latest: number | null = null
  for (const snapshot of snapshots) {
    const at = snapshot.checkedAt ? Date.parse(snapshot.checkedAt) : NaN
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at
  }
  return latest
}

/** A label for a new instance that no other instance uses ("Claude Code 2"). */
export function nextInstanceLabel(base: string, snapshots: readonly InstanceSnapshot[]): string {
  const taken = new Set(snapshots.map((snapshot) => snapshot.displayName.trim().toLowerCase()))
  for (let n = 2; ; n += 1) {
    const label = `${base} ${n}`
    if (!taken.has(label.toLowerCase())) return label
  }
}

/** `NAME=value` lines; blank lines and lines without a name are skipped. */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=')
    const name = (index === -1 ? line : line.slice(0, index)).trim()
    if (!name) continue
    env[name] = index === -1 ? '' : line.slice(index + 1)
  }
  return env
}

/** A name for an agent added from a command: the program's file name without its extension. */
export function commandLabel(command: string): string {
  const base = command.trim().split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(exe|cmd|bat)$/i, '')
}

/** Space-separated, with quotes for arguments that contain spaces. */
export function formatArgs(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg && !/[\s"']/.test(arg)) return arg
      return arg.includes('"') ? `'${arg}'` : `"${arg}"`
    })
    .join(' ')
}

export function parseArgs(text: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    args.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return args
}
