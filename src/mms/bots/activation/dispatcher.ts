import type { BotAuthority } from '../../../shared/bots/personal/authority'
import type { BotLane } from '../../../shared/bots/personal/definition'
import type { BrowserRuntimePort } from '../../../shared/browser/runtime'
import type { BindPolicy, ProviderSelection } from '../../../shared/harness/types'
import type { BrowserExecutionBinding } from '../../orchestrator/browser/binding'
import type { BotTurnPayload } from '../../run/types'

/**
 * What the `turn.start` executor asks of the bot engine (PR 6 §4 "Execution"). The payload names
 * an activation and a dispatch only; everything the turn runs with is rebuilt from `bots.db` here.
 */
export interface BotTurnDispatcher {
  /**
   * Re-reads the activation and dispatch, checks that the grant still holds, compiles the policy
   * and starts the dispatch's active time. A refusal cancels the queued run; nothing is sent.
   */
  prepare(payload: BotTurnPayload): PreparedBotTurn | { refused: string; code: string }
  /**
   * Reads again, now, what the dispatch's runtime check depends on (its policy facts), so
   * `prepare` decides on a fresh reading. Never throws.
   */
  refresh?(payload: BotTurnPayload): Promise<void>
  /** The dispatch's run ended (the executor saw it terminal); `text` is the final message, if any. */
  settle(payload: BotTurnPayload, outcome: { text?: string }): void
  /** The bot's name when `threadId` is one of its threads: ordinary sends there are refused. */
  ownerOf(threadId: string): string | undefined
}

export interface PreparedBotTurn {
  activationId: string
  dispatchN: number
  /** The trigger's text, sent as the turn's user message. */
  prompt: string
  /**
   * The bot's system text (who it is, its lane's rules, what its owner allows now): the turn's system prompt, which a
   * compaction keeps. Claude Code's is replaced by it; Codex takes it as developer instructions; Pi adds it to its own.
   */
  instructions?: string
  selection: ProviderSelection
  /** The binding's policy (`bind(…, {policy})`). */
  policy: BindPolicy
  authority: BotAuthority
  /** The activation's private scratch folder: the turn's working directory. */
  scratch: string
  /** Skill ids the turn may list and load. */
  skills: readonly string[]
  /**
   * `none`: the first dispatch of a run, on a new thread that must have no history.
   * `cleared`: the first dispatch of a chat activation, on the home thread, whose context the engine
   * has just cleared (`clearConversationContext`): the transcript stays, the native context is empty.
   * `thread`: a continuation or a consult, on the thread's own history.
   */
  history: 'none' | 'cleared' | 'thread'
  /** The activation's lane: the owner's chat on the home thread, or a run. */
  lane?: BotLane
  /** The context pack (bot-context.md §5), frozen for the activation: placed in the turn's preamble. */
  preamble?: string
  /** The bot's own browser, when its grant holds "use the browser": the turn's browser tools run on it. */
  browser?: BotTurnBrowser
  /**
   * What reaches the turn while it runs (a main dispatch only): the owner's notes to running work, and, after the
   * runtime compacted the turn's context, the memory pack and the job's brief again. The orchestrator offers it to the
   * runtime as a steer, at the next safe point; a runtime that cannot take one leaves it for the dispatch's end.
   */
  steer?: BotTurnSteer
}

/**
 * The engine's side of a bot turn's steer (`PreparedBotTurn.steer`). Nothing in it widens the turn's grant: it adds
 * text to the conversation and nothing else. Taken text is delivered once: `accepted` marks it read, `handedBack` puts it
 * back to wait, and whatever the turn never read waits for the dispatch's end, as before.
 */
export interface BotTurnSteer {
  /** The runtime takes steers into this turn (the orchestrator wired it): a note reaches it while it runs. */
  attached(): void
  /** What waits to go in now, without taking it. */
  peek(): string | undefined
  /** Takes what waits: its text, and the token it is accepted or handed back by. */
  take(): { text: string; token: string } | undefined
  /** The model read what `token` names: delivered, once. */
  accepted(token: string): void
  /** The runtime could not give it to the turn: it waits again. */
  handedBack(token: string): void
  /** The runtime compacted the turn's context: the memory pack and the job's brief go in again at the next safe point. */
  compacted(): void
}

/** A bot turn's browser: its trusted binding, and the runtime that holds it to the bot's own browser. */
export interface BotTurnBrowser {
  binding: BrowserExecutionBinding
  runtime: BrowserRuntimePort
}

/** The engine's view of the bots' browsers (`BotBrowsers`). */
export interface BotBrowserHost {
  /** The browser of one dispatch; undefined when the bot's browser can't be offered here. */
  turn(input: { botId: string; activationId: string; lane: BotLane; homeThreadId: string; runId: string; signal: AbortSignal }): BotTurnBrowser | undefined
  /** The activation ended (done, failed or stopped): its tabs close, and an idle browser after them. */
  activationEnded(input: { botId: string; activationId: string }): void
  /** The bot was deleted: its browser closes; `purge` also erases its sign-ins and site data. */
  removeBot?(botId: string, purge: boolean): Promise<void> | void
}

/** The abort reason of a bot dispatch that ended at a wall (PR 6 §5): its run ends `bot_wall`. */
export class BotWallAbort extends Error {
  readonly botWall = true
  constructor(message = 'bot_wall') {
    super(message)
    this.name = 'BotWallAbort'
  }
}

/**
 * The abort reason of a dispatch ended to change its model (`set_depth`/`use_model` with scope
 * `now`, Bot Phase 1 §5.6): the wall-abort path with no wall. It continues on the same thread.
 */
export class BotReloadAbort extends BotWallAbort {
  readonly botReload = true
  constructor() {
    super('bot_reload')
    this.name = 'BotReloadAbort'
  }
}

/**
 * The abort reason of work that ran out of room (`BotEngine.budgetEnd`): a wall whose turn hands back what it had, the
 * reply it finished last when it was cut right after a tool call (`stoppedReplyText`).
 */
export class BotRoomAbort extends BotWallAbort {
  readonly botRoom = true
  constructor() {
    super('bot_out_of_room')
    this.name = 'BotRoomAbort'
  }
}

export function isBotWallAbort(reason: unknown): boolean {
  return reason instanceof BotWallAbort || (Boolean(reason) && typeof reason === 'object' && (reason as { botWall?: unknown }).botWall === true)
}

/** Whether a bot turn was cut because its work ran out of room (`BotRoomAbort`). */
export function isBotRoomAbort(reason: unknown): boolean {
  return reason instanceof BotRoomAbort || (Boolean(reason) && typeof reason === 'object' && (reason as { botRoom?: unknown }).botRoom === true)
}
