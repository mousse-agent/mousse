/**
 * The owner's hold of a bot's browser and its input channel, on the host (no browser): each numbered
 * input is applied once, in order, and answered; a gap waits a moment, then what waits behind it is
 * refused without using its number up; a view that holds the browser is the only one that sends input,
 * keeps it with a heartbeat and picks it up again after a reconnect; a hold whose view went away ends
 * after its lease, with what the person left pressed let go of and one line in the bot's chat; a
 * second window takes it over only on purpose; a click on a picture the page no longer shows is
 * refused, and so is the typing that followed it; a Mac view's Command is the page's Control elsewhere.
 */
import { describe, expect, it } from 'vitest'
import { InputSequencer } from '../src/mms/bots/browser/InputSequencer'
import { BotBrowsers, HOLD_EXPIRED_NOTICE, inputForPage, type BotBrowserService } from '../src/mms/bots/browser/BotBrowsers'
import { BrowserAutomationError } from '../src/mms/browser/automation/BrowserSessionManager'
import { BROWSER_MODIFIERS, type BrowserHumanInput, type BrowserHumanInputResult, type BrowserPictureSpot, type BrowserSessionRecord, type BrowserViewerUpdate } from '../src/shared/browser/types'
import type { BotBrowserAck, BotBrowserFrameEvent, BotBrowserInput, BotBrowserSent } from '../src/shared/bots/personal/browser'

/** Timers the test fires by hand. */
function manualTimers() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return { clear: () => { timer.cleared = true } }
    },
    fireAll: () => {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn()
    }
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the hold\'s input channel', () => {
  const sequencer = (options: { refuse?: (item: string) => boolean; lastSeq?: number } = {}) => {
    const applied: string[] = []
    const time = manualTimers()
    const channel = new InputSequencer<string>({
      apply: async (item) => {
        applied.push(item)
        return options.refuse?.(item) ? { status: 'refused', reason: 'page-changed', text: 'Page changed · click again' } : { status: 'applied' }
      },
      setTimer: time.setTimer,
      ...(options.lastSeq !== undefined ? { lastSeq: options.lastSeq } : {})
    })
    return { channel, applied, time }
  }

  it('applies each input once, in number order, however they arrive, and answers each', async () => {
    const { channel, applied } = sequencer()
    const third = channel.submit(3, 'c')
    const first = channel.submit(1, 'a')
    const second = channel.submit(2, 'b')
    expect(await Promise.all([first, second, third])).toEqual([{ seq: 1, status: 'applied' }, { seq: 2, status: 'applied' }, { seq: 3, status: 'applied' }])
    expect(applied).toEqual(['a', 'b', 'c'])
    expect(channel.lastSeq).toBe(3)
  })

  it('answers a resend as a duplicate, with what the first answer said, and never applies it again', async () => {
    const { channel, applied } = sequencer({ refuse: (item) => item === 'b' })
    await channel.submit(1, 'a')
    expect(await channel.submit(2, 'b')).toMatchObject({ status: 'refused', reason: 'page-changed' })
    expect(await channel.submit(1, 'a')).toEqual({ seq: 1, status: 'duplicate' })
    expect(await channel.submit(2, 'b')).toEqual({ seq: 2, status: 'duplicate', reason: 'page-changed', text: 'Page changed · click again' })
    expect(applied).toEqual(['a', 'b'])
  })

  it('waits for a missing input a moment: a gap that fills goes on in order', async () => {
    const { channel, applied, time } = sequencer()
    const later = channel.submit(2, 'b')
    await tick()
    expect(applied).toEqual([])
    expect(time.timers[0]!.ms).toBe(250)
    const first = channel.submit(1, 'a')
    expect(await Promise.all([first, later])).toMatchObject([{ status: 'applied' }, { status: 'applied' }])
    expect(applied).toEqual(['a', 'b'])
  })

  it('refuses what waits behind a gap that does not fill, without using its number up', async () => {
    const { channel, applied, time } = sequencer()
    await channel.submit(1, 'a')
    const waiting = channel.submit(3, 'c')
    time.fireAll()
    expect(await waiting).toMatchObject({ seq: 3, status: 'refused', reason: 'gap' })
    expect(channel.lastSeq).toBe(1)
    // The sender sends the missing one, and that one again: both go, in order.
    await channel.submit(2, 'b')
    expect(await channel.submit(3, 'c')).toMatchObject({ status: 'applied' })
    expect(applied).toEqual(['a', 'b', 'c'])
  })

  it('a hold picked up again goes on after the host\'s last number; a closed one refuses what waits and what comes', async () => {
    const { channel, applied } = sequencer({ lastSeq: 7 })
    expect(await channel.submit(7, 'old')).toMatchObject({ status: 'duplicate' })
    expect(await channel.submit(8, 'h')).toMatchObject({ status: 'applied' })
    const waiting = channel.submit(10, 'j')
    await channel.close('not-held', 'Held in another window')
    expect(await waiting).toEqual({ seq: 10, status: 'refused', reason: 'not-held', text: 'Held in another window' })
    expect(await channel.submit(9, 'i')).toMatchObject({ status: 'refused', reason: 'not-held' })
    expect(applied).toEqual(['h'])
  })
})

describe('a view\'s Command and Control on the page\'s platform', () => {
  const keyA = (modifiers: number): BotBrowserInput => ({ kind: 'keys', type: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers })
  it('maps a Mac view\'s Command to Control on a page elsewhere, and the other way round, with the editing command', () => {
    expect(inputForPage(keyA(BROWSER_MODIFIERS.meta), 'mac', false)).toMatchObject({ modifiers: BROWSER_MODIFIERS.ctrl, command: 'selectAll' })
    expect(inputForPage(keyA(BROWSER_MODIFIERS.ctrl), 'other', true)).toMatchObject({ modifiers: BROWSER_MODIFIERS.meta, command: 'selectAll' })
    expect(inputForPage(keyA(BROWSER_MODIFIERS.meta), 'mac', true)).toMatchObject({ modifiers: BROWSER_MODIFIERS.meta, command: 'selectAll' })
    // Control on a Mac page is not the shortcut key there: no command.
    expect(inputForPage(keyA(BROWSER_MODIFIERS.ctrl), 'mac', true)).not.toHaveProperty('command')
    const redo = inputForPage({ kind: 'keys', type: 'down', key: 'z', code: 'KeyZ', keyCode: 90, modifiers: BROWSER_MODIFIERS.ctrl | BROWSER_MODIFIERS.shift }, 'other', false)
    expect(redo).toMatchObject({ command: 'redo' })
    expect(inputForPage({ kind: 'keys', type: 'down', key: 'b', code: 'KeyB', keyCode: 66, modifiers: BROWSER_MODIFIERS.meta }, 'mac', false)).toMatchObject({ modifiers: BROWSER_MODIFIERS.ctrl })
  })
})

/** The bot's browser as the host sees it, with a worker that answers as the test says. */
function host(options: { results?: (input: BrowserHumanInput, entry: { spot?: BrowserPictureSpot; stale?: true }) => BrowserHumanInputResult; update?: BrowserViewerUpdate } = {}) {
  let now = 1_000_000
  const lease = manualTimers()
  const record: BrowserSessionRecord = { id: 'sess_1', profileId: 'p', threadId: 'home', persistent: true, backend: 'managed-chromium', browserVersion: '1', generation: 1, lifecycle: 'agent-controlled', createdAt: '', updatedAt: '' }
  const worker: Array<{ method: string; args: unknown }> = []
  const notices: string[] = []
  let gave = false
  const service = {
    sessions: {
      trustedSessionScope: () => ({ threadId: 'home', record: { ...record } }),
      control: async (_context: unknown, _sessionId: string, owner: 'agent' | 'human', opts?: unknown) => {
        worker.push({ method: 'control', args: { owner, ...(opts as object) } })
        record.lifecycle = owner === 'human' ? 'human-controlled' : 'agent-controlled'
        return {}
      },
      humanInput: async (_context: unknown, input: { input: BrowserHumanInput }) => {
        worker.push({ method: 'humanInput', args: input.input })
        return {}
      },
      humanInputs: async (_context: unknown, input: { inputs: Array<{ input: BrowserHumanInput; spot?: BrowserPictureSpot; stale?: true }> }) => {
        worker.push({ method: 'humanInputs', args: input.inputs })
        return input.inputs.map((entry) => options.results?.(entry.input, entry) ?? { applied: true })
      },
      viewerNext: async () => {
        if (options.update && !gave) {
          gave = true
          return options.update
        }
        return new Promise(() => undefined)
      },
      viewerStop: async () => undefined,
      retireViewerBudget: () => undefined,
      close: async () => { record.lifecycle = 'closed' }
    },
    tools: { invoke: async () => ({ ok: true, value: { session: { id: 'sess_1' }, observation: { tabId: 'tab_1' } } }) },
    artifacts: {},
    workspaceDataDir: () => '/nowhere'
  } as unknown as BotBrowserService
  const bots = new BotBrowsers({ profileId: 'p', browser: () => service, homeThread: () => 'home', now: () => now, setTimer: () => ({ clear: () => undefined }), leaseTimer: lease.setTimer, holdLeaseMs: 120_000, computerName: 'Desk' })
  bots.setNotice((_botId, text) => notices.push(text))
  /** A window's view of the bot's browser: what it was pushed. */
  const window = async (viewId: string) => {
    const events: BotBrowserFrameEvent[] = []
    await bots.watch('bot-hold', `w-${viewId}`, { width: 960, fps: 15, connectionId: `c-${viewId}`, viewId, emit: async (event) => { events.push(event) } })
    return events
  }
  return { bots, worker, notices, lease, record, window, advance: (ms: number) => { now += ms } }
}
const inputs = (worker: Array<{ method: string; args: unknown }>) => worker.filter((call) => call.method === 'humanInputs').flatMap((call) => (call.args as Array<{ input: BrowserHumanInput }>).map((entry) => entry.input))

describe('the owner\'s hold of a bot\'s browser', () => {
  it('belongs to the view that took it: another window is told, and takes it over only on purpose', async () => {
    const { bots, worker, window } = host()
    const one = await window('one')
    const two = await window('two')
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one', platform: 'mac' })
    expect(hold).toEqual({ id: expect.stringMatching(/^hold_/), lastSeq: 0, computer: 'Desk' })
    expect(worker.find((call) => call.method === 'control')!.args).toMatchObject({ owner: 'human', tabId: 'tab_1', chooser: true })
    // Every view hears who holds it at once.
    await expect.poll(() => two.some((event) => event.holder === 'another-view')).toBe(true)
    expect(one.some((event) => event.holder === 'this-view')).toBe(true)
    expect((await bots.view('bot-hold', { viewId: 'two' })).holder).toBe('another-view')
    // The second window's Take over is refused unless it means it.
    await expect(bots.hold('bot-hold', 'two', { op: 'take' })).rejects.toMatchObject({ code: 'held_elsewhere', message: 'Held in another window.' })
    const taken = await bots.hold('bot-hold', 'two', { op: 'take', force: true })
    expect(taken.hold!.id).not.toBe(hold!.id)
    // What the first left pressed is let go of; the browser stays the owner's.
    expect(worker.filter((call) => call.method === 'humanInput').map((call) => call.args)).toEqual([{ kind: 'release' }])
    expect(worker.filter((call) => call.method === 'control')).toHaveLength(1)
    await expect.poll(() => one.some((event) => event.holdEnded === 'taken') && one.some((event) => event.holder === 'another-view')).toBe(true)
    // The first window's input is refused from now on; the second's goes.
    expect((await bots.send('bot-hold', 'one', hold!.id, [{ seq: 1, input: { kind: 'type', text: 'x' } }])).acks).toEqual([{ seq: 1, status: 'refused', reason: 'not-held', text: 'Held in another window' }])
    expect((await bots.send('bot-hold', 'two', taken.hold!.id, [{ seq: 1, input: { kind: 'type', text: 'y' } }])).acks).toEqual([{ seq: 1, status: 'applied' }])
    expect(inputs(worker)).toEqual([{ kind: 'type', text: 'y' }])
  })

  it('lasts while its view says it is there; a view gone for two minutes lets go, the bot has it back, and its chat says so once', async () => {
    const { bots, worker, notices, lease, record, advance, window } = host()
    const events = await window('one')
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one' })
    // A heartbeat at one minute keeps it past the first two minutes.
    advance(60_000)
    await bots.hold('bot-hold', 'one', { op: 'renew', holdId: hold!.id })
    advance(60_000)
    lease.fireAll()
    await tick()
    expect(record.lifecycle).toBe('human-controlled')
    expect(notices).toEqual([])
    // Then nothing for two minutes: it ends.
    advance(120_000)
    lease.fireAll()
    await expect.poll(() => record.lifecycle).toBe('agent-controlled')
    expect(worker.filter((call) => call.method === 'control').map((call) => (call.args as { owner: string }).owner)).toEqual(['human', 'agent'])
    expect(notices).toEqual([HOLD_EXPIRED_NOTICE])
    await expect.poll(() => events.some((event) => event.holdEnded === 'expired')).toBe(true)
    await expect(bots.hold('bot-hold', 'one', { op: 'renew', holdId: hold!.id })).rejects.toBeInstanceOf(BrowserAutomationError)
  })

  it('a view that reconnects picks its hold up again at the host\'s last number: what it sends again is not applied twice', async () => {
    const { bots, worker } = host()
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one' })
    const typed = (text: string, seq: number): BotBrowserSent => ({ seq, input: { kind: 'type', text } })
    await bots.send('bot-hold', 'one', hold!.id, [typed('a', 1), typed('b', 2), typed('c', 3)])
    const again = await bots.hold('bot-hold', 'one', { op: 'take' })
    expect(again.hold).toEqual({ id: hold!.id, lastSeq: 3, computer: 'Desk' })
    const acks = (await bots.send('bot-hold', 'one', hold!.id, [typed('c', 3), typed('d', 4)])).acks
    expect(acks.map((ack: BotBrowserAck) => ack.status)).toEqual(['duplicate', 'applied'])
    expect(inputs(worker).map((input) => (input as { text: string }).text)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('gives back: the browser is the bot\'s, with no line in its chat', async () => {
    const { bots, record, notices } = host()
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one' })
    await bots.hold('bot-hold', 'one', { op: 'release', holdId: hold!.id })
    expect(record.lifecycle).toBe('agent-controlled')
    expect(notices).toEqual([])
  })

  it('sends a point with where its picture was taken; refuses one on a picture it no longer knows, and the typing that followed it', async () => {
    const spot = { documentId: 'doc_page-a', scrollX: 0, scrollY: 120 }
    const update: BrowserViewerUpdate = { tabId: 'tab_1', url: 'https://a.test/', title: 'A', viewport: { width: 1280, height: 720 }, behind: false, frameSeq: 1, stateSeq: 1, picture: { data: '/9j/', width: 960, height: 540, at: 1, sharp: false, spot } }
    const { bots, worker, window } = host({ update, results: (_input, entry) => entry.stale ? { applied: false, code: 'page_changed', message: 'The page changed since that picture' } : { applied: true } })
    const events = await window('one')
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one' })
    await expect.poll(() => events.some((event) => event.frame?.id === 1)).toBe(true)
    const down = (picture: number, seq: number): BotBrowserSent => ({ seq, picture, input: { kind: 'pointer', type: 'down', x: 10, y: 10, button: 'left', buttons: 1, clicks: 1 } })
    const key = (picture: number, seq: number): BotBrowserSent => ({ seq, picture, input: { kind: 'keys', type: 'down', key: 'h', code: 'KeyH', keyCode: 72, modifiers: 0, text: 'h' } })
    expect((await bots.send('bot-hold', 'one', hold!.id, [down(1, 1)])).acks[0]!.status).toBe('applied')
    const sent = worker.filter((call) => call.method === 'humanInputs').at(-1)!.args as Array<{ spot?: BrowserPictureSpot }>
    expect(sent[0]!.spot).toEqual(spot)
    // A picture the host never sent (or long gone): refused, and the keys typed after it on that picture too.
    const acks = (await bots.send('bot-hold', 'one', hold!.id, [down(9, 2), key(9, 3), key(9, 4)])).acks
    expect(acks.map((ack) => [ack.status, ack.reason])).toEqual([['refused', 'page-changed'], ['refused', 'page-changed'], ['refused', 'page-changed']])
    expect(acks[0]!.text).toBe('Page changed · click again')
    // The keys never reached the page.
    expect(inputs(worker).filter((input) => input.kind === 'keys')).toEqual([])
  })
})
