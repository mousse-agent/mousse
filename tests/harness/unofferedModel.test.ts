/**
 * A stored selection whose model its provider no longer offers (`replacementFor`): it moves to the
 * model the runtime ranks first that is listed and shown, keeping its context, speed and reasoning
 * level only where that model has them. Nothing moves on any other standing. Fake runtimes only.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ProviderAdapter, TurnResult } from '../../src/mms/harness/adapter'
import type { ModelStanding } from '../../src/mms/harness/driver'
import { CODEX_CAPABILITIES } from '../../src/mms/harness/drivers/codex/adapter'
import type { Harness } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import type { LlmModelOption } from '../../src/shared/settings'

const agent: ProviderAdapter = {
  driver: 'claude',
  capabilities: CODEX_CAPABILITIES,
  startTurn: async (): Promise<TurnResult> => { throw new Error('no turns here') },
  interrupt: async () => 'not_active'
}

const homes: string[] = []
const harnesses: Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const LISTED: LlmModelOption[] = [
  { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'high'] },
  { id: 'opus[1m]', label: 'Opus 5.5 (1M)', efforts: ['low', 'high'] },
  { id: 'sonnet', label: 'Sonnet 5.5', efforts: ['low', 'medium', 'high', 'max'] },
  { id: 'nova-5', label: 'Nova 5', efforts: ['low'] },
  { id: 'nova-5:fast', label: 'Nova 5 (fast)', efforts: ['low'] }
]

function fixture(standing: (model: string) => ModelStanding, listed: LlmModelOption[] = LISTED) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-unoffered-'))
  homes.push(home)
  let stored: Record<string, unknown> = { claude: { driver: 'claude', enabled: true } }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances as Record<string, unknown> } } })
  const harness = testHarness({
    drivers: [adapterDriver(agent, { runtime: { models: () => listed, modelStanding: standing } })],
    instances,
    profileHome: home
  })
  harnesses.push(harness)
  return harness
}

const pinned = (model: string, effort?: string) => ({ instanceId: 'claude', llmProvider: 'claude-subscription', model, ...(effort ? { effort } : {}) })

it('moves to the first ranked model, keeping a reasoning level it takes and dropping one it does not', () => {
  const harness = fixture(() => ({ standing: 'not_offered', instead: ['opus', 'opus[1m]', 'sonnet'] }))
  expect(harness.replacementFor(pinned('claude-opus-4-6', 'high'))).toEqual({ instead: { model: 'opus', effort: 'high' } })
  expect(harness.replacementFor(pinned('claude-opus-4-6', 'max'))).toEqual({ instead: { model: 'opus' } })
  // A level packed into the model by an older Mousse counts the same.
  expect(harness.replacementFor(pinned('claude-opus-4-6:low'))).toEqual({ instead: { model: 'opus', effort: 'low' } })
})

it('keeps a 1M context and a fast speed only where the new model lists them', () => {
  const harness = fixture((model) => ({ standing: 'not_offered', instead: model.startsWith('nova') ? ['nova-5'] : model.startsWith('haiku') ? ['sonnet'] : ['opus', 'opus[1m]'] }))
  expect(harness.replacementFor(pinned('claude-opus-4-6[1m]', 'high'))).toEqual({ instead: { model: 'opus[1m]', effort: 'high' } })
  expect(harness.replacementFor(pinned('claude-opus-4-6@1m'))).toEqual({ instead: { model: 'opus[1m]' } })
  // No fast Opus is listed: the context stays, the speed goes.
  expect(harness.replacementFor(pinned('claude-opus-4-6@1m:fast'))).toEqual({ instead: { model: 'opus[1m]' } })
  expect(harness.replacementFor(pinned('nova-4:fast', 'low'))).toEqual({ instead: { model: 'nova-5:fast', effort: 'low' } })
  expect(harness.replacementFor(pinned('nova-4', 'low'))).toEqual({ instead: { model: 'nova-5', effort: 'low' } })
  // Sonnet has no 1M variant listed.
  expect(harness.replacementFor(pinned('haiku-old[1m]', 'medium'))).toEqual({ instead: { model: 'sonnet', effort: 'medium' } })
})

it('skips hidden models, and has none to offer when every ranked model is hidden or the list is empty', async () => {
  const harness = fixture(() => ({ standing: 'not_offered', instead: ['opus', 'sonnet'] }))
  await harness.instances.setModelPrefs('claude', { hidden: ['opus'] })
  expect(harness.replacementFor(pinned('claude-opus-4-6'))).toEqual({ instead: { model: 'sonnet' } })
  await harness.instances.setModelPrefs('claude', { hidden: ['opus', 'sonnet'] })
  expect(harness.replacementFor(pinned('claude-opus-4-6'))).toEqual({})
  const empty = fixture(() => ({ standing: 'not_offered', instead: [] }), [])
  expect(empty.replacementFor(pinned('claude-opus-4-6'))).toEqual({})
})

it('leaves an offered or unknown model, a hidden one and one the user added as they are', async () => {
  const harness = fixture((model) => (model === 'opus' ? { standing: 'offered' } : model === 'claude-opus-4-6' ? { standing: 'unknown' } : { standing: 'not_offered', instead: ['opus'] }))
  expect(harness.replacementFor(pinned('opus'))).toBeUndefined()
  expect(harness.replacementFor(pinned('claude-opus-4-6'))).toBeUndefined()
  expect(harness.replacementFor(pinned('claude-opus-4-1'))).toEqual({ instead: { model: 'opus' } })
  // A hidden model keeps refusing as hidden.
  await harness.instances.setModelPrefs('claude', { hidden: ['claude-opus-4-1'] })
  expect(harness.replacementFor(pinned('claude-opus-4-1'))).toBeUndefined()
  expect(() => harness.resolveStored(pinned('claude-opus-4-1'), { purpose: 'turn' })).toThrow(expect.objectContaining({ code: 'model_hidden' }))
  await harness.instances.setModelPrefs('claude', { hidden: [], custom: [{ id: 'claude-opus-4-1', label: 'Mine', capabilities: { efforts: [], images: false } }] })
  expect(harness.replacementFor(pinned('claude-opus-4-1'))).toBeUndefined()
})
