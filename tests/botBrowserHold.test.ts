/**
 * The owner's hold of a bot's browser and its input channel, on the host (no browser): each numbered
 * input is applied once, in order, and answered; a gap waits a moment, then what waits behind it is
 * refused without using its number up; a view that holds the browser is the only one that sends input,
 * keeps it with a heartbeat and picks it up again after a reconnect; a hold whose view went away ends
 * after its lease, with what the person left pressed let go of and one line in the bot's chat; a
 * second window takes it over only on purpose; a click on a picture the page no longer shows is
 * refused, and so is the typing that followed it; a Mac view's Command is the page's Control elsewhere.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('too much waiting is refused as busy without using its number: sent again, it goes in order', async () => {
    const applied: string[] = []
    let open!: () => void
    const blocked = new Promise<void>((resolve) => { open = resolve })
    const channel = new InputSequencer<string>({
      apply: async (item) => {
        if (item === 'a') await blocked
        applied.push(item)
        return { status: 'applied' }
      },
      maxWaiting: 1,
      setTimer: manualTimers().setTimer
    })
    const first = channel.submit(1, 'a')
    const second = channel.submit(2, 'b')
    expect(await channel.submit(3, 'c')).toEqual({ seq: 3, status: 'refused', reason: 'busy', text: 'Too much at once' })
    open()
    await Promise.all([first, second])
    expect(channel.lastSeq).toBe(2)
    expect(await channel.submit(3, 'c')).toEqual({ seq: 3, status: 'applied' })
    expect(applied).toEqual(['a', 'b', 'c'])
  })

  it('remembers the outcome of a copy for a duplicate, never the text it read', async () => {
    const channel = new InputSequencer<string>({ apply: async () => ({ status: 'applied', copied: 'secret words' }), setTimer: manualTimers().setTimer })
    expect(await channel.submit(1, 'copy')).toEqual({ seq: 1, status: 'applied', copied: 'secret words' })
    expect(await channel.submit(1, 'copy')).toEqual({ seq: 1, status: 'duplicate' })
    expect(JSON.stringify(channel)).not.toContain('secret words')
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

/** The bot's browser as the host sees it, with a worker that answers as the test says (and sends `updates`, one a call, then waits). */
function host(options: { results?: (input: BrowserHumanInput, entry: { spot?: BrowserPictureSpot }) => BrowserHumanInputResult; update?: BrowserViewerUpdate; updates?: () => Promise<BrowserViewerUpdate | undefined> } = {}) {
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
      humanInputs: async (_context: unknown, input: { inputs: Array<{ input: BrowserHumanInput; spot?: BrowserPictureSpot }> }) => {
        worker.push({ method: 'humanInputs', args: input.inputs })
        return input.inputs.map((entry) => options.results?.(entry.input, entry) ?? { applied: true })
      },
      viewerNext: async () => {
        if (options.update && !gave) {
          gave = true
          return options.update
        }
        const next = await options.updates?.()
        if (next) return next
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

  it('a window that reloads keeps its connection and picks its hold up from the view at the host\'s last number: nothing is applied twice', async () => {
    const { bots, worker } = host()
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one', connectionId: 'c1' })
    const typed = (text: string, seq: number): BotBrowserSent => ({ seq, input: { kind: 'type', text } })
    await bots.send('bot-hold', 'one', hold!.id, [typed('a', 1), typed('b', 2), typed('c', 3)], 'c1')
    // The reloaded page asks what it holds, on its own connection: the hold, at the host's last number.
    expect((await bots.view('bot-hold', { viewId: 'one', connectionId: 'c1' })).hold).toEqual({ id: hold!.id, lastSeq: 3, computer: 'Desk' })
    // Another connection that names the same view is not told the hold.
    expect((await bots.view('bot-hold', { viewId: 'one', connectionId: 'c9' })).hold).toBeUndefined()
    const acks = (await bots.send('bot-hold', 'one', hold!.id, [typed('c', 3), typed('d', 4)], 'c1')).acks
    expect(acks.map((ack: BotBrowserAck) => ack.status)).toEqual(['duplicate', 'applied'])
    expect(inputs(worker).map((input) => (input as { text: string }).text)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is bound to the connection that took it: a window back on a new connection presents it there and it moves, once; the old connection never has it again', async () => {
    const { bots, worker } = host()
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one', connectionId: 'c1' })
    const typed = (text: string, seq: number): BotBrowserSent => ({ seq, input: { kind: 'type', text } })
    expect((await bots.send('bot-hold', 'one', hold!.id, [typed('a', 1)], 'c1')).acks[0]!.status).toBe('applied')
    // The window's connection dropped; it renews on its new one with the hold it has: the hold moves there.
    expect((await bots.hold('bot-hold', 'one', { op: 'renew', holdId: hold!.id }, 'c2')).hold).toMatchObject({ id: hold!.id, lastSeq: 1 })
    expect((await bots.send('bot-hold', 'one', hold!.id, [typed('b', 2)], 'c2')).acks[0]!.status).toBe('applied')
    // The old connection is refused, and cannot take it back by naming it.
    expect((await bots.send('bot-hold', 'one', hold!.id, [typed('x', 3)], 'c1')).acks[0]).toMatchObject({ status: 'refused', reason: 'not-held' })
    await expect(bots.hold('bot-hold', 'one', { op: 'renew', holdId: hold!.id }, 'c1')).rejects.toMatchObject({ code: 'hold_ended' })
    await bots.hold('bot-hold', 'one', { op: 'release', holdId: hold!.id }, 'c1')
    expect((await bots.send('bot-hold', 'one', hold!.id, [typed('c', 3)], 'c2')).acks[0]!.status).toBe('applied')
    expect(inputs(worker).map((input) => (input as { text: string }).text)).toEqual(['a', 'b', 'c'])
  })

  it('a repeated Take over from the same window gives a fresh hold: what the old channel waited on is dropped, and the count starts again', async () => {
    const { bots, worker } = host()
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one' })
    const typed = (text: string, seq: number): BotBrowserSent => ({ seq, input: { kind: 'type', text } })
    await bots.send('bot-hold', 'one', hold!.id, [typed('a', 1)])
    // A hole the old channel would wait on: number 2 never came, 3 waits for it.
    const stuck = bots.send('bot-hold', 'one', hold!.id, [typed('c', 3)])
    const again = await bots.hold('bot-hold', 'one', { op: 'take' })
    expect(again.hold!.id).not.toBe(hold!.id)
    expect(again.hold!.lastSeq).toBe(0)
    expect((await stuck).acks[0]).toMatchObject({ status: 'refused', reason: 'not-held', text: 'You took the browser over again' })
    expect((await bots.send('bot-hold', 'one', again.hold!.id, [typed('d', 1)])).acks[0]!.status).toBe('applied')
    expect(inputs(worker).map((input) => (input as { text: string }).text)).toEqual(['a', 'd'])
    // The browser stayed the owner's throughout.
    expect(worker.filter((call) => call.method === 'control').map((call) => (call.args as { owner: string }).owner)).toEqual(['human'])
  })

  it('open from a second window does not take the browser: "Held in another window"', async () => {
    const { bots } = host()
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one' })
    await expect(bots.open('bot-hold', 'https://b.test/', { viewId: 'two', connectionId: 'c2' })).rejects.toMatchObject({ code: 'held_elsewhere', message: 'Held in another window.' })
    expect((await bots.hold('bot-hold', 'one', { op: 'renew', holdId: hold!.id })).hold!.id).toBe(hold!.id)
  })

  it('a skip uses its number and applies nothing, so what follows goes on', async () => {
    const { bots, worker } = host()
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one' })
    const acks = (await bots.send('bot-hold', 'one', hold!.id, [{ seq: 1, skip: true }, { seq: 2, input: { kind: 'type', text: 'b' } }])).acks
    expect(acks).toEqual([{ seq: 1, status: 'refused', reason: 'skipped', text: 'Skipped' }, { seq: 2, status: 'applied' }])
    expect(inputs(worker)).toEqual([{ kind: 'type', text: 'b' }])
  })

  it('gives back: the browser is the bot\'s, with no line in its chat', async () => {
    const { bots, record, notices } = host()
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one' })
    await bots.hold('bot-hold', 'one', { op: 'release', holdId: hold!.id })
    expect(record.lifecycle).toBe('agent-controlled')
    expect(notices).toEqual([])
  })

  it('sends a point with where its picture was taken; a press or a key on a picture it cannot place is refused here and never reaches the page', async () => {
    const spot = { documentId: 'doc_page-a', scrollX: 0, scrollY: 120 }
    const update: BrowserViewerUpdate = { tabId: 'tab_1', url: 'https://a.test/', title: 'A', viewport: { width: 1280, height: 720 }, behind: false, frameSeq: 1, stateSeq: 1, picture: { data: '/9j/', width: 960, height: 540, at: 1, sharp: false, spot } }
    // A worker that applies whatever it is given: the host alone keeps the unplaced input from the page.
    const { bots, worker, window } = host({ update })
    const events = await window('one')
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one' })
    await expect.poll(() => events.some((event) => event.frame?.id === 1)).toBe(true)
    const down = (picture: number | undefined, seq: number): BotBrowserSent => ({ seq, ...(picture !== undefined ? { picture } : {}), input: { kind: 'pointer', type: 'down', x: 10, y: 10, button: 'left', buttons: 1, clicks: 1 } })
    const key = (picture: number, seq: number): BotBrowserSent => ({ seq, picture, input: { kind: 'keys', type: 'down', key: 'h', code: 'KeyH', keyCode: 72, modifiers: 0, text: 'h' } })
    expect((await bots.send('bot-hold', 'one', hold!.id, [down(1, 1)])).acks[0]!.status).toBe('applied')
    const sent = worker.filter((call) => call.method === 'humanInputs').at(-1)!.args as Array<{ spot?: BrowserPictureSpot }>
    expect(sent[0]!.spot).toEqual(spot)
    const before = inputs(worker).length
    // A picture the host never sent (or long gone), and a press with no picture at all: refused, and the keys typed after them too.
    const acks = (await bots.send('bot-hold', 'one', hold!.id, [down(9, 2), key(9, 3), key(9, 4), down(undefined, 5)])).acks
    expect(acks.map((ack) => [ack.status, ack.reason, ack.text])).toEqual(Array(4).fill(['refused', 'page-changed', 'Page changed · click again']))
    // None of them reached the worker.
    expect(inputs(worker)).toHaveLength(before)
    // A button let go of still goes (without a place): the worker lets it go where the pointer is.
    expect((await bots.send('bot-hold', 'one', hold!.id, [{ seq: 6, picture: 9, input: { kind: 'pointer', type: 'up', x: 10, y: 10, button: 'left', buttons: 0, clicks: 1 } }])).acks[0]!.status).toBe('applied')
    expect(worker.filter((call) => call.method === 'humanInputs').at(-1)!.args).toEqual([{ input: { kind: 'pointer', type: 'up', x: 10, y: 10, button: 'left', buttons: 0, clicks: 1 } }])
  })

  it('remembers pictures by time as well as by count: one sent 100 pictures ago within five seconds is still placed; one older than that is not', async () => {
    let next = 0
    const picture = (): BrowserViewerUpdate => ({ tabId: 'tab_1', url: 'https://a.test/', title: 'A', viewport: { width: 1280, height: 720 }, behind: false, frameSeq: ++next, stateSeq: 1, picture: { data: `/9j/${next}`, width: 960, height: 540, at: next, sharp: false, spot: { documentId: 'doc_page-a', scrollX: 0, scrollY: next } } })
    // The page paints 100 pictures, 30 ms apart; later 40 more.
    let sending = 100
    let more: (() => void) | undefined
    const { bots, worker, window, advance } = host({ updates: async () => {
      if (!sending) await new Promise<void>((resolve) => { more = resolve })
      sending -= 1
      advance(30)
      return picture()
    } })
    const events = await window('one')
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one' })
    await expect.poll(() => Math.max(0, ...events.map((event) => event.frame?.id ?? 0))).toBe(100)
    const press = (seq: number, at: number): BotBrowserSent => ({ seq, picture: at, input: { kind: 'pointer', type: 'down', x: 10, y: 10, button: 'left', buttons: 1, clicks: 1 } })
    // 100 pictures in three seconds: the first is still placed.
    expect((await bots.send('bot-hold', 'one', hold!.id, [press(1, 1)])).acks[0]!.status).toBe('applied')
    expect((worker.filter((call) => call.method === 'humanInputs').at(-1)!.args as Array<{ spot?: BrowserPictureSpot }>)[0]!.spot!.scrollY).toBe(1)
    // Ten seconds and 40 more pictures later, it is gone (the last 32 and the last five seconds are kept).
    advance(10_000)
    sending = 40
    more?.()
    await expect.poll(() => Math.max(0, ...events.map((event) => event.frame?.id ?? 0))).toBe(140)
    expect((await bots.send('bot-hold', 'one', hold!.id, [press(2, 1)])).acks[0]).toMatchObject({ status: 'refused', reason: 'page-changed' })
    expect((await bots.send('bot-hold', 'one', hold!.id, [press(3, 140 - 31)])).acks[0]!.status).toBe('applied')
  })

  it('typing on a picture whose click was refused is refused, until a later click on that picture lands', async () => {
    const spot = { documentId: 'doc_page-a', scrollX: 0, scrollY: 0 }
    const update: BrowserViewerUpdate = { tabId: 'tab_1', url: 'https://a.test/', title: 'A', viewport: { width: 1280, height: 720 }, behind: false, frameSeq: 1, stateSeq: 1, picture: { data: '/9j/', width: 960, height: 540, at: 1, sharp: false, spot } }
    let refuse = true
    const { bots, window } = host({ update, results: (input) => refuse && input.kind === 'pointer' && input.type === 'down' ? { applied: false, code: 'page_changed', message: 'What that picture showed there has scrolled out of view' } : { applied: true } })
    const events = await window('one')
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one' })
    await expect.poll(() => events.some((event) => event.frame?.id === 1)).toBe(true)
    const down = (seq: number): BotBrowserSent => ({ seq, picture: 1, input: { kind: 'pointer', type: 'down', x: 10, y: 10, button: 'left', buttons: 1, clicks: 1 } })
    const key = (seq: number): BotBrowserSent => ({ seq, picture: 1, input: { kind: 'keys', type: 'down', key: 'h', code: 'KeyH', keyCode: 72, modifiers: 0, text: 'h' } })
    expect((await bots.send('bot-hold', 'one', hold!.id, [down(1), key(2)])).acks.map((ack) => ack.status)).toEqual(['refused', 'refused'])
    refuse = false
    expect((await bots.send('bot-hold', 'one', hold!.id, [down(3), key(4)])).acks.map((ack) => ack.status)).toEqual(['applied', 'applied'])
  })

  it('gives a page\'s file picker only the files this computer\'s dialog answered, by a one-time token, within the limits', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'mousse-hold-files-'))
    const chosen = join(folder, 'note.txt')
    await writeFile(chosen, 'twelve bytes')
    const update: BrowserViewerUpdate = { tabId: 'tab_1', url: 'https://a.test/', title: 'A', viewport: { width: 1280, height: 720 }, behind: false, frameSeq: 1, stateSeq: 1, chooser: { multiple: false, site: 'a.test' } }
    const { bots, worker, window } = host({ update })
    await window('one')
    const { hold } = await bots.open('bot-hold', undefined, { viewId: 'one' })
    // The view that holds the browser is told which site asks.
    await expect.poll(async () => (await bots.view('bot-hold', { viewId: 'one', connectionId: 'local' })).chooser).toEqual({ multiple: false, site: 'a.test' })
    // Another window, or a connection that is not the hold's, is not this hold.
    await expect(bots.chooseFiles('bot-hold', 'two', hold!.id, [chosen])).rejects.toMatchObject({ code: 'hold_ended' })
    // One file here; never a folder or a path that is not a file.
    await expect(bots.chooseFiles('bot-hold', 'one', hold!.id, [chosen, chosen])).rejects.toMatchObject({ message: 'The page takes one file here.' })
    await expect(bots.chooseFiles('bot-hold', 'one', hold!.id, [folder])).rejects.toMatchObject({ code: 'not_actionable' })
    await expect(bots.chooseFiles('bot-hold', 'one', hold!.id, ['relative/note.txt'])).rejects.toMatchObject({ code: 'invalid_action' })
    const { token, count } = await bots.chooseFiles('bot-hold', 'one', hold!.id, [chosen])
    expect(count).toBe(1)
    expect(token).toMatch(/^files_/)
    expect((await bots.send('bot-hold', 'one', hold!.id, [{ seq: 1, input: { kind: 'files', token } }])).acks[0]!.status).toBe('applied')
    expect(inputs(worker)).toEqual([{ kind: 'files', paths: [chosen] }])
    // Used once: a second time gives the page nothing.
    expect((await bots.send('bot-hold', 'one', hold!.id, [{ seq: 2, input: { kind: 'files', token } }])).acks[0]).toMatchObject({ status: 'refused', text: 'Choose the file again' })
    // Cancel: the picker is answered with none.
    expect((await bots.send('bot-hold', 'one', hold!.id, [{ seq: 3, input: { kind: 'files' } }])).acks[0]!.status).toBe('applied')
    expect(inputs(worker).at(-1)).toEqual({ kind: 'files', paths: [] })
    await rm(folder, { recursive: true, force: true })
  })
})
