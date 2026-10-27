import type { CounterScope } from '../../harness/counters'
import type { SpendScope } from '../../harness/spend'
import type { NeutralTool } from '../../harness/tools'

/**
 * The contracts of a personal bot's authority (PR 6 §2 and §4). A bot activation's runs are held to
 * what its owner approved: the tools and roots of its grant, one count allowance, one active-time
 * deadline and one spend ledger shared by the main run and every consult. The bot engine
 * implements these; the locked runtimes (Claude Code's `PreToolUse` gate, Pi's `/pi/gate` and
 * `/pi/request`) and the Mousse MCP registry code against them. Types only, browser-safe.
 */

/** Which thread of an activation a turn runs on: the main thread, or a context thread it consults. */
export type BotThreadRole = 'activation' | 'context'

/**
 * The bot threads of a profile (`bots.db`). A turn on a bot thread binds with origin `bot`, ahead
 * of any lineage, so a consult never binds as `delegated`; that also covers steers and RunEngine
 * retries, which do not pass an origin themselves.
 */
export interface BotThreads {
  /** The thread's role, or undefined when it is not a bot thread. */
  roleOf(threadId: string): BotThreadRole | undefined
}

/** One tool call as the gate sees it, after its native name was mapped (`nativeToolNames`). */
export type NormalisedCall =
  | { kind: 'builtin'; tool: NeutralTool; nativeName: string; args: Record<string, unknown> }
  | { kind: 'app'; tool: string; args: Record<string, unknown> }
  | { kind: 'mcp'; server: string; tool: string; args: Record<string, unknown> }
  | { kind: 'skill'; skill: string }

/**
 * Why a call stops at a wall: the dispatch ends and the owner is asked. `waiting`: the activation
 * already waits for the owner's answer. `policy_unenforceable`: the tool has no mapping on this
 * runtime, or its containment is unproven here.
 */
export type WallReason =
  | { kind: 'tool'; tool: string }
  | { kind: 'path'; tool: string; path: string; access: 'read' | 'write' }
  | { kind: 'skill'; skill: string }
  | { kind: 'mcp'; server: string; tool: string }
  | { kind: 'waiting' }
  | { kind: 'policy_unenforceable'; tool: string; missing: string[] }
  /** The grant this turn runs under was revoked or replaced since the turn started. */
  | { kind: 'revoked' }
  /** The activation or its dispatch ended (stopped, deadline): nothing more runs. */
  | { kind: 'ended' }

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
  /** The roots the bot may touch and how, and the activation's private scratch folder; null without file access. */
  workspace: { roots: readonly string[]; access: 'read' | 'write'; scratch: string } | null
  /** True while the activation waits for the owner's answer to a wall (`waiting_grant`). */
  waiting(): boolean
  /** Allowlist, path containment across the roots (real paths), skill and MCP identity, and the wait. */
  check(call: NormalisedCall): { ok: true } | { ok: false; wall: WallReason }
  /** The activation's request and tool-call counts: one atomic row, shared by its main run and consults. */
  counters: CounterScope
  time: ActiveTimeScope
  /**
   * The activation's token and USD ledger (`committed + reserved`, shared by its main run and
   * consults): the gateway's spend scope, so a turn hands it over as `TurnSpec.spend`. Null when
   * the bot has no token or USD limit.
   */
  spend: SpendScope | null
}

/** The active time of an activation's main dispatch, which its consults share. */
export interface ActiveTimeScope {
  /** Monotonic milliseconds; fixed when the main dispatch starts. */
  deadline(): number
  /** Aborts when the main dispatch ends, for any reason. */
  signal: AbortSignal
}
