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
    expect(chatOf(f, botId).some((message) => message.kind === 'notice' && message.text === '"Fix the login page" finished')).toBe(true)
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

    await f.bots.service.pause(botId)
    threads.set('t3', { status: 'done', title: 'Fix the login page', result: 'Done.' })
    f.bots.threadRunEnded('t3')
    await flush()
    expect(noticeTurns()).toEqual([])
    const report = chatOf(f, botId).find((message) => message.kind === 'run_report' && message.text.includes('mousse://thread/t3'))
    expect(report?.text).toMatch(/^"Fix the login page" finished: mousse:\/\/thread\/t3\. I didn't follow up on this: I'm paused\./)
    expect(f.store.job(jobId)).toMatchObject({ state: 'done' })
    expect(notices(jobId)).toBe(1)
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
