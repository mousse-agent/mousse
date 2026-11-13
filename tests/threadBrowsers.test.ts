/**
 * A thread agent's browser without a window, watched and taken over from the thread (`browser.view.*`),
 * on real managed Chromium (needs the managed Chrome; skipped without it). The agent's calls go through
 * the thread's browser (`MmsBrowserService.dispatch`), as a turn sent from the command line makes them.
 *
 * - The person watches it, takes it over, and a sentence typed with Enter lands whole.
 * - While they hold it, the agent's act, open and new tab are refused in the user's terms; reads go on;
 *   after Give back the agent acts again. Taking over mid-action tells the agent whether it took effect.
 * - The view follows the thread's open session (the one it follows while it lasts, then the newest) and
 *   says when there is none; another thread's view never reaches it.
 * - A hold lasts while its window says it is there, and ends when it stops, as a bot's does.
 * - Nothing is captured while nobody watches.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { MmsBrowserService } from '../src/mms/browser/MmsBrowserService'
import { BrowserArtifactService } from '../src/mms/browser/BrowserArtifactService'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { BrowserAutomationError } from '../src/mms/browser/automation/BrowserSessionManager'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { dispatchBrowserTool } from '../src/mms/orchestrator/browser/dispatch'
import { snapshotBrowserExecutionBinding } from '../src/mms/orchestrator/browser/binding'
import { browserToolCapability } from '../src/mms/orchestrator/browser/tools'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../src/shared/browser/automation'
import type { BrowserRuntimePort } from '../src/shared/browser/runtime'
import { BROWSER_MODIFIERS, type BrowserObservation, type BrowserSessionRecord } from '../src/shared/browser/types'
import type { ThreadBrowserFrameEvent } from '../src/shared/browser/threadView'
import type { WatchedBrowserAck, WatchedBrowserInput, WatchedBrowserSent } from '../src/shared/browser/watched'
import { MANAGED_BROWSER_ROOT, ensureManagedChrome, startFixtureSite } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()
const profileId = '44444444-4444-4444-8444-444444444444'
const THREAD = 'thread-agent'
const OTHER = 'thread-other'
const VIEW = 'view-one'
const PLATFORM = process.platform === 'darwin' ? 'mac' as const : 'other' as const
/** What the agent reads when it acts, opens or loads while the person holds its browser. */
const USER_HOLDS = /^human_controlled: The user is using this browser now\. Wait for them to give it back, or carry on without it\.$/
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fixture(options: { holdLeaseMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mousse-thread-browser-'))
  const workerArtifactRoot = join(root, 'worker-artifacts')
  await mkdir(workerArtifactRoot)
  const broker = new BrowserBroker({ profileRoot: root, browserRoot: MANAGED_BROWSER_ROOT, artifactRoot: workerArtifactRoot, policy: createAllowHttpPolicy(), transport: 'in-process' })
  await broker.start()
  const artifacts = new BrowserArtifactService({ profileId, profileRoot: root, workerArtifactRoot })
  const browser = new MmsBrowserService({ profileId, profileRoot: root, workerArtifactRoot, artifacts, installationBrowserRoot: MANAGED_BROWSER_ROOT,
    threadExists: (threadId) => threadId === THREAD || threadId === OTHER, createManagedBackend: () => broker,
    views: { computerName: 'Test computer', ...(options.holdLeaseMs ? { holdLeaseMs: options.holdLeaseMs } : {}) } })
  const site = await startFixtureSite()
  cleanups.push(async () => {
    await browser.dispose()
    await broker.close()
    await site.close()
    await rm(root, { force: true, recursive: true })
  })
  // The thread's agent, as a turn sent from the command line drives it: the managed browser, through the thread's browser.
  const tools = BROWSER_AUTOMATION_TOOLS.filter((tool) => tool !== 'browser_request_human')
  const policy = new ExecutionPolicyService().snapshot(profileId, { allowedTools: [...tools], allowedCapabilities: [...new Set(tools.map(browserToolCapability))], allowedEffects: ['read', 'external'], maxToolCalls: 500, maxElapsedMs: 600_000 })
  const binding = (threadId: string) => snapshotBrowserExecutionBinding({ mode: 'structured', vision: false, policy,
    execution: { profileId, threadId, turnId: `turn-${threadId}`, actor: { kind: 'main' }, source: 'cli', policySnapshotId: policy.id, cancellationId: `turn-${threadId}` } })
  const port: BrowserRuntimePort = {
    resolveTarget: () => ({ backend: 'managed-chromium' }),
    requestAccess: async () => 'already-allowed',
    dispatch: async (context, name, args) => {
      const result = await browser.dispatch(context, name, args)
      if (!result.ok) throw new BrowserAutomationError(result.error)
      return result.value
    }
  }
  /** One call of the thread agent's, as the model sees the answer. */
  const agent = async (name: string, args: Record<string, unknown>, threadId = THREAD) => {
    const answer = await dispatchBrowserTool({ port, binding: binding(threadId), name, args })
    return { isError: answer.isError, text: answer.text, json: (() => { try { return JSON.parse(answer.text) as Record<string, unknown> } catch { return {} } })() }
  }
  const reader: BrowserToolContext = { execution: { profileId, threadId: THREAD, turnId: 'reader', actor: { kind: 'main' }, source: 'schedule', policySnapshotId: policy.id, cancellationId: 'reader' }, policy, target: { backend: 'managed-chromium' } }
  const lifecycle = (sessionId: string): BrowserSessionRecord['lifecycle'] => browser.sessions.trustedSessionScope({ profileId, threadId: THREAD, sessionId }).record.lifecycle
  /** What the page wrote down (it notes every input that reached it). */
  const page = async (sessionId: string): Promise<string> => {
    const seen = await browser.tools.invoke('browser_observe', { sessionId }, reader)
    if (!seen.ok) throw new Error(seen.error.message)
    const observation = seen.value.observation as BrowserObservation
    return `${observation.elements.map((element) => `${element.name ?? ''} ${element.text ?? ''}`).join(' ')} ${observation.title}`
  }
  const events: ThreadBrowserFrameEvent[] = []
  const watch = () => browser.views.watch(THREAD, 'w1', { width: 960, fps: 30, connectionId: 'c1', viewId: VIEW, emit: async (event) => { events.push(event) } })
  const shown = (): number | undefined => {
    const ids = events.map((event) => event.frame?.id ?? 0).filter((id) => id > 0)
    return ids.length ? Math.max(...ids) : undefined
  }
  let seq = 0
  const send = async (holdId: string, inputs: WatchedBrowserInput[]): Promise<WatchedBrowserAck[]> => {
    const picture = shown()
    const sent: WatchedBrowserSent[] = inputs.map((input) => ({ seq: ++seq, input, ...(picture !== undefined ? { picture } : {}) }))
    return (await browser.views.send(THREAD, VIEW, holdId, sent, 'c1')).acks
  }
  return { browser, agent, page, lifecycle, watch, events, send, origin: site.origin }
}

function keysFor(text: string): WatchedBrowserInput[] {
  return [...text].flatMap((char): WatchedBrowserInput[] => {
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
const press = (x: number, y: number): WatchedBrowserInput[] => [
  { kind: 'pointer', type: 'move', x, y, button: 'none', buttons: 0 },
  { kind: 'pointer', type: 'down', x, y, button: 'left', buttons: 1, clicks: 1 },
  { kind: 'pointer', type: 'up', x, y, button: 'left', buttons: 0, clicks: 1 }
]
const enter: WatchedBrowserInput[] = [
  { kind: 'keys', type: 'down', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 },
  { kind: 'keys', type: 'up', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 }
]

type Opened = { session: BrowserSessionRecord; observation: BrowserObservation }

describe.skipIf(!chrome.ok)('a thread agent\'s browser without a window, from the thread', () => {
  it('is watched and taken over: a sentence and Enter land whole; the agent acts, opens and loads nothing until it is given back', async () => {
    const { browser, agent, page, lifecycle, watch, events, send, origin } = await fixture()
    const frames = vi.spyOn(browser.sessions, 'viewerNext')
    const opened = (await agent('browser_open', { url: `${origin}/input-lab.html` })).json as Opened
    const sessionId = opened.session.id
    // Nobody watches yet: the thread's view knows the browser, and nothing is captured.
    expect(await browser.views.view(THREAD, { viewId: VIEW, connectionId: 'c1' })).toMatchObject({ open: true, control: 'bot' })
    await sleep(300)
    expect(frames).not.toHaveBeenCalled()

    await watch()
    await expect.poll(() => events.filter((event) => event.frame).length, { timeout: 10_000 }).toBeGreaterThan(0)
    const { hold, browser: held } = await browser.views.hold(THREAD, VIEW, { op: 'take', platform: PLATFORM }, 'c1')
    expect(held).toMatchObject({ open: true, control: 'owner', holder: 'this-view' })
    expect(lifecycle(sessionId)).toBe('human-controlled')

    // The person clicks the field, types a sentence and presses Enter: it lands whole.
    const sentence = 'The quick brown fox jumps over the lazy dog'
    const acks = await send(hold!.id, [...press(240, 48), ...keysFor(sentence), ...enter])
    expect(acks.every((ack) => ack.status === 'applied')).toBe(true)
    await expect.poll(() => page(sessionId), { timeout: 5_000 }).toContain(`submitted:${sentence}`)

    // While they hold it, the agent acts, opens and loads nothing, and hears why in the user's terms; it still reads.
    const seen = (await agent('browser_observe', { sessionId })).json as { observation: BrowserObservation; session: BrowserSessionRecord }
    expect(seen.observation.sessionId).toBe(sessionId)
    const sendButton = seen.observation.elements.find((element) => element.name === 'Send')!
    const acted = await agent('browser_act', { sessionId, tabId: seen.observation.tabId, generation: seen.observation.generation, observationId: seen.observation.observationId,
      controlLeaseId: opened.session.controlLeaseId, action: { type: 'click', target: { kind: 'ref', ref: sendButton.ref } } })
    expect(acted).toMatchObject({ isError: true })
    expect(acted.text).toMatch(USER_HOLDS)
    for (const [name, args] of [['browser_open', { url: `${origin}/nav-a.html` }], ['browser_tabs', { sessionId, operation: 'new', url: `${origin}/nav-a.html` }]] as const) {
      const refused = await agent(name, args)
      expect(refused.isError, name).toBe(true)
      expect(refused.text, name).toMatch(USER_HOLDS)
    }
    expect(browser.sessions.listThreadSessions({ profileId, threadId: THREAD })).toHaveLength(1)

    // Give back: the agent has it again and acts.
    await browser.views.hold(THREAD, VIEW, { op: 'release', holdId: hold!.id }, 'c1')
    expect(lifecycle(sessionId)).not.toBe('human-controlled')
    const again = (await agent('browser_observe', { sessionId })).json as { observation: BrowserObservation; session: BrowserSessionRecord }
    const clicked = await agent('browser_act', { sessionId, tabId: again.observation.tabId, generation: again.observation.generation, observationId: again.observation.observationId,
      controlLeaseId: again.session.controlLeaseId, action: { type: 'click', target: { kind: 'ref', ref: again.observation.elements.find((element) => element.name === 'Send')!.ref } } })
    expect(clicked.isError).toBe(false)
  }, 90_000)

  it('taking over while the agent acts tells it the user took over, and whether its action took effect', async () => {
    const { browser, agent, origin } = await fixture()
    const opened = (await agent('browser_open', { url: `${origin}/input-lab.html` })).json as Opened
    await browser.views.view(THREAD, { viewId: VIEW, connectionId: 'c1' })
    const seen = opened.observation
    const go = seen.elements.find((element) => element.name === 'Send')!
    // The agent clicks Send; its cursor glides there first, and the person takes over meanwhile.
    const acting = agent('browser_act', { sessionId: seen.sessionId, tabId: seen.tabId, generation: seen.generation, observationId: seen.observationId,
      controlLeaseId: opened.session.controlLeaseId, action: { type: 'click', target: { kind: 'ref', ref: go.ref } } })
    await sleep(60)
    await browser.views.hold(THREAD, VIEW, { op: 'take', platform: PLATFORM }, 'c1')
    const told = await acting
    expect(told.isError).toBe(true)
    const result = told.json as { action: { outcome: string; code: string; takeover: string; message: string } }
    expect(result.action).toMatchObject({ outcome: 'blocked', code: 'human_controlled', takeover: 'not-applied' })
    expect(result.action.message).toMatch(/^The user took over the browser before this action ran: it was not applied\. .* Wait for them to give the browser back, or carry on without it\.$/)
  }, 60_000)

  it('follows the thread\'s open session and says when there is none; another thread\'s view never reaches it', async () => {
    const { browser, agent, lifecycle, origin } = await fixture()
    const first = ((await agent('browser_open', { url: `${origin}/form.html` })).json as Opened).session.id
    const second = ((await agent('browser_open', { url: `${origin}/nav-a.html` })).json as Opened).session.id
    expect(second).not.toBe(first)
    const takeAndGiveBack = async (): Promise<string> => {
      const { hold } = await browser.views.hold(THREAD, VIEW, { op: 'take', platform: PLATFORM }, 'c1')
      const held = [first, second].filter((id) => browser.sessions.listThreadSessions({ profileId, threadId: THREAD }).some((record) => record.id === id) && lifecycle(id) === 'human-controlled')
      await browser.views.hold(THREAD, VIEW, { op: 'release', holdId: hold!.id }, 'c1')
      expect(held).toHaveLength(1)
      return held[0]!
    }
    // The view kept the session it followed first, while it is open.
    expect(await browser.views.view(THREAD)).toMatchObject({ open: true })
    expect(await takeAndGiveBack()).toBe(first)

    // Another thread's view shows nothing and holds nothing of it.
    expect(await browser.views.view(OTHER, { viewId: VIEW, connectionId: 'c1' })).toMatchObject({ open: false })
    await expect(browser.views.hold(OTHER, VIEW, { op: 'take', force: true, platform: PLATFORM }, 'c1')).rejects.toMatchObject({ code: 'session_closed' })
    expect([lifecycle(first), lifecycle(second)]).not.toContain('human-controlled')

    // The first closes: the view follows the one still open.
    await closeSession(browser, first)
    expect(await takeAndGiveBack()).toBe(second)
    // None is open: the view says so, and there is nothing to take.
    await closeSession(browser, second)
    expect(await browser.views.view(THREAD, { viewId: VIEW, connectionId: 'c1' })).toMatchObject({ open: false })
    await expect(browser.views.hold(THREAD, VIEW, { op: 'take', platform: PLATFORM }, 'c1')).rejects.toMatchObject({ code: 'session_closed', message: 'No browser is open for this thread.' })
  }, 90_000)

  it('a hold lasts while its window says it is there; when it stops, the hold ends and the agent has its browser back', async () => {
    const { browser, agent, lifecycle, origin } = await fixture({ holdLeaseMs: 600 })
    const sessionId = ((await agent('browser_open', { url: `${origin}/form.html` })).json as Opened).session.id
    const { hold } = await browser.views.hold(THREAD, VIEW, { op: 'take', platform: PLATFORM }, 'c1')
    // The window says it is there, longer than one lease: still held.
    for (let beat = 0; beat < 6; beat += 1) {
      await sleep(200)
      await browser.views.hold(THREAD, VIEW, { op: 'renew', holdId: hold!.id }, 'c1')
    }
    expect(lifecycle(sessionId)).toBe('human-controlled')
    // It stops: after one lease the hold ends, and the agent's browser is its own again.
    await expect.poll(() => lifecycle(sessionId), { timeout: 5_000 }).not.toBe('human-controlled')
    await expect(browser.views.hold(THREAD, VIEW, { op: 'renew', holdId: hold!.id }, 'c1')).rejects.toMatchObject({ code: 'hold_ended' })
    const opened = await agent('browser_tabs', { sessionId, operation: 'new', url: `${origin}/nav-a.html` })
    expect(opened.isError).toBe(false)
  }, 60_000)
})

/** Closes a thread's session as the host does (its agent's own scope). */
async function closeSession(browser: MmsBrowserService, sessionId: string): Promise<void> {
  const scope = browser.sessions.trustedSessionScope({ profileId, threadId: THREAD, sessionId })
  const policy = new ExecutionPolicyService().snapshot(profileId, { allowedTools: [...BROWSER_AUTOMATION_TOOLS], allowedCapabilities: ['browser.session'], allowedEffects: ['read', 'external'], maxToolCalls: 10, maxElapsedMs: 60_000 })
  await browser.sessions.close({ execution: { profileId, threadId: scope.threadId, ...(scope.runId ? { runId: scope.runId } : {}), turnId: 'closer', actor: { kind: 'main' }, source: 'cli', policySnapshotId: policy.id, cancellationId: 'closer' }, policy, target: { backend: 'managed-chromium' } }, sessionId)
}
