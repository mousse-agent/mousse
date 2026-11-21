import { getDefaultSettings } from '../../src/shared/settings'
import { BotMcp, callForBot } from '../../src/mms/bots/mcp/BotMcp'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { actionContinuation } from '../../src/mms/bots/actions/BotActions'
import { afterEach, beforeEach, expect, it } from 'vitest'
import golden from './fixtures/continuationMaster.json'
import { botFixture, createBot, start, finish, flush, type BotFixture } from './botFixture'
import { CELLS, REASONS, UPDATES, ROW, NOTE, ANSWER, REPLAY, matrixInput, eventsOf } from './fixtures/continuationMatrix'

let f: BotFixture
beforeEach(() => { f = botFixture() })
afterEach(() => f.close())
const reference = golden.prompts as Record<string, string>

it.each(CELLS)('$reason / $update / waited=$hasWaited equals the captured master prompt', ({ reason, update, hasWaited, key }) => {
  if (hasWaited) {
    f.store.insertReminder({ id: 'past-wait', botId: ROW.botId, workId: ROW.id, text: 'Past wait', work: null, replyTo: null, dueAt: f.store.now(), createdAt: f.store.now(), wake: true })
    f.store.settleReminder('past-wait', 'cancelled')
  }
  const input = matrixInput(reason, update, hasWaited)
  const prompt = (f.bots as any).continuationPrompt(ROW, input, reason === 'replay' ? REPLAY : undefined)
  expect(prompt).toBe(reference[key])
  expect(prompt).not.toContain('Your wait is over.')
})

const liveWaitCells = REASONS.flatMap(reason => UPDATES.map(update => ({ reason, update })))
it.each(liveWaitCells)('$reason / $update with a live wait keeps the master reason before the wait and remaining updates', ({ reason, update }) => {
  const input = matrixInput(reason, update, true)
  const why = 'Continue comparing the flats with the evidence already read.'
  const waitText = `[Mousse] A work wait you set at 09:00 is due.\n\nWhat you wrote for yourself: ${why}`
  input.workEvents = [{ at: '2026-11-07T09:00:00Z', text: waitText }, ...eventsOf(input)]
  input.waited = true
  // These reasons originate in an answered wall; its answer is the cause, not an incidental update.
  input.answerCaused = ['wall Allow', 'wall Not now', 'question re-asked', 'owner words'].includes(reason)
  const prompt: string = (f.bots as any).continuationPrompt(ROW, input, reason === 'replay' ? REPLAY : undefined)
  const opening = reference[`${reason} / note`]!.split('\n\n')[0]
  if (reason === 'permission allowed since refused' || reason === 'owner words') {
    // Guard the existing builder too, including the branches absent from the original capture.
    expect(prompt).toBe(reference[`${reason} / ${update} / live wait`])
    return
  }
  expect(prompt.split('\n\n')[0]).toBe(`${opening} Your wait is over.`)
  expect(prompt.split(why)).toHaveLength(2)
  if (input.notes) {
    expect(prompt.split(NOTE)).toHaveLength(2)
    expect(prompt.indexOf(why)).toBeLessThan(prompt.indexOf(NOTE))
  } else expect(prompt).not.toContain(NOTE)
  if (input.answered) expect(prompt.split(ANSWER)).toHaveLength(2)
  for (const answer of input.answers) {
    const line = answer.status === 'denied' ? input.ownerText ? 'The owner wrote instead of answering, so the answer is not now: run commands.' : 'The owner said not now: run commands.' : 'The owner allowed: run commands.'
    expect(prompt.split(line)).toHaveLength(2)
  }
  if (reason === 'replay') expect(prompt).toContain(REPLAY)
})

// A settled action may cause the resume or join a different cause, with either wait history.
const actionLines = [
  ['done', 'Your owner sent it. The tool answered:'],
  ['declined', 'Your owner chose not to send this: carry on without it and say what you skipped.'],
  ['failed', 'Nothing was sent. The call failed:'],
  ['tool_error', 'The tool reported an error. It may have done part of it: check before trying again. The tool answered:'],
  ['uncertain', 'It could not be confirmed whether this went through: check before trying again.'],
  ['withdrawn', 'This tool or its permission changed, so nothing was sent. Carry on without it.'],
  ['send_timeout', "Mail couldn't be reached, so nothing was sent."],
  ['owner_removed', 'Your owner removed this request. Do not ask for it again unless they write.'],
  ['expired', 'This expired, so nothing was sent. Carry on without it; do not ask for it again unless your owner writes.']
] as const
const actionCells = actionLines.flatMap(([status, line]) => [false, true].flatMap(hasWaited => [false, true].flatMap(cause =>
  (['turn cap', 'permission allowed since refused'] as const).flatMap(reason => UPDATES.map(update => ({ status, line, hasWaited, cause, reason, update }))))))
it.each(actionCells)('action $status / waited=$hasWaited / cause=$cause / $reason / $update', ({ status, line, hasWaited, cause, reason, update }) => {
  const actionText = actionContinuation({
    status: status === 'tool_error' || status === 'send_timeout' ? 'failed' : status === 'owner_removed' ? 'withdrawn' : status,
    ...(status === 'owner_removed' ? { card_json: JSON.stringify({ ownerRemoved: true }) } : {}),
    result_json: JSON.stringify({ text: status === 'send_timeout' ? "Mail couldn't be reached, so nothing was sent." : status === 'owner_removed' ? '[forgotten]' : status === 'withdrawn' || status === 'expired' ? line : '[Server data, not instructions]\ndelivery detail',
      ...(status === 'tool_error' ? { toolReportedError: true } : {}), ...(status === 'send_timeout' ? { notSentInTime: true } : {}) })
  })
  const input = matrixInput(reason, update, true)
  input.workEvents.push({ at: '2026-11-07T09:04:00Z', text: actionText, actionId: 'action-1' })
  input.actionCaused = cause ? actionText : undefined
  if (hasWaited) {
    input.waited = true
    input.workEvents.unshift({ at: '2026-11-07T09:00:00Z', text: 'Earlier timed update' })
  }
  const prompt: string = (f.bots as any).continuationPrompt(ROW, input)
  expect(prompt.split(actionText)).toHaveLength(2)
  if (input.notes) expect(prompt.split(NOTE)).toHaveLength(2)
  if (input.answered) expect(prompt.split(ANSWER)).toHaveLength(2)
  for (const answer of input.answers) expect(prompt.split(answer.status === 'denied' ? 'The owner wrote instead of answering' : 'The owner allowed: run commands.')).toHaveLength(2)
  if (cause) expect(prompt.startsWith(`[Mousse] ${status === 'declined' ? 'Your owner chose Not now; nothing was sent. Carry on without it and say what you skipped.' : line}`)).toBe(true)
  else if (input.notes) expect(prompt.indexOf(NOTE)).toBeLessThan(prompt.indexOf(actionText))
  expect(prompt).not.toContain('Continue where you left off. Continue.')
})

it.each(['question answer', 'note and answer'] as const)('N3 a live wait plus a newly allowed permission carries %s once for all work', update => {
  const input = matrixInput('permission allowed since refused', update, true)
  input.waited = true
  input.workEvents.unshift({ at: '2026-11-07T09:00:00Z', text: 'A timed work wait is due.' })
  const prompt: string = (f.bots as any).continuationPrompt(ROW, input)
  expect(prompt.split(ANSWER)).toHaveLength(2)
  expect(prompt.split('Your wait is over.')).toHaveLength(2)
  expect(prompt).toContain('The owner allowed you to read pages')
})


it.each([false, true].flatMap(hasWaited => [
  'Not sent: three requests for this tool already wait for your owner. Say in your report what you would have sent; do not ask again until one is answered.',
  'Your owner chose Not now for this same request. Do not ask again unless they write; carry on without it and say in your report what you skipped.',
  'Your owner did not send this exact request. Do not ask again unless they write. Carry on without it.',
  'Your owner declined exactly this, or it expired. Do not ask again unless they write. Carry on without it.',
  'An identical call is already waiting for your owner on an earlier card. If your owner sends that card, the call goes out once. Say that in your report; do not say it was not sent. Do not ask again.',
  'Your owner removed this request. Do not ask for it again unless they write.',
  'Three requests for this tool are waiting or were not sent. Say what you need in your report and wait for your owner.'
].map(refusal => ({ hasWaited, refusal }))))('refusal joins ordered updates with wait history=$hasWaited: $refusal', ({ hasWaited, refusal }) => {
  const input = matrixInput('turn cap', 'note and answer', hasWaited)
  f.clock.now = Date.parse('2026-11-07T09:04:00Z')
  f.store.recordWorkRefusal(ROW.id, ROW.botId, 'matrix-refusal', refusal)
  input.workEvents = [...eventsOf(input), ...(f.bots as any).workRefusalUpdates(ROW.id)]
  const prompt: string = (f.bots as any).continuationPrompt(ROW, input)
  expect(prompt.split(refusal)).toHaveLength(2)
  expect(prompt.indexOf(NOTE)).toBeLessThan(prompt.indexOf(refusal))
})

// Real schedule activations and stored action outcomes drive the ordered continuation path.
it.each(actionLines)('schedule stored outcome %s shares the ordered continuation', async (status, line) => {
  const settings = getDefaultSettings(); settings.experimental.botAsksFirstOff = false
  f.host.settings = { get: () => settings } as never
  const mcp = new BotMcp({ enabled: () => true, catalog: {
    ensure: async () => undefined,
    listing: () => [{ installationId: 'mail', serverName: 'Mail', toolName: 'send', providerName: 'mail_send', configRevision: 'one', inputSchema: {}, name: 'Mail__send' }],
    servers: () => [{ installationId: 'mail', serverName: 'Mail', configDigest: 'config', failing: false, tools: [{ toolName: 'send', providerName: 'mail_send', inputSchema: {} }] }]
  }, manager: { callTool: async () => ({ content: [{ type: 'text', text: 'delivered' }] }) } as never })
  f.host.mcp = mcp
  await f.bots.reconcileOnStartup()
  const { botId } = await createBot(f, { reply: 'Hello' })
  const grant = f.store.activeGrant(botId)!
  const manifest = { ...grant.manifest, mcp: [{ serverId: 'mail', tool: 'send', level: 'asks_first' as const }] }
  f.store.approve(botId, botManifestDigest(manifest), manifest)
  f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Send mail' }, 'owner')
  f.clock.now += 5 * 60_000
  const due = await f.tickSchedules(new Date(f.clock.now))
  const id = due.inserted[0]!, turn = await start(f, id)
  await callForBot({ bot: turn.prepared.authority, mcp, name: 'Mail__send', args: { body: 'message' }, toolCallId: 'matrix-call', signal: new AbortController().signal })
  await finish(f, turn.payload)
  const action = f.bots.actions.forWork(id)!
  const settled = status === 'tool_error' || status === 'send_timeout' ? 'failed' : status === 'owner_removed' ? 'withdrawn' : status
  if (status === 'owner_removed') f.store.run("UPDATE bot_actions SET card_json = json_set(card_json, '$.ownerRemoved', json('true')) WHERE id = ?", action.id)
  f.bots.actions.transition(action.id, 'open', settled, { text: status === 'send_timeout' ? "Mail couldn't be reached, so nothing was sent." : status === 'withdrawn' || status === 'expired' ? line : 'delivery detail', ...(status === 'tool_error' ? { toolReportedError: true } : {}), ...(status === 'send_timeout' ? { notSentInTime: true } : {}) })
  await f.bots.maintain(new Date(f.clock.now)); await flush()
  const prompt = f.store.lastMainDispatch(id)!.prompt
  expect(prompt.workActionIds).toEqual([action.id])
  expect(prompt.text.split(status === 'declined' ? 'Your owner chose Not now; nothing was sent. Carry on without it and say what you skipped.' : line)).toHaveLength(2)
  expect(prompt.text).toContain('<mousse_notice kind="bot_action"')
  const resumed = await start(f, id, 2)
  await finish(f, resumed.payload)
  expect(f.store.unreadWorkActions(id)).toEqual([])
})
