import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { dispatchMethod } from '../src/mms/protocol/handlers'

/** `threads.setModel` and the default selection, through the protocol (SPEC §13.8). */
describe('provider selection over the protocol', () => {
  let home: string
  let main: MousseMainService
  let context: Parameters<typeof dispatchMethod>[0]

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-provider-selection-'))
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    context = { mms: main, globalSequence: () => 0, emitEvent: vi.fn() } as never
  })

  afterEach(async () => {
    await main.stop()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  })

  const setModel = (threadId: string, model: unknown) => dispatchMethod(context, 'threads.setModel', { threadId, model }) as Promise<{ modelOverride: unknown }>

  it('accepts the Codex model the GUI lists by provider id, and stores its instance', async () => {
    const thread = main.threads.createThread('codex')
    const result = await setModel(thread.id, { llmProvider: 'codex', model: 'gpt-5.5' })
    // The selection carries the model's name, for screens and devices with no listing of it.
    expect(result.modelOverride).toEqual({ instanceId: 'codex', llmProvider: 'codex', model: 'gpt-5.5', name: 'GPT-5.5' })
    expect(main.threads.getThread(thread.id)?.modelOverride).toEqual({ instanceId: 'codex', llmProvider: 'codex', model: 'gpt-5.5', name: 'GPT-5.5' })
    await expect(setModel(thread.id, { llmProvider: 'not-a-provider', model: 'x' })).rejects.toMatchObject({ code: 'provider_instance_unknown' })
  })

  it('keeps the instance in the global default, and drops it when a later default names only a provider', async () => {
    const thread = main.threads.createThread('claude')
    await setModel(thread.id, { instanceId: 'claude', model: 'sonnet' })
    expect(main.settings.get().provider).toMatchObject({ instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    // New threads start from the default with its instance.
    const created = await dispatchMethod(context, 'threads.create', { name: 'next' }) as { thread: { modelOverride?: unknown } }
    expect(created.thread.modelOverride).toEqual({ instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet', name: 'Claude Sonnet' })
    main.settings.set({ provider: { llmProvider: 'openai', model: 'gpt-x' } })
    expect(main.settings.get().provider.instanceId).toBeUndefined()
    // Nor does it keep the earlier model's name.
    expect(main.settings.get().provider.name).toBeUndefined()
  })

  it('validates a supplied llmProvider even when the instance decides the stored value', async () => {
    const thread = main.threads.createThread('validate')
    await expect(setModel(thread.id, { instanceId: 'claude', llmProvider: 123, model: 'sonnet' })).rejects.toThrow(/model.llmProvider/)
    await expect(setModel(thread.id, { instanceId: 'claude', llmProvider: 'stale', model: 'sonnet' })).resolves.toMatchObject({
      modelOverride: { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' }
    })
  })
})
