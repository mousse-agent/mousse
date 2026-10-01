import { browserNavigationUrl } from '../../../shared/browser/validation'
import type { BrowserPolicyPort } from '../../../mms/browser/ports'

/** Production default: deny all until root injects a real policy. */
export function createFailClosedAttachedPolicy(): BrowserPolicyPort {
  return {
    authorize() {
      return { allowed: false, code: 'policy_denied', message: 'No attached-browser policy was injected' }
    }
  }
}

/** Fixture-only: HTTP(S) loopback. Not a production default. */
export function createLoopbackAttachedPolicy(): BrowserPolicyPort {
  return {
    authorize(input) {
      const url = input.url ?? (input.action && 'url' in input.action ? input.action.url : undefined)
      if (url === undefined) return { allowed: true }
      try {
        const href = browserNavigationUrl(url)
        const parsed = new URL(href)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { allowed: false, code: 'policy_denied', message: 'Attached navigation is limited to HTTP(S)' }
        }
        if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
          return { allowed: false, code: 'policy_denied', message: 'Attached navigation is limited to loopback' }
        }
        return { allowed: true }
      } catch (error) {
        return { allowed: false, code: 'policy_denied', message: error instanceof Error ? error.message : String(error) }
      }
    }
  }
}
