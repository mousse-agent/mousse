import type { NetIdentityService } from '../../net/identity/NetIdentityService'
import { shortUserName } from '../../../shared/humanAuthor'
import type { NodeId, UserId } from '../../../shared/net/ids'
import type { HumanAuthor } from '../../../shared/types'

/**
 * Who a routed call writes as when it is not the account's owner: the authenticated caller's user and computer, and a
 * name to show. Undefined for the owner's own computers, so their messages stay as they always were (no author). A
 * computer that does not know its own user yet stamps every caller: a caller is the owner only when that is known.
 *
 * The name is a short form of the user id until a team roster gives people names.
 */
export function routedAuthorOf(
  identity: Pick<NetIdentityService, 'self'>,
  caller: { node: NodeId | string; user: UserId | string }
): HumanAuthor | undefined {
  let self: { user: UserId } | undefined
  try {
    self = identity.self()
  } catch {
    self = undefined
  }
  if (self && caller.user === self.user) return undefined
  const user = caller.user as UserId
  return { user, node: caller.node as NodeId, displayName: shortUserName(user) }
}
