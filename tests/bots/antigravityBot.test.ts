/** Create and message a bot through the profile service with an Antigravity provider and a custom ACP agent. Both are scripted. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import { setSharedShellPath } from '../../src/mms/harness/shellPath'
import { slotsAllOn } from '../../src/shared/bots/personal/modelSlots'

it('offers Antigravity for the greeting and subsequent chat and refuses an uncontrolled custom ACP agent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-bot-provider-'))
  const pick = { instanceId: 'antigravity', model: 'gemini-4-hydrogen' }
  const models = [{ id: pick.model, label: 'Gemini 4 Hydrogen' }]
  setSharedShellPath({ entries: [], source: 'login_shell' })
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  let main: MousseMainService | undefined
  try {
    main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    const agent = main.antigravity
    vi.spyOn(agent, 'supportsBotTurns').mockReturnValue(true)
    vi.spyOn(agent, 'signedIn').mockReturnValue(true)
    vi.spyOn(agent, 'configured').mockReturnValue(true)
    vi.spyOn(agent, 'llmProvider').mockReturnValue({ id: 'antigravity', label: 'Antigravity', models })
    vi.spyOn(agent, 'models').mockReturnValue(models)
    // The external executable and sign-in have been checked and are ready.
    const readSnapshots = main.harness.instances.snapshots.bind(main.harness.instances)
    vi.spyOn(main.harness.instances, 'snapshots').mockImplementation(async (scope) => (await readSnapshots(scope)).map((snapshot) =>
      snapshot.instanceId === 'antigravity' ? { ...snapshot, runs: { state: 'yes' }, auth: { state: 'signed_in' } } : snapshot
    ))
    const script = join(home, 'custom-agent.cjs')
    writeFileSync(script, `
      require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const { id, method } = JSON.parse(line)
        if (id === undefined) return
        const result = method === 'initialize'
          ? { protocolVersion: 1, authMethods: [] }
          : { sessionId: 'custom-session', models: {
            currentModelId: 'custom-model', availableModels: [{ modelId: 'custom-model', name: 'Custom model' }]
          } }
        console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
      })
    `)
    const custom = await main.harness.instances.add({
      driver: 'acp', config: { displayName: 'Custom agent', binaryPath: process.execPath, args: [script] }
    })
    const customPick = { instanceId: custom.instanceId, model: 'custom-model' }
    const chat = vi.spyOn(agent, 'chat').mockImplementation(async (input) => {
      expect(input).toMatchObject({ instanceId: pick.instanceId, model: pick.model, permissionMode: 'ask', bot: true })
      expect(input.botAuthority?.check).toBeTypeOf('function')
      const text = input.prompt.includes('Check the garden again.') ? 'The garden looks good.' : 'I can help with your garden.'
      input.onText(text)
      return text
    })
    await main.start()
    const bots = main.personalBots!.service
    const choices = await bots.modelChoices()
    expect(choices.providers).toContainEqual(expect.objectContaining({ instanceId: pick.instanceId, models: expect.arrayContaining([expect.objectContaining({ id: pick.model })]) }))
    expect(choices.unavailableProviders).toContainEqual(expect.objectContaining({ instanceId: custom.instanceId, label: 'Custom agent' }))
    expect(choices.providers?.some((provider) => provider.instanceId === custom.instanceId)).toBe(false)
    await expect(bots.create({
      name: 'Custom Helper', description: 'Help me look after my garden.', look: { colour: 'teal', accessory: 'cap' },
      clientRequestId: 'create-custom-bot', slots: slotsAllOn(customPick)
    })).rejects.toMatchObject({ code: 'model_unavailable' })
    const { bot } = await bots.create({
      name: 'Garden Helper', description: 'Help me look after my garden.', look: { colour: 'teal', accessory: 'cap' },
      clientRequestId: 'create-garden-bot', slots: slotsAllOn(pick)
    })
    await vi.waitFor(() => expect(bots.chatList(bot.id).messages).toContainEqual(expect.objectContaining({ author: 'bot', text: 'I can help with your garden.' })), { timeout: 15_000 })
    await bots.chatSend({ botId: bot.id, text: 'Check the garden again.', clientRequestId: 'garden-chat-1' })
    await vi.waitFor(() => expect(bots.chatList(bot.id).messages).toContainEqual(expect.objectContaining({ author: 'bot', text: 'The garden looks good.' })), { timeout: 15_000 })
    expect(chat).toHaveBeenCalledTimes(2)
  } finally {
    try { await main?.stop() }
    finally {
      setSharedShellPath(undefined)
      vi.restoreAllMocks()
      rmSync(home, { recursive: true, force: true })
    }
  }
}, 40_000)
