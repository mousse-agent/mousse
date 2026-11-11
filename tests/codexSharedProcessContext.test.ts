/**
 * One Codex app-server serves every thread of a profile. Its output arrives in the async context of the chat that
 * started the process, as a child's stdout does. A run's events must reach that run's callbacks in the run's own
 * context, after a cut (`turn/interrupt`, then the `turn/start` that carries a person's message) as before it: the
 * orchestrator finds a turn's thread through that context.
 */
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { currentWorkScope, runInWorkScope, threadScope, type WorkScope } from '../src/mms/execution/workScope'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import type { CodexLaunch, CodexProcess } from '../src/mms/harness/vendors/codex/CodexAppServerClient'
import { CodexProviderService } from '../src/mms/harness/vendors/codex/CodexProviderService'

type Message = { id?: number | string; method?: string; params?: Record<string, unknown> }

let home: string
let binary: string
let questions: UserQuestionService
const services: CodexProviderService[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mousse-codex-shared-'))
  binary = join(home, 'codex')
  writeFileSync(binary, '#!/bin/sh\nexit 0\n')
  chmodSync(binary, 0o755)
  questions = new UserQuestionService()
})
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  questions.shutdown()
  rmSync(home, { recursive: true, force: true })
})

/**
 * An app-server whose every output line is written from the async context its launch ran in (its stdout pipe's). A
 * turn whose prompt starts with `LONG` runs until it is interrupted; any other turn streams one reply and a command.
 */
function sharedServer() {
  const launches: CodexLaunch[] = []
  const requests: Message[] = []
  let turns = 0
  let threads = 0
  const launch = (spec: CodexLaunch): CodexProcess => {
    launches.push(spec)
    const stdout = new PassThrough()
    const stdin = new PassThrough()
    // The pipe is created with the process, in the context of the chat that launched it.
    const pipe = new AsyncResource('CodexStdout')
    const send = (message: unknown): void => {
      setImmediate(() => pipe.runInAsyncScope(() => stdout.write(JSON.stringify(message) + '\n')))
    }
    const notify = (method: string, params: unknown): void => send({ method, params })
    const process = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals = 'SIGTERM') {
        if (process.signalCode) return false
        process.signalCode = signal
        setImmediate(() => process.emit('exit', null, signal))
        return true
      }
    })
    let pending = ''
    stdin.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      let end: number
      while ((end = pending.indexOf('\n')) !== -1) {
        const message = JSON.parse(pending.slice(0, end)) as Message
        pending = pending.slice(end + 1)
        requests.push(message)
        if (message.id === undefined || !message.method) continue
        const reply = (result: unknown): void => send({ id: message.id, result })
        const params = message.params ?? {}
        const threadId = String(params.threadId ?? '')
        switch (message.method) {
          case 'initialize':
            reply({ userAgent: 'test', codexHome: '/h/.codex', platformFamily: 'unix', platformOs: 'macos' })
            break
          case 'account/read':
            reply({ account: { type: 'chatgpt', email: 'person@example.invalid', planType: 'plus' }, requiresOpenaiAuth: true })
            break
          case 'thread/start':
            reply({ thread: { id: `thr-${++threads}` }, model: 'gpt-x', modelProvider: 'openai', cwd: home })
            break
          case 'thread/list':
            send({ id: message.id, error: { code: -32601, message: 'unknown method' } })
            break
          case 'turn/start': {
            const turn = { id: `turn-${++turns}`, status: 'inProgress', error: null }
            const text = ((params.input as Array<{ text?: string }> | undefined) ?? []).map((part) => part.text ?? '').join('')
            reply({ turn })
            notify('turn/started', { threadId, turn })
            if (text.startsWith('LONG')) {
              notify('item/started', { threadId, turnId: turn.id, item: { type: 'commandExecution', id: `cmd-${turn.id}`, command: `sleep 10 (${threadId})`, status: 'inProgress' } })
              break
            }
            notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: `msg-${turn.id}`, delta: `Reply in ${threadId} to ${text}` })
            notify('item/started', { threadId, turnId: turn.id, item: { type: 'commandExecution', id: `cmd-${turn.id}`, command: `echo ${threadId}`, status: 'inProgress' } })
            notify('item/completed', { threadId, turnId: turn.id, item: { type: 'commandExecution', id: `cmd-${turn.id}`, command: `echo ${threadId}`, status: 'completed', exitCode: 0, aggregatedOutput: threadId } })
            notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } })
            break
          }
          case 'turn/interrupt':
            reply({})
            notify('turn/completed', { threadId, turn: { id: params.turnId, status: 'interrupted', error: null } })
            break
          default:
            reply({})
        }
      }
    })
    return process as unknown as CodexProcess
  }
  return { launch, launches, requests }
}

function create(server: ReturnType<typeof sharedServer>): CodexProviderService {
  mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
  writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: binary }))
  const service = new CodexProviderService(home, questions, { launch: server.launch }, { launch: () => ({ binaryPath: binary }), signedOut: () => false })
  services.push(service)
  return service
}

it('delivers each thread its own events in its own context, after a steer was cut into the thread that started the process', async () => {
  const server = sharedServer()
  const service = create(server)
  const thread = new AsyncLocalStorage<string>()
  /** Every callback a chat got: the chat it was given to, and the context it ran in (its thread, its work scope). */
  const seen: Array<{ chat: string; context: string | undefined; scope: WorkScope | null; what: string }> = []
  const callbacks = (chat: string) => ({
    onText: (text: string) => seen.push({ chat, context: thread.getStore(), scope: currentWorkScope(), what: text }),
    onTool: (event: { title?: string }) => seen.push({ chat, context: thread.getStore(), scope: currentWorkScope(), what: `tool ${event.title ?? ''}` }),
    onSteer: (text: string) => seen.push({ chat, context: thread.getStore(), scope: currentWorkScope(), what: `steer ${text}` })
  })
  /** A chat run as a turn runs: in its thread's context and work scope. */
  const asThread = <T>(chat: string, work: () => T): T => thread.run(chat, () => runInWorkScope(threadScope(chat), work))

  // Thread A starts the process with a long command; a person's message is cut into its turn.
  let steered = false
  const a = asThread('A', () => service.chat({
    threadId: 'A', cwd: home, model: 'gpt-x', prompt: 'LONG work in A',
    ...callbacks('A'),
    drainSteerEntry: () => {
      if (steered || !server.requests.some((message) => message.method === 'turn/start')) return undefined
      steered = true
      return { text: 'STEER-A please also report the date', token: 'drain-1', cut: true }
    }
  }))
  const resultA = await a
  expect(server.requests.filter((message) => message.method === 'turn/interrupt')).toHaveLength(1)
  expect(resultA.text).toContain('STEER-A')

  // Thread B, then C, run on the same process.
  const resultB = await asThread('B', () => service.chat({ threadId: 'B', cwd: home, model: 'gpt-x', prompt: 'hello from B', ...callbacks('B') }))
  const resultC = await asThread('C', () => service.chat({ threadId: 'C', cwd: home, model: 'gpt-x', prompt: 'hello from C', ...callbacks('C') }))
  expect(server.launches).toHaveLength(1)

  expect(resultB.text).toContain('hello from B')
  expect(resultB.text).not.toContain('STEER-A')
  expect(resultC.text).toContain('hello from C')
  expect(resultC.text).not.toContain('hello from B')
  for (const chat of ['A', 'B', 'C']) expect(seen.filter((entry) => entry.chat === chat).length).toBeGreaterThan(0)
  // Each callback ran in its own chat's context, never in the one that started the process.
  expect(seen.filter((entry) => entry.context !== entry.chat)).toEqual([])
  // And in its own work scope: work a callback starts during B's turn is counted under B.
  expect(seen.filter((entry) => entry.chat === 'B').map((entry) => entry.scope)).toContainEqual(threadScope('B'))
  expect(seen.filter((entry) => JSON.stringify(entry.scope) !== JSON.stringify(threadScope(entry.chat)))).toEqual([])
})
