import { afterEach, expect, it, vi } from 'vitest'
import { useChatsStore } from '../../src/renderer/stores/chatsStore'

afterEach(() => { vi.unstubAllGlobals() })

it('reads the chats once more when a change arrives while they are being read', async () => {
  let release: (() => void) | undefined
  let calls = 0
  const request = vi.fn(async (method: string) => {
    if (method !== 'chats.snapshot') return {}
    calls += 1
    if (calls === 1) await new Promise<void>((resolve) => { release = resolve })
    return { agents: [], chats: [{ id: `chat-${calls}` }], devices: [] }
  })
  vi.stubGlobal('window', { mousse: { platformRequest: { request } } })
  useChatsStore.getState().activate('profile-refresh-again')

  const first = useChatsStore.getState().refresh()
  await vi.waitFor(() => expect(release).toBeDefined())
  // Two changes arrive while the first read is still out: they make one more read, not two.
  void useChatsStore.getState().refresh()
  void useChatsStore.getState().refresh()
  release!()
  await first
  await vi.waitFor(() => expect(calls).toBe(2))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(calls).toBe(2)
  expect(useChatsStore.getState().snapshot.chats.map((chat) => chat.id)).toEqual(['chat-2'])
})

it('reads nothing more after a refresh no change interrupted', async () => {
  const request = vi.fn(async () => ({ agents: [], chats: [], devices: [] }))
  vi.stubGlobal('window', { mousse: { platformRequest: { request } } })
  useChatsStore.getState().activate('profile-refresh-once')
  await useChatsStore.getState().refresh()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(request).toHaveBeenCalledTimes(1)
})
