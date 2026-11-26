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
import { jobAskerOf, jobResultOf, jobStateOf, jobStep, resultLine, type JobThreadView } from '../../src/mms/bots/jobs'
import { BOT_JOB_LINE_CHARS, BOT_REPORT_MAX_CHARS, jobLine } from '../../src/shared/bots/personal/jobs'
import type { ChatMessage } from '../../src/shared/types'
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

  describe('what the owner asked, when their message is longer than one line holds', () => {
    const chat = { lane: 'chat', idempotencyKey: 'chat:r1', trigger: { kind: 'manual', input: 'x' } } as never
    const long = `Fix the login page in Web, ${'then tidy the settings page and the docs, '.repeat(5)}and tell me.`

    it.each([
      // It may ask for several things: each job names the part its thread was handed.
      ['a long message', long, 'Fix the login redirect in Web.', 'Fix the login redirect in Web.'],
      // Handed nothing to name: the message, cut to the line.
      ['a long message, nothing handed', long, '  ', jobLine(long)],
      // Long only in its spacing: one line holds it.
      ['a message long only in its spacing', `Fix X in Y${' '.repeat(BOT_JOB_LINE_CHARS)}`, 'Fix the login redirect in Web.', 'Fix X in Y']
    ])('%s', (_name, ownerText, sent, request) => {
      expect(jobAskerOf(chat, ownerText, sent)).toEqual({ askedBy: 'owner', request })
    })
  })
})

describe('a job\'s answer and its one line', () => {
  const row = (role: ChatMessage['role'], content: string, turnId?: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `${role}:${content}`, role, content, timestamp: '', ...(turnId ? { turnId } : {}), ...extra })
  // An earlier turn r0 whose reply opens with words the new run's progress line repeats.
  const earlier = [row('user', 'Fix page A', 'r0'), row('assistant', 'Looking at the logs now. Fixed page A: the redirect was wrong.', 'r0')]

  it.each([
    // The run wrote a progress line, then its final reply (the one carrying its id): the final reply is the answer.
    ['a progress line, then the reply', [...earlier, row('user', 'Fix page B', 'r1'), row('assistant', 'Looking at the logs now.'), row('assistant', 'Fixed page B.', 'r1')], 'Looking at the logs now.\n\nFixed page B.', 'Fixed page B.'],
    // The final reply carries no id: the last reply after the message that opened the run.
    ['a reply without the run\'s id', [...earlier, row('user', 'Fix page B', 'r1'), row('assistant', 'Looking now.'), row('assistant', 'Fixed page B.')], undefined, 'Fixed page B.'],
    // Stopped after a progress line that opens the earlier turn's reply: its own line, never the earlier reply.
    ['a stopped run whose line opens an earlier reply', [...earlier, row('user', 'Fix page B', 'r1'), row('assistant', 'Looking at the logs now.'), row('system', 'Turn stopped.')], 'Looking at the logs now.', 'Looking at the logs now.'],
    // Stopped before it wrote anything: no answer, never the earlier turn's.
    ['a stopped run with no reply', [...earlier, row('user', 'Fix page B', 'r1'), row('system', 'Turn stopped.')], undefined, undefined],
    // The next run's messages are not this run's.
    ['a later run\'s reply', [row('user', 'Fix page B', 'r1'), row('user', 'And C', 'r2'), row('assistant', 'Fixed C.', 'r2')], undefined, undefined],
    // A run that left no message of its own: what it kept, or nothing; never the thread's last reply.
    ['no message of the run, a kept result', earlier, 'Fixed page B.', 'Fixed page B.'],
    ['no message of the run, nothing kept', earlier, '  ', undefined]
  ] as const)('the answer: %s', (_name, messages, recorded, answer) => {
    expect(jobResultOf(recorded, messages as readonly ChatMessage[], 'r1')).toBe(answer)
  })

  it('an applet in the reply reaches the answer as its name, never its source, even after 200 characters of prose', () => {
    const source = { schemaVersion: 1, title: 'Price chart', description: 'Prices.', html: '<main id="secret-markup"></main>', css: '', js: 'drawChart()' }
    const reply = `${'The prices over the year, as asked. '.repeat(8)}\n\n\u0060\u0060\u0060mousse-applet\n${JSON.stringify(source)}\n\u0060\u0060\u0060`
    const reference = { appletId: 'ap1', revisionId: 'rev1', sourceHash: 'h', title: 'Price chart', description: 'Prices.' }
    const published = row('assistant', reply, 'r1', { presentationParts: [{ type: 'text', text: reply.slice(0, reply.indexOf('\u0060')) }, { type: 'applet', reference }] })
    for (const message of [published, row('assistant', reply, 'r1')]) {
      const answer = jobResultOf('The prices over the year.', [row('user', 'Chart prices', 'r1'), message], 'r1')!
      expect(answer).toContain('The prices over the year, as asked.')
      expect(answer).toContain('[Applet: Price chart')
      expect(answer).not.toContain('mousse-applet')
      expect(answer).not.toContain('secret-markup')
      expect(answer).not.toContain('drawChart')
    }
  })

  it.each([
    ['the first line', 'Fixed the redirect.\nDetails.', 'Fixed the redirect.'],
    ['past blank lines', '\n  \nFixed the redirect.', 'Fixed the redirect.'],
    ['past a heading', '## Summary\n\nFixed the redirect.', 'Fixed the redirect.'],
    ['past rules and a code fence', '---\n* * *\n___\n```ts\nconst fixed = true\n```', 'const fixed = true'],
    ['past a setext underline', '=====\nFixed the redirect.', 'Fixed the redirect.'],
    // A heading's words when the answer has nothing else.
    ['only headings', '# Done\n\n## Nothing else', 'Done'],
    // Words that start with layout characters are words.
    ['an issue number', '#1873 is merged.', '#1873 is merged.'],
    ['a bold line', '**Fixed** the redirect.', '**Fixed** the redirect.'],
    ['a list item', '- Fixed the redirect.', '- Fixed the redirect.'],
    ['nothing', '\n  \n', undefined],
    ['no answer', undefined, undefined]
  ])('the line: %s', (_name, result, line) => {
    expect(resultLine(result)).toBe(line)
  })

  it('the line is held to one ledger line', () => {
    expect(resultLine(`## Report\n${'word '.repeat(100)}`)).toBe(jobLine('word '.repeat(100)))
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

  it('a long message names on its job what that thread was handed; the ledger line skips the answer\'s heading', async () => {
    const jobId = await handOff(`Fix the login page in project Web, ${'then tidy the settings page and the docs, '.repeat(5)}and tell me.`, 't9', 'm9')
    // handOff hands the thread "Fix the login redirect in Web."
    expect(f.store.job(jobId)).toMatchObject({ askedBy: 'owner', request: 'Fix the login redirect in Web.' })
    threads.set('t9', { status: 'done', title: 'Fix the login page', result: '## Summary\n\n---\nFixed the login redirect.\nDetails below.' })
    f.bots.threadRunEnded('t9')
    await flush()
    expect(f.store.job(jobId)).toMatchObject({ state: 'done', line: 'Fixed the login redirect.' })
  })

  it('a thread waiting for a person is a notice; an answer moves it back quietly; its end is a second notice', async () => {
    const jobId = await handOff('Update the docs in project Web', 't2', 'm2')
    threads.set('t2', { status: 'needs_input', title: 'Fix the login page' })
    f.bots.checkJobs('t2')
    await flush()
    expect(noticeTurns()).toHaveLength(1)
    expect((noticeTurns()[0]!.trigger as { input: string }).input).toMatch(/waits for a person[\s\S]*mousse:\/\/thread\/t2/)
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

    const settings = getDefaultSettings(); settings.experimental.botAsksFirstOff = false
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

    // It works again: the next follow-up keeps the first request's line, never quoting it twice.
    threads.set('t4', { status: 'running', title: 'Fix the login page' })
    f.bots.launchedThreadChanged(home, 't4')
    expect(f.store.openJobsOn('t4')).toMatchObject([{ request: 'More work after "Fix the login page in project Web"' }])
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
    expect(input).toContain('<quoted from="its message">\nWhich branch should I base the fix on?\n</quoted>')
    // The owner sees no line for it; the one kept for the flood guard below stays out of the chat.
    expect(chatOf(f, botId).some((message) => message.text === '"Fix the login page" sent you a message')).toBe(false)
    expect(f.store.chatRowsAfter(botId, 'bm_wake_threadmsg_t6_', 0)).toBe(1)

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
    const settings = getDefaultSettings(); settings.experimental.botAsksFirstOff = false
    f.host.settings = { get: () => settings } as never
    await f.bots.service.pause(botId)
    await expect(f.bots.threadMessage(botId, 't7', { message: 'Hello?', title: 'Other', requestKey: 'p1', maxWaiting: 3 })).rejects.toMatchObject({ code: 'bot_paused' })
    expect(messageTurns()).toHaveLength(6)
  })
})

describe('wake-ups and thread notices stay out of the chat', () => {
  let f: BotFixture
  let botId: string

  async function setUp() {
    f = botFixture()
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Alpha', reply: 'Hello.' })).botId
  }
  afterEach(() => f.close())

  it('while the bot works on a thread\'s message the chat shows no typing, working line or live status, and no event is sent for it', async () => {
    await setUp()
    const events: unknown[] = []
    f.bots.events.on('activity', (event) => events.push(event))
    const emitted: unknown[] = []
    f.bots.events.on('message', (event) => emitted.push(event))
    f.bots.events.on('tell', (event) => emitted.push(event))
    await f.bots.threadMessage(botId, 't1', { message: 'Which branch?', title: 'Fix the login page', requestKey: 'k1', maxWaiting: 3 })
    await flush()
    const turn = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    expect(turn.idempotencyKey.startsWith('threadmsg:')).toBe(true)
    const { payload } = await start(f, turn.id)
    f.bots.publishActivity({ botId, activationId: turn.id, chip: { icon: 'search', text: 'searching the web', live: true } })
    const summary = f.bots.service.get(botId).summary
    expect(summary.chat).toBeUndefined()
    expect(summary.state).not.toBe('working')
    expect(summary.stateText).not.toBe('Working…')
    expect(f.bots.service.chatList(botId).live).toBeUndefined()
    expect(events).toEqual([])
    expect(emitted).toEqual([])
    // What the bot then says posts as any reply.
    await finish(f, payload, 'completed', { text: 'Base it on master.' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ author: 'bot', text: 'Base it on master.' })
  })

  it('lines older versions posted for wake-ups and thread notices no longer show, nor count as unread', async () => {
    await setUp()
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
