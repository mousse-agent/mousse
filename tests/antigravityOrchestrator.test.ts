import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
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

it('offers Mousse tools to the first Antigravity turn woken by monitor recovery', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-acp-boot-wake-'))
  vi.stubEnv('MOUSSE_HOME', home)
  const workspace = join(home, 'workspace')
  mkdirSync(workspace)
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const open = () => MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  let main: MousseMainService | undefined
  try {
    main = await open()
    main.settings.set({ provider: { llmProvider: 'antigravity', model: 'account-model' } })
    const project = main.projects.openProject(workspace)
    const thread = main.threads.createThread('Monitor recovery', project.id, workspace)
    const record = join(main.getProfileHomeDir(), 'monitors.json')
    await main.stop()
    main = undefined
    // A monitor record left on disk by the previous process.
    writeFileSync(record, JSON.stringify({
      version: 1,
      monitors: [{ id: 'bg-test', threadId: thread.id, kind: 'background', description: 'Verify tests' }]
    }))

    main = await open()
    let wake: { threadId: string; prompt: string; tools: string[] } | undefined
    vi.spyOn(main.antigravity, 'chat').mockImplementation(async ({ threadId, prompt, mcp, signal, onText }) => {
      let tools: string[] = []
      if (mcp) {
        const response = await fetch(mcp.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${mcp.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream'
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
          signal
        })
        const body = await response.json() as { result?: { tools: Array<{ name: string }> } }
        tools = body.result?.tools.map(({ name }) => name) ?? []
      }
      wake = { threadId, prompt, tools }
      onText('Restart notice received')
      return 'Restart notice received'
    })
    // Keep startup in progress until the recovered notice has reached the provider.
    vi.spyOn(main.net, 'start').mockImplementation(async () => {
      await vi.waitFor(() => expect(wake).toBeDefined(), { timeout: 5_000 })
    })
    await main.start()
    expect(wake?.threadId).toBe(thread.id)
    expect(wake?.prompt).toContain('Mousse restarted')
    expect(wake?.tools).toContain('background_run')
  } finally {
    await main?.stop()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  }
}, 20_000)

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
