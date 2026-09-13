import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer, LocalMmsClient } from '../src/mms/protocol'
import type { ProtocolEvent } from '../src/mms/protocol'
import type { LineEditStatsSnapshot, UsageStatsSnapshot } from '../src/shared/lineEditStats'

it('routes heatmap reads, manual edits, usage and live updates to the bound profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mousse-profile-stats-'))
  const home = join(root, 'home')
  mkdirSync(home)
  const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false })
  const host = main.getInstallationHost()!
  const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
  const bobServices = await main.getProfileServices(bob.id)
  const server = new MmsProtocolServer({ mms: main, ownerToken: 'stats-fixture-owner' })
  const endpoint = await server.start()
  const options = { homeDir: home, endpoint, ownerToken: 'stats-fixture-owner', requestedCapabilities: ['profiles-v1'] }
  const aliceClient = new LocalMmsClient(options)
  const bobClient = new LocalMmsClient(options)
  const aliceEvents: ProtocolEvent[] = []
  const bobEvents: ProtocolEvent[] = []
  try {
    await aliceClient.connect()
    await bobClient.connect()
    await aliceClient.request('profiles.bind', { profile: main.profileId })
    await bobClient.request('profiles.bind', { profile: bob.id })
    aliceClient.onEvent((event) => aliceEvents.push(event))
    bobClient.onEvent((event) => bobEvents.push(event))
    await aliceClient.subscribe(0)
    await bobClient.subscribe(0)
    main.lineEditStats.record('orchestrator', 7)
    main.lineEditStats.recordUsage({ timestamp: new Date().toISOString(), provider: 'test', model: 'shared-model', input: 10, output: 3, cacheRead: 0, cacheWrite: 0 })
    await aliceClient.request('stats.recordManualEdits', { lines: 5 })
    await bobClient.request('stats.recordManualEdits', { lines: 2 })
    expect(await aliceClient.request<LineEditStatsSnapshot>('stats.lineEdits')).toMatchObject({ total: 12, totalAgent: 5, totalTab: 7 })
    expect(await bobClient.request<LineEditStatsSnapshot>('stats.lineEdits')).toMatchObject({ total: 2, totalAgent: 2, totalTab: 0 })
    expect((await aliceClient.request<UsageStatsSnapshot>('stats.usage')).totals.tokens).toBe(13)
    expect((await bobClient.request<UsageStatsSnapshot>('stats.usage')).turns).toEqual([])
    expect(aliceEvents.filter((event) => event.type === 'stats.lineEdits.updated').map((event) => (event.data as { snapshot: LineEditStatsSnapshot }).snapshot.total)).toEqual([7, 12])
    expect(bobEvents.filter((event) => event.type === 'stats.lineEdits.updated').map((event) => (event.data as { snapshot: LineEditStatsSnapshot }).snapshot.total)).toEqual([2])
    await aliceClient.request('profiles.bind', { profile: bob.id })
    expect((await aliceClient.request<LineEditStatsSnapshot>('stats.lineEdits')).total).toBe(2)
    await aliceClient.request('profiles.bind', { profile: main.profileId })
    expect((await aliceClient.request<LineEditStatsSnapshot>('stats.lineEdits')).total).toBe(12)
    expect(JSON.parse(readFileSync(join(bobServices.getProfileHomeDir(), 'line-edits.json'), 'utf8')).turns).toEqual([])
    await expect(bobClient.request('stats.recordManualEdits', { lines: -1 })).rejects.toThrow()
    await expect(bobClient.request('stats.recordManualEdits', { lines: 20, expectedProfileId: main.profileId })).rejects.toThrow('Profile changed')
    expect((await bobClient.request<LineEditStatsSnapshot>('stats.lineEdits')).total).toBe(2)
  } finally {
    await aliceClient.close()
    await bobClient.close()
    await server.stop()
    await main.stop()
    const rel = relative(tmpdir(), root)
    if (isAbsolute(rel) || !rel.startsWith('mousse-profile-stats-') || rel.startsWith('..')) throw new Error('Unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})
