// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmProviderOption, MousseSettings } from '../../src/shared/settings'
import type { Project, Thread } from '../../src/shared/types'
import { model, snapshot } from '../providerSnapshotFixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A new chat in a project starts with what was last picked there (`Project.newThread`).
// The transcript is not part of this check: the shell shows the composer only.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', () => ({
  MousseAgentChatShell: ({ composer }: { composer: unknown }) => composer
}))
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const catalog = (): LlmProviderOption[] => [
  { id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus 5.5' }, { id: 'sonnet', label: 'Sonnet 5.5' }] }
]
/** The profile's default permission mode; a test may set another. */
let defaultMode = 'accept_edits'
const settings = (): MousseSettings => ({
  provider: { llmProvider: 'claude-subscription', model: 'opus' },
  permissions: { defaultMode },
  integrations: { skills: { enabledSkills: [] } }
} as unknown as MousseSettings)

let root: Root
let host: HTMLElement
let reads: { get: number; getOptions: number }
let settingsListeners: Array<(value: MousseSettings) => void>
/** Answers a test gives on top of the stub, by section (`threads`, `orchestrator`). */
let bridge: Record<string, Record<string, unknown>>

/**
 * `window.mousse` for the composer: settings, options and skills answer (a new object on every call, as
 * over IPC); `on…` subscriptions return an unsubscribe; any other call stays pending.
 */
function stubBridge(): void {
  const pending = () => new Promise(() => undefined)
  // A read loop stops being answered after a few rounds, so the test ends on the read count, not a hang.
  const answer = <T>(value: T): Promise<T> => (reads.get > 10 ? (pending() as Promise<T>) : Promise.resolve(value))
  const section = (overrides: Record<string, unknown>): unknown =>
    new Proxy(overrides, {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined
        if (key in target) return target[key]
        return key.startsWith('on') ? () => () => undefined : (..._args: unknown[]) => pending()
      }
    })
  const sections: Record<string, unknown> = {
    settings: section({
      get: () => { reads.get++; return answer(settings()) },
      getOptions: () => { reads.getOptions++; return answer({ themes: [], accentColors: [], llmProviders: catalog(), agentTypes: [] }) },
      onChanged: (listener: (value: MousseSettings) => void) => {
        settingsListeners.push(listener)
        return () => { settingsListeners = settingsListeners.filter((entry) => entry !== listener) }
      }
    }),
    skills: section({ list: () => Promise.resolve({ skills: [] }) }),
    ...Object.fromEntries(Object.entries(bridge).map(([name, overrides]) => [name, section(overrides)]))
  }
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section({})
      return target[key]
    }
  })
}

/** Lets pending reads answer and their renders run. */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  reads = { get: 0, getOptions: 0 }
  settingsListeners = []
  bridge = {}
  defaultMode = 'accept_edits'
  stubBridge()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({ profileId: 'prf_test', profileReady: true, workspaceReady: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const project = (id: string, newThread?: Project['newThread']): Project => ({ id, name: id, path: `/work/${id}`, createdAt: '', order: 0, ...(newThread ? { newThread } : {}) })

/** Claude Code as the daemon lists it for each project: Opus 5.5 and Sonnet 5.5, Sonnet hidden when asked. */
async function listModels(projectIds: string[], options: { sonnetHidden?: boolean } = {}): Promise<void> {
  const { useProviderSnapshotsStore } = await import('../../src/renderer/lib/providerSnapshots')
  const snapshots = [snapshot({ caps: { toolControl: 'exact' }, models: { entries: [model('opus', { label: 'Opus 5.5' }), model('sonnet', { label: 'Sonnet 5.5', hidden: options.sonnetHidden === true })], source: 'live' } })]
  useProviderSnapshotsStore.setState({ profileId: 'prf_test', scopes: Object.fromEntries(projectIds.map((id) => [`project:${id}`, { snapshots, loading: false }])) })
}

async function showBlankChat(projectId: string): Promise<void> {
  await listModels(['remembers', 'fresh'])
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    activeThreadId: null,
    projects: [project('remembers', { model: { llmProvider: 'claude-subscription', model: 'sonnet' }, permissionMode: 'full' }), project('fresh')],
    composerWorkspaceDrafts: { __blank__: { projectId, worktreeEnabled: true } }
  })
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
}

const modelButton = () => host.querySelector('.composer-model-btn')?.getAttribute('aria-label')
const permissionChip = () => host.querySelector('.composer-permission-chip')?.getAttribute('aria-label')

describe('a new chat in a project', () => {
  it('shows the model and permission mode last picked in that project', async () => {
    await showBlankChat('remembers')
    expect(modelButton()).toBe('Model: Sonnet 5.5')
    expect(permissionChip()).toBe('Permissions: Full access')
    // Showing it reads settings once, as any composer does.
    expect(reads).toEqual({ get: 1, getOptions: 1 })
  })

  it('shows the profile defaults in a project where nothing was picked yet', async () => {
    await showBlankChat('fresh')
    expect(modelButton()).toBe('Model: Opus 5.5')
    expect(permissionChip()).toBe('Permissions: Auto-accept edits')
  })
})

describe('the thread list in the store', () => {
  it('takes a list where only a thread permission mode changed, as a new thread gets its project mode that way', async () => {
    const { sameThreadSnapshot } = await import('../../src/renderer/stores/appStore')
    const thread = { id: 't1', name: 'New Chat', projectId: 'remembers', createdAt: '', updatedAt: '2026-11-10T00:00:00Z' } as Thread
    expect(sameThreadSnapshot([thread], [{ ...thread }])).toBe(true)
    expect(sameThreadSnapshot([thread], [{ ...thread, permissionMode: 'full' }])).toBe(false)
  })
})

/** Types into the composer and presses Enter. */
async function send(text: string): Promise<void> {
  const input = host.querySelector<HTMLTextAreaElement>('.composer-input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await settle()
}

/** A thread as the daemon returns it. */
const threadRow = (id: string, patch: Partial<Thread> = {}): Thread =>
  ({ id, name: 'New Chat', projectId: 'remembers', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', ...patch }) as Thread

const OPUS = { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'opus' }

/**
 * The daemon side of a first send: `threads.create` returns `made`, `threads.applySettings` sets the model and then the
 * mode each only while the thread's settings revision is the one it was given (as main and the daemon do), and the send
 * is accepted. Calls are recorded in order, so a test can check what the first turn runs with.
 */
function daemonForSend(made: Thread, options: {
  select?: number
  /** That computer is too old to set settings conditionally. */
  outdated?: boolean
  /** Runs between the model set and the mode set, as another window could. */
  betweenSets?: () => void
  defaultMode?: Thread['permissionMode']
} = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  let current: Thread = { settingsRevision: 0, ...made }
  let selectFailures = options.select ?? 0
  /** One write of the model or mode, by any route: the revision moves on. */
  const write = (patch: Partial<Thread>) => { current = { ...current, ...patch, settingsRevision: (current.settingsRevision ?? 0) + 1 } }
  bridge.threads = {
    // Made with the model and permission mode the composer names, as the daemon does.
    create: vi.fn(async (...args: unknown[]) => {
      calls.push(['create', ...args])
      const opts = (args[2] ?? {}) as { model?: Thread['modelOverride']; permissionMode?: Thread['permissionMode'] }
      current = { ...current, ...(opts.model ? { modelOverride: opts.model } : {}), ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}) }
      return current
    }),
    // A setup step after the thread was made can fail; the person sends again.
    select: vi.fn(async () => {
      if (selectFailures > 0) { selectFailures -= 1; throw new Error('The service did not answer.') }
    }),
    applySettings: vi.fn(async (id: string, settings: { model?: Thread['modelOverride']; permissionMode?: Thread['permissionMode'] }, ifRevision: number) => {
      calls.push(['applySettings', id, settings, ifRevision])
      if (options.outdated) return { ok: false, code: 'computer_outdated', message: 'Update Mousse.', thread: current }
      let revision = ifRevision
      const conditional = (patch: Partial<Thread>, name: string) => {
        if ((current.settingsRevision ?? 0) !== revision) return false
        write(patch)
        calls.push([name, patch])
        revision = current.settingsRevision!
        return true
      }
      if (settings.model && !conditional({ modelOverride: settings.model }, 'setModel')) return { ok: false, code: 'thread_settings_changed', message: 'changed', thread: current }
      options.betweenSets?.()
      if (settings.permissionMode && !conditional({ permissionMode: settings.permissionMode }, 'setPermissionMode')) return { ok: false, code: 'thread_settings_changed', message: 'changed', thread: current }
      return { ok: true, thread: current }
    })
  }
  bridge.orchestrator = {
    sendToThread: vi.fn(async () => { calls.push(['send', current.permissionMode ?? options.defaultMode, current.modelOverride?.model]); return { message: '', actions: [] } }),
    isTurnActive: vi.fn(async () => false)
  }
  stubBridge()
  return {
    calls,
    sentWith: () => calls.find((call) => call[0] === 'send')?.slice(1),
    /** Another window (or computer) changes the thread on the daemon; this window has not heard yet. */
    writeElsewhere: write
  }
}

async function mountComposer(): Promise<void> {
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
}

describe('the first send of a new chat runs with what the composer shows', () => {
  it('a worktree from another branch makes a new thread, so an older empty Ask thread shows and runs in the project mode', async () => {
    // Another thread in the project remembered Full access; this older empty thread was set to Ask.
    await listModels(['remembers'])
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    useAppStore.setState({
      projects: [project('remembers', { permissionMode: 'full' })],
      threads: [threadRow('older', { permissionMode: 'ask', worktreeEnabled: true, modelOverride: OPUS })],
      activeThreadId: 'older',
      messages: [],
      composerWorkspaceDrafts: {}
    })
    // The composer's create asks for no remembered choices: the daemon makes the thread on the profile defaults.
    const daemon = daemonForSend(threadRow('made', { worktreeEnabled: true, modelOverride: OPUS }))
    await mountComposer()
    expect(permissionChip()).toBe('Permissions: Ask before acting')

    // Another base branch means the send makes a new thread: the composer now shows what that one runs in.
    await act(async () => { useAppStore.getState().setComposerWorkspaceDraft('older', { projectId: 'remembers', worktreeEnabled: true, baseBranch: 'feature' }) })
    await settle()
    expect(permissionChip()).toBe('Permissions: Full access')

    await send('Fix the parser')
    const create = daemon.calls.find((call) => call[0] === 'create')!
    expect(create[3]).toMatchObject({ worktreeEnabled: true, baseBranch: 'feature' })
    expect(create[3]).not.toHaveProperty('rememberedChoices')
    expect(daemon.sentWith()).toEqual(['full', 'opus'])
  })

  it('a mode picked for the new chat runs, and the thread is made with it', async () => {
    await listModels(['remembers'])
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    useAppStore.setState({
      projects: [project('remembers', { permissionMode: 'full' })],
      threads: [], activeThreadId: null, messages: [],
      composerWorkspaceDrafts: { __blank__: { projectId: 'remembers', worktreeEnabled: true } }
    })
    // The worst case: the new thread comes back in Full access.
    const daemon = daemonForSend(threadRow('made', { permissionMode: 'full', worktreeEnabled: true, modelOverride: OPUS }))
    await mountComposer()
    expect(permissionChip()).toBe('Permissions: Full access')
    await act(async () => { host.querySelector<HTMLButtonElement>('.composer-permission-chip')!.click() })
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.composer-permission-mode')].find((row) => row.textContent?.includes('Ask before acting'))!.click() })
    await settle()
    expect(permissionChip()).toBe('Permissions: Ask before acting')

    await send('Fix the parser')
    expect(daemon.sentWith()).toEqual(['ask', 'opus'])
    expect(daemon.calls.find((call) => call[0] === 'create')?.[3]).toMatchObject({ permissionMode: 'ask', model: { model: 'opus' } })
    expect(daemon.calls.some((call) => call[0] === 'setPermissionMode')).toBe(false)
  })

  it('a remembered model that is hidden is not shown, and the first send keeps the daemon fallback instead of stamping it back', async () => {
    // Sonnet was remembered, then hidden in Settings → Providers; Claude Code itself is still on.
    await listModels(['remembers'], { sonnetHidden: true })
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    useAppStore.setState({
      projects: [project('remembers', { model: { ...OPUS, model: 'sonnet' } })],
      threads: [], activeThreadId: null, messages: [],
      composerWorkspaceDrafts: { __blank__: { projectId: 'remembers', worktreeEnabled: true } }
    })
    // The daemon falls back to the profile default for the new thread.
    const daemon = daemonForSend(threadRow('made', { worktreeEnabled: true, modelOverride: OPUS }))
    await mountComposer()
    expect(modelButton()).toBe('Model: Opus 5.5')

    await send('Fix the parser')
    expect(daemon.calls.some((call) => call[0] === 'setModel')).toBe(false)
    expect(daemon.sentWith()?.[1]).toBe('opus')
  })
})

describe('a first send that fails after its thread was made (review reproductions)', () => {
  /** Global default Full access; the project remembered Ask; a new chat in it. */
  async function askChatUnderFullDefault(failures: { select?: number }) {
    defaultMode = 'full'
    await listModels(['remembers'])
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    useAppStore.setState({
      projects: [project('remembers', { permissionMode: 'ask' })],
      threads: [], activeThreadId: null, messages: [],
      composerWorkspaceDrafts: { __blank__: { projectId: 'remembers', worktreeEnabled: true } }
    })
    // Made on the profile defaults unless told otherwise, as the daemon makes a composer's thread.
    const daemon = daemonForSend(threadRow('made', { worktreeEnabled: true, modelOverride: OPUS }), failures)
    await mountComposer()
    expect(permissionChip()).toBe('Permissions: Ask before acting')
    return daemon
  }

  it('a setup step that fails after the thread was made: the retry reuses the thread and still runs in Ask', async () => {
    const daemon = await askChatUnderFullDefault({ select: 1 })
    await send('Fix the parser')
    // Nothing was sent: opening the new thread failed after it was made.
    expect(daemon.sentWith()).toBeUndefined()
    expect(permissionChip()).toBe('Permissions: Ask before acting')

    await send('Fix the parser')
    expect(daemon.calls.filter((call) => call[0] === 'create')).toHaveLength(1)
    expect(daemon.sentWith()).toEqual(['ask', 'opus'])
  })

  it('a thread made here needs no call after it: it is made in Ask, and the send runs in Ask', async () => {
    const daemon = await askChatUnderFullDefault({})
    await send('Fix the parser')
    expect(daemon.calls.find((call) => call[0] === 'create')?.[3]).toMatchObject({ permissionMode: 'ask' })
    expect(daemon.calls.some((call) => call[0] === 'applySettings')).toBe(false)
    expect(daemon.sentWith()).toEqual(['ask', 'opus'])
  })
})

describe('a new chat on another computer gets its settings in the same send, or sends nothing', () => {
  const NODE = 'node-1'
  /** A chat for another computer with the given default; `pick` is chosen in the composer. */
  async function chatOnOtherComputer(options: Parameters<typeof daemonForSend>[1], modes: { computerDefault: 'full' | 'ask'; pick: string }) {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    useAppStore.setState({
      projects: [{ ...project(`${NODE}:repo`), node: NODE }],
      threads: [], activeThreadId: null, messages: [],
      composerWorkspaceDrafts: { __blank__: { projectId: `${NODE}:repo`, worktreeEnabled: false, node: NODE as never } }
    })
    // That computer makes the thread with neither a model nor a mode of its own, and runs it in its default.
    const daemon = daemonForSend(threadRow(`${NODE}:made`, { node: NODE, projectId: `${NODE}:repo` }), { ...options, defaultMode: modes.computerDefault })
    bridge.platformRequest = {
      request: vi.fn(async (method: string) => method === 'bridge.hub.composerOptions'
        ? { providers: [{ id: 'claude-subscription', instanceId: 'claude', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus 5.5' }] }], defaultModel: OPUS, permission: { defaultMode: modes.computerDefault } }
        : new Promise(() => undefined))
    }
    stubBridge()
    await mountComposer()
    await act(async () => { host.querySelector<HTMLButtonElement>('.composer-permission-chip')!.click() })
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.composer-permission-mode')].find((row) => row.textContent?.includes(modes.pick))!.click() })
    await settle()
    expect(permissionChip()).toBe(`Permissions: ${modes.pick}`)
    return daemon
  }

  it('sets the model and then Ask, each on the revision it last had, and sends in Ask', async () => {
    const daemon = await chatOnOtherComputer({}, { computerDefault: 'full', pick: 'Ask before acting' })
    await send('Fix the parser')
    expect(daemon.calls.find((call) => call[0] === 'applySettings')).toEqual(['applySettings', `${NODE}:made`, { model: expect.objectContaining({ model: 'opus' }), permissionMode: 'ask' }, 0])
    expect(daemon.sentWith()).toEqual(['ask', 'opus'])
  })

  it('race: Ask set elsewhere while the model was being set refuses the pending Full access, sends nothing, and shows Ask', async () => {
    let daemon!: ReturnType<typeof daemonForSend>
    daemon = await chatOnOtherComputer({ betweenSets: () => daemon.writeElsewhere({ permissionMode: 'ask' }) }, { computerDefault: 'ask', pick: 'Full access' })
    await send('Fix the parser')
    expect(daemon.calls.some((call) => call[0] === 'setPermissionMode')).toBe(false)
    expect(daemon.sentWith()).toBeUndefined()
    expect(host.textContent).toContain("Not sent: couldn't apply your settings on")
    expect(permissionChip()).toBe('Permissions: Ask before acting')
    // Nothing is kept for a retry: the next send runs in what is shown.
    await send('Fix the parser')
    expect(daemon.calls.filter((call) => call[0] === 'setPermissionMode')).toHaveLength(0)
    expect(daemon.sentWith()?.[0]).toBe('ask')
  })

  it('ABA: Ask, Full access, Ask set elsewhere before the setup still moves the revision, so nothing is applied or sent', async () => {
    const daemon = await chatOnOtherComputer({}, { computerDefault: 'ask', pick: 'Full access' })
    const create = bridge.threads.create as ReturnType<typeof vi.fn>
    const made = create.getMockImplementation()!
    create.mockImplementation(async (...args: unknown[]) => {
      const thread = await made(...args)
      daemon.writeElsewhere({ permissionMode: 'ask' })
      daemon.writeElsewhere({ permissionMode: 'full' })
      daemon.writeElsewhere({ permissionMode: 'ask' })
      return thread
    })
    await send('Fix the parser')
    expect(daemon.calls.some((call) => call[0] === 'setModel' || call[0] === 'setPermissionMode')).toBe(false)
    expect(daemon.sentWith()).toBeUndefined()
    expect(permissionChip()).toBe('Permissions: Ask before acting')
  })

  it('an older computer that cannot set settings conditionally fails closed: nothing is applied or sent, and says to update it', async () => {
    const daemon = await chatOnOtherComputer({ outdated: true }, { computerDefault: 'full', pick: 'Ask before acting' })
    await send('Fix the parser')
    expect(daemon.sentWith()).toBeUndefined()
    expect(host.textContent).toMatch(/Update Mousse on .+ to send from here\./)
    // The chip shows the mode the thread really runs in there.
    expect(permissionChip()).toBe('Permissions: Full access')
  })

  it('with nothing to set, an older computer is not asked anything and the send goes', async () => {
    const daemon = await chatOnOtherComputer({ outdated: true }, { computerDefault: 'full', pick: 'Full access' })
    // The shown model is that computer's default; the thread there has no model of its own, so it is still set.
    ;(bridge.threads.create as ReturnType<typeof vi.fn>).mockImplementationOnce(async (...args: unknown[]) => {
      daemon.calls.push(['create', ...args])
      return { ...threadRow(`${NODE}:made`, { node: NODE, projectId: `${NODE}:repo` }), modelOverride: OPUS, settingsRevision: 1 }
    })
    await send('Fix the parser')
    expect(daemon.calls.some((call) => call[0] === 'applySettings')).toBe(false)
    expect(daemon.calls.some((call) => call[0] === 'send')).toBe(true)
  })
})
