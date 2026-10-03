import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import { MmsProtocolServer } from '../../../src/mms/protocol/server'
import { LocalMmsClient } from '../../../src/mms/protocol/client'
import { NetError, newId } from '../../../src/shared/net'
import { DEFAULT_NET_FEATURE_FLAGS } from '../../../src/shared/featureFlags'
it('fences owner-local domains, retains exact pending outbox originals, and leaves other profiles/local Chats available', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rollback-ipc-'))), home = join(root, 'home')
  const main = await MousseMainService.create({ homeDir: home, repoRoot: root, headless: true, requireOwnership: false })
  const host = main.getInstallationHost()!, aId = host.getDefaultProfileId(), bId = host.manager.create({ displayName: 'Other profile', slug: 'other' }).id
  const server = new MmsProtocolServer({ mms: main, ownerToken: 'rollback-local-owner' }), endpoint = await server.start()
  const client = () => new LocalMmsClient({ homeDir: home, endpoint, ownerToken: 'rollback-local-owner', requestedCapabilities: ['profiles-v1'] })
  const a = client(), b = client(), unbound = client()
  try {
    await Promise.all([a.connect(), b.connect(), unbound.connect()])
    await expect(unbound.request('net.disable', {})).rejects.toMatchObject({ code: 'profile_binding_required' })
    await a.request('profiles.bind', { profile: aId }); await b.request('profiles.bind', { profile: bId })
    const defaults = await a.request('net.status', {})
    expect(defaults).toMatchObject({ enabled: false, features: DEFAULT_NET_FEATURE_FLAGS, routes: [] })
    await expect(a.request('spaces.create', { name: 'Denied before opt-in' })).rejects.toMatchObject({ code: 'cancelled' })
    await expect(a.request('bridge.hub.threads', { target: newId('node') })).rejects.toMatchObject({ code: 'cancelled' })
    for (const c of [a, b]) { await c.request('net.init', { listen: true }); await c.request('net.protect', { passphrase: 'owned-rollback-ipc' }) }
    const created = await a.request('spaces.create', { name: 'Preserved original history' }) as { space: any; channel: any }
    const sent = await a.request('spaces.post', { stream: created.channel, text: 'acknowledged original', mentions: [] }) as { id: any }
    const services = await main.getProfileServices(aId), spaces = services.spaces, rt = services.net.runtime()
    const pending = spaces.client.post(created.channel, 'pending original retained through rollback'), original = rt.outbox.get(pending)!
    expect(original.state).toBe('pending')
    const record = spaces.store.getById(created.channel, sent.id)!, identity = rt.identity.roster()
    const settingsBefore = main.config.get().features
    await expect(a.request('net.disable', { profileId: bId })).rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(a.request('net.disable', { quiesced: true })).rejects.toMatchObject({ code: 'bad_request' })
    expect(await a.request('net.disable', {})).toMatchObject({ enabled: false, restartRequired: true, features: DEFAULT_NET_FEATURE_FLAGS, routes: [] })
    for (const [method, params] of [
      ['spaces.create', { name: 'Denied after rollback' }], ['spaces.post', { stream: created.channel, text: 'denied' }],
      ['bots.list', {}], ['bridge.hub.threads', { target: newId('node') }], ['net.init', {}], ['bridge.invite', {}]
    ] as const) await expect(a.request(method, params)).rejects.toMatchObject({ code: 'cancelled' })
    expect(() => spaces.local.request('spaces.post', { stream: created.channel, text: 'held reference denied' })).toThrow(expect.objectContaining({ code: 'cancelled' }))
    expect(rt.outbox.get(pending)).toEqual(original)
    expect(spaces.store.getById(created.channel, sent.id)).toEqual(record)
    expect(rt.identity.roster()).toEqual(identity)
    expect(main.config.get().features).toEqual(settingsBefore)
    expect(await a.request('net.status', {})).toMatchObject({ enabled: false, restartRequired: true })
    expect(await a.request('net.doctor', {})).toHaveProperty('checks')
    expect(await b.request('spaces.create', { name: 'Unaffected profile' })).toHaveProperty('channel')
    expect(await b.request('net.status', {})).toMatchObject({ enabled: true, features: { netBridge: true, netSpaces: true } })
    // Ordinary local Chats remain a local front door after network rollback.
    expect(services.platform.chats.snapshot()).toBeDefined()
    expect(Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_bot_registry').get()!.n)).toBe(0)
    expect(Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n)).toBe(0)
    expect(() => services.chatNetwork.publish({ chatId: 'invalid', publicationId: 'fixture' } as any)).toThrow(NetError)
  } finally { a.close(); b.close(); unbound.close(); await server.stop(); await main.stop(); rmSync(root, { recursive: true, force: true }) }
}, 15000)
