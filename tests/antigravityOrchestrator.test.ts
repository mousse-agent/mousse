import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { methods, PROTOCOL_VERSION, type AgentApp } from '@agentclientprotocol/sdk'
import { expect, it, vi } from 'vitest'
import { newId } from '../src/shared/net'
import { MmsRemoteBackend } from '../src/mms/bridge/remote/MmsBackend'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { AntigravityProviderService } from '../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { antigravityDriver } from '../src/mms/harness/drivers/antigravity'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { inProcessAgent } from '../src/mms/run/testkit/acpAgent'
import { ThreadRuntimeManager } from '../src/mms/runtime/ThreadRuntimeManager'
import { BACKGROUND_SUMMARY } from '../src/shared/agentActivity'
import { phase6Daemon, waitFor } from './run/phase6Fixture'

it('persists ACP replies and accepted steer in canonical context and forwards it on the next turn', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-acp-orchestrator-'))
  const workspace = join(home, 'workspace')
  mkdirSync(workspace)
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await main.start()
  try {
    main.settings.set({ provider: { llmProvider: 'antigravity', model: 'account-model' } })
    const inputs: Array<Parameters<AntigravityProviderService['chat']>[0]> = []
    const chat = vi.spyOn(main.antigravity, 'chat').mockImplementation(async (input) => {
      inputs.push(input)
      if (inputs.length === 1) {
        expect(main.orchestrator.steerActiveTurn('accepted guidance', input.threadId)).toBe(true)
        expect(input.drainSteer?.()).toBe('accepted guidance')
        input.onSteer?.('accepted guidance')
      }
      input.onText('ACP answer')
      return 'ACP answer'
    })
    const committed = vi.spyOn(main.antigravity, 'commitConversation')
    const project = main.projects.openProject(workspace)
    const thread = main.threads.createThread('Existing conversation', project.id, workspace)
    await main.orchestrator.send({ content: 'first request', mode: 'agent' }, false, {
      threadId: thread.id
    })
    expect(chat).toHaveBeenCalledOnce()
    expect(committed).toHaveBeenCalledWith(thread.id, expect.stringContaining('ACP answer'))
    const persisted = main.threads.loadThreadData(thread.id)
    expect(persisted.llmContext?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'accepted guidance' }),
      expect.objectContaining({ role: 'assistant', provider: 'antigravity', content: [{ type: 'text', text: 'ACP answer' }] })
    ]))
    await main.orchestrator.send({ content: 'second request', mode: 'agent' }, false, { threadId: thread.id })
    expect(inputs[1]?.history).toContain('first request')
    expect(inputs[1]?.history).toContain('accepted guidance')
    expect(inputs[1]?.history).toContain('ACP answer')
    expect(inputs[1]?.history).not.toContain('second request')
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})

it('persists tokensUsed and tokensPerSecond in responseMetadata for Antigravity Gemini turns', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-acp-metadata-'))
  const workspace = join(home, 'workspace')
  mkdirSync(workspace)
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await main.start()
  try {
    main.settings.set({ provider: { llmProvider: 'antigravity', model: 'gemini-4-neon' } })
    vi.spyOn(main.antigravity, 'chat').mockImplementation(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      input.onText('Gemini response')
      input.onUsage?.({ input: 2145, output: 20, cacheRead: 8752, cacheWrite: 0, reasoning: 18, totalTokens: 10917, hasOutput: true })
      return 'Gemini response'
    })
    const project = main.projects.openProject(workspace)
    const thread = main.threads.createThread('Gemini metadata check', project.id, workspace)
    await main.orchestrator.send({ content: 'hello', mode: 'agent' }, false, { threadId: thread.id })
    const persisted = main.threads.loadThreadData(thread.id)
    const assistant = persisted.messages.find((message) => message.role === 'assistant' && message.content === 'Gemini response')
    expect(assistant?.responseMetadata?.modelName).toBe('gemini-4-neon')
    expect(assistant?.responseMetadata?.tokensUsed).toBe(10917)
    expect(assistant?.responseMetadata?.tokensPerSecond).toBeGreaterThan(0)
    expect(persisted.llmContext?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        provider: 'antigravity',
        usage: expect.objectContaining({ input: 2145, output: 20, cacheRead: 8752, cacheWrite: 0, reasoning: 18, totalTokens: 10917 })
      })
    ]))
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})

it('shows thread Waiting while Antigravity background command/subagent runs, then runs reactive continuation to completion', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-agy-bg-orch-'))
  const previousHome = process.env.MOUSSE_HOME
  process.env.MOUSSE_HOME = home
  const workspace = join(home, 'workspace')
  mkdirSync(workspace)
  const settingsDir = join(home, 'providers', 'antigravity')
  mkdirSync(settingsDir, { recursive: true })
  writeFileSync(
    join(settingsDir, 'settings.json'),
    JSON.stringify({ nativeSignedIn: true, models: [{ id: 'gemini-3-pro', label: 'Gemini 3 Pro' }] })
  )

  let agentClient: { notify: (method: string, params: unknown) => Promise<void> } | undefined
  const agent = inProcessAgent((app: AgentApp) => {
    app
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
      .onRequest(methods.agent.session.new, () => ({
        sessionId: 'agy-live-1',
        configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-3-pro', options: [{ value: 'gemini-3-pro', name: 'Gemini 3 Pro' }] }]
      }) as never)
      .onRequest(methods.agent.session.setConfigOption, () => ({ configOptions: [] }))
      .onRequest(methods.agent.session.prompt, async (c) => {
        agentClient = c.client as unknown as typeof agentClient
        await c.client.notify(methods.client.session.update, {
          sessionId: 'agy-live-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'cmd-verify',
            name: 'run_command',
            title: 'Run verify',
            status: 'in_progress',
            rawInput: { CommandLine: 'node scripts/verify.mjs', WaitMsBeforeAsync: 500 }
          }
        } as never)
        await c.client.notify(methods.client.session.update, {
          sessionId: 'agy-live-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'sub-research',
            name: 'invoke_subagent',
            title: 'Run invoke_subagent',
            status: 'in_progress',
            rawInput: { Role: 'Codebase Researcher', TypeName: 'research', Prompt: 'Inspect docs' }
          }
        } as never)
        await c.client.notify(methods.client.session.update, {
          sessionId: 'agy-live-1',
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'sub-research', status: 'completed' }
        })
        await c.client.notify(methods.client.session.update, {
          sessionId: 'agy-live-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Verification is running in the background...' } }
        })
        await c.client.notify(methods.client.session.update, {
          sessionId: 'agy-live-1',
          update: { sessionUpdate: 'usage_update', size: 100000, used: 1000 } as never
        })
        return { stopReason: 'end_turn' as const }
      })
  })

  const service = new AntigravityProviderService(home, home, new UserQuestionService(), undefined, {
    connect: agent.connect,
    findUserAgy: () => process.execPath
  })
  const d = phase6Daemon(home, [], { drivers: [antigravityDriver({ builtIn: () => service })] })
  const manager = new ThreadRuntimeManager()
  d.orch.setRuntimeManager(manager)
  d.settings.provider = { ...d.settings.provider, llmProvider: 'antigravity', instanceId: 'antigravity', model: 'gemini-3-pro' }

  try {
    const project = d.projects.openProject(workspace)
    const thread = d.store.createThread('Investigate Gemini metadata tokens', project.id, workspace)
    await d.orch.send({ content: 'verify and research', mode: 'agent' }, false, { threadId: thread.id, clientRequestId: 'req-1' })

    // After Turn 1 settles with open run_command + launched invoke_subagent, sidebar state must be Waiting (not Done!).
    await waitFor(() => manager.getActivitySnapshot()[thread.id] === 'waiting', 'thread activity enters waiting')
    expect(manager.waitsOnWork(thread.id)).toBe(true)

    const duringWait = d.orch.getMessages(thread.id)
    expect(duringWait.find((m) => m.activity?.callId === 'cmd-verify')?.activity).toMatchObject({
      kind: 'command',
      status: 'done',
      summary: BACKGROUND_SUMMARY
    })
    expect(duringWait.find((m) => m.activity?.callId === 'sub-research')?.activity).toMatchObject({
      kind: 'subagent',
      status: 'done',
      background: true,
      summary: BACKGROUND_SUMMARY
    })

    // Background command finishes out-of-turn: row updates in place while thread stays Waiting.
    await agentClient!.notify(methods.client.session.update, {
      sessionId: 'agy-live-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cmd-verify',
        status: 'completed',
        rawOutput: { output: 'All tests passed' }
      }
    })
    await waitFor(
      () => d.orch.getMessages(thread.id).find((m) => m.activity?.callId === 'cmd-verify')?.activity?.summary === 'All tests passed',
      'background command row updates on completion'
    )
    expect(manager.getActivitySnapshot()[thread.id]).toBe('waiting')

    // Reactive wakeup arrives -> OrchestratorService runs a real provider-continuation turn.
    await agentClient!.notify(methods.client.session.update, {
      sessionId: 'agy-live-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Verification passed and research is complete.' } }
    })
    await agentClient!.notify(methods.client.session.update, {
      sessionId: 'agy-live-1',
      update: { sessionUpdate: 'usage_update', size: 100000, used: 2000 } as never
    })

    // Continuation finishes -> reply persisted, subagent settled, backgroundWork cleared, thread no longer Waiting!
    await waitFor(
      () => d.orch.getMessages(thread.id).some((m) => m.role === 'assistant' && m.content.includes('Verification passed and research is complete.')),
      'continuation reply persisted'
    )
    await waitFor(() => manager.waitsOnWork(thread.id) === false, 'backgroundWork cleared after continuation')
    expect(manager.getActivitySnapshot()[thread.id]).toBe('completed')

    const afterDone = d.orch.getMessages(thread.id)
    expect(afterDone.find((m) => m.activity?.callId === 'sub-research')?.activity).toMatchObject({
      kind: 'subagent',
      status: 'done',
      summary: 'Finished'
    })
  } finally {
    service.stop()
    await d.stop()
    vi.restoreAllMocks()
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

it('replies in a No Project Antigravity thread started from another computer', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-acp-standalone-'))
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await main.start()
  try {
    main.settings.set({ provider: { llmProvider: 'antigravity', model: 'gemini-4-neon' } })
    const seenCwds: string[] = []
    vi.spyOn(main.antigravity, 'chat').mockImplementation(async (input) => {
      seenCwds.push(input.cwd)
      input.onText(`reply ${seenCwds.length}`)
      return `reply ${seenCwds.length}`
    })
    const remote = new MmsRemoteBackend(main)
    const caller = { node: newId('node') }
    const { thread } = await remote.execute('threads.create', { name: 'Yo', started: true }, caller) as { thread: { id: string } }
    expect(main.threads.getThread(thread.id)?.startedFrom?.node).toBe(caller.node)
    const control = { signal: new AbortController().signal, drainSteer: () => undefined, onAccepted: vi.fn() }
    expect(await remote.run(thread.id, 'yo', control)).toMatchObject({ text: 'reply 1', silent: false })
    expect(await remote.run(thread.id, 'follow up', control)).toMatchObject({ text: 'reply 2', silent: false })

    expect(seenCwds).toHaveLength(2)
    expect(seenCwds[0]).toBe(seenCwds[1])
    expect(statSync(seenCwds[0]!).isDirectory()).toBe(true)
    expect(relative(home, seenCwds[0]!).startsWith('..')).toBe(false)
    const other = main.threads.createThread('Other')
    expect(main.harness.standaloneWorkspace('antigravity', other.id)).not.toBe(seenCwds[0])
    const persisted = main.threads.loadThreadData(thread.id)
    expect(persisted.messages.filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual(['reply 1', 'reply 2'])
  } finally {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})
