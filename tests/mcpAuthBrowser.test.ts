import { expect, it, vi } from 'vitest'
import { dispatchMcpAuthBrowser } from '../src/main/mcpAuthBrowser'
import type { ProtocolConnectionEvent } from '../src/mms/protocol/types'

const event: ProtocolConnectionEvent = { kind: 'connection_event', type: 'mcp.auth-url', profileId: 'profile-a', profileEpoch: 1, data: { attemptId: '12345678-1234-1234-1234-123456789abc', url: 'https://login.example.test/authorize' } }
const binding = () => ({ profileId: 'profile-a', epoch: 1 })
it('opens the URL and acknowledges browser launch success or failure truthfully', async () => {
  const open = vi.fn(async () => {}), ack = vi.fn(async () => {})
  await dispatchMcpAuthBrowser(event, binding, open, ack)
  expect(open).toHaveBeenCalledWith('https://login.example.test/authorize')
  expect(ack).toHaveBeenLastCalledWith('12345678-1234-1234-1234-123456789abc', true)
  open.mockRejectedValueOnce(new Error('No browser'))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try { await dispatchMcpAuthBrowser(event, binding, open, ack) } finally { warn.mockRestore() }
  expect(ack).toHaveBeenLastCalledWith('12345678-1234-1234-1234-123456789abc', false)
})
it('rejects stale bindings, invalid schemes and credentials without opening a browser', async () => {
  const open = vi.fn(async () => {}), ack = vi.fn(async () => {})
  await dispatchMcpAuthBrowser(event, () => ({ profileId: 'profile-b', epoch: 1 }), open, ack)
  await dispatchMcpAuthBrowser(event, () => ({ profileId: 'profile-a', epoch: 2 }), open, ack)
  for (const url of ['file:///tmp/no', 'javascript:alert(1)', 'https://user:secret@login.example.test/']) await dispatchMcpAuthBrowser({ ...event, data: { ...(event.data as object), url } }, binding, open, ack)
  expect(open).not.toHaveBeenCalled(); expect(ack).not.toHaveBeenCalled()
})
it('does not acknowledge to a changed profile after browser opening finishes', async () => {
  let epoch = 1
  const ack = vi.fn(async () => {})
  await dispatchMcpAuthBrowser(event, () => ({ profileId: 'profile-a', epoch }), async () => { epoch = 2 }, ack)
  expect(ack).not.toHaveBeenCalled()
})
