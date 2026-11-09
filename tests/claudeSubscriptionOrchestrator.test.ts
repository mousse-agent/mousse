import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { createNativeContext, userMessage } from '../src/mms/orchestrator/nativeContext'
import { nativeAgentAssistantMessage, nativeAgentHistory } from '../src/mms/providers/nativeAgentHistory'
import type { ClaudeSubscriptionProviderService } from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'

describe('independent routing turns on one host', () => {
  let home: string
  let main: MousseMainService | undefined
  beforeAll(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-claude-orchestrator-'))
    const providerInit = vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    try {
      main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
      await main.start()
    } finally { providerInit.mockRestore() }
  })
  afterAll(async () => {
    try { await main?.stop() }
    finally {
      vi.restoreAllMocks()
      if (home) rmSync(home, { recursive: true, force: true })
    }
  })

  it.each([['agent', true], ['plan', true], ['agent', false], ['plan', false]] as const)('routes %s turns with project=%s through Claude', async (mode, projectBound) => {
    const host = main!.getInstallationHost()!
    const profile = host.manager.create({ displayName: `Routing ${mode} ${projectBound}`, slug: `routing-${mode}-${projectBound}` })
    const service = await main!.getProfileServices(profile.id)
    await service.start()
    const workspace = mkdtempSync(join(home, 'workspace-'))
    try {
      service.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'account-model' } })
      const inputs: Array<Parameters<ClaudeSubscriptionProviderService['chat']>[0]> = []
      const chat = vi.spyOn(service.claudeSubscription, 'chat').mockImplementation(async (input) => {
        inputs.push(input)
        if (inputs.length === 1) {
          expect(service.orchestrator.steerActiveTurn('accepted guidance', input.threadId)).toBe(true)
          expect(input.drainSteer?.()).toBe('accepted guidance')
          input.onSteer?.('accepted guidance')
        }
        expect(input.mode).toBe(mode === 'plan' ? 'plan' : 'default')
        expect(input.cwd).toBe(projectBound ? workspace : service.claudeSubscription.standaloneWorkspace(input.threadId))
        input.onThinking?.('Considering the request')
        input.onText('Claude answer')
        return 'Claude answer'
      })
      const committed = vi.spyOn(service.claudeSubscription, 'commitConversation')
      const project = service.projects.openProject(workspace)
      const thread = projectBound ? service.threads.createThread('Existing conversation', project.id, workspace) : service.threads.createThread('Standalone conversation')
      await service.orchestrator.send({ content: 'first request', mode }, false, {
        threadId: thread.id
      })
      expect(chat).toHaveBeenCalledOnce()
      expect(committed).toHaveBeenCalledWith(thread.id, expect.stringContaining('Claude answer'))
      const persisted = service.threads.loadThreadData(thread.id)
      expect(persisted.llmContext?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'accepted guidance' }),
        expect.objectContaining({ role: 'assistant', provider: 'claude-subscription', content: [{ type: 'text', text: 'Claude answer' }] })
      ]))
      await service.orchestrator.send({ content: 'second request', mode }, false, { threadId: thread.id })
      expect(inputs[1]?.history).toContain('first request')
      expect(inputs[1]?.history).toContain('accepted guidance')
      expect(inputs[1]?.history).toContain('Claude answer')
      expect(inputs[1]?.history).not.toContain('second request')
    } finally {
      try { await host.disposeProfile(profile.id) } finally { vi.restoreAllMocks() }
    }
  })
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
    expect(persisted.llmContext?.lastTurnUsage).toMatchObject({ input: 50, cacheRead: 100, cacheWrite: 25, modelKey: 'claude-subscription:opus' })
    // Measured on the model; its reasoning level is no part of it.
    expect(persisted.llmContext?.nativeProviderModel).toMatchObject({ contextWindow: 200000, selectedModel: 'opus' })
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
    // Claude's context compacts at the Compact context size; Pi compacts its own near the window.
    expect(differentModel.compactedByRuntime).toBeUndefined()
    main.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'openai', model: 'gpt-5' })
    const onPi = await main.orchestrator.getContextUsage({ draftInput: '', mode: 'agent' }, thread.id)
    expect(onPi.compactedByRuntime).toBe(true)
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})

it('shows the prompt cache a Claude turn left, until the history changes or is compacted', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-claude-cache-'))
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await main.start()
  try {
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' } })
    const thread = main.threads.createThread('Cached Claude')
    const hour = 60 * 60_000
    let promptCache: { at: number; ttlMs?: number } = { at: Date.parse('2026-11-09T09:00:00Z'), ttlMs: hour }
    vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
      input.onText('Cached answer')
      input.onMetrics?.({
        totalResponseTimeMs: 1000,
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 90_000, totalTokens: 90_030, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        context: { input: 10, cacheRead: 0, cacheWrite: 90_000, contextWindow: 200000 },
        promptCache
      })
      return 'Cached answer'
    })
    const usage = () => main.orchestrator.getContextUsage({ draftInput: '', mode: 'agent' }, thread.id)
    expect((await usage()).promptCache).toBeUndefined()
    await main.orchestrator.send({ content: 'first', mode: 'agent' }, false, { threadId: thread.id })
    // A subscription has no price per token.
    expect((await usage()).promptCache).toEqual({ lastRequestAt: Date.parse('2026-11-09T09:00:00Z'), ttlMs: hour })
    expect(main.threads.loadThreadData(thread.id).llmContext?.promptCache).toMatchObject({ lastRequestAt: Date.parse('2026-11-09T09:00:00Z'), ttlMs: hour, modelKey: 'claude-subscription:opus' })
    // A turn that only read the cache keeps the lifetime; the time moves.
    promptCache = { at: Date.parse('2026-11-09T09:30:00Z') }
    await main.orchestrator.send({ content: 'second', mode: 'agent' }, false, { threadId: thread.id })
    expect((await usage()).promptCache).toEqual({ lastRequestAt: Date.parse('2026-11-09T09:30:00Z'), ttlMs: hour })
    // Another model has its own cache.
    main.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'sonnet' })
    expect((await usage()).promptCache).toBeUndefined()
    main.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'opus' })
    expect((await usage()).promptCache).toBeDefined()
    expect(main.threads.loadThreadData(thread.id).llmContext?.promptCache).toMatchObject({ instanceId: 'claude' })
    // Another Claude instance (a second account) on the same model has its own cache.
    main.harness.instanceMap.setEntry('claude:work', { driver: 'claude', enabled: true, config: { home: 'private', displayName: 'Claude (work)' } })
    main.orchestrator.setThreadModelOverride(thread.id, { instanceId: 'claude:work', llmProvider: 'claude-subscription', model: 'opus' })
    const onWork = await usage()
    // Measured as the same model (the instance resolves), with no cache of its own.
    expect(onWork.limit).toBe(200000)
    expect(onWork.promptCache).toBeUndefined()
    main.orchestrator.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'opus' })
    expect((await usage()).promptCache).toBeDefined()
    // A record saved before it named its instance is cold.
    const live = main.orchestrator.getOrCreateSession(thread.id).nativeContext
    const { instanceId: _instance, ...legacy } = live.promptCache!
    live.promptCache = legacy
    expect((await usage()).promptCache).toBeUndefined()
    live.promptCache = { ...legacy, instanceId: 'claude' }
    // Claude Code's own /compact leaves Mousse's history (and its revision) as it was; the cache is cold all the same.
    vi.spyOn(main.claudeSubscription, 'compactConversation').mockResolvedValue(true)
    expect(await main.orchestrator.compactConversationContext(thread.id)).toBe('native')
    expect((await usage()).promptCache).toBeUndefined()
    // A /clear changes the history the same way.
    await main.orchestrator.send({ content: 'third', mode: 'agent' }, false, { threadId: thread.id })
    expect((await usage()).promptCache).toBeDefined()
    main.orchestrator.clearConversationContext(thread.id)
    expect((await usage()).promptCache).toBeUndefined()
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
}, 60_000)

it('undoes a compaction whose result could not be saved: the next turn resumes no compacted session and has the full history', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-claude-compact-failed-'))
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await main.start()
  try {
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' } })
    const thread = main.threads.createThread('Compaction not saved')
    // A conversation long enough for Mousse's own cut.
    const native = []
    const shown = []
    for (let index = 0; index < 12; index += 1) {
      const question = `question ${index} ${'q'.repeat(12_000)}`
      const answer = `answer ${index} ${'a'.repeat(12_000)}`
      native.push(userMessage(question), nativeAgentAssistantMessage(answer, 'opus', 'claude-subscription'))
      shown.push({ id: `u${index}`, role: 'user' as const, content: question, timestamp: new Date().toISOString() }, { id: `a${index}`, role: 'assistant' as const, content: answer, timestamp: new Date().toISOString() })
    }
    main.orchestrator.replaceConversationState(thread.id, shown, createNativeContext(native))
    const key = (history: string) => createHash('sha256').update(history).digest('hex')
    // The Claude service's own record of its sessions: a turn resumes the one saved for exactly the history it is sent.
    const claude = main.claudeSubscription as unknown as { settings: { sessions?: Record<string, { sessionId: string; historyKey?: string }> } }
    const orchestrator = main.orchestrator as unknown as { persist: (immediate?: boolean) => void }
    const realPersist = orchestrator.persist.bind(main.orchestrator)
    for (const runtimeCompacts of [true, false]) {
      const before = main.orchestrator.getNativeContext(thread.id)
      const fullHistory = nativeAgentHistory(before)
      claude.settings.sessions = { ...claude.settings.sessions, [thread.id]: { sessionId: `vendor-${runtimeCompacts}`, cwd: home, instanceId: 'claude', historyKey: key(fullHistory) } as never }
      // Claude Code compacts its session (or has nothing to compact, and Mousse cuts its copy); saving the result fails.
      vi.spyOn(main.claudeSubscription, 'compactConversation').mockResolvedValue(runtimeCompacts)
      const persist = vi.spyOn(orchestrator, 'persist').mockImplementation((immediate) => {
        const row = main.orchestrator.getMessagesForPersistence(thread.id).at(-1)
        if (row?.kind === 'context_compaction' && row.content.startsWith('Context compacted')) throw new Error('disk full')
        return realPersist(immediate)
      })
      await expect(main.orchestrator.compactConversationContext(thread.id)).rejects.toThrow('disk full')
      persist.mockRestore()
      // The session Claude would resume for this thread now.
      const left = claude.settings.sessions?.[thread.id]
      expect(main.orchestrator.getMessagesForPersistence(thread.id).at(-1)).toMatchObject({ content: 'Context not compacted · disk full', compaction: { kept: 'failed' } })
      const after = main.orchestrator.getNativeContext(thread.id)
      expect(after.compaction).toBeUndefined()
      expect(after.activeStartIndex).toBe(before.activeStartIndex)

      // The next turn: the history it is sent.
      let sent: string | undefined
      const chat = vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
        sent = input.history
        input.onText('answer')
        return 'answer'
      })
      await main.orchestrator.send({ content: `next (${runtimeCompacts})`, mode: 'agent' }, false, { threadId: thread.id })
      chat.mockRestore()
      // Mousse's own cut is undone: the turn goes with the full history. A compacted Claude session is dropped, so
      // the turn cannot resume it; a session Claude left as it was still holds exactly that history.
      expect(sent).toBe(fullHistory)
      expect(sent).toContain('question 0')
      if (runtimeCompacts) expect(left).toBeUndefined()
      else expect(left?.historyKey).toBe(key(sent!))
    }
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
}, 60_000)

describe('a turn whose notes come before its tool calls', () => {
  let home: string
  let main: MousseMainService
  beforeAll(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-claude-notes-'))
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await main.start()
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' } })
  })
  afterAll(async () => {
    try { await main?.stop() }
    finally {
      vi.restoreAllMocks()
      rmSync(home, { recursive: true, force: true })
    }
  })

  /** The turn's rows after the user's: replies by their text, timeline rows by their kind. */
  const rows = (threadId: string) =>
    (main.threads.loadThreadData(threadId).messages ?? [])
      .filter((message) => message.role !== 'user')
      .map((message) => (message.role === 'assistant' && !message.kind ? message.content : message.kind))

  it('ends on the answer, in a row of its own after the calls, with the notes in rows above them', async () => {
    const thread = main.threads.createThread('Notes then answer')
    vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
      input.onText('Checking the tests.')
      input.onTool?.({ phase: 'start', callId: 'run-tests', title: 'Bash', toolName: 'Bash' })
      input.onTool?.({ phase: 'complete', callId: 'run-tests', title: 'Bash', toolName: 'Bash' })
      input.onText('Checking the tests.\n\nThey pass. Reading the logs next.')
      input.onTool?.({ phase: 'start', callId: 'read-logs', title: 'Read', toolName: 'Read' })
      input.onTool?.({ phase: 'complete', callId: 'read-logs', title: 'Read', toolName: 'Read' })
      input.onThinking?.('The logs are clean.')
      const text = 'Checking the tests.\n\nThey pass. Reading the logs next.\n\nEverything works: 6 files pass and the logs are clean.'
      input.onText(text)
      return text
    })
    const response = await main.orchestrator.send({ content: 'Check it', mode: 'agent' }, false, { threadId: thread.id })
    expect(rows(thread.id)).toEqual([
      'Checking the tests.',
      'mcp_tool_call',
      'They pass. Reading the logs next.',
      'mcp_tool_call',
      'thinking',
      'Everything works: 6 files pass and the logs are clean.'
    ])
    const answer = main.threads.loadThreadData(thread.id).messages?.at(-1)
    expect(answer?.responseMetadata).toBeDefined()
    // The run's reply is still the turn's whole text.
    expect(response.message).toContain('Checking the tests.')
    expect(response.message).toContain('Everything works')
  })

  it('keeps the last note as the reply of a turn that ends on a call', async () => {
    const thread = main.threads.createThread('Ends on a call')
    vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
      input.onText('Saving the file.')
      input.onTool?.({ phase: 'start', callId: 'write', title: 'Write', toolName: 'Write' })
      input.onTool?.({ phase: 'complete', callId: 'write', title: 'Write', toolName: 'Write' })
      return 'Saving the file.'
    })
    await main.orchestrator.send({ content: 'Save it', mode: 'agent' }, false, { threadId: thread.id })
    expect(rows(thread.id)).toEqual(['Saving the file.', 'mcp_tool_call'])
    const reply = main.threads.loadThreadData(thread.id).messages?.find((message) => message.content === 'Saving the file.')
    expect(reply?.responseMetadata).toBeDefined()
  })

  it('marks the last note incomplete when the turn stops during a call, without repeating it', async () => {
    const thread = main.threads.createThread('Stopped during a call')
    vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
      input.onText('Running the build.')
      input.onTool?.({ phase: 'start', callId: 'build', title: 'Bash', toolName: 'Bash' })
      expect(main.orchestrator.abortActiveTurn(thread.id)).toBe(true)
      throw new Error('aborted')
    })
    await main.orchestrator.send({ content: 'Build it', mode: 'agent' }, false, { threadId: thread.id })
    const replies = (main.threads.loadThreadData(thread.id).messages ?? []).filter((message) => message.role === 'assistant' && !message.kind)
    expect(replies).toEqual([expect.objectContaining({ content: 'Running the build.', incomplete: true })])
  })
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

it('admits a model handoff only on send, retains history and persists one marker across reload', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-model-handoff-'))
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await main.start()
  try {
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' } })
    const thread = main.threads.createThread('Model handoff')
    const histories: string[] = []
    vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async input => {
      histories.push(input.history ?? '')
      input.onText(`Answer from ${input.model}`)
      return `Answer from ${input.model}`
    })
    await main.orchestrator.send({ content: 'first', mode: 'agent' }, false, { threadId: thread.id })
    main.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'sonnet' })
    main.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'haiku' })
    expect(main.orchestrator.getMessages(thread.id).filter(m=>m.kind==='context_handoff')).toHaveLength(0)
    await main.orchestrator.send({ content: 'second', mode: 'agent' }, false, { threadId: thread.id })
    const data = main.threads.loadThreadData(thread.id)
    const markers = data.messages.filter(m=>m.kind==='context_handoff')
    expect(markers).toHaveLength(1)
    expect(markers[0].contextHandoff).toEqual({ from:{provider:'claude-subscription',model:'opus',name:'Claude Opus'}, to:{provider:'claude-subscription',model:'haiku',name:'Claude Haiku'} })
    const userIndex = data.messages.findIndex(m=>m.content==='second')
    expect(data.messages[userIndex+1].kind).toBe('context_handoff')
    expect(histories[1]).toContain('Answer from opus')
    expect(histories[1]).not.toContain('→')
    main.orchestrator.markThreadRestored(thread.id)
    await main.orchestrator.send({ content: 'third', mode: 'agent' }, false, { threadId: thread.id })
    expect(main.threads.loadThreadData(thread.id).messages.filter(m=>m.kind==='context_handoff')).toHaveLength(1)
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})
