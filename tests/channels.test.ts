import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { chunkMessage } from '../src/mms/channels/chunkMessage'
import { isSilenceNarration, parseDeliveryTarget } from '../src/mms/channels/delivery'
import { ChannelStore } from '../src/mms/channels/ChannelStore'
import { ChannelSessionManager } from '../src/mms/channels/ChannelSessionManager'
import { ChannelRouter } from '../src/mms/channels/ChannelRouter'
import { ChannelAuth } from '../src/mms/channels/ChannelAuth'
import { ChannelService } from '../src/mms/channels/ChannelService'
import { asChannelConfigPatch } from '../src/mms/protocol/validators'
import { TelegramAdapter } from '../src/mms/channels/adapters/TelegramAdapter'
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
import type {
  InboundChannelMessage,
  OutboundChannelMessage,
  ChannelAdapter
} from '../src/mms/channels/types'
import type { LlmProviderOption } from '../src/shared/settings'
import type { ChannelConfig } from '../src/shared/types'

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
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500)
    expect(chunks.join(' ')).toBe(text)
  })
})

describe('TelegramAdapter', () => {
  it('retries a transient outbound fetch failure', async () => {
    const networkError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )

    try {
      const adapter = new TelegramAdapter({ enabled: true, token: 'test-token' })
      await expect(
        adapter.send({ platform: 'telegram', chatId: '42', text: 'hello' })
      ).resolves.toEqual({ success: true, messageId: '7' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('keeps polling with backoff when Telegram returns transient 502 responses', async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/getMe')) {
        return new Response(JSON.stringify({ ok: true, result: { username: 'mousse-test' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url.endsWith('/setMyCommands')) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({ ok: false, description: 'Bad Gateway' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      })
    })

    const adapter = new TelegramAdapter({ enabled: true, token: 'test-token' })
    try {
      await adapter.connect()
      await vi.advanceTimersByTimeAsync(0)
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/getUpdates'))
      ).toHaveLength(1)
      expect(adapter.getStatus().state).toBe('connected')
      expect(warning).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1000)
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/getUpdates'))
      ).toHaveLength(2)
      expect(adapter.getStatus().state).toBe('connected')
      // The second consecutive failure backs off without another stack/log flood.
      expect(warning).toHaveBeenCalledTimes(1)
    } finally {
      await adapter.disconnect()
      fetchMock.mockRestore()
      warning.mockRestore()
      vi.useRealTimers()
    }
  })

  it('renders channel menus as Telegram inline keyboards', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )

    try {
      const adapter = new TelegramAdapter({ enabled: true, token: 'test-token' })
      await adapter.send({
        platform: 'telegram',
        chatId: '42',
        text: 'Select a provider',
        menu: {
          id: 'abc123',
          placeholder: 'Choose',
          options: [{ label: 'OpenAI', description: '2 models', value: '0' }],
          page: 0,
          pageCount: 2
        }
      })
      const request = fetchMock.mock.calls[0]?.[1] as RequestInit
      const body = JSON.parse(String(request.body))
      expect(body.reply_markup.inline_keyboard).toEqual([
        [{ text: 'OpenAI — 2 models', callback_data: 'mousse:abc123:0' }],
        [{ text: 'Next ›', callback_data: 'mousse:abc123:next' }]
      ])
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('includes Telegram error details in outbound failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    )

    try {
      const adapter = new TelegramAdapter({ enabled: true, token: 'test-token' })
      await expect(
        adapter.send({ platform: 'telegram', chatId: 'missing', text: 'hello' })
      ).resolves.toEqual({
        success: false,
        error: 'Telegram API sendMessage HTTP 400: Bad Request: chat not found'
      })
    } finally {
      fetchMock.mockRestore()
    }
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
      // A fresh store over the same home reads what was written to disk.
      const reloaded = new ChannelStore(MousseConfigStore.load(tempHome))
      expect(reloaded.getConfig().platforms.telegram).toMatchObject({ enabled: true, allowedUserIds: ['1'] })
      expect(reloaded.listSessions()).toHaveLength(1)
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

  it('registers canonical commands and compatible aliases on Telegram and Discord', () => {
    const names = CHANNEL_COMMAND_REGISTRY.map((command) => command.name)
    const telegramNames = telegramBotCommands().map((command) => command.command)
    const discordNames = discordApplicationCommands().map((command) => command.name)
    expect(telegramNames).toEqual(expect.arrayContaining(names))
    expect(discordNames).toEqual(expect.arrayContaining(names))
    expect(telegramNames).toContain('models')
    expect(discordNames).toContain('models')
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
      const outbound: OutboundChannelMessage[] = []
      const adapter: ChannelAdapter = {
        platform: 'telegram',
        connect: async () => {},
        disconnect: async () => {},
        getStatus: () => ({ platform: 'telegram', state: 'connected' }),
        setInboundHandler: () => {},
        send: async (msg) => {
          sent.push(msg.text)
          outbound.push(msg)
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
      const providerMenu = outbound.at(-1)?.menu
      expect(providerMenu?.options.map((option) => option.label)).toContain('✓ OpenAI')

      await router.handleInbound({
        ...baseMsg,
        text: '[menu selection]',
        menuSelection: { menuId: providerMenu!.id, value: '0' }
      })
      expect(outbound.at(-1)?.menu?.options.map((option) => option.description)).toEqual([
        'gpt-3.5',
        'gpt-4o'
      ])

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

      const stoppedThreads: string[] = []
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
        ),
        // `/stop` is a Stop of the thread (`OrchestratorService.stopThread`): its subagents end with it.
        stopThread: vi.fn(async (threadId: string) => {
          stoppedThreads.push(threadId)
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
      // The thread the channel session is bound to is Stopped as a whole, once.
      expect(stoppedThreads).toHaveLength(1)
      expect(stoppedThreads[0]).toBe(runner.runChannelTurn.mock.calls[0][0])

      resolveTurn?.({ text: 'should not deliver', silent: false, aborted: true })
      await turnPromise
      expect(sent.some((s) => s.includes('should not deliver'))).toBe(false)
    })
  })

  it('forwards unrecognized slash commands to the host turn with the real message identity', async () => {
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
        text: '/notacommand',
        messageId: 'host-1'
      })

      expect(runner.runChannelTurn).toHaveBeenCalledWith(
        expect.any(String),
        '/notacommand',
        expect.objectContaining({
          hostIngress: { platform: 'telegram', chatId: '1', messageId: 'host-1' }
        })
      )
      expect(sent[0]).toBe('from-llm')
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
      const projectPath = join(process.env.MOUSSE_HOME!, 'project-one')
      mkdirSync(projectPath, { recursive: true })
      const project = projects.openProject(projectPath)
      const projectThread = threads.createThread('Project thread', project.id, project.path)

      const runner = {
        runChannelTurn: vi.fn(async () => ({ text: 'from-llm', silent: false }))
      }
      const sent: string[] = []
      const outbound: OutboundChannelMessage[] = []
      const adapter: ChannelAdapter = {
        platform: 'telegram',
        connect: async () => {},
        disconnect: async () => {},
        getStatus: () => ({ platform: 'telegram', state: 'connected' }),
        setInboundHandler: () => {},
        send: async (msg) => {
          sent.push(msg.text)
          outbound.push(msg)
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
      const threadMenu = outbound.at(-1)?.menu
      expect(threadMenu?.options[0]).toMatchObject({
        label: 'Projects ›',
        description: '1 project'
      })
      expect(
        threadMenu?.options.some((option) => option.description === originalThread.slice(0, 8))
      ).toBe(true)
      expect(
        threadMenu?.options.some((option) => option.description === other.id.slice(0, 8))
      ).toBe(true)

      await router.handleInbound({
        ...baseMsg,
        text: '[menu selection]',
        menuSelection: { menuId: threadMenu!.id, value: '0' }
      })
      const projectMenu = outbound.at(-1)?.menu
      expect(projectMenu?.placeholder).toBe('Choose a project')
      expect(projectMenu?.options[0]?.label).toBe(project.name)

      await router.handleInbound({
        ...baseMsg,
        text: '[menu selection]',
        menuSelection: { menuId: projectMenu!.id, value: '0' }
      })
      const projectThreadMenu = outbound.at(-1)?.menu
      expect(projectThreadMenu?.placeholder).toBe('Choose a project thread')
      expect(projectThreadMenu?.options[0]?.description).toBe(projectThread.id.slice(0, 8))

      await router.handleInbound({
        ...baseMsg,
        text: '[menu selection]',
        menuSelection: { menuId: projectThreadMenu!.id, value: '0' }
      })
      expect(sent.at(-1)).toContain('Selected thread')
      expect(sent.at(-1)).toContain('history preserved')
      const rebound = sessionManager.getSession(first.sessionKey)
      expect(rebound?.mousseThreadId).toBe(projectThread.id)
      expect(threads.getThread(originalThread)).toBeDefined()
      expect(runner.runChannelTurn).not.toHaveBeenCalled()
    })
  })

  it('uses provider, model, and reasoning-effort menus for /models', async () => {
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
          models: [{ id: 'gpt-4o', label: 'GPT-4o', efforts: ['low', 'high'] }]
        }
      ]
      const runner = {
        runChannelTurn: vi.fn(async () => ({ text: 'from-llm', silent: false }))
      }
      const sent: string[] = []
      const outbound: OutboundChannelMessage[] = []
      const adapter: ChannelAdapter = {
        platform: 'telegram',
        connect: async () => {},
        disconnect: async () => {},
        getStatus: () => ({ platform: 'telegram', state: 'connected' }),
        setInboundHandler: () => {},
        send: async (msg) => {
          sent.push(msg.text)
          outbound.push(msg)
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
      const providerMenu = outbound.at(-1)!.menu!
      expect(providerMenu.placeholder).toBe('Choose a provider')

      await router.handleInbound({
        ...baseMsg,
        text: '[menu selection]',
        menuSelection: { menuId: providerMenu.id, value: '0' }
      })
      const modelMenu = outbound.at(-1)!.menu!
      expect(modelMenu.options[0]?.description).toBe('gpt-4o')

      await router.handleInbound({
        ...baseMsg,
        text: '[menu selection]',
        menuSelection: { menuId: modelMenu.id, value: '0' }
      })
      const effortMenu = outbound.at(-1)!.menu!
      expect(effortMenu.options.map((option) => option.label)).toEqual(['Low', 'High'])

      await router.handleInbound({
        ...baseMsg,
        text: '[menu selection]',
        menuSelection: { menuId: effortMenu.id, value: '1' }
      })
      expect(sent.at(-1)).toContain('Session model set to openai/gpt-4o:high')
      expect(sessionManager.getSession(buildSessionKey('telegram', '91'))?.modelOverride).toEqual({
        llmProvider: 'openai',
        model: 'gpt-4o:high'
      })
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


describe('channel owner and bot replies (PR 6 §6)', () => {
  function service(options: ConstructorParameters<typeof ChannelService>[6] = {}) {
    const configStore = MousseConfigStore.load()
    const store = new ChannelStore(configStore)
    const projects = new ProjectManager()
    const threads = new ThreadDataStore(projects)
    projects.setThreadStore(threads)
    const orchestrator = { migrateModelOverride: (override: unknown) => override, isBotThread: () => false } as never
    return { store, configStore, channels: new ChannelService(orchestrator, threads, store, new SettingsStore(configStore), {} as never, undefined, options) }
  }

  /** What the router records when the right code arrives from `userId`. */
  function receiveCode(channels: ChannelService, code: string, userId: string) {
    const claims = (channels as unknown as { ownerClaims: { receive(message: InboundChannelMessage, code: string): string } }).ownerClaims
    expect(claims.receive({ platform: 'telegram', chatId: `chat-${userId}`, chatType: 'dm', userId, userName: 'Me', text: '' }, code)).toBe('received')
  }

  /** The platform config validator as builds before 6d shipped it: no `owner` key is allowed. */
  const PRE_6D_PLATFORM_KEYS = new Set(['enabled', 'token', 'allowedUserIds', 'allowAllUsers', 'homeChatId', 'webhookPort', 'webhookSecret'])
  const pre6dAccepts = (config: ChannelConfig) =>
    Object.values(config.platforms).every((platform) => Object.keys(platform).every((key) => PRE_6D_PLATFORM_KEYS.has(key))) &&
    Object.keys(config).every((key) => ['platforms', 'filterSilenceNarration', 'unauthorizedDmBehavior'].includes(key))

  it('the owner is kept outside the channel config, so what Settings saves back stays valid for older builds', async () => {
    await withTempHome(async () => {
      const { store, configStore, channels } = service()
      store.updateConfig({ platforms: { telegram: { enabled: true, token: 't' }, discord: { enabled: false }, webhook: { enabled: false } } })
      expect(() => channels.startOwnerClaim('webhook')).toThrow(/Webhook senders/)
      expect(() => channels.confirmOwner('telegram', 'u1')).toThrow(/No account sent that code/)
      const { code } = channels.startOwnerClaim('telegram')
      receiveCode(channels, code, 'u1')
      expect(channels.ownerClaimStatus('telegram')).toMatchObject({ claimant: { userId: 'u1' } })
      expect(channels.confirmOwner('telegram', 'u1').telegram).toMatchObject({ userId: 'u1', displayName: 'Me' })
      const snapshot = channels.getSnapshot()
      expect(snapshot.owners?.telegram).toMatchObject({ userId: 'u1' })
      // Neither the stored config nor the form the renderer sends back carries the owner.
      expect(JSON.stringify(configStore.getChannelsSection())).not.toContain('u1')
      expect(pre6dAccepts(snapshot.config)).toBe(true)
      expect(() => asChannelConfigPatch(snapshot.config)).not.toThrow()
      channels.updateConfig(snapshot.config)
      expect(store.getOwners().telegram).toMatchObject({ userId: 'u1' })
      expect(channels.clearOwner('telegram').telegram).toBeUndefined()
    })
  })

  it('"No" ends the claim in the daemon: the code stops working and a stored owner stays', async () => {
    await withTempHome(async () => {
      const { store, channels } = service()
      store.setOwner('telegram', { userId: 'u1', displayName: 'Me', confirmedAt: 'x' })
      const { code } = channels.startOwnerClaim('telegram')
      receiveCode(channels, code, 'u2')
      channels.cancelOwnerClaim('telegram')
      expect(channels.ownerClaimStatus('telegram')).toBeNull()
      expect(() => channels.confirmOwner('telegram', 'u2')).toThrow(/No account sent that code/)
      expect(store.getOwners().telegram).toMatchObject({ userId: 'u1' })
    })
  })

  it('a bot reply goes to the owner\'s chat once connected, is retried after a failed send, and never to a former owner', async () => {
    await withTempHome(async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      try {
        const sent: OutboundChannelMessage[] = []
        let failNext = 0
        let listener: ((event: { activationId?: string }) => void) | undefined
        const told = new Set<string>()
        const releases: string[] = []
        const replyTo = { platform: 'telegram' as const, chatId: '42', messageId: 'm1', userId: 'u1' }
        const { store, channels } = service({
          createAdapter: (platform) => ({
            platform,
            connect: async () => {},
            disconnect: async () => {},
            getStatus: () => ({ platform, state: 'connected' }),
            setInboundHandler: () => {},
            send: async (message) => {
              if (failNext > 0) {
                failNext -= 1
                return { success: false, error: '429' }
              }
              sent.push(message)
              return { success: true }
            }
          }),
          bots: {
            findByName: () => undefined,
            activateFromChannel: async () => {},
            channelReply: (id, options) => {
              if (told.has(id) || (options?.canSend && !options.canSend(replyTo))) return undefined
              told.add(id)
              return { replyTo, text: 'Footer fixed.', release: () => { told.delete(id); releases.push(id) } }
            },
            recentChannelActivations: () => ['act-1'],
            onChanged: (next) => {
              listener = next
              return () => { listener = undefined }
            }
          }
        })
        store.updateConfig({ platforms: { telegram: { enabled: true, token: 't' }, discord: { enabled: false }, webhook: { enabled: false } } })
        store.setOwner('telegram', { userId: 'u1', displayName: 'Me', confirmedAt: 'x' })
        // Not connected: nothing is claimed or sent.
        listener!({ activationId: 'act-1' })
        expect(told.size).toBe(0)
        // Connecting sweeps what is still owed; the first send fails and is retried.
        failNext = 1
        await channels.connect('telegram')
        await vi.waitFor(() => expect(releases).toEqual(['act-1']))
        expect(sent).toHaveLength(0)
        await vi.advanceTimersByTimeAsync(30_000)
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]).toMatchObject({ chatId: '42', text: 'Footer fixed.', replyToMessageId: 'm1' })
        listener!({ activationId: 'act-1' })
        await Promise.resolve()
        expect(sent).toHaveLength(1)
        // After an owner change, another activation's reply to the former owner is not sent.
        store.setOwner('telegram', { userId: 'u9', displayName: 'New', confirmedAt: 'y' })
        listener!({ activationId: 'act-2' })
        expect(told.has('act-2')).toBe(false)
        channels.beginShutdown()
        expect(listener).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
