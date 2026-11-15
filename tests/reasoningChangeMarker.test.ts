/**
 * A turn that runs at another reasoning level than the turn before it leaves one marker in the transcript, after the
 * person's message: where the change took effect. A model change at the same time is the same marker, not a second.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { turnMarker, turnMarkerText } from '../src/mms/orchestrator/contextHandoff'

const opus = { provider: 'claude-subscription', model: 'opus' }
const sonnet = { provider: 'claude-subscription', model: 'sonnet' }
/** A model whose agent reports `medium` as its default; a level it does not offer runs at the default. */
const levelOf = (selection: { effort?: string }): string | undefined =>
  selection.effort && ['low', 'medium', 'high'].includes(selection.effort) ? selection.effort : 'medium'

describe('turnMarker', () => {
  it.each([
    ['a level alone', { ...opus, effort: 'medium' }, { ...opus, effort: 'high' }, 'Reasoning: Medium → High'],
    ['the default to a chosen level', opus, { ...opus, effort: 'high' }, 'Reasoning: Medium → High'],
    ['a chosen level back to the default', { ...opus, effort: 'low' }, opus, 'Reasoning: Low → Medium'],
    ['a level packed into an older message\'s model', { provider: opus.provider, model: 'opus:low' }, { ...opus, effort: 'high' }, 'Reasoning: Low → High'],
    ['a model alone', { ...opus, effort: 'high' }, { ...sonnet, effort: 'high' }, 'Claude Opus → Claude Sonnet'],
    ['a model and a level at once', { ...opus, effort: 'low' }, { ...sonnet, effort: 'high' }, 'Claude Opus → Claude Sonnet']
  ])('marks %s', (_name, previous, next, text) => {
    const marker = turnMarker(previous, next, levelOf)
    expect(marker && turnMarkerText(marker)).toBe(text)
  })

  it('writes a changed level into both sides, and leaves the sides of a model change alone otherwise', () => {
    expect(turnMarker(opus, { ...sonnet, effort: 'high' }, levelOf)).toEqual({ from: { ...opus, effort: 'medium' }, to: { ...sonnet, effort: 'high' } })
    expect(turnMarker(opus, sonnet, levelOf)).toEqual({ from: opus, to: sonnet })
  })

  it.each([
    ['the same model and level', { ...opus, effort: 'high' }, { ...opus, effort: 'high' }],
    ['the default chosen by name', opus, { ...opus, effort: 'medium' }],
    ['a level the model does not offer, which runs at its default', opus, { ...opus, effort: 'max' }]
  ])('gives no marker for %s', (_name, previous, next) => {
    expect(turnMarker(previous, next, levelOf)).toBeUndefined()
  })

  it('compares the model alone when the previous level is not known, and gives a first turn no marker', () => {
    expect(turnMarker(opus, { ...opus, effort: 'high' })).toBeUndefined()
    expect(turnMarker(opus, { ...sonnet, effort: 'high' })).toEqual({ from: opus, to: { ...sonnet, effort: 'high' } })
    expect(turnMarker(undefined, { ...opus, effort: 'high' }, levelOf)).toBeUndefined()
  })
})

describe('a reasoning change in a thread', () => {
  const homes: string[] = []
  const services: MousseMainService[] = []
  afterEach(async () => {
    for (const service of services.splice(0)) await service.stop().catch(() => undefined)
    vi.restoreAllMocks()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  async function start() {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-reasoning-marker-'))
    homes.push(home)
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await main.start()
    services.push(main)
    const prompts: string[] = []
    vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
      prompts.push(input.prompt)
      input.onText(`Answer from ${input.model}`)
      return `Answer from ${input.model}`
    })
    main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' } })
    const thread = main.threads.createThread('Reasoning marker')
    const send = (content: string) => main.orchestrator.send({ content, mode: 'agent' }, false, { threadId: thread.id })
    const pick = (model: string, effort?: string) => main.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model, ...(effort ? { effort } : {}) })
    /** The transcript as a person reads it: each message's text, a marker as `[its text]`. */
    const transcript = () => main.threads.loadThreadData(thread.id).messages
      .filter((message) => !message.hidden && (message.role === 'user' || message.kind === 'context_handoff'))
      .map((message) => (message.kind === 'context_handoff' ? `[${message.content}]` : message.content))
    return { main, thread, prompts, send, pick, transcript }
  }

  it('is marked once, after the message whose turn runs at the new level, and the model is told nothing', async () => {
    const { prompts, send, pick, transcript } = await start()
    pick('opus', 'low')
    await send('first')
    await send('same level')
    pick('opus', 'high')
    // Picking a level changes nothing in the transcript until a turn runs at it.
    expect(transcript()).toEqual(['first', 'same level'])
    await send('at high')
    await send('still high')
    expect(transcript()).toEqual(['first', 'same level', 'at high', '[Reasoning: Low → High]', 'still high'])
    expect(prompts.join('\n')).not.toContain('Reasoning')
  })

  it("compares the levels the turns run at: the model's default chosen by name is no change", async () => {
    const { main, send, pick, transcript } = await start()
    vi.spyOn(main.claudeSubscription, 'models').mockReturnValue([
      { id: 'opus', label: 'Claude Opus', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }
    ])
    await send('at the default')
    pick('opus', 'medium')
    await send('the default by name')
    pick('opus', 'high')
    await send('at high')
    pick('opus')
    await send('back at the default')
    expect(transcript()).toEqual([
      'at the default', 'the default by name', 'at high', '[Reasoning: Medium → High]', 'back at the default', '[Reasoning: High → Medium]'
    ])
  })

  it('is one marker with a model change made at the same time', async () => {
    const { main, thread, send, pick, transcript } = await start()
    pick('opus', 'low')
    await send('first')
    pick('sonnet', 'high')
    await send('second')
    expect(transcript()).toEqual(['first', 'second', '[Claude Opus → Claude Sonnet]'])
    const [marker] = main.orchestrator.getMessages(thread.id).filter((message) => message.kind === 'context_handoff')
    expect(marker?.contextHandoff).toMatchObject({ from: { model: 'opus', effort: 'low' }, to: { model: 'sonnet', effort: 'high' } })
  })
})
