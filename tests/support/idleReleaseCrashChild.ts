/**
 * A daemon in a child process, for `idleThreadRelease.test.ts`: the test kills it inside an idle thread's release.
 *
 * `first <home> <before|after>`: thread A runs a turn and owes a save; thread B has a turn held and a message queued
 * behind it. A's release starts, and the process kills itself (SIGKILL) at the release save's COMMIT: just before it
 * (`before`) or just after it (`after`). It never returns from the release.
 *
 * `restart <home>`: a new daemon on the same home recovers and drains, and writes what it finds to `result.json`.
 *
 * Every prompt a provider receives is appended to `prompts.log` with the run it came from.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readDurableQueue } from '../../src/mms/queue/durableQueue'
import type { ChatMessage } from '../../src/shared/types'
import { claudeAdapter, phase6Daemon } from '../run/phase6Fixture'

const [mode, home, variant] = process.argv.slice(2) as ['first' | 'restart', string, 'before' | 'after' | undefined]
process.env.MOUSSE_HOME = home
process.env.MOUSSE_SQLITE_THREAD_STORE = '1'
const MODEL = { llmProvider: 'claude-subscription', model: 'vendor-model' }

const waitFor = async (cond: () => boolean, label: string, timeoutMs = 20_000): Promise<void> => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const daemon = (pid: number) => {
  const adapter = claudeAdapter((input) => {
    appendFileSync(join(home, 'prompts.log'), `${mode}:${input.prompt}\n`)
    // A held turn never ends by itself: the process dies with it running.
    if (input.prompt.startsWith('hold')) return new Promise<string>(() => undefined)
    return `reply to ${input.prompt}`
  })
  const d = phase6Daemon(home, [adapter], { pid })
  d.store.setSqliteStoreEnabled(true)
  d.orch.setPersistCallback((threadId) => {
    if (!threadId || !d.store.getThread(threadId) || !d.orch.hasSession(threadId)) return
    d.store.mutateThreadData(threadId, () => ({ messages: d.orch.liveMessagesForSave(threadId) as ChatMessage[], llmContext: d.orch.getNativeContext(threadId) }))
  })
  return d
}

async function first(): Promise<void> {
  const d = daemon(1)
  mkdirSync(join(home, 'project'), { recursive: true })
  const project = d.projects.openProject(join(home, 'project'))
  const a = d.store.createThread('A', project.id)
  const b = d.store.createThread('B', project.id)
  for (const thread of [a, b]) d.orch.setThreadModelOverride(thread.id, MODEL)
  writeFileSync(join(home, 'threads.json'), JSON.stringify({ a: a.id, b: b.id }))

  await d.orch.send('a-first', false, { threadId: a.id, clientRequestId: 'a-1' })
  await waitFor(() => d.orch.releaseHoldReason(a.id) === undefined, `A idle (${d.orch.releaseHoldReason(a.id)})`)

  void d.orch.send('hold-b', false, { threadId: b.id, clientRequestId: 'b-1' })
  await waitFor(() => d.orch.isActiveTurnRunning(b.id), 'B turn')
  const queued = await d.orch.send('b-queued', false, { threadId: b.id, clientRequestId: 'b-2' })
  if (!queued.queued || readDurableQueue(d.store, b.id).length !== 1) throw new Error('B has no queued message')

  // A owes a save: something only memory has.
  d.orch.getOrCreateSession(a.id).messages.push({ id: 'a-owed', role: 'user', content: 'a-owed', timestamp: new Date().toISOString() } as ChatMessage)

  // Killed at the COMMIT of A's next save transaction in its thread.db: the release's save.
  // Paths compared as plain lower-case paths, whatever their slashes or long-path prefix (`\\?\`).
  const normal = (path: string): string => {
    const plain = path.split('\\').join('/').toLowerCase()
    return plain.startsWith('//?/') ? plain.slice(4) : plain
  }
  const target = normal(d.store.getThreadDir(a.id))
  const isA = (db: DatabaseSync): boolean => normal(String(db.location() ?? '')).startsWith(target)
  const exec = DatabaseSync.prototype.exec
  let inSave = false
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    if (sql === 'BEGIN IMMEDIATE' && isA(this)) inSave = true
    if (inSave && sql === 'COMMIT' && isA(this)) {
      if (variant === 'before') process.kill(process.pid, 'SIGKILL')
      exec.call(this, sql)
      process.kill(process.pid, 'SIGKILL')
    }
    return exec.call(this, sql)
  }
  writeFileSync(join(home, 'armed'), d.orch.releaseHoldReason(a.id) ?? 'releasable')
  d.orch.residency.now = () => Date.now() + 60 * 60_000
  d.orch.residency.sweepNow()
  writeFileSync(join(home, 'survived'), '')
  process.exit(0)
}

async function restart(): Promise<void> {
  const d = daemon(2)
  const { a, b } = JSON.parse((await import('node:fs')).readFileSync(join(home, 'threads.json'), 'utf-8')) as { a: string; b: string }
  d.orch.recoverAndDrainPendingQueues()
  await waitFor(() => readDurableQueue(d.store, b).length === 0 && d.engine.getActiveRun(b) === null && !d.orch.isActiveTurnRunning(b), 'B drained')
  // Nothing more starts.
  await new Promise((resolve) => setTimeout(resolve, 500))
  writeFileSync(join(home, 'result.json'), JSON.stringify({
    a: d.store.loadThreadData(a).messages.map((message) => message.content),
    b: d.store.loadThreadData(b).messages.filter((message) => message.role === 'user').map((message) => message.content),
    bQueue: readDurableQueue(d.store, b).length,
    bRuns: d.engine.listRuns(b).map((run) => ({ clientRequestId: run.clientRequestId, status: run.status })),
    bActive: d.engine.getActiveRun(b) !== null
  }))
  await d.stop()
  process.exit(0)
}

void (mode === 'first' ? first() : restart()).catch((error: unknown) => {
  writeFileSync(join(home, 'error.txt'), error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
  process.exit(3)
})
