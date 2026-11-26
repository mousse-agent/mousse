import type { NodeId } from '../../shared/net'
import { NetError } from '../../shared/net/errors'
import { methodAccess, needsWork } from '../../shared/net/accessClasses'
import { accessPresetOf } from '../../shared/net/accessPresets'
import type { RpcMethod } from './contracts'
import type { NodePolicy } from './store/nodePolicy'

/** The refusal of a device this computer lets view threads and chat with bots only. */
export const workOff = (): NetError =>
  new NetError('forbidden', undefined, { details: { reason: 'work_off' } })

/**
 * What this computer lets one other device do, for one call: shared by v1 sessions (after their own gates) and
 * engine sessions (after the grant and the allowlist). Read on every call and on every lookup of a saved result,
 * so a block, the terminal switch or "Work on threads" takes effect on the device's next request.
 */
export function checkNodePolicy(
  method: Pick<RpcMethod, 'method' | 'family' | 'needsTerminal'>,
  node: NodeId,
  policy: { isBlocked(node: NodeId): boolean; get(node: NodeId): NodePolicy },
  config: { workOnThreads?: boolean }
): void {
  if ((method.family === 'bridge' || method.family === 'routed') && policy.isBlocked(node))
    throw new NetError(
      'forbidden',
      undefined,
      method.family === 'routed' ? { details: { reason: 'blocked' } } : undefined
    )
  // Installing an update stops every turn and the service here: only a device the owner gave Full control, and has not
  // blocked, may ask, see a request's status or cancel it. Read on every call, so a change applies at once.
  if (methodAccess(method.method) === 'update') {
    if (policy.isBlocked(node)) throw new NetError('forbidden', undefined, { details: { reason: 'blocked' } })
    if (accessPresetOf(policy.get(node)) !== 'full')
      throw new NetError('forbidden', undefined, { details: { reason: 'full_control_needed' } })
  }
  if (method.family === 'routed') {
    // The owner's switch is read on every call, so turning it off is also a kill switch.
    if (config.workOnThreads === false)
      throw new NetError('forbidden', undefined, { details: { reason: 'setting_off' } })
    if (method.needsTerminal && !policy.get(node).terminal)
      throw new NetError('forbidden', undefined, { details: { reason: 'terminal_off' } })
  }
  // "Work on threads from this device" off: the device views threads and chats with bots, and every call
  // that would start, change or stop work is refused, in every family, a saved result's lookup included.
  if (needsWork(methodAccess(method.method)) && !policy.get(node).work) throw workOff()
}
