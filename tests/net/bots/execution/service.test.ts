import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectManager } from '../../../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../../../src/mms/data/ThreadDataStore'
import {
  effectiveBotPolicyDigest,
  type NativeBotDefinition
} from '../../../../src/mms/bots/space/runtime'
import { ScriptedBotRuntime } from '../scriptedRuntime'
import {
  MmsBotMaterializer,
  BotExecutionService,
  deniedBotApprovals
} from '../../../../src/mms/bots/space/execution'
import { setup } from '../admission/helpers'
import { cleanup, disposers, profile } from '../../spaces/host/helpers'
import { SqliteExecutionLedger } from '../../../../src/mms/net/store/executions'
import { SqliteBudgetLedger } from '../../../../src/mms/net/store/budgets'
import { SqliteOutbox } from '../../../../src/mms/net/store/outbox'
import { SqliteCompartmentStore } from '../../../../src/mms/bots/space/compartments'
import { SqliteBotRegistry } from '../../../../src/mms/bots/space/registry'
import { BotAdmissionService, BotOutbox } from '../../../../src/mms/bots/space/admission'
import { PrivateSpaceService } from '../../../../src/mms/spaces/private'
import { SqlPrivateStreamKeys } from '../../../../src/mms/net/identity'
import { createHash } from 'node:crypto'
import { canonicalJson, decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { newId } from '../../../../src/shared/net'
afterEach(cleanup)
async function runtimeFixture(ignoresAbort = false) {
  const f = await setup(),
    contexts: Array<{ prompt: string; history: string[] }> = [],
    runtime = new ScriptedBotRuntime({
      answer: 'Scoped bot answer',
      paused: ignoresAbort,
      stubborn: ignoresAbort,
      script: async ({ request }) => {
        contexts.push({
          prompt: request.prompt,
          history: f.compartments.history(request.compartment, 100).map((turn) => turn.text)
        })
        return 'Scoped bot answer'
      }
    })
  const definition: NativeBotDefinition = {
      revision: 'v1',
      systemPrompt: 'Only compartment history. No local context.',
      billing: {
        provider: 'bot-ledger-fixture',
        model: 'fixture',
        api: 'anthropic-messages',
        modelDigest: 'fixture-digest',
        sdkVersion: 'fixture',
        platform: process.platform,
        nodeVersion: process.versions.node,
        runtimeVersion: 'mousse-net-native-v1',
        maximumUnits: 60,
        maxOutputTokens: 50,
        maxRequestBytes: 65536,
        evidence: 'Local deterministic charges10; no paid provider qualification'
      },
      readerTools: [],
      approval: 'always',
      maxModelCalls: 2,
      maxToolCalls: 1,
      maxElapsedMs: 30000
    },
    projects = new ProjectManager(f.p.path),
    threads = new ThreadDataStore(projects, f.p.path, {
      profileId: 'profile-a',
      allowLegacyProjectData: false
    })
  projects.setThreadStore(threads)
  const materializer = new MmsBotMaterializer({
    profileId: 'profile-a',
    profileHome: f.p.path,
    threads,
    projects
  })
  f.adapters.set('fixture', runtime)
  f.registry.configure(
    {
      ...f.registry.get(f.space.space, f.bot)!,
      profileDigest: effectiveBotPolicyDigest(definition, 'chat')
    },
    f.p.clock.now()
  )
  f.registry.qualify(f.space.space, f.bot, 'v1', effectiveBotPolicyDigest(definition, 'chat'))
  const previous = f.service.options.output.plan.bind(f.service.options.output)
  f.service.options.output.plan = (mention) => ({
    ...previous(mention),
    ...materializer.plannedIds(mention)
  })
  const output = f.service.options
      .output as import('../../../../src/mms/bots/space/admission').BotOutbox,
    runner = new BotExecutionService({
      db: f.p.db,
      executions: f.executions,
      budgets: f.budgets,
      compartments: f.compartments,
      registry: f.registry,
      admission: f.service,
      output,
      materializer,
      adapters: f.registry.options.adapters,
      approvals: () => deniedBotApprovals
    })
  return {
    ...f,
    runner,
    threads,
    contexts,
    runtime,
    release: () => runtime.release(),
    get calls() {
      return runtime.runs.length
    }
  }
}
describe('bot execution with durable admission, spend, history and outcomes', () => {
  it('does not start a model after terminal host rejection of its accepted receipt', async () => {
    const f = await runtimeFixture(),
      record = f.service.admit(f.message()).record,
      accepted = f.outbox
        .list(record.binding!.stream)
        .find((event) => decodeEnvelope(event.envelope).envelope.type === 'bot.run.accepted')!
    f.outbox.markFailed(accepted.id, 'forbidden')
    expect(await f.runner.start(record.id)).toMatchObject({
      state: 'failed',
      error: { code: 'not_started' }
    })
    expect(f.calls).toBe(0)
    expect(f.budgets.remaining(f.bot, f.space.space, f.p.clock.now())).toBe(1000)
    expect(f.outbox.list(record.binding!.stream)).toHaveLength(1)
  })
  it('cancels an already dispatched provider on acceptance rejection while reconciling its proven terminal charge', async () => {
    const f = await runtimeFixture(true),
      record = f.service.admit(f.message()).record,
      accepted = f.outbox
        .list(record.binding!.stream)
        .find((event) => decodeEnvelope(event.envelope).envelope.type === 'bot.run.accepted')!,
      run = f.runner.start(record.id)
    await vi.waitFor(() => expect(f.calls).toBe(1))
    f.outbox.markFailed(accepted.id, 'forbidden')
    f.release()
    expect(await run).toMatchObject({ state: 'cancelled' })
    expect(f.calls).toBe(1)
    expect(f.budgets.remaining(f.bot, f.space.space, f.p.clock.now())).toBe(990)
    expect(f.outbox.list(record.binding!.stream)).toHaveLength(1)
    expect(
      f.p.db.database.prepare('SELECT count(*) AS n FROM net_bot_terminal_pending').get()!.n
    ).toBe(1)
  })
  it('terminally fences already queued dependent receipts without touching another execution', async () => {
    const f = await runtimeFixture(),
      first = f.service.admit(f.message()).record,
      second = f.service.admit(f.message()).record,
      mention = f.service.mentionForExecution(first.id),
      progress = f.runner.options.output.prepareTerminal(
        mention,
        first.id,
        first.binding!,
        'bot.run.progress',
        { text: 'Already queued' }
      )
    f.p.db.transaction(() => f.runner.options.output.enqueueTerminal(first, progress))
    const accepted = f.outbox
      .list(first.binding!.stream)
      .find((entry) => decodeEnvelope(entry.envelope).envelope.type === 'bot.run.accepted')!
    f.outbox.markFailed(accepted.id, 'forbidden')
    expect(f.outbox.get(progress.id)?.state).toBe('failed')
    expect(f.outbox.due(first.binding!.stream)).toEqual([])
    expect(f.outbox.due(second.binding!.stream)).toHaveLength(1)
    expect(f.executions.get(second.id)?.state).toBe('accepted')
    expect(() =>
      f.runner.options.output.prepareTerminal(
        mention,
        first.id,
        first.binding!,
        'bot.run.completed',
        { text: 'Cannot overtake rejection' }
      )
    ).toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(f.calls).toBe(0)
  })
  it('materializes exactly one real backing thread, runs the native loop once, and atomically completes receipt/history/accounting', async () => {
    const f = await runtimeFixture(),
      input = f.message(),
      admitted = f.service.admit(input)
    expect(admitted.kind).toBe('admitted')
    const result = await f.runner.start(admitted.record.id)
    expect(result.state).toBe('completed')
    expect(result.result).toEqual({ text: 'Scoped bot answer', spentUnits: 10 })
    expect(f.calls).toBe(1)
    expect(f.threads.listThreads()).toHaveLength(1)
    expect(f.compartments.history(result.binding!.compartment, 100).map((t) => t.text)).toEqual([
      'Public mention',
      'Scoped bot answer'
    ])
    expect(f.budgets.remaining(f.bot, f.space.space, f.p.clock.now())).toBe(990)
    expect(
      f.p.db.database.prepare('SELECT active FROM net_bot_admission_slots').get()!.active
    ).toBe(0)
    expect(
      f.outbox
        .list(result.binding!.stream)
        .filter((e) => JSON.parse(Buffer.from(e.envelope).toString()).type === 'bot.run.completed')
    ).toHaveLength(1)
    expect(f.service.admit(input).kind).toBe('duplicate')
    await expect(f.runner.start(result.id)).rejects.toMatchObject({ code: 'conflict' })
    expect(f.calls).toBe(1)
  })
  it('recovers accepted/running rows without running any model and preserves unrelated Bridge admission', async () => {
    const f = await runtimeFixture(),
      accepted = f.service.admit(f.message()).record,
      running = f.service.admit(f.message()).record
    f.executions.transition(running.id, 'running', f.p.clock.now())
    f.budgets.authorizeCall(running.id, 'lost-response', 60)
    const bridge = f.executions.admit(
        { scope: f.p.identity.self()!.node, target: 'threads.create', trigger: newId('rpc') },
        'a'.repeat(64),
        f.p.clock.now()
      ).record,
      recovered = f.runner.recoverAfterRestart()
    expect(recovered).toHaveLength(2)
    expect(f.executions.get(accepted.id)).toMatchObject({
      state: 'failed',
      error: { code: 'not_started' }
    })
    expect(f.executions.get(running.id)).toMatchObject({ state: 'uncertain' })
    expect(f.executions.get(bridge.id)?.state).toBe('accepted')
    expect(f.budgets.remaining(f.bot, f.space.space, f.p.clock.now())).toBe(940)
    expect(f.calls).toBe(0)
    expect(f.runner.recoverAfterRestart()).toEqual([])
    expect(
      f.p.db.database.prepare('SELECT count(*) AS n FROM net_bot_terminal_pending').get()!.n
    ).toBe(2)
  })
  it('reopens the actual durable profile and converts lost in-flight work to uncertain without a model retry', async () => {
    const f = await runtimeFixture(),
      record = f.service.admit(f.message()).record
    f.executions.transition(record.id, 'running', f.p.clock.now())
    f.budgets.authorizeCall(record.id, 'lost-process-response', 60)
    f.p.store.close()
    f.p.db.close()
    const p = await profile(f.p.clock, 'Existing owner', f.p.path),
      executions = new SqliteExecutionLedger(p.db),
      budgets = new SqliteBudgetLedger(p.db),
      compartments = new SqliteCompartmentStore(p.db, 'profile-a'),
      registry = new SqliteBotRegistry({
        ...f.registry.options,
        db: p.db,
        identity: p.identity,
        keys: p.keys,
        meta: p.projection,
        budgets
      }),
      outbox = new BotOutbox({
        ...(f.service.options.output as BotOutbox).options,
        db: p.db,
        identity: p.identity,
        keys: p.keys,
        meta: p.projection,
        store: p.store,
        outbox: new SqliteOutbox(p.db)
      }),
      admission = new BotAdmissionService({
        ...f.service.options,
        db: p.db,
        identity: p.identity,
        store: p.store,
        meta: p.projection,
        registry,
        executions,
        budgets,
        compartments,
        output: outbox,
        confirmedMeta: () => ({
          head: p.store.head(f.space.meta),
          confirmedAtMonotonic: p.clock.monotonic()
        })
      }),
      runner = new BotExecutionService({
        ...f.runner.options,
        db: p.db,
        executions,
        budgets,
        compartments,
        registry,
        admission,
        output: outbox
      })
    expect(runner.recoverAfterRestart()).toMatchObject([{ id: record.id, state: 'uncertain' }])
    expect(f.calls).toBe(0)
    expect(budgets.remaining(f.bot, f.space.space, p.clock.now())).toBe(940)
    expect(p.db.database.prepare('SELECT active FROM net_bot_admission_slots').get()!.active).toBe(
      0
    )
    expect(runner.recoverAfterRestart()).toEqual([])
    await expect(runner.start(record.id)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('runs an actual sealed private compartment without public context/output, then refuses changed visibility policy', async () => {
    const f = await runtimeFixture(),
      self = f.p.identity.self()!,
      privateKeys = new SqlPrivateStreamKeys({
        database: f.p.db.database,
        keys: f.p.keys,
        node: self.node,
        user: self.user,
        spaceForStream: (stream) => f.p.store.getStream(stream)!.space!,
        transaction: (work) => f.p.db.transaction(work)
      }),
      privateService = new PrivateSpaceService({
        db: f.p.db,
        keys: f.p.keys,
        identity: f.p.identity,
        store: f.p.store,
        meta: f.p.projection,
        outbox: f.outbox,
        privateKeys,
        clock: f.p.clock
      }),
      created = privateService.prepareCreation(f.space.space, f.parent, [self.user, f.bot]),
      control = f.p.store.appendAsAuthority(created.descriptor.id, {
        ...created.event,
        recvTs: f.p.clock.now()
      })
    privateService.applyStored(created.descriptor, { ...created.event, ...control }, 'live')
    f.p.host.postMeta(f.space.space, 'bot.policyChanged', {
      bot: f.bot,
      policy: { steer: { kind: 'everyone' }, visibility: 'private' }
    })
    const previous = f.service.options.output.plan.bind(f.service.options.output),
      privateOutput = new BotOutbox({
        ...(f.service.options.output as BotOutbox).options,
        private: privateService,
        privateKeys,
        plan: (mention) => ({
          ...previous(mention),
          stream: created.descriptor.id,
          compartment: f.compartments.privateId(f.bot, created.descriptor.id, 1),
          visibilityEpoch: 1,
          participantHash: createHash('sha256')
            .update(
              canonicalJson(privateService.state(created.descriptor.id)!.control.participants)
            )
            .digest('base64url')
        })
      })
    f.service.options.private = privateService
    f.service.options.output = privateOutput
    f.runner.options.output = privateOutput
    const record = f.service.admit(f.message()).record
    f.compartments.appendTurn(record.binding!.compartment, {
      role: 'user',
      text: 'PRIVATE COMPARTMENT SECRET',
      ts: f.p.clock.now()
    })
    expect((await f.runner.start(record.id)).state).toBe('completed')
    expect(JSON.stringify(f.contexts)).toContain('PRIVATE COMPARTMENT SECRET')
    const events = f.outbox
      .list(created.descriptor.id)
      .filter((event) => decodeEnvelope(event.envelope).envelope.type.startsWith('bot.run.'))
    expect(events.length).toBeGreaterThanOrEqual(2)
    for (const event of events) {
      expect(Buffer.from(event.envelope).toString()).not.toContain('PRIVATE COMPARTMENT SECRET')
      expect(decodeEnvelope(event.envelope).envelope.body).toBeUndefined()
    }
    const another = f.service.admit(f.message()).record
    f.p.host.postMeta(f.space.space, 'bot.policyChanged', {
      bot: f.bot,
      policy: { steer: { kind: 'everyone' }, visibility: 'public' }
    })
    expect(() => f.service.assertExecutionCurrent(another.id)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    expect(f.calls).toBe(1)
  })

  it('retains capacity while the actual provider ignores abort and refuses a false stop acknowledgement', async () => {
    const f = await runtimeFixture(true),
      record = f.service.admit(f.message()).record,
      run = f.runner.start(record.id)
    await vi.waitFor(() => expect(f.calls).toBe(1))
    f.runner.cancel(record.id)
    expect(await run).toMatchObject({ state: 'uncertain', error: { code: 'outcome_uncertain' } })
    expect(
      f.p.db.database.prepare('SELECT active FROM net_bot_admission_slots').get()!.active
    ).toBe(1)
    expect(f.p.db.database.prepare('SELECT spent FROM net_budget_calls').get()!.spent).toBeNull()
    expect(
      JSON.parse(
        f.p.db.database.prepare('SELECT evidence FROM net_bot_failure_evidence').get()!
          .evidence as string
      ).quiesced
    ).toBe(false)
    await expect(f.runner.stop(f.space.space, f.bot)).rejects.toMatchObject({
      code: 'outcome_uncertain'
    })
    f.release()
    await vi.waitFor(() =>
      expect(f.p.db.database.prepare('SELECT spent FROM net_budget_calls').get()!.spent).toBe(10)
    )
    expect(f.calls).toBe(1)
  }, 10000)
})
