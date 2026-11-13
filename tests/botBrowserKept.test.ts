/**
 * A bot's browser answers only through `BotBrowsers` (its owner's view and controls, and the bot's own
 * tools). The general `browser.sessions.*` methods, a thread's agent, a workflow or a group chat that
 * names the bot's home thread, its session or its profile are refused in plain words and change
 * nothing: the owner's hold, the followed tab and the session stay as they were. The same calls for an
 * ordinary thread still work.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { MmsBrowserService } from '../src/mms/browser/MmsBrowserService'
import { BrowserArtifactService } from '../src/mms/browser/BrowserArtifactService'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { registerBrowserMethods } from '../src/mms/browser/registerBrowserMethods'
import { BrowserSessionManager } from '../src/mms/browser/automation/BrowserSessionManager'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { DomainHandlerRegistry } from '../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../src/mms/protocol/handlers'
import { BOT_BROWSER_KEEPER, BotBrowsers, botBrowserWorkspace } from '../src/mms/bots/browser/BotBrowsers'
import { dispatchBrowserTool } from '../src/mms/orchestrator/browser/dispatch'
import { BROWSER_AUTOMATION_TOOLS, type BrowserAutomationTool, type BrowserToolContext } from '../src/shared/browser/automation'
import { BROWSER_GUI_METHODS, BROWSER_VIEWER_CAPABILITY } from '../src/shared/browser/host'
import type { BrowserObservation, BrowserSessionRecord } from '../src/shared/browser/types'
import { MANAGED_BROWSER_ROOT, ensureManagedChrome, startFixtureSite } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()
const profileId = '33333333-3333-4333-8333-333333333333'
const BOT = 'bot-keptkeptkept'
const HOME = 'home-kept'
const THREAD = 'thread-plain'
const BOT_REFUSAL = /belongs to a bot/
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const policy = new ExecutionPolicyService().snapshot(profileId, {
  allowedTools: [...BROWSER_AUTOMATION_TOOLS],
  allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract', 'browser.task'],
  allowedEffects: ['read', 'write', 'external'],
  maxToolCalls: 200,
  maxElapsedMs: 120_000
})

/** A call on `threadId` as a thread's main agent makes it (no run, no keeper). */
function threadContext(threadId: string, source: 'gui' | 'cli' | 'schedule' = 'schedule'): BrowserToolContext {
  return { execution: { profileId, threadId, turnId: `turn-${threadId}`, actor: { kind: 'main' }, source, policySnapshotId: policy.id, cancellationId: `turn-${threadId}` }, policy, target: { backend: 'managed-chromium' }, vision: true }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mousse-bot-kept-'))
  const workerArtifactRoot = join(root, 'worker-artifacts')
  await mkdir(workerArtifactRoot)
  const broker = new BrowserBroker({ profileRoot: root, browserRoot: MANAGED_BROWSER_ROOT, artifactRoot: workerArtifactRoot, policy: createAllowHttpPolicy(), transport: 'in-process' })
  await broker.start()
  const artifacts = new BrowserArtifactService({ profileId, profileRoot: root, workerArtifactRoot })
  const browser = new MmsBrowserService({ profileId, profileRoot: root, workerArtifactRoot, artifacts, installationBrowserRoot: MANAGED_BROWSER_ROOT,
    threadExists: () => true, createManagedBackend: () => broker })
  await browser.setAccess(true)
  const bots = new BotBrowsers({ profileId, browser: () => browser, homeThread: (botId) => botId === BOT ? HOME : undefined, setTimer: () => ({ clear: () => undefined }) })
  const domains = new DomainHandlerRegistry()
  registerBrowserMethods(domains, () => browser)
  domains.seal()
  const site = await startFixtureSite()
  cleanups.push(async () => {
    await bots.removeBot(BOT, true)
    await browser.dispose()
    await broker.close()
    await site.close()
    await rm(root, { force: true, recursive: true })
  })
  /** The owner's app window calling a general browser method. */
  const gui = (method: string, params: Record<string, unknown>) => domains.dispatch({
    connection: { id: 'conn-1', binding: { profileId, epoch: 1 }, capabilities: new Set([BROWSER_VIEWER_CAPABILITY]), clientType: 'gui' }
  } as unknown as HandlerContext, method, params)
  /** The bot's own session record, as its keeper reads it. */
  const botSession = (): BrowserSessionRecord => browser.sessions.trustedSessionScope({ profileId, threadId: HOME, sessionId: browser.sessions.listThreadSessions({ profileId, threadId: HOME, keeper: BOT_BROWSER_KEEPER })[0]!.id, keeper: BOT_BROWSER_KEEPER }).record
  return { root, browser, bots, gui, botSession, origin: site.origin }
}

describe.skipIf(!chrome.ok)('a bot\'s browser answers only through its own view and tools', () => {
  it('refuses every general browser method on the bot\'s home thread or session, and changes nothing', async () => {
    const { browser, bots, gui, botSession, origin } = await fixture()
    // The owner holds the bot's browser, as they do to sign in for it.
    const { browser: opened } = await bots.open(BOT, `${origin}/form.html`)
    expect(opened).toMatchObject({ open: true, control: 'owner', tab: { url: `${origin}/form.html` } })
    const before = botSession()
    expect(before.lifecycle).toBe('human-controlled')
    const view = await bots.view(BOT, { frame: true })
    const sessionId = before.id

    // Listing the bot's home thread shows nothing of it, and asks for no session.
    expect(await gui('browser.sessions.list', { threadId: HOME })).toMatchObject({ sessions: [] })
    expect(await gui('browser.sessions.get', { threadId: HOME })).not.toHaveProperty('session')
    // Every method that names its session is refused in plain words: from its home thread, or another.
    const params: Record<string, Record<string, unknown>> = {
      'browser.sessions.get': { sessionId },
      'browser.sessions.observe': { sessionId },
      'browser.sessions.takeControl': { sessionId },
      'browser.sessions.resume': { sessionId },
      'browser.sessions.close': { sessionId },
      'browser.sessions.humanAction': { sessionId, tabId: 'tab-1', generation: before.generation, observationId: 'obs-1', action: { type: 'click', target: { kind: 'ref', ref: 'e1' } } },
      'browser.artifacts.read': { sessionId, artifactId: 'artifact-1' }
    }
    for (const method of BROWSER_GUI_METHODS.filter((name) => name !== 'browser.sessions.list')) {
      for (const threadId of [HOME, THREAD]) {
        await expect(gui(method, { threadId, ...params[method] }), `${method} on ${threadId}`).rejects.toMatchObject({ code: 'policy_denied', message: expect.stringMatching(BOT_REFUSAL) })
      }
    }

    // Nothing changed: the owner still holds it, on the same tab; their input still lands.
    const after = botSession()
    expect(after).toMatchObject({ id: sessionId, lifecycle: 'human-controlled', generation: before.generation, controlLeaseId: before.controlLeaseId })
    expect(await bots.view(BOT, { frame: true })).toMatchObject({ open: true, control: 'owner', tab: view.tab })
    await bots.input(BOT, { kind: 'navigate', url: `${origin}/nav-a.html` })
    expect((await bots.view(BOT)).tab?.url).toBe(`${origin}/nav-a.html`)
    // The bot's own tools still work once the owner gives it back.
    expect((await bots.control(BOT, 'bot')).control).toBe('bot')
    const turn = bots.turn({ botId: BOT, activationId: 'act-1', lane: 'chat', homeThreadId: HOME, runId: 'run-1', signal: new AbortController().signal })!
    const observed = await dispatchBrowserTool({ port: turn.runtime, binding: turn.binding, name: 'browser_open', args: { url: `${origin}/nav-b.html` } })
    expect(observed.isError).toBe(false)
    expect((JSON.parse(observed.text) as { session: BrowserSessionRecord }).session.id).toBe(sessionId)
  }, 90_000)

  it('refuses a thread\'s agent, a workflow and a group chat that name the bot\'s session or profile', async () => {
    const { browser, bots, botSession, origin } = await fixture()
    const turn = bots.turn({ botId: BOT, activationId: 'act-1', lane: 'run', homeThreadId: HOME, runId: 'run-1', signal: new AbortController().signal })!
    const opened = await dispatchBrowserTool({ port: turn.runtime, binding: turn.binding, name: 'browser_open', args: { url: `${origin}/form.html` } })
    expect(opened.isError).toBe(false)
    const first = JSON.parse(opened.text) as { session: BrowserSessionRecord; observation: BrowserObservation }
    const before = botSession()
    const sessionId = before.id
    const tabId = first.observation.tabId
    const view = await bots.view(BOT, { frame: true })

    // An agent on the home thread itself (the shape of a main-agent turn there: no run) or on another thread.
    for (const context of [threadContext(HOME, 'gui'), threadContext(HOME, 'cli'), threadContext(THREAD)]) {
      const tools: Array<[BrowserAutomationTool, Record<string, unknown>]> = [
        ['browser_observe', { sessionId }],
        ['browser_screenshot', { sessionId }],
        ['browser_tabs', { sessionId, operation: 'new', url: `${origin}/nav-a.html` }],
        ['browser_find', { sessionId, tabId, query: 'Save' }],
        ['browser_extract', { sessionId, tabId }],
        ['browser_wait', { sessionId, tabId, condition: { type: 'text', text: 'Save', present: true } }],
        ['browser_act', { sessionId, tabId, generation: before.generation, observationId: first.observation.observationId, controlLeaseId: before.controlLeaseId, action: { type: 'click', target: { kind: 'ref', ref: 'e1' } } }],
        ['browser_tabs', { sessionId, operation: 'close', tabId }]
      ]
      for (const [name, args] of tools) {
        const result = await browser.tools.invoke(name, args, context)
        expect(result, `${name} from ${context.execution.threadId}`).toMatchObject({ ok: false, error: { code: 'policy_denied', message: expect.stringMatching(BOT_REFUSAL) } })
      }
      // The host's own calls with such a context: watching, holding, typing, closing.
      await expect(browser.sessions.control(context, sessionId, 'human')).rejects.toThrow(BOT_REFUSAL)
      await expect(browser.sessions.frame(context, { sessionId })).rejects.toThrow(BOT_REFUSAL)
      await expect(browser.sessions.humanInput(context, { sessionId, input: { kind: 'navigate', url: `${origin}/nav-a.html` } })).rejects.toThrow(BOT_REFUSAL)
      await expect(browser.sessions.close(context, sessionId)).rejects.toThrow(BOT_REFUSAL)
      expect(() => browser.sessions.latestObservation(context, sessionId)).toThrow(BOT_REFUSAL)
      expect(browser.sessions.list(context).map((session) => session.id)).not.toContain(sessionId)
    }
    // Opening the bot's profile (its sign-ins), as a workflow node's config could ask: refused, nothing opens.
    const workflow = await browser.dispatch(threadContext(THREAD), 'browser_open', { url: `${origin}/remember.html`, persistent: true, workspaceId: botBrowserWorkspace(BOT) })
    expect(workflow).toMatchObject({ ok: false, error: { code: 'policy_denied', message: expect.stringMatching(BOT_REFUSAL) } })
    expect(browser.sessions.listThreadSessions({ profileId, threadId: THREAD })).toEqual([])
    // The group chat and screenshot paths look a session up by its owner first: refused there too.
    expect(() => browser.sessions.trustedSessionScope({ profileId, threadId: HOME, sessionId })).toThrow(BOT_REFUSAL)
    expect(browser.sessions.listThreadSessions({ profileId, threadId: HOME })).toEqual([])
    expect(browser.listPublicSessions(HOME)).toEqual([])
    // A look-alike of the bot's keeper is no keeper.
    expect(() => browser.sessions.trustedSessionScope({ profileId, threadId: HOME, sessionId, keeper: { name: 'bot' } })).toThrow(/not recognised/)

    // Nothing changed: the session, its tab and the bot's tools are as they were.
    expect(botSession()).toMatchObject({ id: sessionId, lifecycle: before.lifecycle, generation: before.generation, controlLeaseId: before.controlLeaseId })
    expect(await bots.view(BOT, { frame: true })).toMatchObject({ open: true, control: 'bot', tab: view.tab })
    const tabs = await dispatchBrowserTool({ port: turn.runtime, binding: turn.binding, name: 'browser_tabs', args: { operation: 'list' } })
    expect((JSON.parse(tabs.text) as { tabs: Array<{ id: string; url: string }> }).tabs).toEqual([expect.objectContaining({ id: tabId, url: `${origin}/form.html` })])
  }, 90_000)

  it('an ordinary thread\'s session still answers the general methods', async () => {
    const { browser, gui, origin } = await fixture()
    const opened = await browser.tools.invoke('browser_open', { url: `${origin}/form.html` }, threadContext(THREAD))
    expect(opened.ok).toBe(true)
    const sessionId = opened.ok ? opened.value.session!.id : ''
    expect(await gui('browser.sessions.list', { threadId: THREAD })).toMatchObject({ sessions: [expect.objectContaining({ id: sessionId })] })
    expect(await gui('browser.sessions.observe', { threadId: THREAD, sessionId })).toMatchObject({ session: { id: sessionId } })
    expect(await gui('browser.sessions.takeControl', { threadId: THREAD, sessionId })).toMatchObject({ session: { id: sessionId, lifecycle: 'human-controlled' } })
    expect(await gui('browser.sessions.resume', { threadId: THREAD, sessionId })).toMatchObject({ session: { id: sessionId } })
    expect(await gui('browser.sessions.close', { threadId: THREAD, sessionId })).toMatchObject({ session: { id: sessionId, lifecycle: 'closed' } })
  }, 60_000)

  it('keeps the bot\'s session after a restart, and one recorded before sessions named their keeper', async () => {
    const { root, browser, bots, origin } = await fixture()
    await bots.open(BOT, `${origin}/form.html`)
    const sessionId = browser.sessions.listThreadSessions({ profileId, threadId: HOME, keeper: BOT_BROWSER_KEEPER })[0]!.id
    const restarted = new BrowserSessionManager({ profileId, profileRoot: root, broker: { call: async () => { throw new Error('no worker') } } })
    expect(restarted.listThreadSessions({ profileId, threadId: HOME })).toEqual([])
    expect(() => restarted.trustedSessionScope({ profileId, threadId: HOME, sessionId })).toThrow(BOT_REFUSAL)
    expect(restarted.listThreadSessions({ profileId, threadId: HOME, keeper: BOT_BROWSER_KEEPER }).map((session) => session.id)).toEqual([sessionId])
  }, 60_000)
})

describe('a bot\'s session recorded before sessions named their keeper', () => {
  it('is kept by its profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-bot-kept-old-'))
    cleanups.push(() => rm(root, { force: true, recursive: true }))
    await mkdir(join(root, 'browser'), { recursive: true })
    const at = new Date().toISOString()
    const record = { id: 'sess_old', profileId, threadId: HOME, persistent: true, workspaceId: botBrowserWorkspace(BOT), backend: 'managed-chromium', browserVersion: '1', generation: 1, lifecycle: 'ready', createdAt: at, updatedAt: at }
    await writeFile(join(root, 'browser', 'automation-sessions.json'), JSON.stringify([{ record, owner: { threadId: HOME } }]))
    const manager = new BrowserSessionManager({ profileId, profileRoot: root, broker: { call: async () => { throw new Error('no worker') } } })
    expect(manager.listThreadSessions({ profileId, threadId: HOME })).toEqual([])
    expect(() => manager.trustedSessionScope({ profileId, threadId: HOME, sessionId: 'sess_old' })).toThrow(BOT_REFUSAL)
    await expect(manager.close(threadContext(HOME), 'sess_old')).rejects.toThrow(BOT_REFUSAL)
    expect(manager.trustedSessionScope({ profileId, threadId: HOME, sessionId: 'sess_old', keeper: BOT_BROWSER_KEEPER }).record.id).toBe('sess_old')
  })
})
