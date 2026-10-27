import type { BinarySource, InstallOwner, InstanceSnapshot } from '../../../shared/harness/status'
import type {
  HarnessDriverKind,
  ProviderScope,
  RegistryAgentView,
  RegistryChecksum,
  RegistrySourcePatch,
  RemoveInstallResult
} from '../../../shared/harness/types'

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
  /**
   * Runs on what ships with Mousse (Cursor's SDK): there is no executable to find, and no
   * arguments or variables to set. Its sign-in is a key Mousse keeps.
   */
  bundled?: boolean
  /** Also added from the ACP registry: the Add dialog offers it as its own choice ("More ACP agents…"). */
  registry?: { addLabel: string; description: string }
  /**
   * Added as Mousse-managed (its own download and sign-in, `setup: managed`) or on the user's own
   * CLI (`setup: existing`); the Add dialog asks which (Codex).
   */
  setups?: boolean
}

/** Where ChatGPT shows a plan's usage; Mousse links to it and never reads it. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

/** The entry runs Mousse's own Codex download with Sign in with ChatGPT. */
export function isManagedSetup(snapshot: InstanceSnapshot): boolean {
  return snapshot.config?.setup === 'managed'
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
    label: 'ChatGPT subscription',
    iconId: 'openai',
    family: 'agent',
    description: 'Use your ChatGPT plan through Codex.',
    // Further entries are Mousse-managed, each with its own ChatGPT sign-in.
    multiInstance: true,
    customModels: true,
    homeHint: '~/.codex',
    setups: true
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
    customModels: false,
    bundled: true
  },
  grok: {
    label: 'Grok',
    iconId: 'xai',
    family: 'agent',
    description: "xAI's Grok CLI, signed in with your Grok account or an xAI API key. Grok asks Mousse before it runs a tool.",
    multiInstance: true,
    customModels: false,
    homeHint: '~/.grok'
  },
  acp: {
    label: 'ACP agent',
    iconId: 'acp',
    family: 'agent',
    description: 'Any agent that speaks the Agent Client Protocol, started from a command you enter.',
    multiInstance: true,
    customModels: false,
    customCommand: true,
    addLabel: 'Custom command',
    registry: { addLabel: 'More ACP agents…', description: 'Agents listed in the ACP registry. Mousse downloads and installs them.' }
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

const ANTIGRAVITY_TAG_PREFIX = 'agy_acp_server_'

/**
 * Antigravity versions are release tags, `agy_acp_server_<yyyymmdd>_<build>` with an optional
 * `_<candidate>`. Shown as the date and the candidate: `agy_acp_server_20260818_01_RC01` →
 * "2026-08-18 RC01". Anything else is not such a tag.
 */
function antigravityRelease(tag: string): string | undefined {
  if (!tag.startsWith(ANTIGRAVITY_TAG_PREFIX)) return undefined
  const [date = '', build = '', ...rest] = tag.slice(ANTIGRAVITY_TAG_PREFIX.length).split('_')
  if (!/^\d{8}$/.test(date) || !/^\d+$/.test(build)) return undefined
  const candidate = rest.join('_')
  if (rest.length > 0 && !/^\w+$/.test(candidate)) return undefined
  const day = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`
  return candidate ? `${day} ${candidate}` : day
}

/** A version for display: numeric versions get a "v", Antigravity's release tags become a date. */
export function formatVersion(version: string | undefined): string | undefined {
  const text = version?.trim()
  if (!text) return undefined
  const release = antigravityRelease(text)
  if (release) return release
  return text[0]! >= '0' && text[0]! <= '9' ? `v${text}` : text
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
  homePath?: string
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
    ...(typeof raw.homePath === 'string' && raw.homePath ? { homePath: raw.homePath } : {}),
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

/** The switch: the device setting is a ceiling, and a project can only narrow it. */
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

/** What a provider row says about its model list: when it was updated, or that it is a cached list. */
export type ModelsFreshness = { kind: 'updated'; at: number } | { kind: 'cached' }

/**
 * Nothing for a provider that is off or not signed in, or lists no models: its list is not in
 * question. A list with no known update time is the cached one (the built-in aliases or the last
 * list the agent gave), unless a refresh found it live.
 */
export function modelsFreshness(snapshot: InstanceSnapshot): ModelsFreshness | null {
  if (!snapshot.enabled.device) return null
  if (snapshot.auth.state !== 'signed_in' && snapshot.auth.state !== 'not_required') return null
  if (!snapshot.models.entries.length) return null
  const at = snapshot.models.refreshedAt ? Date.parse(snapshot.models.refreshedAt) : NaN
  if (Number.isFinite(at)) return { kind: 'updated', at }
  return snapshot.models.source === 'cached' ? { kind: 'cached' } : null
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

/* ACP registry agents ("More ACP agents…"). */

export const CHECKSUM_LABELS: Record<RegistryChecksum, string> = {
  registry: 'Registry checksum checked',
  none: 'No registry checksum'
}

export function checksumLabel(checksum: RegistryChecksum): string {
  return CHECKSUM_LABELS[checksum]
}

/** Said wherever Mousse installs a download the registry gives no checksum for. */
export const UNVERIFIED_NOTE = "Mousse cannot verify this download. It records the files' fingerprints and refuses to run them if they change."

const DISTRIBUTION_LABELS: Record<RegistryAgentView['distribution'], string> = {
  binary: 'Binary download',
  npx: 'npm package',
  uvx: 'Python (uvx)'
}

export function distributionLabel(distribution: RegistryAgentView['distribution']): string {
  return DISTRIBUTION_LABELS[distribution]
}

/** Whether installing this agent needs the user's explicit yes (a download without a checksum). */
export function needsConsent(agent: Pick<RegistryAgentView, 'distribution' | 'checksum'>): boolean {
  return agent.distribution === 'binary' && agent.checksum === 'none'
}

/**
 * The `source` that adds or updates an entry to this registry agent; undefined when Mousse cannot
 * install it here. An unverified download carries the consent for exactly this version and URL.
 */
export function registrySourceOf(agent: RegistryAgentView): RegistrySourcePatch | undefined {
  if (agent.unsupported || agent.distribution === 'uvx') return undefined
  return {
    kind: 'registry',
    agentId: agent.id,
    version: agent.version,
    distribution: agent.distribution,
    ...(needsConsent(agent) && agent.artifactUrl ? { consent: { version: agent.version, artifactUrl: agent.artifactUrl } } : {})
  }
}

/** The row's second line: licence, how it is fetched, and the checksum label. */
export function registryAgentMeta(agent: RegistryAgentView): string {
  return [agent.license, distributionLabel(agent.distribution), checksumLabel(agent.checksum)].filter(Boolean).join(' · ')
}

/** "ACP registry · gemini v1.2.0": where a registry entry comes from. */
export function registrySourceLabel(source: { agentId: string; version: string }): string {
  return `ACP registry · ${source.agentId} ${formatVersion(source.version) ?? source.version}`
}

/**
 * The registry's listing of an installed agent when it offers another version Mousse can install;
 * undefined when it is the same, missing or cannot be installed here. Matches the id exactly.
 */
export function registryUpdateOf(
  installed: { agentId: string; version: string },
  agents: readonly RegistryAgentView[]
): RegistryAgentView | undefined {
  const listed = agents.find((agent) => agent.id === installed.agentId)
  if (!listed || listed.version === installed.version || !registrySourceOf(listed)) return undefined
  return listed
}

/** Megabytes as the downloads indicator shows them: no decimals, at least 1. */
export function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`
}

/** "Work (2 entries)": a profile whose entries still use the downloaded files. */
export function usedByLabel(entry: Extract<RemoveInstallResult, { removed: false }>['usedBy'][number]): string {
  return `${entry.profileName ?? entry.profileId} (${entry.entries} ${entry.entries === 1 ? 'entry' : 'entries'})`
}
