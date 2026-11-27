/**
 * A bot's checklist on its summary: the tasks `task_create` keeps on its chat's thread, then on the thread of work it
 * runs now; nothing once that work ended or while it keeps none; and a change to a bot thread's tasks says the bot
 * changed, so the app reads its summary again.
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { botTaskItems } from '../../src/mms/bots/activation/botTasks'
import { BOT_TASKS_SHOWN } from '../../src/shared/bots/personal/chat'
import type { Task } from '../../src/shared/types'
import { botFixture, createBot, flush, start, finish, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
const kept = new Map<string, Task[]>()

const task = (id: string, status: Task['status'] = 'pending', patch: Partial<Task> = {}): Task => ({ id, description: `Task ${id}`, status, createdAt: '2026-11-07T09:00:00.000Z', ...patch })
const summary = () => f.bots.service.list().bots.find((bot) => bot.id === botId)!

beforeEach(async () => {
  f = botFixture()
  f.host.threadTasks = (threadId) => kept.get(threadId) ?? []
  botId = (await createBot(f, { name: 'Pip', reply: 'Hello.' })).botId
})

afterEach(() => {
  kept.clear()
  f.close()
})

it('carries its chat’s tasks, then its running work’s, and drops the work’s once it ends', async () => {
  expect(summary().tasks).toBeUndefined()
  const home = summary().homeThreadId!
  kept.set(home, [task('a', 'completed'), task('b', 'in_progress', { progressMessage: 'Half done' })])
  expect(summary().tasks).toEqual([
    { id: 'a', text: 'Task a', status: 'completed' },
    { id: 'b', text: 'Task b', status: 'in_progress', note: 'Half done' }
  ])

  const run = await f.bots.activate({ botId, input: 'Tidy the notes', clientRequestId: 'r1' })
  kept.set(run.threadId!, [task('c')])
  expect(summary().tasks?.map((item) => item.id)).toEqual(['a', 'b', 'c'])

  const { payload } = await start(f, run.id)
  await finish(f, payload, 'completed', { text: 'Notes tidied.' })
  await flush()
  expect(summary().tasks?.map((item) => item.id)).toEqual(['a', 'b'])
})

it('a change to a bot thread’s tasks says that bot changed; another thread’s says nothing', async () => {
  const changed: Array<{ botId?: string }> = []
  f.bots.events.on('changed', (event) => changed.push(event))
  f.bots.threadTasksChanged(summary().homeThreadId!)
  expect(changed).toEqual([{ botId }])
  f.bots.threadTasksChanged('thread:someone-else')
  expect(changed).toHaveLength(1)
})

it('keeps each task once, the newest when there are many, and skips a thread it cannot read', () => {
  const many = Array.from({ length: BOT_TASKS_SHOWN + 5 }, (_, index) => task(`t${index}`))
  const items = botTaskItems(['home', 'broken', 'work', 'home'], (threadId) => {
    if (threadId === 'broken') throw new Error('gone')
    return threadId === 'home' ? many.slice(0, 10) : many
  })
  expect(items).toHaveLength(BOT_TASKS_SHOWN)
  expect(new Set(items.map((item) => item.id)).size).toBe(BOT_TASKS_SHOWN)
  expect(items.at(-1)?.id).toBe(`t${BOT_TASKS_SHOWN + 4}`)
})
