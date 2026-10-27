import type { BotAuthority } from '../../../shared/bots/personal/authority'
import type { BindPolicy, ProviderSelection } from '../../../shared/harness/types'
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
  /** The bot's instructions, appended to the runtime's own. */
  instructions?: string
  selection: ProviderSelection
  /** The binding's policy (`bind(…, {policy})`). */
  policy: BindPolicy
  authority: BotAuthority
  /** The activation's private scratch folder: the turn's working directory. */
  scratch: string
  /** Skill ids the turn may list and load. */
  skills: readonly string[]
}
