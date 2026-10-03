import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import type { AntigravityProviderService } from '../src/mms/providers/antigravity/AntigravityProviderService'

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
