import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { createNativeContext, userMessage } from '../src/mms/orchestrator/nativeContext'
import { nativeAgentAssistantMessage, nativeAgentHistory } from '../src/mms/providers/nativeAgentHistory'
import type { ClaudeSubscriptionProviderService } from '../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'

it.each([['agent', true], ['plan', true], ['agent', false], ['plan', false]] as const)('routes %s turns with project=%s through Claude', async (mode, projectBound) => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-claude-orchestrator-'))
  const workspace = join(home, 'workspace')
  mkdirSync(workspace)
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await main.start()
  try {
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'account-model' } })
    const inputs: Array<Parameters<ClaudeSubscriptionProviderService['chat']>[0]> = []
    const chat = vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
      inputs.push(input)
      if (inputs.length === 1) {
        expect(main.orchestrator.steerActiveTurn('accepted guidance', input.threadId)).toBe(true)
        expect(input.drainSteer?.()).toBe('accepted guidance')
        input.onSteer?.('accepted guidance')
      }
      expect(input.mode).toBe(mode === 'plan' ? 'plan' : 'default')
      expect(input.cwd).toBe(projectBound ? workspace : main.claudeSubscription.standaloneWorkspace(input.threadId))
      input.onThinking?.('Considering the request')
      input.onText('Claude answer')
      return 'Claude answer'
    })
    const committed = vi.spyOn(main.claudeSubscription, 'commitConversation')
    const project = main.projects.openProject(workspace)
    const thread = projectBound ? main.threads.createThread('Existing conversation', project.id, workspace) : main.threads.createThread('Standalone conversation')
    await main.orchestrator.send({ content: 'first request', mode }, false, {
      threadId: thread.id
    })
    expect(chat).toHaveBeenCalledOnce()
    expect(committed).toHaveBeenCalledWith(thread.id, expect.stringContaining('Claude answer'))
    const persisted = main.threads.loadThreadData(thread.id)
    expect(persisted.llmContext?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'accepted guidance' }),
      expect.objectContaining({ role: 'assistant', provider: 'claude-subscription', content: [{ type: 'text', text: 'Claude answer' }] })
    ]))
    await main.orchestrator.send({ content: 'second request', mode }, false, { threadId: thread.id })
    expect(inputs[1]?.history).toContain('first request')
    expect(inputs[1]?.history).toContain('accepted guidance')
    expect(inputs[1]?.history).toContain('Claude answer')
    expect(inputs[1]?.history).not.toContain('second request')
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})

it('persists Claude measurements, populates response metadata and counts usage and edits once per turn', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-claude-metrics-'))
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await main.start()
  try {
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus:low' } })
    const thread = main.threads.createThread('Measured Claude')
    const before = await main.orchestrator.getContextUsage({ draftInput: 'draft', mode: 'agent' }, thread.id)
    expect(before.limit).toBe(0)
    expect(before.used).toBeGreaterThan(0)
    expect(before.source).toBe('estimated')
    vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
      input.onText('Measured answer')
      input.onLineEdits?.(3)
      input.onMetrics?.({
        realModelName: 'claude-opus-official', totalResponseTimeMs: 2000,
        totalTokensUsed: 370, tokensPerSecond: 10,
        usage: { input: 100, output: 20, cacheRead: 200, cacheWrite: 50, totalTokens: 370, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        context: { input: 50, cacheRead: 100, cacheWrite: 25, contextWindow: 200000, modelName: 'claude-opus-official' }
      })
      return 'Measured answer'
    })
    for (let turn = 0; turn < 2; turn += 1) {
      await main.orchestrator.send({ content: `request ${turn}`, mode: 'agent' }, false, { threadId: thread.id })
    }
    const persisted = main.threads.loadThreadData(thread.id)
    const answer = persisted.messages?.find((message) => message.content === 'Measured answer')
    expect(answer?.responseMetadata).toEqual({ modelName: 'claude-opus-official', totalResponseTimeMs: 2000, tokensUsed: 370, tokensPerSecond: 10 })
    const nativeAnswer = persisted.llmContext?.messages.find((message) => message.role === 'assistant')
    expect(nativeAnswer).toMatchObject({ usage: { input: 100, output: 20, cacheRead: 200, cacheWrite: 50 } })
    expect(persisted.llmContext?.lastTurnUsage).toMatchObject({ input: 50, cacheRead: 100, cacheWrite: 25, modelKey: 'claude-subscription:opus:low' })
    expect(persisted.llmContext?.nativeProviderModel).toMatchObject({ contextWindow: 200000, selectedModel: 'opus:low' })
    main.orchestrator.markThreadRestored(thread.id)
    const measured = await main.orchestrator.getContextUsage({ draftInput: '', mode: 'agent' }, thread.id)
    expect(measured).toMatchObject({ source: 'measured', limit: 200000, modelName: 'claude-opus-official', processedTokens: 370 })
    expect(measured.categories[0]).toMatchObject({ tokens: 50 })
    expect(main.lineEditStats.getUsageSnapshot().turns).toHaveLength(2)
    expect(main.lineEditStats.getUsageSnapshot().totals).toMatchObject({ input: 200, output: 40, tokens: 740 })
    expect(main.lineEditStats.getSnapshot().totalTab).toBe(6)
    main.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'sonnet' })
    const differentModel = await main.orchestrator.getContextUsage({ draftInput: '', mode: 'agent' }, thread.id)
    expect(differentModel).toMatchObject({ source: 'estimated', limit: 0, modelName: 'sonnet' })
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})

it.each([false, true])('applies Mousse context compactionEnabled=%s to Claude history', async (enabled) => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-claude-compaction-'))
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await main.start()
  try {
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' }, context: { compactionEnabled: enabled, compactionTokens: 128000 } })
    const thread = main.threads.createThread('Claude compaction')
    const context = createNativeContext(Array.from({ length: 4 }, (_, index) => [
      userMessage(`old request ${index}: ` + 'context '.repeat(25000)),
      nativeAgentAssistantMessage(`old answer ${index}: ` + 'answer '.repeat(25000), 'opus', 'claude-subscription')
    ]).flat())
    context.nativeProviderModel = { provider: 'claude-subscription', selectedModel: 'opus', modelName: 'claude-opus-official', contextWindow: 200000 }
    const data = main.threads.loadThreadData(thread.id)
    main.threads.saveThreadData(thread.id, { ...data, llmContext: context })
    let history = ''
    vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
      history = input.history ?? ''
      input.onText('New answer')
      return 'New answer'
    })
    await main.orchestrator.send({ content: 'next request', mode: 'agent' }, false, { threadId: thread.id })
    const persisted = main.threads.loadThreadData(thread.id)
    expect(Boolean(persisted.llmContext?.compaction)).toBe(enabled)
    expect(Boolean(JSON.parse(history).summary)).toBe(enabled)
    expect(persisted.llmContext?.nativeProviderModel?.contextWindow).toBe(200000)
    // The changed history is precisely what the provider hashes before deciding
    // whether its official SDK conversation can be resumed.
    if (enabled) expect(history).not.toBe(nativeAgentHistory(context))
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})

it.each(['error', 'abort'])('counts measured partial Claude usage once on %s', async (outcome) => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-claude-partial-'))
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await main.start()
  try {
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' } })
    const thread = main.threads.createThread('Partial Claude')
    const controller = new AbortController()
    vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
      input.onMetrics?.({ totalResponseTimeMs: 200, totalTokensUsed: 10, usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
      if (outcome === 'abort') controller.abort()
      throw new Error('Interrupted test turn')
    })
    await main.orchestrator.send({ content: 'request', mode: 'agent' }, false, { threadId: thread.id, externalSignal: controller.signal })
    expect(main.lineEditStats.getUsageSnapshot().turns).toHaveLength(1)
    expect(main.lineEditStats.getUsageSnapshot().totals).toMatchObject({ input: 8, output: 2, tokens: 10 })
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})

it.each([false, true])('retries Claude context overflow only before provider progress (tool started=%s)', async (toolStarted) => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-claude-overflow-'))
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await main.start()
  try {
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' }, context: { compactionEnabled: true, compactionTokens: 128000 } })
    const thread = main.threads.createThread('Overflow Claude')
    const context = createNativeContext(Array.from({ length: 3 }, () => [
      userMessage('old request ' + 'a'.repeat(40000)),
      nativeAgentAssistantMessage('old answer ' + 'b'.repeat(40000), 'opus', 'claude-subscription')
    ]).flat())
    main.threads.saveThreadData(thread.id, { ...main.threads.loadThreadData(thread.id), llmContext: context })
    let calls = 0
    const chat = vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
      calls += 1
      if (calls === 1) {
        if (toolStarted) input.onTool?.({ phase: 'start', callId: 'write-file', title: 'Write' })
        throw new Error('maximum context exceeded')
      }
      expect(JSON.parse(input.history ?? '{}').summary).toBeTruthy()
      input.onText('Recovered answer')
      return 'Recovered answer'
    })
    await main.orchestrator.send({ content: 'request', mode: 'agent' }, false, { threadId: thread.id })
    expect(chat).toHaveBeenCalledTimes(toolStarted ? 1 : 2)
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})
