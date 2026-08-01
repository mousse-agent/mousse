import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { chunkMessage } from '../src/mms/channels/chunkMessage'
import { isSilenceNarration, parseDeliveryTarget } from '../src/mms/channels/delivery'
import { ChannelStore } from '../src/mms/channels/ChannelStore'
import { ChannelSessionManager } from '../src/mms/channels/ChannelSessionManager'
import { ChannelRouter } from '../src/mms/channels/ChannelRouter'
import { ChannelAuth } from '../src/mms/channels/ChannelAuth'
import {
  discordApplicationCommands,
  parseSlashCommand,
  resolveChannelCommand,
  telegramBotCommands
} from '../src/mms/channels/slash'
import {
  CHANNEL_COMMAND_REGISTRY,
  COMPOSER_DESKTOP_COMMANDS,
  filterChannelCommandSuggestions,
  filterComposerCommandSuggestions,
  filterSkillSuggestions,
  parseSkillsPickerQuery
} from '../src/shared/channelCommands'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { buildSessionKey } from '../src/mms/channels/types'
import type { InboundChannelMessage, ChannelAdapter } from '../src/mms/channels/types'
import type { LlmProviderOption } from '../src/shared/settings'

describe('buildSessionKey', () => {
  it('builds stable session keys', () => {
    expect(buildSessionKey('telegram', '12345')).toBe('telegram:12345')
    expect(buildSessionKey('discord', '987', '555')).toBe('discord:987:555')
  })
})

describe('delivery', () => {
  it('parses explicit targets', () => {
    const target = parseDeliveryTarget('telegram:12345:99')
    expect(target.platform).toBe('telegram')
    expect(target.chatId).toBe('12345')
    expect(target.threadId).toBe('99')
  })

  it('detects silence narration', () => {
    expect(isSilenceNarration('*(silent)*')).toBe(true)
    expect(isSilenceNarration('The deployment ran silently')).toBe(false)
  })
})

describe('chunkMessage', () => {
  it('splits long messages', () => {
    const text = 'word '.repeat(900).trim()
    const chunks = chunkMessage(text, 500)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join(' ')).toContain('word')
  })
})

describe('ChannelStore', () => {
  it('persists config and sessions', () => {
    const originalHome = process.env.MOUSSE_HOME
    const tempHome = mkdtempSync(join(tmpdir(), 'mousse-channels-test-'))
    process.env.MOUSSE_HOME = tempHome

    try {
      const configStore = MousseConfigStore.load(tempHome)
      const store = new ChannelStore(configStore)
      const updated = store.updateConfig({
        platforms: {
          telegram: { enabled: true, token: 'test-token', allowedUserIds: ['1'] },
          discord: { enabled: false },
          webhook: { enabled: false }
        }
      })
      expect(updated.platforms.telegram.enabled).toBe(true)

      store.upsertSession({
        sessionKey: 'telegram:1',
        platform: 'telegram',
        chatId: '1',
        chatType: 'dm',
        mousseThreadId: 'thread-1',
        createdAt: new Date().toISOString()
      })
      expect(store.listSessions()).toHaveLength(1)
    } finally {
      if (originalHome === undefined) {
        delete process.env.MOUSSE_HOME
      } else {
        process.env.MOUSSE_HOME = originalHome
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })
})

describe('parseSlashCommand', () => {
  it('parses /new and optional title', () => {
    const bare = parseSlashCommand('/new')
    expect(bare).toMatchObject({ name: 'new', canonical: 'new', args: '' })

    const titled = parseSlashCommand('/new My Title')
    expect(titled).toMatchObject({ name: 'new', canonical: 'new', args: 'My Title' })
  })

  it('resolves /reset alias to new', () => {
    const parsed = parseSlashCommand('/reset')
    expect(parsed).toMatchObject({ name: 'reset', canonical: 'new', args: '' })
  })

  it('parses /model with flags', () => {
    const parsed = parseSlashCommand('/model gpt --session')
    expect(parsed).toMatchObject({
      name: 'model',
      canonical: 'model',
      args: 'gpt --session'
    })
  })

  it('strips Telegram @bot suffix', () => {
    const parsed = parseSlashCommand('/help@BotName')
    expect(parsed).toMatchObject({ name: 'help', canonical: 'help' })
  })

  it('rejects file paths and empty command', () => {
    expect(parseSlashCommand('/home/path')).toBeNull()
    expect(parseSlashCommand('/C:/Users/foo')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()
    expect(parseSlashCommand('hello')).toBeNull()
  })

  it('returns unknown command names for dispatcher', () => {
    const parsed = parseSlashCommand('/foobar')
    expect(parsed).toMatchObject({ name: 'foobar', canonical: 'foobar' })
    expect(resolveChannelCommand(parsed!.name)).toBeUndefined()
  })
})

describe('resolveChannelCommand', () => {
  it('resolves aliases', () => {
    expect(resolveChannelCommand('reset')?.name).toBe('new')
    expect(resolveChannelCommand('set-home')?.name).toBe('sethome')
    expect(resolveChannelCommand('tasks')?.name).toBe('agents')
    expect(resolveChannelCommand('/model')?.name).toBe('model')
    expect(resolveChannelCommand('models')?.name).toBe('model')
    expect(resolveChannelCommand('thread')?.name).toBe('threads')
    expect(resolveChannelCommand('/threads')?.name).toBe('threads')
  })
})

describe('channel command suggestions and native registrations', () => {
  it('shows the full registry for a bare slash and filters subsequent text', () => {
    expect(filterChannelCommandSuggestions('/')).toEqual(CHANNEL_COMMAND_REGISTRY)
    expect(filterChannelCommandSuggestions('/mod').map((command) => command.name)).toEqual(['model'])
    expect(filterChannelCommandSuggestions('/thread').map((command) => command.name)).toEqual([
      'threads'
    ])
    expect(filterChannelCommandSuggestions('/reset').map((command) => command.name)).toEqual(['new'])
    expect(filterChannelCommandSuggestions('/model gpt')).toEqual([])
  })

  it('includes desktop-only /skills in composer suggestions only', () => {
    expect(filterChannelCommandSuggestions('/skills')).toEqual([])
    expect(filterComposerCommandSuggestions('/skil').map((command) => command.name)).toEqual(['skills'])
    expect(filterComposerCommandSuggestions('/skills').map((command) => command.name)).toEqual([
      'skills'
    ])
    expect(filterComposerCommandSuggestions('/')).toEqual([
      ...CHANNEL_COMMAND_REGISTRY,
      ...COMPOSER_DESKTOP_COMMANDS
    ])
    expect(telegramBotCommands().map((command) => command.command)).not.toContain('skills')
    expect(discordApplicationCommands().map((command) => command.name)).not.toContain('skills')
  })

  it('parses /skills picker queries and filters skills', () => {
    expect(parseSkillsPickerQuery('/skill')).toBeNull()
    expect(parseSkillsPickerQuery('/skills')).toBe('')
    expect(parseSkillsPickerQuery('/skills ')).toBe('')
    expect(parseSkillsPickerQuery('/skills review')).toBe('review')
    expect(parseSkillsPickerQuery('/skillsomething')).toBeNull()

    const skills = [
      { id: 'reviewer', name: 'reviewer', description: 'Review code changes' },
      { id: 'canvas', name: 'canvas', description: 'Draw diagrams' }
    ]
    expect(filterSkillSuggestions(skills, '').map((skill) => skill.id)).toEqual([
      'reviewer',
      'canvas'
    ])
    expect(filterSkillSuggestions(skills, 'rev').map((skill) => skill.id)).toEqual(['reviewer'])
    expect(filterSkillSuggestions(skills, 'diagram').map((skill) => skill.id)).toEqual(['canvas'])
  })

  it('registers every canonical command on Telegram and Discord', () => {
    const names = CHANNEL_COMMAND_REGISTRY.map((command) => command.name)
    expect(telegramBotCommands().map((command) => command.command)).toEqual(names)
    expect(discordApplicationCommands().map((command) => command.name)).toEqual(names)
    expect(discordApplicationCommands().find((command) => command.name === 'model')?.options).toEqual([
      { name: 'arguments', description: '[name] [--session|--global]', type: 3, required: false }
    ])
  })
})

function withTempHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const originalHome = process.env.MOUSSE_HOME
  const tempHome = mkdtempSync(join(tmpdir(), 'mousse-channels-slash-'))
  process.env.MOUSSE_HOME = tempHome
  return Promise.resolve()
    .then(() => fn(tempHome))
    .finally(() => {
      if (originalHome === undefined) {
        delete process.env.MOUSSE_HOME
      } else {
        process.env.MOUSSE_HOME = originalHome
      }
      rmSync(tempHome, { recursive: true, force: true })
    })
}

describe('ChannelSessionManager.resetSession', () => {
  it('creates a new thread id and clears model override', async () => {
    await withTempHome(async () => {
      const configStore = MousseConfigStore.load()
      const store = new ChannelStore(configStore)
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const manager = new ChannelSessionManager(store, threads)

      const message: InboundChannelMessage = {
        platform: 'telegram',
        chatId: '42',
        chatType: 'dm',
        userId: 'u1',
        userName: 'alice',
        text: 'hi'
      }

      const first = manager.resolveThread(message)
      manager.setModelOverride(first.sessionKey, {
        llmProvider: 'openai',
        model: 'gpt-4'
      })
      expect(manager.getSession(first.sessionKey)?.modelOverride?.model).toBe('gpt-4')

      const reset = manager.resetSession(message, 'Fresh start')
      expect(reset.mousseThreadId).not.toBe(first.mousseThreadId)
      expect(reset.sessionKey).toBe(first.sessionKey)
      expect(reset.modelOverride).toBeUndefined()
      expect(threads.getThread(reset.mousseThreadId)?.name).toBe('Fresh start')
    })
  })
})

describe('ChannelRouter slash commands', () => {
  it('handles /help without calling runner', async () => {
    await withTempHome(async () => {
      const configStore = MousseConfigStore.load()
      const store = new ChannelStore(configStore)
      store.updateConfig({
        platforms: {
          telegram: { enabled: true, allowAllUsers: true },
          discord: { enabled: false },
          webhook: { enabled: false }
        }
      })
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const sessionManager = new ChannelSessionManager(store, threads)
      const settings = new SettingsStore(configStore)
      const runner = {
        runChannelTurn: vi.fn(async () => ({ text: 'from-llm', silent: false }))
      }
      const sent: string[] = []
      const adapter: ChannelAdapter = {
        platform: 'telegram',
        connect: async () => {},
        disconnect: async () => {},
        getStatus: () => ({ platform: 'telegram', state: 'connected' }),
        setInboundHandler: () => {},
        send: async (msg) => {
          sent.push(msg.text)
          return { success: true, messageId: '1' }
        }
      }

      const router = new ChannelRouter(
        store,
        sessionManager,
        new ChannelAuth(),
        runner,
        () => adapter,
        () => store.getConfig(),
        {
          settingsStore: settings,
          threadStore: threads,
          listModels: () => []
        }
      )

      await router.handleInbound({
        platform: 'telegram',
        chatId: '99',
        chatType: 'dm',
        userId: 'user-1',
        userName: 'bob',
        text: '/help'
      })

      expect(runner.runChannelTurn).not.toHaveBeenCalled()
      expect(sent.length).toBeGreaterThan(0)
      expect(sent[0]).toContain('/help')
      expect(sent[0]).toContain('/model')
    })
  })

  it('lists and switches models with session override', async () => {
    await withTempHome(async () => {
      const configStore = MousseConfigStore.load()
      const store = new ChannelStore(configStore)
      store.updateConfig({
        platforms: {
          telegram: { enabled: true, allowAllUsers: true },
          discord: { enabled: false },
          webhook: { enabled: false }
        }
      })
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const sessionManager = new ChannelSessionManager(store, threads)
      const settings = new SettingsStore(configStore)
      settings.set({ provider: { llmProvider: 'openai', model: 'gpt-3.5' } })

      const models: LlmProviderOption[] = [
        {
          id: 'openai',
          label: 'OpenAI',
          models: [
            { id: 'gpt-3.5', label: 'GPT 3.5' },
            { id: 'gpt-4o', label: 'GPT 4o' }
          ]
        }
      ]

      const runner = {
        runChannelTurn: vi.fn(async () => ({ text: 'from-llm', silent: false }))
      }
      const sent: string[] = []
      const adapter: ChannelAdapter = {
        platform: 'telegram',
        connect: async () => {},
        disconnect: async () => {},
        getStatus: () => ({ platform: 'telegram', state: 'connected' }),
        setInboundHandler: () => {},
        send: async (msg) => {
          sent.push(msg.text)
          return { success: true, messageId: '1' }
        }
      }

      const router = new ChannelRouter(
        store,
        sessionManager,
        new ChannelAuth(),
        runner,
        () => adapter,
        () => store.getConfig(),
        {
          settingsStore: settings,
          threadStore: threads,
          listModels: () => models
        }
      )

      const baseMsg = {
        platform: 'telegram' as const,
        chatId: '77',
        chatType: 'dm' as const,
        userId: 'user-2',
        userName: 'carol'
      }

      await router.handleInbound({ ...baseMsg, text: '/model' })
      expect(runner.runChannelTurn).not.toHaveBeenCalled()
      expect(sent.at(-1)).toContain('gpt-4o')
      expect(sent.at(-1)).toContain('Current model')

      await router.handleInbound({ ...baseMsg, text: '/model gpt-4o --session' })
      const session = sessionManager.getSession(buildSessionKey('telegram', '77'))
      expect(session?.modelOverride).toEqual({
        llmProvider: 'openai',
        model: 'gpt-4o'
      })
      expect(sent.at(-1)).toContain('Session model set to openai/gpt-4o')
      expect(settings.get().provider.model).toBe('gpt-3.5')
    })
  })

  it('handles /stop and /steer mid-turn', async () => {
    await withTempHome(async () => {
      const configStore = MousseConfigStore.load()
      const store = new ChannelStore(configStore)
      store.updateConfig({
        platforms: {
          telegram: { enabled: true, allowAllUsers: true },
          discord: { enabled: false },
          webhook: { enabled: false }
        }
      })
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const sessionManager = new ChannelSessionManager(store, threads)
      const settings = new SettingsStore(configStore)

      let drainSteer: (() => string | undefined) | undefined
      let signal: AbortSignal | undefined
      let resolveTurn: ((value: { text: string; silent: boolean; aborted?: boolean }) => void) | undefined

      const runner = {
        runChannelTurn: vi.fn(
          async (
            _threadId: string,
            _text: string,
            opts?: {
              signal?: AbortSignal
              drainSteer?: () => string | undefined
            }
          ) => {
            signal = opts?.signal
            drainSteer = opts?.drainSteer
            return await new Promise<{ text: string; silent: boolean; aborted?: boolean }>((resolve) => {
              resolveTurn = resolve
            })
          }
        )
      }
      const sent: string[] = []
      const adapter: ChannelAdapter = {
        platform: 'telegram',
        connect: async () => {},
        disconnect: async () => {},
        getStatus: () => ({ platform: 'telegram', state: 'connected' }),
        setInboundHandler: () => {},
        send: async (msg) => {
          sent.push(msg.text)
          return { success: true, messageId: '1' }
        }
      }

      const router = new ChannelRouter(
        store,
        sessionManager,
        new ChannelAuth(),
        runner,
        () => adapter,
        () => store.getConfig(),
        {
          settingsStore: settings,
          threadStore: threads,
          listModels: () => []
        }
      )

      const baseMsg = {
        platform: 'telegram' as const,
        chatId: '55',
        chatType: 'dm' as const,
        userId: 'user-3',
        userName: 'dave'
      }

      const turnPromise = router.handleInbound({ ...baseMsg, text: 'long running' })
      // Wait until the runner is in-flight
      await vi.waitFor(() => {
        expect(runner.runChannelTurn).toHaveBeenCalled()
      })

      await router.handleInbound({ ...baseMsg, text: '/steer focus on tests' })
      expect(sent.at(-1)).toContain('Steered')
      expect(drainSteer?.()).toBe('focus on tests')

      await router.handleInbound({ ...baseMsg, text: '/stop' })
      expect(sent.at(-1)).toContain('Stop requested')
      expect(signal?.aborted).toBe(true)

      resolveTurn?.({ text: 'should not deliver', silent: false, aborted: true })
      await turnPromise
      expect(sent.some((s) => s.includes('should not deliver'))).toBe(false)
    })
  })

  it('replies unknown for unrecognized slash commands without LLM', async () => {
    await withTempHome(async () => {
      const configStore = MousseConfigStore.load()
      const store = new ChannelStore(configStore)
      store.updateConfig({
        platforms: {
          telegram: { enabled: true, allowAllUsers: true },
          discord: { enabled: false },
          webhook: { enabled: false }
        }
      })
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      const sessionManager = new ChannelSessionManager(store, threads)
      const settings = new SettingsStore(configStore)
      const runner = {
        runChannelTurn: vi.fn(async () => ({ text: 'from-llm', silent: false }))
      }
      const sent: string[] = []
      const adapter: ChannelAdapter = {
        platform: 'telegram',
        connect: async () => {},
        disconnect: async () => {},
        getStatus: () => ({ platform: 'telegram', state: 'connected' }),
        setInboundHandler: () => {},
        send: async (msg) => {
          sent.push(msg.text)
          return { success: true }
        }
      }

      const router = new ChannelRouter(
        store,
        sessionManager,
        new ChannelAuth(),
        runner,
        () => adapter,
        () => store.getConfig(),
        {
          settingsStore: settings,
          threadStore: threads,
          listModels: () => []
        }
      )

      await router.handleInbound({
        platform: 'telegram',
        chatId: '1',
        chatType: 'dm',
        userId: 'u',
        text: '/notacommand'
      })

      expect(runner.runChannelTurn).not.toHaveBeenCalled()
      expect(sent[0]).toContain('Unknown command')
      expect(sent[0]).toContain('/help')
    })
  })

  it('lists and selects threads without destroying history', async () => {
    await withTempHome(async () => {
      const configStore = MousseConfigStore.load()
      const store = new ChannelStore(configStore)
      store.updateConfig({
        platforms: {
          telegram: { enabled: true, allowAllUsers: true },
          discord: { enabled: false },
          webhook: { enabled: false }
        }
      })
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const sessionManager = new ChannelSessionManager(store, threads)
      const settings = new SettingsStore(configStore)
      const other = threads.createThread('Other thread')

      const runner = {
        runChannelTurn: vi.fn(async () => ({ text: 'from-llm', silent: false }))
      }
      const sent: string[] = []
      const adapter: ChannelAdapter = {
        platform: 'telegram',
        connect: async () => {},
        disconnect: async () => {},
        getStatus: () => ({ platform: 'telegram', state: 'connected' }),
        setInboundHandler: () => {},
        send: async (msg) => {
          sent.push(msg.text)
          return { success: true, messageId: '1' }
        }
      }

      const router = new ChannelRouter(
        store,
        sessionManager,
        new ChannelAuth(),
        runner,
        () => adapter,
        () => store.getConfig(),
        {
          settingsStore: settings,
          threadStore: threads,
          listModels: () => []
        }
      )

      const baseMsg = {
        platform: 'telegram' as const,
        chatId: '88',
        chatType: 'dm' as const,
        userId: 'user-8',
        userName: 'erin'
      }

      const first = sessionManager.resolveThread({ ...baseMsg, text: 'hi' })
      const originalThread = first.mousseThreadId

      await router.handleInbound({ ...baseMsg, text: '/threads' })
      expect(sent.at(-1)).toContain('Threads:')
      expect(sent.at(-1)).toContain(originalThread.slice(0, 8))

      await router.handleInbound({ ...baseMsg, text: `/thread ${other.id.slice(0, 8)}` })
      expect(sent.at(-1)).toContain('Selected thread')
      expect(sent.at(-1)).toContain('history preserved')
      const rebound = sessionManager.getSession(first.sessionKey)
      expect(rebound?.mousseThreadId).toBe(other.id)
      expect(threads.getThread(originalThread)).toBeDefined()
      expect(runner.runChannelTurn).not.toHaveBeenCalled()
    })
  })

  it('accepts /models as alias of /model', async () => {
    await withTempHome(async () => {
      const configStore = MousseConfigStore.load()
      const store = new ChannelStore(configStore)
      store.updateConfig({
        platforms: {
          telegram: { enabled: true, allowAllUsers: true },
          discord: { enabled: false },
          webhook: { enabled: false }
        }
      })
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const sessionManager = new ChannelSessionManager(store, threads)
      const settings = new SettingsStore(configStore)
      const models: LlmProviderOption[] = [
        {
          id: 'openai',
          label: 'OpenAI',
          models: [{ id: 'gpt-4o', label: 'GPT-4o' }]
        }
      ]
      const runner = {
        runChannelTurn: vi.fn(async () => ({ text: 'from-llm', silent: false }))
      }
      const sent: string[] = []
      const adapter: ChannelAdapter = {
        platform: 'telegram',
        connect: async () => {},
        disconnect: async () => {},
        getStatus: () => ({ platform: 'telegram', state: 'connected' }),
        setInboundHandler: () => {},
        send: async (msg) => {
          sent.push(msg.text)
          return { success: true, messageId: '1' }
        }
      }
      const router = new ChannelRouter(
        store,
        sessionManager,
        new ChannelAuth(),
        runner,
        () => adapter,
        () => store.getConfig(),
        {
          settingsStore: settings,
          threadStore: threads,
          listModels: () => models
        }
      )
      const baseMsg = {
        platform: 'telegram' as const,
        chatId: '91',
        chatType: 'dm' as const,
        userId: 'user-9',
        userName: 'frank'
      }
      await router.handleInbound({ ...baseMsg, text: '/models' })
      expect(sent.at(-1)).toContain('Available models')
      await router.handleInbound({ ...baseMsg, text: '/models gpt-4o --session' })
      expect(sent.at(-1)).toContain('Session model set to openai/gpt-4o')
    })
  })

  it('runs unrelated channel sessions concurrently (no globalTurn serialization)', async () => {
    await withTempHome(async () => {
      const configStore = MousseConfigStore.load()
      const store = new ChannelStore(configStore)
      store.updateConfig({
        platforms: {
          telegram: { enabled: true, allowAllUsers: true },
          discord: { enabled: false },
          webhook: { enabled: false }
        }
      })
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const sessionManager = new ChannelSessionManager(store, threads)
      const settings = new SettingsStore(configStore)

      let inFlight = 0
      let maxInFlight = 0
      const gate = new Map<string, () => void>()

      const runner = {
        runChannelTurn: vi.fn(async (threadId: string) => {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise<void>((resolve) => {
            gate.set(threadId, resolve)
          })
          inFlight--
          return { text: `done:${threadId}`, silent: false }
        })
      }
      const sent: string[] = []
      const adapter: ChannelAdapter = {
        platform: 'telegram',
        connect: async () => {},
        disconnect: async () => {},
        getStatus: () => ({ platform: 'telegram', state: 'connected' }),
        setInboundHandler: () => {},
        send: async (msg) => {
          sent.push(msg.text)
          return { success: true, messageId: '1' }
        }
      }
      const router = new ChannelRouter(
        store,
        sessionManager,
        new ChannelAuth(),
        runner,
        () => adapter,
        () => store.getConfig(),
        {
          settingsStore: settings,
          threadStore: threads,
          listModels: () => []
        }
      )

      const p1 = router.handleInbound({
        platform: 'telegram',
        chatId: 'a',
        chatType: 'dm',
        userId: 'u1',
        text: 'hello-a'
      })
      const p2 = router.handleInbound({
        platform: 'telegram',
        chatId: 'b',
        chatType: 'dm',
        userId: 'u2',
        text: 'hello-b'
      })

      await vi.waitFor(() => expect(gate.size).toBe(2))
      expect(maxInFlight).toBe(2)

      for (const release of gate.values()) release()
      await Promise.all([p1, p2])
      expect(sent.some((s) => s.startsWith('done:'))).toBe(true)
    })
  })

  it('stacks same-session ordinary messages FIFO while a turn is busy', async () => {
    await withTempHome(async () => {
      const configStore = MousseConfigStore.load()
      const store = new ChannelStore(configStore)
      store.updateConfig({
        platforms: {
          telegram: { enabled: true, allowAllUsers: true },
          discord: { enabled: false },
          webhook: { enabled: false }
        }
      })
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const sessionManager = new ChannelSessionManager(store, threads)
      const settings = new SettingsStore(configStore)

      const order: string[] = []
      let releaseFirst: (() => void) | undefined

      const runner = {
        runChannelTurn: vi.fn(async (_threadId: string, text: string) => {
          order.push(`start:${text}`)
          if (text === 'first') {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve
            })
          }
          order.push(`end:${text}`)
          return { text: `reply:${text}`, silent: false }
        })
      }
      const adapter: ChannelAdapter = {
        platform: 'telegram',
        connect: async () => {},
        disconnect: async () => {},
        getStatus: () => ({ platform: 'telegram', state: 'connected' }),
        setInboundHandler: () => {},
        send: async () => ({ success: true, messageId: '1' })
      }
      const router = new ChannelRouter(
        store,
        sessionManager,
        new ChannelAuth(),
        runner,
        () => adapter,
        () => store.getConfig(),
        {
          settingsStore: settings,
          threadStore: threads,
          listModels: () => []
        }
      )

      const base = {
        platform: 'telegram' as const,
        chatId: 'stack-1',
        chatType: 'dm' as const,
        userId: 'u-stack'
      }

      const first = router.handleInbound({ ...base, text: 'first' })
      await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'))
      const second = router.handleInbound({ ...base, text: 'second' })

      // Second must not start until first finishes
      expect(order).toEqual(['start:first'])
      releaseFirst!()
      await Promise.all([first, second])
      expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second'])
    })
  })
})

