import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatConversation } from '../../src/shared/chats'
import type { BotId } from '../../src/shared/net'

vi.mock('../../src/renderer/stores/appStore', () => ({ useAppStore: { getState: () => ({ setThreadsSidebarView: vi.fn(), setSidebarMode: vi.fn() }) } }))
import { useChatsStore } from '../../src/renderer/stores/chatsStore'
import type { ChatNetworkProjection } from '../../src/shared/chatsNetwork'

const request = vi.fn()
let profile = 0
const local = (): ChatConversation => ({ id: 'chat', kind: 'group', name: 'Group', threadId: 'local-thread', participants: [], messages: [], createdAt: '', updatedAt: '' })
beforeEach(() => {
  vi.stubGlobal('window', { mousse: { platformRequest: { request } } })
  request.mockReset()
  useChatsStore.getState().activate(`profile-${++profile}`)
  useChatsStore.setState({ activeChatId: 'chat', conversation: local() })
})
afterEach(() => vi.unstubAllGlobals())

it('retries the exact explicit bot selection after a lost send reply without deriving mentions from names', async () => {
  request.mockRejectedValue(new Error('reply lost'))
  const bots = ['bot_second', 'bot_first'] as BotId[]
  await useChatsStore.getState().send('@display-name hello', bots)
  bots.push('bot_new' as BotId)
  await useChatsStore.getState().send('@display-name hello', ['bot_first', 'bot_second'] as BotId[])
  const first = request.mock.calls[0][1], retry = request.mock.calls[1][1]
  expect(retry).toEqual(first)
  expect(first.mentions).toEqual(['bot_first', 'bot_second'])
  await useChatsStore.getState().send('@display-name hello', [])
  expect(request.mock.calls[2][1].clientMessageId).not.toBe(first.clientMessageId)
  expect(request.mock.calls[2][1].mentions).toEqual([])
})

it('retains one publication key after an uncertain reply and never includes old local data', async () => {
  request.mockRejectedValue(new Error('reply lost'))
  await useChatsStore.getState().publish()
  await useChatsStore.getState().publish()
  expect(request.mock.calls[1]).toEqual(request.mock.calls[0])
  expect(Object.keys(request.mock.calls[0][1]).sort()).toEqual(['chatId', 'publicationId'])
  expect(useChatsStore.getState().error).toContain('Publication needs checking')
})

it('discards a late send response and retry identity across profile activation', async () => {
  let resolve!: (value: ChatConversation) => void
  request.mockImplementationOnce(() => new Promise<ChatConversation>(done => { resolve = done }))
  const pending = useChatsStore.getState().send('first profile', [])
  const oldId = request.mock.calls[0][1].clientMessageId
  useChatsStore.getState().activate('different-profile')
  resolve(local()); await pending
  expect(useChatsStore.getState().conversation).toBeNull()
  expect(request).toHaveBeenCalledTimes(1)
  useChatsStore.setState({ activeChatId: 'chat', conversation: local() })
  request.mockRejectedValue(new Error('offline'))
  await useChatsStore.getState().send('first profile', [])
  expect(request.mock.calls[1][1].clientMessageId).not.toBe(oldId)
})

it('does not replace a refreshed head with a page requested from the previous view', async () => {
  const network = { binding: { publicationId: 'binding' }, records: [], cursor: { epoch: 1, seq: 128 }, nextAfter: { epoch: 1, seq: 128 } } as unknown as ChatNetworkProjection
  const old = { ...local(), network }
  useChatsStore.setState({ conversation: old })
  let resolve!: (value: ChatConversation) => void
  request.mockImplementationOnce(() => new Promise<ChatConversation>(done => { resolve = done }))
  const pending = useChatsStore.getState().loadMore()
  const refreshed = { ...old, network: { ...network, cursor: { epoch: 2, seq: 1 }, records: [] } }
  request.mockResolvedValueOnce({ chats: [], agents: [], devices: [] }).mockResolvedValueOnce(refreshed)
  await useChatsStore.getState().refresh()
  resolve({ ...old, network: { ...network, nextAfter: undefined } }); await pending
  expect(useChatsStore.getState().conversation).toBe(refreshed)
  expect(useChatsStore.getState().loading).toBe(false)
})

function paged(count: number, head = count): ChatConversation {
  const records = Array.from({ length: count }, (_, index) => ({ epoch: 1, seq: index + 1, recvTs: index + 1, envelope: { id: `event-${index + 1}`, body: { text: `message ${index + 1}` } } }))
  const network = { binding: { publicationId: 'binding', space: 'space', channel: 'channel', owner: 'owner' }, records, head: { epoch: 1, seq: head }, cursor: { epoch: 1, seq: count }, participants: [], offline: false, readonly: false, ...(head > count ? { nextAfter: { epoch: 1, seq: count } } : {}) } as unknown as ChatNetworkProjection
  return { ...local(), network }
}

it('retains loaded original pages across periodic refresh while adopting current read-only and presence state', async () => {
  useChatsStore.setState({ conversation: paged(256) })
  const first = paged(128, 257)
  first.network!.readonly = true
  first.network!.offline = true
  request.mockResolvedValueOnce({ chats: [], agents: [], devices: [] }).mockResolvedValueOnce(first)
  await useChatsStore.getState().refresh()
  const held = useChatsStore.getState().conversation!.network!
  expect(held.records).toHaveLength(256)
  expect(held.cursor).toEqual({ epoch: 1, seq: 256 })
  expect(held.nextAfter).toEqual({ epoch: 1, seq: 256 })
  expect(held.head).toEqual({ epoch: 1, seq: 257 })
  expect(held.readonly).toBe(true)
  expect(held.offline).toBe(true)
})

it.each(['original', 'receipt', 'binding', 'epoch', 'regression'])('discards retained pages when the refreshed %s disagrees', async reason => {
  useChatsStore.setState({ conversation: paged(256) })
  const first = paged(128, 256)
  if (reason === 'original') first.network!.records[0].envelope.body = { text: 'changed' }
  if (reason === 'receipt') first.network!.records[0].recvTs++
  if (reason === 'binding') first.network!.binding.channel = 'different' as ChatNetworkProjection['binding']['channel']
  if (reason === 'epoch') first.network!.head.epoch = 2
  if (reason === 'regression') first.network!.head.seq = 200
  request.mockResolvedValueOnce({ chats: [], agents: [], devices: [] }).mockResolvedValueOnce(first)
  await useChatsStore.getState().refresh()
  expect(useChatsStore.getState().conversation).toBe(first)
})


it.each(['forbidden', 'cancelled', 'disabled'])('clears an open network view after current authorization or networking is denied (%s)', async code => {
  useChatsStore.setState({ conversation: paged(128) })
  request.mockResolvedValueOnce({ chats: [], agents: [], devices: [] }).mockRejectedValueOnce(Object.assign(new Error('No current read permission'), { code }))
  await useChatsStore.getState().refresh()
  expect(useChatsStore.getState().conversation).toBeNull()
  expect(useChatsStore.getState().error).toContain('No current read permission')
})
