/**
 * Which size a bot's browser page takes, and when, on the host (no browser): the page takes the size of
 * the split view that is seen; with two windows' split views, the one that holds the browser, else the
 * one opened last; a window that only shows the small preview never sizes it; when no split view is
 * seen the page goes back to its default. A resize waits for the bot's step under way without stopping
 * it, and goes ahead of the bot's steps that wait.
 */
import { describe, expect, it } from 'vitest'
import { BotBrowsers, type BotBrowserService } from '../src/mms/bots/browser/BotBrowsers'
import { BrowserTurns, OWNER_CUT_IN_MS } from '../src/mms/browser/viewer/BrowserTurns'
import type { BrowserSessionRecord } from '../src/shared/browser/types'
import { watchedBrowserPageSize, type WatchedBrowserPageSize } from '../src/shared/browser/watched'

const BOT = 'bot-sizes'
const DEFAULT = { width: 1280, height: 720, scale: 1 }

/** The bot's browser on the host, with a worker that keeps the page size it was last given. */
function host() {
  const record: BrowserSessionRecord = { id: 'sess_1', profileId: 'p', threadId: 'home', persistent: true, backend: 'managed-chromium', browserVersion: '1', generation: 1, lifecycle: 'agent-controlled', createdAt: '', updatedAt: '' }
  const sizes: WatchedBrowserPageSize[] = []
  const service = {
    sessions: {
      trustedSessionScope: () => ({ threadId: 'home', record: { ...record } }),
      control: async (_context: unknown, _sessionId: string, owner: 'agent' | 'human') => {
        record.lifecycle = owner === 'human' ? 'human-controlled' : 'agent-controlled'
        return {}
      },
      humanInput: async () => ({}),
      humanInputs: async () => [],
      viewerNext: () => new Promise(() => undefined),
      viewerStop: async () => undefined,
      resizePage: async (_context: unknown, input: { page: WatchedBrowserPageSize }) => {
        sizes.push(input.page)
        return input.page
      },
      retireViewerBudget: () => undefined,
      close: async () => { record.lifecycle = 'closed' }
    },
    tools: { invoke: async () => ({ ok: true, value: { session: { id: 'sess_1' }, observation: { tabId: 'tab_1' } } }) },
    artifacts: {},
    workspaceDataDir: () => '/nowhere'
  } as unknown as BotBrowserService
  const bots = new BotBrowsers({ profileId: 'p', browser: () => service, homeThread: () => 'home', setTimer: () => ({ clear: () => undefined }), computerName: 'Desk' })
  /** A window's view: its split view at `page`, or its small preview with none. */
  const watch = (window: string, page?: WatchedBrowserPageSize) =>
    bots.watch(BOT, `w-${window}`, { width: page ? page.width : 480, fps: 15, connectionId: `c-${window}`, viewId: window, ...(page ? { page } : {}), emit: async () => undefined })
  /** The page's size now: the last one the worker was given. */
  const size = () => sizes.at(-1) ?? DEFAULT
  return { bots, sizes, size, watch }
}

const tall = { width: 790, height: 1070, scale: 1 }
const wide = { width: 900, height: 600, scale: 2 }

describe('the size a bot\'s browser page takes', () => {
  it('is the split view\'s while it is seen, and the default again once it is not; the small preview never sizes it', async () => {
    const { bots, sizes, size, watch } = host()
    await bots.open(BOT, undefined, { viewId: 'one' })
    await bots.hold(BOT, 'one', { op: 'release', holdId: (await bots.view(BOT, { viewId: 'one' })).hold!.id })
    await watch('one')
    expect(sizes).toEqual([])
    await watch('one', tall)
    await expect.poll(size).toEqual(tall)
    // The divider dragged: the latest size, once.
    await watch('one', { ...tall, width: 700 })
    await expect.poll(size).toEqual({ ...tall, width: 700 })
    // The split view closes and the reply's preview shows again.
    await watch('one')
    await expect.poll(size).toEqual(DEFAULT)
    await watch('one', tall)
    await expect.poll(size).toEqual(tall)
    // The window goes away altogether.
    bots.unwatch(BOT, 'w-one', 'c-one')
    await expect.poll(size).toEqual(DEFAULT)
  })

  it('with two windows\' split views, is the one that holds the browser, else the one opened last; the other\'s going changes nothing', async () => {
    const { bots, size, watch } = host()
    await watch('one', tall)
    await bots.open(BOT, undefined, { viewId: 'one' })
    const held = (await bots.view(BOT, { viewId: 'one' })).hold!
    await bots.hold(BOT, 'one', { op: 'release', holdId: held.id })
    await expect.poll(size).toEqual(tall)
    // The second window opens its split view last: its size.
    await watch('two', wide)
    await expect.poll(size).toEqual(wide)
    // The first window resizes its split view: the second still opened last.
    await watch('one', { ...tall, height: 900 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(size()).toEqual(wide)
    // The first takes the browser over: its size, whoever opened last.
    await bots.hold(BOT, 'one', { op: 'take' })
    await expect.poll(size).toEqual({ ...tall, height: 900 })
    // The second window closes its split view: nothing changes.
    await watch('two')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(size()).toEqual({ ...tall, height: 900 })
  })
})

describe('the bounds of the size a view asks for', () => {
  it.each([
    ['a tall split view on a 1.5 screen', { width: 790, height: 1070, scale: 1.5 }, { width: 790, height: 1070, scale: 1.5 }],
    ['narrower and shorter than any page', { width: 120, height: 90, scale: 1 }, { width: 320, height: 240, scale: 1 }],
    ['larger than any page', { width: 4000, height: 3000, scale: 1 }, { width: 1920, height: 2160, scale: 1 }],
    ['a 3x screen: at most 2', { width: 600, height: 800, scale: 3 }, { width: 600, height: 800, scale: 2 }],
    ['a picture over 1920 across: the ratio comes down, in quarters', { width: 1400, height: 600, scale: 2 }, { width: 1400, height: 600, scale: 1.25 }],
    ['a ratio below 1 (zoomed out)', { width: 800, height: 600, scale: 0.8 }, { width: 800, height: 600, scale: 1 }],
    ['no size: the default', {}, DEFAULT]
  ])('%s', (_name, asked, page) => {
    expect(watchedBrowserPageSize(asked)).toEqual(page)
  })
})

describe('a resize in the browser\'s turn', () => {
  it('waits for the bot\'s step under way without stopping it, and goes ahead of the bot\'s steps that wait', async () => {
    const turns = new BrowserTurns()
    const order: string[] = []
    let finish!: () => void
    const step = turns.run(async (held) => {
      order.push('step starts')
      await new Promise<void>((resolve) => { finish = resolve })
      order.push(held.aborted ? 'step stopped' : 'step ends')
    }, { yields: true })
    const next = turns.run(async () => { order.push('next step') })
    const resize = turns.personCall(async () => { order.push('resize') }, { busy: () => new Error('busy') })
    // Well past the moment after which a person's input would stop the bot's step.
    await new Promise((resolve) => setTimeout(resolve, OWNER_CUT_IN_MS * 3))
    expect(order).toEqual(['step starts'])
    finish()
    await Promise.all([step, next, resize])
    expect(order).toEqual(['step starts', 'step ends', 'resize', 'next step'])
  })
})
