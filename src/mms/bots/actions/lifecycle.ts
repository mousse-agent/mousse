import type { BotStoreTx } from '../store/BotStore'

/** Per open database: existing held rows settle even when new holds are disabled. */
export interface HeldCallLifecycle {
  /** The activation `id` ended as `to`: a chat turn's held calls outlive it when it ends done. */
  endWork(id: string, to: 'done' | 'failed' | 'cancelled'): void
  grantChanged(botId: string): void
  forgetMessage(botId: string, messageId: string): void
}
const lifecycles = new WeakMap<BotStoreTx, HeldCallLifecycle>()
export function registerHeldCalls(db: BotStoreTx, lifecycle: HeldCallLifecycle): void { lifecycles.set(db, lifecycle) }
export function heldCalls(db: BotStoreTx): HeldCallLifecycle | undefined { return lifecycles.get(db) }
