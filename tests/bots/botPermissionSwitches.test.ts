/**
 * A bot's own permission switches (About → Can use): the only gate on what a bot may do. A permission switched off
 * gives the bot none of it: on the next call of a turn already running and on every later turn, in the chat, in work,
 * in a consult, a scheduled run, a reminder's work and a turn resumed after a restart. An ask for it makes no card and
 * the bot is told it is switched off; switching it on gives it back with no new ask. "Run commands" switched off also
 * stops a turn that started with it, and the work goes on in a new turn without it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotBrowserHost } from '../../src/mms/bots/activation/dispatcher'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { botInstructions } from '../../src/mms/bots/instructions'
import { BOT_AUTOMATION_APP_TOOLS, BOT_AUTOMATIONS_SWITCH, BOT_SKILLS_SWITCH } from '../../src/shared/bots/personal/manifest'
import { getDefaultSettings } from '../../src/shared/settings'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { appToolRegistry, appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import { delegationFixture } from '../run/delegationFixture'
import { botFixture, chatOf, createBot, finish, flush, payloadOf, start, type BotFixture } from './botFixture'

const SWITCHED_OFF = /switched.*off/
const command = (text: string): NormalisedCall => ({ kind: 'builtin', tool: 'shell', nativeName: 'bash', args: { command: text } })
const app = (tool: string): NormalisedCall => ({ kind: 'app', tool, args: {} })

describe('a bot\'s permission switches', () => {
  let f: BotFixture
  let botId: string
  const cards = () => chatOf(f, botId).filter((message) => message.ask)
  const line = (text: string | undefined, what: string) => text!.slice(text!.indexOf('What your owner allows now')).split('\n').find((row) => row.startsWith(`- ${what}`))
  const permissionId = (title: string) => f.bots.service.get(botId).permissions.find((item) => item.title === title)!.id
  const switchAllOff = () => { for (const item of f.bots.service.get(botId).permissions) f.bots.service.setPermission(botId, item.id, false) }

  beforeEach(async () => {
    f = botFixture()
    f.host.instructions = (bot) => botInstructions(bot)
    const browser: BotBrowserHost = {
      turn: () => ({ binding: { mode: 'structured' } as never, runtime: { resolveTarget: () => ({ backend: 'managed-chromium' }), dispatch: async () => ({}) } }),
      activationEnded: () => {}
    }
    f.host.browser = browser
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Pip', description: 'Look things up for me.', reply: 'Hello.' })).botId
  })
  afterEach(() => f.close())

  async function chat(text: string, id: string) {
    await f.bots.service.chatSend({ botId, text, clientRequestId: id })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    return { activation, ...(await start(f, activation.id)) }
  }

  /** A run of the bot's work lane, started by hand. */
  async function run(id: string) {
    const activation = await f.bots.activate({ botId, input: 'Check it.', clientRequestId: id })
    return { id: activation.id, ...(await start(f, activation.id)) }
  }

  /** The owner allows commands and the browser from work's cards. */
  async function allowAll() {
    const work = await run('grant')
    for (const permission of [{ tool: 'shell' }, { tool: 'browser' }])
      work.prepared.authority.escalate!({ permission, reason: 'The owner asked.' })
    await finish(f, work.payload, 'completed', { text: 'Asked.' })
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    expect(f.bots.service.get(botId).permissions.filter((item) => !item.builtIn).map((item) => item.title).sort()).toEqual(['run commands', 'use the browser'])
  }

  it('a bot switch stops commands, continues without them, and restores without a card; old builds see no power', async () => {
    await allowAll()
    const id = permissionId('run commands')
    const work = await run('switch-work')
    expect(work.prepared.authority.check(command('ls')).ok).toBe(true)
    f.bots.service.setPermission(botId, id, false)
    expect(work.prepared.authority.time.signal.aborted).toBe(true)
    expect(chatOf(f, botId).at(-1)).toMatchObject({ systemLine: true, author: 'bot' })
    expect(f.bots.service.get(botId).permissions.find((item) => item.id === id)?.enabled).toBe(false)
    // This is the query an older build uses; neither its grant nor the published definition contains commands.
    const old = f.store.get('SELECT manifest_json FROM bot_grants WHERE bot_id = ? AND revoked_at IS NULL ORDER BY grant_id DESC LIMIT 1', botId)!
    expect(JSON.parse(old.manifest_json as string).tools).not.toContain('shell')
    expect(f.bots.definitionOf(botId).permissions.tools).not.toContain('shell')
    await finish(f, work.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    const next = await start(f, work.id, 2)
    expect(next.prepared.policy.tools!.allow).not.toContain('bash')
    expect(next.prepared.authority.check(command('ls')).ok).toBe(false)
    expect(next.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Run it' })).toMatch(SWITCHED_OFF)
    expect(next.prepared.instructions).not.toContain('You can ask for "run commands"')
    await finish(f, next.payload, 'completed', { text: 'Skipped it.' })
    const before = cards().length
    f.bots.service.setPermission(botId, id, true)
    const again = await run('switch-again')
    expect(again.prepared.policy.tools!.allow).toContain('bash')
    expect(again.prepared.authority.check(command('ls')).ok).toBe(true)
    expect(cards()).toHaveLength(before)
    await finish(f, again.payload, 'completed', { text: 'Ran it.' })
    f.bots.service.setPermission(botId, id, false)
    f.bots.service.revokePermission(botId, id)
    expect(f.bots.service.get(botId).permissions.some((item) => item.id === id)).toBe(false)
    expect(() => f.bots.service.setPermission(botId, id, true)).toThrow()
  })

  it('a bot browser switch refuses an already running call and ask without stopping unrelated work', async () => {
    await allowAll()
    const id = permissionId('use the browser')
    const work = await run('browser-switch')
    expect(work.prepared.authority.check(app('browser_open')).ok).toBe(true)
    const before = cards().length
    f.bots.service.setPermission(botId, id, false)
    expect(work.prepared.authority.time.signal.aborted).toBe(false)
    expect(work.prepared.authority.check(app('browser_open')).ok).toBe(false)
    expect(work.prepared.authority.escalate!({ permission: { tool: 'browser' }, reason: 'Open it' })).toMatch(SWITCHED_OFF)
    expect(cards()).toHaveLength(before)
    expect(work.prepared.authority.check(command('ls')).ok).toBe(true)
    f.bots.service.setPermission(botId, id, true)
    expect(work.prepared.authority.check(app('browser_open')).ok).toBe(false)
    f.bots.service.setPermission(botId, id, false)
    f.bots.service.revokePermission(botId, id)
    expect(work.prepared.authority.check(app('browser_open')).ok).toBe(false)
    await finish(f, work.payload, 'completed', { text: 'Skipped the browser.' })
  })

  it('the browser switched off: running work\'s next browser call is refused through the app tools, and later turns get no browser', async () => {
    await allowAll()
    const work = await run('w1')
    expect(work.prepared.browser).toBeDefined()
    f.bots.service.setPermission(botId, permissionId('use the browser'), false)
    const fx = delegationFixture()
    try {
      const running = await fx.runningRun('bot-run')
      const { registry, turns, request } = appToolRegistry(fx.engine, fakeAppToolHost().host)
      // The turn as the orchestrator registers it: its bot authority and the browser it started with.
      turns.register(appTurn({ threadId: 'bot-run', runId: running.runId, bot: work.prepared.authority, browser: work.prepared.browser!.binding, browserRuntime: work.prepared.browser!.runtime }))
      const opened = await registry.call('browser_open', { url: 'https://example.com' }, request({ threadId: 'bot-run', runId: running.runId }))
      expect(opened).toMatchObject({ isError: true })
      expect((opened as { text: string }).text).toMatch(SWITCHED_OFF)
    } finally {
      fx.dispose()
    }
    await finish(f, work.payload, 'completed', { text: 'Done.' })
    const next = await run('w2')
    expect(next.prepared.browser).toBeUndefined()
    expect(next.prepared.policy.tools!.allow!.filter((name) => name.startsWith('browser_'))).toEqual([])
    await finish(f, next.payload, 'completed', { text: 'Done.' })
  })

  it('a disabled permission survives reopening the service and refuses an old Allow card', async () => {
    await allowAll()
    const id = permissionId('run commands')
    f.bots.service.setPermission(botId, id, false)
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    expect(f.bots.service.get(botId).permissions.find((item) => item.id === id)?.enabled).toBe(false)
    const work = await run('after-switch-restart')
    expect(work.prepared.policy.tools!.allow).not.toContain('bash')
    expect(work.prepared.authority.check(command('ls')).ok).toBe(false)
    expect(work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Run' })).toMatch(SWITCHED_OFF)
    await finish(f, work.payload, 'completed', { text: 'No command.' })
  })

  it('an old ask and Allow this time cannot restore a disabled permission', async () => {
    const work = await run('old-card')
    work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Run it.' })
    await finish(f, work.payload, 'completed', { text: 'Asked.' })
    const ask = f.store.openAsks(botId)[0]!
    // A card left by an older build, whose grant was widened without settling that card.
    const definition = f.bots.definitionOf(botId)
    const manifest = { ...definition.permissions, tools: [...definition.permissions.tools, 'shell' as const] }
    const revision = f.host.definitions.publishRevision({ ...definition, permissions: manifest })
    f.store.setPublished(botId, revision.revision!)
    f.store.approve(botId, botManifestDigest(manifest), manifest)
    const id = permissionId('run commands')
    f.bots.service.setPermission(botId, id, false)
    await expect(f.bots.service.answer(botId, ask.id, 'allow')).rejects.toMatchObject({ code: 'permission_off' })
    f.store.run("UPDATE bot_activations SET status = 'waiting_grant' WHERE id = ?", work.id)
    await expect(f.bots.respond({ escalationId: ask.id, answer: 'allow_once' })).rejects.toMatchObject({ code: 'permission_off' })
    f.store.run("UPDATE bot_activations SET status = 'done' WHERE id = ?", work.id)
    const later = await f.bots.activate({ botId, input: 'Run', clientRequestId: 'old-overlay' })
    f.store.putOverlay(later.id, 'old-overlay', { tool: 'shell' })
    const turn = await start(f, later.id)
    expect(turn.prepared.policy.tools!.allow).not.toContain('bash')
    expect(turn.prepared.authority.check(command('ls')).ok).toBe(false)
    await finish(f, turn.payload, 'completed', { text: 'Skipped.' })
  })

  it('every skill is on with nothing granted; skills switched off are neither listed nor loaded from a running turn, even by name, nor offered later', async () => {
    const work = await run('skill-work')
    const fx = delegationFixture()
    try {
      const running = await fx.runningRun('bot-skill')
      const descriptor = { id: 'review', installationId: 'inst-review', name: 'Review changes', description: 'Review', rootPath: '/skills/review', skillPath: '/skills/review/SKILL.md', scope: 'global' as const, source: 'mousse-profile' as const, managed: true }
      const result = { skill: descriptor, content: 'Review instructions' }
      const readSkillForModel = vi.fn(async () => result)
      const settings = getDefaultSettings().integrations.skills
      settings.enabledSkills = [descriptor.installationId]
      const { registry, turns, request } = appToolRegistry(fx.engine, fakeAppToolHost({
        skills: () => ({ readSkillForModel }) as never,
        skillSettings: () => settings
      }).host)
      turns.register(appTurn({ threadId: 'bot-skill', runId: running.runId, bot: work.prepared.authority, enabledSkills: [descriptor] }))
      const call = (name: string, args = {}) => registry.call(name, args, request({ threadId: 'bot-skill', runId: running.runId }))
      expect(f.store.activeGrant(botId)!.manifest.skills).toEqual([])
      expect(await call('skill_load', { skill: 'Review changes' })).toMatchObject({ text: 'Review instructions' })
      const reading = Promise.withResolvers<void>()
      const release = Promise.withResolvers<typeof result>()
      readSkillForModel.mockImplementationOnce(() => {
        reading.resolve()
        return release.promise
      })
      const inFlight = call('skill_load', { skill: 'Review changes' })
      await reading.promise
      f.bots.service.setPermission(botId, BOT_SKILLS_SWITCH, false)
      release.resolve(result)
      expect(await inFlight).toMatchObject({ isError: true })
      expect(await call('skill_list')).toMatchObject({ text: '[]' })
      expect(await call('skill_load', { skill: 'Review changes' })).toMatchObject({ isError: true })
      expect(readSkillForModel).toHaveBeenCalledTimes(2)
      expect(f.store.openAsks(botId)).toHaveLength(0)
    } finally { fx.dispose() }
    await finish(f, work.payload, 'completed', { text: 'Skipped the skill.' })
    const off = await run('skill-off')
    expect(off.prepared.policy.tools!.allow).not.toContain('skill_load')
    expect(off.prepared.authority.check({ kind: 'skill', skill: 'review' }).ok).toBe(false)
    expect(off.prepared.authority.escalate!({ permission: { skill: 'review' }, reason: 'Review' })).toMatch(SWITCHED_OFF)
    expect(line(off.prepared.instructions, 'Skills')).toMatch(SWITCHED_OFF)
    await finish(f, off.payload, 'completed', { text: 'Skipped.' })
    f.bots.service.setPermission(botId, BOT_SKILLS_SWITCH, true)
    const again = await run('skill-restored')
    expect(again.prepared.policy.tools!.allow).toContain('skill_load')
    expect(again.prepared.authority.check({ kind: 'skill', skill: 'review' }).ok).toBe(true)
    expect(f.store.openAsks(botId)).toHaveLength(0)
    await finish(f, again.payload, 'completed', { text: 'Reviewed.' })
  })

  it('the automation tools are on with nothing granted; switched off, a running turn\'s next call is refused and later turns are not offered them', async () => {
    const work = await run('automation-work')
    expect(work.prepared.policy.tools!.allow).toEqual(expect.arrayContaining([...BOT_AUTOMATION_APP_TOOLS]))
    expect(work.prepared.authority.check(app('automation_list')).ok).toBe(true)
    f.bots.service.setPermission(botId, BOT_AUTOMATIONS_SWITCH, false)
    expect(work.prepared.authority.check(app('automation_list'))).toMatchObject({ ok: false, refused: { text: expect.stringMatching(SWITCHED_OFF) } })
    expect(work.prepared.authority.escalate!({ permission: { tool: 'automation_draft_save' }, reason: 'Draft it' })).toMatch(SWITCHED_OFF)
    await finish(f, work.payload, 'completed', { text: 'Skipped.' })
    const off = await run('automation-off')
    for (const tool of BOT_AUTOMATION_APP_TOOLS) expect(off.prepared.policy.tools!.allow).not.toContain(tool)
    expect(line(off.prepared.instructions, 'Automation tools')).toMatch(SWITCHED_OFF)
    expect(f.bots.service.get(botId).permissions.find((item) => item.id === BOT_AUTOMATIONS_SWITCH)).toMatchObject({ enabled: false, builtIn: true })
    await finish(f, off.payload, 'completed', { text: 'Skipped.' })
    f.bots.service.setPermission(botId, BOT_AUTOMATIONS_SWITCH, true)
    const on = await run('automation-on')
    expect(on.prepared.policy.tools!.allow).toEqual(expect.arrayContaining([...BOT_AUTOMATION_APP_TOOLS]))
    expect(cards()).toHaveLength(0)
    await finish(f, on.payload, 'completed', { text: 'Done.' })
  })

  it.each(['web_search', 'web_fetch'] as const)('the %s row restores both the native and app tool with no ask', async (tool) => {
    const initial = await run('web-grant')
    initial.prepared.authority.escalate!({ permission: { tool }, reason: 'Use the web.' })
    await finish(f, initial.payload, 'completed', { text: 'Asked.' })
    // Older grants can hold the same web tool in both lists. Keep both when restoring it.
    const definition = f.bots.definitionOf(botId)
    const manifest = { ...definition.permissions, tools: [...definition.permissions.tools, tool] }
    const revision = f.host.definitions.publishRevision({ ...definition, permissions: manifest })
    f.store.setPublished(botId, revision.revision!)
    f.store.approve(botId, botManifestDigest(manifest), manifest)
    const item = f.bots.service.get(botId).permissions.find((item) => item.id.includes(tool))!
    f.bots.service.setPermission(botId, item.id, false)
    const off = await run('web-off')
    expect(off.prepared.authority.check(app(tool)).ok).toBe(false)
    expect(off.prepared.authority.check({ kind: 'builtin', tool, nativeName: tool, args: {} }).ok).toBe(false)
    await finish(f, off.payload, 'completed', { text: 'Skipped.' })
    const before = cards().length
    f.bots.service.setPermission(botId, item.id, true)
    const on = await run('web-on')
    expect(on.prepared.authority.check(app(tool)).ok).toBe(true)
    expect(on.prepared.authority.check({ kind: 'builtin', tool, nativeName: tool, args: {} }).ok).toBe(true)
    expect(cards()).toHaveLength(before)
    await finish(f, on.payload, 'completed', { text: 'Read it.' })
  })

  it('a consult is held to the switches too', async () => {
    await allowAll()
    const definitions = f.host.definitions
    const current = definitions.revision(botId, f.store.registry(botId)!.revision!)!
    const published = definitions.publishRevision({ ...current, context: [{ key: 'docs', title: 'Docs expert', agent: { instructions: 'You know the docs.' }, model: { mode: 'auto', depth: 'normal' } }] })
    f.store.setPublished(botId, published.revision!)
    switchAllOff()
    const turn = await chat('What does the doc say?', 'm1')
    const asked = turn.prepared.authority.consult!({ context: 'docs', question: 'What does it say?' })
    await flush()
    const consultN = f.store.dispatches(turn.activation.id).find((dispatch) => dispatch.kind === 'consult')!.n
    const consult = f.bots.prepare(payloadOf(f, turn.activation.id, consultN))
    if ('refused' in consult) throw new Error(consult.refused)
    expect(consult.authority.check(command('ls'))).toMatchObject({ ok: false })
    expect(consult.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To run it.' })).toMatch(SWITCHED_OFF)
    expect(consult.instructions).not.toContain('You can ask for "run commands"')
    void asked.catch(() => undefined)
  })

  /** What a turn that holds everything was prepared with, while the owner has everything switched off. */
  function heldToNothing(prepared: Awaited<ReturnType<typeof start>>['prepared']) {
    expect(prepared.policy.tools!.allow).not.toContain('bash')
    expect(prepared.policy.tools!.allow!.filter((name) => name.startsWith('browser_'))).toEqual([])
    expect(prepared.browser).toBeUndefined()
    expect(prepared.authority.check(command('ls')).ok).toBe(false)
  }

  it('a scheduled run and a reminder\'s work start held to the switches, with no card', async () => {
    await allowAll()
    const before = cards().length
    switchAllOff()
    const scheduled = f.bots.runScheduledOccurrence({ botId, scheduleId: 'sched-1', prompt: 'Tidy the notes.', occurrenceAt: new Date(f.clock.now).toISOString() })
    if (scheduled.kind !== 'started') throw new Error(`not started: ${scheduled.kind}`)
    await flush()
    const run = await start(f, scheduled.activationId)
    heldToNothing(run.prepared)
    expect(run.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To tidy.' })).toMatch(SWITCHED_OFF)
    await finish(f, run.payload, 'completed', { text: 'Tidied what I could.' })

    const turn = await chat('Remind me in a minute and check the weather then', 'm1')
    f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'Checking.', work: { title: 'Weather', brief: 'Check the weather.' } })
    await finish(f, turn.payload, 'completed', { text: 'I will.' })
    f.clock.now += 2 * 60_000
    await f.bots.deliverDueReminders()
    const reminderWork = f.store.laneActivations(botId, 'run', ['running']).find((row) => row.idempotencyKey.startsWith('reminder:'))!
    const reminded = await start(f, reminderWork.id)
    heldToNothing(reminded.prepared)
    await finish(f, reminded.payload, 'completed', { text: 'Checked.' })
    expect(cards()).toHaveLength(before)
  })

  it('a turn resumed after Mousse restarts is held to what the switches allow now', async () => {
    await allowAll()
    const work = await run('w1')
    expect(work.prepared.authority.check(command('ls'))).toEqual({ ok: true })
    // Mousse stops mid-turn; while it is down the owner switches everything off.
    f.runs.markTerminal(work.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    f.bots.close()
    switchAllOff()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush(12)
    const resumed = await start(f, work.id, 2)
    expect(resumed.prepared.prompt).toContain('Mousse restarted')
    heldToNothing(resumed.prepared)
    await finish(f, resumed.payload, 'completed', { text: 'Done what I could.' })
  })

  it('the bot is never told it has, or can ask for, what is switched off: its instructions and the answer to a wrong ask', async () => {
    await allowAll()
    const id = permissionId('use the browser')
    f.bots.service.setPermission(botId, id, false)
    const turn = await chat('Hello', 'm1')
    const text = turn.prepared.instructions!
    expect(text).not.toMatch(/With the browser|the browser,/)
    expect(line(text, 'Use the browser')).toMatch(/switched off by your owner/)
    // What is on is still offered.
    expect(text).toContain('You can ask for "run commands"')
    // An ask written wrongly is answered with what can be asked for, which is never file access.
    const answer = turn.prepared.authority.escalate!({ permission: { nonsense: true } as never, reason: 'x' })
    expect(answer).toMatch(/Ask for a tool, a limit/)
    expect(answer).not.toMatch(/file access|folder path/)
    await finish(f, turn.payload, 'completed', { text: 'Hi.' })
    // The control: with the browser on again, it is offered.
    f.bots.service.setPermission(botId, id, true)
    const again = await chat('Hello again', 'm2')
    expect(again.prepared.instructions).toMatch(/With the browser/)
    await finish(f, again.payload, 'completed', { text: 'Hi.' })
  })

  it('commands switched off: a turn that started with them stops at once, and the work goes on in a new turn without it', async () => {
    await allowAll()
    const work = await run('w1')
    const chatTurn = await chat('Hello', 'm1')
    const stopped = () => work.prepared.authority.time.signal.aborted
    // A command is running when the switch goes off: the stop cuts it off, its effect unknown.
    f.runs.tools.start({ invocationId: 'inv-bash', runId: work.payload.runId, attemptId: f.runs.getRun(work.payload.runId)!.activeAttemptId!, tool: 'bash', argsDigest: 'd', now: 'n', idempotent: false })
    // Commands off: the work started with them, so it stops now; the chat turn never holds commands and goes on.
    f.bots.service.setPermission(botId, permissionId('run commands'), false)
    expect(stopped()).toBe(true)
    expect(chatTurn.prepared.authority.time.signal.aborted).toBe(false)
    expect(chatOf(f, botId).at(-1)).toMatchObject({ systemLine: true, text: 'I stopped: "run commands" was switched off for now.' })
    // The runtime ends the turn as it does at a wall; the work goes on in its next turn, without commands. The command
    // the switch cut off holds nothing up: the next turn is told it was interrupted.
    await finish(f, work.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    expect(f.store.activation(work.id)!.status).toBe('running')
    const next = await start(f, work.id, 2)
    expect(next.prepared.prompt).toMatch(/^\[Mousse\] Your owner switched off a permission while you worked\. .*Continue where you left off, without it\. Interrupted tool calls .*bash/s)
    expect(next.prepared.policy.tools!.allow).not.toContain('bash')
    await finish(f, next.payload, 'completed', { text: 'Done without them.' })
    expect(f.store.activation(work.id)!.status).toBe('done')
    await finish(f, chatTurn.payload, 'completed', { text: 'Hi.' })
  })

  it('a call of another power the stop cut off still holds the work for the owner, as after any interruption', async () => {
    await allowAll()
    const work = await run('w1')
    f.runs.tools.start({ invocationId: 'inv-edit', runId: work.payload.runId, attemptId: f.runs.getRun(work.payload.runId)!.activeAttemptId!, tool: 'edit', argsDigest: 'd', now: 'n', idempotent: false })
    f.bots.service.setPermission(botId, permissionId('run commands'), false)
    await finish(f, work.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    expect(f.store.activation(work.id)).toMatchObject({ status: 'paused', endReason: 'unknown_calls' })
  })

  /** The bot's published definition gains a context thread, so its turns can consult it. */
  function withDocsContext() {
    const definitions = f.host.definitions
    const current = definitions.revision(botId, f.store.registry(botId)!.revision!)!
    const published = definitions.publishRevision({ ...current, context: [{ key: 'docs', title: 'Docs expert', agent: { instructions: 'You know the docs.' }, model: { mode: 'auto', depth: 'normal' } }] })
    f.store.setPublished(botId, published.revision!)
  }

  it('commands switched off: a consult that holds them is stopped with its chat turn, which holds none, and the command it started holds nothing up', async () => {
    await allowAll()
    const id = permissionId('run commands')
    const flip = (enabled: boolean) => f.bots.service.setPermission(botId, id, enabled)
    withDocsContext()
    const turn = await chat('What does the doc say?', 'm1')
    const stopped = () => turn.prepared.authority.time.signal.aborted
    expect(turn.prepared.policy.tools!.allow).not.toContain('bash')
    // Off and on again before any consult: the chat turn holds no commands, so nothing stops.
    flip(false)
    flip(true)
    expect(stopped()).toBe(false)
    // The consult starts now, with commands, and runs one.
    const asked = turn.prepared.authority.consult!({ context: 'docs', question: 'What does it say?' })
    void asked.catch(() => undefined)
    await flush()
    const consultN = f.store.dispatches(turn.activation.id).find((dispatch) => dispatch.kind === 'consult')!.n
    const consult = await start(f, turn.activation.id, consultN)
    expect(consult.prepared.authority.check(command('ls'))).toEqual({ ok: true })
    f.runs.tools.start({ invocationId: 'inv-consult-bash', runId: consult.payload.runId, attemptId: f.runs.getRun(consult.payload.runId)!.activeAttemptId!, tool: 'bash', argsDigest: 'd', now: 'n', idempotent: false })
    // Off again: the consult, and its turn with it, stop at once.
    flip(false)
    expect(consult.prepared.authority.time.signal.aborted).toBe(true)
    expect(stopped()).toBe(true)
    expect(chatOf(f, botId).filter((message) => message.kind === 'notice').at(-1)).toMatchObject({ systemLine: true })
    await finish(f, consult.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    await finish(f, turn.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    // The consult's cut-off command was the switch's: the chat goes on in a new turn, told it was interrupted.
    expect(f.store.activation(turn.activation.id)!.status).toBe('running')
    const next = await start(f, turn.activation.id, f.store.lastMainDispatch(turn.activation.id)!.n)
    expect(next.prepared.prompt).toMatch(/owner switched off.*Interrupted tool calls .*bash \(consult run/s)
    await finish(f, next.payload, 'completed', { text: 'Here is what I know.' })
  })

  it('a turn that finished before the stop reached it is done, with nothing carried on', async () => {
    await allowAll()
    const work = await run('w1')
    f.bots.service.setPermission(botId, permissionId('run commands'), false)
    await finish(f, work.payload, 'completed', { text: 'Done first.' })
    expect(f.store.activation(work.id)!.status).toBe('done')
    expect(f.store.dispatches(work.id).filter((dispatch) => dispatch.kind !== 'consult')).toHaveLength(1)
  })
})
