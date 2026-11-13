import type { CounterScope } from '../../harness/counters'
import type { SpendScope } from '../../harness/spend'
import type { NeutralTool } from '../../harness/tools'
import type { BotComputerSwitch } from './computerLimit'
import type { PermissionMode } from '../../permissionMode'
import type { BotModelPick, BotWorkModelName } from './definition'

/**
 * The contracts of a personal bot's authority (PR 6 §2 and §4). A bot activation's runs are held to
 * what its owner approved: the tools and roots of its grant, one count allowance, one active-time
 * deadline and one spend ledger shared by the main run and every consult. The bot engine
 * implements these; the locked runtimes (Claude Code's `PreToolUse` gate, Pi's `/pi/gate` and
 * `/pi/request`) and the Mousse MCP registry code against them. Types only, browser-safe.
 */

/** Which thread of an activation a turn runs on: the main thread, a context thread it consults, or a run's subagent. */
export type BotThreadRole = 'activation' | 'context' | 'subagent'

/**
 * The bot threads of a profile (`bots.db`). A turn on a bot thread binds with origin `bot`, ahead
 * of any lineage, so a consult never binds as `delegated`; that also covers steers and RunEngine
 * retries, which do not pass an origin themselves.
 */
export interface BotThreads {
  /** The thread's role, or undefined when it is not a bot thread. */
  roleOf(threadId: string): BotThreadRole | undefined
  /**
   * The bot a thread belongs to, by id and its name now, or undefined when it is no bot's: how a thread the bot started
   * and a message it sent are shown as the bot's ("use your threads"). Never throws.
   */
  botOf?(threadId: string): { botId: string; name: string } | undefined
  /**
   * The chat turn (activation) when its owner's own message started it, the only turn that may start,
   * message or stop the owner's threads, with `limit`: the permission limit of the other device that message came from
   * (absent: this computer's own window). Undefined for any other turn. Never throws.
   */
  ownerTurn?(activationId: string): { limit?: PermissionMode } | undefined
}

/**
 * One tool call as the gate sees it, after its native name was mapped (`nativeToolNames`). `own`:
 * every path the call names is in the runtime's own storage for this bot (Claude Code's saved tool
 * output, `claudeOwnFolders`), checked by the runtime's gate; such a file call needs no file access.
 */
export type NormalisedCall =
  | { kind: 'builtin'; tool: NeutralTool; nativeName: string; args: Record<string, unknown>; own?: true }
  | { kind: 'app'; tool: string; args: Record<string, unknown> }
  /** One of the owner's MCP tools: `server` is the grant's server id (its installation), `serverName` its name for chips. */
  | { kind: 'mcp'; server: string; tool: string; args: Record<string, unknown>; serverName?: string }
  | { kind: 'skill'; skill: string }

/**
 * One of the owner's MCP tools a bot's turn is offered: granted, and on a server set up for the whole profile now
 * (`BotMcp.offered`). Every call of it goes through Mousse, which checks it against the grant before the server sees it.
 */
export interface BotMcpTool {
  /** The name the turn sees: the relay's `<server>__<tool>` on Claude Code and Codex. */
  name: string
  /** The proxied name (`McpManager`'s provider name), which Pi's turn sees and every call runs by. */
  providerName: string
  /** The grant's pair: the server's id (its installation) and the tool's own name. */
  server: string
  tool: string
  serverName: string
  /** The server's own description, framed as third-party text (never instructions). */
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Why a call stops at a wall: the dispatch ends and the owner is asked. `waiting`: the activation
 * already waits for the owner's answer. `policy_unenforceable`: the tool has no mapping on this
 * runtime, or its containment is unproven here.
 */
export type WallReason =
  | { kind: 'tool'; tool: string }
  | { kind: 'path'; tool: string; path: string; access: 'read' | 'write' }
  /** A path inside Mousse's own data, closed to every bot even with file access: never an ask. */
  | { kind: 'closed'; tool: string; path: string }
  /**
   * Something this computer has switched off for every bot (Settings → What bots may do here, `BotComputerLimit`):
   * commands, files outside the bot's own folders, or the browser. Never an ask, whatever the grant holds.
   */
  | { kind: 'computer'; tool: string; off: BotComputerSwitch }
  /**
   * A path the runtime would rewrite before opening (`~`, a variable): never checked, never an ask.
   * `home`: the owner's home folder, for a `~` or variable path; `full`: the path it stands for.
   */
  | { kind: 'path_form'; tool: string; path: string; home?: string; full?: string }
  /** A network path to this computer that can't be turned into the local path it means with certainty: never an ask. */
  | { kind: 'network_path'; tool: string; path: string }
  /** A search or listing over a folder that holds a place closed to bots, on a runtime that can't skip it: never an ask. */
  | { kind: 'search_closed'; tool: string; path: string }
  | { kind: 'skill'; skill: string }
  | { kind: 'mcp'; server: string; tool: string; serverName?: string }
  | { kind: 'waiting' }
  | { kind: 'policy_unenforceable'; tool: string; missing: string[] }
  /** The grant this turn runs under was revoked or replaced since the turn started. */
  | { kind: 'revoked' }
  /** The activation or its dispatch ended (stopped, deadline): nothing more runs. */
  | { kind: 'ended' }
  /**
   * The call hit a wall and the owner was asked (6c-2): the dispatch ends now. `permission` is
   * what was asked for, in plain words.
   */
  | { kind: 'escalated'; permission: string }
  /** The activation paused: earlier tool calls need the owner's check first (6c-2). */
  | { kind: 'paused' }

/**
 * What the authority decides for one call (Bot Phase 1 §5.1.1). `wall` ends the dispatch: a chat
 * turn's missing permission, a budget, or the activation's state. `refused` is an unattended run's
 * missing permission: the call fails with `text` as its tool error, an ask (`askId`) waits for the
 * owner, and the dispatch carries on.
 */
export type BotCheck =
  | { ok: true }
  | { ok: false; wall: WallReason }
  | { ok: false; refused: { text: string; askId: string } }

/** A check that did not allow the call. */
export type BotCheckDenied = Exclude<BotCheck, { ok: true }>

/**
 * Called at every check that allows a call, whatever the runtime (Bot Phase 1 §5.8): the source of
 * live chips (`BotActivitySink.onAllowed`). Must not throw or block.
 */
export type BotAllowedObserver = (call: NormalisedCall) => void

/**
 * A bot activation's authority over one turn, registered with the turn's app tools (never in the
 * run policy, which carries only `RunPolicy.authority`'s kind and digest).
 */
export interface BotAuthority {
  activationId: string
  role: BotThreadRole
  /** Granted built-ins (neutral names). */
  tools: ReadonlySet<NeutralTool>
  /** Granted Mousse app tools, by their app-tool name. */
  appTools: ReadonlySet<string>
  skills: ReadonlySet<string>
  /** Granted MCP tools, as `<server id>::<tool name>`. */
  mcp: ReadonlySet<`${string}::${string}`>
  /**
   * The granted MCP tools this turn is offered, on servers set up now (none in a chat turn: they are work's). Read when
   * the turn starts; every call is checked again against `mcp` and the server as it is then.
   */
  mcpTools?: readonly BotMcpTool[]
  /**
   * The roots the bot may touch and how, and the activation's private scratch folder; null when it
   * may touch no folder at all. With file access the roots are the tops of the file system and
   * `computer` is set.
   */
  workspace: {
    roots: readonly string[]
    access: 'read' | 'write'
    scratch: string
    /** The roots it may change (per folder); absent: every root when `access` is `write`. */
    writeRoots?: readonly string[]
    /**
     * The bot's files folder, also one of `roots` and `writeRoots`: the working directory of a turn
     * on a runtime that asks before calls (Claude Code, Codex on the owner's entries).
     */
    files?: string
    /**
     * File access (bot-architecture.md §3.7): every folder, read and write, but `closed`, Mousse's
     * own data folder, of which only the files folder and scratch are the bot's, and `outside`: Mousse's
     * other data and sign-ins, and the sign-in files of the CLIs it runs (`botClosedPlaces`).
     */
    computer?: { closed: string; outside?: readonly string[] }
  } | null
  /** True while the activation waits for the owner's answer to a wall (`waiting_grant`). */
  waiting(): boolean
  /** Allowlist, path containment across the roots (real paths), skill and MCP identity, and the wait. */
  check(call: NormalisedCall): BotCheck
  /**
   * One native call that stands for several neutral tools (Claude's `Glob`): allowed when any of
   * them passes. Decided without side effects, so a wall or an ask is raised once, only when all are refused.
   */
  checkAny?(calls: readonly NormalisedCall[]): BotCheck
  /**
   * With file access: whether a search or listing that walks down from `path` (on its real path) would reach a place
   * closed to bots, other than the bot's own folders. A runtime that can't make the walk skip them refuses it.
   */
  closedBelow?(path: string): boolean
  /** The activation's request and tool-call counts: one atomic row, shared by its main run and consults. */
  counters: CounterScope
  time: ActiveTimeScope
  /**
   * The activation's token and USD ledger (`committed + reserved`, shared by its main run and
   * consults): the gateway's spend scope, so a turn hands it over as `TurnSpec.spend`. Null when
   * the bot has no token or USD limit.
   */
  spend: SpendScope | null
  /**
   * The `escalate` app tool (6c-2): the bot asks its owner for a permission it lacks. The dispatch
   * ends at the wall; the text is what the call returns. Absent: the turn cannot escalate.
   */
  escalate?(request: { permission: unknown; reason: string; toolCallId?: string }): string
  /**
   * What a call of a permission the turn lacks returns when the bot's grant holds it now (the owner allowed it after
   * the turn started): it is not asked for again. Undefined when the grant does not hold it. Absent: never held.
   */
  held?(permission: unknown): string | undefined
  /**
   * The `consult` app tool (6c-2), on activation threads only: asks the context thread `context`
   * and returns its final message. Absent on context threads (depth is 1).
   */
  consult?(request: { context: string; question: string; signal?: AbortSignal }): Promise<string>
  /** The context threads `consult` may name, by key and title. */
  contexts?: ReadonlyArray<{ key: string; title: string }>
  /**
   * The `subagent_*` app tools, on a run's main turn only: subagents of the work, each held to the work's permissions
   * and counted by the service. Absent on the chat, a consult and a subagent (depth is 1).
   */
  subagents?: BotSubagents
  /**
   * Why this turn holds the owner's threads ("use your threads") to reading only, for the words of a refused start,
   * message or Stop: `work` (work, a reminder's work or a schedule: starting is the chat's), or `not_owner` (a chat turn
   * no message of the owner started, such as the bot's first message). Absent: the turn may act, or holds
   * no thread tool at all.
   */
  threadsReadOnly?: 'work' | 'not_owner'
  /**
   * Why the turn may not use the app tool `tool` now (its grant was removed or replaced, this computer switched it off,
   * the activation ended), decided without asking anyone or showing a chip; undefined while it may. For a call that
   * waited (`thread_wait`), checked again before it returns anything.
   */
  stillHolds?(tool: string): string | undefined
}

/** A subagent of a bot's work, as the work reads it: its title, its model in plain words, where it is, and its result. */
export interface BotSubagentView {
  subagent: string
  model: string
  state: 'running' | 'done' | 'failed' | 'stopped'
  /** What it returned, framed as data from a subagent; only once it ended, and only when asked for. */
  result?: string
  /** Why it ended without a result, in plain words. */
  why?: string
}

/**
 * The work's handle on its subagents (`BotAuthority.subagents`). Every answer is plain text or a view for the model;
 * a refusal is `{ refused }` and starts nothing. The engine decides and counts, never the tool.
 */
export interface BotSubagents {
  /**
   * `model`: one of `work_models`' choices, already matched (`workModelChoice`), with its entry's sign-in now; absent, the
   * work's own model.
   */
  start(request: { title: string; brief: string; model?: { pick: BotModelPick & { instanceId: string }; name: BotWorkModelName }; toolCallId?: string }): Promise<{ started: BotSubagentView; note: string; lacks?: string[] } | { refused: string }>
  send(request: { subagent: string; message: string }): Promise<{ sent: BotSubagentView; note: string; lacks?: string[] } | { refused: string }>
  /** Until `subagent` (or, without one, every running subagent) ends, the turn ends, or `timeoutMs` passes. */
  wait(request: { subagent?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<{ subagents: BotSubagentView[]; note?: string } | { refused: string }>
  /** One subagent with its result once it ended, or (without `subagent`) every one, without results. */
  result(request: { subagent?: string }): { subagents: BotSubagentView[]; note?: string } | { refused: string }
  stop(request: { subagent: string }): { stopped: BotSubagentView } | { refused: string }
  /**
   * For `work_models`: by entry, what a subagent there would run without (in the owner's words), or why it can't run
   * there, for what the work's turn holds now (the hold rule, `subagentHold`). An entry it would run on as the work does
   * is absent.
   */
  holdOn?(instanceIds: readonly string[]): Record<string, { lacks: string[] } | { refused: string }>
}

/** The active time of an activation's main dispatch, which its consults share. */
export interface ActiveTimeScope {
  /** Monotonic milliseconds; fixed when the main dispatch starts. */
  deadline(): number
  /** Aborts when the main dispatch ends, for any reason. */
  signal: AbortSignal
}
