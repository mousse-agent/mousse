import { localBotMethod, type BotMethod } from '../../shared/bots/personal/methodTable'
import { DomainRpcError } from '../protocol/domainRegistry'
import type { HandlerContext } from '../protocol/handlers'
import { connectionIsLocal } from '../protocol/threadVisibility'

/**
 * A bot method's own limit on who calls it (`BOT_METHODS`' `local.only`): this computer's window (`window`), or its
 * window and command line (`this_computer`), never a call that came through Bridge. Absent, any client of the profile.
 */
export function assertLocalCaller(method: BotMethod, connection: HandlerContext['connection']): void {
  const only = localBotMethod(method).only
  if (!only) return
  const allowed = only.callers === 'window' ? connection?.clientType === 'gui' : connectionIsLocal(connection)
  if (!allowed || connection?.bridgeCaller) throw new DomainRpcError('forbidden', only.refusal)
}
