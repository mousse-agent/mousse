/**
 * Automatic thread naming's models: every connected model that can run a single request, ranked by the catalog's
 * naming providers, then tier, then a subscription, from what the snapshots already say. Usage limits (shared with
 * bots) are read when the index is read, so a reset that passes brings a model back without a new snapshot.
 */
import { describe, expect, it, vi } from 'vitest'
import { bundledModelCatalog } from '../src/mms/models/modelCatalog'
import { extractLimitFromError, SHORT_LIMIT_COOLDOWN_MS, UsageLimitTracker } from '../src/mms/models/usageLimits'
import { usageLimitError } from '../src/mms/orchestrator/providerErrors'
import { AppError } from '../src/shared/errors'
import { rankTitleModels, TitleModelCache, titleEffortFor, type TitleModelSource } from '../src/mms/orchestrator/TitleModelIndex'
import type { InstanceSnapshot } from '../src/shared/harness/status'
import { harnessAppError, type InstanceModel, type ProviderScope } from '../src/shared/harness/types'
import type { ModelCatalog } from '../src/shared/modelCatalog'
import { model, snapshot } from './providerSnapshotFixture'

const catalog = bundledModelCatalog()
const NOW = new Date('2026-11-20T10:00:00.000Z')

const claudeSnapshot = (patch: Parameters<typeof snapshot>[0] = {}) => snapshot({ auth: { credential: 'subscription' }, ...patch })
const codexSnapshot = () => snapshot({ instanceId: 'codex', driver: 'codex', auth: { credential: undefined } })
const agSnapshot = () => snapshot({ instanceId: 'antigravity', driver: 'antigravity', auth: { credential: 'subscription' } })
const piSnapshot = (instanceId: string, credential: 'api_key' | 'subscription' = 'api_key') => snapshot({ instanceId, driver: 'pi', auth: { credential } })

const LOW = { efforts: ['low', 'medium', 'high'], images: false }

const MODELS: Record<string, InstanceModel[]> = {
  claude: [
    model('default'),
    model('opus', { resolvedId: 'claude-opus-5-5', capabilities: LOW }),
    model('sonnet', { resolvedId: 'claude-sonnet-5-5', capabilities: LOW }),
    model('haiku', { resolvedId: 'claude-haiku-5-5', capabilities: LOW })
  ],
  codex: [model('default'), model('gpt-6.2-sol', { capabilities: LOW }), model('gpt-6-luna', { capabilities: LOW }), model('gpt-6.1-terra', { capabilities: LOW })],
  antigravity: [model('gemini-4-neon'), model('gemini-3.8-flash'), model('gemini-4-hydrogen')],
  'pi:anthropic': [model('claude-haiku-5-5', { capabilities: { efforts: ['low', 'high'], images: false, thinkingOff: true } })],
  'pi:openai': [model('gpt-6-luna')],
  'pi:groq': [model('llama-fast')],
  'pi:amazon-bedrock': [model('bedrock-model')],
  cursor: [model('cursor-model')],
  'opencode:opencode': [model('opencode/big-pickle')],
  grok: [model('grok-model')],
  'acp:other': [model('other-model')]
}

/** Admission as the gateway answers it for these fixtures: no hidden, unable or local server's model. */
function admitsListed(models: Record<string, InstanceModel[]>) {
  return (instanceId: string, id: string) => {
    const listed = (models[instanceId] ?? []).find((each) => each.id === id)
    return Boolean(listed) && !listed!.hidden && listed!.oneShot !== false && !listed!.local
  }
}

function rank(snapshots: InstanceSnapshot[], options: { models?: Record<string, InstanceModel[]>; admits?: (id: string, model: string) => boolean; catalog?: ModelCatalog } = {}) {
  const models = options.models ?? MODELS
  return rankTitleModels({
    snapshots,
    models: (instanceId) => models[instanceId] ?? [],
    admits: options.admits ?? admitsListed(models),
    catalog: options.catalog ?? catalog
  })
}
const ids = (candidates: Array<{ instanceId: string; model: string }>) => candidates.map((candidate) => `${candidate.instanceId}/${candidate.model}`)

describe('ranking', () => {
  it('held routes first (Claude, Codex, Pi by provider, Bedrock, Cursor, OpenCode), then Grok, Antigravity and any ACP agent; small models first within each', () => {
    const ranked = rank([
      snapshot({ instanceId: 'acp:other', driver: 'acp' as InstanceSnapshot['driver'] }),
      snapshot({ instanceId: 'grok', driver: 'grok' as InstanceSnapshot['driver'] }),
      snapshot({ instanceId: 'opencode:opencode', driver: 'opencode' as InstanceSnapshot['driver'] }),
      snapshot({ instanceId: 'cursor', driver: 'cursor' as InstanceSnapshot['driver'] }),
      piSnapshot('pi:amazon-bedrock'),
      piSnapshot('pi:groq'),
      piSnapshot('pi:openai'),
      piSnapshot('pi:anthropic'),
      agSnapshot(),
      codexSnapshot(),
      claudeSnapshot()
    ])
    expect(ids(ranked)).toEqual([
      'claude/haiku', 'claude/sonnet', 'claude/opus',
      'codex/gpt-6-luna', 'codex/gpt-6.1-terra', 'codex/gpt-6.2-sol',
      'pi:anthropic/claude-haiku-5-5',
      'pi:openai/gpt-6-luna',
      'pi:groq/llama-fast',
      // After the `pi` entry: its own entry wins over the broader one.
      'pi:amazon-bedrock/bedrock-model',
      'cursor/cursor-model',
      'opencode:opencode/opencode/big-pickle',
      'grok/grok-model',
      'antigravity/gemini-3.8-flash', 'antigravity/gemini-4-hydrogen', 'antigravity/gemini-4-neon',
      'acp:other/other-model'
    ])
  })

  it("an alias is ranked by the model it runs (Claude Code's haiku is small)", () => {
    const [first] = rank([claudeSnapshot()])
    expect(first).toMatchObject({ model: 'haiku', tier: 'small', credential: 'subscription', effort: 'low' })
    // An alias no pattern knows is ranked by the model it runs.
    const unresolved = rank([claudeSnapshot()], { models: { claude: [model('fast', { resolvedId: 'claude-haiku-5-5' }), model('claude-sonnet-5-5')] } })
    expect(unresolved.map((candidate) => [candidate.model, candidate.tier])).toEqual([['fast', 'small'], ['claude-sonnet-5-5', 'standard']])
  })

  it('tier comes before credential: a small model on an API key wins over a standard one on a subscription', () => {
    const ranked = rank([piSnapshot('pi:a', 'subscription'), piSnapshot('pi:b', 'api_key')], {
      models: { 'pi:a': [model('gpt-6.1-terra')], 'pi:b': [model('gpt-6-luna')] }
    })
    expect(ids(ranked)).toEqual(['pi:b/gpt-6-luna', 'pi:a/gpt-6.1-terra'])
    // Same tier: the subscription first.
    const same = rank([piSnapshot('pi:b', 'api_key'), piSnapshot('pi:a', 'subscription')], {
      models: { 'pi:a': [model('gpt-6-luna')], 'pi:b': [model('gpt-6-luna')] }
    })
    expect(ids(same)).toEqual(['pi:a/gpt-6-luna', 'pi:b/gpt-6-luna'])
  })

  it('a current model before an older one, then the newest release', () => {
    const ranked = rank([claudeSnapshot()], { models: { claude: [model('claude-haiku-4-5'), model('claude-haiku-5-5')] } })
    expect(ids(ranked)).toEqual(['claude/claude-haiku-5-5', 'claude/claude-haiku-4-5'])
  })

  it("the catalog's naming providers decide the order: a Pi provider by pi:<id>, the driver, then *", () => {
    const custom: ModelCatalog = { ...catalog, namingProviders: ['pi:openai', 'antigravity', '*'] }
    const ranked = rank([claudeSnapshot(), agSnapshot(), piSnapshot('pi:openai'), piSnapshot('pi:groq')], { catalog: custom })
    expect(ranked[0]).toMatchObject({ instanceId: 'pi:openai' })
    expect(ranked[1]).toMatchObject({ instanceId: 'antigravity', model: 'gemini-3.8-flash' })
    // Claude and pi:groq both fall to *: by tier there, a model of no known tier last.
    expect(ids(ranked.slice(4))).toEqual(['claude/haiku', 'claude/sonnet', 'claude/opus', 'pi:groq/llama-fast'])
  })

  it('leaves out entries that are not ready, locked bot entries, and every model admission does not admit', () => {
    const ranked = rank([
      claudeSnapshot({ instanceId: 'claude:off', enabled: { effective: false } }),
      claudeSnapshot({ instanceId: 'claude:out', auth: { state: 'signed_out' } }),
      claudeSnapshot({ instanceId: 'claude:stopped', runs: { state: 'no' } }),
      claudeSnapshot({ instanceId: 'claude:bots', config: { profile: 'locked' } as InstanceSnapshot['config'] }),
      claudeSnapshot({ instanceId: 'claude:agent' }),
      claudeSnapshot({ instanceId: 'claude:mixed' })
    ], {
      models: {
        'claude:off': [model('haiku')],
        'claude:out': [model('haiku')],
        'claude:stopped': [model('haiku')],
        'claude:bots': [model('haiku')],
        'claude:agent': [model('haiku')],
        'claude:mixed': [model('haiku', { hidden: true }), model('custom-agent-model', { oneShot: false }), model('sonnet')]
      },
      // Admission refuses the agent with no route, and on the mixed entry its hidden and unable models.
      admits: (id, modelId) => id !== 'claude:agent' && (id !== 'claude:mixed' || modelId === 'sonnet')
    })
    expect(ids(ranked)).toEqual(['claude:mixed/sonnet'])
  })

  it("'default' is asked only when the entry lists nothing else", () => {
    expect(ids(rank([codexSnapshot()], { models: { codex: [model('default')] } }))).toEqual(['codex/default'])
    expect(ids(rank([codexSnapshot()], { models: { codex: [model('default'), model('gpt-6.1-terra')] } }))).toEqual(['codex/gpt-6.1-terra'])
  })

  it('an entry whose models cannot be read is skipped', () => {
    const ranked = rankTitleModels({
      snapshots: [claudeSnapshot(), codexSnapshot()],
      models: (id) => { if (id === 'claude') throw new Error('gone'); return MODELS[id] ?? [] },
      admits: admitsListed(MODELS),
      catalog
    })
    expect(ranked[0]).toMatchObject({ instanceId: 'codex', model: 'gpt-6-luna' })
  })
})

describe('the level a naming request asks for', () => {
  it('Pi turns thinking off when it can, else the lowest level; Claude and Codex low; others their default', () => {
    expect(titleEffortFor('pi', model('m', { capabilities: { efforts: ['low', 'high'], images: false } }))).toBeUndefined()
    expect(titleEffortFor('pi', model('m', { capabilities: { efforts: ['medium', 'low', 'high'], images: false, thinkingOff: false } }))).toBe('low')
    expect(titleEffortFor('pi', model('m', { capabilities: { efforts: ['medium', 'high'], images: false, thinkingOff: false } }))).toBe('medium')
    expect(titleEffortFor('claude', model('m', { capabilities: LOW }))).toBe('low')
    expect(titleEffortFor('codex', model('m', { capabilities: { efforts: ['medium'], images: false } }))).toBeUndefined()
    expect(titleEffortFor('antigravity', model('m', { capabilities: LOW }))).toBeUndefined()
  })
})

/** A gateway as the index reads it, with every read counted. */
function gateway(snapshots: InstanceSnapshot[], options: { enabledIn?: (id: string, scope: ProviderScope) => boolean; hasRoute?: (id: string) => boolean } = {}) {
  let current = snapshots
  const listeners: Array<(event: { type: string; data?: unknown }) => void> = []
  const source = {
    cachedSnapshots: vi.fn(() => current),
    admitsOneShot: vi.fn(admitsListed(MODELS)),
    hasOneShotRoute: vi.fn(options.hasRoute ?? (() => true)),
    isEnabledInScope: vi.fn(options.enabledIn ?? (() => true)),
    catalog: { models: vi.fn((id: string) => MODELS[id] ?? []) },
    instances: {
      snapshots: vi.fn(async () => current),
      subscribe: vi.fn((listener: (event: { type: string; data?: unknown }) => void) => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1) })
    },
    oneShot: vi.fn()
  }
  return {
    source,
    set(next: InstanceSnapshot[], scope: ProviderScope = { kind: 'device' }) {
      current = next
      for (const listener of [...listeners]) listener({ type: 'snapshots', data: { scope, snapshots: next } })
    },
    listeners
  }
}

describe('the cached index', () => {
  it('is rebuilt on device snapshots events only, and reading it asks no provider', () => {
    const g = gateway([])
    const updated = vi.fn()
    const cache = new TitleModelCache({ usageLimits: new UsageLimitTracker(), catalog: () => catalog, onSnapshotsUpdated: updated })
    cache.attach(g.source as unknown as TitleModelSource)
    expect(cache.candidates()).toEqual([])
    g.set([claudeSnapshot()], { kind: 'project', projectId: 'p1' })
    expect(updated).not.toHaveBeenCalled()
    g.set([claudeSnapshot()])
    expect(updated).toHaveBeenCalledTimes(1)
    const reads = g.source.cachedSnapshots.mock.calls.length
    for (let i = 0; i < 5; i++) expect(cache.candidates()[0]).toMatchObject({ instanceId: 'claude', model: 'haiku' })
    expect(g.source.cachedSnapshots.mock.calls.length).toBe(reads)
    expect(g.source.instances.snapshots).not.toHaveBeenCalled()
    expect(g.source.oneShot).not.toHaveBeenCalled()
    cache.detach()
    expect(g.listeners).toHaveLength(0)
  })

  it('a project that turns an entry off reads the next one', () => {
    const g = gateway([claudeSnapshot(), codexSnapshot()], { enabledIn: (id, scope) => !(id === 'claude' && scope.kind === 'project') })
    const cache = new TitleModelCache({ usageLimits: new UsageLimitTracker(), catalog: () => catalog })
    cache.attach(g.source as unknown as TitleModelSource)
    expect(cache.candidates({ kind: 'device' })[0]).toMatchObject({ instanceId: 'claude' })
    expect(cache.candidates({ kind: 'project', projectId: 'p1' })[0]).toMatchObject({ instanceId: 'codex', model: 'gpt-6-luna' })
  })

  it('a stub gateway (no cached snapshots or single-request check) gives an empty index and nothing pending', () => {
    const cache = new TitleModelCache({ usageLimits: new UsageLimitTracker() })
    cache.attach({ oneShot: vi.fn() } as unknown as TitleModelSource)
    expect(cache.candidates()).toEqual([])
    expect(cache.hasPendingProbe()).toBe(false)
    cache.attach(undefined)
    expect(cache.candidates()).toEqual([])
  })
})

describe('usage limits', () => {
  function cacheWith(limits: UsageLimitTracker, snapshots: InstanceSnapshot[] = [claudeSnapshot(), agSnapshot()]) {
    const g = gateway(snapshots)
    const cache = new TitleModelCache({ usageLimits: limits, catalog: () => catalog })
    cache.attach(g.source as unknown as TitleModelSource)
    return { cache, g }
  }

  it("an Antigravity model's quota holds that model alone; the reset brings it back with no new snapshot", () => {
    const limits = new UsageLimitTracker()
    const { cache, g } = cacheWith(limits, [agSnapshot()])
    const error = harnessAppError({ code: 'rate_limited', message: 'Quota reached for this model.', scope: 'model', resetAt: '2026-11-20T10:30:00.000Z' })
    const limit = extractLimitFromError(error, NOW)
    expect(limit).toEqual({ until: '2026-11-20T10:30:00.000Z', scope: 'model' })
    limits.markModelLimited('antigravity', 'gemini-3.8-flash', limit!.until)
    expect(ids(cache.candidates(undefined, NOW))).toEqual(['antigravity/gemini-4-hydrogen', 'antigravity/gemini-4-neon'])
    const builds = g.source.cachedSnapshots.mock.calls.length
    expect(ids(cache.candidates(undefined, new Date('2026-11-20T10:30:01.000Z')))[0]).toBe('antigravity/gemini-3.8-flash')
    expect(g.source.cachedSnapshots.mock.calls.length).toBe(builds)
  })

  it('a plan limit holds the whole entry until its reported reset', () => {
    vi.useFakeTimers({ now: NOW })
    try {
      const limits = new UsageLimitTracker()
      const { cache } = cacheWith(limits)
      const error = usageLimitError({ provider: 'anthropic', resetsAt: '2026-11-20T12:00:00.000Z', estimated: false, limitKind: 'five_hour' })
      const limit = extractLimitFromError(error, NOW)
      expect(limit).toEqual({ until: '2026-11-20T12:00:00.000Z', scope: 'instance' })
      limits.markInstanceLimited('claude', limit!.until)
      expect(cache.candidates(undefined, NOW).every((candidate) => candidate.instanceId === 'antigravity')).toBe(true)
      // The same limit wrapped in the gateway's rate_limited error reads the same.
      const wrapped = new AppError({ code: 'rate_limited', message: 'Usage limit.', errorInfo: { category: 'unavailable', retryable: true } }, error)
      expect(extractLimitFromError(wrapped, NOW)).toEqual({ until: '2026-11-20T12:00:00.000Z', scope: 'instance' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a guessed reset holds for the short cooldown only, not the five-hour estimate', () => {
    const error = usageLimitError({ provider: 'anthropic', estimated: true })
    expect(extractLimitFromError(error, NOW)).toEqual({ until: new Date(NOW.getTime() + SHORT_LIMIT_COOLDOWN_MS).toISOString(), scope: 'instance' })
    expect(SHORT_LIMIT_COOLDOWN_MS).toBe(2 * 60_000)
    // Too many requests now: the whole entry, for the cooldown, and only the feature that met it (`transient`).
    const cooldown = { until: new Date(NOW.getTime() + SHORT_LIMIT_COOLDOWN_MS).toISOString(), scope: 'instance', transient: true }
    expect(extractLimitFromError(harnessAppError({ code: 'rate_limited', message: 'Slow down.' }), NOW)).toEqual(cooldown)
    expect(extractLimitFromError(new AppError({ code: 'provider_rate_limited', message: 'Slow down.', errorInfo: { category: 'unavailable', retryable: true } }), NOW)).toEqual(cooldown)
  })

  it("Claude's weekly Opus window holds that model alone: Haiku still names threads", () => {
    vi.useFakeTimers({ now: NOW })
    try {
      const limits = new UsageLimitTracker()
      const { cache } = cacheWith(limits, [claudeSnapshot()])
      const error = usageLimitError({ provider: 'anthropic', resetsAt: '2026-11-23T00:00:00.000Z', estimated: false, limitKind: 'seven_day_opus' })
      const limit = extractLimitFromError(error, NOW)
      expect(limit).toMatchObject({ scope: 'model' })
      limits.markModelLimited('claude', 'opus', limit!.until)
      expect(ids(cache.candidates(undefined, NOW))).toEqual(['claude/haiku', 'claude/sonnet'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failure that is not a limit marks nothing', () => {
    expect(extractLimitFromError(new Error('offline'), NOW)).toBeUndefined()
    expect(extractLimitFromError(harnessAppError({ code: 'timeout', message: 'Too slow.' }), NOW)).toBeUndefined()
  })

  it("the owner's Resume clears the entry and each of its models; a later reset already held wins", () => {
    const limits = new UsageLimitTracker()
    limits.markInstanceLimited('claude', '2026-11-20T12:00:00.000Z')
    limits.markInstanceLimited('claude', '2026-11-20T11:00:00.000Z')
    expect(limits.limitUntil('claude', undefined, NOW)).toBe('2026-11-20T12:00:00.000Z')
    limits.markModelLimited('claude', 'opus', '2026-11-20T13:00:00.000Z')
    limits.markModelLimited('antigravity', 'gemini-4-neon', '2026-11-20T13:00:00.000Z')
    expect(limits.limitUntil('claude', 'opus', NOW)).toBe('2026-11-20T13:00:00.000Z')
    expect(limits.limitUntil('claude', 'haiku', NOW)).toBe('2026-11-20T12:00:00.000Z')
    limits.clearInstance('claude')
    expect(limits.isLimited('claude', 'opus', NOW)).toBe(false)
    expect(limits.isLimited('claude', 'haiku', NOW)).toBe(false)
    expect(limits.isLimited('antigravity', 'gemini-4-neon', NOW)).toBe(true)
    expect([...limits.limitedInstances(NOW).keys()]).toEqual([])
  })
})

describe('an entry not checked yet', () => {
  function pending(snapshots: InstanceSnapshot[], options: Parameters<typeof gateway>[1] = {}) {
    const g = gateway(snapshots, options)
    const cache = new TitleModelCache({ usageLimits: new UsageLimitTracker(), catalog: () => catalog })
    cache.attach(g.source as unknown as TitleModelSource)
    return cache
  }
  const unchecked = (patch: Parameters<typeof snapshot>[0] = {}) => claudeSnapshot({ checkedAt: undefined, runs: { state: 'unknown' }, auth: { state: 'unknown' }, ...patch })

  it('is pending until its first check ends, however it ends', () => {
    expect(pending([unchecked()]).hasPendingProbe()).toBe(true)
    // Not installed, or a failed sign-in check: checked, so not pending.
    expect(pending([unchecked({ checkedAt: '2026-11-20T09:59:00.000Z', runs: { state: 'no', failure: 'not_on_path' } })]).hasPendingProbe()).toBe(false)
    expect(pending([unchecked({ checkedAt: '2026-11-20T09:59:00.000Z', runs: { state: 'yes' }, auth: { state: 'signed_out' } })]).hasPendingProbe()).toBe(false)
  })

  it('an entry that is off, a locked bot entry, one with no single requests, or off in the project is never pending', () => {
    expect(pending([unchecked({ enabled: { effective: false } })]).hasPendingProbe()).toBe(false)
    expect(pending([unchecked({ config: { profile: 'locked' } as InstanceSnapshot['config'] })]).hasPendingProbe()).toBe(false)
    expect(pending([unchecked()], { hasRoute: () => false }).hasPendingProbe()).toBe(false)
    const project: ProviderScope = { kind: 'project', projectId: 'p1' }
    expect(pending([unchecked()], { enabledIn: (_id, scope) => scope.kind === 'device' }).hasPendingProbe(project)).toBe(false)
  })
})
