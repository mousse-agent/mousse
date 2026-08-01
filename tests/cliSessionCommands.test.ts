import { describe, expect, it, vi } from 'vitest'
import {
  handleInteractiveSlash,
  type InteractiveCommandContext,
  type InteractiveSessionState
} from '../src/cli/interactive/sessionCommands'
import type { LlmProviderOption } from '../src/shared/settings'

function makeCtx(overrides?: Partial<InteractiveCommandContext>): InteractiveCommandContext {
  const state: InteractiveSessionState = {
    threadId: 'aaaaaaaa-1111-2222-3333-444444444444',
    modelOverride: undefined
  }
  const models: LlmProviderOption[] = [
    {
      id: 'openai',
      label: 'OpenAI',
      models: [
        { id: 'gpt-4o', label: 'GPT-4o' },
        { id: 'gpt-4o-mini', label: 'GPT-4o mini' }
      ]
    }
  ]
  const base: InteractiveCommandContext = {
    state,
    listThreads: () => [
      { id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'Main' },
      { id: 'bbbbbbbb-1111-2222-3333-444444444444', name: 'Side' }
    ],
    listModels: () => models,
    getGlobalModel: () => ({ llmProvider: 'openai', model: 'gpt-4o-mini' }),
    setGlobalModel: vi.fn(),
    isTurnActive: () => false,
    abortTurn: () => false,
    steerTurn: vi.fn(() => false),
    bindThread: vi.fn((id: string) => {
      state.threadId = id
    }),
    setModelOverride: vi.fn((override) => {
      state.modelOverride = override
    })
  }
  return { ...base, ...overrides, state: overrides?.state ?? state }
}

describe('handleInteractiveSlash', () => {
  it('lists and selects threads', () => {
    const ctx = makeCtx()
    const listed = handleInteractiveSlash('/threads', ctx)
    expect(listed.handled).toBe(true)
    expect(listed.reply).toContain('Main')
    expect(listed.reply).toContain(' *')

    const selected = handleInteractiveSlash('/thread 2', ctx)
    expect(selected.reply).toMatch(/Selected thread bbbbbbbb/)
    expect(ctx.bindThread).toHaveBeenCalledWith('bbbbbbbb-1111-2222-3333-444444444444')
  })

  it('lists models with current marker and sets session override', () => {
    const ctx = makeCtx()
    const listed = handleInteractiveSlash('/models', ctx)
    expect(listed.reply).toContain('gpt-4o-mini *')
    expect(listed.reply).toContain('Available models')

    const set = handleInteractiveSlash('/model gpt-4o --session', ctx)
    expect(set.reply).toContain('Session model set to openai/gpt-4o')
    expect(ctx.setModelOverride).toHaveBeenCalledWith({
      llmProvider: 'openai',
      model: 'gpt-4o'
    })
  })

  it('steers when local or peer turn accepts; reports no turn otherwise', () => {
    const inactiveSteer = vi.fn(() => false)
    const inactive = makeCtx({ isTurnActive: () => false, steerTurn: inactiveSteer })
    const miss = handleInteractiveSlash('/steer focus tests', inactive)
    expect(miss.reply).toMatch(/No active turn/)
    // Always attempt steer (local + cross-process durable intent path).
    expect(inactiveSteer).toHaveBeenCalledWith('focus tests')

    const steerTurn = vi.fn(() => true)
    const active = makeCtx({ isTurnActive: () => true, steerTurn })
    const hit = handleInteractiveSlash('/steer focus tests', active)
    expect(hit.reply).toContain('Steered: focus tests')
    expect(steerTurn).toHaveBeenCalledWith('focus tests')
  })

  it('handles /stop and /exit', () => {
    const abortTurn = vi.fn(() => true)
    const ctx = makeCtx({ abortTurn })
    expect(handleInteractiveSlash('/stop', ctx).reply).toMatch(/Stop requested/)
    expect(abortTurn).toHaveBeenCalled()

    const exit = handleInteractiveSlash('/exit', ctx)
    expect(exit.exit).toBe(true)
  })

  it('ignores non-slash input', () => {
    const ctx = makeCtx()
    expect(handleInteractiveSlash('hello', ctx).handled).toBe(false)
  })
})
