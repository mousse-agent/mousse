import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { MmsProtocolServer } from '../../../../src/mms/protocol/server'
import { LocalMmsClient } from '../../../../src/mms/protocol/client'
import { newId } from '../../../../src/shared/net'
import type { BotsLocalParams } from '../../../../src/shared/bots/local'

it('registers actual owner bot IPC with trusted profile binding, exact DTOs and inactive production qualification', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bots-owner-ipc-'))),
    home = join(root, 'home')
  const main = await MousseMainService.create({
      homeDir: home,
      repoRoot: root,
      headless: true,
      requireOwnership: false
    }),
    host = main.getInstallationHost()!,
    aId = host.getDefaultProfileId(),
    bId = host.manager.create({ displayName: 'Other profile', slug: 'other' }).id
  const server = new MmsProtocolServer({ mms: main, ownerToken: 'local-bot-test-owner' }),
    endpoint = await server.start()
  const client = (ownerToken = 'local-bot-test-owner') =>
    new LocalMmsClient({
      homeDir: home,
      endpoint,
      ownerToken,
      requestedCapabilities: ['profiles-v1']
    })
  const a = client(),
    b = client(),
    unbound = client(),
    outsider = client('wrong-owner'),
    digest = Buffer.alloc(32, 1).toString('base64url')
  try {
    await Promise.all([a.connect(), b.connect(), unbound.connect()])
    await expect(outsider.connect()).rejects.toThrow()
    await expect(unbound.request('bots.list', {})).rejects.toMatchObject({
      code: 'profile_binding_required'
    })
    await a.request('profiles.bind', { profile: aId })
    await b.request('profiles.bind', { profile: bId })
    await a.request('net.init', { listen: true, port: 0 })
    await a.request('net.protect', { passphrase: 'task-owned-bot-fixture' })
    await b.request('net.init', {})
    const services = await main.getProfileServices(aId),
      rt = services.net.runtime(),
      self = rt.identity.self()!,
      space = services.spaces.host.create({ name: 'Owner IPC' }),
      channel = services.spaces.host.createChannel(space.space, 'general'),
      bot = newId('bot'),
      key = rt.keys.createBotKey(bot),
      delegation = rt.identity.issueBotDelegation({
        bot,
        key,
        name: 'Inactive local bot',
        hostNode: self.node
      })
    services.spaces.host.postMeta(space.space, 'bot.added', {
      record: {
        bot,
        owner: self.user,
        delegation,
        displayName: 'Inactive local bot',
        profile: 'chat',
        policy: { steer: { kind: 'everyone' }, visibility: 'public' }
      }
    })
    const config: BotsLocalParams['bots.configure'] = {
      space: space.space,
      bot,
      adapter: 'mousse',
      profile: 'chat',
      definitionRevision: 'unqualified-production',
      profileDigest: digest,
      dailyBudgetUnits: 1000,
      runCeilingUnits: 60,
      maxConcurrent: 2,
      runsPerMemberHour: 20
    }
    expect(await a.request('bots.configure', config)).toMatchObject({
      owner: self.user,
      bot,
      qualified: false,
      stopped: false
    })
    await expect(
      a.request('bots.qualify', {
        space: space.space,
        bot,
        definitionRevision: config.definitionRevision,
        profileDigest: digest
      })
    ).rejects.toMatchObject({ code: 'profile_unsupported' })
    await expect(
      a.request('bots.configure', { ...config, projectPath: root })
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(a.request('bots.configure', { ...config, qualified: true })).rejects.toMatchObject(
      { code: 'bad_request' }
    )
    await expect(
      a.request('bots.configure', { ...config, native: { definition: 'untrusted' } })
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      a.request('bots.configure', { ...config, profile: 'reader', projectId: randomUUID() })
    ).rejects.toMatchObject({ code: 'forbidden' })
    const otherServices = await main.getProfileServices(bId),
      foreignProject = otherServices.projects.openProject(root),
      localProject = services.projects.openProject(root),
      reader = newId('bot'),
      readerKey = rt.keys.createBotKey(reader),
      readerDelegation = rt.identity.issueBotDelegation({
        bot: reader,
        key: readerKey,
        name: 'Inactive reader',
        hostNode: self.node
      })
    services.spaces.host.postMeta(space.space, 'bot.added', {
      record: {
        bot: reader,
        owner: self.user,
        delegation: readerDelegation,
        displayName: 'Inactive reader',
        profile: 'reader',
        policy: { steer: { kind: 'everyone' }, visibility: 'public' }
      }
    })
    await expect(
      a.request('bots.configure', {
        ...config,
        bot: reader,
        profile: 'reader',
        projectId: foreignProject.id
      })
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(
      await a.request('bots.configure', {
        ...config,
        bot: reader,
        profile: 'reader',
        projectId: localProject.id
      })
    ).toMatchObject({ bot: reader, projectId: localProject.id, qualified: false })
    await expect(a.request('bots.list', { profileId: bId })).rejects.toMatchObject({
      code: 'profile_mismatch'
    })
    await expect(a.request('bots.list', { profileId: aId })).rejects.toMatchObject({
      code: 'bad_request'
    })
    await expect(
      a.request('bots.list', { after: { space: space.space, bot, profileEpoch: 999 } })
    ).rejects.toMatchObject({ code: 'bad_request' })
    expect(await b.request('bots.list', {})).toEqual({ bots: [] })
    await expect(b.request('bots.configure', config)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(b.request('bots.stop', { space: space.space, bot })).rejects.toMatchObject({
      code: 'forbidden'
    })
    await a.request('bots.stop', { space: space.space, bot })
    expect(await a.request('bots.resume', { space: space.space, bot })).toMatchObject({
      stopped: false,
      qualified: false
    })
    expect(await a.request('bots.presence', { space: space.space, bot, stream: channel })).toEqual({
      space: space.space,
      bot,
      stream: channel,
      state: 'offline'
    })
    await expect(
      a.request('bots.grant', { stream: channel, request: newId('event'), approved: true })
    ).rejects.toMatchObject({ code: 'forbidden' })
    const sent = await a.request<any>('spaces.post', {
      stream: channel,
      text: 'An inactive mention stays a human message',
      mentions: [bot]
    })
    expect(sent.state).toBe('sent')
    expect(
      (await a.request<any>('spaces.tail', { stream: channel })).records[0].envelope.refs
    ).toEqual({ mentions: [bot] })
    await expect(
      a.request('spaces.post', { stream: channel, text: 'duplicate mention', mentions: [bot, bot] })
    ).rejects.toMatchObject({ code: 'bad_request' })
    const before = rt.db.database.prepare('SELECT count(*) AS n FROM net_outbox').get()!.n
    await expect(
      a.request('spaces.post', {
        stream: channel,
        text: '\u0000'.repeat(20 * 1024),
        mentions: [bot]
      })
    ).rejects.toMatchObject({ code: 'too_large' })
    expect(rt.db.database.prepare('SELECT count(*) AS n FROM net_outbox').get()!.n).toBe(before)
    await services.bots.drain()
    expect(rt.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(0)
    const listed = await a.request<any>('bots.list', {})
    expect(listed.bots).toHaveLength(2)
    expect(JSON.stringify(listed)).not.toContain(root)
  } finally {
    await Promise.all([a.close(), b.close(), unbound.close(), outsider.close()])
    await server.stop()
    await main.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 30000)
