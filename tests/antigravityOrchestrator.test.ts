import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { expect, it, vi } from 'vitest'
import { newId } from '../src/shared/net'
import { MmsRemoteBackend } from '../src/mms/bridge/remote/MmsBackend'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import type { AntigravityProviderService } from '../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'

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
