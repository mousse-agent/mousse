/**
 * A person's input in a bot's browser, on real managed Chromium (needs the managed Chrome; skipped
 * without it): each input of a hold is applied once, in order, and answered. Text typed before Enter is
 * in the field when the form submits, however the batches arrive; wheel turns add up; pointer events
 * make drags, double and right clicks and text selection; shortcuts carry their modifiers and editing
 * command; IME composition commits; a page's dialog and file picker are answered from the view (the
 * picker names its site, and takes only a file this computer's dialog answered); a click on a picture
 * older than a scroll lands on what it showed, and one older than a navigation is refused, with the
 * typing that followed it; on a page that paints every frame, a click on a picture 40 frames old lands
 * where it showed or is refused, never elsewhere; a click where a modal, a shift of the layout or an
 * inner scroll has changed what was there is refused; a positioned input with no picture never reaches
 * the page; keys held when a dialog opened go up once it is answered; a page that stops answering
 * while the person types holds back their typing, then the channel recovers by itself with nothing
 * applied twice. Taking the browser over while the bot acts tells the bot whether its action took
 * effect.
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
import { BotBrowserChannel, type ChannelHealth } from '../src/renderer/stores/botBrowserChannel'
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
  /** The latest picture's number the view has (what a person acts on). */
  const shown = (): number | undefined => {
    const ids = events.map((event) => event.frame?.id ?? 0).filter((id) => id > 0)
    return ids.length ? Math.max(...ids) : undefined
  }
  /** Numbers inputs in order, without sending them, made on `picture` (the latest by default). */
  const number = (inputs: BotBrowserInput[], picture = shown()): BotBrowserSent[] => inputs.map((input) => ({ seq: ++seq, input, ...(picture !== undefined ? { picture } : {}) }))
  /** Sends numbered inputs as one batch. */
  const raw = async (sent: BotBrowserSent[]): Promise<BotBrowserAck[]> => (await bots.send(BOT, VIEW, holdId, sent)).acks
  const send = (inputs: BotBrowserInput[], picture?: number) => raw(number(inputs, picture))
  /** The latest picture's number, once one newer than `after` has come. */
  const picture = async (after = 0): Promise<number> => {
    await expect.poll(() => Math.max(0, ...events.map((event) => event.frame?.id ?? 0)), { timeout: 10_000 }).toBeGreaterThan(after)
    return Math.max(...events.map((event) => event.frame?.id ?? 0))
  }
  /** Waits until the page has written `line` down. */
  const noted = (line: string, timeout = 5_000) => expect.poll(async () => { const seen = await page(); return `${seen.text} ${seen.title}` }, { timeout }).toContain(line)
  return { bots, browser, page, lab, number, raw, send, picture, noted, events, origin: site.origin, hold: () => holdId, policy }
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

  it('adds up fast wheel turns, never dropping one, and a click on the picture after the scroll lands where it shows', async () => {
    const { lab, send, page, picture, noted } = await fixture()
    await lab()
    const before = await picture()
    // Twenty quick turns of 40 px, each its own input made on the picture from before they began, sent at once.
    const turns: BotBrowserInput[] = Array.from({ length: 20 }, () => ({ kind: 'scroll', x: 600, y: 650, deltaX: 0, deltaY: 40 }))
    expect(applied((await Promise.all(turns.map((turn) => send([turn], before)))).flat())).toBe(true)
    await expect.poll(async () => (await page()).title, { timeout: 5_000 }).toBe('Input lab 800')
    // Back up to 200 px; on the picture of the page there, "far" (at 700 on the page) shows 500 px down.
    expect(applied(await send([{ kind: 'scroll', x: 600, y: 300, deltaX: 0, deltaY: -600 }], await picture()))).toBe(true)
    await expect.poll(async () => (await page()).title, { timeout: 5_000 }).toBe('Input lab 200')
    const now = await picture(await picture())
    expect(applied(await send(press(190, 520), now))).toBe(true)
    await noted('clicked:far')
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
    const { bots, lab, send, noted, events, hold } = await fixture()
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
    // The file input asks the person: the view is told which site asks, and only the file this
    // computer's dialog answered (a one-time token) goes to the page.
    const chosen = join(await mkdtemp(join(tmpdir(), 'mousse-bot-file-')), 'note.txt')
    await writeFile(chosen, 'twelve bytes')
    expect(applied(await send(press(190, 316)))).toBe(true)
    await expect.poll(() => events.some((event) => event.chooser && !event.chooser.multiple && event.chooser.site === '127.0.0.1'), { timeout: 5_000 }).toBe(true)
    // Paths never come on the channel; one file only for this picker.
    await expect(bots.chooseFiles(BOT, VIEW, hold(), [chosen, chosen])).rejects.toMatchObject({ message: 'The page takes one file here.' })
    const { token } = await bots.chooseFiles(BOT, VIEW, hold(), [chosen])
    expect(applied(await send([{ kind: 'files', token }]))).toBe(true)
    await noted('file:note.txt:12')
    // The token was used once: it gives nothing again.
    expect((await send([{ kind: 'files', token }]))[0]).toMatchObject({ status: 'refused', text: 'Choose the file again' })
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

  it('on a page that paints every frame, a click on a picture 40 frames old lands where it showed, or is refused: never elsewhere', async () => {
    const { lab, send, picture, page, noted } = await fixture()
    await lab('animating.html')
    const old = await picture()
    // The page scrolls 200 px down; its pictures go on, up to 30 a second.
    expect(applied(await send([{ kind: 'scroll', x: 600, y: 400, deltaX: 0, deltaY: 200 }]))).toBe(true)
    await expect.poll(async () => (await page()).title, { timeout: 5_000 }).toBe('Animating 200')
    await picture(old + 40)
    // "target" showed at y 330 in that old picture; "below" is what sits at that point of the screen now.
    const [, down] = await send(press(190, 330), old)
    if (down!.status === 'applied') await noted('clicked:target')
    else expect(down).toMatchObject({ status: 'refused', reason: 'page-changed' })
    await sleep(300)
    expect((await page()).text).not.toMatch(/clicked:(above|below|lower)/)
  }, 90_000)

  it('a press where a modal, a shift of the layout or an inner scroll changed what was there is refused; one where nothing changed lands', async () => {
    const { lab, send, picture, page, noted } = await fixture()
    await lab('changing.html')
    // Nothing changed since the picture: the click lands.
    expect(applied(await send(press(190, 230), await picture()))).toBe(true)
    await noted('clicked:target')
    /** A key that changes the page, then a press on the picture from before it. */
    const pressAfter = async (name: string, code: string, keyCode: number, x: number, y: number) => {
      const before = await picture()
      expect(applied(await send(key(name, code, keyCode)))).toBe(true)
      await noted(`key:${name}`)
      await picture(before)
      return (await send(press(x, y), before))[1]
    }
    // The inner list scrolled under "item 1": refused, and no item is clicked.
    expect(await pressAfter('i', 'KeyI', 73, 750, 275)).toMatchObject({ status: 'refused', reason: 'page-changed', text: 'Page changed · click again' })
    // A banner pushed the content down 60 px: "prev" is where "target" was. Refused.
    expect(await pressAfter('b', 'KeyB', 66, 190, 230)).toMatchObject({ status: 'refused', reason: 'page-changed' })
    // A modal opened over it. Refused.
    expect(await pressAfter('m', 'KeyM', 77, 190, 230)).toMatchObject({ status: 'refused', reason: 'page-changed' })
    await sleep(300)
    expect((await page()).title).not.toMatch(/clicked:(prev|next|modal-button|item)/)
  }, 90_000)

  it('a dialog that opens while a press is being checked lets its answer go first: the press is refused at once, not stuck', async () => {
    const { lab, send, noted, events, bots, hold } = await fixture()
    await lab('changing.html')
    // The page will be busy a moment, then open an alert, while the press after this key is checked.
    expect(applied(await send(key('d', 'KeyD', 68)))).toBe(true)
    const startedAt = Date.now()
    const [, down] = await send(press(190, 230))
    expect(down).toMatchObject({ status: 'refused', reason: 'dialog', text: 'Answer the page\'s dialog first' })
    expect(Date.now() - startedAt).toBeLessThan(4_000)
    await expect.poll(() => events.some((event) => event.dialog?.message === 'later'), { timeout: 5_000 }).toBe(true)
    // Its answer goes next, and the page carries on.
    expect((await bots.send(BOT, VIEW, hold(), [{ seq: 100, input: { kind: 'dialog', accept: true } }])).acks[0]).toMatchObject({ status: 'refused', reason: 'gap' })
    expect(applied(await send([{ kind: 'dialog', accept: true }]))).toBe(true)
    await noted('alert:answered')
  }, 60_000)

  it('each key goes down once: on a Mac, "h", "i" and "j" are not pressed as the volume keys and repeated', async () => {
    const { lab, send, page, noted } = await fixture()
    await lab('changing.html')
    expect(applied(await send([...key('h', 'KeyH', 72), ...key('i', 'KeyI', 73), ...key('j', 'KeyJ', 74)]))).toBe(true)
    await noted('key:j')
    await sleep(500)
    expect((await page()).title).toBe('Changing key:h key:i key:j')
  }, 60_000)

  it('a positioned input with no picture to place it never reaches the page', async () => {
    const { browser, lab, send, page } = await fixture()
    await lab()
    // At the host: a press on a picture it does not know is refused before the page.
    const acks = await send(press(190, 420), 999_999)
    expect(acks[1]).toMatchObject({ status: 'refused', reason: 'page-changed', text: 'Page changed · click again' })
    // At the worker: one that comes without the spot of its picture is refused too.
    const policy = new ExecutionPolicyService().snapshot(profileId, { allowedTools: [...BROWSER_AUTOMATION_TOOLS], allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action'], allowedEffects: ['read', 'external'], maxToolCalls: 1_000, maxElapsedMs: 600_000 })
    const owner: BrowserToolContext = { execution: { profileId, threadId: 'home-input', turnId: 'owner', actor: { kind: 'main' }, source: 'gui', policySnapshotId: policy.id, cancellationId: 'owner' }, policy, target: { backend: 'managed-chromium' } }
    const sessionId = browser.sessions.listThreadSessions({ profileId, threadId: 'home-input' })[0]!.id
    const listed = await browser.sessions.tabs(owner, sessionId, { operation: 'list' }) as { tabs?: Array<{ id: string }> }
    const results = await browser.sessions.humanInputs(owner, { sessionId, tabId: listed.tabs![0]!.id, inputs: [{ input: { kind: 'click', x: 190, y: 420 } }, { input: { kind: 'pointer', type: 'down', x: 190, y: 420, button: 'left', buttons: 1, clicks: 1 } }] })
    expect(results).toEqual([{ applied: false, code: 'page_changed', message: 'No picture places this input' }, { applied: false, code: 'page_changed', message: 'No picture places this input' }])
    await sleep(300)
    expect((await page()).text).not.toMatch(/clicked:(below|far)/)
  }, 60_000)

  it('a key held when the page opened a dialog goes up once the dialog is answered, even after another window took over', async () => {
    const { bots, lab, send, noted, events } = await fixture()
    await lab()
    expect(applied(await send([{ kind: 'keys', type: 'down', key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifiers: BROWSER_MODIFIERS.shift }]))).toBe(true)
    expect(applied(await send(press(90, 256)))).toBe(true)
    await expect.poll(() => events.some((event) => event.dialog?.type === 'alert'), { timeout: 5_000 }).toBe(true)
    // Another window takes over while the page waits for its dialog: the Shift the first left down cannot go up yet.
    const taken = await bots.hold(BOT, 'view-two', { op: 'take', force: true, platform: PLATFORM }, 'c2')
    // The dialog is answered there: the Shift goes up then, not never.
    expect((await bots.send(BOT, 'view-two', taken.hold!.id, [{ seq: 1, input: { kind: 'dialog', accept: true } }], 'c2')).acks[0]).toMatchObject({ status: 'applied' })
    await noted('alert:answered')
    await noted('keyup:Shift')
  }, 60_000)

  it('a page that stops answering while the person types: typing is held back, then the channel recovers by itself, nothing applied twice', async () => {
    const { bots, lab, page, events, hold } = await fixture()
    await lab('freezing.html?ms=4000')
    const healths: ChannelHealth[] = []
    const channel = new BotBrowserChannel({ send: (inputs) => bots.send(BOT, VIEW, hold(), inputs), health: (health) => healths.push(health) })
    const shown = () => Math.max(0, ...events.map((event) => event.frame?.id ?? 0)) || undefined
    const click = (x: number, y: number) => { for (const input of press(x, y)) channel.push(input, shown()) }
    click(240, 60)
    await expect.poll(() => channel.unanswered, { timeout: 5_000 }).toBe(0)
    // Enter in the field: the page stops answering for 4 s. The person types on, a key every 120 ms for 3.6 s.
    for (const input of key('Enter', 'Enter', 13)) channel.push(input, shown())
    await expect.poll(() => channel.unanswered, { timeout: 5_000 }).toBe(0)
    const typed: Array<{ char: string; done: Promise<BotBrowserAck> }> = []
    for (const char of 'abcdefghijklmnopqrstuvwxyz0123') {
      const [down, up] = keysFor(char)
      typed.push({ char, done: channel.push(down!, shown()).done })
      channel.push(up!, shown())
      await sleep(120)
    }
    // What came while nothing was answered is held back here, and the view says "Not reaching".
    expect(healths).toContain('unreachable')
    // The page answers again: what was taken arrives once, in order, and the channel is quiet again by itself.
    await expect.poll(() => channel.unanswered, { timeout: 30_000 }).toBe(0)
    expect(channel.health).toBe('ok')
    const answers = await Promise.all(typed.map(async (entry) => ({ char: entry.char, ack: await entry.done })))
    const reached = answers.filter((entry) => entry.ack.status === 'applied').map((entry) => entry.char).join('')
    expect(answers.filter((entry) => entry.ack.status === 'refused').every((entry) => entry.ack.reason === 'busy')).toBe(true)
    expect(answers.some((entry) => entry.ack.status === 'refused')).toBe(true)
    expect(reached.length).toBeGreaterThan(0)
    await expect.poll(async () => (await page()).title, { timeout: 5_000 }).toBe(`Freezing ${reached}`)
    // And it takes typing again at once.
    for (const input of keysFor('z')) channel.push(input, shown())
    await expect.poll(async () => (await page()).title, { timeout: 5_000 }).toBe(`Freezing ${reached}z`)
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
