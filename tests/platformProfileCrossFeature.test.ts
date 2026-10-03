import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LegacyControlCredentials } from '../src/mms/profiles/migration/LegacyControlCredentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { BROWSER_ATTACHED_V1_CAPABILITY } from '../src/shared/browser/connectionCommands'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../src/shared/browser/automation'
import { BROWSER_VIEWER_CAPABILITY } from '../src/shared/browser/host'
import { PROFILES_V1_CAPABILITY } from '../src/shared/profiles/types'
import type { WorkflowBundle } from '../src/shared/workflows'
import { WORKFLOW_RUN_CAPABILITY } from '../src/shared/workflowRunPlatform'
import { FakeAttachedExecutor } from './fixtures/agent-platform/browser-daemon-composition/fakeAttachedExecutor'

const OWNER_TOKEN = 'cross-feature-owner-token'
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  // Windows may deliver one final fs.watch completion after close; let profile
  // shutdown callbacks settle before removing their task-owned roots.
  await new Promise((resolve) => setTimeout(resolve, 50))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `mousse-${label}-`))
  roots.push(root)
  return root
}

function browserContext(profileId: string, threadId: string): BrowserToolContext {
  const policy = {
    version: 1 as const, id: `policy-${profileId}`, profileId,
    allowedTools: [...BROWSER_AUTOMATION_TOOLS],
    allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract', 'browser.task'],
    allowedEffects: ['read', 'write', 'external'] as const, approvalEffects: [] as const,
    maxToolCalls: 40, maxElapsedMs: 60_000, maxArtifactBytes: 1024 * 1024
  }
  return { execution: { profileId, threadId, turnId: 'cross-feature-turn', actor: { kind: 'main' },
    policySnapshotId: policy.id, source: 'gui', cancellationId: 'cross-feature-cancel' }, policy }
}

function approvalWorkflow(): WorkflowBundle {
  const id = randomUUID()
  return { assets: [], manifest: {
    schemaVersion: 1, id, name: 'Cross-feature waiting workflow', slug: `cross-${id.slice(0, 8)}`,
    entryNodeId: 'start', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    permissions: { capabilities: ['human.approval'] },
    nodes: [
      { id: 'start', type: 'start', version: 1, config: {} },
      { id: 'approval', type: 'approval', version: 1, config: { action: 'continue', proposal: 'Hold profile A active' } },
      { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'input', pointer: '' } } }
    ],
    edges: [
      { from: 'start', port: 'next', to: 'approval' },
      { from: 'approval', port: 'approved', to: 'end' },
      { from: 'approval', port: 'denied', to: 'end' }
    ]
  } }
}

const nativeResult = (text: string) => ({
  text, usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  modelName: 'fixture', totalResponseTimeMs: 1, totalTokensUsed: 5, tokensPerSecond: 5,
  contextInputs: { systemPromptText: '', mcpToolsText: '', otherToolsText: '', signature: 'cross-feature' },
  toolEvents: [], nativeMessages: []
})

describe('profile cross-feature production composition', () => {
  it('switches A to B while chat, workflow, and attached browser are active without publishing late A state into B', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = tempRoot('profile-cross-switch'), home = join(root, 'home')
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false, headless: true })
    const host = main.getInstallationHost()!
    const a = host.manager.create({ displayName: 'Profile A', slug: 'profile-a' })
    const b = host.manager.create({ displayName: 'Profile B', slug: 'profile-b' })
    const aServices = await main.getProfileServices(a.id)
    const bServices = await main.getProfileServices(b.id)
    const aThread = aServices.threads.createThread('A active thread')
    const bThread = bServices.threads.createThread('B thread')
    const bundle = approvalWorkflow()
    const draft = aServices.platform.workflowDefinitions.saveDraft({ bundle })
    const published = aServices.platform.workflowDefinitions.publish({ definitionId: bundle.manifest.id,
      expectedDraftSemanticHash: draft.semanticHash, expectedHeadRevisionId: null })
    const run = await aServices.platform.workflowRuns.start({ profileId: a.id, threadId: aThread.id,
      definitionId: bundle.manifest.id, revisionId: published.head!.revisionId, requestId: randomUUID(), input: {} }, { source: 'gui' })
    await vi.waitFor(async () => expect((await aServices.platform.workflowRuns.runtime.get(run.manifest.runId, { profileId: a.id })).manifest.state).toBe('waiting-approval'))

    const server = new MmsProtocolServer({ mms: main, ownerToken: OWNER_TOKEN, commandRouter: main.browserCommandRouter })
    const endpoint = await server.start()
    const client = new LocalMmsClient({ homeDir: home, endpoint, ownerToken: OWNER_TOKEN, clientType: 'gui',
      requestedCapabilities: [PROFILES_V1_CAPABILITY, WORKFLOW_RUN_CAPABILITY, BROWSER_ATTACHED_V1_CAPABILITY, BROWSER_VIEWER_CAPABILITY] })
    const executor = new FakeAttachedExecutor(aServices.platform.workerArtifactRoot)
    client.setAttachedBrowserCommandHandler(executor.handle)
    let releaseChat!: () => void
    let chatEntered!: () => void
    const entered = new Promise<void>((resolve) => { chatEntered = resolve })
    const events: unknown[] = []
    try {
      await client.connect()
      await client.request('profiles.bind', { profile: a.id })
      const registrationId = randomUUID()
      const closureToken = randomBytes(32).toString('base64url')
      await client.request('browser.attachments.register', { registrationId, registrationEpoch: 1,
        closureToken, uiTabId: 'cross-window:tab-a' })
      await client.request('browser.attachments.select', { uiTabId: 'cross-window:tab-a', threadId: aThread.id })
      await client.request('browser.access.set', { allowed: true })
      const opened = await aServices.platform.browser.dispatch(browserContext(a.id, aThread.id), 'browser_open', {})
      expect(opened.ok).toBe(true)

      const llm = (aServices.orchestrator as unknown as { llm: { getSelectedModelContextLimit(): { limit: number }; getContextInputs(): Promise<unknown>; chat(): Promise<unknown> } }).llm
      vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
      vi.spyOn(llm, 'getContextInputs').mockResolvedValue(nativeResult('').contextInputs)
      vi.spyOn(llm, 'chat').mockImplementation(async () => {
        chatEntered()
        await new Promise<void>((resolve) => { releaseChat = resolve })
        return nativeResult('late answer owned by A')
      })
      client.onEvent((event) => events.push(event))
      await client.subscribe(0)
      const pendingChat = client.request<{ message: string }>('orchestrator.send', { threadId: aThread.id, content: 'hold A active' })
      await entered
      // A real profile switch drains the window-owned raw browser session before
      // rebinding its connection; unregister is the host's explicit close proof.
      await client.request('browser.sessions.close', { threadId: aThread.id, sessionId: opened.ok ? opened.value.session!.id : '' })
      await client.request('browser.attachments.unregister', { registrationId, registrationEpoch: 1 })
      await client.request('profiles.bind', { profile: b.id })
      releaseChat()
      await expect(pendingChat).resolves.toMatchObject({ message: 'late answer owned by A' })
      await new Promise((resolve) => setTimeout(resolve, 30))

      expect(aServices.orchestrator.getMessages(aThread.id).some((message) => message.content === 'late answer owned by A')).toBe(true)
      expect(bServices.orchestrator.getMessages(bThread.id).some((message) => message.content.includes('late answer owned by A'))).toBe(false)
      expect(JSON.stringify(events)).not.toContain('late answer owned by A')
      await expect(client.request('browser.sessions.list', { threadId: aThread.id })).rejects.toMatchObject({ code: 'invalid_action' })
      await expect(client.request('workflowRuns.get', { profileId: b.id, runId: run.manifest.runId })).rejects.toMatchObject({ code: 'run_not_found' })
      expect(aServices.platform.browser.managedDispatchAttempted).toBe(false)
    } finally {
      releaseChat?.()
      await aServices.platform.workflowRuns.runtime.cancel(run.manifest.runId, { profileId: a.id }, 'cross-feature fixture complete').catch(() => undefined)
      try {
        await vi.waitFor(() => expect({ platform: aServices.platform.getActiveCount(), browser: aServices.platform.browser.getActiveCount(),
          native: aServices.platform.agentRuns.getActiveCount(), pendingGuest: aServices.platform.browser.pendingAttachedGuestAcks() }).toEqual({
          platform: 0, browser: 0, native: 0, pendingGuest: []
        }))
      } finally {
        try {
          client.beginCommandShutdown()
          await client.awaitCommandShutdown(5_000)
        } finally {
          await client.close()
          try { await server.stop() } finally { await main.stop() }
        }
      }
    }
  }, 30_000)

  it('serializes two profile mutations of one Git repository and keeps measured provider usage profile-owned', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = tempRoot('profile-cross-repo'), repo = join(root, 'repo'), home = join(root, 'home')
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: repo }); execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo }); execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repo })
    writeFileSync(join(repo, 'base.txt'), 'base\n'); execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo })
    const main = await MousseMainService.create({ homeDir: home, repoRoot: repo, requireOwnership: false, headless: true })
    const host = main.getInstallationHost()!, b = host.manager.create({ displayName: 'Profile B', slug: 'profile-b' })
    const aServices = main, bServices = await main.getProfileServices(b.id)
    const actionA = new ThreadActionService(join(aServices.getProfileHomeDir(), 'threads', 'lease-a'))
    const actionB = new ThreadActionService(join(bServices.getProfileHomeDir(), 'threads', 'lease-b'))
    mkdirSync(join(aServices.getProfileHomeDir(), 'threads', 'lease-a'), { recursive: true })
    mkdirSync(join(bServices.getProfileHomeDir(), 'threads', 'lease-b'), { recursive: true })
    let releaseA!: () => void
    let enteredA!: () => void
    const firstEntered = new Promise<void>((resolve) => { enteredA = resolve })
    const order: string[] = []
    const options = (threadId: string) => ({ threadId, turnId: `turn-${threadId}`, conversationBranchId: 'main' as const,
      workspacePath: repo, presentationMessageStart: 0, presentationMessageEnd: 0,
      nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'cross-profile-test' } })
    try {
      const first = actionA.runCheckpointedAction(options('a'), async () => { order.push('A'); enteredA(); await new Promise<void>((resolve) => { releaseA = resolve }) })
      await firstEntered
      const second = actionB.runCheckpointedAction(options('b'), async () => { order.push('B') })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(order).toEqual(['A'])
      releaseA()
      await Promise.all([first, second])
      expect(order).toEqual(['A', 'B'])

      expect(aServices.providerAuth).toBe(bServices.providerAuth)
      await aServices.providerAuth.setApiKey('openai', 'shared-fixture-key')
      expect(bServices.providerAuth.credentials.has('openai')).toBe(true)
      aServices.lineEditStats.recordUsage({ timestamp: '2026-09-11T00:00:00.000Z', provider: 'openai', model: 'shared-model', input: 11, output: 1, cacheRead: 0, cacheWrite: 0 })
      bServices.lineEditStats.recordUsage({ timestamp: '2026-09-11T00:00:01.000Z', provider: 'openai', model: 'shared-model', input: 22, output: 2, cacheRead: 0, cacheWrite: 0 })
      expect(aServices.lineEditStats.getUsageSnapshot().totals.tokens).toBe(12)
      expect(bServices.lineEditStats.getUsageSnapshot().totals.tokens).toBe(24)
    } finally {
      releaseA?.()
      await main.stop()
    }
  }, 20_000)

  it('keeps inert legacy credential inventories separate from shared provider credentials', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = tempRoot('profile-cross-control')
    const main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, requireOwnership: false, headless: true })
    const host = main.getInstallationHost()!, b = host.manager.create({ displayName: 'Profile B', slug: 'profile-b' })
    const bServices = await main.getProfileServices(b.id)
    try {
      new LegacyControlCredentials(main.getProfileHomeDir()).saveCredentials({ accountId: 'account-a', deviceEnrollmentToken: 'device-a', updatedAt: new Date().toISOString() })
      new LegacyControlCredentials(bServices.getProfileHomeDir()).saveCredentials({ accountId: 'account-b', deviceEnrollmentToken: 'device-b', updatedAt: new Date().toISOString() })
      await main.providerAuth.setApiKey('openai', 'installation-provider-key')
      expect(new LegacyControlCredentials(main.getProfileHomeDir()).getCredentials()?.accountId).toBe('account-a')
      expect(new LegacyControlCredentials(bServices.getProfileHomeDir()).getCredentials()).toMatchObject({ accountId: 'account-b', deviceEnrollmentToken: 'device-b' })
      expect(main.net.status()).toMatchObject({ enabled: false, keystore: 'missing' })
      expect(bServices.net.status()).toMatchObject({ enabled: false, keystore: 'missing' })
      expect(main.providerAuth).toBe(bServices.providerAuth)
      expect(await bServices.providerAuth.credentials.read('openai')).toMatchObject({ key: 'installation-provider-key' })
    } finally {
      await main.stop()
    }
  })
})
