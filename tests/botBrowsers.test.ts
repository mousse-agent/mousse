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
import { BotBrowsers, botBrowserWorkspace } from '../src/mms/bots/browser/BotBrowsers'
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
    expect(view).toMatchObject({ open: true, control: 'bot', tab: { url: `${origin}/form.html` }, activationId: 'act-run' })
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
    const { bots, origin } = await fixture()
    const opened = await bots.open(BOT_A, `${origin}/remember.html?set=owner`)
    expect(opened).toMatchObject({ open: true, control: 'owner', tab: { url: `${origin}/remember.html?set=owner` } })
    expect(opened.frame?.mimeType).toBe('image/jpeg')
    expect(opened.cursor).toBeUndefined()
    await bots.input(BOT_A, { kind: 'navigate', url: `${origin}/remember.html` })
    expect((await bots.view(BOT_A, { frame: true })).tab?.url).toBe(`${origin}/remember.html`)
  }, 60_000)
})
