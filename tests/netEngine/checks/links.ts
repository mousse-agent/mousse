/**
 * The link the owner checks run over. With `MOUSSE_NET_HELPER` unset it is the in-memory link; the helper-backed
 * link replaces it once the app talks to a helper.
 */
import { fakeLink } from '../fakeLink'
import type { LinkFactory } from './harness'

export function checkLink(): LinkFactory {
  return async (pair) => {
    const link = fakeLink({ ...pair })
    return { outbound: link.outbound, inbound: link.inbound, cut: link.cut }
  }
}
