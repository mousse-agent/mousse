import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createAssistantMessageEventStream,
  type Model,
  type Provider,
  type AssistantMessage,
  type Context,
  type StreamOptions
} from '@earendil-works/pi-ai'
import { MmsProfileServices } from '../../../../src/mms/MmsProfileServices'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { MousseConfigStore } from '../../../../src/mms/config/MousseConfigStore'
import { ProviderAuthService } from '../../../../src/mms/providers/ProviderAuthService'
import { DomainHandlerRegistry } from '../../../../src/mms/protocol/domainRegistry'
import { NetService } from '../../../../src/mms/net/NetService'
import { BridgeProfileService } from '../../../../src/mms/bridge/BridgeProfileService'
import { BotProfileService } from '../../../../src/mms/bots/BotProfileService'
import {
  effectiveBotPolicyDigest,
  nativeSdkVersion,
  modelDigest,
  type NativeBotDefinition
} from '../../../../src/mms/bots/runtime'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { newId, type SpaceId, type StreamId, type BotId } from '../../../../src/shared/net'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function profile(options: { native?: boolean; paused?: boolean; stubborn?: boolean } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bot-central-')))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
  cleanup.push(() => auth.stop())
  const services = new MmsProfileServices(
    MousseConfigStore.load(home),
    { homeDir: home, repoRoot: home, headless: true, requireOwnership: false },
    null,
    home,
    {
      providerAuth: auth,
      domains: new DomainHandlerRegistry(),
      installationHome: home,
      profileId: randomUUID(),
      allowLegacyProjectData: false
    }
  )
  cleanup.push(() => services.stop())
  const contexts: Context[] = [],
    signals: AbortSignal[] = []
  let release = () => {}
  const model: Model<'anthropic-messages'> = {
    id: 'central-fixture',
    name: 'Fixture',
    api: 'anthropic-messages',
    provider: 'central-fixture',
    baseUrl: 'https://invalid.test',
    reasoning: false,
    input: ['text'],
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    contextWindow: 10000,
    maxTokens: 1000
  }
  const stream = (
    _model: Model<'anthropic-messages'>,
    context: Context,
    request: StreamOptions = {}
  ) => {
    contexts.push(structuredClone(context))
    signals.push(request.signal!)
    const result = createAssistantMessageEventStream()
    const message: AssistantMessage = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: 'text', text: 'Central exact answer' }],
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 10 / 1000000 }
      }
    }
    release = () => {
      result.push({ type: 'done', reason: 'stop', message })
      result.end(message)
    }
    if (!options.stubborn) request.signal?.addEventListener('abort', release, { once: true })
    if (!options.paused) queueMicrotask(release)
    return result
  }
  const provider: Provider<'anthropic-messages'> = {
    id: model.provider,
    name: 'Fixture',
    auth: {
      apiKey: {
        name: 'Fixture',
        resolve: async () => ({ auth: { apiKey: 'deterministic-central-fixture' } })
      }
    },
    getModels: () => [model],
    stream,
    streamSimple: stream
  }
  auth.models.setProvider(provider)
  await auth.credentials.modify(provider.id, async () => ({
    type: 'api_key',
    key: 'deterministic-central-fixture'
  }))
  const definition: NativeBotDefinition = {
    revision: 'central-v1',
    systemPrompt: 'Only the central bot compartment.',
    billing: {
      provider: model.provider,
      model: model.id,
      api: model.api,
      modelDigest: modelDigest(model),
      sdkVersion: nativeSdkVersion(),
      platform: process.platform,
      nodeVersion: process.versions.node,
      runtimeVersion: 'mousse-net-native-v1',
      maximumUnits: 60,
      maxOutputTokens: 50,
      maxRequestBytes: 65536,
      evidence: 'Deterministic local charge10 fixture only; no paid-provider qualification.'
    },
    readerTools: [],
    approval: 'always',
    maxModelCalls: 2,
    maxToolCalls: 1,
    maxElapsedMs: 30000
  }
  let bridge!: BridgeProfileService
  const net = new NetService({
    profileDir: home,
    composeRuntime: (runtime) => {
      bridge = new BridgeProfileService({
        services,
        runtime,
        net,
        nativeAdapters: options.native
          ? new Map([
              [
                'mousse',
                {
                  settings: services.settings,
                  providerAuth: auth,
                  sdkVersion: nativeSdkVersion(),
                  definition,
                  qualification: { active: (profile) => profile === 'chat', invalidate: () => {} }
                }
              ]
            ])
          : undefined
      })
      return bridge.composition()
    }
  })
  cleanup.push(() => net.shutdown())
  await net.request('net.init', { listen: true })
  await net.request('net.protect', { passphrase: 'central-fixture-protection' })
  return {
    home,
    services,
    auth,
    net,
    get bridge() {
      return bridge
    },
    contexts,
    signals,
    definition,
    release: () => release()
  }
}

async function addBot(
  p: Awaited<ReturnType<typeof profile>>,
  space: SpaceId,
  visibility: 'public' | 'private' = 'public'
) {
  const rt = p.net.runtime(),
    bot = newId('bot'),
    key = rt.keys.createBotKey(bot),
    self = rt.identity.self()!
  const delegation = rt.identity.issueBotDelegation({
    bot,
    key,
    name: 'Central fixture',
    hostNode: self.node
  })
  p.bridge.spaces.host.postMeta(space, 'bot.added', {
    record: {
      bot,
      owner: self.user,
      delegation,
      displayName: 'Central fixture',
      profile: 'chat',
      policy: { visibility, steer: { kind: 'everyone' } }
    }
  })
  const config = {
    space,
    bot,
    adapter: 'mousse',
    profile: 'chat' as const,
    definitionRevision: p.definition.revision,
    profileDigest: effectiveBotPolicyDigest(p.definition, 'chat'),
    dailyBudgetUnits: 1000,
    runCeilingUnits: 60,
    maxConcurrent: 2,
    runsPerMemberHour: 20
  }
  p.bridge.bots.configure(config)
  return { bot, config }
}

async function mention(
  p: Awaited<ReturnType<typeof profile>>,
  space: SpaceId,
  channel: StreamId,
  bot: BotId
) {
  const id = p.bridge.spaces.client.post(channel, 'Only this original mention', { mentions: [bot] })
  await p.bridge.spaces.flush(space)
  return id
}

it('exposes the actual production bot owner before enrollment, with every native profile inactive by default', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bot-default-')))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const mms = await MousseMainService.create({
    homeDir: home,
    repoRoot: home,
    headless: true,
    requireOwnership: false
  })
  cleanup.push(() => mms.stop())
  expect(mms.bots).toBeInstanceOf(BotProfileService)
  expect(mms.bots).toBe(mms.bridge.bots)
  expect(mms.net.runtime().identity.self()).toBeUndefined()
  expect(mms.bots.nativeRuntimes.size).toBe(0)
  expect(mms.spaces.client.options.identity).toBe(mms.bots.options.spaces.historyIdentity)
})

it.each(['public', 'private'] as const)(
  'runs actual central Native execution once after durable authority acceptance and publishes verified %s results to an independent protected TLS replica',
  async (visibility) => {
    const host = await profile({ native: true }),
      member = await profile()
    const created = host.bridge.spaces.host.create({ name: 'Central conversation' }),
      channel = host.bridge.spaces.host.createChannel(created.space, 'general')
    const { bot, config } = await addBot(host, created.space, visibility)
    host.bridge.bots.qualify(config)
    const invitation = host.bridge.spaces.host.invite(created.space, { role: 'member' })
    const joinId = member.bridge.spaces.client.prepareJoin(invitation.text)
    await member.bridge.spaces.client.join(joinId)
    await member.bridge.spaces.client.connect(created.space)
    await member.bridge.spaces.client.subscribe(channel)
    expect(member.net.runtime().keys.encryptedAtRest()).toBe(true)
    const id = await mention(member, created.space, channel, bot)
    const rt = host.net.runtime()
    await vi.waitFor(
      () =>
        expect(rt.executions.find({ scope: created.space, target: bot, trigger: id })?.state).toBe(
          'completed'
        ),
      { timeout: 10000 }
    )
    await host.bridge.bots.drain()
    const execution = rt.executions.find({ scope: created.space, target: bot, trigger: id })!,
      output = execution.binding!.stream
    expect(host.contexts).toHaveLength(1)
    expect(host.contexts[0].tools).toBeUndefined()
    expect(host.contexts[0].systemPrompt).toBe(host.definition.systemPrompt)
    const acceptance = rt.outbox
      .list(output)
      .find((entry) => decodeEnvelope(entry.envelope).envelope.type === 'bot.run.accepted')!
    expect(acceptance.state).toBe('sent')
    expect(host.bridge.spaces.host.executionBinding(created.space, execution.id)?.trigger).toBe(id)
    expect(
      rt.db.database
        .prepare('SELECT spent FROM net_budget_calls WHERE execution=?')
        .get(execution.id)!.spent
    ).toBe(10)
    expect(
      existsSync(
        join(
          host.services.threads.getThreadDir(execution.binding!.backingThreadId),
          'bot-workspaces',
          execution.binding!.workspaceId,
          '.net-bot-workspace.json'
        )
      )
    ).toBe(true)
    const session = member.bridge.spaces.session(created.space)!
    await vi.waitFor(() =>
      expect(member.bridge.spaces.store.head(channel).seq).toBe(
        host.bridge.spaces.store.head(channel).seq
      )
    )
    const descriptor = await member.bridge.spaces.discover(created.space, output)
    expect(descriptor).toEqual(host.bridge.spaces.store.getStream(output))
    if (visibility === 'private') {
      expect(member.bridge.spaces.private.state(output)?.control.participants).toEqual(
        [
          host.net.runtime().identity.self()!.user,
          member.net.runtime().identity.self()!.user,
          bot
        ].sort()
      )
    }
    await member.bridge.spaces.client.subscribe(output)
    await vi.waitFor(() =>
      expect(member.bridge.spaces.store.head(output).seq).toBe(
        host.bridge.spaces.store.head(output).seq
      )
    )
    expect(member.bridge.spaces.store.getById(output, acceptance.id)?.envelope).toEqual(
      acceptance.envelope
    )
    if (visibility === 'private') {
      const completed = rt.outbox
        .list(output)
        .find((entry) => decodeEnvelope(entry.envelope).envelope.type === 'bot.run.completed')!
      expect(Buffer.from(completed.envelope).toString()).not.toContain('Central exact answer')
      expect(
        member.bridge.spaces.private.open(
          output,
          member.bridge.spaces.store.getById(output, completed.id)!
        )
      ).toEqual({ text: 'Central exact answer' })
      const verify = vi.spyOn(member.bridge.bots, 'verifyHistory'),
        receive = vi.spyOn(member.bridge.bots, 'receiveStored')
      const records = host.bridge.spaces.store.read(
        output,
        { epoch: 1, seq: 0 },
        host.bridge.spaces.store.head(output).seq,
        1024 * 1024
      ).records
      member.bridge.spaces.store.installSnapshot(output, 1, records.at(-1)!.seq, records)
      const botCalls = verify.mock.calls.filter(
        ([record]) => decodeEnvelope(record.envelope).envelope.author.bot
      )
      expect(botCalls.length).toBeGreaterThanOrEqual(2)
      expect(
        botCalls.every(
          ([, , control]) =>
            control?.stream === output && control.control.participants.includes(bot)
        )
      ).toBe(true)
      expect(verify).toHaveBeenCalled()
      expect(receive).not.toHaveBeenCalled()
      expect(
        member.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!
          .n
      ).toBe(0)
      verify.mockRestore()
      receive.mockRestore()
    }
    expect(member.bridge.bots.options.spaces.historyIdentity).toBe(
      member.bridge.spaces.client.options.identity
    )
    const publish = vi.spyOn(host.net, 'publishPresence'),
      receivePresence = vi.spyOn(member.bridge.bots, 'receivePresence')
    await host.bridge.bots.presence.publish(bot, channel)
    const heartbeat = publish.mock.calls.at(-1)![0]
    await vi.waitFor(() =>
      expect(member.bridge.bots.presenceReceiver.view(channel, bot).state).toBe('idle')
    )
    expect(
      receivePresence.mock.calls.filter(
        ([message]) => message.subject === bot && message.counter === heartbeat.counter
      )
    ).toHaveLength(1)
    expect(member.bridge.spaces.store.head(channel).seq).toBe(
      host.bridge.spaces.store.head(channel).seq
    )
    publish.mockRestore()
    receivePresence.mockRestore()
    const original = rt.outbox.get(id) ?? member.net.runtime().outbox.get(id)!
    await session.append(channel, id, original.envelope, original.sig)
    await host.bridge.bots.drain()
    expect(host.contexts).toHaveLength(1)
  },
  20000
)

it('denies an unqualified production adapter before admission/model effects through the actual ordinary committed record hook', async () => {
  const host = await profile(),
    created = host.bridge.spaces.host.create({ name: 'No qualification' }),
    channel = host.bridge.spaces.host.createChannel(created.space, 'general')
  const { bot, config } = await addBot(host, created.space)
  expect(() => host.bridge.bots.qualify(config)).toThrow(
    expect.objectContaining({ code: 'profile_unsupported' })
  )
  await mention(host, created.space, channel, bot)
  await host.bridge.bots.drain()
  expect(host.contexts).toHaveLength(0)
  expect(
    host.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n
  ).toBe(0)
})

it('rechecks the original authorization after awaited private audience preparation before creating keys or an admission', async () => {
  const host = await profile({ native: true }),
    created = host.bridge.spaces.host.create({ name: 'Private proof race' }),
    channel = host.bridge.spaces.host.createChannel(created.space, 'general')
  const { bot, config } = await addBot(host, created.space, 'private')
  host.bridge.bots.qualify(config)
  const prepare = vi.fn(
    async (
      space: SpaceId,
      participants: Array<import('../../../../src/shared/net').UserId | BotId>
    ) => {
      expect(space).toBe(created.space)
      expect(participants).toEqual([host.net.runtime().identity.self()!.user, bot].sort())
      await Promise.resolve()
      host.bridge.spaces.host.postMeta(created.space, 'bot.removed', { bot })
    }
  )
  host.bridge.bots.options.preparePrivateAudience = prepare
  const creation = vi.spyOn(host.bridge.spaces.private, 'prepareCreation'),
    calls = vi.spyOn(host.bridge.bots, 'receiveStored')
  const id = await mention(host, created.space, channel, bot)
  const index = calls.mock.calls.findIndex(
    ([record]) => decodeEnvelope(record.envelope).envelope.id === id
  )
  await expect(Promise.all(calls.mock.results[index].value)).rejects.toMatchObject({
    code: 'bad_delegation'
  })
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(creation).not.toHaveBeenCalled()
  expect(host.contexts).toHaveLength(0)
  expect(
    host.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n
  ).toBe(0)
})

it.each(['public', 'private'] as const)(
  'executes a third member %s original only on the separately protected bot executor through real authority and client guards',
  async (visibility) => {
    const host = await profile(),
      executor = await profile({ native: true }),
      sender = await profile()
    const created = host.bridge.spaces.host.create({ name: 'Three actual users' }),
      channel = host.bridge.spaces.host.createChannel(created.space, 'general')
    await executor.bridge.spaces.client.join(
      executor.bridge.spaces.client.prepareJoin(host.bridge.spaces.host.invite(created.space).text)
    )
    await executor.bridge.spaces.client.connect(created.space)
    await executor.bridge.spaces.client.subscribe(channel)
    const rt = executor.net.runtime(),
      self = rt.identity.self()!,
      bot = newId('bot'),
      key = rt.keys.createBotKey(bot)
    const delegation = rt.identity.issueBotDelegation({
      bot,
      key,
      name: 'Remote central fixture',
      hostNode: self.node
    })
    await vi.waitFor(() =>
      expect(
        JSON.parse(
          Buffer.from(
            host.net.runtime().identity.roster(self.user)!.payload,
            'base64url'
          ).toString()
        ).bots
      ).toHaveLength(1)
    )
    const registered = executor.bridge.spaces.client.queue(created.meta, 'bot.added', {
      record: {
        bot,
        owner: self.user,
        delegation,
        displayName: 'Remote central fixture',
        profile: 'chat',
        policy: { visibility, steer: { kind: 'everyone' } }
      }
    })
    await executor.bridge.spaces.flush(created.space)
    expect(rt.outbox.get(registered)?.state).toBe('sent')
    await vi.waitFor(() =>
      expect(executor.bridge.spaces.meta.bot(created.space, bot)).toBeDefined()
    )
    await sender.bridge.spaces.client.join(
      sender.bridge.spaces.client.prepareJoin(host.bridge.spaces.host.invite(created.space).text)
    )
    await sender.bridge.spaces.client.connect(created.space)
    await sender.bridge.spaces.client.subscribe(channel)
    await vi.waitFor(() =>
      expect(
        executor.bridge.spaces.meta.member(
          created.space,
          sender.net.runtime().identity.self()!.user
        )
      ).toBeDefined()
    )
    // A real negotiated session pong supplies admission's clock estimate. There
    // is no synthetic estimate or accelerated clock in this composition test.
    await vi.waitFor(
      () => expect(executor.bridge.spaces.session(created.space)?.clockEstimate()).toBeDefined(),
      { timeout: 25000 }
    )
    const config = {
      space: created.space,
      bot,
      adapter: 'mousse',
      profile: 'chat' as const,
      definitionRevision: executor.definition.revision,
      profileDigest: effectiveBotPolicyDigest(executor.definition, 'chat'),
      dailyBudgetUnits: 1000,
      runCeilingUnits: 60,
      maxConcurrent: 2,
      runsPerMemberHour: 20
    }
    executor.bridge.bots.configure(config)
    executor.bridge.bots.qualify(config)
    const calls = vi.spyOn(executor.bridge.bots, 'receiveStored'),
      id = await mention(sender, created.space, channel, bot)
    await vi.waitFor(() =>
      expect(
        calls.mock.calls.some(([record]) => decodeEnvelope(record.envelope).envelope.id === id)
      ).toBe(true)
    )
    const index = calls.mock.calls.findIndex(
      ([record]) => decodeEnvelope(record.envelope).envelope.id === id
    )
    await Promise.all(calls.mock.results[index].value)
    await executor.bridge.bots.drain()
    const execution = rt.executions.find({ scope: created.space, target: bot, trigger: id })!
    expect(execution.state).toBe('completed')
    expect(executor.contexts).toHaveLength(1)
    expect(host.contexts).toHaveLength(0)
    expect(sender.contexts).toHaveLength(0)
    expect(host.bridge.spaces.host.executionBinding(created.space, execution.id)?.bot).toBe(bot)
    expect(
      rt.outbox
        .list(execution.binding!.stream)
        .find((entry) => decodeEnvelope(entry.envelope).envelope.type === 'bot.run.accepted')?.state
    ).toBe('sent')
    const output = execution.binding!.stream
    await vi.waitFor(() =>
      expect(sender.bridge.spaces.store.head(channel).seq).toBe(
        host.bridge.spaces.store.head(channel).seq
      )
    )
    await sender.bridge.spaces.discover(created.space, output)
    await sender.bridge.spaces.client.subscribe(output)
    await vi.waitFor(() =>
      expect(sender.bridge.spaces.store.head(output).seq).toBe(
        host.bridge.spaces.store.head(output).seq
      )
    )
    if (visibility === 'private') {
      const completed = rt.outbox
        .list(output)
        .find((entry) => decodeEnvelope(entry.envelope).envelope.type === 'bot.run.completed')!
      expect(
        sender.bridge.spaces.private.open(
          output,
          sender.bridge.spaces.store.getById(output, completed.id)!
        )
      ).toEqual({ text: 'Central exact answer' })
      const senderRt = sender.net.runtime(),
        before = senderRt.outbox.list(output).length
      expect(() =>
        sender.bridge.spaces.private.seal(output, 'message.posted', {
          text: 'Original recipient current-proof ciphertext'
        })
      ).toThrow(expect.objectContaining({ code: 'meta_stale' }))
      expect(senderRt.outbox.list(output)).toHaveLength(before)
      expect(senderRt.identity.pinnedRootKey(self.user)).toBeUndefined()
      await sender.bridge.currentIdentity.preparePrivateAudience(
        created.space,
        sender.bridge.spaces.private.state(output)!.control.participants
      )
      await executor.bridge.spaces.client.subscribe(output)
      const message = sender.bridge.spaces.private.seal(output, 'message.posted', {
        text: 'Original recipient current-proof ciphertext'
      })
      await sender.bridge.spaces.flush(created.space)
      expect(senderRt.outbox.get(message.id)?.state).toBe('sent')
      expect(host.bridge.spaces.store.getById(output, message.id)?.envelope).toEqual(
        message.envelope
      )
      await vi.waitFor(() =>
        expect(executor.bridge.spaces.store.getById(output, message.id)).toBeDefined()
      )
      await vi.waitFor(() =>
        expect(sender.bridge.spaces.store.getById(output, message.id)).toBeDefined()
      )
      expect(
        sender.bridge.spaces.private.open(
          output,
          sender.bridge.spaces.store.getById(output, message.id)!
        )
      ).toEqual({ text: 'Original recipient current-proof ciphertext' })
      expect(
        executor.bridge.spaces.private.open(
          output,
          executor.bridge.spaces.store.getById(output, message.id)!
        )
      ).toEqual({ text: 'Original recipient current-proof ciphertext' })
      expect(senderRt.identity.pinnedRootKey(self.user)).toBeUndefined()
    }
    expect(sender.net.runtime().identity.pinnedRootKey(self.user)).toBeUndefined()
    const publish = vi.spyOn(executor.net, 'publishPresence'),
      relay = vi.spyOn(host.net, 'publishPresence'),
      received = vi.spyOn(sender.bridge.bots, 'receivePresence')
    await executor.bridge.bots.presence.publish(bot, channel)
    const heartbeat = publish.mock.calls.at(-1)![0]
    await vi.waitFor(() =>
      expect(sender.bridge.bots.presenceReceiver.view(channel, bot).state).toBe('idle')
    )
    expect(
      relay.mock.calls.some(
        ([message, exclude]) =>
          message.sig === heartbeat.sig &&
          message.counter === heartbeat.counter &&
          exclude === self.node
      )
    ).toBe(true)
    expect(
      received.mock.calls.filter(
        ([message]) => message.subject === bot && message.counter === heartbeat.counter
      )
    ).toHaveLength(1)
    expect(sender.net.runtime().identity.pinnedRootKey(self.user)).toBeUndefined()
    publish.mockRestore()
    relay.mockRestore()
    received.mockRestore()
  },
  40000
)

it('retains composed ownership while an actually dispatched Native provider ignores abort and rejects close on uncertain effects', async () => {
  const host = await profile({ native: true, paused: true, stubborn: true }),
    created = host.bridge.spaces.host.create({ name: 'Unproven drain' }),
    channel = host.bridge.spaces.host.createChannel(created.space, 'general')
  const { bot, config } = await addBot(host, created.space)
  host.bridge.bots.qualify(config)
  const id = await mention(host, created.space, channel, bot),
    rt = host.net.runtime()
  await vi.waitFor(() => expect(host.contexts).toHaveLength(1))
  expect(host.bridge.activeCount()).toBeGreaterThan(0)
  await expect(host.bridge.close()).rejects.toMatchObject({ code: 'outcome_uncertain' })
  expect(host.signals[0].aborted).toBe(true)
  expect(rt.executions.find({ scope: created.space, target: bot, trigger: id })?.state).toBe(
    'uncertain'
  )
  expect(rt.db.database.prepare('SELECT active FROM net_bot_admission_slots').get()!.active).toBe(1)
  expect(rt.db.database.prepare('SELECT maximum,spent FROM net_budget_calls').get()).toEqual({
    maximum: 60,
    spent: null
  })
  await expect(host.bridge.close()).rejects.toMatchObject({ code: 'outcome_uncertain' })
  host.release()
  await vi.waitFor(() =>
    expect(rt.db.database.prepare('SELECT spent FROM net_budget_calls').get()!.spent).toBe(10)
  )
  // Provider settlement alone does not invent a release of the held uncertain slot.
  expect(rt.db.database.prepare('SELECT active FROM net_bot_admission_slots').get()!.active).toBe(1)
  // Explicit fixture cleanup after the actual provider's terminal usage was
  // observed; production retains uncertainty until owner reconciliation.
  rt.db.transaction(() =>
    host.bridge.bots.admission.release(
      rt.executions.find({ scope: created.space, target: bot, trigger: id })!.id
    )
  )
  await host.bridge.close()
}, 15000)

it('closes SQLite only after the real cooperative Native provider drains its terminal usage and cancellation', async () => {
  const host = await profile({ native: true, paused: true }),
    created = host.bridge.spaces.host.create({ name: 'Known cooperative drain' }),
    channel = host.bridge.spaces.host.createChannel(created.space, 'general')
  const { bot, config } = await addBot(host, created.space)
  host.bridge.bots.qualify(config)
  const id = await mention(host, created.space, channel, bot),
    rt = host.net.runtime()
  await vi.waitFor(() =>
    expect(
      host.contexts,
      JSON.stringify({
        execution: rt.executions.find({ scope: created.space, target: bot, trigger: id }),
        receipts: rt.db.database.prepare('SELECT state,error FROM net_outbox').all()
      })
    ).toHaveLength(1)
  )
  expect(host.net.getActiveCount()).toBeGreaterThan(0)
  const close = rt.db.close.bind(rt.db),
    observed = vi.spyOn(rt.db, 'close').mockImplementation(() => {
      expect(rt.executions.find({ scope: created.space, target: bot, trigger: id })?.state).toBe(
        'cancelled'
      )
      expect(rt.db.database.prepare('SELECT spent FROM net_budget_calls').get()!.spent).toBe(10)
      expect(
        rt.db.database.prepare('SELECT active FROM net_bot_admission_slots').get()!.active
      ).toBe(0)
      close()
    })
  await host.net.shutdown()
  expect(host.signals[0].aborted).toBe(true)
  expect(host.contexts).toHaveLength(1)
  expect(observed).toHaveBeenCalledTimes(1)
  observed.mockRestore()
}, 10000)

it('NetService preserves the actual composed uncertain provider ledger when domain shutdown fails', async () => {
  const host = await profile({ native: true, paused: true, stubborn: true }),
    created = host.bridge.spaces.host.create({ name: 'Network drain ownership' }),
    channel = host.bridge.spaces.host.createChannel(created.space, 'general')
  const { bot, config } = await addBot(host, created.space)
  host.bridge.bots.qualify(config)
  const id = await mention(host, created.space, channel, bot),
    rt = host.net.runtime()
  await vi.waitFor(() => expect(host.contexts).toHaveLength(1))
  const closing = host.net.shutdown(),
    concurrent = host.net.shutdown()
  const outcome = await closing.then(
    () => ({ resolved: true }),
    (error) => ({ error })
  )
  const second = await concurrent.then(
    () => ({ resolved: true }),
    (error) => ({ error })
  )
  try {
    expect(outcome).toMatchObject({ error: { code: 'outcome_uncertain' } })
    expect(second).toMatchObject({ error: { code: 'outcome_uncertain' } })
    expect(rt.executions.find({ scope: created.space, target: bot, trigger: id })?.state).toBe(
      'uncertain'
    )
    expect(rt.db.database.prepare('SELECT active FROM net_bot_admission_slots').get()!.active).toBe(
      1
    )
    await expect(host.net.shutdown()).rejects.toMatchObject({ code: 'outcome_uncertain' })
  } finally {
    host.release()
    try {
      await vi.waitFor(() =>
        expect(rt.db.database.prepare('SELECT spent FROM net_budget_calls').get()!.spent).toBe(10)
      )
      rt.db.transaction(() =>
        host.bridge.bots.admission.release(
          rt.executions.find({ scope: created.space, target: bot, trigger: id })!.id
        )
      )
    } catch {
      // The pre-fix red reproduction closes SQLite. Stop the owned timer so
      // that a failed assertion does not leave asynchronous fixture work.
      await host.bridge.spaces.local.close()
    }
  }
  await host.net.shutdown()
  expect(() => rt.db.database.prepare('SELECT 1').get()).toThrow('database is not open')
}, 15000)
