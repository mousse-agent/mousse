/**
 * A person's input in a bot's browser, on real managed Chromium (needs the managed Chrome; skipped
 * without it): each input of a hold is applied once, in order, and answered. Text typed before Enter is
 * in the field when the form submits, however the batches arrive; wheel turns add up; pointer events
 * make drags, double and right clicks and text selection; shortcuts carry their modifiers and editing
 * command; IME composition commits; a page's dialog and file picker are answered from the view; a click
 * on a picture older than a scroll lands on what it showed, and one older than a navigation is refused,
 * with the typing that followed it. Taking the browser over while the bot acts tells the bot whether
 * its action took effect.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { MmsBrowserService } from '../src/mms/browser/MmsBrowserService'
import { BrowserArtifactService } from '../src/mms/browser/BrowserArtifactService'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { BotBrowsers } from '../src/mms/bots/browser/BotBrowsers'
import { dispatchBrowserTool } from '../src/mms/orchestrator/browser/dispatch'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../src/shared/browser/automation'
import { BROWSER_MODIFIERS, type BrowserObservation } from '../src/shared/browser/types'
import type { BotBrowserAck, BotBrowserFrameEvent, BotBrowserInput, BotBrowserSent } from '../src/shared/bots/personal/browser'
import { MANAGED_BROWSER_ROOT, ensureManagedChrome, startFixtureSite } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()
const profileId = '33333333-3333-4333-8333-333333333333'
const BOT = 'bot-inputinputin'
const VIEW = 'view-one'
const PLATFORM = process.platform === 'darwin' ? 'mac' as const : 'other' as const
const PRIMARY = PLATFORM === 'mac' ? BROWSER_MODIFIERS.meta : BROWSER_MODIFIERS.ctrl
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mousse-bot-input-'))
  const workerArtifactRoot = join(root, 'worker-artifacts')
  await mkdir(workerArtifactRoot)
  const broker = new BrowserBroker({ profileRoot: root, browserRoot: MANAGED_BROWSER_ROOT, artifactRoot: workerArtifactRoot, policy: createAllowHttpPolicy(), transport: 'in-process' })
  await broker.start()
  const artifacts = new BrowserArtifactService({ profileId, profileRoot: root, workerArtifactRoot })
  const browser = new MmsBrowserService({ profileId, profileRoot: root, workerArtifactRoot, artifacts, installationBrowserRoot: MANAGED_BROWSER_ROOT, threadExists: () => true, createManagedBackend: () => broker })
  const bots = new BotBrowsers({ profileId, browser: () => browser, homeThread: () => 'home-input', setTimer: () => ({ clear: () => undefined }), computerName: 'Test computer' })
  const site = await startFixtureSite()
  cleanups.push(async () => {
    await bots.removeBot(BOT, true)
    await browser.dispose()
    await broker.close()
    await site.close()
    await rm(root, { force: true, recursive: true })
  })
  const policy = new ExecutionPolicyService().snapshot(profileId, { allowedTools: [...BROWSER_AUTOMATION_TOOLS], allowedCapabilities: ['browser.session', 'browser.observe'], allowedEffects: ['read', 'external'], maxToolCalls: 1_000, maxElapsedMs: 600_000 })
  const home: BrowserToolContext = { execution: { profileId, threadId: 'home-input', turnId: 'reader', actor: { kind: 'main' }, source: 'schedule', policySnapshotId: policy.id, cancellationId: 'reader' }, policy, target: { backend: 'managed-chromium' } }
  /** What the page wrote down (it notes every input that reached it), and its title (it carries the scroll). */
  const page = async (): Promise<{ text: string; title: string }> => {
    const sessionId = browser.sessions.listThreadSessions({ profileId, threadId: 'home-input' })[0]!.id
    const seen = await browser.tools.invoke('browser_observe', { sessionId }, home)
    if (!seen.ok) throw new Error(seen.error.message)
    const observation = seen.value.observation as BrowserObservation
    return { text: observation.elements.map((element) => `${element.name ?? ''} ${element.text ?? ''}`).join(' '), title: observation.title }
  }
  const events: BotBrowserFrameEvent[] = []
  let seq = 0
  let holdId = ''
  /** The owner's view: it holds the browser on the lab page, and watches it (pictures with their numbers). */
  const lab = async (path = 'input-lab.html') => {
    const { hold } = await bots.open(BOT, `${site.origin}/${path}`, { viewId: VIEW, platform: PLATFORM })
    holdId = hold!.id
    await bots.watch(BOT, 'w1', { width: 960, fps: 30, connectionId: 'c1', viewId: VIEW, emit: async (event) => { events.push(event) } })
    await expect.poll(() => events.filter((event) => event.frame).length, { timeout: 10_000 }).toBeGreaterThan(0)
    return hold!
  }
  /** Numbers inputs in order, without sending them. */
  const number = (inputs: BotBrowserInput[], picture?: number): BotBrowserSent[] => inputs.map((input) => ({ seq: ++seq, input, ...(picture !== undefined ? { picture } : {}) }))
  /** Sends numbered inputs as one batch. */
  const raw = async (sent: BotBrowserSent[]): Promise<BotBrowserAck[]> => (await bots.send(BOT, VIEW, holdId, sent)).acks
  const send = (inputs: BotBrowserInput[], picture?: number) => raw(number(inputs, picture))
  /** The latest picture's number, once one newer than `after` has come. */
  const picture = async (after = 0): Promise<number> => {
    await expect.poll(() => Math.max(0, ...events.map((event) => event.frame?.id ?? 0)), { timeout: 10_000 }).toBeGreaterThan(after)
    return Math.max(...events.map((event) => event.frame?.id ?? 0))
  }
  /** Waits until the page has written `line` down. */
  const noted = (line: string, timeout = 5_000) => expect.poll(async () => (await page()).text, { timeout }).toContain(line)
  return { bots, browser, page, lab, number, raw, send, picture, noted, events, origin: site.origin }
}

const press = (x: number, y: number, button: 'left' | 'right' = 'left', clicks = 1): BotBrowserInput[] => [
  { kind: 'pointer', type: 'move', x, y, button: 'none', buttons: 0 },
  { kind: 'pointer', type: 'down', x, y, button, buttons: button === 'left' ? 1 : 2, clicks },
  { kind: 'pointer', type: 'up', x, y, button, buttons: 0, clicks }
]

/** The keys a person presses to type `text` (each goes down with its character, then up). */
function keysFor(text: string): BotBrowserInput[] {
  return [...text].flatMap((char): BotBrowserInput[] => {
    const upper = char.toUpperCase()
    const code = char === ' ' ? 'Space' : /[a-z]/i.test(char) ? `Key${upper}` : /\d/.test(char) ? `Digit${char}` : ''
    const keyCode = char === ' ' ? 32 : upper.charCodeAt(0)
    const shift = /[A-Z]/.test(char) ? BROWSER_MODIFIERS.shift : 0
    return [
      { kind: 'keys', type: 'down', key: char, code, keyCode, modifiers: shift, text: char },
      { kind: 'keys', type: 'up', key: char, code, keyCode, modifiers: shift }
    ]
  })
}
const key = (name: string, code: string, keyCode: number, modifiers = 0): BotBrowserInput[] => [
  { kind: 'keys', type: 'down', key: name, code, keyCode, modifiers },
  { kind: 'keys', type: 'up', key: name, code, keyCode, modifiers }
]
const applied = (acks: BotBrowserAck[]) => acks.every((ack) => ack.status === 'applied')

describe.skipIf(!chrome.ok)('a person\'s input in a bot\'s browser', () => {
  it('types a sentence and presses Enter: the field holds the whole sentence when the form submits, however the batches arrive, and nothing goes twice', async () => {
    const { lab, send, number, raw, page, noted } = await fixture()
    await lab()
    expect(applied(await send(press(240, 48)))).toBe(true)
    const sentence = 'The quick brown fox jumps over the lazy dog 42 times'
    const typed = number([...keysFor(sentence), ...key('Enter', 'Enter', 13)])
    // Batches of six, all on their way at once, the last one (with Enter) sent first: the host puts them back in order.
    const batches: BotBrowserSent[][] = []
    for (let at = 0; at < typed.length; at += 6) batches.push(typed.slice(at, at + 6))
    const answers = await Promise.all([...batches].reverse().map((batch) => raw(batch)))
    expect(applied(answers.flat())).toBe(true)
    await noted(`submitted:${sentence}`)
    // A resend of the whole lot (a lost answer) is answered as duplicates and types nothing again.
    const again = await raw(typed)
    expect(again.every((ack) => ack.status === 'duplicate')).toBe(true)
    await sleep(300)
    expect((await page()).text.split(`submitted:${sentence}`).length - 1).toBe(1)
  }, 90_000)

  it('adds up fast wheel turns, never dropping one', async () => {
    const { lab, send, page } = await fixture()
    await lab()
    // Twenty quick turns of 40 px, each its own input, sent at once.
    const turns: BotBrowserInput[] = Array.from({ length: 20 }, () => ({ kind: 'scroll', x: 600, y: 500, deltaX: 0, deltaY: 40 }))
    expect(applied((await Promise.all(turns.map((turn) => send([turn])))).flat())).toBe(true)
    await expect.poll(async () => (await page()).title, { timeout: 5_000 }).toBe('Input lab 800')
  }, 60_000)

  it('drags a slider, double-clicks, right-clicks, and selects text the person then copies', async () => {
    const { lab, send, noted } = await fixture()
    await lab()
    // Drag the slider's thumb from its start to three quarters along, with the button held throughout.
    const drag: BotBrowserInput[] = [
      { kind: 'pointer', type: 'move', x: 48, y: 195, button: 'none', buttons: 0 },
      { kind: 'pointer', type: 'down', x: 48, y: 195, button: 'left', buttons: 1, clicks: 1 },
      ...Array.from({ length: 10 }, (_, step): BotBrowserInput => ({ kind: 'pointer', type: 'move', x: 48 + (step + 1) * 25, y: 195, button: 'none', buttons: 1 })),
      { kind: 'pointer', type: 'up', x: 298, y: 195, button: 'left', buttons: 0, clicks: 1 }
    ]
    expect(applied(await send(drag))).toBe(true)
    await noted('slider:6')
    expect(applied(await send([...press(660, 48, 'left', 1), ...press(660, 48, 'left', 2).slice(1)]))).toBe(true)
    await noted('dblclick')
    expect(applied(await send(press(660, 48, 'right')))).toBe(true)
    await noted('contextmenu')
    // Select "these words" by dragging over them, then copy: the selection comes back for the person's clipboard.
    const select: BotBrowserInput[] = [
      { kind: 'pointer', type: 'move', x: 640, y: 102, button: 'none', buttons: 0 },
      { kind: 'pointer', type: 'down', x: 640, y: 102, button: 'left', buttons: 1, clicks: 1 },
      { kind: 'pointer', type: 'move', x: 700, y: 102, button: 'none', buttons: 1 },
      { kind: 'pointer', type: 'move', x: 760, y: 102, button: 'none', buttons: 1 },
      { kind: 'pointer', type: 'up', x: 760, y: 102, button: 'left', buttons: 0, clicks: 1 }
    ]
    expect(applied(await send(select))).toBe(true)
    const [copied] = await send([{ kind: 'copy' }])
    expect(copied!.status).toBe('applied')
    expect(copied!.copied).toMatch(/these words/)
  }, 90_000)

  it('runs the page\'s select-all shortcut, pastes text in, and commits IME composition', async () => {
    const { lab, send, noted, page } = await fixture()
    await lab()
    // Into the text area: select everything with the platform's shortcut, then paste over it.
    expect(applied(await send(press(240, 125)))).toBe(true)
    expect(applied(await send(key('a', 'KeyA', 65, PRIMARY)))).toBe(true)
    await noted(`shortcut:${PLATFORM === 'mac' ? 'meta' : 'ctrl'}+a`)
    expect(applied(await send([{ kind: 'paste', text: 'pasted words' }]))).toBe(true)
    const [copied] = await send([...key('a', 'KeyA', 65, PRIMARY), { kind: 'copy' }]).then((acks) => acks.slice(-1))
    expect(copied!.copied).toBe('pasted words')
    // An IME: the composition shows as it is typed, and commits as the text chosen.
    expect(applied(await send(press(700, 198)))).toBe(true)
    expect(applied(await send([
      { kind: 'compose', text: 'n', selectionStart: 1, selectionEnd: 1 },
      { kind: 'compose', text: 'ni', selectionStart: 2, selectionEnd: 2 },
      { kind: 'compose', text: '你', selectionStart: 1, selectionEnd: 1 },
      { kind: 'type', text: '你好' }
    ]))).toBe(true)
    // Leave the field, so it reports its value.
    expect(applied(await send(press(900, 600)))).toBe(true)
    await noted('ime:你好')
    expect((await page()).text).not.toContain('ime:ni')
  }, 90_000)

  it('answers the page\'s alert and prompt in the view, and a file the person chose reaches its file picker', async () => {
    const { lab, send, noted, events } = await fixture()
    await lab()
    // The click that opens the alert is done once the alert is open; the view is told, and its answer goes next.
    expect(applied(await send(press(90, 256)))).toBe(true)
    await expect.poll(() => events.some((event) => event.dialog?.type === 'alert' && event.dialog.message === 'Hello from the page'), { timeout: 5_000 }).toBe(true)
    // Anything else waits for the answer: the page takes nothing until then.
    expect((await send(press(240, 48)))[1]).toMatchObject({ status: 'refused', reason: 'dialog' })
    expect(applied(await send([{ kind: 'dialog', accept: true }]))).toBe(true)
    await noted('alert:answered')
    expect(events.some((event) => event.dialog === null)).toBe(true)
    expect(applied(await send(press(330, 256)))).toBe(true)
    await expect.poll(() => events.some((event) => event.dialog?.type === 'prompt' && event.dialog.defaultPrompt === 'nobody'), { timeout: 5_000 }).toBe(true)
    expect(applied(await send([{ kind: 'dialog', accept: true, text: 'Ada' }]))).toBe(true)
    await noted('prompt:Ada')
    // The file input asks the person: the view is told, and the file they chose goes to the page.
    const chosen = join(await mkdtemp(join(tmpdir(), 'mousse-bot-file-')), 'note.txt')
    await writeFile(chosen, 'twelve bytes')
    expect(applied(await send(press(190, 316)))).toBe(true)
    await expect.poll(() => events.some((event) => event.chooser && !event.chooser.multiple), { timeout: 5_000 }).toBe(true)
    expect(applied(await send([{ kind: 'files', paths: [chosen] }]))).toBe(true)
    await noted('file:note.txt:12')
  }, 90_000)

  it('a click on a picture older than a scroll lands on what it showed; one older than a page is refused, with the typing after it', async () => {
    const { lab, send, noted, picture, page, origin } = await fixture()
    await lab()
    const before = await picture()
    // The page scrolls by 300 px (the person's wheel, or the page itself) before the click on the older picture reaches it.
    expect(applied(await send([{ kind: 'scroll', x: 600, y: 500, deltaX: 0, deltaY: 300 }]))).toBe(true)
    await expect.poll(async () => (await page()).title, { timeout: 5_000 }).toBe('Input lab 300')
    // "below" sat at y 400 in that picture; where it showed is now 100 px from the top, and the click lands there.
    expect(applied(await send(press(190, 420), before))).toBe(true)
    await noted('clicked:below')
    expect((await page()).text).not.toContain('clicked:far')
    // Now a new page: a click on a picture of the old one is refused, and so is the typing that followed it.
    const old = await picture()
    expect(applied(await send([{ kind: 'navigate', url: `${origin}/nav-a.html` }]))).toBe(true)
    await picture(old)
    const acks = await send([...press(190, 420), ...keysFor('hi')], old)
    expect(acks[1]).toMatchObject({ status: 'refused', reason: 'page-changed', text: 'Page changed · click again' })
    expect(acks[3]).toMatchObject({ status: 'refused', reason: 'page-changed' })
  }, 90_000)

  it('Give back lets go of a key and a button the person left down', async () => {
    const { bots, lab, send, noted, page } = await fixture()
    const hold = await lab()
    expect(applied(await send([
      { kind: 'keys', type: 'down', key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifiers: BROWSER_MODIFIERS.shift },
      { kind: 'pointer', type: 'move', x: 190, y: 715, button: 'none', buttons: 0 },
      { kind: 'pointer', type: 'down', x: 190, y: 715, button: 'left', buttons: 1, clicks: 1 }
    ]))).toBe(true)
    expect((await page()).text).not.toContain('keyup:Shift')
    await bots.hold(BOT, VIEW, { op: 'release', holdId: hold.id })
    await noted('keyup:Shift')
    await noted('mouseup:far')
  }, 60_000)

  it('taking over while the bot acts tells the bot whether its action took effect', async () => {
    const { bots, origin } = await fixture()
    const controller = new AbortController()
    const prepared = bots.turn({ botId: BOT, activationId: 'act-1', lane: 'run', homeThreadId: 'home-input', runId: 'run-1', signal: controller.signal })!
    const call = (name: string, args: Record<string, unknown>) => dispatchBrowserTool({ port: prepared.runtime, binding: prepared.binding, name, args })
    const opened = JSON.parse((await call('browser_open', { url: `${origin}/input-lab.html` })).text) as { observation: BrowserObservation; session: { controlLeaseId: string } }
    const seen = opened.observation
    const go = seen.elements.find((element) => element.name === 'Send')!
    // The bot clicks Send; its cursor glides there first, and the owner takes over meanwhile.
    const acting = call('browser_act', { sessionId: seen.sessionId, tabId: seen.tabId, generation: seen.generation, observationId: seen.observationId,
      controlLeaseId: opened.session.controlLeaseId, action: { type: 'click', target: { kind: 'ref', ref: go.ref } } })
    await sleep(60)
    await bots.hold(BOT, VIEW, { op: 'take', platform: PLATFORM })
    const told = await acting
    expect(told.isError).toBe(true)
    const result = JSON.parse(told.text) as { action: { outcome: string; code: string; takeover: string; message: string } }
    expect(result.action).toMatchObject({ outcome: 'blocked', code: 'human_controlled', takeover: 'not-applied' })
    expect(result.action.message).toMatch(/^Your owner took over the browser before this action ran: it was not applied/)
    controller.abort()
  }, 60_000)
})
