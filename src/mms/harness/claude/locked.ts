import { execFile, spawn as nodeSpawn } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import type { Options, SandboxSettings, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { ToolCall } from '@earendil-works/pi-ai'
import type { BotAuthority } from '../../../shared/bots/personal/authority'
import { botAppToolRefusal, checkBuiltinCall, wallMessage } from '../../../shared/bots/personal/walls'
import { runtimeExpandedPath } from '../../bots/authority/botAuthority'
import { neutralToolIdempotent, neutralToolsOf, type NativeToolTable, type NeutralTool } from '../../../shared/harness/tools'
import type { HarnessCaps } from '../../../shared/harness/types'
import { withoutTransportFields } from '../../agentDefinitions/definitionGate'
import { CLAUDE_MOUSSE_TOOL_PREFIX } from '../../run/mcp/attachment'
import type { ToolLedger } from '../../run/mcp/appTools/types'
import { hasContainmentEvidence, type ContainmentEvidence } from '../compatibility'

/**
 * The locked Claude Code profile (PR 6 §3): how a bot's turn runs on Claude Code. An instance with
 * `config.profile: 'locked'` runs in a home of its own and only bot turns; every interactive
 * instance keeps the user's own setup, untouched.
 *
 * A locked turn loads no settings, plugins or MCP servers but Mousse's own, runs in the activation's
 * private scratch folder, offers exactly the granted built-ins (`tools`) and turns every other one
 * off (`disallowedTools`). Mousse's `PreToolUse` hook is the grant gate: it holds each call to the
 * bot's authority and never allows a call itself, so `canUseTool` checks it again, by default
 * denying, and writes the run's ledger row before a granted built-in runs. Nobody is asked.
 */

/** The instance profile that runs bots. */
export const CLAUDE_LOCKED_PROFILE = 'locked'

/** One `query` is one dispatch: a backstop on its model turns, not a policy claim. */
export const CLAUDE_LOCKED_MAX_TURNS = 100

/**
 * Claude Code's built-in tools: the pinned SDK's `ToolInputSchemas` by tool name (the `File` prefix
 * dropped, the MCP resource tools by their `…Tool` names), plus names older or newer CLIs use for
 * the same tools. A locked turn turns off every one it was not granted, as a second layer behind
 * `tools`. `claudeLocked` diffs this against the pinned SDK on every bump.
 */
export const CLAUDE_BUILTIN_TOOLS: readonly string[] = Object.freeze([
  'Agent', 'Artifact', 'AskUserQuestion', 'Bash', 'BashOutput', 'ClaudeDesign', 'Config', 'CronCreate', 'CronDelete', 'CronList',
  'Edit', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep', 'KillShell', 'ListMcpResourcesTool', 'LSP',
  'Monitor', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'OfferChromeSetup', 'Projects', 'ProposeGoal', 'ProposeSkills', 'PushNotification', 'Read',
  'ReadMcpResourceDir', 'ReadMcpResourceTool', 'ReadNotifications', 'RefreshMcpTools', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup', 'SendFeedback', 'ShowOnboardingRolePicker', 'Skill',
  'SlashCommand', 'Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskUpdate', 'TodoWrite', 'ToolSearch', 'WebFetch',
  'WebSearch', 'Workflow', 'Write'
])

/** Variables that hold Claude Code's credential: never visible to a sandboxed command. */
export const CLAUDE_KEY_VARIABLES: readonly string[] = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])

/** Whether Claude Code's sandbox can run here: Seatbelt on macOS, bubblewrap and socat on Linux; no evidence on Windows. */
export type ClaudeSandboxFact = 'available' | 'missing' | 'unsupported'

export function claudeSandboxFact(platform: NodeJS.Platform, onPath: (name: string) => boolean): ClaudeSandboxFact {
  if (platform === 'darwin') return 'available'
  if (platform === 'linux') return onPath('bwrap') && onPath('socat') ? 'available' : 'missing'
  return 'unsupported'
}

/**
 * The caps of a locked instance. Tool control is `exact` and containment `strong` only with the
 * evidence of this CLI version on this platform, and never under an organisation's managed
 * Claude Code policy, which Mousse cannot see past. Model requests inside the CLI cannot be refused
 * in advance, so no count or spend limit is offered. There is no `Agent` tool, so a child's policy holds.
 */
export function claudeLockedCaps(base: HarnessCaps, input: { platform: NodeJS.Platform; cliVersion?: string; managedPolicy: boolean; evidence?: readonly ContainmentEvidence[] }): HarnessCaps {
  const proven = (kind: 'tools' | 'sandbox') => !input.managedPolicy && input.cliVersion !== undefined &&
    hasContainmentEvidence({ driver: 'claude', kind, platform: input.platform, cliVersion: input.cliVersion }, input.evidence)
  return Object.freeze({
    ...base,
    planMode: false,
    toolControl: proven('tools') ? 'exact' : 'approval_only',
    containment: proven('tools') && proven('sandbox') ? 'strong' : 'weak',
    childPolicy: 'enforced',
    budgets: 'unsupported',
    spendLimits: 'unsupported'
  })
}

/**
 * Whether a locked instance holds a bot to its grant on this platform: once the gate and ledger
 * (`tools`, items 1–7) have evidence here, and no managed Claude Code policy applies. The sandbox's
 * evidence is needed only for shell (`shellContained`, per turn); the version is checked by the caps
 * (`claudeLockedCaps`) and again when a turn starts.
 */
export function claudeLockedHoldsBots(platform: NodeJS.Platform, managedPolicy: boolean, evidence?: readonly ContainmentEvidence[]): boolean {
  return !managedPolicy && hasContainmentEvidence({ driver: 'claude', kind: 'tools', platform }, evidence)
}

/** What `resolveSettings` reports: whether any managed (policy) tier is present, whatever its origin. */
export function claudeManagedPolicyIn(resolved: { sources: ReadonlyArray<{ source: string }> }): boolean {
  return resolved.sources.some((source) => source.source === 'managed')
}

/** Why a locked entry refuses a bot under an organisation's policy. */
export const CLAUDE_MANAGED_POLICY_REFUSAL = 'Your organisation\'s Claude Code policy applies; Mousse can\'t guarantee this bot\'s tool list.'

/**
 * Claude Code's built-ins for each neutral tool (PR 6 §2). Every name exists in the pinned SDK's
 * `ToolInputSchemas` (`toolNames` test); the other built-ins have no neutral name and are never
 * granted.
 */
export const CLAUDE_NATIVE_TOOLS: NativeToolTable = Object.freeze({
  read: ['Read'],
  list: ['Glob'],
  search: ['Glob', 'Grep'],
  edit: ['Edit'],
  write: ['Write'],
  shell: ['Bash'],
  web_fetch: ['WebFetch'],
  web_search: ['WebSearch']
})

/** What a locked turn runs with, from the turn's bot authority and the runtime's facts. */
export interface ClaudeLockedTurn {
  authority: BotAuthority
  /** The run's tool ledger; without it no built-in runs. */
  ledger?: ToolLedger
  /** The activation's private scratch folder: the turn's working directory. */
  cwd: string
  /** A `shell` grant may run: the sandbox is available and has evidence for this CLI and platform. */
  shellContained: boolean
  /** The system temporary folders (`systemTempDirs`), closed to sandboxed writes. */
  temps: readonly string[]
  /** The bot's instructions, which replace Claude Code's own system prompt. */
  systemPrompt: string
  /** Each Claude Code process of the turn, as it starts (its active-time supervision). */
  onProcess?(pid: number): void
  /**
   * True once an organisation policy is there that the turn's admission did not see (a
   * server-managed policy the CLI fetched at its own start): every call is then denied.
   */
  policyAppeared?(): boolean
}

/** The built-ins a locked turn offers, and every other built-in, turned off. */
export function claudeLockedTools(turn: Pick<ClaudeLockedTurn, 'authority' | 'shellContained'>, mousseTools: boolean): { tools: string[]; disallowedTools: string[] } {
  const offered = new Set<string>()
  for (const tool of turn.authority.tools) {
    // Shell runs only in a proven sandbox; without one it is never offered.
    if (tool === 'shell' && !turn.shellContained) continue
    for (const name of CLAUDE_NATIVE_TOOLS[tool] ?? []) offered.add(name)
  }
  // ToolSearch only loads the Mousse tools' schemas; each call is still gated.
  if (mousseTools) offered.add('ToolSearch')
  const tools = [...offered].sort()
  return { tools, disallowedTools: CLAUDE_BUILTIN_TOOLS.filter((name) => !offered.has(name)) }
}

/**
 * The sandbox of a `shell` grant. `allowWrite` only adds to what the sandbox already allows (the
 * working directory and temporary storage), so the system temporary folders and, for a read-only
 * grant, the roots are denied explicitly; the working directory is the scratch folder. The home
 * folder is unreadable but for the roots and scratch, the network is closed, and the instance's
 * key is unset for every command.
 */
export function claudeLockedSandbox(input: { workspace: NonNullable<BotAuthority['workspace']>; temps: readonly string[]; home?: string }): SandboxSettings {
  const { roots, access, scratch } = input.workspace
  // Per folder (6c-2): only the folders granted for writing are writable; every other root is denied.
  const writeRoots = input.workspace.writeRoots ?? (access === 'write' ? roots : [])
  const readRoots = roots.filter((root) => !writeRoots.includes(root))
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: false,
    excludedCommands: [],
    enableWeakerNestedSandbox: false,
    filesystem: {
      allowWrite: [...writeRoots, scratch],
      denyWrite: [...readRoots, ...input.temps],
      denyRead: [input.home ?? homedir()],
      allowRead: [...roots, scratch]
    },
    network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false },
    credentials: { envVars: CLAUDE_KEY_VARIABLES.map((name) => ({ name, mode: 'deny' as const })) }
  } as SandboxSettings
}

/**
 * The launch options of a locked turn, over the service's own: nothing the user configured for
 * Claude Code (settings files, plugins, launch arguments, MCP servers) reaches it, and no
 * permission rule or extra directory widens what the sandbox may write.
 */
export function claudeLockedOptions(turn: ClaudeLockedTurn, input: {
  env: NodeJS.ProcessEnv
  mcpServers: NonNullable<Options['mcpServers']>
  mousseTools: boolean
  spawn?: Options['spawnClaudeCodeProcess']
  home?: string
}): Partial<Options> {
  const { tools, disallowedTools } = claudeLockedTools(turn, input.mousseTools)
  const shell = tools.includes('Bash') && turn.authority.workspace
  return {
    cwd: turn.cwd,
    env: input.env,
    settingSources: [],
    strictMcpConfig: true,
    plugins: [],
    extraArgs: {},
    mcpServers: input.mcpServers,
    tools,
    disallowedTools,
    permissionMode: 'default',
    systemPrompt: turn.systemPrompt,
    maxTurns: CLAUDE_LOCKED_MAX_TURNS,
    ...(shell ? { sandbox: claudeLockedSandbox({ workspace: turn.authority.workspace!, temps: turn.temps, ...(input.home ? { home: input.home } : {}) }) } : {}),
    ...(input.spawn ? { spawnClaudeCodeProcess: input.spawn } : {})
  }
}

/** Options a locked turn never carries, whatever the service's defaults: each would widen it. */
export const CLAUDE_LOCKED_REMOVED_OPTIONS = ['allowDangerouslySkipPermissions', 'additionalDirectories', 'allowedTools', 'resume'] as const

type Decision = { ok: true } | { ok: false; reason: string }

/** A call as the gate classifies it by name. */
type Classified =
  | { kind: 'builtin'; neutral: NeutralTool[] }
  | { kind: 'app'; tool: string }
  | { kind: 'tool_search' }
  | { kind: 'unknown' }

/**
 * Path-like arguments of Claude's search tools that the authority's path check does not read: an
 * absolute or drive pattern, one the runtime expands (`~`, a variable), or any `..` (braces such
 * as `{..,x}` included) is refused.
 */
function patternEscapes(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return isAbsolute(value) || /^[A-Za-z]:/.test(value) || runtimeExpandedPath(value) || value.includes('..')
}

/** What the model is told when the gate itself fails: the call does not run. */
const GATE_FAILED = 'This call could not be checked against the bot\'s permissions, so it does not run.'

/**
 * The grant gate of one locked turn: `PreToolUse` and `canUseTool` decide every call with it, and
 * the post-tool hooks settle the ledger rows it wrote. Built-ins are held to the bot's authority
 * (tools, roots, scratch) and counted on the activation; Mousse's own tools are held here and again
 * by the Mousse MCP registry, which also writes their ledger rows and counts them. Anything else is
 * denied.
 */
export class ClaudeLockedGate {
  /** Ledger rows of allowed calls, by `tool_use_id`. */
  private readonly rows = new Map<string, string>()

  constructor(
    private readonly turn: ClaudeLockedTurn,
    /** The Mousse MCP server is attached to the turn. */
    private readonly mcp: boolean
  ) {}

  private classify(toolName: string): Classified {
    if (this.mcp && toolName.startsWith(CLAUDE_MOUSSE_TOOL_PREFIX)) return { kind: 'app', tool: toolName.slice(CLAUDE_MOUSSE_TOOL_PREFIX.length) }
    if (this.mcp && toolName === 'ToolSearch') return { kind: 'tool_search' }
    const neutral = neutralToolsOf(CLAUDE_NATIVE_TOOLS, toolName)
    return neutral.length ? { kind: 'builtin', neutral } : { kind: 'unknown' }
  }

  /** The authority's own decision on a call, with no side effect. */
  private decide(toolName: string, args: Record<string, unknown>): Decision & { classified?: Classified } {
    if (this.turn.policyAppeared?.()) return { ok: false, reason: CLAUDE_MANAGED_POLICY_REFUSAL }
    const authority = this.turn.authority
    const classified = this.classify(toolName)
    switch (classified.kind) {
      case 'unknown':
        return { ok: false, reason: wallMessage({ kind: 'tool', tool: toolName }) }
      case 'app': {
        const refusal = botAppToolRefusal(authority, classified.tool, withoutTransportFields(args))
        return refusal ? { ok: false, reason: refusal } : { ok: true, classified }
      }
      case 'tool_search': {
        // It only loads tool schemas, but nothing runs once the activation waits or ended.
        if (authority.time.signal.aborted) return { ok: false, reason: wallMessage({ kind: 'ended' }) }
        if (authority.waiting()) return { ok: false, reason: wallMessage({ kind: 'waiting' }) }
        return { ok: true, classified }
      }
      case 'builtin': {
        if (classified.neutral.includes('shell')) {
          if (!this.turn.shellContained) return { ok: false, reason: wallMessage({ kind: 'policy_unenforceable', tool: toolName, missing: ['containment'] }) }
          if (args.dangerouslyDisableSandbox === true) return { ok: false, reason: 'Commands always run in the sandbox here. Run it again without dangerouslyDisableSandbox.' }
        }
        // Glob's pattern and Grep's glob name files too: one that leaves the folder it searches is refused.
        if (patternEscapes(toolName === 'Glob' ? args.pattern : toolName === 'Grep' ? args.glob : undefined))
          return { ok: false, reason: `This bot searches only inside its folders: give ${toolName} a relative pattern and a path.` }
        const decided = checkBuiltinCall(authority, CLAUDE_NATIVE_TOOLS, toolName, args)
        return decided.ok ? { ok: true, classified } : { ok: false, reason: wallMessage(decided.wall) }
      }
    }
  }

  /**
   * `PreToolUse`: deny with a reason, or let the call go on to `canUseTool` (`ask`); never allow.
   * A built-in that passes is counted on the activation's tool counter. Locked Claude offers no
   * count limit, so the count never refuses here.
   */
  preToolUse(toolName: string, args: Record<string, unknown>): Decision {
    // Fails closed: a check or count that throws (a busy bots.db) denies the call.
    try {
      const decided = this.decide(toolName, args)
      if (!decided.ok) return decided
      if (decided.classified?.kind === 'builtin') this.turn.authority.counters.charge('tool')
      return { ok: true }
    } catch (error) {
      console.warn('[claude-locked] the grant gate failed; the call is denied', error instanceof Error ? error.message : String(error))
      return { ok: false, reason: GATE_FAILED }
    }
  }

  /**
   * `canUseTool`: the second, default-deny check. A built-in (or ToolSearch) is allowed only once
   * its `started` row is in the run's ledger, written with its neutral class's idempotency (reads
   * are idempotent; `edit`, `write` and `shell` are not). A Mousse tool's row is the registry's.
   */
  canUse(toolName: string, args: Record<string, unknown>, toolUseId: string): Decision {
    try {
      return this.allow(toolName, args, toolUseId)
    } catch (error) {
      console.warn('[claude-locked] the grant gate failed; the call is denied', error instanceof Error ? error.message : String(error))
      return { ok: false, reason: GATE_FAILED }
    }
  }

  private allow(toolName: string, args: Record<string, unknown>, toolUseId: string): Decision {
    const decided = this.decide(toolName, args)
    if (!decided.ok) return decided
    const classified = decided.classified!
    if (classified.kind === 'app') return { ok: true }
    const idempotent = classified.kind === 'tool_search' || (classified.kind === 'builtin' && classified.neutral.every(neutralToolIdempotent))
    const row = this.turn.ledger?.start({ type: 'toolCall', id: toolUseId, name: toolName, arguments: args } as ToolCall, { idempotent })
    if (!row) return { ok: false, reason: 'This call could not be recorded, so it does not run.' }
    this.rows.set(toolUseId, row)
    return { ok: true }
  }

  /** `PostToolUse`: the call's row is committed. */
  committed(toolUseId: string): void {
    const row = this.rows.get(toolUseId)
    if (!row) return
    this.rows.delete(toolUseId)
    this.turn.ledger?.commit(row)
  }

  /** `PostToolUseFailure`: the call's row is failed. */
  failed(toolUseId: string): void {
    const row = this.rows.get(toolUseId)
    if (!row) return
    this.rows.delete(toolUseId)
    this.turn.ledger?.failed(row)
  }
}

/** How long a locked turn's process group has to end after SIGTERM before it is killed. */
export const CLAUDE_LOCKED_KILL_GRACE_MS = 2_000

/** How much of the CLI's error output a failed locked turn keeps for the log. */
const STDERR_TAIL = 4_000

export interface ClaudeLockedSpawnOptions {
  onProcess?: (pid: number) => void
  platform?: NodeJS.Platform
  spawn?: typeof nodeSpawn
  /** Signals the process group `pid` leads (POSIX); throws when it has no member left. */
  signalGroup?: (pid: number, signal: NodeJS.Signals | 0) => void
  /** Ends the process tree `pid` heads (Windows), without waiting for it. */
  killTree?: (pid: number) => void
  graceMs?: number
  /** Where a failed turn's error output goes (default: the log). */
  onStderr?: (tail: string, code: number | null) => void
}

const defaultSignalGroup = (pid: number, signal: NodeJS.Signals | 0) => process.kill(-pid, signal)
// `taskkill` runs on its own: the daemon's loop never waits for it.
const defaultKillTree = (pid: number) => {
  execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => undefined)
}

/**
 * The spawn of a locked turn's Claude Code (`spawnClaudeCodeProcess`): the SDK's command,
 * arguments, folder and environment unchanged, in a process group of its own on POSIX, reported to
 * `onProcess`. The SDK's forwarded abort (after its own close grace) and the CLI's exit end the whole
 * group: SIGTERM, then SIGKILL after a short grace, with plain signals and no process listing on the
 * daemon's loop. On Windows the tree is ended by a `taskkill` that runs on its own, and only while the
 * CLI still runs (a pid may be reused once it is gone). A process whose registration fails is ended
 * at once and the spawn fails: nothing runs unsupervised. The CLI's error output is kept, and its
 * tail is logged when it fails.
 */
export function claudeLockedSpawn(options: ClaudeLockedSpawnOptions = {}): (spawnOptions: SpawnOptions) => SpawnedProcess {
  const platform = options.platform ?? process.platform
  const spawn = options.spawn ?? nodeSpawn
  const signalGroup = options.signalGroup ?? defaultSignalGroup
  const killTree = options.killTree ?? defaultKillTree
  const graceMs = options.graceMs ?? CLAUDE_LOCKED_KILL_GRACE_MS
  const onStderr = options.onStderr ?? ((tail: string, code: number | null) => console.warn(`[claude-locked] Claude Code exited with code ${code}: ${tail}`))
  const send = (pid: number, signal: NodeJS.Signals | 0): boolean => {
    try {
      signalGroup(pid, signal)
      return true
    } catch {
      return false
    }
  }
  return (spawnOptions) => {
    const child = spawn(spawnOptions.command, spawnOptions.args, {
      ...(spawnOptions.cwd ? { cwd: spawnOptions.cwd } : {}),
      env: spawnOptions.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: platform !== 'win32',
      windowsHide: true
    })
    const pid = child.pid
    let exited = false
    let ended = false
    let stderr = ''
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on?.('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL)
    })
    /** Ends the group or tree; `now` skips the grace. */
    const end = (now = false) => {
      if (ended || pid === undefined) return
      ended = true
      if (platform === 'win32') {
        if (!exited) killTree(pid)
        return
      }
      if (now || !send(pid, 'SIGTERM')) {
        send(pid, 'SIGKILL')
        return
      }
      const timer = setTimeout(() => {
        if (send(pid, 0)) send(pid, 'SIGKILL')
      }, graceMs)
      timer.unref?.()
    }
    const abort = () => end()
    if (spawnOptions.signal.aborted) queueMicrotask(abort)
    else spawnOptions.signal.addEventListener('abort', abort, { once: true })
    child.once('exit', (code: number | null) => {
      exited = true
      spawnOptions.signal.removeEventListener('abort', abort)
      if (code !== 0 && code !== null && stderr.trim()) onStderr(stderr.trim(), code)
      // On POSIX the group outlives its leader and is ended too.
      end()
    })
    if (pid !== undefined && options.onProcess) {
      try {
        options.onProcess(pid)
      } catch (error) {
        end(true)
        child.stdin?.destroy?.()
        child.stdout?.destroy?.()
        throw error
      }
    }
    return child as unknown as SpawnedProcess
  }
}
