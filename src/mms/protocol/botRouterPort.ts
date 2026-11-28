import type { BotSummary } from '../../shared/bots/personal/chat'
import type { HandlerContext } from './handlers'

/**
 * What the protocol handlers need from the router that sends a window's call about a bot of another of the user's
 * computers to that computer (`bridge/routed/BotRouter.ts`). Composed with Bridge; a profile without it runs every bot
 * call here.
 */
export interface BotRouterPort {
  /**
   * Runs a bot call on the computer it names (a qualified `botId`, or `node` for a call that names a computer and no
   * bot). `undefined` means the call is for this computer: the handlers run it. Throws a `DomainRpcError` for a refusal.
   */
  dispatch(ctx: HandlerContext, method: string, params: unknown): Promise<{ result: unknown } | undefined>
  /**
   * A window keeps (or lets go of) a bot's chat in view. For a bot of another computer its chat stream is open while at
   * least one window shows it; for a bot of this computer there is nothing to do.
   */
  focus(ctx: HandlerContext, botId: string, focused: boolean): Promise<{ routed: boolean; focused: boolean }>
  /** The other computers' bots a window lists beside this computer's own (`bots.remote.list`), from what is kept here. */
  list(ctx: HandlerContext): BotSummary[]
}
