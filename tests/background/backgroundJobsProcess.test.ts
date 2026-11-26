/**
 * The background job service with real processes, shared by a thread's monitors and a real bot engine as the profile
 * wires it (`MmsProfileServices`): a command runs with exactly the environment its caller gives, never Mousse's own; a
 * bot's command started from its chat never holds the chat and comes back as a wake, with a result its child printed
 * after the shell exited; a restart with commands and wake-ups pending tells each thread and bot as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundJobService } from '../../src/mms/background/BackgroundJobService'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { ThreadMonitors } from '../../src/mms/monitors/ThreadMonitors'
import { ThreadWakes } from '../../src/mms/wakes/ThreadWakes'
import type { MonitorEventPayload, ThreadWakePayload } from '../../src/mms/run/types'
import { botFixture, createBot, finish, flush, start, type BotFixture } from '../bots/botFixture'

const LEAK = 'MOUSSE_JOB_ENV_SENTINEL'
let dir: string
let script: string
let f: BotFixture
let botId: string
let jobs: BackgroundJobService
let monitors: ThreadMonitors
let posted: Array<{ threadId: string; payload: MonitorEventPayload }>

/** What a thread's caller gives its scripts: here only what a shell needs, nothing of this process's secrets. */
const threadEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}) })
const monitorsOver = (recordFile?: string) => new ThreadMonitors({ jobs, env: threadEnv, post: (threadId, payload) => { posted.push({ threadId, payload: structuredClone(payload) }) }, ...(recordFile ? { recordFile } : {}) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mousse-jobs-'))
  script = join(dir, 'job.js')
  // Prints whether it sees the sentinel, writes its pid, then exits or runs until a go file appears. \`late\` leaves a
  // child on its output (detached, so it outlives it on Windows too) that prints the result 1.5 s after it exits.
  writeFileSync(script, `
const [mode, pidFile] = process.argv.slice(2)
require('fs').writeFileSync(pidFile, String(process.pid))
if (mode === 'child') setTimeout(() => { console.log('result=late'); process.exit(0) }, 1500)
else {
  console.log('sentinel=' + (process.env.${LEAK} || 'absent'))
  if (mode === 'late') {
    require('child_process').spawn(process.execPath, [__filename, 'child', pidFile + '.child'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })
    process.exit(0)
  }
  if (mode === 'exit') process.exit(0)
  setInterval(() => { if (require('fs').existsSync(pidFile + '.go')) { console.log('built'); process.exit(0) } }, 25)
}
`)
  process.env[LEAK] = 'secret-of-mousse'
  jobs = new BackgroundJobService()
  posted = []
  monitors = monitorsOver()
  f = botFixture()
  // The engine over the profile's shared service, as `MmsProfileServices` opens it.
  f.bots.close()
  f.host.backgroundJobs = jobs
  f.bots = new BotEngine(f.host)
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Pip', reply: 'Hello.' })).botId
})

afterEach(() => {
  delete process.env[LEAK]
  monitors.close()
  f.close()
  rmSync(dir, { recursive: true, force: true })
})

const command = (mode: string, pidFile: string) => `"${process.execPath}" "${script}" ${mode} "${pidFile}"`
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
const pidOf = async (file: string) => { await until(() => existsSync(file) && readFileSync(file, 'utf8').length > 0); return Number(readFileSync(file, 'utf8')) }
const pidFile = (name: string) => join(dir, `${name}-${Math.random().toString(16).slice(2)}.pid`)
const wakeTurn = (id: string) => f.store.listActivations(botId).find((row) => row.idempotencyKey === `wake:${id}`)

/** The owner writes; the chat turn that answers it starts. */
async function chat(text: string, id: string) {
  await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { activation, ...(await start(f, activation.id)) }
}

/** The owner allows "run commands", as they would on the bot's ask. */
async function allowCommands() {
  const activation = await f.bots.activate({ botId, input: 'Run', clientRequestId: 'grant-commands' })
  const turn = await start(f, activation.id)
  turn.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To watch builds.' })
  await finish(f, turn.payload, 'completed', { text: 'Asked.' })
  for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
  await flush()
}

/** The wake a command's end fired, delivered: its chat turn's input. */
async function woken(watcherId: string): Promise<string> {
  await until(() => f.store.reminder(watcherId)?.fired !== null)
  await f.bots.deliverDueReminders()
  return (await start(f, wakeTurn(watcherId)!.id)).prepared.prompt
}

describe('a command runs with its caller\'s environment only', () => {
  it('a thread\'s background command sees what the thread\'s caller gave it, not Mousse\'s own', async () => {
    monitors.startBackground({ threadId: 't1', description: 'build', command: command('exit', pidFile('thread')), cwd: dir })
    await until(() => posted.some((entry) => entry.payload.end))
    const end = posted.find((entry) => entry.payload.end)!.payload
    expect(end.end).toMatchObject({ reason: 'exit', code: 0 })
    expect(end.tail).toContain('sentinel=absent')
  })

  it('a bot\'s background command sees only its locked environment', async () => {
    await allowCommands()
    const turn = await chat('Watch the build', 'm1')
    const { watcherId } = f.bots.tools.watchers!.start(botId, turn.activation.id, { command: command('exit', pidFile('bot')), brief: 'Say how it went.' })
    await finish(f, turn.payload, 'completed', { text: 'Watching.' })
    const prompt = await woken(watcherId)
    expect(prompt).toContain('sentinel=absent')
    expect(prompt).not.toContain('secret-of-mousse')
  })
})

describe('a bot\'s chat is never held by its command', () => {
  it('started from the chat: the chat turn ends, the owner\'s next message is answered while it runs, and its end comes back as a wake', async () => {
    await allowCommands()
    const turn = await chat('Run the build and tell me', 'm1')
    const file = pidFile('gate')
    const { watcherId } = f.bots.tools.watchers!.start(botId, turn.activation.id, { command: command('gate', file), brief: 'Tell them how the build went.', title: 'Build' })
    await finish(f, turn.payload, 'completed', { text: "I'll tell you when it's done." })
    const pid = await pidOf(file)
    expect(f.store.activation(turn.activation.id)).toMatchObject({ status: 'done' })
    expect(jobs.holds({ kind: 'bot', botId })).toBe(false)
    // The next message takes the chat's one slot at once, and ends, while the command still runs.
    const next = await chat('Anything else?', 'm2')
    expect(next.activation.idempotencyKey).toBe('chat:m2')
    await finish(f, next.payload, 'completed', { text: 'Not yet.' })
    expect(f.store.activation(next.activation.id)).toMatchObject({ status: 'done' })
    expect(alive(pid)).toBe(true)
    expect(f.store.reminder(watcherId)?.fired).toBeNull()
    writeFileSync(`${file}.go`, '')
    expect(await woken(watcherId)).toContain('exited with code 0')
    expect(wakeTurn(watcherId)!.lane).toBe('chat')
  })
})

describe('a bot\'s command whose child prints its result after the shell exited', () => {
  it('the wake and watch_list both carry the result', async () => {
    await allowCommands()
    const turn = await chat('Run the tests and tell me', 'm1')
    const { watcherId } = f.bots.tools.watchers!.start(botId, turn.activation.id, { command: command('late', pidFile('late')), brief: 'Say how the tests went.' })
    await finish(f, turn.payload, 'completed', { text: 'Running.' })
    const prompt = await woken(watcherId)
    expect(prompt).toContain('result=late')
    expect(prompt).toContain('exited with code 0')
    expect(f.bots.tools.watchers!.output!(botId, watcherId)?.output).toContain('result=late')
  })
})

describe('a restart with commands and wake-ups pending', () => {
  it('ends every command, then tells the thread and the bot, and keeps the wake-ups', async () => {
    const record = join(dir, 'monitors.json')
    monitors.close()
    monitors = monitorsOver(record)
    const threadWakesFile = join(dir, 'thread-wakes.json')
    const threadPosts: Array<{ threadId: string; payload: ThreadWakePayload }> = []
    const threadWakes = () => new ThreadWakes({
      file: threadWakesFile,
      post: (threadId, payload) => { threadPosts.push({ threadId, payload }) },
      threadState: () => ({ state: 'deleted' }),
      pullRequestState: async () => ({ none: true }),
      personLastWroteAt: () => undefined,
      threadExists: () => true,
      now: () => f.clock.now
    })
    const wakesBefore = threadWakes()
    const threadWake = await wakesBefore.add('t1', { brief: 'Check the deploy.', dueAt: new Date(f.clock.now + 30 * 60_000).toISOString() })
    await allowCommands()
    const turn = await chat('Watch the build', 'm1')
    const botWake = await f.bots.tools.wakes!.add(botId, turn.activation.id, { brief: 'Ask how the deploy went.', dueAt: new Date(f.clock.now + 30 * 60_000).toISOString() })
    const threadFile = pidFile('thread')
    const botFile = pidFile('bot')
    const monitor = monitors.startMonitor({ threadId: 't1', description: 'CI', command: command('gate', threadFile), cwd: dir })
    const { watcherId } = f.bots.tools.watchers!.start(botId, turn.activation.id, { command: command('gate', botFile), brief: 'Say how it went.' })
    await finish(f, turn.payload, 'completed', { text: 'Watching.' })
    const pids = [await pidOf(threadFile), await pidOf(botFile)]
    await monitors.settled()

    // Mousse closes: each caller ends its own; nobody is told now.
    monitors.close()
    wakesBefore.close()
    f.bots.close()
    await until(() => pids.every((pid) => !alive(pid)))
    expect(posted.filter((entry) => entry.payload.end)).toEqual([])
    expect(jobs.list()).toEqual([])

    // The next start, past the wake-ups' time.
    f.clock.now += 60 * 60_000
    monitors = monitorsOver(record)
    expect(await monitors.recoverOnBoot()).toBe(1)
    expect(posted.at(-1)).toMatchObject({ threadId: 't1', payload: { monitorId: monitor.id, end: { reason: 'restart' } } })
    const wakesAfter = threadWakes()
    wakesAfter.start()
    await until(() => threadPosts.length > 0)
    expect(threadPosts[0]).toMatchObject({ threadId: 't1', payload: { wakeId: threadWake.wakeId } })
    wakesAfter.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await f.bots.maintain(new Date(f.clock.now))
    // Both come back in the chat, one turn at a time: the command's end, said as a restart, and the wake-up at its time.
    expect(f.store.reminder(watcherId)?.fired).toEqual({ kind: 'ended', reason: 'restart' })
    for (const id of [watcherId, botWake.wakeId]) expect(wakeTurn(id)).toMatchObject({ lane: 'chat' })
  })
})
