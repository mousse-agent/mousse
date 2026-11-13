/**
 * Each bot's own browser, on real managed Chromium: a bot drives its own session on a persistent
 * profile of its own, never the owner's or a thread's; each activation keeps to its own tabs; the
 * agent cursor is held for the owner's view (a frame) and never put into the page; the owner can
 * take the browser over and give it back; an idle browser closes and its sign-ins stay.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { processRecordPath } from '../src/browser-worker/lifecycle/paths'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { MmsBrowserService } from '../src/mms/browser/MmsBrowserService'
import { BrowserArtifactService } from '../src/mms/browser/BrowserArtifactService'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { BOT_BROWSER_KEEPER, BROWSER_TURN_HOLD_MS, BotBrowsers, BrowserTurns, MAX_BROWSER_WAITERS, OWNER_CUT_IN_MS, OWNER_KEEP_MS, botBrowserWorkspace } from '../src/mms/bots/browser/BotBrowsers'
import type { BotTurnBrowser } from '../src/mms/bots/activation/dispatcher'
import { dispatchBrowserTool } from '../src/mms/orchestrator/browser/dispatch'
import { snapshotBrowserExecutionBinding } from '../src/mms/orchestrator/browser/binding'
import { browserToolCapability } from '../src/mms/orchestrator/browser/tools'
import { BrowserAutomationError } from '../src/mms/browser/automation/BrowserSessionManager'
import type { BrowserRuntimePort } from '../src/shared/browser/runtime'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../src/shared/browser/automation'
import type { BrowserObservation, BrowserSessionRecord } from '../src/shared/browser/types'
import type { BotBrowserFrameEvent } from '../src/shared/bots/personal/browser'
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
  /** The worker methods called from now on (the view's `frame`, `frame.next` and `frame.stop` among them). */
  const workerCalls = () => {
    const methods: string[] = []
    const original = broker.call.bind(broker)
    broker.call = (request, options) => {
      methods.push(request.method)
      return original(request, options)
    }
    return methods
  }
  return { browser, bots, turn, call, idle, origin: site.origin, workerCalls }
}

/** A view watching a bot's browser: what it was sent, and how long each delivery takes. */
function viewer(deliveryMs = 0) {
  const events: Array<BotBrowserFrameEvent & { receivedAt: number }> = []
  const connection = new AbortController()
  return {
    events,
    frames: () => events.filter((event) => event.frame),
    close: () => connection.abort(),
    lifetime: connection.signal,
    emit: async (event: BotBrowserFrameEvent) => {
      events.push({ ...event, receivedAt: Date.now() })
      if (deliveryMs) await new Promise((resolve) => setTimeout(resolve, deliveryMs))
    }
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

  it("the owner's input cuts into a run's call that holds the browser after a moment; a call that does not give way is waited for", async () => {
    expect(OWNER_CUT_IN_MS).toBeLessThan(500)
    const turns = new BrowserTurns()
    const order: string[] = []
    const cutIn = { afterMs: 50, reason: () => new BrowserAutomationError({ code: 'human_controlled', message: 'Your owner is using your browser now.' }) }
    let runSignal: AbortSignal | undefined
    // A run's long call holds the browser, and another run's waits behind it.
    const long = turns.run((held) => { runSignal = held; return new Promise<void>(() => undefined) }, { yields: true })
    const behind = turns.run(async () => { order.push('run b') }, { yields: true })
    const started = Date.now()
    const owner = turns.run(async () => { order.push('owner'); return 'applied' }, { first: true, cutIn })
    // Queued is not done: the owner's work has not run while the run's call still holds the browser.
    await sleep(10)
    expect(order).toEqual([])
    await expect(owner).resolves.toBe('applied')
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
    await expect(long).rejects.toMatchObject({ code: 'human_controlled' })
    expect(runSignal!.aborted).toBe(true)
    await behind
    expect(order).toEqual(['owner', 'run b'])
    // Closing an ended run's tab does not give way: the owner's input waits for it to end.
    let release!: () => void
    const side = turns.run(() => new Promise<void>((resolve) => { release = resolve }))
    let went = false
    const after = turns.run(async () => { went = true }, { first: true, cutIn })
    await sleep(120)
    expect(went).toBe(false)
    release()
    await Promise.all([side, after])
    expect(went).toBe(true)
  })

  it("the browser stays the owner's a moment after each input: their next input goes at once, a run's call after the moment", async () => {
    expect(OWNER_KEEP_MS).toBeGreaterThanOrEqual(500)
    const turns = new BrowserTurns()
    const order: string[] = []
    await turns.run(async () => { order.push('key 1') }, { first: true, keepMs: 80 })
    // A run's call that comes now waits for the moment to pass.
    const run = turns.run(async () => { order.push('run') }, { yields: true })
    await sleep(20)
    expect(order).toEqual(['key 1'])
    // The owner's next input within the moment goes at once, ahead of the waiting run, and keeps it again.
    await turns.run(async () => { order.push('key 2') }, { first: true, keepMs: 80 })
    expect(order).toEqual(['key 1', 'key 2'])
    await run
    expect(order).toEqual(['key 1', 'key 2', 'run'])
    expect(turns.busy).toBe(false)
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
    expect(foreign).toMatchObject({ ok: false, error: { code: 'policy_denied', message: expect.stringMatching(/belongs to a bot/) } })

    // Alice's activation ends; nobody watches, so the idle browser closes. Its sign-in stays.
    bots.activationEnded({ botId: BOT_A, activationId: 'act-a1' })
    expect(idle).toHaveLength(1)
    idle[0]!()
    await expect.poll(() => browser.sessions.listThreadSessions({ profileId, threadId: 'home-a', keeper: BOT_BROWSER_KEEPER }).length).toBe(0)
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
    const { browser: opened } = await bots.open(BOT_A, first)
    expect(opened).toMatchObject({ open: true, control: 'owner', tab: { url: first } })
    expect(opened.frame?.mimeType).toBe('image/jpeg')
    expect(opened.cursor).toBeUndefined()
    // The owner holds the browser before its first page loads: a check on that page sees a person.
    const policy = new ExecutionPolicyService().snapshot(profileId, { allowedTools: [...BROWSER_AUTOMATION_TOOLS], allowedCapabilities: ['browser.session', 'browser.observe'], allowedEffects: ['read', 'external'], maxToolCalls: 10, maxElapsedMs: 60_000 })
    const home: BrowserToolContext = { execution: { profileId, threadId: 'home-a', turnId: 'owner-check', actor: { kind: 'main' }, source: 'schedule', policySnapshotId: policy.id, cancellationId: 'owner-check' }, policy, target: { backend: 'managed-chromium' }, keeper: BOT_BROWSER_KEEPER }
    const sessionId = browser.sessions.listThreadSessions({ profileId, threadId: 'home-a', keeper: BOT_BROWSER_KEEPER })[0]!.id
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

  it('two runs on two tabs, the owner holds one: the view stays on it, the other run reads but cannot act, the sentence lands whole there only, and Give back hands both runs their browser', async () => {
    const { bots, turn, call, origin } = await fixture()
    const first = turn(BOT_A, 'act-r1', 'run')
    const second = turn(BOT_A, 'act-r2', 'run')
    const one = await call(first, 'browser_open', { url: `${origin}/form.html` })
    const two = await call(second, 'browser_open', { url: `${origin}/form.html?second` })
    expect(one.observation!.tabId).not.toBe(two.observation!.tabId)
    // The view follows the first run's tab, and Take over holds exactly that tab.
    const taken = await bots.hold(BOT_A, 'view-a', { op: 'take', platform: 'other' })
    expect(taken.browser).toMatchObject({ control: 'owner', holder: 'this-view', activationId: 'act-r1', tab: { url: `${origin}/form.html` } })
    const holdId = taken.hold!.id
    // The other run reads its own page, but acts on nothing and opens nothing while the owner holds the browser.
    expect((await call(second, 'browser_observe', {})).error).toBeUndefined()
    const seen = (await call(second, 'browser_observe', {})).observation!
    const otherSave = seen.elements.find((element) => element.name === 'Save')!
    expect((await call(second, 'browser_act', { sessionId: seen.sessionId, tabId: seen.tabId, generation: seen.generation, observationId: seen.observationId,
      controlLeaseId: two.session!.controlLeaseId, action: { type: 'click', target: { kind: 'ref', ref: otherSave.ref } } })).error).toMatch(/owner is using your browser/)
    expect((await call(second, 'browser_tabs', { operation: 'new', url: `${origin}/nav-a.html` })).error).toMatch(/owner is using your browser/)
    // The owner clicks the Name field on a picture of the tab they hold, types a sentence and presses Enter, while the
    // other run keeps reading its own page.
    const shot = await bots.view(BOT_A, { frame: true, viewId: 'view-a' })
    const field = one.observation!.elements.find((element) => element.role === 'textbox' && element.name?.trim() === 'Name')!
    const sentence = 'The quick brown fox jumps over the lazy dog'
    const reading = Promise.all([call(second, 'browser_observe', {}), call(second, 'browser_extract', {}), call(second, 'browser_observe', {})])
    const { acks } = await bots.send(BOT_A, 'view-a', holdId, [
      { seq: 1, input: { kind: 'click', x: field.bounds!.x + 5, y: field.bounds!.y + 5 }, picture: shot.frame!.id! },
      { seq: 2, input: { kind: 'type', text: sentence }, picture: shot.frame!.id! },
      { seq: 3, input: { kind: 'key', key: 'Enter' }, picture: shot.frame!.id! }
    ])
    expect(acks.map((ack) => ack.status)).toEqual(['applied', 'applied', 'applied'])
    await reading
    // The view stayed on the held tab throughout.
    expect(await bots.view(BOT_A, { viewId: 'view-a' })).toMatchObject({ control: 'owner', activationId: 'act-r1', tab: { url: `${origin}/form.html` } })
    expect((await call(first, 'browser_extract', {})).extraction!.text).toContain(`saved:${sentence}:pwlen=0`)
    const untouched = (await call(second, 'browser_extract', {})).extraction!.text
    expect(untouched).toContain('idle')
    expect(untouched).not.toContain('quick brown fox')
    // Give back: both runs have their browser again, and the view still follows the first.
    await bots.hold(BOT_A, 'view-a', { op: 'release', holdId })
    // The run picks the browser up again on its own tab, with the session's new lease.
    const reopened = await call(second, 'browser_open', {})
    expect(reopened.observation!.tabId).toBe(two.observation!.tabId)
    const again = reopened.observation!
    const saved = await call(second, 'browser_act', { sessionId: again.sessionId, tabId: again.tabId, generation: again.generation, observationId: again.observationId,
      controlLeaseId: reopened.session!.controlLeaseId, action: { type: 'click', target: { kind: 'ref', ref: again.elements.find((element) => element.name === 'Save')!.ref } } })
    expect(saved.error).toBeUndefined()
    expect((await call(second, 'browser_extract', {})).extraction!.text).toContain('saved::pwlen=0')
    expect((await bots.view(BOT_A)).activationId).toBe('act-r1')
  }, 60_000)

  it("the owner's input does not wait out a run's call that holds the browser: it cuts in, and is answered once it is on the page", async () => {
    const { bots, turn, call, origin } = await fixture()
    const first = turn(BOT_A, 'act-r1', 'run')
    const second = turn(BOT_A, 'act-r2', 'run')
    const one = await call(first, 'browser_open', { url: `${origin}/form.html` })
    const two = await call(second, 'browser_open', { url: `${origin}/remember.html` })
    const taken = await bots.hold(BOT_A, 'view-a', { op: 'take', platform: 'other' })
    const holdId = taken.hold!.id
    const shot = await bots.view(BOT_A, { frame: true, viewId: 'view-a' })
    const field = one.observation!.elements.find((element) => element.role === 'textbox' && element.name?.trim() === 'Name')!
    expect((await bots.send(BOT_A, 'view-a', holdId, [{ seq: 1, input: { kind: 'click', x: field.bounds!.x + 5, y: field.bounds!.y + 5 }, picture: shot.frame!.id! }])).acks[0]!.status).toBe('applied')
    // The other run holds the browser's turn with a long read of its own page (reading is allowed during a hold), once
    // the moment the click kept the browser for its owner has passed.
    const startedWait = Date.now()
    const waiting = call(second, 'browser_wait', { sessionId: two.session!.id, tabId: two.observation!.tabId, condition: { type: 'text', text: 'never-present', present: true }, timeoutMs: 20_000 })
    await sleep(OWNER_KEEP_MS + 400)
    const sentAt = Date.now()
    let answeredAt: number | undefined
    const sending = bots.send(BOT_A, 'view-a', holdId, [
      { seq: 2, input: { kind: 'type', text: 'Cut in' }, picture: shot.frame!.id! },
      { seq: 3, input: { kind: 'key', key: 'Enter' }, picture: shot.frame!.id! }
    ]).then((answer) => { answeredAt = Date.now(); return answer })
    // Taken is not applied: no answer while the run's call still holds the browser.
    await sleep(40)
    expect(answeredAt).toBeUndefined()
    const { acks } = await sending
    expect(acks).toMatchObject([{ status: 'applied' }, { status: 'applied' }])
    // Well under the half second after which the view says "Sending…", not the run's 20 seconds.
    expect(answeredAt! - sentAt).toBeLessThan(500 + 1_000)
    // The run's read was stopped and told why; it was not left to run out.
    expect((await waiting).error).toMatch(/owner is using your browser/)
    expect(Date.now() - startedWait).toBeLessThan(10_000)
    // Answered as applied once the page had it: the form saved the text.
    expect((await call(first, 'browser_extract', {})).extraction!.text).toContain('saved:Cut in:pwlen=0')
    // A stopped call is not a lost browser: the browser stays open, and the run still reads its own tab.
    expect((await bots.view(BOT_A, { viewId: 'view-a' })).open).toBe(true)
    expect((await call(second, 'browser_tabs', { operation: 'list' })).tabs).toEqual([expect.objectContaining({ id: two.observation!.tabId })])
    // A person typing fast while the run keeps reading: each key goes at the page's pace, not one cut-in at a time
    // (24 keys would take over 3.6 s), and the run reads in the pauses.
    const pageId = (await bots.view(BOT_A, { frame: true, viewId: 'view-a' })).frame!.id!
    expect((await bots.send(BOT_A, 'view-a', holdId, [{ seq: 4, input: { kind: 'click', x: field.bounds!.x + 5, y: field.bounds!.y + 5 }, picture: pageId }])).acks[0]!.status).toBe('applied')
    let reading = true
    const reads = (async () => { let count = 0; while (reading) { await call(second, 'browser_wait', { sessionId: two.session!.id, tabId: two.observation!.tabId, condition: { type: 'text', text: 'never-present', present: true }, timeoutMs: 400 }); count += 1 } return count })()
    await sleep(200)
    const burstAt = Date.now()
    const keys = [...'abcdefghijklmnopqrstuvwx'].map((char, index) => ({ seq: 5 + index, input: { kind: 'type' as const, text: char }, picture: pageId }))
    const burst = await bots.send(BOT_A, 'view-a', holdId, keys)
    const burstMs = Date.now() - burstAt
    expect(burst.acks.every((ack) => ack.status === 'applied')).toBe(true)
    expect(burstMs).toBeLessThan(24 * OWNER_CUT_IN_MS)
    await sleep(OWNER_KEEP_MS + 600)
    reading = false
    expect(await reads).toBeGreaterThan(0)
    expect((await bots.send(BOT_A, 'view-a', holdId, [{ seq: 29, input: { kind: 'key', key: 'Enter' }, picture: pageId }])).acks[0]!.status).toBe('applied')
    // Whole and in order (the click put the caret before what the field held).
    expect((await call(first, 'browser_extract', {})).extraction!.text).toMatch(/saved:[^:\n]*abcdefghijklmnopqrstuvwx[^:\n]*:pwlen=0/)
    await bots.hold(BOT_A, 'view-a', { op: 'release', holdId })
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

describe.skipIf(!chrome.ok)('watching a bot\'s browser', () => {
  it('captures nothing until a view watches; then pushes pictures as the page paints, nothing for a still page, and stops when the view goes', async () => {
    const { bots, turn, call, origin, workerCalls } = await fixture()
    const methods = workerCalls()
    const bot = turn(BOT_A, 'act-1')
    expect((await call(bot, 'browser_open', { url: `${origin}/nav-a.html` })).error).toBeUndefined()
    await sleep(1_000)
    // Nobody watches: the worker is never asked for a picture.
    expect(methods.filter((method) => method.startsWith('frame'))).toEqual([])

    const view = viewer()
    const answered = await bots.watch(BOT_A, 'w1', { width: 960, fps: 15, connectionId: 'c1', lifetime: view.lifetime, emit: view.emit })
    expect(answered).toMatchObject({ open: true, control: 'bot' })
    await expect.poll(() => view.frames().length, { timeout: 5_000 }).toBeGreaterThan(0)
    const first = view.events.find((event) => event.frame)!
    expect(view.events.find((event) => event.viewport)!.viewport).toEqual({ width: 1280, height: 720 })
    expect(view.events.find((event) => event.tab)!.tab).toMatchObject({ url: `${origin}/nav-a.html` })
    // The page's own title follows as soon as the page sets it.
    await expect.poll(() => view.events.some((event) => event.tab?.title === 'Nav A'), { timeout: 5_000 }).toBe(true)
    expect(first.frame).toMatchObject({ mimeType: 'image/jpeg', width: 960, height: 540 })
    expect(Buffer.from(first.frame!.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    // A still page: a sharp picture once it settles, and then nothing at all.
    await expect.poll(() => view.frames().at(-1)!.frame!.sharp === true, { timeout: 5_000 }).toBe(true)
    const settled = view.events.length
    await sleep(2_000)
    expect(view.events.length).toBe(settled)
    // The viewport went once; pictures after the first carry none.
    expect(view.events.filter((event) => event.viewport)).toHaveLength(1)

    // The bot opens another page: the view follows it.
    expect((await call(bot, 'browser_open', { url: `${origin}/nav-b.html` })).error).toBeUndefined()
    await expect.poll(() => view.events.some((event) => event.tab?.url === `${origin}/nav-b.html`), { timeout: 5_000 }).toBe(true)
    await expect.poll(() => view.events.slice(settled).some((event) => event.frame), { timeout: 5_000 }).toBe(true)

    // The view goes: the worker's wait ends, and it is asked for nothing more.
    bots.unwatch(BOT_A, 'w1', 'c1')
    await expect.poll(() => methods.includes('frame.stop'), { timeout: 2_000 }).toBe(true)
    await sleep(500)
    const asked = methods.filter((method) => method === 'frame.next').length
    const sent = view.events.length
    await sleep(1_500)
    expect(methods.filter((method) => method === 'frame.next').length).toBe(asked)
    expect(view.events.length).toBe(sent)
  }, 60_000)

  it('keeps each view to its size and rate, and a slow view gets the latest picture without queueing', async () => {
    const { bots, turn, call, origin } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    expect((await call(bot, 'browser_open', { url: `${origin}/moving.html?stopAfter=8000` })).error).toBeUndefined()
    const preview = viewer()
    await bots.watch(BOT_A, 'preview', { width: 480, fps: 5, connectionId: 'c1', emit: preview.emit })
    await expect.poll(() => preview.frames().length, { timeout: 5_000 }).toBeGreaterThan(0)
    const from = Date.now()
    await sleep(2_000)
    const previewFrames = preview.frames().filter((event) => event.receivedAt >= from)
    expect(previewFrames.length).toBeLessThanOrEqual(11)
    expect(previewFrames.length).toBeGreaterThanOrEqual(5)
    expect(previewFrames.every((event) => event.frame!.width === 480)).toBe(true)
    const gaps = previewFrames.slice(1).map((event, index) => event.receivedAt - previewFrames[index]!.receivedAt)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(180)

    // The split view opens beside it (in another window: a window watches a bot once), and takes 300 ms
    // to take each picture: it drops pictures, never queues them.
    const pane = viewer(300)
    await bots.watch(BOT_A, 'pane', { width: 960, fps: 15, connectionId: 'c2', emit: pane.emit })
    await expect.poll(() => pane.frames().some((event) => event.frame!.width === 960), { timeout: 5_000 }).toBe(true)
    const paneFrom = Date.now()
    await sleep(2_000)
    const paneFrames = pane.frames().filter((event) => event.receivedAt >= paneFrom)
    expect(paneFrames.length).toBeLessThanOrEqual(8)
    expect(paneFrames.length).toBeGreaterThanOrEqual(3)
    // The page stops moving: each view's last picture is the sharp one taken after it stopped.
    await expect.poll(() => pane.frames().at(-1)!.frame!.sharp === true && preview.frames().at(-1)!.frame!.sharp === true, { timeout: 10_000 }).toBe(true)
    expect(pane.frames().at(-1)!.frame!.width).toBe(960)
    bots.unwatch(BOT_A, 'preview', 'c1')
    bots.unwatch(BOT_A, 'pane', 'c2')
  }, 60_000)

  it('never brings a tab to the front for the view: a tab behind shows a still and says so', async () => {
    const { bots, turn, call, origin, workerCalls } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    const opened = await call(bot, 'browser_open', { url: `${origin}/moving.html?tab=first` })
    const first = opened.observation!.tabId
    const view = viewer()
    await bots.watch(BOT_A, 'w1', { width: 480, fps: 5, connectionId: 'c1', emit: view.emit })
    await expect.poll(() => view.frames().length, { timeout: 5_000 }).toBeGreaterThan(0)
    // The bot opens a second tab (it comes to the front), then switches back to the first without acting on it.
    expect((await call(bot, 'browser_tabs', { operation: 'new', url: `${origin}/moving.html?tab=second` })).error).toBeUndefined()
    const methods = workerCalls()
    expect((await call(bot, 'browser_tabs', { operation: 'switch', tabId: first })).error).toBeUndefined()
    await expect.poll(() => view.events.some((event) => event.behind === true), { timeout: 5_000 }).toBe(true)
    const behindAt = view.events.findIndex((event) => event.behind === true)
    // One still picture of the tab behind, then nothing while it stays behind.
    await expect.poll(() => view.events.slice(behindAt).some((event) => event.frame?.sharp), { timeout: 5_000 }).toBe(true)
    await sleep(500)
    const quiet = view.events.length
    await sleep(1_500)
    expect(view.events.length).toBe(quiet)
    // The second tab is still the one Chromium paints: watching the first did not pull it forward.
    const tabs = (await call(bot, 'browser_tabs', { operation: 'list' })).tabs!
    const second = tabs.find((tab) => tab.id !== first)!.id
    expect((await call(bot, 'browser_extract', { tabId: second })).extraction!.text).toMatch(/StaticText visible/)
    expect((await call(bot, 'browser_extract', { tabId: first })).extraction!.text).toMatch(/StaticText hidden/)
    expect(methods).not.toContain('frame')
    // The bot acts on the first tab: it comes to the front and pictures flow again.
    const seen = (await call(bot, 'browser_observe', { tabId: first })).observation!
    const scrolled = await call(bot, 'browser_act', { tabId: first, generation: seen.generation, observationId: seen.observationId,
      controlLeaseId: opened.session!.controlLeaseId, action: { type: 'scroll', deltaX: 0, deltaY: 40 } })
    expect(scrolled.error).toBeUndefined()
    await expect.poll(() => view.events.some((event, index) => index > behindAt && event.behind === false), { timeout: 5_000 }).toBe(true)
    const back = view.events.length
    await expect.poll(() => view.events.slice(back).filter((event) => event.frame).length, { timeout: 5_000 }).toBeGreaterThan(1)
    bots.unwatch(BOT_A, 'w1', 'c1')
  }, 60_000)

  it('tells a watching view when pictures stop, and a view whose connection closed is dropped', async () => {
    const { bots, turn, call, origin, workerCalls } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    expect((await call(bot, 'browser_open', { url: `${origin}/nav-a.html` })).error).toBeUndefined()
    const gone = viewer()
    await bots.watch(BOT_A, 'w-gone', { width: 480, fps: 5, connectionId: 'c-gone', lifetime: gone.lifetime, emit: gone.emit })
    const view = viewer()
    await bots.watch(BOT_A, 'w1', { width: 480, fps: 5, connectionId: 'c1', lifetime: view.lifetime, emit: view.emit })
    await expect.poll(() => view.frames().length && gone.frames().length, { timeout: 5_000 }).toBeTruthy()
    gone.close()
    const methods = workerCalls()
    await bots.close(BOT_A)
    await expect.poll(() => view.events.some((event) => event.stalled), { timeout: 5_000 }).toBe(true)
    expect(gone.events.some((event) => event.stalled)).toBe(false)
    expect((await bots.view(BOT_A)).open).toBe(false)
    // Closed: the worker is asked for nothing more.
    await sleep(1_000)
    expect(methods.filter((method) => method === 'frame.next')).toEqual([])
  }, 60_000)

  it('when the browser\'s process ends, a watching view says so within seconds, and the next use starts it again on the same profile', async () => {
    const { browser, bots, turn, call, origin } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    expect((await call(bot, 'browser_open', { url: `${origin}/nav-a.html` })).error).toBeUndefined()
    const view = viewer()
    await bots.watch(BOT_A, 'w1', { width: 480, fps: 5, connectionId: 'c1', lifetime: view.lifetime, emit: view.emit })
    await expect.poll(() => view.frames().length, { timeout: 5_000 }).toBeGreaterThan(0)
    const { pid } = JSON.parse(await readFile(processRecordPath(browser.workspaceDataDir(botBrowserWorkspace(BOT_A))), 'utf8')) as { pid: number }
    process.kill(pid, 'SIGKILL')
    await expect.poll(() => view.events.find((event) => event.stalled)?.stalled, { timeout: 5_000 }).toBe('The browser stopped.')
    await expect.poll(async () => (await bots.view(BOT_A)).stopped, { timeout: 5_000 }).toBe(true)
    expect((await bots.view(BOT_A)).open).toBe(false)
    // The bot's next use starts it again on the same profile, without restarting anything.
    const again = await call(bot, 'browser_open', { url: `${origin}/nav-b.html` })
    expect(again.error).toBeUndefined()
    expect(again.observation?.url).toContain('/nav-b.html')
    const reopened = await bots.view(BOT_A)
    expect(reopened.open).toBe(true)
    expect(reopened.stopped).toBeUndefined()
    bots.unwatch(BOT_A, 'w1', 'c1')
  }, 60_000)

  it('Take over brings the tab the owner takes to the front: their typing lands and shows, and the view never says "on another tab"', async () => {
    const { bots, turn, call, origin } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    const opened = await call(bot, 'browser_open', { url: `${origin}/owner-input.html` })
    const first = opened.observation!.tabId
    // The bot opens a second tab (it comes to the front), then looks at its first again without acting on it.
    expect((await call(bot, 'browser_tabs', { operation: 'new', url: `${origin}/moving.html?tab=second` })).error).toBeUndefined()
    expect((await call(bot, 'browser_observe', { tabId: first })).error).toBeUndefined()
    const view = viewer()
    await bots.watch(BOT_A, 'w1', { width: 960, fps: 15, connectionId: 'c1', lifetime: view.lifetime, emit: view.emit })
    await expect.poll(() => view.events.some((event) => event.behind === true), { timeout: 5_000 }).toBe(true)
    const behindAt = view.events.findIndex((event) => event.behind === true)
    // The owner takes over the tab they see: it comes to the front.
    expect((await bots.control(BOT_A, 'owner')).control).toBe('owner')
    await expect.poll(() => view.events.some((event, index) => index > behindAt && event.behind === false), { timeout: 5_000 }).toBe(true)
    expect((await call(bot, 'browser_extract', { tabId: first })).extraction!.text).toMatch(/StaticText visible/)
    // Their click and typing land on it, and the view shows them as they are painted.
    const typedFrom = view.events.length
    await bots.input(BOT_A, { kind: 'click', x: 240, y: 100 })
    await bots.input(BOT_A, { kind: 'type', text: 'hello' })
    await expect.poll(() => view.events.slice(typedFrom).some((event) => event.frame), { timeout: 5_000 }).toBe(true)
    const typed = (await call(bot, 'browser_extract', { tabId: first })).extraction!.text
    expect(typed).toMatch(/StaticText visible/)
    expect(typed).toMatch(/StaticText hello/)
    expect((await bots.view(BOT_A)).behind).toBeUndefined()
    await bots.control(BOT_A, 'bot')
    bots.unwatch(BOT_A, 'w1', 'c1')
  }, 60_000)

  it('when the tab in front closes, the bot\'s tab in front before it comes back, and the view says truly which is behind', async () => {
    const { bots, turn, call, origin } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    const opened = await call(bot, 'browser_open', { url: `${origin}/moving.html?tab=one` })
    const one = opened.observation!.tabId
    const two = (await call(bot, 'browser_tabs', { operation: 'new', url: `${origin}/moving.html?tab=two` })).tabs!.find((tab) => tab.id !== one)!.id
    const three = (await call(bot, 'browser_tabs', { operation: 'new', url: `${origin}/moving.html?tab=three` })).tabs!.find((tab) => tab.id !== one && tab.id !== two)!.id
    // The bot acts on the first tab, then on the third: the first was in front just before the third.
    const scroll = async (tabId: string) => {
      const seen = (await call(bot, 'browser_observe', { tabId })).observation!
      expect((await call(bot, 'browser_act', { tabId, generation: seen.generation, observationId: seen.observationId, controlLeaseId: opened.session!.controlLeaseId, action: { type: 'scroll', deltaX: 0, deltaY: 40 } })).error).toBeUndefined()
    }
    await scroll(one)
    await scroll(three)
    // The view follows the first tab, behind the third.
    expect((await call(bot, 'browser_observe', { tabId: one })).error).toBeUndefined()
    const view = viewer()
    await bots.watch(BOT_A, 'w1', { width: 480, fps: 5, connectionId: 'c1', lifetime: view.lifetime, emit: view.emit })
    await expect.poll(() => view.events.some((event) => event.behind === true), { timeout: 5_000 }).toBe(true)
    // The third closes. Chromium would put the second (next to it) in front; the first comes back instead.
    expect((await call(bot, 'browser_tabs', { operation: 'close', tabId: three })).error).toBeUndefined()
    await expect.poll(() => view.events.at(-1)?.behind === false || view.events.filter((event) => event.behind !== undefined).at(-1)?.behind === false, { timeout: 5_000 }).toBe(true)
    expect((await call(bot, 'browser_extract', { tabId: one })).extraction!.text).toMatch(/StaticText visible/)
    expect((await call(bot, 'browser_extract', { tabId: two })).extraction!.text).toMatch(/StaticText hidden/)
    // Pictures flow for it: Chromium paints it.
    const from = view.events.length
    await expect.poll(() => view.events.slice(from).filter((event) => event.frame).length, { timeout: 5_000 }).toBeGreaterThan(2)
    bots.unwatch(BOT_A, 'w1', 'c1')
  }, 60_000)

  it('a tab a site opens does not take the front from the bot\'s tab', async () => {
    const { bots, turn, call, origin } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    const opened = await call(bot, 'browser_open', { url: `${origin}/opens-tab.html` })
    const tabId = opened.observation!.tabId
    const view = viewer()
    await bots.watch(BOT_A, 'w1', { width: 480, fps: 5, connectionId: 'c1', lifetime: view.lifetime, emit: view.emit })
    await expect.poll(() => view.frames().length, { timeout: 5_000 }).toBeGreaterThan(0)
    const seen = (await call(bot, 'browser_observe', {})).observation!
    const link = seen.elements.find((element) => element.role === 'link')!
    expect((await call(bot, 'browser_act', { tabId, generation: seen.generation, observationId: seen.observationId, controlLeaseId: opened.session!.controlLeaseId,
      action: { type: 'click', target: { kind: 'ref', ref: link.ref } } })).error).toBeUndefined()
    // The site's tab opened (it is the site's, not the bot's: the bot's list does not show it), and the bot's tab is still painted.
    await sleep(6_000)
    expect((await call(bot, 'browser_tabs', { operation: 'list' })).tabs!.map((tab) => tab.id)).toEqual([tabId])
    expect((await call(bot, 'browser_extract', { tabId })).extraction!.text).toMatch(/StaticText visible/)
    expect(view.events.some((event) => event.behind === true)).toBe(false)
    bots.unwatch(BOT_A, 'w1', 'c1')
  }, 60_000)

  it('a followed tab that closes itself: the view hears pictures stopped, and each renewal keeps saying so', async () => {
    const { bots, turn, call, origin } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    expect((await call(bot, 'browser_open', { url: `${origin}/nav-a.html` })).error).toBeUndefined()
    // A tab with one page in its history may close itself.
    expect((await call(bot, 'browser_tabs', { operation: 'new', url: `${origin}/closes-itself.html?after=2000` })).error).toBeUndefined()
    const view = viewer()
    const answered = await bots.watch(BOT_A, 'w1', { width: 480, fps: 5, connectionId: 'c1', lifetime: view.lifetime, emit: view.emit })
    expect(answered.stalled).toBeUndefined()
    await expect.poll(() => view.events.some((event) => event.stalled), { timeout: 15_000 }).toBe(true)
    const stalledAt = view.events.findIndex((event) => event.stalled)
    // Renewals (every 5 s in the app) answer that pictures still cannot arrive, and nothing says live.
    for (let renewal = 0; renewal < 3; renewal += 1) {
      await sleep(1_500)
      expect((await bots.watch(BOT_A, 'w1', { width: 480, fps: 5, connectionId: 'c1', lifetime: view.lifetime, emit: view.emit })).stalled).toBeTruthy()
    }
    expect(view.events.slice(stalledAt).some((event) => event.live)).toBe(false)
    expect((await bots.view(BOT_A)).stalled).toBeTruthy()
    bots.unwatch(BOT_A, 'w1', 'c1')
  }, 60_000)

  it('keeps a view whose connection is busy or refuses a picture too large, drops one that is gone, and caps the views', async () => {
    const { bots, turn, call, origin } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    expect((await call(bot, 'browser_open', { url: `${origin}/moving.html?stopAfter=20000` })).error).toBeUndefined()
    // Its first two updates are refused as busy, the third as too large: it stays, and pictures keep coming.
    const busy = viewer()
    let refusals = 0
    const connection = new AbortController()
    await bots.watch(BOT_A, 'w-busy', { width: 480, fps: 5, connectionId: 'c-busy', lifetime: connection.signal, emit: async (event) => {
      refusals += 1
      if (refusals <= 2) throw Object.assign(new Error('Too many pending display frames'), { code: 'resource_limit' })
      if (refusals === 3) throw Object.assign(new Error('Frame size 2000000 exceeds max 1048576'), { name: 'FrameTooLargeError' })
      await busy.emit(event)
    } })
    await expect.poll(() => busy.frames().length, { timeout: 10_000 }).toBeGreaterThan(2)
    // A window that reloaded watches again on the same connection: the watch before it ends.
    const old = viewer()
    await bots.watch(BOT_A, 'w-old', { width: 480, fps: 5, connectionId: 'c-reload', emit: old.emit })
    await expect.poll(() => old.frames().length, { timeout: 5_000 }).toBeGreaterThan(0)
    const fresh = viewer()
    await bots.watch(BOT_A, 'w-new', { width: 480, fps: 5, connectionId: 'c-reload', emit: fresh.emit })
    await sleep(300)
    const oldCount = old.events.length
    await expect.poll(() => fresh.frames().length, { timeout: 5_000 }).toBeGreaterThan(1)
    expect(old.events.length).toBe(oldCount)
    // At most eight views watch one bot.
    for (let index = 0; index < 6; index += 1) await bots.watch(BOT_A, `w${index}`, { width: 480, fps: 5, connectionId: `c${index}`, emit: viewer().emit })
    await expect(bots.watch(BOT_A, 'w-ninth', { width: 480, fps: 5, connectionId: 'c-ninth', emit: viewer().emit })).rejects.toThrow(/Too many views/)
    // A connection that closed: its view is dropped at its next update.
    connection.abort()
    const count = busy.events.length
    await sleep(1_500)
    expect(busy.events.length).toBe(count)
    expect(bots.watch(BOT_A, 'w-ninth', { width: 480, fps: 5, connectionId: 'c-ninth', emit: viewer().emit })).resolves.toBeDefined()
  }, 60_000)
})

interface ModelNavigation { state: string; note?: string; problem?: string; reason?: string; next?: string }
/** An address nothing answers on: a port that was free a moment ago (port 1 would be one Chromium refuses as unsafe). */
async function closedAddress(): Promise<string> {
  const { createServer } = await import('node:net')
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}/`
}
/** A tool result the model reads (an error's text is the same JSON when the page failed). */
const modelResult = (result: Parsed & { error?: string }) => (result.error?.startsWith('{') ? JSON.parse(result.error) : result) as Parsed & { navigation?: ModelNavigation; action?: { outcome: string; navigation?: ModelNavigation } }

describe.skipIf(!chrome.ok)('a slow page is not a failed page', () => {
  it('a page that commits and never finishes loading is still loading, and the browser stays open', async () => {
    const { turn, call, origin } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    const started = Date.now()
    const opened = modelResult(await call(bot, 'browser_open', { url: `${origin}/never-loads.html` }))
    // Done once the document is ready, not when every image has come.
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(opened.error).toBeUndefined()
    expect(opened.navigation).toMatchObject({ state: 'loading', note: expect.stringMatching(/not a failure/) })
    expect(opened.session!.lifecycle).toBe('agent-controlled')
    expect(opened.observation!.warnings).toContain('page-still-loading')
    expect(opened.observation!.elements.some((element) => element.name?.includes('Ready, still loading'))).toBe(true)
    // Waiting for it to finish loading waits, and says it did not.
    expect((await call(bot, 'browser_wait', { tabId: opened.observation!.tabId, condition: { type: 'document-ready' }, timeoutMs: 800 })).error).toMatch(/timeout/)
    // The browser goes on: the same session opens the next page.
    const next = modelResult(await call(bot, 'browser_open', { url: `${origin}/nav-a.html` }))
    expect(next.session!.id).toBe(opened.session!.id)
    expect(next.observation!.warnings).not.toContain('page-still-loading')
  }, 60_000)

  it('a site that can\'t be reached, one that refuses the browser and one that needs a person come back in their class, and the browser stays open', async () => {
    const { turn, call, origin } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    const nowhere = await closedAddress()
    // The first page fails: the session opens anyway, and the model reads the class and what to do next.
    const unreachable = await call(bot, 'browser_open', { url: nowhere })
    expect(unreachable.error).toBeDefined()
    const failed = modelResult(unreachable)
    expect(failed.session!.id).toBeTruthy()
    expect(failed.navigation).toMatchObject({ state: 'failed', problem: 'site_unreachable', next: expect.stringMatching(/^Can't reach 127\.0\.0\.1 \(net::ERR_CONNECTION_REFUSED\)\. Check the address/) })
    // It goes on in the same session.
    const good = modelResult(await call(bot, 'browser_open', { url: `${origin}/nav-a.html` }))
    expect(good.session!.id).toBe(failed.session!.id)
    const page = good.observation!
    const act = (url: string) => call(bot, 'browser_act', { tabId: page.tabId, generation: page.generation, observationId: page.observationId, controlLeaseId: good.session!.controlLeaseId, action: { type: 'navigate', url } })
    expect((await act(nowhere)).error).toMatch(/^site_unreachable: Can't reach 127\.0\.0\.1 \(net::ERR_CONNECTION_REFUSED\)/)
    // An unsafe port is the browser refusing the address itself, not the site.
    const fresh = modelResult(await call(bot, 'browser_observe', { tabId: page.tabId })).observation!
    const refused = await call(bot, 'browser_act', { tabId: fresh.tabId, generation: fresh.generation, observationId: fresh.observationId, controlLeaseId: good.session!.controlLeaseId, action: { type: 'navigate', url: 'http://127.0.0.1:6000/' } })
    expect(refused.error).toMatch(/^browser_refused: This browser won't open that address: its port is one browsers refuse \(net::ERR_UNSAFE_PORT\)/)
    // A sign-in page (401 with its form) opens: a note for the bot to ask its owner, never a failure.
    const signIn = modelResult(await call(bot, 'browser_open', { url: `${origin}/sign-in.html` }))
    expect(signIn.error).toBeUndefined()
    expect(signIn.navigation).toMatchObject({ state: 'ready', shows: ['sign-in-form'], note: expect.stringMatching(/sign-in form\. You have no sign-in of your own: ask your owner to sign in here/) })
    expect(JSON.stringify(signIn.navigation)).not.toMatch(/Don't retry/)
    expect(modelResult(await call(bot, 'browser_tabs', { operation: 'list' })).tabs!.length).toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('the owner\'s view shows the bot\'s new tab loading, and a page the bot could not open even in a tab that closed again', async () => {
    const { bots, turn, call, origin } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    expect((await call(bot, 'browser_open', { url: `${origin}/nav-a.html` })).error).toBeUndefined()
    const view = viewer()
    await bots.watch(BOT_A, 'w1', { width: 480, fps: 5, connectionId: 'c1', emit: view.emit })
    await expect.poll(() => view.frames().length, { timeout: 5_000 }).toBeGreaterThan(0)
    // A new tab on a page that never finishes loading: the view follows it, loading.
    const opened = modelResult(await call(bot, 'browser_open', { url: `${origin}/never-loads.html` }))
    expect(opened.navigation).toMatchObject({ state: 'loading' })
    await expect.poll(() => view.events.some((event) => event.loading === true), { timeout: 5_000 }).toBe(true)
    // A new tab on an address nothing answers on is closed again; the view still says what happened.
    expect((await call(bot, 'browser_open', { url: await closedAddress() })).error).toMatch(/^site_unreachable/)
    await expect.poll(() => view.events.some((event) => event.problem?.kind === 'unreachable'), { timeout: 5_000 }).toBe(true)
    expect((await bots.view(BOT_A)).problem).toMatchObject({ kind: 'unreachable', code: 'net::ERR_CONNECTION_REFUSED' })
    // A page that opens clears it.
    expect((await call(bot, 'browser_open', { url: `${origin}/nav-b.html` })).error).toBeUndefined()
    await expect.poll(() => view.events.at(-1) && (view.events.some((event, index) => index > 0 && event.problem === null)), { timeout: 5_000 }).toBe(true)
    expect((await bots.view(BOT_A)).problem).toBeUndefined()
    // So does the owner's own page, after the bot's failed one.
    expect((await call(bot, 'browser_open', { url: await closedAddress() })).error).toMatch(/^site_unreachable/)
    expect((await bots.view(BOT_A)).problem).toMatchObject({ kind: 'unreachable' })
    await bots.control(BOT_A, 'owner')
    await bots.input(BOT_A, { kind: 'navigate', url: `${origin}/nav-a.html` })
    expect((await bots.view(BOT_A)).problem).toBeUndefined()
    bots.unwatch(BOT_A, 'w1', 'c1')
  }, 60_000)

  it('a thread agent reads a local sign-in page as a form it may fill, and fills it; a bot is told to ask its owner', async () => {
    const { browser, turn, call, origin } = await fixture()
    // A thread's agent, as the orchestrator dispatches it (not a bot).
    const policy = new ExecutionPolicyService().snapshot(profileId, { allowedTools: [...BROWSER_AUTOMATION_TOOLS], allowedCapabilities: [...new Set(BROWSER_AUTOMATION_TOOLS.map(browserToolCapability))], allowedEffects: ['read', 'external'], maxToolCalls: 50, maxElapsedMs: 60_000 })
    const binding = snapshotBrowserExecutionBinding({ execution: { profileId, threadId: 'thread-1', turnId: 'turn-1', actor: { kind: 'main' }, source: 'gui', policySnapshotId: policy.id, cancellationId: 'turn-1' }, policy, mode: 'structured', vision: false })
    const port: BrowserRuntimePort = {
      resolveTarget: () => ({ backend: 'managed-chromium' }),
      requestAccess: async () => 'already-allowed',
      dispatch: async (context, name, args) => {
        const result = await browser.tools.invoke(name, args as Record<string, unknown>, context)
        if (!result.ok) throw new BrowserAutomationError(result.error)
        return result.value
      }
    }
    const agent = async (name: string, args: Record<string, unknown>) => dispatchBrowserTool({ port, binding, name, args })
    const opened = await agent('browser_open', { url: `${origin}/login` })
    expect(opened.isError).toBe(false)
    const result = JSON.parse(opened.text) as Parsed & { navigation?: Record<string, unknown> }
    expect(result.navigation).toMatchObject({ state: 'ready', shows: ['sign-in-form'], note: expect.stringMatching(/sign-in form\. Fill it if you have what it needs/) })
    expect(opened.text).not.toMatch(/Don't retry|needs_person|ask your owner/)
    // It fills the form with the test account it was given, and is signed in.
    const page = result.observation!
    const field = (name: string) => page.elements.find((element) => element.role === 'textbox' && element.name?.includes(name))!
    const act = async (action: Record<string, unknown>, seen: BrowserObservation) => JSON.parse((await agent('browser_act', { sessionId: seen.sessionId, tabId: seen.tabId, generation: seen.generation, observationId: seen.observationId, controlLeaseId: result.session!.controlLeaseId, action })).text) as Parsed
    let seen = (await act({ type: 'fill', target: { kind: 'ref', ref: field('Email').ref }, text: 'tester@local.test' }, page)).action!.observation!
    seen = (await act({ type: 'fill', target: { kind: 'ref', ref: seen.elements.find((element) => element.name?.includes('Password'))!.ref }, text: 'test-password' }, seen)).action!.observation!
    await act({ type: 'click', target: { kind: 'ref', ref: seen.elements.find((element) => element.role === 'button')!.ref } }, seen)
    expect((JSON.parse((await agent('browser_extract', { sessionId: page.sessionId, tabId: page.tabId })).text) as Parsed).extraction!.text).toMatch(/Signed in as tester@local\.test/)
    // A bot on the same page has no sign-in of its own: its note says to ask its owner.
    const bot = turn(BOT_A, 'act-1')
    const botOpened = modelResult(await call(bot, 'browser_open', { url: `${origin}/login` }))
    expect(botOpened.navigation).toMatchObject({ state: 'ready', note: expect.stringMatching(/You have no sign-in of your own: ask your owner to sign in here/) })
  }, 60_000)

  it('the owner signs in by clicking and typing: the view no longer says the page needs a sign-in', async () => {
    const { bots, turn, call, origin } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    expect((await call(bot, 'browser_open', { url: `${origin}/login` })).error).toBeUndefined()
    const view = viewer()
    await bots.watch(BOT_A, 'w1', { width: 960, fps: 15, connectionId: 'c1', emit: view.emit })
    await expect.poll(async () => (await bots.view(BOT_A)).problem, { timeout: 5_000 }).toMatchObject({ kind: 'needs-you', reason: 'sign-in', host: '127.0.0.1' })
    await bots.control(BOT_A, 'owner')
    // The form signs in where it is: no new page commits.
    await bots.input(BOT_A, { kind: 'click', x: 230, y: 66 })
    await bots.input(BOT_A, { kind: 'type', text: 'owner@local.test' })
    await bots.input(BOT_A, { kind: 'click', x: 230, y: 110 })
    await bots.input(BOT_A, { kind: 'type', text: 'secret' })
    await bots.input(BOT_A, { kind: 'key', key: 'Enter' })
    await expect.poll(() => view.events.some((event) => event.problem === null), { timeout: 5_000 }).toBe(true)
    expect((await bots.view(BOT_A)).problem).toBeUndefined()
    await bots.control(BOT_A, 'bot')
    expect((await call(bot, 'browser_extract', {})).extraction!.text).toMatch(/Signed in as owner@local\.test/)
    bots.unwatch(BOT_A, 'w1', 'c1')
  }, 60_000)

  it('what the bot\'s failed new tab ran into stops showing once the bot carries on in the tab the view follows', async () => {
    const { bots, turn, call, origin } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    const opened = modelResult(await call(bot, 'browser_open', { url: `${origin}/nav-a.html` }))
    const view = viewer()
    await bots.watch(BOT_A, 'w1', { width: 480, fps: 5, connectionId: 'c1', emit: view.emit })
    await expect.poll(() => view.frames().length, { timeout: 5_000 }).toBeGreaterThan(0)
    // A new tab on an address nothing answers on closes again; the view says what happened.
    expect((await call(bot, 'browser_open', { url: await closedAddress() })).error).toMatch(/^site_unreachable/)
    await expect.poll(async () => (await bots.view(BOT_A)).problem?.kind, { timeout: 5_000 }).toBe('unreachable')
    // The bot carries on by clicking a link in its tab: the view follows the tab as it is now.
    const seen = modelResult(await call(bot, 'browser_observe', { tabId: opened.observation!.tabId })).observation!
    const link = seen.elements.find((element) => element.role === 'link')!
    expect((await call(bot, 'browser_act', { tabId: seen.tabId, generation: seen.generation, observationId: seen.observationId, controlLeaseId: opened.session!.controlLeaseId, action: { type: 'click', target: { kind: 'ref', ref: link.ref } } })).error).toBeUndefined()
    await expect.poll(async () => (await bots.view(BOT_A)).problem, { timeout: 5_000 }).toBeUndefined()
    expect((await bots.view(BOT_A)).tab?.url).toBe(`${origin}/nav-b.html`)
    bots.unwatch(BOT_A, 'w1', 'c1')
  }, 60_000)

  it('a challenge served with 403 tells the bot to ask its owner; once the page replaces itself the view\'s line clears; a failed address stays in the address field', async () => {
    const { bots, turn, call, origin } = await fixture()
    const bot = turn(BOT_A, 'act-1')
    const first = modelResult(await call(bot, 'browser_open', { url: `${origin}/nav-a.html` }))
    const view = viewer()
    await bots.watch(BOT_A, 'w1', { width: 480, fps: 5, connectionId: 'c1', emit: view.emit })
    await expect.poll(() => view.frames().length, { timeout: 5_000 }).toBeGreaterThan(0)
    // A challenge that arrives with 403 and shows its check a moment later: a person can pass it.
    const challenge = `${origin}/challenge?code=403&after=7000`
    const challenged = await call(bot, 'browser_open', { url: challenge })
    expect(challenged.error).toMatch(/needs_person/)
    expect(challenged.error).toMatch(/ask your owner to take over your browser/)
    expect(challenged.error).not.toMatch(/site_blocked|refused/)
    await expect.poll(async () => (await bots.view(BOT_A)).problem, { timeout: 5_000 }).toMatchObject({ kind: 'needs-you', reason: 'human-check', code: 'HTTP 403' })
    // It passes by itself and reloads the same address, which the site now answers with its page: the line clears.
    await expect.poll(async () => (await bots.view(BOT_A)).problem, { timeout: 15_000 }).toBeUndefined()
    expect((await bots.view(BOT_A)).tab?.url).toBe(challenge)
    expect((await call(bot, 'browser_extract', {})).extraction!.text).toMatch(/Welcome to the shop/)
    // An address nothing answers on, in the tab the view follows: the address field keeps it, so the owner can correct it.
    const nowhere = await closedAddress()
    const seen = modelResult(await call(bot, 'browser_observe', {}))
    const leaseId = first.session!.controlLeaseId
    expect((await call(bot, 'browser_act', { tabId: seen.observation!.tabId, generation: seen.observation!.generation, observationId: seen.observation!.observationId, controlLeaseId: leaseId, action: { type: 'navigate', url: nowhere } })).error).toMatch(/^site_unreachable/)
    await expect.poll(async () => (await bots.view(BOT_A)).problem?.kind, { timeout: 5_000 }).toBe('unreachable')
    await expect.poll(() => view.events.filter((event) => event.tab).at(-1)?.tab?.url, { timeout: 5_000 }).toBe(nowhere)
    expect(view.events.some((event) => event.tab?.url.startsWith('chrome-error:'))).toBe(false)
    bots.unwatch(BOT_A, 'w1', 'c1')
  }, 60_000)

  it('the owner\'s own navigation answers at the commit, and the view shows the page loading or what it ran into', async () => {
    const { bots, origin } = await fixture()
    await bots.open(BOT_A, `${origin}/nav-a.html`)
    const view = viewer()
    await bots.watch(BOT_A, 'w1', { width: 960, fps: 15, connectionId: 'c1', emit: view.emit })
    await expect.poll(() => view.frames().length, { timeout: 5_000 }).toBeGreaterThan(0)
    const started = Date.now()
    await bots.input(BOT_A, { kind: 'navigate', url: `${origin}/never-loads.html` })
    expect(Date.now() - started).toBeLessThan(3_000)
    await expect.poll(() => view.events.some((event) => event.loading === true), { timeout: 5_000 }).toBe(true)
    expect((await bots.view(BOT_A)).loading).toBe(true)
    // A site that can't be reached: the owner's call fails in its class, and the view says so.
    const failed = await bots.input(BOT_A, { kind: 'navigate', url: await closedAddress() }).catch((error: unknown) => error)
    expect(failed).toMatchObject({ code: 'site_unreachable', details: { problem: { kind: 'unreachable', code: 'net::ERR_CONNECTION_REFUSED' } } })
    await expect.poll(() => view.events.some((event) => event.problem?.kind === 'unreachable'), { timeout: 5_000 }).toBe(true)
    // A good page clears it.
    await bots.input(BOT_A, { kind: 'navigate', url: `${origin}/nav-b.html` })
    await expect.poll(() => view.events.at(-1)?.problem === null || view.events.some((event, index) => index > 0 && event.problem === null), { timeout: 5_000 }).toBe(true)
    bots.unwatch(BOT_A, 'w1', 'c1')
  }, 60_000)
})
