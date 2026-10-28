import type { HandlerContext } from './handlers'

/**
 * What the protocol handlers need from the router that sends the actions of a thread on another of
 * the user's computers to that computer (`bridge/routed/ThreadRouter.ts`). The router is composed
 * with Bridge; a profile without it runs every call here.
 */
export interface ThreadRouterPort {
  /**
   * Runs the call on the computer it names, if it names one. `undefined` means the call is for this
   * computer: the handlers run it. Throws a `DomainRpcError` for a refusal (the computer is
   * offline, refused this device, is older, or the call is not one a connection of this kind may route).
   */
  dispatch(
    ctx: HandlerContext,
    method: string,
    params: unknown
  ): Promise<{ result: unknown } | undefined>
  /**
   * A window keeps (or lets go of) a thread in view. For a thread of another computer this attaches
   * the stream that thread's events travel on; for a thread of this computer there is nothing to do.
   */
  focus(
    ctx: HandlerContext,
    threadId: string,
    focused: boolean
  ): Promise<{ routed: boolean; focused: boolean }>
}
