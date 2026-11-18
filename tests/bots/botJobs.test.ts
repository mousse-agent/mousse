import { remoteBotMethods } from '../../src/mms/bridge/remote/RemoteBots'
import { getDefaultSettings } from '../../src/shared/settings'
/**
 * The ledger of work a bot hands to its owner's threads (docs/plans/bot-context.md §16): one row per job with who asked
 * and what, a notice turn in the bot's chat with a capped report and the thread's link when the thread finishes or
 * waits for a person (once per change), a line instead when the bot is paused, and the row still there days later.
 * The tools that open a job are in tests/run/botThreadTools.test.ts; the pack's ledger lines in
 * tests/bots/memory/botChatEpochPack.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { threadsActOf } from '../../src/mms/bots/activation/BotEngine'
import { jobAskerOf, jobStateOf, jobStep, type JobThreadView } from '../../src/mms/bots/jobs'
import { BOT_REPORT_MAX_CHARS } from '../../src/shared/bots/personal/jobs'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from './botFixture'

describe('a thread\'s standing as a job', () => {
  it.each([
    ['running', 'running'], ['queued', 'running'], ['paused', 'running'], ['subagents', 'running'],
    ['needs_input', 'needs_input'], ['on_hold', 'needs_input'],
    ['done', 'done'], ['failed', 'failed'], ['stopped', 'stopped'], ['gone', 'gone'],
    // Not started yet: the message has not begun a turn, so nothing changes.
    ['idle', undefined]
  ] as const)('%s → %s', (status, state) => {
    expect(jobStateOf(status as JobThreadView['status'])).toBe(state)
  })

  it('a notice for waiting or ending, a quiet move back to working, and nothing for no change', () => {
    expect(jobStep({ state: 'running' }, 'needs_input')).toEqual({ state: 'needs_input', notice: true })
    expect(jobStep({ state: 'needs_input' }, 'running')).toEqual({ state: 'running', notice: false })
    expect(jobStep({ state: 'running' }, 'done')).toEqual({ state: 'done', notice: true })
    expect(jobStep({ state: 'running' }, 'running')).toBeUndefined()
    expect(jobStep({ state: 'running' }, undefined)).toBeUndefined()
  })

  it.each([
    ['the owner\'s chat message', { lane: 'chat', idempotencyKey: 'chat:r1', trigger: { kind: 'manual', input: 'x' } }, 'Fix X in Y', { askedBy: 'owner', request: 'Fix X in Y' }],
    ['a schedule', { lane: 'run', idempotencyKey: 'sched:b:s:t', trigger: { kind: 'schedule', input: 'Nightly check' } }, undefined, { askedBy: 'schedule', request: 'Nightly check' }],
    ['another bot', { lane: 'chat', idempotencyKey: 'botmsg:m1', trigger: { kind: 'manual', input: 'Please look', fromBot: { botId: 'o', name: 'O' } } }, undefined, { askedBy: 'bot', request: 'Please look' }],
    ['a wake, its own', { lane: 'chat', idempotencyKey: 'wake:w1', trigger: { kind: 'manual', input: 'woke' } }, undefined, { askedBy: 'self', request: 'Do the thing' }]
  ] as const)('who asked, from %s', (_name, row, ownerText, expected) => {
    expect(jobAskerOf(row as never, ownerText, 'Do the thing')).toEqual(expected)
  })
})

describe('the ledger in the bot engine', () => {
  let f: BotFixture
  let botId: string
  const threads = new Map<string, JobThreadView>()
  const notices = (jobId: string) => f.store.get('SELECT notices FROM bot_jobs WHERE id = ?', jobId)?.notices
  const noticeTurns = () => f.store.listActivations(botId).filter((row) => row.idempotencyKey.startsWith('job:'))

  beforeEach(async () => {
    f = botFixture()
    threads.clear()
    f.host.jobThread = (threadId) => threads.get(threadId)
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Alpha', description: 'Help me with my work.', reply: 'Hello.' })).botId
  })
  afterEach(() => f.close())

  /** The owner asks in the chat; the turn hands the job to `threadId` as thread_create does, and ends. */
  async function handOff(text: string, threadId: string, clientRequestId: string) {
    await f.bots.service.chatSend({ botId, text, clientRequestId })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { payload } = await start(f, activation.id)
    const { jobId } = f.bots.openJob(botId, activation.id, { threadId, title: 'Fix the login page', project: 'Web', sent: 'Fix the login redirect in Web.' })
    threads.set(threadId, { status: 'running', title: 'Fix the login page' })
    await finish(f, payload, 'completed', { text: 'Started a thread for it.' })
    return jobId
  }

  it('"fix X in project Y" becomes a job; the thread\'s end is one notice turn with the capped report and link, and the row is still there days later', async () => {
    const jobId = await handOff('Fix the login page in project Web', 't1', 'm1')
    expect(f.store.job(jobId)).toMatchObject({ threadId: 't1', project: 'Web', askedBy: 'owner', request: 'Fix the login page in project Web', state: 'running' })
    // Still working: nothing to say.
    f.bots.checkJobs('t1')
    await flush()
    expect(noticeTurns()).toEqual([])

    const answer = `Fixed the login redirect.\n${'detail '.repeat(600)}`
    threads.set('t1', { status: 'done', title: 'Fix the login page', result: answer })
    f.bots.threadRunEnded('t1')
    await flush()
    const [turn, ...more] = noticeTurns()
    expect(more).toEqual([])
    expect(turn).toMatchObject({ lane: 'chat' })
    // The turn may act on the owner's threads (#1359).
    expect(threadsActOf(turn!)).toBe(true)
    const input = (turn!.trigger as { input: string }).input
    expect(input).toContain('mousse://thread/t1')
    expect(input).toContain('Who asked: your owner.')
    expect(input).toContain('Fix the login page in project Web')
    // One Mousse block about this thread that may end with no reply; the thread's words are quoted inside it.
    expect(input.startsWith('<mousse_notice kind="job_update" reply="if-needed" ref="t1">\n')).toBe(true)
    expect(input.endsWith('\n</mousse_notice>')).toBe(true)
    expect(input).toContain('<quoted from="its answer">\nFixed the login redirect.')
    // The answer is held to the report cap, with where to read the rest.
    expect(input).toMatch(new RegExp(`cut at ${BOT_REPORT_MAX_CHARS.toLocaleString('en-US')} characters: read the rest with thread_read`))
    expect(input.length).toBeLessThan(BOT_REPORT_MAX_CHARS + 1_500)
    // The owner sees nothing of the notice itself: only what the bot says about it.
    expect(chatOf(f, botId).some((message) => message.text.includes('"Fix the login page" finished'))).toBe(false)
    expect(f.store.job(jobId)).toMatchObject({ state: 'done', line: 'Fixed the login redirect.', endedAt: expect.any(String) })
    expect(notices(jobId)).toBe(1)

    // The same end seen again (a restart, the upkeep pass) says nothing more.
    f.bots.threadRunEnded('t1')
    f.bots.checkJobs('t1')
    await flush()
    expect(noticeTurns()).toHaveLength(1)

    // Three days later the ledger still names the thread that did it.
    f.clock.now += 3 * 24 * 60 * 60 * 1000
    expect(f.store.recentJobs(botId, 6)).toEqual([expect.objectContaining({ id: jobId, threadId: 't1', state: 'done', line: 'Fixed the login redirect.' })])
  })

  it('a thread waiting for a person is a notice; an answer moves it back quietly; its end is a second notice', async () => {
    const jobId = await handOff('Update the docs in project Web', 't2', 'm2')
    threads.set('t2', { status: 'needs_input', title: 'Fix the login page' })
    f.bots.checkJobs('t2')
    await flush()
    expect(noticeTurns()).toHaveLength(1)
    expect((noticeTurns()[0]!.trigger as { input: string }).input).toMatch(/waiting for a person[\s\S]*mousse:\/\/thread\/t2/)
    expect(f.store.job(jobId)).toMatchObject({ state: 'needs_input' })
    expect(notices(jobId)).toBe(1)

    threads.set('t2', { status: 'running', title: 'Fix the login page' })
    f.bots.checkJobs('t2')
    await flush()
    expect(noticeTurns()).toHaveLength(1)
    expect(f.store.job(jobId)).toMatchObject({ state: 'running' })
    expect(notices(jobId)).toBe(1)

    threads.set('t2', { status: 'failed', title: 'Fix the login page' })
    f.bots.threadRunEnded('t2')
    await flush()
    expect(noticeTurns()).toHaveLength(2)
    expect(f.store.job(jobId)).toMatchObject({ state: 'failed' })
    expect(notices(jobId)).toBe(2)
  })

  it('a second message to a thread still on the job joins it; a paused bot is told in a line with the link, and no turn starts', async () => {
    const jobId = await handOff('Fix the login page in project Web', 't3', 'm3')
    expect(f.bots.openJob(botId, f.store.listActivations(botId).at(-1)!.id, { threadId: 't3', title: 'Fix the login page', sent: 'Also the logout.' }).jobId).toBe(jobId)

    const settings = getDefaultSettings(); settings.experimental.botAsksFirst = true
    f.host.settings = { get: () => settings } as never
    await f.bots.service.pause(botId)
    threads.set('t3', { status: 'done', title: 'Fix the login page', result: 'Done.' })
    f.bots.threadRunEnded('t3')
    await flush()
    expect(noticeTurns()).toEqual([])
    const report = chatOf(f, botId).find((message) => message.kind === 'run_report' && message.text.includes('mousse://thread/t3'))
    expect(report?.text).toMatch(/^"Fix the login page" finished: mousse:\/\/thread\/t3\. I didn't follow up on this: I'm paused\./)
    expect(f.store.job(jobId)).toMatchObject({ state: 'done' })
    expect(notices(jobId)).toBe(1)
    expect(report?.action).toBeUndefined()
    expect(report?.ask).toBeUndefined()
    const list = remoteBotMethods({ bots: () => f.bots.service }).find(method => method.method === 'bots.chat.list')!
    const page = await list.handle(list.validate!({ botId }), { caller: { node: 'phone', user: 'owner' } } as never) as any
    const remote = page.messages.find((message: any) => message.id === report!.id)
    expect(remote).toMatchObject({ kind: 'run_report', text: report!.text })
    expect(remote.action).toBeUndefined()
    expect(remote.text).toContain('mousse://thread/t3')
  })

  it('a thread the bot started that works again after its job ended (the owner said go in it) reaches the bot again when it ends', async () => {
    const jobId = await handOff('Fix the login page in project Web', 't4', 'm4')
    threads.set('t4', { status: 'done', title: 'Fix the login page', result: 'Ready to open the PR. Say go.' })
    f.bots.threadRunEnded('t4')
    await flush()
    expect(noticeTurns()).toHaveLength(1)
    const home = f.store.registry(botId)!.homeThreadId!

    // Ended and seen again: nothing opens.
    f.bots.launchedThreadChanged(home, 't4')
    expect(f.store.openJobsOn('t4')).toEqual([])

    // The owner says go in the thread: it works again, with no job of the bot's open there.
    threads.set('t4', { status: 'running', title: 'Fix the login page' })
    f.bots.launchedThreadChanged(home, 't4')
    const [followUp, ...more] = f.store.openJobsOn('t4')
    expect(more).toEqual([])
    expect(followUp).toMatchObject({ botId, askedBy: 'owner', state: 'running', request: 'More work after "Fix the login page in project Web"' })
    expect(followUp!.id).not.toBe(jobId)
    // Seen again while it works: still the one follow-up.
    f.bots.launchedThreadChanged(home, 't4')
    expect(f.store.openJobsOn('t4')).toHaveLength(1)

    threads.set('t4', { status: 'done', title: 'Fix the login page', result: 'Opened PR #12.' })
    f.bots.threadRunEnded('t4')
    await flush()
    const turns = noticeTurns()
    expect(turns).toHaveLength(2)
    const followUpTurn = turns.find((row) => row.idempotencyKey.startsWith(`job:${followUp!.id}:`))
    expect((followUpTurn!.trigger as { input: string }).input).toContain('Opened PR #12.')
    expect(f.store.job(followUp!.id)).toMatchObject({ state: 'done', line: 'Opened PR #12.' })
  })

  it('a message the bot sends to a thread whose follow-up is open takes the follow-up over: its turn, request and asker', async () => {
    await handOff('Fix the login page in project Web', 't5', 'm5')
    threads.set('t5', { status: 'done', title: 'Fix the login page' })
    f.bots.threadRunEnded('t5')
    await flush()
    threads.set('t5', { status: 'running', title: 'Fix the login page' })
    f.bots.launchedThreadChanged(f.store.registry(botId)!.homeThreadId!, 't5')
    const [followUp] = f.store.openJobsOn('t5')
    const turn = noticeTurns()[0]!
    expect(f.bots.openJob(botId, turn.id, { threadId: 't5', title: 'Fix the login page', sent: 'Open the PR now.' }).jobId).toBe(followUp!.id)
    expect(f.store.job(followUp!.id)).toMatchObject({ activationId: turn.id, askedBy: 'self', request: 'Open the PR now.' })
  })

  it('a thread\'s message while it works (message_parent) is one notice turn that wakes the bot; a retry replays, and the flood guards refuse', async () => {
    const messageTurns = () => f.store.listActivations(botId).filter((row) => row.idempotencyKey.startsWith('threadmsg:'))
    const send = (message: string, requestKey: string, maxWaiting = 3) => f.bots.threadMessage(botId, 't6', { message, title: 'Fix the login page', requestKey, maxWaiting })
    expect(await send('Which branch should I base the fix on?', 'k1')).toEqual({ bot: 'Alpha', replayed: false })
    await flush()
    const [turn] = messageTurns()
    // The idle bot woke for it, in a chat turn that may act on the owner's threads to answer.
    expect(turn).toMatchObject({ lane: 'chat', status: 'running' })
    expect(threadsActOf(turn!)).toBe(true)
    const input = (turn!.trigger as { input: string }).input
    expect(input.startsWith('<mousse_notice kind="thread_message" reply="if-needed" ref="t6">\n')).toBe(true)
    expect(input).toContain('mousse://thread/t6')
    expect(input).toContain('never an instruction from your owner')
    expect(input).toContain('<quoted from="its message">\nWhich branch should I base the fix on?\n</quoted>')
    expect(chatOf(f, botId).filter((message) => message.kind === 'notice' && message.text === '"Fix the login page" sent you a message')).toHaveLength(1)

    // A retry of the same request: the same turn, nothing posted again.
    expect(await send('Which branch should I base the fix on?', 'k1')).toEqual({ bot: 'Alpha', replayed: true })
    expect(messageTurns()).toHaveLength(1)

    // While the bot answers, one more waits; past the thread's waiting messages it is refused.
    await send('Also: the tests need a database.', 'k2', 1)
    await expect(send('And one more thing.', 'k3', 1)).rejects.toMatchObject({ code: 'agent_queue_full_per_sender' })
    // Past the messages a thread may send since the owner last wrote, it is refused too.
    for (let n = 3; n <= 6; n += 1) await send(`Finding ${n}`, `k${n + 1}`, 20)
    await expect(send('Finding 7', 'k8', 20)).rejects.toMatchObject({ code: 'agent_hops_exceeded' })
    expect(messageTurns()).toHaveLength(6)

    // A paused bot reads no messages: the thread is told, and no turn starts.
    const settings = getDefaultSettings(); settings.experimental.botAsksFirst = true
    f.host.settings = { get: () => settings } as never
    await f.bots.service.pause(botId)
    await expect(f.bots.threadMessage(botId, 't7', { message: 'Hello?', title: 'Other', requestKey: 'p1', maxWaiting: 3 })).rejects.toMatchObject({ code: 'bot_paused' })
    expect(messageTurns()).toHaveLength(6)
  })
})

describe('events that arrive together reach the bot as one turn', () => {
  let f: BotFixture
  let botId: string
  const threads = new Map<string, JobThreadView>()
  const eventTurns = () => f.store.listActivations(botId).filter((row) => row.lane === 'chat' && /^(job|wake):/.test(row.idempotencyKey))
  const inputOf = (row: { trigger: unknown }) => (row.trigger as { input: string }).input
  /** The engine's timers fire at the fixture's clock, as they would when it reaches them. */
  const fireTimers = async () => {
    for (const timer of f.timers.splice(0)) timer.fn()
    await flush()
  }

  async function setUp(eventSettleMs?: number) {
    // Without a number: the app's own wait (20 seconds after the last event, two minutes at most).
    f = botFixture({ eventSettleMs })
    threads.clear()
    f.host.jobThread = (threadId) => threads.get(threadId)
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Alpha', reply: 'Hello.' })).botId
  }
  afterEach(() => f.close())

  /** The owner asks; the turn hands the job to `threadId` and ends. */
  async function handOff(threadId: string, n: number) {
    await f.bots.service.chatSend({ botId, text: `Fix part ${n} in project Web`, clientRequestId: `m${n}` })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { payload } = await start(f, activation.id)
    f.bots.openJob(botId, activation.id, { threadId, title: `Part ${n}`, project: 'Web', sent: `Fix part ${n}.` })
    threads.set(threadId, { status: 'running', title: `Part ${n}` })
    await finish(f, payload, 'completed', { text: 'Started a thread for it.' })
  }

  async function ends(threadId: string) {
    threads.set(threadId, { status: 'done', title: threads.get(threadId)!.title, result: `${threadId} is done.` })
    f.bots.threadRunEnded(threadId)
    await flush()
  }

  it('threads that finish while the bot answers its owner are one turn after it, and nothing shows in the chat', async () => {
    await setUp(0)
    await handOff('t1', 1)
    await handOff('t2', 2)
    await f.bots.service.chatSend({ botId, text: 'How is it going?', clientRequestId: 'm3' })
    const busy = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { payload } = await start(f, busy.id)
    const before = chatOf(f, botId).length
    await ends('t1')
    await ends('t2')
    const [turn, ...more] = eventTurns()
    expect(more).toEqual([])
    expect(turn).toMatchObject({ status: 'queued' })
    expect(inputOf(turn!)).toMatch(/mousse:\/\/thread\/t1[\s\S]*mousse:\/\/thread\/t2/)
    expect(chatOf(f, botId)).toHaveLength(before)
    await finish(f, payload, 'completed', { text: 'Both are running.' })
    expect(f.store.activation(turn!.id)?.status).toBe('running')
    const { prepared } = await start(f, turn!.id)
    expect(prepared.prompt.match(/<mousse_notice kind="job_update"/g)).toHaveLength(2)
  })

  it('a notice waits for the ones after it, at most two minutes in all; the owner\'s message does not wait behind it', async () => {
    await setUp()
    for (let n = 1; n <= 9; n++) await handOff(`t${n}`, n)
    await ends('t1')
    const [turn] = eventTurns()
    expect(turn).toMatchObject({ status: 'queued' })
    f.clock.now += 10_000
    await ends('t2')
    expect(eventTurns()).toHaveLength(1)
    // 25 seconds after the first, 15 after the second: still waiting for more.
    f.clock.now += 15_000
    await fireTimers()
    expect(f.store.activation(turn!.id)?.status).toBe('queued')
    // The owner writes meanwhile: their turn starts at once.
    await f.bots.service.chatSend({ botId, text: 'Anything new?', clientRequestId: 'ask' })
    const owner = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    expect(owner.idempotencyKey.startsWith('job:')).toBe(false)
    const { payload } = await start(f, owner.id)
    await finish(f, payload, 'completed', { text: 'Still on it.' })
    // 20 seconds after the last notice, it starts with both.
    f.clock.now += 5_000
    await fireTimers()
    expect(f.store.activation(turn!.id)?.status).toBe('running')
    expect(inputOf(f.store.activation(turn!.id)!)).toMatch(/mousse:\/\/thread\/t1[\s\S]*mousse:\/\/thread\/t2/)
    const { payload: noticePayload } = await start(f, turn!.id)
    await finish(f, noticePayload, 'completed', { text: '[SILENT]' })
    // Notices that keep coming start a turn two minutes after the first, however close together they are.
    await ends('t3')
    const next = eventTurns().find((row) => row.id !== turn!.id)!
    for (let n = 4; n <= 9; n++) {
      f.clock.now += 19_000
      await fireTimers()
      await ends(`t${n}`)
    }
    expect(f.store.activation(next.id)?.status).toBe('queued')
    f.clock.now += 6_000
    await fireTimers()
    expect(f.store.activation(next.id)?.status).toBe('running')
    expect(eventTurns()).toHaveLength(2)
  })

  it('lines older versions posted for wake-ups and thread notices no longer show, nor count as unread', async () => {
    await setUp(0)
    const shown = chatOf(f, botId).length
    const unread = f.store.unread(botId, 0)
    f.store.db.transaction(() => {
      f.bots.chat.post({ id: 'bm_wake_w1', botId, author: 'bot', kind: 'notice', text: 'Following up', lane: 'chat' })
      f.bots.chat.post({ id: 'bm_wake_job_j1_a1', botId, author: 'bot', kind: 'notice', text: '"Part 1" finished', lane: 'chat' })
    })
    expect(chatOf(f, botId)).toHaveLength(shown)
    expect(f.store.unread(botId, 0)).toBe(unread)
  })
})

describe('the ledger in bots.db', () => {
  let f: BotFixture
  beforeEach(() => { f = botFixture() })
  afterEach(() => f.close())
  const open = (id: string, botId = 'b', threadId = 't') => f.store.openJob({ id, botId, activationId: 'a', threadId, title: 'T', request: 'R', askedBy: 'owner' })

  it('a move from a state the job left is refused, so two passes give one notice; an end keeps its time', () => {
    open('j1')
    expect(f.store.moveJob('j1', 'running', 'done', { line: 'ok', notice: true })).toBe(true)
    expect(f.store.moveJob('j1', 'running', 'done', { notice: true })).toBe(false)
    expect(f.store.job('j1')).toMatchObject({ state: 'done', line: 'ok', endedAt: expect.any(String) })
    expect(f.store.openJobsOn('t')).toEqual([])
    // An ended job leaves the thread free for the next one.
    expect(open('j2').id).toBe('j2')
  })

  it('newest first, only those changed since a time, and the purge takes a deleted bot\'s rows', () => {
    open('j1', 'b', 't1')
    const first = f.store.job('j1')!.updatedAt
    f.clock.now += 1_000
    open('j2', 'b', 't2')
    open('j3', 'other', 't3')
    expect(f.store.recentJobs('b', 6).map((job) => job.id)).toEqual(['j2', 'j1'])
    expect(f.store.recentJobs('b', 6, first).map((job) => job.id)).toEqual(['j2'])
    f.store.deleteBotRows('b')
    expect(f.store.recentJobs('b', 6)).toEqual([])
    expect(f.store.job('j3')).toBeDefined()
  })
})
