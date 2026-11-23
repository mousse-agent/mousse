/** Create and message a bot through the profile service with an Antigravity provider. The agent is scripted. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import { setSharedShellPath } from '../../src/mms/harness/shellPath'
import { slotsAllOn } from '../../src/shared/bots/personal/modelSlots'

it('offers Antigravity in New bot and uses the selected model for its greeting and subsequent chat', async () => {
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
    const snapshots = vi.spyOn(main.harness.instances, 'snapshots')
    const realSnapshots = await snapshots({ kind: 'device' })
    snapshots.mockResolvedValue(realSnapshots.map((snapshot) => snapshot.instanceId === 'antigravity'
      ? { ...snapshot, runs: { state: 'yes' }, auth: { state: 'signed_in' } }
      : snapshot))
    const chat = vi.spyOn(agent, 'chat').mockImplementation(async (input) => {
      expect(input).toMatchObject({ instanceId: pick.instanceId, model: pick.model, permissionMode: 'ask', bot: true })
      expect(input.botAuthority?.check).toBeTypeOf('function')
      const text = input.prompt.includes('Check the garden again.') ? 'The garden looks good.' : 'I can help with your garden.'
      input.onText(text)
      return text
    })
    await main.start()
    const bots = main.personalBots!.service
    expect((await bots.modelChoices()).providers).toContainEqual(expect.objectContaining({ instanceId: pick.instanceId, models: expect.arrayContaining([expect.objectContaining({ id: pick.model })]) }))
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
