import type { BotSummary } from '../../shared/bots/personal/chat'
import type { BotElsewhereComputer } from '../../shared/bots/personal/methods'
import type { HandlerContext } from './handlers'
import type { RemoteAppletIds, RemoteAppletOpened } from '../bridge/routed/remoteBotApplets'

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
  /** The other computers where this one has Full bot access (New bot's "Lives on"), from what is kept here. */
  computers?(ctx: HandlerContext): BotElsewhereComputer[]
  /**
   * A file a bot of another computer's chat shows (`bots.remote.file`): its copy on this computer, read from the bot's
   * files folder there when there is none or it changed. `path` is its place in that folder.
   */
  file(ctx: HandlerContext, botId: string, path: string): Promise<{ path: string; name: string; size: number }>
  /**
   * An applet a message of a bot of another computer shows (`bots.remote.applet`): its source and saved state, read
   * there; while that computer is away, the copy kept here, `readOnly`.
   */
  applet?(ctx: HandlerContext, botId: string, ids: RemoteAppletIds): Promise<RemoteAppletOpened>
  /** Saves such an applet's state on the bot's computer (`bots.remote.appletState`); refused at once while it is away. */
  appletSave?(ctx: HandlerContext, botId: string, ids: RemoteAppletIds, state: unknown): Promise<{ saved: true }>
}
