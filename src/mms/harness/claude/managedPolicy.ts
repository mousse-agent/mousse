import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { managedSettingsPaths } from '../../providers/claudeSubscription/accountSubject'
import { claudeManagedPolicyIn } from './locked'

/**
 * Whether an organisation's Claude Code policy applies to a locked entry (PR 6 §3), read fresh every
 * time: the SDK's own resolver keeps its first operating-system policy reading (registry, MDM) for
 * the life of the process that loaded it, and reports a read it could not make as no policy. So
 * each reading takes a new process for the resolver and reads the operating system's policy
 * sources itself, and anything it cannot read counts as a policy.
 */

/** One run of a command: its exit code (null when it could not start or was killed) and output. */
export interface PolicyCommandResult {
  code: number | null
  stdout: string
}

export type PolicyCommandRunner = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<PolicyCommandResult>

const defaultRunner: PolicyCommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, args, { env: options.env, timeout: options.timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0
      resolve({ code, stdout: String(stdout ?? '') })
    })
  })

/** The resolver, run in its own process: prints the sources of the policy tier as JSON. */
const RESOLVE_SCRIPT = [
  'import(require("node:url").pathToFileURL(process.argv[1]).href)',
  '.then((sdk) => sdk.resolveSettings({ cwd: process.argv[2], settingSources: [] }))',
  '.then((resolved) => process.stdout.write(JSON.stringify({ sources: resolved.sources.map((s) => ({ source: s.source, policyOrigin: s.policyOrigin })) })),',
  '(error) => { process.stderr.write(String(error)); process.exit(2) })'
].join('')

/** Where the pinned SDK's entry module is, for the resolver's own process. */
function sdkEntry(): string {
  const here = import.meta.url
  return createRequire(here).resolve('@anthropic-ai/claude-agent-sdk')
}

/** The macOS managed-preferences files (MDM) Claude Code reads. */
function darwinPolicyFiles(): string[] {
  let user: string | undefined
  try {
    user = userInfo().username
  } catch {
    user = undefined
  }
  return ['/Library/Managed Preferences/com.anthropic.claudecode.plist', ...(user ? [`/Library/Managed Preferences/${user}/com.anthropic.claudecode.plist`] : [])]
}

/** The largest server-managed cache Claude Code reads; a larger one is not read, so it counts. */
const REMOTE_SETTINGS_MAX_BYTES = 8 * 1024 * 1024

export interface RemoteSettingsFiles {
  size(path: string): number
  read(path: string): string
}

const realFiles: RemoteSettingsFiles = {
  size: (path) => statSync(path).size,
  read: (path) => readFileSync(path, 'utf8')
}

/**
 * Whether the entry's server-managed cache (`<home>/remote-settings.json`) holds a policy. Claude
 * Code writes the empty object `{}` there when the organisation has no server-managed settings
 * (its 404 sentinel), and drops `$`-prefixed keys (`$schema`) when it reads the file; so no file,
 * `{}`, or an object of `$`-prefixed keys only, is no policy. Any other key, a file that is not a
 * JSON object, one over Claude Code's size limit, or one that cannot be read, is a policy.
 */
export function remoteSettingsHoldPolicy(home: string, files: RemoteSettingsFiles = realFiles): boolean {
  const path = join(home, 'remote-settings.json')
  let text: string
  try {
    if (files.size(path) > REMOTE_SETTINGS_MAX_BYTES) return true
    text = files.read(path)
  } catch (error) {
    return (error as { code?: unknown }).code !== 'ENOENT'
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return true
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true
  return Object.keys(parsed).some((key) => !key.startsWith('$'))
}

/** Windows' own `reg.exe`, by its full path, as the SDK runs it (never one found on PATH). */
function regExe(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR ?? 'C:\\Windows'
  return `${root}\\System32\\reg.exe`
}

/** Whether `stdout` of `reg query <key>` lists the subkey `name` (a line ending in `\\<name>`). */
function listsSubkey(stdout: string, name: string): boolean {
  return new RegExp(`\\\\${name}\\s*$`, 'im').test(stdout)
}

export interface ManagedPolicyReadInput {
  /** The entry's own home (`CLAUDE_CONFIG_DIR`): its server-managed cache is read there. */
  home?: string
  /** A folder of Mousse's own to resolve in (no project settings are read). */
  cwd: string
  platform?: NodeJS.Platform
  run?: PolicyCommandRunner
  exists?: (path: string) => boolean
  /** How the entry's server-managed cache is read (default: from disk). */
  files?: RemoteSettingsFiles
  /** The SDK's entry module (default: the pinned one). */
  sdk?: () => string
  /** The environment of the resolver's process (default: Mousse's own). */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/**
 * Reads the policy now. True when any source holds a policy or could not be read:
 * - the entry's server-managed cache (`remoteSettingsHoldPolicy`: Claude Code's empty sentinel is none);
 * - `managed-settings.json` and its `managed-settings.d` drop-ins, by their presence;
 * - macOS MDM (the managed-preferences plists) and the Windows HKLM and HKCU `Policies\ClaudeCode`
 *   keys, read directly. A `Policies` key is absent only when its parent's listing, which always
 *   works, does not name it; any listing that fails counts as a policy;
 * - the SDK's resolver in a new process, for every other source it knows.
 */
export async function readClaudeManagedPolicy(input: ManagedPolicyReadInput): Promise<boolean> {
  const platform = input.platform ?? process.platform
  const exists = input.exists ?? existsSync
  const run = input.run ?? defaultRunner
  const timeoutMs = input.timeoutMs ?? 15_000
  if (input.home && remoteSettingsHoldPolicy(input.home, input.files)) return true
  for (const file of managedSettingsPaths(platform)) if (exists(file) || exists(join(dirname(file), 'managed-settings.d'))) return true
  if (platform === 'darwin' && darwinPolicyFiles().some((file) => exists(file))) return true
  if (platform === 'win32') {
    const env = input.env ?? process.env
    const reg = regExe(env)
    for (const hive of ['HKLM', 'HKCU']) {
      // `reg` exits 1 both for a missing key and for one it may not read, so a missing `Policies`
      // key is told apart by listing `SOFTWARE`, which every profile has and anyone may list.
      const parent = await run(reg, ['query', `${hive}\\SOFTWARE`], { env, timeoutMs })
      if (parent.code !== 0) return true
      if (!listsSubkey(parent.stdout, 'Policies')) continue
      const listed = await run(reg, ['query', `${hive}\\SOFTWARE\\Policies`], { env, timeoutMs })
      if (listed.code !== 0) return true
      if (listsSubkey(listed.stdout, 'ClaudeCode')) return true
    }
  }
  let sdk: string
  try {
    sdk = (input.sdk ?? sdkEntry)()
  } catch {
    return true
  }
  const resolved = await run(process.execPath, ['-e', RESOLVE_SCRIPT, sdk, input.cwd], {
    env: { ...(input.env ?? process.env), ...(input.home ? { CLAUDE_CONFIG_DIR: input.home } : {}), ELECTRON_RUN_AS_NODE: '1' },
    timeoutMs
  })
  if (resolved.code !== 0) return true
  try {
    const parsed = JSON.parse(resolved.stdout) as { sources?: unknown }
    if (!Array.isArray(parsed.sources)) return true
    return claudeManagedPolicyIn(parsed as { sources: Array<{ source: string }> })
  } catch {
    return true
  }
}
