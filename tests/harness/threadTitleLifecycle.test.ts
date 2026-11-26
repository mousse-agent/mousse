/**
 * When Mousse names a thread: at the first send the title from the message shows at once, dimmed
 * (`provisional`), the title model's title replaces it (`auto`), and after the first finished reply the
 * thread is named once more for good (`final`). A name the person gave is never replaced. The title and the
 * worktree branch are asked for in requests of their own. With no title model chosen, Automatic names them with
 * the best connected model; First line only, or no connected model, names them from the first line alone.
 */
import { describe, expect, it, vi } from 'vitest'
import { UsageLimitTracker } from '../../src/mms/models/usageLimits'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { usageLimitError } from '../../src/mms/orchestrator/providerErrors'
import { branchNamingPrompt } from '../../src/mms/workspace/branchNaming'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import { harnessAppError, type InstanceModel, type ProviderScope } from '../../src/shared/harness/types'
import { AppError } from '../../src/shared/errors'
import { getDefaultSettings, normalizeBranchNamingSettings, type MousseSettings } from '../../src/shared/settings'
import type { ChatMessage, Thread } from '../../src/shared/types'
import { model, snapshot } from '../providerSnapshotFixture'

const MODEL = { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-small' }
const DEVICE: ProviderScope = { kind: 'device' }

type Answer = string | Error | Promise<string>
interface OneShotRequest {
  selection: { instanceId?: string; llmProvider: string; model: string; effort?: string }
  scope?: ProviderScope
  task: string
  system: string
  prompt: string
  signal?: AbortSignal
}

/** The providers Automatic reads: snapshots that can change, each instance's models, and the scopes an entry is on in. */
interface Providers {
  snapshots: InstanceSnapshot[]
  models?: Record<string, InstanceModel[]>
  enabledIn?: (instanceId: string, scope: ProviderScope) => boolean
}

interface Harness {
  orch: {
    nameThreadOnFirstSend(threadId: string, content: string, images: number, restoreSignal?: AbortSignal, namingSignal?: AbortSignal): void
    nameThreadAfterTurn(threadId: string, completed: boolean): void
    askBranchName(request: { threadId: string; system: string; prompt: string }, signal?: AbortSignal): Promise<string | undefined>
    generateThreadTitle(messages: ChatMessage[], threadId?: string): Promise<string>
    draftPullRequest(params: Record<string, unknown>): Promise<{ source: string }>
    generateCommitMessage(params: Record<string, unknown>): Promise<unknown>
    titleWork: Map<string, Promise<void>>
  }
  thread: () => Thread
  rename: (name: string) => void
  oneShot: ReturnType<typeof vi.fn>
  requests: () => OneShotRequest[]
  settings: MousseSettings
  messages: ChatMessage[]
  limits: UsageLimitTracker
  settle: () => Promise<void>
  /** The providers' checks report `next`: the gateway's snapshots event. */
  checked: (next: InstanceSnapshot[]) => void
  probes: ReturnType<typeof vi.fn>
}

function setup(options: {
  model?: boolean
  name?: string
  answers?: Answer[]
  answer?: (request: OneShotRequest) => Answer
  localOnly?: boolean
  providers?: Providers
  scope?: ProviderScope
  mode?: 'off'
  /** The thread runs on a local server's `phi3:medium` (stored split, as the picker stores it), in memory or not. */
  local?: { resident: boolean | undefined; via?: 'override' | 'default' }
} = {}): Harness {
  let thread: Thread = {
    id: 't1', name: options.name ?? 'New Chat', createdAt: '', updatedAt: '', ...(options.localOnly ? { localOnly: true as const } : {}),
    ...(options.local && options.local.via !== 'default' ? { modelOverride: { instanceId: 'pi:local-ollama', llmProvider: 'local-ollama', model: 'phi3', effort: 'medium' } } : {})
  }
  const answers = [...(options.answers ?? [])]
  const oneShot = vi.fn(async (request: OneShotRequest) => {
    const next = options.answer ? options.answer(request) : answers.shift() ?? 'Unexpected call'
    if (next instanceof Error) throw next
    return { text: await next }
  })
  const messages: ChatMessage[] = []
  const explicit = options.model ?? !options.providers
  const settings = {
    ...getDefaultSettings(),
    title: explicit ? { ...MODEL } : { ...getDefaultSettings().title, ...(options.mode ? { mode: options.mode } : {}) },
    // A thread with no model of its own runs the default: here a local server's model.
    ...(options.local?.via === 'default' ? { provider: { ...getDefaultSettings().provider, instanceId: 'pi:local-ollama', llmProvider: 'local-ollama', model: 'phi3:medium' } } : {})
  } as MousseSettings
  const threadStore = {
    getThread: (id: string) => (id === thread.id ? { ...thread } : null),
    updateThreadMeta: (_id: string, partial: Partial<Thread>) => {
      thread = { ...thread, ...partial }
      return { ...thread }
    }
  }
  const listeners: Array<(event: { type: string; data?: unknown }) => void> = []
  let current = options.providers?.snapshots ?? []
  const probes = vi.fn(async () => current)
  // A test's stub gateway runs single requests only; Automatic's readers come with `providers`.
  const harness = options.providers
    ? {
        oneShot,
        cachedSnapshots: () => current,
        canOneShot: () => true,
        isEnabledInScope: (instanceId: string, scope: ProviderScope) => options.providers!.enabledIn?.(instanceId, scope) ?? true,
        catalog: { models: (instanceId: string) => options.providers!.models?.[instanceId] ?? MODELS[instanceId] ?? [] },
        instances: {
          snapshots: probes,
          subscribe: (listener: (event: { type: string; data?: unknown }) => void) => { listeners.push(listener); return () => undefined }
        }
      }
    : { oneShot }
  const limits = new UsageLimitTracker()
  const local = options.local
  const orch = Object.assign(Object.create(OrchestratorService.prototype), {
    threadStore,
    settingsStore: { get: () => settings },
    harness: local ? { ...harness, instanceMap: { migrate: (selection: unknown) => selection } } : harness,
    ...(local
      ? {
          providerAuth: {
            local: {
              has: (id: string) => id === 'local-ollama',
              facts: (_id: string, modelId: string) => (modelId === 'phi3:medium' ? { tools: 'reported', images: false } : undefined),
              resident: async () => local.resident
            }
          }
        }
      : {}),
    titleWork: new Map(),
    threadScope: () => options.scope,
    getMessages: () => messages
  })
  orch.setUsageLimits(limits)
  const settle = async () => {
    while (orch.titleWork.size) await Promise.all([...orch.titleWork.values()])
  }
  return {
    orch,
    thread: () => thread,
    rename: (name) => { thread = { ...thread, name, titleSource: 'user' } },
    oneShot,
    requests: () => oneShot.mock.calls.map(([request]) => request as OneShotRequest),
    settings,
    messages,
    limits,
    settle,
    checked: (next) => {
      current = next
      for (const listener of listeners) listener({ type: 'snapshots', data: { scope: DEVICE, snapshots: next } })
    },
    probes
  }
}

const user = (content: string): ChatMessage => ({ id: content, role: 'user', content, timestamp: '' })
const assistant = (content: string): ChatMessage => ({ id: content, role: 'assistant', content, timestamp: '' })
/** The first reply of a thread, then its end. */
const finishTurn = async (h: Harness, request = 'Please fix the OAuth loop', reply = 'The state parameter is lost on the redirect.') => {
  h.messages.push(user(request), assistant(reply))
  h.orch.nameThreadAfterTurn('t1', true)
  await h.settle()
}

const LOW = { efforts: ['low', 'medium', 'high'], images: false }
const MODELS: Record<string, InstanceModel[]> = {
  claude: [model('sonnet', { resolvedId: 'claude-sonnet-5-5', capabilities: LOW }), model('haiku', { resolvedId: 'claude-haiku-5-5', capabilities: LOW })],
  codex: [model('gpt-6-luna', { capabilities: LOW })],
  antigravity: [model('gemini-3.8-flash'), model('gemini-4-hydrogen')]
}
const ready = {
  claude: () => snapshot({ auth: { credential: 'subscription' } }),
  codex: () => snapshot({ instanceId: 'codex', driver: 'codex' }),
  antigravity: () => snapshot({ instanceId: 'antigravity', driver: 'antigravity', auth: { credential: 'subscription' } })
}
/** An entry whose first check has not ended (a daemon that just started). */
const unchecked = (ready: InstanceSnapshot): InstanceSnapshot => ({ ...ready, checkedAt: undefined, runs: { state: 'unknown' }, auth: { state: 'unknown' } } as InstanceSnapshot)
const picked = (h: Harness) => h.requests().map((request) => `${request.selection.instanceId}/${request.selection.model}`)

describe('naming a thread', () => {
  it('with Automatic and no connected model, the title from the message is final and no model runs', async () => {
    const h = setup({ model: false })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    expect(h.thread()).toMatchObject({ name: 'Fix the OAuth loop', titleSource: 'final' })
    h.orch.nameThreadAfterTurn('t1', true)
    await h.settle()
    expect(h.oneShot).not.toHaveBeenCalled()
  })

  it('shows the title from the message dimmed at once, then the model title, then names it once more after the first reply', async () => {
    const h = setup({ answers: ['OAuth callback loop', 'OAuth redirect state'] })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    // Written before the model answers, so the sidebar never shows "New Chat".
    expect(h.thread()).toMatchObject({ name: 'Fix the OAuth loop', titleSource: 'provisional' })
    await h.settle()
    expect(h.thread()).toMatchObject({ name: 'OAuth callback loop', titleSource: 'auto' })

    await finishTurn(h)
    expect(h.thread()).toMatchObject({ name: 'OAuth redirect state', titleSource: 'final' })
    expect(h.oneShot.mock.calls[1]![0].prompt).toContain('Reply began: The state parameter is lost on the redirect.')

    // Named for good: later turns never rename it.
    h.orch.nameThreadAfterTurn('t1', true)
    await h.settle()
    expect(h.oneShot).toHaveBeenCalledTimes(2)
  })

  it('names a "continue" thread from its first reply', async () => {
    const h = setup({ answers: ['UNTITLED', 'Checkout retry limit'] })
    h.orch.nameThreadOnFirstSend('t1', 'continue', 0)
    await h.settle()
    expect(h.thread()).toMatchObject({ name: 'New Chat', titleSource: 'provisional' })
    await finishTurn(h, 'continue', 'I raised the checkout retry limit to three.')
    expect(h.thread()).toMatchObject({ name: 'Checkout retry limit', titleSource: 'final' })
  })

  it('a rename made while the model works is never overwritten', async () => {
    const h = setup({ answers: ['OAuth callback loop'] })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    h.rename('Login bug')
    await h.settle()
    await finishTurn(h, 'x', 'y')
    expect(h.thread()).toMatchObject({ name: 'Login bug', titleSource: 'user' })
    expect(h.oneShot).toHaveBeenCalledTimes(1)
  })

  it('a failed model keeps the dimmed title until the turn ends, and a failed turn stops dimming it', async () => {
    const h = setup({ answers: [new Error('offline'), 'Relay drops'] })
    h.orch.nameThreadOnFirstSend('t1', 'the relay drops', 0)
    await h.settle()
    expect(h.thread()).toMatchObject({ name: 'The relay drops', titleSource: 'provisional' })
    h.orch.nameThreadAfterTurn('t1', false)
    await h.settle()
    expect(h.thread()).toMatchObject({ name: 'The relay drops', titleSource: 'auto' })
    // The next finished reply still names it.
    await finishTurn(h, 'the relay drops', 'The relay closes idle sockets after 30 seconds.')
    expect(h.thread()).toMatchObject({ name: 'Relay drops', titleSource: 'final' })
  })

  it('leaves a thread that already has a name alone', async () => {
    const h = setup({ name: 'Nightly review' })
    h.orch.nameThreadOnFirstSend('t1', 'run the review', 0)
    h.orch.nameThreadAfterTurn('t1', true)
    await h.settle()
    expect(h.thread().name).toBe('Nightly review')
    expect(h.thread().titleSource).toBeUndefined()
    expect(h.oneShot).not.toHaveBeenCalled()
  })
})

describe('the title and the branch are asked for apart', () => {
  /** The branch request the worktree's naming makes for `text` (`requestBranchName`), under the settings now. */
  const branchRequest = (h: Harness, text = 'Please fix the OAuth loop') => ({ threadId: 't1', ...branchNamingPrompt(text, normalizeBranchNamingSettings(h.settings.branches))! })

  it('the first send asks for the title alone; the title lands while the branch request is still unanswered', async () => {
    let branchAnswer!: (name: string) => void
    const h = setup({ answer: (request) => request.task === 'title' ? 'OAuth callback loop' : new Promise<string>((resolve) => { branchAnswer = resolve }) })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    const branch = h.orch.askBranchName(branchRequest(h))
    await h.settle()
    expect(h.thread()).toMatchObject({ name: 'OAuth callback loop', titleSource: 'auto' })
    await vi.waitFor(() => expect(branchAnswer).toBeDefined())
    branchAnswer('oauth-callback-loop')
    expect(await branch).toBe('oauth-callback-loop')
    const [title, branchCall] = [h.requests().find((request) => request.task === 'title')!, h.requests().find((request) => request.task === 'branch_name')!]
    expect(h.oneShot).toHaveBeenCalledTimes(2)
    expect(title.system).not.toMatch(/branch/i)
    expect(title.prompt).toContain('Request: Please fix the OAuth loop')
    expect(title.prompt).not.toMatch(/branch/i)
    expect(branchCall.prompt).toContain('Please fix the OAuth loop')
  })

  it('a failed title request does not keep the branch from being named', async () => {
    const h = setup({ answer: (request) => request.task === 'title' ? new Error('offline') : 'oauth-loop' })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await h.settle()
    expect(await h.orch.askBranchName(branchRequest(h))).toBe('oauth-loop')
    expect(h.thread()).toMatchObject({ titleSource: 'provisional' })
  })

  it('a branch naming that gives up waiting gets nothing', async () => {
    const h = setup({ answer: () => new Promise<string>(() => undefined) })
    const stop = new AbortController()
    const branch = h.orch.askBranchName(branchRequest(h), stop.signal)
    stop.abort()
    expect(await branch).toBeUndefined()
  })

  // An answer is for the branch settings and the title model it was asked under.
  it.each([
    ['the naming mode changed', (h: Harness) => { h.settings.branches = { ...h.settings.branches, mode: 'semantic' } }],
    ['the title model changed', (h: Harness) => { h.settings.title = { ...h.settings.title, model: 'another-model' } }],
    ['the title model was cleared to Automatic', (h: Harness) => { h.settings.title = getDefaultSettings().title }],
    ['First line only was picked', (h: Harness) => { h.settings.title = { ...getDefaultSettings().title, mode: 'off' } }]
  ] as const)('%s while the branch request ran: the temporary branch stays', async (_case, change) => {
    let answer!: (name: string) => void
    const h = setup({ answer: () => new Promise<string>((resolve) => { answer = resolve }) })
    const branch = h.orch.askBranchName(branchRequest(h))
    await vi.waitFor(() => expect(answer).toBeDefined())
    change(h)
    answer('oauth-callback-loop')
    expect(await branch).toBeUndefined()
  })

  it('First line only, or Automatic with nothing connected, asks for no branch name', async () => {
    const h = setup({ model: false })
    expect(await h.orch.askBranchName(branchRequest(h))).toBeUndefined()
    h.settings.title = { ...getDefaultSettings().title, mode: 'off' }
    expect(await h.orch.askBranchName(branchRequest(h))).toBeUndefined()
    expect(h.oneShot).not.toHaveBeenCalled()
  })

  it("a private thread is asked for its title alone, with none of the person's branch instructions", async () => {
    const h = setup({ localOnly: true, answers: ['OAuth callback loop'] })
    h.settings.branches = { mode: 'custom', prefix: 'mousse', instructions: 'Start every branch with ticket ABC-123' }
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await h.settle()
    expect(h.thread().name).toBe('OAuth callback loop')
    const request = h.oneShot.mock.calls[0]![0]
    expect(request.system).not.toMatch(/branch/i)
    expect(request.system).not.toContain('ABC-123')
    expect(request.prompt).not.toMatch(/branch/i)
  })
})

describe('Automatic naming', () => {
  const connected = (): Providers => ({ snapshots: [ready.antigravity(), ready.codex(), ready.claude()] })

  it('names the thread and its branch with the best connected model, at a low level', async () => {
    const h = setup({ providers: connected(), answer: (request) => request.task === 'title' ? 'OAuth callback loop' : 'oauth-callback-loop' })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await h.settle()
    expect(h.thread()).toMatchObject({ name: 'OAuth callback loop', titleSource: 'auto' })
    expect(await h.orch.askBranchName({ threadId: 't1', ...branchNamingPrompt('Please fix the OAuth loop', normalizeBranchNamingSettings(h.settings.branches))! })).toBe('oauth-callback-loop')
    expect(h.requests().map((request) => [request.task, request.selection])).toEqual([
      ['title', { instanceId: 'claude', llmProvider: '', model: 'haiku', effort: 'low' }],
      ['branch_name', { instanceId: 'claude', llmProvider: '', model: 'haiku', effort: 'low' }]
    ])
    await finishTurn(h)
    expect(h.thread()).toMatchObject({ titleSource: 'final' })
    expect(picked(h)).toEqual(['claude/haiku', 'claude/haiku', 'claude/haiku'])
  })

  it('a failed entry gives way to the next, three models at most', async () => {
    const h = setup({ providers: { snapshots: [ready.claude(), ready.codex(), ready.antigravity()] }, answer: () => new Error('offline') })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await h.settle()
    expect(picked(h)).toEqual(['claude/haiku', 'codex/gpt-6-luna', 'antigravity/gemini-3.8-flash'])
    expect(h.thread()).toMatchObject({ name: 'Fix the OAuth loop', titleSource: 'provisional' })
  })

  it("one model's quota moves to the entry's next model, and the limit is kept for the next request and bots", async () => {
    const quota = harnessAppError({ code: 'rate_limited', message: 'Quota reached.', scope: 'model', resetAt: new Date(Date.now() + 60 * 60_000).toISOString() })
    const h = setup({ providers: { snapshots: [ready.antigravity()] }, answer: (request) => request.selection.model === 'gemini-3.8-flash' ? quota : 'OAuth callback loop' })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await h.settle()
    expect(h.thread()).toMatchObject({ name: 'OAuth callback loop', titleSource: 'auto' })
    expect(h.limits.isLimited('antigravity', 'gemini-3.8-flash')).toBe(true)
    expect(h.limits.isLimited('antigravity', 'gemini-4-hydrogen')).toBe(false)
    await finishTurn(h)
    expect(picked(h)).toEqual(['antigravity/gemini-3.8-flash', 'antigravity/gemini-4-hydrogen', 'antigravity/gemini-4-hydrogen'])
  })

  it("an entry's usage limit moves to another entry until the reset", async () => {
    const h = setup({
      providers: connected(),
      answer: (request) => request.selection.instanceId === 'claude'
        ? usageLimitError({ provider: 'claude', resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(), estimated: false, limitKind: 'five_hour' })
        : 'OAuth callback loop'
    })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await h.settle()
    await finishTurn(h)
    expect(picked(h)).toEqual(['claude/haiku', 'codex/gpt-6-luna', 'codex/gpt-6-luna'])
    expect(h.limits.isLimited('claude')).toBe(true)
  })

  it('too many requests just now moves naming to another entry for a short while, and leaves bots alone', async () => {
    const busy = new AppError({ code: 'provider_rate_limited', message: 'Slow down.', errorInfo: { category: 'unavailable', retryable: true } })
    const h = setup({ providers: connected(), answer: (request) => request.selection.instanceId === 'claude' ? busy : 'OAuth callback loop' })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await h.settle()
    await finishTurn(h)
    expect(picked(h)).toEqual(['claude/haiku', 'codex/gpt-6-luna', 'codex/gpt-6-luna'])
    // The profile's shared limits, which bots read, hold nothing.
    expect(h.limits.isLimited('claude')).toBe(false)
  })

  it.each(['provider_timeout', 'timeout', 'provider_cancelled', 'aborted', 'policy_unenforceable'])('%s ends the naming with no other model asked', async (code) => {
    const error = Object.assign(new Error(code), { code })
    const h = setup({ providers: connected(), answer: () => error })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await h.settle()
    expect(picked(h)).toEqual(['claude/haiku'])
    expect(h.thread()).toMatchObject({ titleSource: 'provisional' })
    expect(h.limits.limitedInstances().size).toBe(0)
  })

  it('a stop ends the naming at once; the request still running is left to end on its own signal', async () => {
    const h = setup({ providers: connected(), answer: () => new Promise<string>(() => undefined) })
    const stop = new AbortController()
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0, undefined, stop.signal)
    await vi.waitFor(() => expect(h.oneShot).toHaveBeenCalledTimes(1))
    stop.abort()
    await h.settle()
    expect(h.requests()[0]!.signal?.aborted).toBe(true)
    expect(h.oneShot).toHaveBeenCalledTimes(1)
    expect(h.thread()).toMatchObject({ name: 'Fix the OAuth loop', titleSource: 'provisional' })
  })

  it('a title gives up after 25 seconds, whatever the model does, and asks no other model', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = setup({ providers: connected(), answer: () => new Promise<string>(() => undefined) })
      h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
      while (!h.oneShot.mock.calls.length) await new Promise((resolve) => setImmediate(resolve))
      vi.advanceTimersByTime(24_999)
      await new Promise((resolve) => setImmediate(resolve))
      expect(h.requests()[0]!.signal?.aborted).toBe(false)
      vi.advanceTimersByTime(1)
      await h.settle()
      expect(h.requests()[0]!.signal?.aborted).toBe(true)
      expect(h.oneShot).toHaveBeenCalledTimes(1)
      expect(h.thread()).toMatchObject({ titleSource: 'provisional' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a thread on a local server is named by its own model only while it is in memory; cold, it keeps its first line and no other model is asked', async () => {
    for (const resident of [false, undefined]) {
      const cold = setup({ providers: connected(), local: { resident }, answers: ['Cloud title'] })
      cold.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
      await cold.settle()
      expect(cold.oneShot).not.toHaveBeenCalled()
      expect(cold.thread().name).not.toBe('Cloud title')
    }
    const warm = setup({ providers: connected(), local: { resident: true }, answers: ['OAuth callback loop'] })
    warm.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await warm.settle()
    expect(warm.thread()).toMatchObject({ name: 'OAuth callback loop', titleSource: 'auto' })
    expect(picked(warm)).toEqual(['pi:local-ollama/phi3:medium'])
  })

  it('a local thread is never named by a cloud model: not by a chosen title model, and not when it runs the default model', async () => {
    for (const local of [{ resident: false }, { resident: false, via: 'default' as const }]) {
      for (const model of [true, false]) {
        const h = setup({ model, ...(model ? {} : { providers: connected() }), local, answers: ['Cloud title'] })
        h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
        await h.settle()
        expect(h.oneShot).not.toHaveBeenCalled()
        expect(h.thread().name).not.toBe('Cloud title')
      }
    }
    const warm = setup({ model: true, local: { resident: true }, answers: ['OAuth callback loop'] })
    warm.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await warm.settle()
    expect(warm.thread()).toMatchObject({ name: 'OAuth callback loop', titleSource: 'auto' })
    expect(picked(warm)).toEqual(['pi:local-ollama/phi3:medium'])
  })

  it('Regenerate falls back to the title from the first message when every model fails, or none is connected', async () => {
    const failing = setup({ providers: connected(), answer: () => new Error('offline') })
    const messages = [user('Please fix the OAuth loop'), assistant('The state parameter is lost.'), user('Also cover the logout redirect')]
    expect(await failing.orch.generateThreadTitle(messages, 't1')).toBe('Fix the OAuth loop')
    expect(failing.oneShot).toHaveBeenCalledTimes(3)
    const answering = setup({ providers: connected(), answers: ['OAuth and logout redirects'] })
    expect(await answering.orch.generateThreadTitle(messages, 't1')).toBe('OAuth and logout redirects')
    expect(answering.requests()[0]!.prompt).toContain('Later request: Also cover the logout redirect')
    const none = setup({ providers: { snapshots: [] } })
    expect(await none.orch.generateThreadTitle(messages, 't1')).toBe('Fix the OAuth loop')
    expect(none.oneShot).not.toHaveBeenCalled()
  })

  it('First line only names threads from their first line with a model connected, and asks no model', async () => {
    const h = setup({ providers: connected(), mode: 'off', answers: ['OAuth callback loop'] })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    expect(h.thread()).toMatchObject({ name: 'Fix the OAuth loop', titleSource: 'final' })
    await finishTurn(h)
    expect(await h.orch.askBranchName({ threadId: 't1', system: 'x', prompt: 'y' })).toBeUndefined()
    expect(await h.orch.generateThreadTitle([user('Please fix the OAuth loop')], 't1')).toBe('Fix the OAuth loop')
    expect(h.oneShot).not.toHaveBeenCalled()
  })

  it('pull request drafts and commit messages use only a title model the person chose', async () => {
    const h = setup({ providers: connected(), answers: ['Title: x\n\nBody'] })
    const draft = await h.orch.draftPullRequest({ root: 'C:/no/such/folder', branch: 'mousse/x', base: 'main', remote: null, originThreadId: null, projectId: null, threadName: 'OAuth loop' })
    expect(draft.source).toBe('heuristic')
    await expect(h.orch.generateCommitMessage({ root: 'C:/no/such/folder', all: true, projectId: null, threadId: null })).rejects.toMatchObject({ code: 'git_suggest_no_model' })
    expect(h.oneShot).not.toHaveBeenCalled()
  })
})

describe('Automatic before the providers were checked', () => {
  it('the turn ends first: the title stops dimming, waits for the check, and is named once a model is ready', async () => {
    const h = setup({ providers: { snapshots: [unchecked(ready.claude())] }, answers: ['OAuth redirect state'] })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    expect(h.thread()).toMatchObject({ name: 'Fix the OAuth loop', titleSource: 'provisional' })
    // A daemon with no window open has read no provider yet: the first checks start here.
    expect(h.probes).toHaveBeenCalledWith(DEVICE)
    await finishTurn(h)
    expect(h.thread()).toMatchObject({ name: 'Fix the OAuth loop', titleSource: 'auto' })
    expect(h.oneShot).not.toHaveBeenCalled()
    h.checked([ready.claude()])
    await vi.waitFor(() => expect(h.thread()).toMatchObject({ name: 'OAuth redirect state', titleSource: 'final' }))
    expect(picked(h)).toEqual(['claude/haiku'])
    expect(h.requests()[0]!.prompt).toContain('Reply began: The state parameter is lost on the redirect.')
  })

  it('the check ends first: the end of the turn names the thread at once', async () => {
    const h = setup({ providers: { snapshots: [unchecked(ready.claude())] }, answers: ['OAuth redirect state'] })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    h.checked([ready.claude()])
    await finishTurn(h)
    expect(h.thread()).toMatchObject({ name: 'OAuth redirect state', titleSource: 'final' })
    expect(h.oneShot).toHaveBeenCalledTimes(1)
  })

  it("a project's thread waits for an entry on in that project, not one that is off there", async () => {
    const project: ProviderScope = { kind: 'project', projectId: 'p1' }
    const h = setup({
      scope: project,
      providers: { snapshots: [ready.claude(), unchecked(ready.codex())], enabledIn: (instanceId, scope) => !(instanceId === 'claude' && scope.kind === 'project') },
      answers: ['OAuth redirect state']
    })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await finishTurn(h)
    expect(h.thread()).toMatchObject({ titleSource: 'auto' })
    expect(h.oneShot).not.toHaveBeenCalled()
    h.checked([ready.claude(), ready.codex()])
    await vi.waitFor(() => expect(h.thread()).toMatchObject({ name: 'OAuth redirect state', titleSource: 'final' }))
    expect(h.requests()[0]).toMatchObject({ selection: { instanceId: 'codex', model: 'gpt-6-luna' }, scope: project })
  })

  it('a title model picked while the thread waits names it once the next check reports', async () => {
    const h = setup({ providers: { snapshots: [unchecked(ready.claude())] }, answers: ['OAuth redirect state'] })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await finishTurn(h)
    h.settings.title = { ...MODEL }
    h.checked([unchecked(ready.claude())])
    await vi.waitFor(() => expect(h.thread()).toMatchObject({ name: 'OAuth redirect state', titleSource: 'final' }))
    expect(h.requests()[0]!.selection).toMatchObject(MODEL)
  })

  it('a check that finds no usable model (signed out) leaves the title final as it is', async () => {
    const h = setup({ providers: { snapshots: [unchecked(ready.claude())] } })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await finishTurn(h)
    h.checked([snapshot({ auth: { state: 'signed_out' } })])
    await vi.waitFor(() => expect(h.thread()).toMatchObject({ name: 'Fix the OAuth loop', titleSource: 'final' }))
    expect(h.oneShot).not.toHaveBeenCalled()
  })

  it('a message the title rules name nothing in keeps its words when no model can name it, not "New Chat"', async () => {
    const h = setup({ providers: { snapshots: [unchecked(ready.claude())] } })
    h.orch.nameThreadOnFirstSend('t1', 'hello there', 0)
    await finishTurn(h, 'hello there')
    h.checked([snapshot({ auth: { state: 'signed_out' } })])
    await vi.waitFor(() => expect(h.thread()).toMatchObject({ name: 'hello there', titleSource: 'final' }))
  })
})
