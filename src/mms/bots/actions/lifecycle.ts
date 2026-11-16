import type { BotStoreTx } from '../store/BotStore'

/** Per open database, never persisted: a disabled feature installs no active behavior. */
export interface HeldCallLifecycle {
  endWork(id: string): void
  grantChanged(botId: string): void
  forgetMessage(botId: string, messageId: string): void
}
const lifecycles = new WeakMap<BotStoreTx, HeldCallLifecycle>()
export function registerHeldCalls(db: BotStoreTx, lifecycle: HeldCallLifecycle): void { lifecycles.set(db, lifecycle) }
export function heldCalls(db: BotStoreTx): HeldCallLifecycle | undefined { return lifecycles.get(db) }
