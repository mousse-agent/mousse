/**
 * A model change tells the next turn's agent which model it is now and which models wrote the earlier replies, once
 * per change: not on later turns, not for a reasoning level alone, and not again after a restart.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { modelChangeNote } from '../src/mms/orchestrator/contextHandoff'
import type { ChatMessage } from '../src/shared/types'

const opus = { provider: 'claude-subscription', model: 'opus', name: 'Claude Opus 5.5' }
const sonnet = { provider: 'claude-subscription', model: 'sonnet', name: 'Claude Sonnet 5.5' }
const gpt = { provider: 'openai-codex', model: 'gpt-6.1', name: 'GPT-6.1' }
let next = 0
const user = (content: string, modelSelection: ChatMessage['modelSelection'], extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `m${next++}`, role: 'user', content, timestamp: '2026-11-12T00:00:00Z', modelSelection, ...extra })
const reply = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `m${next++}`, role: 'assistant', content, timestamp: '2026-11-12T00:00:00Z', ...extra })
const providers = (provider: string): string => ({ 'claude-subscription': 'Claude Code', 'openai-codex': 'Codex' })[provider] ?? provider
const noteAt = (messages: ChatMessage[]): string | undefined => modelChangeNote(messages, messages.length - 1, providers)

describe('modelChangeNote', () => {
  it('names the new model and the one that wrote the earlier replies', () => {
    expect(noteAt([user('a', opus), reply('Use a map.'), user('what is your opinion?', sonnet)]))
      .toBe('[Mousse] Model change: you are now Claude Sonnet 5.5. The earlier assistant replies in this thread were written by Claude Opus 5.5.')
  })

  it('gives no note without a switch, for a level alone, or on the turn after the switch', () => {
    expect(noteAt([user('a', opus), reply('one'), user('b', opus)])).toBeUndefined()
    expect(noteAt([user('a', { ...opus, effort: 'low' }), reply('one'), user('b', { ...opus, effort: 'high' })])).toBeUndefined()
    expect(noteAt([user('a', opus), reply('one'), user('b', sonnet), reply('two'), user('c', sonnet)])).toBeUndefined()
    // The first turn of a thread has nothing to compare with.
    expect(noteAt([user('a', opus)])).toBeUndefined()
  })

  it('lists every model that wrote a reply after A → B → A, and which wrote the latest', () => {
    const messages = [user('a', opus), reply('one'), user('b', sonnet), reply('two'), user('c', opus)]
    expect(noteAt(messages)).toBe('[Mousse] Model change: you are now Claude Opus 5.5. The earlier assistant replies in this thread were written by Claude Opus 5.5 and Claude Sonnet 5.5. The latest one was written by Claude Sonnet 5.5.')
  })

  it('names the provider when the models run on different ones', () => {
    expect(noteAt([user('a', opus), reply('one'), user('b', gpt)]))
      .toBe('[Mousse] Model change: you are now GPT-6.1 (Codex). The earlier assistant replies in this thread were written by Claude Opus 5.5 (Claude Code).')
  })

  it('counts only replies: tool rows, thoughts, markers, hidden rows and steers are not', () => {
    const messages = [
      user('a', opus),
      reply('', { kind: 'tool_call' }), reply('thinking', { kind: 'thinking' }), reply('hidden', { hidden: true }),
      user('steer', undefined, { steered: true }),
      user('b', sonnet), reply('Opus 5.5 → Sonnet 5.5', { kind: 'context_handoff' }), reply('two'),
      user('c', gpt)
    ]
    expect(noteAt(messages)).toBe('[Mousse] Model change: you are now GPT-6.1 (Codex). The earlier assistant replies in this thread were written by Claude Sonnet 5.5 (Claude Code).')
    // No earlier reply at all: there is nothing to attribute.
    expect(noteAt([user('a', opus), user('b', sonnet)])).toBeUndefined()
  })

  it('puts nothing before a slash command; the next message gets the note', () => {
    const command = [user('a', opus), reply('one'), user('/review src', sonnet)]
    expect(noteAt(command)).toBeUndefined()
    expect(noteAt([...command, reply('reviewed'), user('and now?', sonnet)]))
      .toBe('[Mousse] Model change: you are now Claude Sonnet 5.5. The earlier assistant replies in this thread were written by Claude Opus 5.5 and Claude Sonnet 5.5. The latest one was written by Claude Sonnet 5.5.')
  })
})

describe('the agent gets the model-change note', () => {
  const homes: string[] = []
  const services: MousseMainService[] = []
  afterEach(async () => {
    for (const service of services.splice(0)) await service.stop().catch(() => undefined)
    vi.restoreAllMocks()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  async function start(home?: string) {
    const dir = home ?? mkdtempSync(join(realpathSync(tmpdir()), 'mousse-model-note-'))
    if (!home) homes.push(dir)
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const main = await MousseMainService.create({ homeDir: dir, headless: true, ownerKind: 'test' })
    await main.start()
    services.push(main)
    const prompts: string[] = []
    let gate: Promise<void> | undefined
    vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
      prompts.push(input.prompt)
      if (gate) await gate
      input.onText(`Answer from ${input.model}`)
      return `Answer from ${input.model}`
    })
    return { main, home: dir, prompts, hold: (until: Promise<void>) => { gate = until } }
  }
  const notes = (prompts: string[]) => prompts.map((prompt) => (prompt.match(/\[Mousse\] Model change:/g) ?? []).length)

  it('adds the note to the next turn only, never for a level alone, and not again after a restart', async () => {
    const { main, home, prompts } = await start()
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' } })
    const thread = main.threads.createThread('Model note')
    const send = (content: string) => main.orchestrator.send({ content, mode: 'agent' }, false, { threadId: thread.id })
    await send('first')
    await send('same model')
    main.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'opus', effort: 'high' })
    await send('level only')
    main.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'sonnet' })
    await send("what's your opinion?")
    await send('after the switch')
    expect(notes(prompts)).toEqual([0, 0, 0, 1, 0])
    expect(prompts[3]).toMatch(/^\[Mousse\] Model change: you are now Claude Sonnet\. The earlier assistant replies in this thread were written by Claude Opus\.\n\nwhat's your opinion\?$/)
    // The person's message and the transcript keep only what they typed; the marker shows once.
    const messages = main.orchestrator.getMessages(thread.id)
    expect(messages.filter((message) => message.content.includes('[Mousse] Model change'))).toEqual([])
    expect(messages.filter((message) => message.kind === 'context_handoff')).toHaveLength(1)

    await main.stop()
    services.splice(services.indexOf(main), 1)
    vi.restoreAllMocks()
    const restarted = await start(home)
    await restarted.main.orchestrator.send({ content: 'after a restart', mode: 'agent' }, false, { threadId: thread.id })
    expect(notes(restarted.prompts)).toEqual([0])
  })

  it('lists both models after A → B → A', async () => {
    const { main, prompts } = await start()
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' } })
    const thread = main.threads.createThread('Back and forth')
    const send = (content: string) => main.orchestrator.send({ content, mode: 'agent' }, false, { threadId: thread.id })
    await send('one')
    main.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'sonnet' })
    await send('two')
    main.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'opus' })
    await send('three')
    expect(notes(prompts)).toEqual([0, 1, 1])
    expect(prompts[2]).toContain('you are now Claude Opus. The earlier assistant replies in this thread were written by Claude Opus and Claude Sonnet. The latest one was written by Claude Sonnet.\n\nthree')
  })

  it('gives the note to a queued turn that runs after the switch', async () => {
    const { main, prompts, hold } = await start()
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' } })
    const thread = main.threads.createThread('Queued')
    const send = (content: string) => main.orchestrator.send({ content, mode: 'agent' }, false, { threadId: thread.id })
    await send('first')
    let release!: () => void
    hold(new Promise<void>((resolve) => { release = resolve }))
    const running = send('second')
    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    main.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'sonnet' })
    const queued = await send('queued after the switch')
    expect(queued.queued).toBe(true)
    hold(Promise.resolve())
    release()
    await running
    await vi.waitFor(() => expect(prompts).toHaveLength(3), { timeout: 10_000 })
    expect(notes(prompts)).toEqual([0, 0, 1])
    expect(prompts[2]).toContain('you are now Claude Sonnet.')
    expect(prompts[2].endsWith('queued after the switch')).toBe(true)
  })
})
