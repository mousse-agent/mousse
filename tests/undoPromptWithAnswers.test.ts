import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { testHarness } from '../src/mms/run/testkit/harness'
import { piAdapter } from './run/phase6Fixture'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.restoreAllMocks() })

// An approval answered during a turn is stored as a user message (`questionAnswers`) that the transcript shows as a
// step of the agent's turn. Undo must still name the prompt that started the turn, or the Undo button has nowhere to go.
it("names the turn's prompt as Undo's target when the turn answered an approval, and undoes the whole turn", async () => {
  const root = mkdtempSync(join(tmpdir(), 'mousse-undo-answers-'))
  const home = join(root, 'home'); mkdirSync(home)
  const main = await MousseMainService.create({ homeDir: home, repoRoot: root, headless: true, ownerKind: 'test' })
  let server: MmsProtocolServer | undefined
  let client: LocalMmsClient | undefined
  cleanup = async () => { await client?.close(); await server?.stop(); await main.stop(); rmSync(root, { recursive: true, force: true }) }
  await main.start()
  const provider = main.providerAuth.models.getProviders().find(item => main.providerAuth.models.getModels(item.id).length)!
  const model = main.providerAuth.models.getModels(provider.id)[0]
  vi.spyOn(main.providerAuth, 'has').mockReturnValue(true)
  vi.spyOn(main.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'synthetic' } as never)
  const settings = main.settings.get()
  main.settings.set({ provider: { llmProvider: provider.id, model: model.id }, integrations: {
    ...settings.integrations, tools: { enabled: false, enabledTools: [] },
    skills: { ...settings.integrations.skills, enabled: false }, mcp: { ...settings.integrations.mcp, enabled: false }
  } })
  const thread = main.threads.createThread('Undo after an approval')
  main.orchestrator.setHarness(testHarness({ adapters: [piAdapter((input) => {
    if (!input.prompt.includes('Run the command.')) return 'First answer.'
    // The person answers the agent's approval while the turn runs, as the GUI records it.
    main.orchestrator.recordQuestionResponseMessage(thread.id, 'Q: Allow the command?\nA: Allow once', [{ prompt: 'Allow the command?', chosen: ['Allow once'] }])
    return 'Ran it.'
  })], profileHome: main.getProfileHomeDir() }))
  const token = main.getOwnerLease()!.owner.token
  server = new MmsProtocolServer({ mms: main, ownerToken: token, version: 'undo-answers-test' })
  client = new LocalMmsClient({ homeDir: home, endpoint: await server.start(), ownerToken: token, clientType: 'gui' })
  await client.connect()
  await client.request('orchestrator.send', { threadId: thread.id, content: 'First prompt.', mode: 'agent' })
  await client.request('orchestrator.send', { threadId: thread.id, content: 'Run the command.', mode: 'agent' })

  const messages = main.orchestrator.getMessages(thread.id)
  const prompt = messages.find(message => message.role === 'user' && message.content === 'Run the command.')!
  expect(messages.at(-2)).toMatchObject({ role: 'user', questionAnswers: [{ chosen: ['Allow once'] }] })

  const history = await client.request<{ journalGeneration: number; undoTarget?: { turnId: string; messageId: string } }>('actions.list', { threadId: thread.id })
  expect(history.undoTarget).toMatchObject({ messageId: prompt.id, turnId: prompt.turnId })

  await client.request('actions.undoLatest', { threadId: thread.id, expectedJournalGeneration: history.journalGeneration, expectedTurnId: history.undoTarget!.turnId })
  expect(main.orchestrator.getMessages(thread.id).filter(message => !message.hidden).map(message => message.content)).toEqual(['First prompt.', 'First answer.'])
}, 60_000)
