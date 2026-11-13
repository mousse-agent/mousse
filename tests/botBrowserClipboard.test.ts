/**
 * What reaches the person's clipboard from a bot's browser, on real managed Chromium (needs the
 * managed Chrome; skipped without it). The person's copy reads the page's selection as plain text,
 * for their clipboard alone (the app writes it there): the browser's own copy never runs, so its
 * clipboard never holds it for a page or the bot to read back, and cut deletes the selection in a
 * field. While the person holds the browser a page can neither write nor read a clipboard
 * (`navigator.clipboard` is refused). On a Mac the system clipboard is checked too: nothing the page
 * does, and nothing the browser does, changes it (skipped elsewhere). A duplicate of a copy carries
 * no text.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { MmsBrowserService } from '../src/mms/browser/MmsBrowserService'
import { BrowserArtifactService } from '../src/mms/browser/BrowserArtifactService'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { BOT_BROWSER_KEEPER, BotBrowsers } from '../src/mms/bots/browser/BotBrowsers'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../src/shared/browser/automation'
import type { BrowserObservation } from '../src/shared/browser/types'
import type { BotBrowserFrameEvent, BotBrowserInput } from '../src/shared/bots/personal/browser'
import { MANAGED_BROWSER_ROOT, ensureManagedChrome, startFixtureSite } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()
const profileId = '44444444-4444-4444-8444-444444444444'
const BOT = 'bot-clipboardabc'
const VIEW = 'view-one'
const mac = process.platform === 'darwin'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** This Mac's clipboard as text (the test puts back what was there). */
const systemClipboard = {
  read: () => execFileSync('pbpaste', { encoding: 'utf8' }),
  write: (text: string) => { execFileSync('pbcopy', { input: text }) }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mousse-bot-clipboard-'))
  const workerArtifactRoot = join(root, 'worker-artifacts')
  await mkdir(workerArtifactRoot)
  const broker = new BrowserBroker({ profileRoot: root, browserRoot: MANAGED_BROWSER_ROOT, artifactRoot: workerArtifactRoot, policy: createAllowHttpPolicy(), transport: 'in-process' })
  await broker.start()
  const artifacts = new BrowserArtifactService({ profileId, profileRoot: root, workerArtifactRoot })
  const browser = new MmsBrowserService({ profileId, profileRoot: root, workerArtifactRoot, artifacts, installationBrowserRoot: MANAGED_BROWSER_ROOT, threadExists: () => true, createManagedBackend: () => broker })
  const bots = new BotBrowsers({ profileId, browser: () => browser, homeThread: () => 'home-clip', setTimer: () => ({ clear: () => undefined }), computerName: 'Test computer' })
  const site = await startFixtureSite()
  const saved = mac ? systemClipboard.read() : undefined
  cleanups.push(async () => {
    if (saved !== undefined) systemClipboard.write(saved)
    await bots.removeBot(BOT, true)
    await browser.dispose()
    await broker.close()
    await site.close()
    await rm(root, { force: true, recursive: true })
  })
  const policy = new ExecutionPolicyService().snapshot(profileId, { allowedTools: [...BROWSER_AUTOMATION_TOOLS], allowedCapabilities: ['browser.session', 'browser.observe'], allowedEffects: ['read', 'external'], maxToolCalls: 1_000, maxElapsedMs: 600_000 })
  const home: BrowserToolContext = { execution: { profileId, threadId: 'home-clip', turnId: 'reader', actor: { kind: 'main' }, source: 'schedule', policySnapshotId: policy.id, cancellationId: 'reader' }, policy, target: { backend: 'managed-chromium' }, keeper: BOT_BROWSER_KEEPER }
  /** What the page wrote down, and its title. */
  const page = async (): Promise<string> => {
    const sessionId = browser.sessions.listThreadSessions({ profileId, threadId: 'home-clip', keeper: BOT_BROWSER_KEEPER })[0]!.id
    const seen = await browser.tools.invoke('browser_observe', { sessionId }, home)
    if (!seen.ok) throw new Error(seen.error.message)
    const observation = seen.value.observation as BrowserObservation
    return `${observation.title} ${observation.elements.map((element) => `${element.name ?? ''} ${element.text ?? ''}`).join(' ')}`
  }
  const events: BotBrowserFrameEvent[] = []
  const { hold } = await bots.open(BOT, `${site.origin}/clipboard-lab.html`, { viewId: VIEW, platform: mac ? 'mac' : 'other' })
  await bots.watch(BOT, 'w1', { width: 960, fps: 30, connectionId: 'c1', viewId: VIEW, emit: async (event) => { events.push(event) } })
  await expect.poll(() => events.filter((event) => event.frame).length, { timeout: 10_000 }).toBeGreaterThan(0)
  let seq = 0
  const shown = () => Math.max(...events.map((event) => event.frame?.id ?? 0))
  const send = async (inputs: BotBrowserInput[]) => (await bots.send(BOT, VIEW, hold!.id, inputs.map((input) => ({ seq: ++seq, picture: shown(), input })))).acks
  const resend = async (seqs: number[], inputs: BotBrowserInput[]) => (await bots.send(BOT, VIEW, hold!.id, inputs.map((input, index) => ({ seq: seqs[index]!, picture: shown(), input })))).acks
  const noted = (line: string) => expect.poll(page, { timeout: 5_000 }).toContain(line)
  return { send, resend, page, noted, seqNow: () => seq }
}

const press = (x: number, y: number): BotBrowserInput[] => [
  { kind: 'pointer', type: 'move', x, y, button: 'none', buttons: 0 },
  { kind: 'pointer', type: 'down', x, y, button: 'left', buttons: 1, clicks: 1 },
  { kind: 'pointer', type: 'up', x, y, button: 'left', buttons: 0, clicks: 1 }
]
/** Drags over "Copy these bold words" (the bold part is HTML). */
const selectWords: BotBrowserInput[] = [
  { kind: 'pointer', type: 'move', x: 42, y: 42, button: 'none', buttons: 0 },
  { kind: 'pointer', type: 'down', x: 42, y: 42, button: 'left', buttons: 1, clicks: 1 },
  { kind: 'pointer', type: 'move', x: 300, y: 42, button: 'none', buttons: 1 },
  { kind: 'pointer', type: 'up', x: 300, y: 42, button: 'left', buttons: 0, clicks: 1 }
]

describe.skipIf(!chrome.ok)('the person\'s clipboard and a bot\'s browser', () => {
  it('the person\'s copy is the selection as plain text, for them alone: the page hears no copy, and the browser\'s clipboard stays empty of it', async () => {
    const { send, resend, page, seqNow } = await fixture()
    if (mac) systemClipboard.write('before the copy')
    expect((await send(selectWords)).every((ack) => ack.status === 'applied')).toBe(true)
    const [copied] = await send([{ kind: 'copy' }])
    expect(copied).toMatchObject({ status: 'applied', copied: 'Copy these bold words' })
    await sleep(300)
    // The page's own copy handler never ran: the browser's copy did not.
    expect(await page()).not.toContain('copy-event')
    // The browser wrote nothing on this computer's clipboard (the app does, with the text it was answered).
    if (mac) expect(systemClipboard.read()).toBe('before the copy')
    // The copy's answer is not kept: sent again, it is a duplicate that carries no text.
    const [again] = await resend([seqNow()], [{ kind: 'copy' }])
    expect(again).toEqual({ seq: seqNow(), status: 'duplicate' })
  }, 60_000)

  it('cut reads the selection in a field and deletes it there, without the browser\'s clipboard', async () => {
    const { send, noted, page } = await fixture()
    if (mac) systemClipboard.write('before the cut')
    // Into the field, everything in it selected (the page's select-all), then cut.
    const primary = mac ? 4 : 2
    expect((await send([
      ...press(190, 178),
      { kind: 'keys', type: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: primary, command: 'selectAll' },
      { kind: 'keys', type: 'up', key: 'a', code: 'KeyA', keyCode: 65, modifiers: primary }
    ])).every((ack) => ack.status === 'applied')).toBe(true)
    const [cut] = await send([{ kind: 'copy', cut: true }])
    expect(cut).toMatchObject({ status: 'applied', copied: 'cut me' })
    await noted('field: ')
    expect(await page()).not.toContain('copy-event')
    if (mac) expect(systemClipboard.read()).toBe('before the cut')
  }, 60_000)

  it('while the person holds the browser a page cannot write the clipboard: writeText is refused, and this computer\'s clipboard is unchanged', async () => {
    const { send, noted, page } = await fixture()
    if (mac) systemClipboard.write('the person\'s own')
    // The person's click gives the page the right to act on it: it tries writeText, then execCommand('copy').
    expect((await send(press(140, 118))).every((ack) => ack.status === 'applied')).toBe(true)
    await noted('writeText:')
    expect(await page()).toContain('writeText:NotAllowedError')
    expect((await send(press(360, 118))).every((ack) => ack.status === 'applied')).toBe(true)
    await noted('exec:')
    await sleep(300)
    if (mac) expect(systemClipboard.read()).toBe('the person\'s own')
  }, 60_000)
})
