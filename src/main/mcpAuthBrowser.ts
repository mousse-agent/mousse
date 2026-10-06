import type { ProtocolConnectionEvent } from '../mms/protocol/types'
import { openExternalSafely } from './safeExternalUrl'

/** Browser consent belongs to the initiating live window, never a replay or another profile. */
export async function dispatchMcpAuthBrowser(
  event: ProtocolConnectionEvent,
  currentBinding: () => { profileId: string; epoch: number } | null | undefined,
  open: (url: string) => Promise<void>,
  acknowledge: (attemptId: string, opened: boolean) => Promise<unknown>
): Promise<void> {
  const current = (): boolean => {
    const binding = currentBinding()
    return !!binding && event.profileId === binding.profileId && event.profileEpoch === binding.epoch
  }
  if (event.type !== 'mcp.auth-url' || !current()) return
  const data = event.data as { attemptId?: unknown; url?: unknown }
  if (!data || typeof data.attemptId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.attemptId) || typeof data.url !== 'string' || data.url.length > 16_384) return
  let parsed: URL
  try { parsed = new URL(data.url) } catch { return }
  if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) return
  const opened = await openExternalSafely(open, parsed.toString(), 'mcpAuth')
  if (current()) await acknowledge(data.attemptId, opened)
}
