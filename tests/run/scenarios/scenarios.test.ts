/**
 * SPEC §13.6/§13.7: every scenario runs against every adapter that has a fixture for it, through a
 * real orchestrator, Run Engine and effect worker, with the provider replayed at its boundary.
 */
import { describe, expect, it } from 'vitest'
import { readTranscript } from '../../../src/mms/run/testkit/ReplayTransport'
import { SCENARIOS } from './index'
import { FIXTURES_DIR, fixtureAdapters, runScenario } from './runScenario'
import { join } from 'node:path'

const ADAPTERS = ['acp', 'antigravity', 'claude-subscription', 'codex', 'cursor', 'pi', 'pi-rpc']

// A scenario may declare a subset of adapters (`delegate-child` is pi-only: vendor runtimes get no
// ToolHost until Phase 5).
describe.each(Object.keys(SCENARIOS))('scenario %s', (name) => {
  const adapters = fixtureAdapters(name)

  it('has a fixture for every adapter, each naming its boundary', () => {
    expect(adapters).toEqual(SCENARIOS[name].adapters ?? ADAPTERS)
    for (const adapter of adapters) {
      const { header } = readTranscript(join(FIXTURES_DIR, name, `${adapter}.ndjson`))
      expect(header).toMatchObject({ kind: 'transcript', adapter, scenario: name, version: 1 })
      expect(header.boundary).toBeTruthy()
      expect(header.recordedAt).toBeTruthy()
    }
  })

  it.each(adapters)('replays through %s', async (adapterId) => {
    SCENARIOS[name].assert(await runScenario(name, adapterId))
  })
})
