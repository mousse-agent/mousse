/** Stop the actual CLI immediately after writing its transfer request.
 * Its response remains pending while the independently owned daemon continues.
 */
import { LocalMmsClient } from '../../../src/mms/protocol/client'

const request = LocalMmsClient.prototype.request
LocalMmsClient.prototype.request = function <T = unknown>(
  method: string,
  params?: unknown,
  timeoutMs?: number
) {
  const pending = request.call(this, method, params, timeoutMs) as Promise<T>
  if (method === 'net.authority.transfer') {
    process.send?.({ requestHeld: true })
    process.kill(process.pid, 'SIGSTOP')
  }
  return pending
}
await import('../../../src/cli/index')
