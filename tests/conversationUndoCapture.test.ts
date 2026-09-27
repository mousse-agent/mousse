import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { seedChatUndoFullShell } from './fixtures/chat-undo-full-shell-seed'
import type { ThreadAction } from '../src/shared/threadActions'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { randomUUID } from 'node:crypto'

interface History {
  actions: ThreadAction[]
  journalGeneration: number
  undoTarget?: { turnId: string; messageId: string }
  redoTarget?: { turnId: string }
  undoUnavailableReason?: string
}

it('captures default agent chat with tools available and restores exact context across restart without tool execution', async () => {
  const fixture = await seedChatUndoFullShell(true)
  const main = await MousseMainService.create({ homeDir: fixture.home, repoRoot: fixture.root, headless: true, ownerKind: 'test' })
  let server: MmsProtocolServer | undefined
  let client: LocalMmsClient | undefined
  try {
    await main.start()
    expect(main.settings.get().integrations.tools.enabled).toBe(true)
    const token = main.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms: main, ownerToken: token, version: 'conversation-capture-test' })
    client = new LocalMmsClient({ homeDir: fixture.home, endpoint: await server.start(), ownerToken: token, clientType: 'gui' })
    await client.connect()
    const history = () => client!.request('actions.list', { threadId: fixture.threadId }) as Promise<History>
    let state = await history()
    expect(state.actions).toHaveLength(2)
    expect(state.actions.every(action => action.scope === 'conversation' && action.reversible && !action.externalEffects.length && !action.commits.length)).toBe(true)
    expect(state.undoTarget).toBeDefined()
    const target = state.undoTarget!
    await expect(client.request('actions.undoLatest', { threadId: fixture.threadId, expectedJournalGeneration: state.journalGeneration, expectedTurnId: 'wrong-turn' })).rejects.toThrow()
    expect(main.orchestrator.getNativeContext(fixture.threadId).messages).toEqual(fixture.fullNativeMessages)
    for (let cycle = 0; cycle < 2; cycle++) {
      state = await history()
      await client.request('actions.undoLatest', { threadId: fixture.threadId, expectedJournalGeneration: state.journalGeneration, expectedTurnId: target.turnId })
      expect(main.orchestrator.getNativeContext(fixture.threadId).messages).toEqual(fixture.firstNativeMessages)
      expect(main.orchestrator.getMessages(fixture.threadId).filter(message => message.role === 'user')).toHaveLength(1)
      state = await history()
      expect(state.redoTarget?.turnId).toBe(target.turnId)
      await client.request('actions.redo', { threadId: fixture.threadId, expectedJournalGeneration: state.journalGeneration })
      expect(main.orchestrator.getNativeContext(fixture.threadId).messages).toEqual(fixture.fullNativeMessages)
      expect(main.orchestrator.getMessages(fixture.threadId).filter(message => message.role === 'user')).toHaveLength(2)
    }
    const legacy = await client.request('actions.list', { threadId: fixture.legacyThreadId }) as History
    expect(legacy.undoTarget).toBeUndefined()
    expect(legacy.undoUnavailableReason).toContain('no eligible recorded')
    expect(readFileSync(fixture.sentinel, 'utf8')).toBe('No chat turn may change this file.\n')
  } finally {
    await client?.close(); await server?.stop(); await main.stop(); fixture.dispose()
  }
}, 60_000)

it('finishes an admitted conversation Undo on restarted history listing and returns the recovered generation', async () => {
  const fixture = await seedChatUndoFullShell()
  const actions = new ThreadActionService(fixture.threadDirectory)
  const target = actions.list().at(-1)!
  const journal = new ThreadJournal(fixture.threadDirectory)
  const operationId = randomUUID()
  journal.append({ operationId, operationType: 'conversation-history', state: 'context_pending', details: { action: { ...target, state: 'undone' }, kind: 'undo' } })
  const main = await MousseMainService.create({ homeDir: fixture.home, repoRoot: fixture.root, headless: true, ownerKind: 'test' })
  let server: MmsProtocolServer | undefined
  let client: LocalMmsClient | undefined
  try {
    await main.start()
    // Model the crash after context persistence but before completing the action journal.
    main.orchestrator.restoreConversationBoundary(fixture.threadId, target.presentationMessageStart, target.nativeContextStartBoundary!)
    const token = main.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms: main, ownerToken: token, version: 'conversation-recovery-test' })
    client = new LocalMmsClient({ homeDir: fixture.home, endpoint: await server.start(), ownerToken: token, clientType: 'gui' })
    await client.connect()
    const beforeArchive = structuredClone(main.orchestrator.getNativeContext(fixture.threadId).retiredMessages)
    const history = await client.request('actions.list', { threadId: fixture.threadId }) as History
    expect(history.redoTarget?.turnId).toBe(target.turnId)
    expect(history.journalGeneration).toBe(journal.latestSequence())
    expect(journal.latestByOperation().get(operationId)?.state).toBe('completed')
    expect(main.orchestrator.getNativeContext(fixture.threadId).messages).toEqual(fixture.firstNativeMessages)
    expect(main.orchestrator.getNativeContext(fixture.threadId).retiredMessages).toEqual(beforeArchive)
    await client.request('actions.redo', { threadId: fixture.threadId, expectedJournalGeneration: history.journalGeneration })
    expect(main.orchestrator.getNativeContext(fixture.threadId).messages).toEqual(fixture.fullNativeMessages)
  } finally { await client?.close(); await server?.stop(); await main.stop(); fixture.dispose() }
}, 60_000)
