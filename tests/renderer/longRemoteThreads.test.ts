import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forgetMessageImageRequests, hydrateMessageImages, missingImages, resetMessageImageRequests, type MessageImageDeps } from '../../src/renderer/lib/messageImages'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import type { ChatMessage } from '../../src/shared/types'

const message = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'user', content: id, timestamp: `2026-10-27T10:00:${id.padStart(2, '0').slice(-2)}Z`, ...patch }) as ChatMessage
const image = (name: string, data?: string) => ({ name, mimeType: 'image/png', ...(data ? { data } : {}) })

describe('images that come without their bytes', () => {
  it('finds them newest first, and skips the ones that have data', () => {
    const found = missingImages([
      message('1', { images: [image('a.png'), image('b.png', 'AAAA')] }),
      message('2'),
      message('3', { images: [image('c.png'), image('d.png')] })
    ])
    expect(found).toEqual([
      { messageId: '3', index: 0 },
      { messageId: '3', index: 1 },
      { messageId: '1', index: 0 }
    ])
  })

  it('takes at most the newest few', () => {
    const many = Array.from({ length: 40 }, (_, at) => message(String(at + 1), { images: [image(`${at}.png`)] }))
    const found = missingImages(many, 5)
    expect(found.map((entry) => entry.messageId)).toEqual(['40', '39', '38', '37', '36'])
  })

  it('shows one without bytes as a named file, not as a broken picture', () => {
    const [shown] = mousseToUIMessages([message('1', { content: '', images: [image('a.png'), image('b.png', 'AAAA')] })])
    const parts = (shown.parts as unknown as Array<{ type: string; filename?: string; url?: string }>).filter((part) => part.type === 'file')
    expect(parts).toEqual([
      expect.objectContaining({ filename: 'a.png', mediaType: 'image/png' }),
      expect.objectContaining({ filename: 'b.png', url: 'data:image/png;base64,AAAA' })
    ])
    expect(parts[0]).not.toHaveProperty('url')
  })
})

describe('fetching them as the thread is shown', () => {
  let messages: ChatMessage[]
  let active: string | null
  const asked: string[] = []
  const deps = (fetchImage: MessageImageDeps['fetchImage']): MessageImageDeps => ({
    fetchImage,
    shown: () => ({ threadId: active, messages }),
    update: (next) => { messages = messages.map((entry) => (entry.id === next.id ? next : entry)) }
  })
  beforeEach(() => {
    resetMessageImageRequests()
    asked.length = 0
    active = 'nod_a:t'
    messages = [message('1', { images: [image('a.png')] }), message('2', { images: [image('b.png'), image('c.png')] })]
  })

  it('puts each image in its message, one fetch each', async () => {
    await hydrateMessageImages('nod_a:t', deps(async (_thread, id, index) => { asked.push(`${id}:${index}`); return { name: 'x', mimeType: 'image/png', data: `data-${id}-${index}` } }))
    expect(asked.sort()).toEqual(['1:0', '2:0', '2:1'])
    expect(messages.map((entry) => entry.images?.map((one) => one.data))).toEqual([['data-1-0'], ['data-2-0', 'data-2-1']])
  })

  it('asks for an image once, also when the thread is shown again', async () => {
    const fetchImage: MessageImageDeps['fetchImage'] = async (_thread, id, index) => { asked.push(`${id}:${index}`); return { name: 'x', mimeType: 'image/png', data: 'AAAA' } }
    await hydrateMessageImages('nod_a:t', deps(fetchImage))
    await hydrateMessageImages('nod_a:t', deps(fetchImage))
    expect(asked).toHaveLength(3)
  })

  it('leaves an image that cannot be fetched as its name, and still fetches the others', async () => {
    await hydrateMessageImages('nod_a:t', deps(async (_thread, id, index) => {
      if (id === '1') throw new Error('Studio is offline.')
      return { name: 'x', mimeType: 'image/png', data: `data-${id}-${index}` }
    }))
    expect(messages[0].images?.[0].data).toBeUndefined()
    expect(messages[1].images?.map((one) => one.data)).toEqual(['data-2-0', 'data-2-1'])
  })

  it('puts nothing into a thread that is no longer shown', async () => {
    await hydrateMessageImages('nod_a:t', deps(async () => { active = 'other'; return { name: 'x', mimeType: 'image/png', data: 'AAAA' } }))
    expect(messages.flatMap((entry) => entry.images ?? []).every((one) => one.data === undefined)).toBe(true)
  })
})

describe('the older part of a long thread in the window', () => {
  const initial = useAppStore.getInitialState()
  beforeEach(() => {
    useAppStore.setState({ ...initial, activeThreadId: 'nod_a:t', messages: [], earlierByThread: {} })
  })
  afterEach(() => { useAppStore.setState({ ...initial }) })
  const view = (messages: ChatMessage[], earlier?: { before: string; count: number }) =>
    useAppStore.getState().applyThreadView({ threadId: 'nod_a:t', messages, ...(earlier ? { earlier } : {}) })

  it('remembers what a view left out, and forgets it when a view has the whole thread', () => {
    view([message('8'), message('9')], { before: '8', count: 7 })
    expect(useAppStore.getState().earlierByThread['nod_a:t']).toEqual({ before: '8', count: 7 })
    view([message('1'), message('8'), message('9')])
    expect(useAppStore.getState().earlierByThread['nod_a:t']).toBeUndefined()
  })

  it('puts a page of older messages in front, once each, and records what is still left', () => {
    view([message('8'), message('9')], { before: '8', count: 7 })
    useAppStore.getState().applyEarlierMessages('nod_a:t', [message('5'), message('6'), message('7'), message('8')], { before: '5', count: 4 })
    expect(useAppStore.getState().messages.map((entry) => entry.id)).toEqual(['5', '6', '7', '8', '9'])
    expect(useAppStore.getState().earlierByThread['nod_a:t']).toEqual({ before: '5', count: 4 })
    useAppStore.getState().applyEarlierMessages('nod_a:t', [message('1'), message('2'), message('3'), message('4')], undefined)
    expect(useAppStore.getState().messages.map((entry) => entry.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    expect(useAppStore.getState().earlierByThread['nod_a:t']).toBeUndefined()
  })

  it('does not bring the prompt back for messages already loaded when the same view comes again', () => {
    view([message('8'), message('9')], { before: '8', count: 7 })
    useAppStore.getState().applyEarlierMessages('nod_a:t', [message('5'), message('6'), message('7')], { before: '5', count: 4 })
    view([message('8'), message('9')], { before: '8', count: 7 })
    expect(useAppStore.getState().earlierByThread['nod_a:t']).toEqual({ before: '5', count: 4 })
  })

  it('records a page for a thread that is not in view without touching the shown transcript', () => {
    view([message('8'), message('9')])
    useAppStore.getState().applyEarlierMessages('nod_b:t', [message('1')], { before: '1', count: 2 })
    expect(useAppStore.getState().messages.map((entry) => entry.id)).toEqual(['8', '9'])
    expect(useAppStore.getState().earlierByThread['nod_b:t']).toEqual({ before: '1', count: 2 })
  })
})

describe('images that were fetched stay', () => {
  const initial = useAppStore.getInitialState()
  beforeEach(() => { useAppStore.setState({ ...initial, activeThreadId: 'nod_a:t', messages: [], earlierByThread: {} }); resetMessageImageRequests() })
  afterEach(() => { useAppStore.setState({ ...initial }) })

  it('are kept when the thread is read again, which sends them by name', () => {
    const store = useAppStore.getState()
    store.applyThreadView({ threadId: 'nod_a:t', messages: [message('1', { images: [image('a.png'), image('b.png')] })] })
    store.updateMessage({ ...useAppStore.getState().messages[0], images: [image('a.png', 'AAAA'), image('b.png')] })
    // A reconnect, Retry or reopening: the snapshot has no bytes at all.
    useAppStore.getState().applyThreadView({ threadId: 'nod_a:t', messages: [message('1', { images: [image('a.png'), image('b.png')] })] })
    expect(useAppStore.getState().messages[0].images?.map((one) => one.data)).toEqual(['AAAA', undefined])
  })

  it('are never given to an image of another name', () => {
    const store = useAppStore.getState()
    store.applyThreadView({ threadId: 'nod_a:t', messages: [message('1', { images: [image('a.png', 'AAAA')] })] })
    useAppStore.getState().updateMessage(message('1', { images: [image('other.png')], content: 'edited' }))
    expect(useAppStore.getState().messages[0].images).toEqual([image('other.png')])
  })

  it('are asked for again for a thread that is opened again, when the first ask failed', async () => {
    const asked: string[] = []
    let messages = [message('1', { images: [image('a.png')] })]
    const deps = (ok: boolean): MessageImageDeps => ({
      fetchImage: async (_thread, id, index) => { asked.push(`${id}:${index}`); if (!ok) throw new Error('offline'); return { name: 'a.png', mimeType: 'image/png', data: 'AAAA' } },
      shown: () => ({ threadId: 'nod_a:t', messages }),
      update: (next) => { messages = messages.map((entry) => (entry.id === next.id ? next : entry)) }
    })
    await hydrateMessageImages('nod_a:t', deps(false))
    await hydrateMessageImages('nod_a:t', deps(false))
    expect(asked).toEqual(['1:0'])
    forgetMessageImageRequests('nod_a:t')
    await hydrateMessageImages('nod_a:t', deps(true))
    expect(asked).toEqual(['1:0', '1:0'])
    expect(messages[0].images?.[0].data).toBe('AAAA')
  })

  it('are asked for again when the person moved to another thread before they came', async () => {
    let active = 'nod_a:t'
    let messages = [message('1', { images: [image('a.png')] })]
    const deps: MessageImageDeps = {
      fetchImage: async () => { active = 'other'; return { name: 'a.png', mimeType: 'image/png', data: 'AAAA' } },
      shown: () => ({ threadId: active, messages }),
      update: () => undefined
    }
    await hydrateMessageImages('nod_a:t', deps)
    active = 'nod_a:t'
    expect(missingImages(messages)).toHaveLength(1)
    const again: string[] = []
    await hydrateMessageImages('nod_a:t', { ...deps, fetchImage: async (_t, id) => { again.push(id); return { name: 'a.png', mimeType: 'image/png', data: 'AAAA' } } })
    expect(again).toEqual(['1'])
  })
})
