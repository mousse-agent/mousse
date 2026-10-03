import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { MmsProfileServices } from '../src/mms/MmsProfileServices'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { MmsBrowserService } from '../src/mms/browser/MmsBrowserService'
import { BrowserArtifactService } from '../src/mms/browser/BrowserArtifactService'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { createMmsChatResourceService } from '../src/mms/chats/resources/createMmsChatResourceService'
import { createChatBrowserRuntime } from '../src/mms/chats/resources/createChatBrowserRuntime'
import type { ChatResourceService } from '../src/mms/chats/resources/ChatResourceService'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../src/shared/browser/automation'
import { MANAGED_BROWSER_ROOT, ensureManagedChrome, startFixtureSite } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()
const fixtures: Array<{ resources: ChatResourceService; browser: MmsBrowserService; broker: BrowserBroker; root: string; closeSite(): Promise<void> }> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.resources.dispose()
    await fixture.browser.dispose()
    await fixture.broker.close()
    await fixture.closeSite()
    await rm(fixture.root, { force: true, recursive: true })
  }
})

async function fixture() {
  const profileId = '11111111-1111-4111-8111-111111111111'
  const root = await mkdtemp(join(tmpdir(), 'mousse-chat-browser-'))
  const threadDirectory = join(root, 'thread'), workspace = join(root, 'workspace'), workerArtifactRoot = join(root, 'worker-artifacts')
  await mkdir(threadDirectory); await mkdir(workspace)
  const broker = new BrowserBroker({ profileRoot: root, browserRoot: MANAGED_BROWSER_ROOT,
    artifactRoot: workerArtifactRoot, policy: createAllowHttpPolicy(), transport: 'in-process' })
  await broker.start()
  const artifacts = new BrowserArtifactService({ profileId, profileRoot: root, workerArtifactRoot })
  const browser = new MmsBrowserService({ profileId, profileRoot: root, workerArtifactRoot, artifacts,
    installationBrowserRoot: MANAGED_BROWSER_ROOT, threadExists: (id) => id === 'group-thread', createManagedBackend: () => broker })
  const services = { profileId, platform: { browser }, threads: { getThreadDir: () => threadDirectory }, ptyManager: { list: () => [] } } as unknown as MmsProfileServices
  const participant = { id: 'agent-a', definitionId: 'agent-a', definitionRevision: 'a'.repeat(64), kind: 'agent' as const, name: 'Scout' }
  const binding = { profileId, chatId: 'group-a', threadId: 'group-thread', workspaceRoot: workspace,
    participants: [{ id: 'self', kind: 'person' as const, name: 'Me' }, participant] }
  const resources = createMmsChatResourceService(services, () => binding)
  const policy = new ExecutionPolicyService().snapshot(profileId, { allowedTools: [...BROWSER_AUTOMATION_TOOLS],
    allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract', 'browser.task'],
    allowedEffects: ['read', 'external'], maxToolCalls: 100, maxElapsedMs: 60_000, maxArtifactBytes: 10 * 1024 * 1024 })
  const context: BrowserToolContext = { execution: { profileId, threadId: 'group-thread', turnId: 'agent-turn', runId: 'execution-a',
    actor: { kind: 'agent', definitionId: participant.definitionId, definitionRevision: participant.definitionRevision }, source: 'gui', policySnapshotId: policy.id, cancellationId: 'cancel-a' },
    policy, signal: new AbortController().signal, vision: true }
  let active = true
  const runtime = createChatBrowserRuntime(services, (execution) => {
    if (!active || execution.profileId !== profileId || execution.threadId !== binding.threadId || execution.runId !== 'execution-a') throw new Error('Inactive or foreign chat execution')
    return binding
  }, resources)
  const site = await startFixtureSite()
  fixtures.push({ resources, browser, broker, root, closeSite: site.close })
  const gui = { profileId, groupId: 'group-a', participantId: 'self', clientId: 'gui-a' }
  return { resources, browser, runtime, context, gui, url: `${site.origin}/form.html`, deactivate: () => { active = false } }
}

describe.skipIf(!chrome.ok)('real group browser sharing', () => {
  it('shares the same page with two viewers and the admitted agent, including cursor and screenshots', async () => {
    const { resources, browser, runtime, context, gui, url } = await fixture()
    const initial = await resources.browserOpen(gui, url)
    expect(initial.observation?.screenshot?.artifactId).toBeTruthy()
    expect(initial.session?.controlLeaseId).toBeUndefined()
    const id = initial.session!.id
    browser.access.set(true)
    expect(await runtime.requestAccess!(context.execution)).toBe('already-allowed')
    const opened = await runtime.dispatch(context, 'browser_open', { url })
    expect(opened.session!.id).toBe(id)
    expect(opened.session!.runId).toBeUndefined()
    expect(opened.session!.controlLeaseId).toBeUndefined()
    expect(browser.sessions.listThreadSessions({ profileId: context.execution.profileId, threadId: context.execution.threadId })).toHaveLength(1)
    const observed = opened.observation!
    const found = await runtime.dispatch(context, 'browser_find', { sessionId: id, tabId: observed.tabId, query: 'Name' })
    const name = found.matches?.find((element) => element.role === 'textbox')!
    expect(name, JSON.stringify(found)).toBeTruthy()
    const result = await runtime.dispatch(context, 'browser_act', { sessionId: id, tabId: observed.tabId,
      generation: observed.generation, observationId: found.observationId, action: { type: 'fill', target: { kind: 'ref', ref: name.ref }, text: 'Agent shared edit' } })
    expect(result.action?.outcome).toBe('verified')
    const other = await resources.snapshot({ ...gui, clientId: 'gui-b' })
    expect(other.browsers).toHaveLength(1)
    expect(other.browsers[0].session!.id).toBe(id)
    expect(other.presence.find((entry) => entry.participant.id === 'agent-a')).toMatchObject({ target: { kind: 'browser', id }, cursor: { kind: 'browser' } })
    const imageObservation = await runtime.dispatch(context, 'browser_screenshot', { sessionId: id })
    const screenshot = await runtime.readScreenshot!(context, id, imageObservation.observation!.screenshot!.artifactId)
    expect(screenshot.mimeType).toBe('image/png')
    expect(Buffer.from(screenshot.data, 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    await resources.browserControl(gui, id, true)
    await expect(runtime.dispatch(context, 'browser_act', { sessionId: id, tabId: observed.tabId,
      generation: observed.generation, observationId: observed.observationId, action: { type: 'reload' } })).rejects.toThrow('person is controlling')
    await resources.browserControl(gui, id, false)
    const refreshed = await resources.browserObserve({ ...gui, clientId: 'gui-b' }, id)
    const extract = await runtime.dispatch(context, 'browser_extract', { sessionId: id, tabId: refreshed.observation!.tabId })
    expect(JSON.stringify(extract)).toContain('Agent shared edit')
  }, 30_000)

  it('rejects inactive runs and denied tools without opening another session', async () => {
    const { resources, browser, runtime, context, gui, url, deactivate } = await fixture()
    await resources.browserOpen(gui, url)
    browser.access.set(true)
    const denied = { ...context, policy: { ...context.policy, allowedTools: ['browser_open'] } }
    await expect(runtime.dispatch(denied, 'browser_open', { url })).rejects.toThrow('denied')
    expect(browser.sessions.listThreadSessions({ profileId: context.execution.profileId, threadId: context.execution.threadId })).toHaveLength(1)
    deactivate()
    expect(() => runtime.resolveTarget(context.execution)).toThrow('Inactive')
    await expect(runtime.dispatch(context, 'browser_observe', {})).rejects.toThrow('Inactive')
  }, 30_000)
})
