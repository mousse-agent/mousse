/**
 * When Mousse names a thread: at the first send the title from the message shows at once, dimmed
 * (`provisional`), the title model's title replaces it (`auto`), and after the first finished reply the
 * thread is named once more for good (`final`). A name the person gave is never replaced.
 */
import { describe, expect, it, vi } from 'vitest'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { branchNamingPrompt } from '../../src/mms/workspace/branchNaming'
import { getDefaultSettings, normalizeBranchNamingSettings, type MousseSettings } from '../../src/shared/settings'
import type { ChatMessage, Thread } from '../../src/shared/types'

const MODEL = { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-small' }

interface Harness {
  orch: {
    nameThreadOnFirstSend(threadId: string, content: string, images: number): void
    nameThreadAfterTurn(threadId: string, completed: boolean): void
    askBranchName(request: { threadId: string; system: string; prompt: string }, signal?: AbortSignal): Promise<string | undefined>
    titleWork: Map<string, Promise<void>>
  }
  thread: () => Thread
  rename: (name: string) => void
  oneShot: ReturnType<typeof vi.fn>
  settings: MousseSettings
  messages: ChatMessage[]
  settle: () => Promise<void>
}

function setup(options: { model?: boolean; name?: string; answers?: Array<string | Error>; localOnly?: boolean } = {}): Harness {
  let thread: Thread = { id: 't1', name: options.name ?? 'New Chat', createdAt: '', updatedAt: '', ...(options.localOnly ? { localOnly: true as const } : {}) }
  const answers = [...(options.answers ?? [])]
  const oneShot = vi.fn(async () => {
    const next = answers.shift() ?? 'Unexpected call'
    if (next instanceof Error) throw next
    return { text: next }
  })
  const messages: ChatMessage[] = []
  const settings = { ...getDefaultSettings(), title: options.model === false ? getDefaultSettings().title : MODEL }
  const threadStore = {
    getThread: (id: string) => (id === thread.id ? { ...thread } : null),
    updateThreadMeta: (_id: string, partial: Partial<Thread>) => {
      thread = { ...thread, ...partial }
      return { ...thread }
    }
  }
  const orch = Object.assign(Object.create(OrchestratorService.prototype), {
    threadStore,
    settingsStore: { get: () => settings },
    harness: { oneShot },
    titleWork: new Map(),
    threadScope: () => undefined,
    getMessages: () => messages
  })
  const settle = async () => {
    while (orch.titleWork.size) await Promise.all([...orch.titleWork.values()])
  }
  return {
    orch,
    thread: () => thread,
    rename: (name) => { thread = { ...thread, name, titleSource: 'user' } },
    oneShot,
    settings,
    messages,
    settle
  }
}

const user = (content: string): ChatMessage => ({ id: content, role: 'user', content, timestamp: '' })
const assistant = (content: string): ChatMessage => ({ id: content, role: 'assistant', content, timestamp: '' })

describe('naming a thread', () => {
  it('without a title model, the title from the message is final and no model runs', async () => {
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

    h.messages.push(user('Please fix the OAuth loop'), assistant('The state parameter is lost on the redirect.'))
    h.orch.nameThreadAfterTurn('t1', true)
    await h.settle()
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
    h.messages.push(user('continue'), assistant('I raised the checkout retry limit to three.'))
    h.orch.nameThreadAfterTurn('t1', true)
    await h.settle()
    expect(h.thread()).toMatchObject({ name: 'Checkout retry limit', titleSource: 'final' })
  })

  it('a rename made while the model works is never overwritten', async () => {
    const h = setup({ answers: ['OAuth callback loop'] })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    h.rename('Login bug')
    await h.settle()
    h.messages.push(user('x'), assistant('y'))
    h.orch.nameThreadAfterTurn('t1', true)
    await h.settle()
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
    h.messages.push(user('the relay drops'), assistant('The relay closes idle sockets after 30 seconds.'))
    h.orch.nameThreadAfterTurn('t1', true)
    await h.settle()
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

describe('one request names the thread and its branch', () => {
  /** The branch request the worktree's naming makes for `text` (`requestBranchName`), under the settings now. */
  const branchRequest = (h: Harness, text = 'Please fix the OAuth loop') => ({ threadId: 't1', ...branchNamingPrompt(text, normalizeBranchNamingSettings(h.settings.branches)) })

  it('the first send asks once for both; the worktree branch takes that answer, with no second request', async () => {
    const h = setup({ answers: ['Title: OAuth callback loop\nBranch: oauth-callback-loop'] })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    // Asked for before the answer came: it waits for it.
    const branch = h.orch.askBranchName(branchRequest(h))
    await h.settle()
    expect(h.thread()).toMatchObject({ name: 'OAuth callback loop', titleSource: 'auto' })
    expect(await branch).toBe('oauth-callback-loop')
    expect(h.oneShot).toHaveBeenCalledTimes(1)
    const request = h.oneShot.mock.calls[0]![0]
    expect(request.system).toContain('Branch: <the branch name>')
    expect(request.prompt).toContain('Request: Please fix the OAuth loop')
  })

  it('an answer with a title alone names the thread, and the branch is then asked for on its own', async () => {
    const h = setup({ answers: ['OAuth callback loop', 'oauth-loop'] })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await h.settle()
    expect(h.thread().name).toBe('OAuth callback loop')
    expect(await h.orch.askBranchName(branchRequest(h))).toBe('oauth-loop')
    expect(h.oneShot).toHaveBeenCalledTimes(2)
  })

  it('a naming request that failed is not made again for the branch', async () => {
    const h = setup({ answers: [new Error('offline'), 'oauth-loop'] })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await h.settle()
    expect(await h.orch.askBranchName(branchRequest(h))).toBeUndefined()
    expect(h.oneShot).toHaveBeenCalledTimes(1)
  })

  it('a branch naming that gives up waiting gets nothing', async () => {
    const h = setup({ answers: [] })
    h.oneShot.mockImplementationOnce(() => new Promise(() => undefined))
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    const stop = new AbortController()
    const branch = h.orch.askBranchName(branchRequest(h), stop.signal)
    stop.abort()
    expect(await branch).toBeUndefined()
  })

  it('a thread with no first-send request (it was named already) asks for its branch on its own', async () => {
    const h = setup({ name: 'Nightly review', answers: ['nightly-review'] })
    h.orch.nameThreadOnFirstSend('t1', 'run the review', 0)
    expect(await h.orch.askBranchName(branchRequest(h, 'run the review'))).toBe('nightly-review')
    expect(h.oneShot).toHaveBeenCalledTimes(1)
    expect(h.oneShot.mock.calls[0]![0].task).toBe('branch_name')
  })

  // The first answer applies to the same message, branch settings and title model.
  it.each([
    ['the setup stopped and another message started the worktree', (h: Harness) => branchRequest(h, 'Add dark mode to the settings page')],
    ['the naming mode changed', (h: Harness) => { h.settings.branches = { ...h.settings.branches, mode: 'semantic' }; return branchRequest(h) }],
    ['the title model changed', (h: Harness) => { h.settings.title = { ...h.settings.title, model: 'another-model' }; return branchRequest(h) }]
  ] as const)('%s: the first answer is dropped and the branch is asked for on its own', async (_case, change) => {
    const h = setup({ answers: ['Title: OAuth callback loop\nBranch: oauth-callback-loop', 'fix/dark-mode-settings'] })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await h.settle()
    expect(await h.orch.askBranchName(change(h))).toBe('fix/dark-mode-settings')
    expect(h.oneShot).toHaveBeenCalledTimes(2)
    expect(h.oneShot.mock.calls[1]![0].task).toBe('branch_name')
  })

  it('a switch to Automatic names no branch, from the first answer or a new request', async () => {
    const h = setup({ answers: ['Title: OAuth callback loop\nBranch: oauth-callback-loop'] })
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    await h.settle()
    h.settings.title = getDefaultSettings().title
    expect(await h.orch.askBranchName(branchRequest(h))).toBeUndefined()
    expect(h.oneShot).toHaveBeenCalledTimes(1)
  })

  it('switching to Automatic while the first naming request is pending keeps the temporary branch', async () => {
    const h = setup()
    let answer!: (value: { text: string }) => void
    h.oneShot.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    h.orch.nameThreadOnFirstSend('t1', 'Please fix the OAuth loop', 0)
    const branch = h.orch.askBranchName(branchRequest(h))
    await vi.waitFor(() => expect(answer).toBeDefined())
    h.settings.title = getDefaultSettings().title
    answer({ text: 'Title: OAuth callback loop\nBranch: oauth-callback-loop' })
    expect(await branch).toBeUndefined()
    expect(h.oneShot).toHaveBeenCalledTimes(1)
    await h.settle()
  })

  it("a private thread is asked for its title alone: no branch request, and none of the person's branch instructions", async () => {
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
