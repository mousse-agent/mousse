/**
 * A bot's subagents on the owner's other entries are never held less tightly than their work (docs/bots.md, "Subagents
 * of work"), and end, count and are checked with it: on a real `bots.db` and run database, through the engine.
 *
 * The inputs (test-the-claim §4):
 * - entries: the work's own; another on the same runtime; one whose runtime holds commands less tightly; one that
 *   searches the web whatever the bot holds;
 * - what the work's turn holds: commands, file access, the web; an Allow given while the turn runs;
 * - endings: the report with a subagent mid-command, mid-file-change or idle; the owner's Stop; the deadline; the bot
 *   deleted; Run commands or Use files switched off (a cut-off call under the subagent's own entry's names);
 * - counts: the work's time with subagents running, and the bot's day;
 * - a follow-up (`subagent_send`) after the model's entry reached its usage limit, or the work moved model.
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botInstructions } from '../../src/mms/bots/instructions'
import { toolArgsDigest } from '../../src/mms/run/tools/argsDigest'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { BOT_COMPUTER_OPEN, type BotComputerLimit } from '../../src/shared/bots/personal/computerLimit'
import { MAX_BOT_SUBAGENTS_PER_DAY } from '../../src/shared/bots/personal/manifest'
import type { BotModelOption } from '../../src/shared/bots/personal/methods'
import type { BotRuntimeHold } from '../../src/shared/bots/personal/subagentHold'
import { appToolRegistry, appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import { delegationFixture } from '../run/delegationFixture'
import { botFixture, chatOf, createBot, finish, flush, PI, start, type BotFixture } from './botFixture'

const command: NormalisedCall = { kind: 'builtin', tool: 'shell', nativeName: 'bash', args: { command: 'ls' } }
const write = (path: string): NormalisedCall => ({ kind: 'builtin', tool: 'write', nativeName: 'write', args: { path } })

describe('a subagent on another entry is never held less tightly than its work', () => {
  let f: BotFixture
  let botId: string
  let limit: BotComputerLimit
  /** The work's own entry runs Claude Code in its sandbox here (Linux); "Second Claude" too; "Cheap Router" is Pi. */
  const PIONLY = { instanceId: 'pi:cheap', model: 'cheap/model' }
  const SECOND = { instanceId: 'claude:second', model: 'second/model' }
  const choices: BotModelOption[] = [
    { instanceId: PI.instanceId, entry: 'OpenRouter', model: PI.model, label: 'Some Model', efforts: [] },
    { instanceId: PIONLY.instanceId, entry: 'Cheap Router', model: PIONLY.model, label: 'Cheap Model', efforts: ['low'] },
    { instanceId: SECOND.instanceId, entry: 'Second Claude', model: SECOND.model, label: 'Second Model', efforts: [] }
  ]
  const cheap = { pick: { ...PIONLY }, name: { name: 'Cheap Model', entry: 'Cheap Router' } }
  const second = { pick: { ...SECOND }, name: { name: 'Second Model', entry: 'Second Claude' } }
  let holds: Record<string, BotRuntimeHold>

  beforeEach(async () => {
    f = botFixture()
    limit = { ...BOT_COMPUTER_OPEN }
    holds = { [PI.instanceId]: { runtime: 'claude', sandbox: 'available' }, [SECOND.instanceId]: { runtime: 'claude', sandbox: 'available' }, [PIONLY.instanceId]: { runtime: 'pi' } }
    f.host.computerLimit = () => limit
    f.host.platform = 'linux'
    f.host.instructions = (bot) => botInstructions(bot)
    f.host.modelOptions = async () => choices
    f.host.harness.botHold = (instanceId) => holds[instanceId]
    // Each entry names its built-ins its own way, so a turn shows which runtime it was compiled for.
    const prefix: Record<string, string> = { [PIONLY.instanceId]: 'cheap_', [SECOND.instanceId]: 'second_' }
    f.host.harness.nativeToolNames = (instanceId, tools) => ({ ok: true, names: tools.flatMap((tool) => [...(PI_NATIVE_TOOLS[tool] ?? [tool])].map((name) => `${prefix[instanceId] ?? ''}${name}`)) })
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Pip', description: 'Look things up for me.', reply: 'Hello.' })).botId
  })
  afterEach(() => f.close())

  /** A piece of work on its first turn; `shell` and `files`: allowed for this work ("Allow this time"). */
  async function work(id: string, options: { shell?: boolean; files?: boolean } = {}) {
    const activation = await f.bots.activate({ botId, input: 'Compare three vacuum cleaners.', clientRequestId: id })
    if (options.shell) f.store.putOverlay(activation.id, `once-shell-${id}`, { tool: 'shell' })
    if (options.files) f.store.putOverlay(activation.id, `once-files-${id}`, { path: f.base, access: 'write' })
    return { id: activation.id, ...(await start(f, activation.id)) }
  }
  const subagentNs = (activationId: string) => f.store.dispatches(activationId).filter((dispatch) => dispatch.kind === 'subagent').map((dispatch) => dispatch.n)
  const attemptOf = (runId: string) => f.runs.getRun(runId)!.activeAttemptId!

  it('on an entry that holds commands less tightly it runs without them: no command tool, refused at the call, it is told, the work is told, work_models and the work line say so', async () => {
    const job = await work('w1', { shell: true })
    const subagents = job.prepared.authority.subagents!
    // work_models marks the entry before anything starts; the work's own runtime is left unmarked.
    expect(subagents.holdOn!(choices.map((option) => option.instanceId))).toEqual({ [PIONLY.instanceId]: { lacks: ['run commands'] } })
    const started = await subagents.start({ title: 'Reviews', brief: 'Find reviews.', model: cheap })
    expect(started).toMatchObject({ started: { subagent: 'Reviews', model: 'Cheap Model on Cheap Router' }, lacks: ['run commands'], note: expect.stringMatching(/It can't run commands there: Cheap Router would hold that less tightly than your own entry/) })
    const child = await start(f, job.id, subagentNs(job.id)[0])
    expect(child.prepared.policy.tools!.allow).toContain('cheap_read')
    expect(child.prepared.policy.tools!.allow).not.toContain('cheap_bash')
    expect(child.prepared.authority.check(command)).toMatchObject({ ok: false })
    expect(child.prepared.instructions).toContain('You can\'t run commands in this job: you run on another provider than the work that started you')
    expect(f.bots.service.get(botId).summary.work!.find((item) => item.id === job.id)!.subagents).toEqual([{ title: 'Reviews', model: 'Cheap Model on Cheap Router', lacks: ['run commands'] }])
    // The control: on another entry of the work's own runtime it keeps commands, and runs them.
    expect(await subagents.start({ title: 'Prices', brief: 'Find prices.', model: second })).not.toHaveProperty('lacks')
    const priced = await start(f, job.id, subagentNs(job.id)[1])
    expect(priced.prepared.authority.check(command)).toEqual({ ok: true })
    expect(priced.prepared.policy.tools!.allow).toContain('second_bash')
    // work_models, as the work's model reads it through the app tools.
    const fx = delegationFixture()
    try {
      const parentRun = await fx.runningRun(job.payload.threadId)
      const { registry, turns, request } = appToolRegistry(fx.engine, fakeAppToolHost().host, { bots: () => ({ host: f.bots.tools, models: { pickable: async () => choices } }) })
      turns.register(appTurn({ threadId: job.payload.threadId, runId: parentRun.runId, bot: job.prepared.authority }))
      const listed = await registry.call('work_models', {}, request({ threadId: job.payload.threadId, runId: parentRun.runId }))
      expect(listed.isError, listed.text).toBeFalsy()
      const entries = JSON.parse(listed.text).entries as Array<{ instanceId: string; subagentLacks?: string[] }>
      expect(entries.find((entry) => entry.instanceId === PIONLY.instanceId)?.subagentLacks).toEqual(['run commands'])
      expect(entries.find((entry) => entry.instanceId === SECOND.instanceId)).not.toHaveProperty('subagentLacks')
    } finally {
      fx.dispose()
    }
  })

  it('a power its entry can\'t run without refuses the start, names the entries that would do, and nothing starts', async () => {
    // The work has no web; a runtime that searches the web whatever the bot holds can't hold a subagent of it.
    f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, appTools: manifest.appTools.filter((tool) => tool !== 'web_search' && tool !== 'web_fetch') }))
    holds[PIONLY.instanceId] = { runtime: 'codex', hostedSearch: 'always' }
    const job = await work('w1')
    const subagents = job.prepared.authority.subagents!
    expect(await subagents.start({ title: 'Reviews', brief: 'Find reviews.', model: cheap })).toEqual({ refused: expect.stringMatching(/^A subagent can't run on Cheap Router: you have no web, and a subagent there would still search the web on its own\. These would do: OpenRouter, Second Claude\. Nothing was started\.$/) })
    expect(subagentNs(job.id)).toEqual([])
    expect(subagents.holdOn!([PIONLY.instanceId])).toEqual({ [PIONLY.instanceId]: { refused: expect.stringMatching(/no web/) } })
    // The control: a Codex that switches its search off for a bot without the web (every checked one) starts.
    holds[PIONLY.instanceId] = { runtime: 'codex', hostedSearch: 'off_without_web' }
    expect(await subagents.start({ title: 'Reviews', brief: 'Find reviews.', model: cheap })).toHaveProperty('started')
  })

  it('it holds what the work\'s turn holds: an Allow given while the turn runs is not its, and Run commands switched off stops neither', async () => {
    const job = await work('w1')
    // Allowed for this work while its first turn runs: the turn gets it at its next turn, and so does a subagent.
    f.store.putOverlay(job.id, 'later', { tool: 'shell' })
    await job.prepared.authority.subagents!.start({ title: 'Look', brief: 'List the folder.' })
    const child = await start(f, job.id, subagentNs(job.id)[0])
    expect(child.prepared.policy.tools!.allow).not.toContain('bash')
    expect(child.prepared.authority.check(command)).toMatchObject({ ok: false })
    // What it holds is recorded like its work's: neither holds commands, so the switch stops neither.
    limit = { ...limit, shell: false }
    f.bots.computerLimitChanged()
    expect(job.prepared.authority.time.signal.aborted).toBe(false)
    expect(child.prepared.authority.time.signal.aborted).toBe(false)
  })

  // Run commands or Use files switched off stops the work and its subagent on another entry; the call the subagent had
  // in flight is matched by that entry's names, and only what the switch took away is cleared.
  it.each([
    ['a command, Run commands off', 'shell', 'second_bash', false],
    ['a file change outside the bot\'s folders, Use files off', 'files', 'second_write', false],
    ['a file change, Run commands off (another power: it holds)', 'shell', 'second_write', true]
  ] as const)('a switch turned off: %s', async (_name, which, tool, holdsWork) => {
    const job = await work('w1', { shell: true, files: true })
    await job.prepared.authority.subagents!.start({ title: 'Builder', brief: 'Build it.', model: second })
    const builder = await start(f, job.id, subagentNs(job.id)[0])
    const outside = join(f.base, 'notes.md')
    expect(builder.prepared.authority.check(write(outside))).toEqual({ ok: true })
    f.runs.tools.start({ invocationId: 'inv-sub', runId: builder.payload.runId, attemptId: attemptOf(builder.payload.runId), tool, argsDigest: toolArgsDigest(tool === 'second_bash' ? { command: 'make' } : { path: outside }), now: 'n', idempotent: false })
    limit = { ...limit, [which]: false }
    f.bots.computerLimitChanged()
    expect(job.prepared.authority.time.signal.aborted).toBe(true)
    expect(builder.prepared.authority.time.signal.aborted).toBe(true)
    await finish(f, builder.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    await finish(f, job.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    if (holdsWork) expect(f.store.activation(job.id)).toMatchObject({ status: 'paused', endReason: 'unknown_calls' })
    else {
      expect(f.store.activation(job.id)!.status).toBe('running')
      const next = await start(f, job.id, f.store.lastMainDispatch(job.id)!.n)
      expect(next.prepared.prompt).toMatch(new RegExp(`Interrupted tool calls .*${tool} \\(subagent run`, 's'))
    }
  })

  // The report while a subagent runs: the work ends done, its report names the subagent it stopped, and says on hover
  // whether one was cut in the middle of a command or a file change.
  it.each([
    ['in the middle of a command', 'bash', /Look was in the middle of a command: its last step may not have completed\./],
    ['in the middle of a file change', 'write', /Look was in the middle of a file change: its last step may not have completed\./],
    ['between steps', undefined, /They were still working when I reported\./]
  ] as const)('the work reports while a subagent is %s: done, with the stopped subagent named', async (_name, tool, title) => {
    const job = await work('w1', { shell: true })
    await job.prepared.authority.subagents!.start({ title: 'Look', brief: 'Look around.' })
    const look = await start(f, job.id, subagentNs(job.id)[0])
    if (tool) f.runs.tools.start({ invocationId: 'inv-look', runId: look.payload.runId, attemptId: attemptOf(look.payload.runId), tool, argsDigest: 'd', now: 'n', idempotent: false })
    await finish(f, job.payload, 'completed', { text: 'Here is what I found.' })
    expect(f.stopped).toContain(look.payload.threadId)
    await finish(f, look.payload, 'interrupted', { outcome: { interruptedBy: 'user' } })
    expect(f.store.activation(job.id)).toMatchObject({ status: 'done' })
    const report = chatOf(f, botId).filter((message) => message.kind === 'run_report').at(-1)!
    expect(report.text).toBe('Here is what I found.')
    expect(report.chips).toContainEqual(expect.objectContaining({ text: 'stopped a subagent early', highlight: 'Look', title: expect.stringMatching(title) }))
    expect(chatOf(f, botId).some((message) => message.kind === 'error')).toBe(false)
  })

  it('the work\'s own interrupted call still holds it for the owner after it reports', async () => {
    const job = await work('w1', { shell: true })
    await job.prepared.authority.subagents!.start({ title: 'Look', brief: 'Look around.' })
    const look = await start(f, job.id, subagentNs(job.id)[0])
    f.runs.tools.start({ invocationId: 'inv-own', runId: job.payload.runId, attemptId: attemptOf(job.payload.runId), tool: 'bash', argsDigest: 'd', now: 'n', idempotent: false })
    await finish(f, job.payload, 'completed', { text: 'Here.' })
    await finish(f, look.payload, 'interrupted', { outcome: { interruptedBy: 'user' } })
    expect(f.store.activation(job.id)).toMatchObject({ status: 'paused', endReason: 'unknown_calls' })
  })

  it.each(['the owner\'s Stop', 'the deadline', 'the bot deleted'] as const)('%s with a subagent running ends it with the work', async (how) => {
    f.host.quiesceTimeoutMs = 200
    const job = await work('w1')
    await job.prepared.authority.subagents!.start({ title: 'Slow', brief: 'Take your time.' })
    const slow = await start(f, job.id, subagentNs(job.id)[0])
    let removing: Promise<unknown> | undefined
    if (how === 'the owner\'s Stop') await f.bots.stop(job.id)
    else if (how === 'the deadline') f.timers.at(-1)!.fn()
    else {
      removing = f.bots.remove(botId).catch((error: unknown) => error)
      await flush()
    }
    // It shares the work's stop: its turn ends at once, and the work's settle stops its run.
    expect(slow.prepared.authority.time.signal.aborted).toBe(true)
    await finish(f, job.payload, 'interrupted', { outcome: { interruptedBy: how === 'the deadline' ? 'bot_wall' : 'user' } })
    expect(f.stopped).toContain(slow.payload.threadId)
    await finish(f, slow.payload, 'interrupted', { outcome: { interruptedBy: 'user' } })
    await removing
    expect(f.store.dispatch(job.id, subagentNs(job.id)[0]!)!.endedAt).not.toBeNull()
    expect(f.store.activation(job.id)!.status).not.toBe('running')
  })

  it('its running time counts against the work\'s: the deadline comes closer while it runs, and its time is charged', async () => {
    const job = await work('w1')
    const allowance = f.store.dispatch(job.id, 1)!.deadlineMs!
    const before = f.store.counters(job.id).activeMs
    await job.prepared.authority.subagents!.start({ title: 'Half', brief: 'Do half.' })
    const half = await start(f, job.id, subagentNs(job.id)[0])
    // Two running now: what is left goes twice as fast, so the work's deadline is half its allowance away.
    expect(f.timers.at(-1)!.ms).toBe(Math.floor(allowance / 2))
    f.clock.now += 10 * 60_000
    await finish(f, half.payload, 'completed', { text: 'Half done.' })
    // Its ten minutes are charged; the work alone again, its deadline is what is left after both.
    expect(f.store.counters(job.id).activeMs).toBe(before + 10 * 60_000)
    expect(f.timers.at(-1)!.ms).toBe(allowance - 20 * 60_000)
    f.clock.now += 60_000
    await finish(f, job.payload, 'completed', { text: 'Done.' })
    expect(f.store.counters(job.id).activeMs - (before - allowance)).toBe(21 * 60_000)
  })

  it(`counts the bot's subagents per day: ${MAX_BOT_SUBAGENTS_PER_DAY} across its work, then none until a day has passed`, async () => {
    let started = 0
    for (let w = 0; started < MAX_BOT_SUBAGENTS_PER_DAY; w += 1) {
      const job = await work(`w${w}`)
      for (let k = 0; k < 10 && started < MAX_BOT_SUBAGENTS_PER_DAY; k += 1) {
        expect(await job.prepared.authority.subagents!.start({ title: `Part ${k}`, brief: 'Do it.' }), `${started}`).toHaveProperty('started')
        await finish(f, (await start(f, job.id, subagentNs(job.id).at(-1)!)).payload, 'completed', { text: 'Done.' })
        started += 1
      }
      await finish(f, job.payload, 'completed', { text: 'Done.' })
    }
    const next = await work('over')
    expect(await next.prepared.authority.subagents!.start({ title: 'One more', brief: 'Do it.' })).toMatchObject({ refused: expect.stringMatching(new RegExp(`started ${MAX_BOT_SUBAGENTS_PER_DAY} subagents in the last day`)) })
    await finish(f, next.payload, 'completed', { text: 'Done.' })
    f.clock.now += 24 * 60 * 60_000 + 1
    const tomorrow = await work('tomorrow')
    expect(await tomorrow.prepared.authority.subagents!.start({ title: 'One more', brief: 'Do it.' })).toHaveProperty('started')
  })

  it('subagent_send checks its model again: a named model now at its usage limit is refused, and one on the work\'s model runs on the model the work runs on now', async () => {
    const job = await work('w1')
    const subagents = job.prepared.authority.subagents!
    await subagents.start({ title: 'Reviews', brief: 'Find reviews.', model: second })
    await finish(f, (await start(f, job.id, subagentNs(job.id)[0])).payload, 'completed', { text: 'Done.' })
    await subagents.start({ title: 'Notes', brief: 'Take notes.' })
    await finish(f, (await start(f, job.id, subagentNs(job.id)[1])).payload, 'completed', { text: 'Done.' })
    const until = new Date(f.clock.now + 60 * 60_000).toISOString()
    f.limited.set(SECOND.instanceId, until)
    expect(await subagents.send({ subagent: 'Reviews', message: 'More.' })).toMatchObject({ refused: expect.stringMatching(/Second Model on Second Claude is at its usage limit.*Nothing was started/) })
    // The work's own entry reached its limit for this bot (kept by the engine), and the work moved: a follow-up on its
    // model goes to the model the work runs on now, never the stored one.
    f.store.setModel(botId, { ...(f.store.registry(botId)!.model ?? {}), limits: { [PI.instanceId]: { instanceId: PI.instanceId, until } } } as never)
    expect(await subagents.send({ subagent: 'Notes', message: 'More.' })).toMatchObject({ refused: expect.stringMatching(/at its usage limit/) })
    f.store.setActivationSelection(job.id, { ...SECOND })
    f.limited.delete(SECOND.instanceId)
    expect(await subagents.send({ subagent: 'Notes', message: 'More.' })).toMatchObject({ sent: { subagent: 'Notes', model: 'Second Model on Second Claude' } })
    expect(f.store.dispatch(job.id, subagentNs(job.id).at(-1)!)!.prompt.subagent!.selection).toEqual(SECOND)
  })
})
