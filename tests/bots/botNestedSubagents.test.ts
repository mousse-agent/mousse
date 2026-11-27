/**
 * A bot's work subagents nest at any depth (docs/plans/tool-api.md §2.8, "Nesting"; issue #1454 slice S5): a subagent
 * starts its own through the same bot port, held within what it holds and the grant now, under the work's chain and
 * counts. Each shows under its parent in the tree, each parent names and hears only its own, a Stop at any level ends
 * everything below it, and the owner's correction of the work reaches every depth. Real bots.db and run database,
 * through the engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { botInstructions } from '../../src/mms/bots/instructions'
import { chainIdOf } from '../../src/mms/run/AgentChains'
import { buildSubagentView } from '../../src/mms/run/delegation/subagentView'
import { Inbox } from '../../src/mms/run/Inbox'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { botFixture, createBot, finish, flush, start, startSubagent, subagentRuns, type BotFixture } from './botFixture'

const app = (tool: string): NormalisedCall => ({ kind: 'app', tool, args: {} })

describe('a bot\'s subagents nest past one level', () => {
  let f: BotFixture
  let botId: string

  beforeEach(async () => {
    f = botFixture()
    f.host.instructions = (bot) => botInstructions(bot)
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Pip', description: 'Look things up for me.', reply: 'Hello.' })).botId
  })
  afterEach(() => {
    vi.restoreAllMocks()
    f.close()
  })

  /** Work, its subagent "Prices", and Prices' own subagent "Shops", each turn started. */
  async function family() {
    const activation = await f.bots.activate({ botId, input: 'Compare three vacuum cleaners.', clientRequestId: 'w1' })
    const job = { id: activation.id, ...(await start(f, activation.id)) }
    await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })
    const prices = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    expect(await prices.prepared.authority.subagents!.start({ title: 'Shops', brief: 'List the shops.' })).toMatchObject({ started: { subagent: 'Shops', state: 'running' } })
    const shops = await startSubagent(f, subagentRuns(f, job.id)[1]!)
    return { job, prices, shops }
  }

  const tree = (threadId: string) => buildSubagentView({ delegations: f.runs.delegations, inbox: new Inbox(f.runs.store), store: f.runs.store, thread: (id) => ({ name: id }), hasPendingQuestion: () => false }, threadId)
  const named = (answer: { subagents: Array<{ subagent: string }> } | { refused: string }) => 'refused' in answer ? answer : answer.subagents.map((view) => view.subagent)

  it('a subagent starts its own, two levels down: each hangs from its parent\'s run and shows under its thread, in the work\'s chain', async () => {
    const made = vi.spyOn(f.host.threads, 'ensureExecutionThread')
    const { job, prices, shops } = await family()
    // Its tools offer it, as the work's do.
    expect(prices.prepared.policy.tools!.allow).toEqual(expect.arrayContaining(['subagent_start', 'model_list']))
    const delegation = f.runs.delegations.getByChildRun(shops.payload.runId)!
    expect(delegation).toMatchObject({ parentRunId: prices.payload.runId, parentThreadId: prices.payload.threadId, bot: { botId, rootActivationId: job.id } })
    expect(f.runs.delegations.getLineage(shops.payload.threadId)).toMatchObject({ parentThreadId: prices.payload.threadId, relationship: 'subagent' })
    expect(made.mock.calls.at(-1)![3]).toEqual({ parentTaskId: prices.payload.threadId })
    // In the tree: Prices under the work, Shops under Prices only.
    expect(tree(job.payload.threadId).map((row) => row.childThreadId)).toEqual([prices.payload.threadId])
    expect(tree(prices.payload.threadId).map((row) => row.childThreadId)).toEqual([shops.payload.threadId])
    // The work's chain, so nesting draws on the same budget and hold.
    expect(chainIdOf(f.runs.store, shops.payload.runId)).toBe(chainIdOf(f.runs.store, job.payload.runId))
    // And a third level, on the work's counts.
    expect(await shops.prepared.authority.subagents!.start({ title: 'Branch', brief: 'Check one branch.' })).toHaveProperty('started')
    const branch = await startSubagent(f, subagentRuns(f, job.id)[2]!)
    expect(f.runs.delegations.getByChildRun(branch.payload.runId)).toMatchObject({ parentRunId: shops.payload.runId })
    const before = f.store.counters(job.id).inputTokens
    branch.prepared.usage!({ input: 700, output: 10, cacheRead: 0, cacheWrite: 0 })
    expect(f.store.counters(job.id).inputTokens).toBe(before + 700)
  })

  it('each parent names and hears only its own subagents, and a result goes to the one that started it', async () => {
    const { job, prices, shops } = await family()
    const work = job.prepared.authority.subagents!
    const mid = prices.prepared.authority.subagents!
    expect(named(work.result({}))).toEqual(['Prices'])
    expect(named(mid.result({}))).toEqual(['Shops'])
    expect(await work.send({ subagent: 'Shops', message: 'Faster.' })).toMatchObject({ refused: expect.stringMatching(/no subagent called "Shops"/) })
    expect(work.stop({ subagent: 'Shops' })).toHaveProperty('refused')
    // A title is its parent's: Prices may call one of its own "Prices".
    expect(await mid.start({ title: 'Prices', brief: 'Prices at one shop.' })).toHaveProperty('started')
    await finish(f, shops.payload, 'completed', { text: 'Shop A, Shop B.' })
    // Prices hears of it at its next step, once; the work does not.
    const steer = prices.prepared.steer!
    expect(steer.peek()).toMatch(/Your subagent "Shops" finished/)
    expect(job.prepared.steer?.peek() ?? '').not.toMatch(/Shops/)
    const taken = steer.take()!
    steer.accepted(taken.token)
    expect(steer.peek()).toBeUndefined()
    expect(mid.result({ subagent: 'Shops' })).toMatchObject({ subagents: [{ subagent: 'Shops', state: 'done', result: 'Shop A, Shop B.' }] })
  })

  it('a Stop at any level ends everything below it, and a subagent\'s own subagents end with its turn', async () => {
    const { job, prices, shops } = await family()
    // The person's Stop on Prices' row: Shops below it ends too; the work goes on.
    const stopped = f.runs.stopSubtree({ threadId: prices.payload.threadId, reason: 'user', clientRequestId: 'stop-mid' })
    expect(stopped.activeRuns.map((run) => run.runId).sort()).toEqual([prices.payload.runId, shops.payload.runId].sort())
    for (const turn of [prices, shops]) expect(f.runs.getRun(turn.payload.runId)!.outcome?.stopRequested).toBe(true)
    expect(f.runs.getRun(job.payload.runId)!.outcome?.stopRequested).toBeFalsy()

    // Another subagent finishes while its own still works: the one below is stopped with it.
    await job.prepared.authority.subagents!.start({ title: 'Reviews', brief: 'Find reviews.' })
    const reviews = await startSubagent(f, subagentRuns(f, job.id).at(-1)!)
    await reviews.prepared.authority.subagents!.start({ title: 'Forum', brief: 'Read one forum.' })
    const forum = await startSubagent(f, subagentRuns(f, job.id).at(-1)!)
    await finish(f, reviews.payload, 'completed', { text: 'Mixed.' })
    expect(f.stopped).toContain(forum.payload.threadId)
  })

  it('the owner\'s correction of the work reaches every depth through the port: a running one at its next step, one started later at its start', async () => {
    const { job, prices, shops } = await family()
    shops.prepared.steer!.attached()
    const sent = f.bots.tools.work.noteSubagents!(botId, job.id, 'Only ones under 300.')
    expect(sent.map((entry) => entry.subagent).sort()).toEqual(['Prices', 'Shops'])
    expect(shops.prepared.steer!.peek()).toContain('Only ones under 300.')
    // Started by Prices after the correction: it starts with it.
    await prices.prepared.authority.subagents!.start({ title: 'Late', brief: 'One more shop.' })
    const late = await startSubagent(f, subagentRuns(f, job.id).at(-1)!)
    expect(late.prepared.prompt).toContain('Only ones under 300.')
    expect(late.prepared.prompt).not.toMatch(/The person told/)
  })

  describe('refusals', () => {
    it('without the bot port a subagent\'s own subagent never starts, and nothing is written', async () => {
      const { job, prices } = await family()
      const before = subagentRuns(f, job.id)
      f.runs.setBotPort(null)
      expect(await prices.prepared.authority.subagents!.start({ title: 'More', brief: 'More shops.' })).toMatchObject({ refused: expect.stringMatching(/Bots are not running here/) })
      expect(subagentRuns(f, job.id)).toEqual(before)
    })

    it('the port admits only a running subagent of the same work as a parent', async () => {
      const { job, prices, shops } = await family()
      const ask = (parentRunId: string) => f.bots.authorizeSubagent({ botId, rootActivationId: job.id, parentRunId })
      expect(ask(shops.payload.runId)).toEqual({ ok: true })
      expect(ask('run-of-nobody')).toMatchObject({ ok: false })
      await finish(f, shops.payload, 'completed', { text: 'Shop A.' })
      expect(ask(shops.payload.runId)).toMatchObject({ ok: false })
      expect(await prices.prepared.authority.subagents!.start({ title: 'Again', brief: 'x' })).toHaveProperty('started')
    })

    it('a permission removed mid-run applies at every depth\'s next call, and nobody below asks the owner for it', async () => {
      const { job, prices, shops } = await family()
      for (const turn of [job, prices, shops]) expect(turn.prepared.authority.check(app('web_search'))).toEqual({ ok: true })
      f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, appTools: manifest.appTools.filter((tool) => tool !== 'web_search') }))
      await flush()
      for (const turn of [prices, shops]) {
        expect(turn.prepared.authority.check(app('web_search'))).toMatchObject({ ok: false })
        expect(turn.prepared.authority.check(app('web_fetch'))).toEqual({ ok: true })
      }
      expect(f.store.escalations({ botId })).toEqual([])
      // A child started by Prices now holds what is left: its turn is compiled without it.
      await prices.prepared.authority.subagents!.start({ title: 'After', brief: 'Search again.' })
      const effect = f.outbox.listForRun(subagentRuns(f, job.id).at(-1)!).find((entry) => entry.kind === 'turn.start')!
      await f.bots.refresh(effect.payload as never)
      expect(f.bots.prepare(effect.payload as never)).toMatchObject({ code: 'bot_grant_revoked' })
    })
  })
})
