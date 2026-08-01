import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import { HeadlessAgentRunner } from '../src/mms/terminals/HeadlessAgentRunner'
import { MacroEngine } from '../src/mms/macros/MacroEngine'
import { getDefaultSettings } from '../src/shared/settings'
import type { ChatMessage } from '../src/shared/types'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function createOrchestrator(home: string, store: ThreadDataStore): OrchestratorService {
  process.env.MOUSSE_HOME = home
  const agents = new AgentRegistry()
  const tasks = new TaskQueue()
  const worktrees = new WorktreeManager(home)
  const pty = new PtyManager()
  const headless = new HeadlessAgentRunner()
  const macros = {
    listProviders: () => ['mousse'],
    isHeadlessEnabled: () => false,
    getHeadlessShellCommand: () => 'echo',
    getCliCommand: () => 'echo',
    runPtyMacro: async () => ({ log: [] as string[] })
  } as unknown as MacroEngine
  const settingsStore = { getSettings: () => getDefaultSettings(), get: () => getDefaultSettings() }
  const providerAuth = { getConnectedProviders: () => [] }
  const orch = new OrchestratorService(
    agents,
    tasks,
    worktrees,
    pty,
    headless,
    macros,
    settingsStore as never,
    providerAuth as never
  )
  orch.setThreadStore(store)
  return orch
}

describe('thread-scoped orchestrator conversation events', () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-scoped-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = createOrchestrator(home, store)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('emits thread-message without legacy message for background thread mutations', () => {
    const selected = store.createThread('Selected')
    const background = store.createThread('Background')
    orch.bindThread(selected.id, [], undefined, [])

    const legacyAdds: ChatMessage[] = []
    const scopedAdds: Array<{ threadId: string; message: ChatMessage }> = []
    orch.on('message', (msg: ChatMessage) => legacyAdds.push(msg))
    orch.on('thread-message', (payload: { threadId: string; message: ChatMessage }) =>
      scopedAdds.push(payload)
    )

    const bgSession = orch.getOrCreateSession(background.id)
    // Exercise private ALS-scoped mutators (same path used during concurrent turns).
    const internal = orch as unknown as {
      sessionAls: { run: <T>(session: unknown, fn: () => T) => T }
      addSystemMessage: (content: string) => void
      addMessage: (role: 'user' | 'assistant', content: string) => ChatMessage
      updateStreamingAssistantMessage: (
        id: string,
        content: string,
        streaming: boolean
      ) => void
    }

    internal.sessionAls.run(bgSession, () => {
      internal.addSystemMessage('background system note')
    })

    expect(scopedAdds).toHaveLength(1)
    expect(scopedAdds[0].threadId).toBe(background.id)
    expect(scopedAdds[0].message.content).toBe('background system note')
    expect(legacyAdds).toHaveLength(0)
  })

  it('mirrors legacy message events only for the bound (selected) thread', () => {
    const selected = store.createThread('Bound')
    orch.bindThread(selected.id, [], undefined, [])

    const legacyAdds: ChatMessage[] = []
    const scopedAdds: Array<{ threadId: string; message: ChatMessage }> = []
    const legacyUpdates: ChatMessage[] = []
    const scopedUpdates: Array<{ threadId: string; message: ChatMessage }> = []
    const legacySyncs: ChatMessage[][] = []
    const scopedSyncs: Array<{ threadId: string; messages: ChatMessage[] }> = []

    orch.on('message', (msg: ChatMessage) => legacyAdds.push(msg))
    orch.on('thread-message', (payload: { threadId: string; message: ChatMessage }) =>
      scopedAdds.push(payload)
    )
    orch.on('message-updated', (msg: ChatMessage) => legacyUpdates.push(msg))
    orch.on('thread-message-updated', (payload: { threadId: string; message: ChatMessage }) =>
      scopedUpdates.push(payload)
    )
    orch.on('messages-sync', (messages: ChatMessage[]) => legacySyncs.push(messages))
    orch.on('thread-messages', (payload: { threadId: string; messages: ChatMessage[] }) =>
      scopedSyncs.push(payload)
    )

    const internal = orch as unknown as {
      sessionAls: { run: <T>(session: unknown, fn: () => T) => T }
      addMessage: (role: 'user' | 'assistant', content: string) => ChatMessage
      updateStreamingAssistantMessage: (
        id: string,
        content: string,
        streaming: boolean
      ) => void
      removeMessage: (id: string) => void
      boundSession: { threadId: string }
    }

    const bound = orch.getOrCreateSession(selected.id)
    expect(bound.threadId).toBe(internal.boundSession.threadId)

    let assistantId = ''
    internal.sessionAls.run(bound, () => {
      const msg = internal.addMessage('assistant', '')
      assistantId = msg.id
      internal.updateStreamingAssistantMessage(assistantId, 'hello bound', false)
    })

    expect(scopedAdds.some((p) => p.threadId === selected.id)).toBe(true)
    expect(legacyAdds.length).toBeGreaterThan(0)
    expect(scopedUpdates.some((p) => p.threadId === selected.id)).toBe(true)
    expect(legacyUpdates.length).toBeGreaterThan(0)

    internal.sessionAls.run(bound, () => {
      internal.removeMessage(assistantId)
    })
    expect(scopedSyncs.some((p) => p.threadId === selected.id)).toBe(true)
    expect(legacySyncs.length).toBeGreaterThan(0)
  })

  it('does not broadcast legacy messages-sync for background remove/finalize', () => {
    const selected = store.createThread('Sel')
    const background = store.createThread('Bg')
    orch.bindThread(selected.id, [], undefined, [])

    const legacySyncs: ChatMessage[][] = []
    const scopedSyncs: Array<{ threadId: string }> = []
    orch.on('messages-sync', (messages: ChatMessage[]) => legacySyncs.push(messages))
    orch.on('thread-messages', (payload: { threadId: string }) => scopedSyncs.push(payload))

    const bg = orch.getOrCreateSession(background.id)
    const internal = orch as unknown as {
      sessionAls: { run: <T>(session: unknown, fn: () => T) => T }
      addMessage: (role: 'user' | 'assistant', content: string) => ChatMessage
      removeMessage: (id: string) => void
    }

    internal.sessionAls.run(bg, () => {
      const msg = internal.addMessage('user', 'temp')
      internal.removeMessage(msg.id)
    })

    expect(scopedSyncs.some((p) => p.threadId === background.id)).toBe(true)
    expect(legacySyncs).toHaveLength(0)
  })
})

describe('queued messages UI wiring', () => {
  it('registers QueuedMessages styles attached above the composer', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/app.css'), 'utf8')
    expect(css).toMatch(/\.queued-messages\s*\{/)
    expect(css).toMatch(/\.queued-messages-row\s*\{/)
    expect(css).toMatch(/chat-input-area:has\(\.queued-messages\)\s+\.composer/)
  })

  it('OrchestratorChat mounts QueuedMessages and uses sendToThread / isTurnActive', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/OrchestratorChat.tsx'),
      'utf8'
    )
    expect(source).toMatch(/import\s+\{\s*QueuedMessages\s*\}/)
    expect(source).toMatch(/<QueuedMessages/)
    expect(source).toMatch(/sendToThread/)
    expect(source).toMatch(/isTurnActive/)
    expect(source).toMatch(/abort\(activeThreadId/)
    expect(source).toMatch(/steer\([^,]+,\s*activeThreadId/)
  })

  it('ChatComposer allows ordinary send while loading (queue path)', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/ChatComposer.tsx'),
      'utf8'
    )
    expect(source).not.toMatch(/\(\!loading\s*\|\|\s*isControlWhileLoading\)/)
    expect(source).toMatch(/stack on the per-thread queue/)
  })

  it('App filters thread-scoped conversation events by selected thread', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8')
    expect(source).toMatch(/onThreadMessage/)
    expect(source).toMatch(/onThreadMessageUpdated/)
    expect(source).toMatch(/onThreadMessages/)
    expect(source).toMatch(/isSelectedThread/)
    expect(source).not.toMatch(/orchestrator\.onMessage\(/)
  })
})
