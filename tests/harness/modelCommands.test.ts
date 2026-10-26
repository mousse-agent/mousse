/**
 * `/model` in channels and the interactive CLI lists the profile's models through the gateway's
 * view: hidden models and disabled instances are not offered, so they cannot be picked.
 */
import { describe, expect, it } from 'vitest'
import { handleInteractiveSlash, type InteractiveCommandContext } from '../../src/cli/interactive/sessionCommands'
import { dispatchSlashCommand, type SlashContext } from '../../src/mms/channels/slash/handlers'
import { parseSlashCommand } from '../../src/mms/channels/slash/parse'
import { piInstanceId, piProviderIdOf } from '../../src/shared/providerInstances'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderAdapter } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import type { LlmProviderOption } from '../../src/shared/settings'

const pi = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
const claude: ProviderAdapter = { driver: 'claude', capabilities: pi.capabilities, configured: () => true, startTurn: async () => { throw new Error('unused') }, interrupt: async () => 'not_active' }

/** A profile with OpenAI (one hidden model), a disabled Anthropic pi instance and Claude Code. */
async function profile() {
  const piProviders: LlmProviderOption[] = [
    { id: 'openai', label: 'OpenAI', models: [{ id: 'gpt-a', label: 'GPT A' }, { id: 'gpt-hidden', label: 'GPT Hidden' }] },
    { id: 'anthropic', label: 'Anthropic', models: [{ id: 'claude-x', label: 'Claude X' }] }
  ]
  let stored: unknown = { 'pi:anthropic': { driver: 'pi', enabled: false } }
  let seedVersion: number | undefined
  const instances = new ProviderInstanceService({
    store: { read: () => ({ instances: stored, seedVersion }), write: (next) => { stored = next.instances; seedVersion = next.seedVersion } },
    providerAuth: { getConfiguredLlmProviders: () => piProviders, credentials: { listProviderIds: () => ['openai', 'anthropic'] } }
  })
  const harness = testHarness({
    drivers: [
      adapterDriver(pi),
      adapterDriver(claude, { runtime: { llmProvider: () => ({ id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] }) } })
    ],
    instances
  })
  await harness.instances.setModelPrefs(piInstanceId('openai'), { hidden: ['gpt-hidden'] })
  await harness.instances.setModelPrefs('claude', { hidden: ['opus'] })
  return { harness, instances }
}

function channelContext(listModels: () => LlmProviderOption[], text: string) {
  const parsed = parseSlashCommand(text)!
  const overrides: Array<unknown> = []
  const session = { sessionKey: 's', platform: 'telegram', chatId: 'c' }
  const ctx = {
    message: { platform: 'telegram', chatId: 'c', text },
    session,
    args: parsed.args,
    parsed,
    sessionManager: { getSession: () => session, setModelOverride: (_key: string, value: unknown) => overrides.push(value) },
    settings: { get: () => ({ provider: { llmProvider: 'openai', model: 'gpt-a' } }), set: () => {} },
    listModels,
    bumpGeneration: () => 1,
    getGeneration: () => 1
  } as unknown as SlashContext
  return { ctx, overrides }
}

function cliContext(listModels: () => LlmProviderOption[]) {
  const overrides: unknown[] = []
  const ctx: InteractiveCommandContext = {
    state: { threadId: null },
    listThreads: () => [],
    listModels,
    getGlobalModel: () => ({ llmProvider: 'openai', model: 'gpt-a' }),
    setGlobalModel: () => {},
    getContextUsage: () => null,
    isTurnActive: () => false,
    abortTurn: () => false,
    steerTurn: () => false,
    bindThread: () => {},
    setModelOverride: (value) => overrides.push(value)
  }
  return { ctx, overrides }
}

describe('/model honours hidden models and disabled instances', () => {
  it('the picker listing leaves them out and adds nothing hidden', async () => {
    const { instances } = await profile()
    const listing = instances.llmProviders()
    expect(listing.map((option) => [option.instanceId, option.models.map((model) => model.id)])).toEqual([
      ['pi:openai', ['gpt-a']],
      ['claude', ['sonnet']]
    ])
  })

  it('channel /model cannot select a hidden model or a disabled instance', async () => {
    const { instances } = await profile()
    // The profile's channel listing (MmsProfileServices): pi-ai providers through the instance view.
    const listModels = () => instances.llmProviders().filter((option) => option.instanceId && piProviderIdOf(option.instanceId))
    for (const name of ['gpt-hidden', 'claude-x']) {
      const { ctx, overrides } = channelContext(listModels, `/model ${name}`)
      const result = await dispatchSlashCommand(ctx)
      expect(result.reply, name).toMatch(/Model not found/)
      expect(overrides).toEqual([])
    }
    const { ctx, overrides } = channelContext(listModels, '/model gpt-a')
    expect((await dispatchSlashCommand(ctx)).reply).toMatch(/Session model set to openai\/gpt-a/)
    expect(overrides).toEqual([{ instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-a' }])
    expect(JSON.stringify(listModels())).not.toMatch(/gpt-hidden|claude-x/)
  })

  it('CLI /models cannot select a hidden model or a disabled instance', async () => {
    const { instances } = await profile()
    // `settings.getOptions().llmProviders` is `providerInstances.llmProviders()`.
    const listModels = () => instances.llmProviders()
    for (const name of ['gpt-hidden', 'claude-x', 'opus']) {
      const { ctx, overrides } = cliContext(listModels)
      expect(handleInteractiveSlash(`/models ${name}`, ctx).reply, name).toMatch(/Model not found/)
      expect(overrides).toEqual([])
    }
    const { ctx, overrides } = cliContext(listModels)
    expect(handleInteractiveSlash('/models sonnet', ctx).reply).toMatch(/claude-subscription\/sonnet/)
    expect(overrides).toEqual([{ instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' }])
  })

  it('two Claude instances: /model selects by instance, with each instance\'s own enabled state and catalog', async () => {
    let stored: unknown = {
      claude: { driver: 'claude', enabled: false },
      'claude:work': { driver: 'claude', enabled: true, config: { displayName: 'Work' } }
    }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const base = adapterDriver(claude)
    const catalogs: Record<string, string[]> = { claude: ['opus', 'sonnet'], 'claude:work': ['work-only', 'sonnet'] }
    const harness = testHarness({
      drivers: [adapterDriver(pi), {
        ...base,
        create: (context) => ({
          ...base.create(context),
          llmProvider: () => ({ id: 'claude-subscription', label: 'Claude Code', models: catalogs[context.instanceId]!.map((id) => ({ id, label: id })) })
        })
      }],
      instances
    })
    const listModels = () => instances.llmProviders()
    // Only the enabled Work instance is offered, under its own id.
    expect(listModels().map((option) => [option.instanceId, option.models.map((model) => model.id)])).toEqual([['claude:work', ['work-only', 'sonnet']]])
    const cli = cliContext(listModels)
    expect(handleInteractiveSlash('/models work-only', cli.ctx).reply).toMatch(/claude-subscription\/work-only/)
    expect(cli.overrides).toEqual([{ instanceId: 'claude:work', llmProvider: 'claude-subscription', model: 'work-only' }])
    expect(handleInteractiveSlash('/models opus', cliContext(listModels).ctx).reply).toMatch(/Model not found/)
    const channel = channelContext(listModels, '/model work-only')
    await dispatchSlashCommand(channel.ctx)
    expect(channel.overrides).toEqual([{ instanceId: 'claude:work', llmProvider: 'claude-subscription', model: 'work-only' }])
    // The selection resolves to Work, not the disabled built-in instance.
    expect(harness.resolve({ instanceId: 'claude:work', model: 'work-only' }, { kind: 'device' }, 'cli_model').selection.instanceId).toBe('claude:work')

    // Both enabled: a model both list goes to the instance already selected, and both are listed apart.
    await harness.instances.setEnabled('claude', { kind: 'device' }, true)
    expect(listModels().map((option) => option.instanceId)).toEqual(['claude', 'claude:work'])
    const current = cliContext(listModels)
    current.ctx.getGlobalModel = () => ({ instanceId: 'claude:work', llmProvider: 'claude-subscription', model: 'work-only' })
    handleInteractiveSlash('/models sonnet', current.ctx)
    expect(current.overrides).toEqual([{ instanceId: 'claude:work', llmProvider: 'claude-subscription', model: 'sonnet' }])
    expect(handleInteractiveSlash('/models', current.ctx).reply).toMatch(/\(claude:work\):\n {2}work-only \*/)
    expect(harness.configuredProviderIds()).toEqual(['claude-subscription'])

    // Either account by its instance, from any current selection; a bare shared model asks which.
    const other = cliContext(listModels)
    const listed = handleInteractiveSlash('/models', other.ctx).reply
    expect(listed).toContain('sonnet  (/model claude/sonnet)')
    expect(listed).toContain('sonnet  (/model claude:work/sonnet)')
    expect(listed).toMatch(/\n {2}opus\n/)
    expect(handleInteractiveSlash('/models sonnet', other.ctx).reply).toBe('More than one provider lists `sonnet`. Name the instance:\n  /model claude/sonnet\n  /model claude:work/sonnet')
    expect(other.overrides).toEqual([])
    expect(handleInteractiveSlash('/model claude:work/sonnet', other.ctx).reply).toBe('Session model set to claude-subscription/sonnet (claude:work)')
    expect(handleInteractiveSlash('/model claude sonnet', other.ctx).reply).toBe('Session model set to claude-subscription/sonnet (claude)')
    expect(handleInteractiveSlash('/model claude:work/opus', other.ctx).reply).toMatch(/Model not found/)
    // A model only one instance lists needs no instance.
    expect(handleInteractiveSlash('/model opus', other.ctx).reply).toBe('Session model set to claude-subscription/opus (claude)')
    expect(other.overrides).toEqual([
      { instanceId: 'claude:work', llmProvider: 'claude-subscription', model: 'sonnet' },
      { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' },
      { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'opus' }
    ])
  })

  it('resolve() rejects them for the /model purposes too', async () => {
    const { harness } = await profile()
    expect(() => harness.resolve({ instanceId: 'pi:openai', model: 'gpt-hidden' }, { kind: 'device' }, 'channel_model')).toThrow(/hidden/)
    expect(() => harness.resolve({ instanceId: 'pi:anthropic', model: 'claude-x' }, { kind: 'device' }, 'cli_model')).toThrow(/disabled/)
  })
})
