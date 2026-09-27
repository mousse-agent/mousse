import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { vi } from 'vitest'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { MmsProtocolServer } from '../../src/mms/protocol/server'
import { LocalMmsClient } from '../../src/mms/protocol/client'
import { migrateLegacyContext } from '../../src/mms/orchestrator/nativeContext'
import type { ChatMessage } from '../../src/shared/types'
import type { WorkspaceExecutionContext } from '../../src/shared/workspace'
import { providerResponse, streamOf } from './agent-platform/agent-runtime-policy/helpers'

export async function seedChatUndoFullShell(toolsEnabled = false) {
  const root = mkdtempSync(join(tmpdir(), 'mousse-chat-undo-shell-'))
  const home = join(root, 'home'); mkdirSync(home)
  const sentinel = join(root, 'unchanged.txt'); writeFileSync(sentinel, 'No chat turn may change this file.\n')
  const main = await MousseMainService.create({ homeDir: home, repoRoot: root, headless: true, ownerKind: 'test' })
  let server: MmsProtocolServer | undefined
  let client: LocalMmsClient | undefined
  try {
    await main.start()
    const provider = main.providerAuth.models.getProviders().find(item => main.providerAuth.models.getModels(item.id).length)!
    const model = main.providerAuth.models.getModels(provider.id)[0]
    vi.spyOn(main.providerAuth, 'has').mockReturnValue(true)
    vi.spyOn(main.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'synthetic' } as never)
    const settings = main.settings.get()
    main.settings.set({ provider: { llmProvider: provider.id, model: model.id }, integrations: {
      ...settings.integrations, tools: { enabled: toolsEnabled, enabledTools: toolsEnabled ? settings.integrations.tools.enabledTools : [] },
      skills: { ...settings.integrations.skills, enabled: false }, mcp: { ...settings.integrations.mcp, enabled: false }
    } })
    const prompts = ['First ordinary chat turn.', 'Second ordinary chat turn.']
    const replies = ['First ordinary chat answer.', 'Second ordinary chat answer.']
    vi.spyOn(main.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => {
      const last = context.messages.at(-1)
      const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content)
      const index = prompts.findIndex(prompt => text?.includes(prompt))
      return streamOf(providerResponse([{ type: 'text', text: index < 0 ? 'Ordinary chat' : replies[index] }], 'stop')) as never
    })
    const token = main.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms: main, ownerToken: token, version: 'chat-undo-test' })
    client = new LocalMmsClient({ homeDir: home, endpoint: await server.start(), ownerToken: token, clientType: 'gui' })
    await client.connect()
    const thread = main.threads.createThread('Ordinary chat undo')
    if (thread.projectId) throw new Error('Chat Undo qualification requires a projectless thread')
    const workspace = await client.request<{ metadata?: unknown; execution: WorkspaceExecutionContext }>('workspace.getStatus', { threadId: thread.id })
    if (workspace.metadata || workspace.execution.workspacePath || workspace.execution.projectPath || workspace.execution.lifecycle !== 'unprovisioned' || workspace.execution.capability.checkpointable || workspace.execution.capability.gitBacked) throw new Error(`Chat fixture unexpectedly owns a workspace: ${JSON.stringify(workspace)}`)
    await client.request('orchestrator.send', { threadId: thread.id, content: prompts[0], mode: 'agent' })
    const firstNativeMessages = structuredClone(main.orchestrator.getNativeContext(thread.id).messages)
    await client.request('orchestrator.send', { threadId: thread.id, content: prompts[1], mode: 'agent' })
    const fullNativeMessages = structuredClone(main.orchestrator.getNativeContext(thread.id).messages)
    const messages = main.orchestrator.getMessages(thread.id)
    if (messages.filter(message => message.role === 'user').length !== 2 || !messages.some(message => message.content.includes(replies[1]))) throw new Error('Synthetic provider did not complete two real chat turns')
    const legacy = main.threads.createThread('Legacy chat without boundaries')
    const legacyMessages: ChatMessage[] = [{ id: 'legacy-prompt', role: 'user', content: 'Legacy ordinary prompt.', timestamp: new Date().toISOString() }]
    main.orchestrator.replaceConversationState(legacy.id, legacyMessages, migrateLegacyContext(legacyMessages))
    return { root, home, sentinel, threadId: thread.id, legacyThreadId: legacy.id,
      threadDirectory: main.threads.getThreadDir(thread.id), firstNativeMessages, fullNativeMessages, prompts, replies,
      dispose: () => {
        const rel = relative(realpathSync(tmpdir()), realpathSync(root))
        if (isAbsolute(rel) || !rel.startsWith('mousse-chat-undo-shell-') || rel.includes('..')) throw new Error('Unsafe chat fixture cleanup')
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
  } finally { await client?.close(); await server?.stop(); await main.stop(); vi.restoreAllMocks() }
}
