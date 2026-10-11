import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import type { DomainConnectionContext } from '../src/mms/protocol/domainRegistry'
import { INTEGRATION_CAPABILITY } from '../src/shared/integrationPlatform'

it('delivers an authorization URL only to its initiating connection without replay and rejects a stale profile binding', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-mcp-auth-'))), home = join(root, 'home')
  const main = await MousseMainService.create({ homeDir: home, repoRoot: root, headless: true, requireOwnership: false })
  let emit: NonNullable<DomainConnectionContext['emitConnectionEvent']> | undefined
  main.domains.register({ method: 'fixture.mcpAuth', scope: 'profile', requiredCapabilities: [INTEGRATION_CAPABILITY], validate: () => ({}), handle: async ctx => {
    emit = ctx.connection!.emitConnectionEvent!
    await emit('mcp.auth-url', { attemptId: 'fixture', url: 'https://login.example.test/authorize' })
    return { sent: true }
  } })
  const server = new MmsProtocolServer({ mms: main, ownerToken: 'fixture-owner' })
  const endpoint = await server.start()
  const client = () => new LocalMmsClient({ homeDir: home, endpoint, ownerToken: 'fixture-owner', clientType: 'gui', requestedCapabilities: ['profiles-v1', INTEGRATION_CAPABILITY] })
  const owner = client(), observer = client(), received: unknown[] = [], other: unknown[] = []
  try {
    await Promise.all([owner.connect(), observer.connect()])
    const profile = main.getInstallationHost()!.getDefaultProfileId()
    await owner.request('profiles.bind', { profile })
    await observer.request('profiles.bind', { profile })
    owner.onConnectionEvent(event => received.push(event))
    observer.onConnectionEvent(event => other.push(event))
    const baseline = await observer.subscribe()
    await owner.request('fixture.mcpAuth', {})
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'mcp.auth-url', profileId: profile })
    expect(other).toEqual([])
    expect((await observer.subscribe(baseline.sequence)).replay).toEqual([])
    const old = emit!
    await owner.request('profiles.bind', { profile })
    await expect(old('mcp.auth-url', {})).rejects.toMatchObject({ code: 'connection_closed' })
  } finally {
    await Promise.all([owner.close(), observer.close()])
    await server.stop(); await main.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
