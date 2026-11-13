/**
 * Each bot's own browser, on real managed Chromium: a bot drives its own session on a persistent
 * profile of its own, never the owner's or a thread's; each activation keeps to its own tabs; the
 * agent cursor is held for the owner's view (a frame) and never put into the page; the owner can
 * take the browser over and give it back; an idle browser closes and its sign-ins stay.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { MmsBrowserService } from '../src/mms/browser/MmsBrowserService'
import { BrowserArtifactService } from '../src/mms/browser/BrowserArtifactService'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { BROWSER_TURN_HOLD_MS, BotBrowsers, BrowserTurns, MAX_BROWSER_WAITERS, botBrowserWorkspace } from '../src/mms/bots/browser/BotBrowsers'
import type { BotTurnBrowser } from '../src/mms/bots/activation/dispatcher'
import { dispatchBrowserTool } from '../src/mms/orchestrator/browser/dispatch'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../src/shared/browser/automation'
import type { BrowserObservation, BrowserSessionRecord } from '../src/shared/browser/types'
import { MANAGED_BROWSER_ROOT, ensureManagedChrome, startFixtureSite } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()
const profileId = '22222222-2222-4222-8222-222222222222'
const BOT_A = 'bot-aaaaaaaaaaaa'
const BOT_B = 'bot-bbbbbbbbbbbb'
const HOMES: Record<string, string> = { [BOT_A]: 'home-a', [BOT_B]: 'home-b' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface Parsed { session?: BrowserSessionRecord; observation?: BrowserObservation; action?: { outcome: string; observation?: BrowserObservation }; extraction?: { text: string }; tabs?: Array<{ id: string }> }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mousse-bot-browser-'))
  const workerArtifactRoot = join(root, 'worker-artifacts')
  await mkdir(workerArtifactRoot)
  const broker = new BrowserBroker({ profileRoot: root, browserRoot: MANAGED_BROWSER_ROOT, artifactRoot: workerArtifactRoot, policy: createAllowHttpPolicy(), transport: 'in-process' })
  await broker.start()
  const artifacts = new BrowserArtifactService({ profileId, profileRoot: root, workerArtifactRoot })
  const browser = new MmsBrowserService({ profileId, profileRoot: root, workerArtifactRoot, artifacts, installationBrowserRoot: MANAGED_BROWSER_ROOT,
    threadExists: () => true, createManagedBackend: () => broker })
  const idle: Array<() => void> = []
  const bots = new BotBrowsers({ profileId, browser: () => browser, homeThread: (botId) => HOMES[botId], setTimer: (fn) => { idle.push(fn); return { clear: () => { idle.splice(idle.indexOf(fn) >>> 0, 1) } } } })
  const site = await startFixtureSite()
  cleanups.push(async () => {
    await bots.removeBot(BOT_A, true)
    await bots.removeBot(BOT_B, true)
    await browser.dispose()
    await broker.close()
    await site.close()
    await rm(root, { force: true, recursive: true })
  })
  /** One bot dispatch's browser, as `BotEngine.prepare` gets it. */
  const turn = (botId: string, activationId: string, lane: 'chat' | 'run' = 'chat') => {
    const controller = new AbortController()
    const prepared = bots.turn({ botId, activationId, lane, homeThreadId: HOMES[botId]!, runId: `run-${activationId}`, signal: controller.signal })!
    expect(prepared).toBeDefined()
    return { ...prepared, stop: () => controller.abort() }
  }
  /** A browser tool call the way the bot's runtime makes it (through Mousse's app tool). */
  const call = async (prepared: BotTurnBrowser, name: string, args: Record<string, unknown> = {}): Promise<Parsed & { error?: string }> => {
    const result = await dispatchBrowserTool({ port: prepared.runtime, binding: prepared.binding, name, args })
    if (result.isError) return { error: result.text }
    return JSON.parse(result.text) as Parsed
  }
  return { browser, bots, turn, call, idle, origin: site.origin }
}

describe('turns on a bot\'s browser (BrowserTurns)', () => {
  it('runs one call at a time, in the order they came; a stopped wait leaves at once; the queue is bounded', async () => {
    const turns = new BrowserTurns()
    const order: string[] = []
    let release!: () => void
    const first = turns.run(() => new Promise<void>((resolve) => { order.push('a start'); release = () => { order.push('a end'); resolve() } }), { tab: 'tab-a' })
    expect(turns.busy).toBe(true)
    expect(turns.holderTab).toBe('tab-a')
    const second = turns.run(async () => { order.push('b') })
    const stop = new AbortController()
    const stopped = turns.run(async () => { order.push('never') }, { signal: stop.signal })
    const third = turns.run(async () => { order.push('c') })
    stop.abort()
    await expect(stopped).rejects.toMatchObject({ code: 'cancelled' })
    release()
    await Promise.all([first, second, third])
    expect(order).toEqual(['a start', 'a end', 'b', 'c'])
    expect(turns.busy).toBe(false)
    // A full queue refuses the next call as busy, instead of growing without end.
    let hold!: () => void
    const holding = turns.run(() => new Promise<void>((resolve) => { hold = resolve }))
    const waiting = Array.from({ length: MAX_BROWSER_WAITERS }, () => turns.run(async () => undefined))
    await expect(turns.run(async () => undefined)).rejects.toMatchObject({ code: 'timeout' })
    hold()
    await Promise.all([holding, ...waiting])
    // A wait longer than its bound is refused as busy too.
    const long = turns.run(() => new Promise<void>((resolve) => setTimeout(resolve, 200)))
    await expect(turns.run(async () => undefined, { waitMs: 20 })).rejects.toMatchObject({ code: 'timeout' })
    await long
  })

  it("the owner's input goes ahead of the calls that wait: it waits only for the one under way", async () => {
    const turns = new BrowserTurns()
    const order: string[] = []
    let release!: () => void
    const under = turns.run(() => new Promise<void>((resolve) => { release = resolve }))
    const runs = [turns.run(async () => { order.push('run b') }), turns.run(async () => { order.push('run c') })]
    const owner = turns.run(async () => { order.push('owner') }, { first: true })
    release()
    await Promise.all([under, owner, ...runs])
    expect(order).toEqual(['owner', 'run b', 'run c'])
  })

  it('a holder that never returns is stopped at its limit: its call fails, its signal ends, and the next call goes', async () => {
    expect(BROWSER_TURN_HOLD_MS).toBeGreaterThan(4 * 60_000)
    const turns = new BrowserTurns()
    let held: AbortSignal | undefined
    const stuck = turns.run((signal) => { held = signal; return new Promise<void>(() => undefined) }, { holdMs: 50 })
    const next = turns.run(async () => 'went')
    await expect(stuck).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('did not answer in time') })
    expect(held!.aborted).toBe(true)
    await expect(next).resolves.toBe('went')
    expect(turns.busy).toBe(false)
  })
})

describe.skipIf(!chrome.ok)('a bot\'s own browser', () => {
  it('each bot drives its own persistent browser, apart from the owner\'s and from the other bot\'s; sign-ins stay after it closes', async () => {
    const { browser, bots, turn, call, idle, origin } = await fixture()
    const alice = turn(BOT_A, 'act-a1')
    // The browser tools are the bot's: the policy holds every one but the handoff, and none is refused.
    expect([...alice.binding.policy.allowedTools].sort()).toEqual(BROWSER_AUTOMATION_TOOLS.filter((tool) => tool !== 'browser_request_human').sort())
    const opened = await call(alice, 'browser_open', { url: `${origin}/remember.html?set=alice` })
    expect(opened.error).toBeUndefined()
    expect(opened.session).toMatchObject({ backend: 'managed-chromium', persistent: true, workspaceId: botBrowserWorkspace(BOT_A), threadId: 'home-a' })
    expect(opened.session!.runId).toBeUndefined()
    const aliceText = await call(alice, 'browser_extract', { sessionId: opened.session!.id, tabId: opened.observation!.tabId })
    expect(aliceText.extraction!.text).toContain('mousse_signed_in=alice')

    const bob = turn(BOT_B, 'act-b1')
    const bobOpened = await call(bob, 'browser_open', { url: `${origin}/remember.html` })
    expect(bobOpened.session!.id).not.toBe(opened.session!.id)
    expect(bobOpened.session!.workspaceId).toBe(botBrowserWorkspace(BOT_B))
    expect((await call(bob, 'browser_extract', { sessionId: bobOpened.session!.id, tabId: bobOpened.observation!.tabId })).extraction!.text).toContain('empty')
    // Bob can't reach Alice's browser, even naming its session.
    expect((await call(bob, 'browser_observe', { sessionId: opened.session!.id })).error).toMatch(/not yours/)
    // The owner's threads see none of them, and a thread's agent can't use them.
    expect(browser.sessions.listThreadSessions({ profileId, threadId: 'owner-thread' })).toEqual([])
    const policy = new ExecutionPolicyService().snapshot(profileId, { allowedTools: [...BROWSER_AUTOMATION_TOOLS], allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract'], allowedEffects: ['read', 'external'], maxToolCalls: 10, maxElapsedMs: 60_000 })
    const thread: BrowserToolContext = { execution: { profileId, threadId: 'owner-thread', turnId: 't1', actor: { kind: 'main' }, source: 'schedule', policySnapshotId: policy.id, cancellationId: 't1' }, policy, target: { backend: 'managed-chromium' } }
    const foreign = await browser.tools.invoke('browser_observe', { sessionId: opened.session!.id }, thread)
    expect(foreign).toMatchObject({ ok: false, error: { code: 'profile_mismatch' } })

    // Alice's activation ends; nobody watches, so the idle browser closes. Its sign-in stays.
    bots.activationEnded({ botId: BOT_A, activationId: 'act-a1' })
    expect(idle).toHaveLength(1)
    idle[0]!()
    await expect.poll(() => browser.sessions.listThreadSessions({ profileId, threadId: 'home-a' }).length).toBe(0)
    expect((await bots.view(BOT_A)).open).toBe(false)
    const again = turn(BOT_A, 'act-a2', 'run')
    const reopened = await call(again, 'browser_open', { url: `${origin}/remember.html` })
    expect(reopened.session!.id).not.toBe(opened.session!.id)
    expect((await call(again, 'browser_extract', { sessionId: reopened.session!.id, tabId: reopened.observation!.tabId })).extraction!.text).toContain('mousse_signed_in=alice')
  }, 60_000)

  it('keeps each activation to its own tabs, shows the agent cursor in frames but never in the page, and lets the owner take over', async () => {
    const { bots, turn, call, origin } = await fixture()
    const chatTurn = turn(BOT_A, 'act-chat')
    const runTurn = turn(BOT_A, 'act-run', 'run')
    const chatOpened = await call(chatTurn, 'browser_open', { url: `${origin}/form.html` })
    const runOpened = await call(runTurn, 'browser_open', { url: `${origin}/remember.html` })
    // One browser for the bot, a tab for each activation.
    expect(runOpened.session!.id).toBe(chatOpened.session!.id)
    expect(runOpened.observation!.tabId).not.toBe(chatOpened.observation!.tabId)
    expect((await call(runTurn, 'browser_observe', { sessionId: runOpened.session!.id, tabId: chatOpened.observation!.tabId })).error).toMatch(/another of your runs/)
    expect((await call(runTurn, 'browser_tabs', { sessionId: runOpened.session!.id, operation: 'list' })).tabs!.map((tab) => tab.id)).toEqual([runOpened.observation!.tabId])

    // The chat's agent clicks Save: the cursor is where the button is, in the view's frame.
    const observed = await call(chatTurn, 'browser_observe', {})
    const before = observed.observation!
    expect(before.tabId).toBe(chatOpened.observation!.tabId)
    const save = before.elements.find((element) => element.name === 'Save')!
    const clicked = await call(chatTurn, 'browser_act', { sessionId: before.sessionId, tabId: before.tabId, generation: before.generation, observationId: before.observationId,
      controlLeaseId: chatOpened.session!.controlLeaseId, action: { type: 'click', target: { kind: 'ref', ref: save.ref } } })
    expect(clicked.error).toBeUndefined()
    expect(clicked.action!.outcome).toBe('verified')
    const view = await bots.view(BOT_A, { frame: true })
    // The view follows the first activation that used the browser, the chat, whose reply shows the preview.
    expect(view).toMatchObject({ open: true, control: 'bot', tab: { url: `${origin}/form.html` }, activationId: 'act-chat' })
    expect(view.activations).toEqual(['act-chat', 'act-run'])
    expect(view.frame!.mimeType).toBe('image/jpeg')
    expect(Buffer.from(view.frame!.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(view.frame!.viewport).toEqual({ width: 1280, height: 720 })
    expect(view.cursor).toMatchObject({ action: 'click', tabId: before.tabId, viewport: { width: 1280, height: 720 } })
    expect(Math.abs(view.cursor!.x - (save.bounds!.x + save.bounds!.width / 2))).toBeLessThan(save.bounds!.width / 2)
    expect(Math.abs(view.cursor!.y - (save.bounds!.y + save.bounds!.height / 2))).toBeLessThan(save.bounds!.height / 2)
    // Nothing of the cursor reaches the page: what the agent observes is the page alone.
    const after = clicked.action!.observation!
    expect(after.elements.map((element) => [element.role, element.name])).toEqual(before.elements.map((element) => [element.role, element.name === 'idle' ? 'saved::pwlen=0' : element.name]))
    const text = await call(chatTurn, 'browser_extract', { sessionId: before.sessionId, tabId: before.tabId })
    expect(text.extraction!.text).not.toMatch(/cursor/i)

    // The owner takes over: the bot waits; the owner's click lands; giving back lets the bot act again.
    expect((await bots.control(BOT_A, 'owner')).control).toBe('owner')
    const fresh = (await call(chatTurn, 'browser_observe', {})).observation!
    const name = fresh.elements.find((element) => element.role === 'textbox' && element.name?.trim() === 'Name')!
    const refused = await call(chatTurn, 'browser_act', { sessionId: fresh.sessionId, tabId: fresh.tabId, generation: fresh.generation, observationId: fresh.observationId,
      controlLeaseId: 'lease_x', action: { type: 'click', target: { kind: 'ref', ref: name.ref } } })
    expect(refused.error).toMatch(/owner is using your browser/)
    // Nor can it open or load a page meanwhile: nothing it starts runs while the owner holds the browser.
    expect((await call(chatTurn, 'browser_open', { url: `${origin}/remember.html` })).error).toMatch(/owner is using your browser/)
    expect((await call(chatTurn, 'browser_tabs', { operation: 'new', url: `${origin}/remember.html` })).error).toMatch(/owner is using your browser/)
    expect((await call(chatTurn, 'browser_tabs', { operation: 'list' })).tabs).toHaveLength(1)
    await bots.input(BOT_A, { kind: 'click', x: name.bounds!.x + 5, y: name.bounds!.y + 5 })
    await bots.input(BOT_A, { kind: 'type', text: 'Ada' })
    await bots.input(BOT_A, { kind: 'key', key: 'Enter' })
    expect((await bots.control(BOT_A, 'bot')).control).toBe('bot')
    const resumed = (await call(chatTurn, 'browser_extract', {})).extraction!.text
    expect(resumed).toContain('saved:Ada')

    // The run ends while the chat goes on: only the run's tab closes.
    bots.activationEnded({ botId: BOT_A, activationId: 'act-run' })
    await expect.poll(async () => (await call(chatTurn, 'browser_tabs', { operation: 'list' })).tabs!.length).toBe(1)
    expect((await call(chatTurn, 'browser_observe', {})).observation!.url).toBe(`${origin}/form.html`)
    // A stopped turn can't use the browser any more.
    chatTurn.stop()
    expect((await call(chatTurn, 'browser_observe', {})).error).toBeTruthy()
  }, 60_000)

  it('the owner can open the bot\'s browser to sign in for it, under their own control', async () => {
    const { bots, browser, origin } = await fixture()
    const first = `${origin}/automation-page.html?name=owner`
    const opened = await bots.open(BOT_A, first)
    expect(opened).toMatchObject({ open: true, control: 'owner', tab: { url: first } })
    expect(opened.frame?.mimeType).toBe('image/jpeg')
    expect(opened.cursor).toBeUndefined()
    // The owner holds the browser before its first page loads: a check on that page sees a person.
    const policy = new ExecutionPolicyService().snapshot(profileId, { allowedTools: [...BROWSER_AUTOMATION_TOOLS], allowedCapabilities: ['browser.session', 'browser.observe'], allowedEffects: ['read', 'external'], maxToolCalls: 10, maxElapsedMs: 60_000 })
    const home: BrowserToolContext = { execution: { profileId, threadId: 'home-a', turnId: 'owner-check', actor: { kind: 'main' }, source: 'schedule', policySnapshotId: policy.id, cancellationId: 'owner-check' }, policy, target: { backend: 'managed-chromium' } }
    const sessionId = browser.sessions.listThreadSessions({ profileId, threadId: 'home-a' })[0]!.id
    const seen = await browser.tools.invoke('browser_observe', { sessionId }, home)
    expect(seen.ok).toBe(true)
    const text = seen.ok ? seen.value.observation!.elements.map((element) => `${element.name ?? ''} ${element.text ?? ''}`).join(' ') : ''
    expect(text).toContain('owner-first:false')
    await bots.input(BOT_A, { kind: 'navigate', url: `${origin}/remember.html` })
    expect((await bots.view(BOT_A, { frame: true })).tab?.url).toBe(`${origin}/remember.html`)
  }, 60_000)

  it('gives each of two activations opening pages at once its own tab', async () => {
    const { turn, call, origin } = await fixture()
    const first = turn(BOT_A, 'act-first')
    expect((await call(first, 'browser_open', { url: `${origin}/form.html` })).error).toBeUndefined()
    const one = turn(BOT_A, 'act-one')
    const two = turn(BOT_A, 'act-two')
    const [a, b] = await Promise.all([call(one, 'browser_open', { url: `${origin}/nav-a.html` }), call(two, 'browser_open', { url: `${origin}/nav-b.html` })])
    expect(a.error).toBeUndefined()
    expect(b.error).toBeUndefined()
    expect(a.observation!.tabId).not.toBe(b.observation!.tabId)
    expect(a.observation!.url).toBe(`${origin}/nav-a.html`)
    expect(b.observation!.url).toBe(`${origin}/nav-b.html`)
    expect((await call(one, 'browser_tabs', { operation: 'list' })).tabs!.map((tab) => tab.id)).toEqual([a.observation!.tabId])
    expect((await call(two, 'browser_tabs', { operation: 'list' })).tabs!.map((tab) => tab.id)).toEqual([b.observation!.tabId])
  }, 60_000)

  it('the owner\'s view comes from the tab\'s screencast: a still page is the same picture, a change shows as it is painted', async () => {
    const { bots, origin } = await fixture()
    await bots.open(BOT_A, `${origin}/nav-a.html`)
    // The screencast is running once its first paint has arrived; a still page then sends nothing new.
    await expect.poll(async () => {
      const first = (await bots.view(BOT_A, { frame: true })).frame!
      await new Promise((resolve) => setTimeout(resolve, 100))
      const again = (await bots.view(BOT_A, { frame: true })).frame!
      return again.at === first.at && again.data === first.data
    }, { timeout: 5_000, interval: 100 }).toBe(true)
    const still = (await bots.view(BOT_A, { frame: true })).frame!
    expect(still.viewport).toEqual({ width: 1280, height: 720 })
    expect(Buffer.from(still.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    // The owner goes to another page: its picture shows soon after, without anyone asking twice.
    await bots.input(BOT_A, { kind: 'navigate', url: `${origin}/nav-b.html` })
    await expect.poll(async () => (await bots.view(BOT_A, { frame: true })).frame!.data !== still.data, { timeout: 2_000, interval: 40 }).toBe(true)
  }, 60_000)

  it('with two runs browsing, the view follows one run\'s tab; while the owner holds a tab, their input lands there only, and is refused once it has gone', async () => {
    const { bots, turn, call, origin } = await fixture()
    const first = turn(BOT_A, 'act-r1', 'run')
    const second = turn(BOT_A, 'act-r2', 'run')
    const opened = await call(first, 'browser_open', { url: `${origin}/form.html` })
    await call(second, 'browser_open', { url: `${origin}/remember.html` })
    // The second run's calls never move the view: it follows the first run's tab, and the preview sits on its reply.
    await call(second, 'browser_observe', {})
    expect(await bots.view(BOT_A, { frame: true })).toMatchObject({ activationId: 'act-r1', tab: { url: `${origin}/form.html` } })
    // The owner takes over the tab they see.
    expect((await bots.control(BOT_A, 'owner')).control).toBe('owner')
    const field = opened.observation!.elements.find((element) => element.role === 'textbox' && element.name?.trim() === 'Name')!
    // Meanwhile the second run may not open a tab, but reads its page, bringing its own tab forward before and while the
    // owner types: a tab in the back takes no input, so each input takes its turn and brings the owner's tab forward.
    expect((await call(second, 'browser_tabs', { operation: 'new', url: `${origin}/nav-a.html` })).error).toMatch(/owner is using your browser/)
    await call(second, 'browser_observe', {})
    await Promise.all([bots.input(BOT_A, { kind: 'click', x: field.bounds!.x + 5, y: field.bounds!.y + 5 }), call(second, 'browser_observe', {}), call(second, 'browser_observe', {})])
    await call(second, 'browser_observe', {})
    await Promise.all([call(second, 'browser_observe', {}), bots.input(BOT_A, { kind: 'type', text: 'Ada' }), call(second, 'browser_observe', {})])
    await call(second, 'browser_observe', {})
    await Promise.all([bots.input(BOT_A, { kind: 'key', key: 'Enter' }), call(second, 'browser_observe', {})])
    await call(second, 'browser_observe', {})
    // The view stayed on the owner's tab throughout.
    expect(await bots.view(BOT_A, { frame: true })).toMatchObject({ control: 'owner', activationId: 'act-r1', tab: { url: `${origin}/form.html` } })
    expect((await bots.control(BOT_A, 'bot')).control).toBe('bot')
    expect((await call(first, 'browser_extract', {})).extraction!.text).toContain('saved:Ada')
    for (const tab of (await call(second, 'browser_tabs', { operation: 'list' })).tabs!) {
      expect((await call(second, 'browser_extract', { tabId: tab.id })).extraction!.text).not.toContain('Ada')
    }

    // Held again, and the run whose tab it is ends: its tab closes, and the owner's input is refused, never sent elsewhere.
    await bots.control(BOT_A, 'owner')
    bots.activationEnded({ botId: BOT_A, activationId: 'act-r1' })
    await expect.poll(async () => bots.input(BOT_A, { kind: 'scroll', x: 10, y: 10, deltaX: 0, deltaY: 1 }).then(() => 'sent', (error: Error) => error.message), { timeout: 5_000, interval: 50 })
      .toBe('The tab you took over has closed. Give the browser back, then take it over again.')
    await expect(bots.input(BOT_A, { kind: 'type', text: 'Zed42' })).rejects.toThrow(/has closed/)
    for (const tab of (await call(second, 'browser_tabs', { operation: 'list' })).tabs!) {
      expect((await call(second, 'browser_extract', { tabId: tab.id })).extraction!.text).not.toContain('Zed42')
    }
    // Given back, the view follows the run still browsing.
    await bots.control(BOT_A, 'bot')
    await call(second, 'browser_observe', {})
    expect((await bots.view(BOT_A, { frame: true })).activationId).toBe('act-r2')
  }, 60_000)

  it('a call that waited its turn while the owner took the browser over is refused when the turn comes, and loads nothing', async () => {
    const { bots, turn, call, origin } = await fixture()
    const first = turn(BOT_A, 'act-r1', 'run')
    const second = turn(BOT_A, 'act-r2', 'run')
    const opened = await call(first, 'browser_open', { url: `${origin}/form.html` })
    const own = await call(second, 'browser_open', { url: `${origin}/remember.html` })
    // The first run holds the browser's turn with a wait; the second run's navigation queues behind it.
    const waiting = call(first, 'browser_wait', { sessionId: opened.session!.id, tabId: opened.observation!.tabId, condition: { type: 'text', text: 'never-present', present: true }, timeoutMs: 1_500 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const queued = call(second, 'browser_open', { url: `${origin}/nav-a.html` })
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Take over takes no turn: it is the owner's at once, while the wait still holds the turn.
    expect((await bots.control(BOT_A, 'owner')).control).toBe('owner')
    await waiting
    expect((await queued).error).toMatch(/owner is using your browser/)
    expect((await call(second, 'browser_tabs', { operation: 'list' })).tabs).toEqual([expect.objectContaining({ id: own.observation!.tabId, url: `${origin}/remember.html` })])
    expect((await call(second, 'browser_extract', {})).extraction!.text).not.toContain('Page A')
    await bots.control(BOT_A, 'bot')
  }, 60_000)

  it('several activations browsing at once take turns on the one browser: none is refused or loses its tab mid-action', async () => {
    // Without the turns, three clicks sent to the session at once all land, but the two whose tabs lose the front wait
    // about 5 s each on their checks (0.8 s in turn), close to an action's 8 s limit.
    const { bots, turn, call, origin } = await fixture()
    const runs = ['act-r1', 'act-r2', 'act-r3'].map((id) => turn(BOT_A, id, 'run'))
    const opened = []
    for (const run of runs) opened.push(await call(run, 'browser_open', { url: `${origin}/form.html` }))
    expect(new Set(opened.map((entry) => entry.session!.id)).size).toBe(1)
    const click = async (index: number) => {
      const seen = (await call(runs[index]!, 'browser_observe', {})).observation!
      const save = seen.elements.find((element) => element.name === 'Save')!
      return call(runs[index]!, 'browser_act', { sessionId: seen.sessionId, tabId: seen.tabId, generation: seen.generation, observationId: seen.observationId,
        controlLeaseId: opened[index]!.session!.controlLeaseId, action: { type: 'click', target: { kind: 'ref', ref: save.ref } } })
    }
    // All three click at once, each on its own tab: each waits its turn, and each click lands on its own page.
    const clicks = await Promise.all(runs.map((_, index) => click(index)))
    for (const clicked of clicks) {
      expect(clicked.error).toBeUndefined()
      expect(clicked.action!.outcome).toBe('verified')
    }
    for (const run of runs) expect((await call(run, 'browser_extract', {})).extraction!.text).toContain('saved')
    // The owner's view meanwhile follows the last tab used and never fails a call.
    const viewing = bots.view(BOT_A, { frame: true })
    const again = await Promise.all(runs.map((run) => call(run, 'browser_observe', {})))
    expect(again.every((entry) => !entry.error)).toBe(true)
    expect((await viewing).open).toBe(true)
  }, 60_000)
})
