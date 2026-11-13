// @vitest-environment jsdom
/**
 * A bot chat the window holds reads its newest rows again when the window's service connection was opened again
 * (#1042): a restarted service replays only what it sent since it started, so rows sent meanwhile were never heard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, message, summary } from './fakeBotsClient'

const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const botsInitial = useBotsStore.getInitialState()

afterEach(() => {
  setBotsClient(null)
  useBotsStore.setState(botsInitial)
})

describe('a bot chat after the window reconnects', () => {
  it('adds the rows it missed, once, and leaves chats it never opened alone', async () => {
    const fake = fakeBots({ bots: [summary('inbox'), summary('other')], chats: { inbox: [message(1), message(2)], other: [message(5)] } })
    installPreload(fake)
    setBotsClient(fake.client)
    useBotsStore.getState().activate('p1')
    await useBotsStore.getState().loadChat('inbox')
    expect(useBotsStore.getState().chats.inbox?.messages.map((row) => row.id)).toEqual(['m1', 'm2'])

    // A row sent while the window's connection was down: the window never heard of it.
    fake.chats.inbox = [...fake.chats.inbox!, message(3)]
    fake.emit.reread()
    await vi.waitFor(() => expect(useBotsStore.getState().chats.inbox?.messages.map((row) => row.id)).toEqual(['m1', 'm2', 'm3']))
    expect(fake.calls.filter(([name, botId]) => name === 'messages' && botId === 'other')).toEqual([])
  })
})
