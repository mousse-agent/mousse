// A stand-in for Pi's RPC mode, for engine lifecycle tests: it reports ready over the engine's bridge
// the way Mousse's extension does, answers the commands the engine sends, and behaves as
// `pi-stub.json` in its working directory says (stall, crash with a helper, settle, fail).
// It makes no network request but to the engine's own bridge on 127.0.0.1.
//
// `onPrompt: 'script'` behaves as Pi 1.4.0 did in spike S3 (docs/design/steer-and-interruptions.md): replies stream,
// a native `steer` is queued and read only at a step boundary (right after `turn_end`, one user message per steer),
// `clear_queue` empties that queue, `abort` ends the running prompt with `agent_settled` (`aborted: true`) before its
// own response and leaves the queue as it is, retries emit an `agent_end` per failed attempt and one `agent_settled`,
// and a prompt sent while one runs is refused. Everything it reads and settles is appended to `log.jsonl`.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

const config = existsSync(join(process.cwd(), 'pi-stub.json')) ? JSON.parse(readFileSync(join(process.cwd(), 'pi-stub.json'), 'utf8')) : {}
const bridge = JSON.parse(process.env.MOUSSE_PI_BRIDGE ?? '{}')
const scripted = config.onPrompt === 'script'
/** A prompt runs: from its `agent_start` to its `agent_settled`. */
let running = false
const log = (entry) => {
  if (scripted) appendFileSync(join(process.cwd(), 'log.jsonl'), `${JSON.stringify({ ...entry, at: Date.now() })}\n`)
}
const track = (value) => {
  if (value.type === 'agent_start') running = true
  if (value.type === 'agent_settled') running = false
  if (['agent_end', 'agent_settled', 'turn_end', 'auto_retry_start', 'compaction_start', 'compaction_end'].includes(value.type)) log({ event: value.type, ...(value.aborted ? { aborted: true } : {}) })
  if (value.type === 'message_start' && value.message?.role === 'user') log({ read: value.message.content?.[0]?.text })
}
const write = (value) => {
  track(value)
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
/** Several records in one write, so the engine reads them in one stdout chunk. */
const writeTogether = (values) => {
  for (const value of values) track(value)
  process.stdout.write(values.map((value) => `${JSON.stringify(value)}\n`).join(''))
}
const response = (command, data) => ({ type: 'response', id: command.id, command: command.type, success: true, ...(data === undefined ? {} : { data }) })
const respond = (command, data) => write(response(command, data))

function post(name, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = request(`${bridge.url}/pi/${name}`, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve(text ? JSON.parse(text) : {}))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

/** A helper that outlives a crash: it holds Pi's stdout unless `detached`. */
function helper(detached) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: detached ? 'ignore' : ['ignore', 'inherit', 'ignore'], detached: false, windowsHide: true })
  writeFileSync(join(process.cwd(), 'helper.pid'), String(child.pid))
}

setTimeout(() => {
  void post('ready', { guarded: [], aws: { maxAttempts: process.env.AWS_MAX_ATTEMPTS ?? null, retryMode: process.env.AWS_RETRY_MODE ?? null }, reason: 'startup' })
}, config.readyDelayMs ?? 0)
if (config.helperAtStart) helper(true)

/** Native steers Pi queued and has not read (`onPrompt: 'steerAtEnd'`, `steerDelayMs`): `clear_queue` returns them. */
const queuedSteers = []
/** `onPrompt: 'steerAtEnd'`: the prompt's last step has ended and the prompt settles once a steer is queued. */
let settleOnSteer = false
/** `steer: 'hangSecond'`: the native steers received so far. */
let steersSeen = 0

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const command = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    handle(command)
  }
})

function handle(command) {
  if (scripted && ['prompt', 'steer', 'clear_queue', 'abort'].includes(command.type)) log({ command: command.type, ...(command.message !== undefined ? { message: command.message } : {}) })
  switch (command.type) {
    case 'get_available_models': return respond(command, { models: [] })
    case 'get_state': return respond(command, { sessionId: `stub-${process.pid}` })
    case 'get_session_stats': return respond(command, {})
    case 'clear_queue': {
      const steering = [...(config.queued ?? []), ...queuedSteers.splice(0)]
      log({ cleared: steering })
      return respond(command, { steering, followUp: [] })
    }
    case 'abort':
      // `abort: 'never'`: Pi neither answers nor settles (the engine's deadline must end the cut).
      if (config.abort === 'never') return
      if (scripted && checking) checking.aborted = true
      if (scripted && current) return current.abort(command)
      // As Pi: the running prompt settles first, then the abort is answered; an idle Pi only answers.
      if (running) {
        write({ type: 'agent_end', messages: [] })
        write({ type: 'agent_settled', aborted: true })
      }
      return respond(command)
    case 'steer':
      if (scripted) return scriptSteer(command)
      // `steer: 'hangSecond'` (with `onPrompt: 'steerAtEnd'`): Pi queues the first steer unread and runs one more step;
      // the second is never answered (the engine's command deadline kills the process), and the prompt settles.
      if (config.steer === 'hangSecond' && settleOnSteer) {
        steersSeen += 1
        if (steersSeen === 1) {
          queuedSteers.push(command.message)
          respond(command)
          write({ type: 'turn_start' })
          write({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } })
          return write({ type: 'turn_end' })
        }
        settleOnSteer = false
        write({ type: 'agent_end', messages: [] })
        return write({ type: 'agent_settled' })
      }
      // `steerDelayMs`: Pi queues the steer and answers only after the delay.
      if (config.steerDelayMs) {
        return void setTimeout(() => {
          queuedSteers.push(command.message)
          respond(command)
        }, config.steerDelayMs)
      }
      respond(command)
      if (!settleOnSteer) return
      // Queued after Pi's last check of its queue: the prompt ends without reading it, and Pi keeps it for the next.
      settleOnSteer = false
      queuedSteers.push(command.message)
      write({ type: 'agent_end', messages: [] })
      return write({ type: 'agent_settled' })
    case 'prompt':
      if (scripted) return startRun(command)
      // Pi answers a prompt only after its preflight: a stall never answers.
      if (config.onPrompt === 'stall') return
      // A slow preflight (a compaction): the prompt is answered late and then runs.
      if (config.onPrompt === 'slowAck') {
        return void setTimeout(() => {
          respond(command)
          writeFileSync(join(process.cwd(), 'ran.txt'), 'the stopped prompt ran')
          write({ type: 'agent_start' })
          write({ type: 'agent_end', messages: [] })
          write({ type: 'agent_settled' })
        }, config.ackDelayMs ?? 1500)
      }
      respond(command)
      write({ type: 'agent_start' })
      if (config.onPrompt === 'crash') {
        helper(false)
        return setTimeout(() => process.exit(3), 50)
      }
      if (config.onPrompt === 'hang') return
      if (config.onPrompt === 'steerAtEnd') {
        // The last step ends; the engine answers `turn_end` with a native steer, which arrives too late to be read.
        settleOnSteer = true
        write({ type: 'turn_start' })
        write({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } })
        return write({ type: 'turn_end' })
      }
      if (config.onPrompt === 'stepThenHang') {
        // One step ends (the engine answers `turn_end` with a native steer), and the prompt runs on until `abort`.
        write({ type: 'turn_start' })
        write({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }], stopReason: 'toolUse' } })
        return write({ type: 'turn_end' })
      }
      if (config.onPrompt === 'turn') {
        // As the extension's `before_agent_start` does: the turn the engine hands out.
        return void post('turn', {}).then((turn) => {
          writeFileSync(join(process.cwd(), 'turn.json'), JSON.stringify(turn))
          write({ type: 'agent_end', messages: [] })
          write({ type: 'agent_settled' })
        })
      }
      for (const event of config.events ?? []) write(event)
      write({ type: 'agent_end', messages: [] })
      return write({ type: 'agent_settled' })
    default:
      return respond(command)
  }
}

// -- `onPrompt: 'script'` ---------------------------------------------------------------------------
//
// `config.runs[i]` lists the steps of the i-th prompt (the last list repeats). A step is one model request:
// - `{ text: 'a b c', deltaMs }`: the reply streams word by word and ends (`forever: true` streams until `abort`);
// - `tools: [{ name, args, runMs }]`: the reply ends with those calls, which then run together;
// - `fail: true, delayMs`: the request fails and Pi retries after `delayMs` (an `agent_end` per failed attempt);
// - `compactMs`: Pi compacts its context for that long before the request (an abort does not stop it);
// - `waitSteer: 'readFirst' | 'okThenStart' | 'startThenOk'`: the request waits for the next native steer and then
//   reads it before answering it, or answers it in the same stdout chunk as the reply's start, in either order.
// Steers left in the queue after the last step are read as one more step (`config.steerReply`, default 'answered').
// `config.steerDelayMs` answers a native steer late (it is queued at once); `config.abortSettleDelayMs` delays the
// aborted prompt's `agent_settled` after its `agent_end`.

/** The prompt running now. */
let current
let promptCount = 0

function scriptSteer(command) {
  // `steerAnswer`: Pi takes the steer out of its queue at once and shows it `readAfterMs` later; it answers after
  // `delayMs` (a read that crosses its answer or a `clear_queue`, spike S3 items 4–5).
  if (config.steerAnswer) {
    const { delayMs = 0, readAfterMs = delayMs } = config.steerAnswer
    const user = { role: 'user', content: [{ type: 'text', text: command.message }] }
    setTimeout(() => respond(command), delayMs)
    setTimeout(() => {
      write({ type: 'message_start', message: user })
      write({ type: 'message_end', message: user })
    }, readAfterMs)
    return
  }
  // The next step waits for this steer (`waitSteer`).
  if (current?.wantSteer) {
    current.wantSteer = false
    if (!current.steerWaiter) return void (current.steerInbox = command)
    const wake = current.steerWaiter
    current.steerWaiter = undefined
    return wake(command)
  }
  queuedSteers.push(command.message)
  if (config.steerDelayMs) return void setTimeout(() => respond(command), config.steerDelayMs)
  respond(command)
}

/** A later prompt Pi is still checking (`continuationDelayMs`): an abort meanwhile means it runs no request. */
let checking

function startRun(command) {
  if (promptCount > 0 && config.continuationDelayMs && !command.checked) {
    checking = { aborted: false }
    const entry = checking
    return void setTimeout(() => {
      if (checking === entry) checking = undefined
      if (!entry.aborted) return startRun({ ...command, checked: true })
      // As Pi (spike S3 item 7): answered, its user message recorded, no request, settled as aborted.
      log({ prompt: command.message, abortedBeforeRequest: true })
      respond(command)
      write({ type: 'agent_start' })
      write({ type: 'agent_end', messages: [] })
      write({ type: 'agent_settled', aborted: true })
    }, config.continuationDelayMs)
  }
  if (running || current || (promptCount > 0 && config.refuseContinuation)) {
    log({ refused: command.message })
    return write({ type: 'response', id: command.id, command: 'prompt', success: false, error: 'Agent is already processing.' })
  }
  const runs = config.runs ?? [[{ text: 'ok' }]]
  const run = {
    steps: [...runs[Math.min(promptCount, runs.length - 1)]],
    aborted: undefined,
    cancel: undefined,
    steerWaiter: undefined,
    abort(abortCommand) {
      if (run.aborted) return respond(abortCommand)
      run.aborted = abortCommand
      // `abortAnswerFirst`: the abort is answered before the prompt settles (only the settlement says it is over).
      if (config.abortAnswerFirst) {
        respond(abortCommand)
        run.answered = true
      }
      run.cancel?.()
    }
  }
  promptCount += 1
  current = run
  log({ prompt: command.message })
  respond(command)
  write({ type: 'agent_start' })
  // The prompt's own user message, as Pi records it.
  write({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: command.message }] } })
  write({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: command.message }] } })
  void execute(run)
}

/** Waits `ms`; false when an abort cut it short. A compaction passes `abortable: false`. */
function wait(run, ms, abortable = true) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      run.cancel = undefined
      resolve(true)
    }, ms)
    if (!abortable) return
    run.cancel = () => {
      clearTimeout(timer)
      run.cancel = undefined
      resolve(false)
    }
  })
}

const assistant = (content, stopReason) => ({ role: 'assistant', content, stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })

async function execute(run) {
  let pending = []
  let attempt = 0
  let index = 0
  let calls = 0
  let afterTools = false
  for (;;) {
    // After tool results Pi always asks the model again; queued steers are read as a step of their own.
    const step = run.steps[index] ?? (pending.length ? { text: config.steerReply ?? 'answered' } : afterTools ? { text: 'done' } : undefined)
    if (!step) break
    index += 1
    afterTools = false
    write({ type: 'turn_start' })
    for (const text of pending.splice(0)) {
      write({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } })
      write({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } })
    }
    if (step.compactMs) {
      write({ type: 'compaction_start', reason: 'threshold' })
      await wait(run, step.compactMs, false)
      write({ type: 'compaction_end', reason: 'threshold', result: { summary: 'compacted' }, aborted: false, willRetry: false })
      if (run.aborted) return finishAborted(run, undefined)
    }
    if (step.fail) {
      attempt += 1
      write({ type: 'message_start', message: assistant([], 'error') })
      write({ type: 'message_end', message: { ...assistant([], 'error'), errorMessage: '503 Service unavailable' } })
      write({ type: 'turn_end' })
      write({ type: 'agent_end', messages: [] })
      write({ type: 'auto_retry_start', attempt, maxAttempts: 5, delayMs: step.delayMs ?? 100, errorMessage: '503 Service unavailable' })
      if (!(await wait(run, step.delayMs ?? 100))) {
        // As Pi: a cancelled backoff ends the retry and settles the prompt at once.
        write({ type: 'auto_retry_end', success: false, attempt, finalError: 'Retry cancelled' })
        return finishSettled(run)
      }
      write({ type: 'agent_start' })
      continue
    }
    let opened = false
    const open = () => {
      if (!opened) write({ type: 'message_start', message: assistant([], 'stop') })
      opened = true
    }
    if (step.waitSteer) {
      const inbox = run.steerInbox
      run.steerInbox = undefined
      const steer = inbox ?? await new Promise((resolve) => {
        run.steerWaiter = resolve
        run.cancel = () => {
          run.steerWaiter = undefined
          run.cancel = undefined
          resolve(undefined)
        }
      })
      if (!steer) return finishAborted(run, undefined)
      const user = { role: 'user', content: [{ type: 'text', text: steer.message }] }
      if (step.waitSteer === 'readFirst') {
        write({ type: 'message_start', message: user })
        write({ type: 'message_end', message: user })
        respond(steer)
        open()
      } else {
        // Pi checked its queue before the steer came: it waits for the next step.
        queuedSteers.push(steer.message)
        opened = true
        const start = { type: 'message_start', message: assistant([], 'stop') }
        writeTogether(step.waitSteer === 'okThenStart' ? [response(steer), start] : [start, response(steer)])
      }
    }
    open()
    let text = ''
    const words = String(step.text ?? '').split(' ').filter(Boolean)
    for (let word = 0; step.forever || word < words.length; word += 1) {
      const delta = `${text ? ' ' : ''}${step.forever ? `word${word}` : words[word]}`
      text += delta
      write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } })
      if (!(await wait(run, step.deltaMs ?? 20))) return finishAborted(run, text)
    }
    const tools = (step.tools ?? []).map((tool) => ({ ...tool, id: `call_${(calls += 1)}` }))
    const content = [...(text ? [{ type: 'text', text }] : []), ...tools.map((tool) => ({ type: 'toolCall', id: tool.id, name: tool.name, arguments: tool.args ?? {} }))]
    write({ type: 'message_end', message: assistant(content, tools.length ? 'toolUse' : 'stop') })
    if (attempt) {
      write({ type: 'auto_retry_end', success: true, attempt })
      attempt = 0
    }
    if (tools.length) {
      for (const tool of tools) write({ type: 'tool_execution_start', toolCallId: tool.id, toolName: tool.name, args: tool.args ?? {} })
      const finished = await wait(run, Math.max(...tools.map((tool) => tool.runMs ?? 20)))
      for (const tool of tools) {
        write({ type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.name, isError: !finished, result: { content: [{ type: 'text', text: finished ? 'done' : 'Operation aborted' }] } })
      }
      if (!finished) {
        write({ type: 'turn_end' })
        return finishAborted(run, undefined, true)
      }
      afterTools = true
    }
    write({ type: 'turn_end' })
    // Pi reads its steering queue right after `turn_end`: a steer sent in reply to it is too late for this step.
    pending = queuedSteers.splice(0)
    if (!tools.length && !pending.length && index >= run.steps.length) break
    // The next request waits for the native steer the engine sends in reply to this `turn_end`.
    if (run.steps[index]?.waitSteer) run.wantSteer = true
    // The next request goes out a moment later.
    if (!(await wait(run, 2))) return finishAborted(run, undefined, true)
  }
  write({ type: 'agent_end', messages: [] })
  return finishSettled(run)
}

/** An abort ended the prompt: its reply as written so far, then `agent_end`, `agent_settled` and the abort's answer. */
async function finishAborted(run, partial, ended = false) {
  if (!ended) {
    write({ type: 'message_end', message: assistant(partial ? [{ type: 'text', text: partial }] : [], 'aborted') })
    write({ type: 'turn_end' })
  }
  write({ type: 'agent_end', messages: [] })
  if (config.abortSettleDelayMs) await new Promise((resolve) => setTimeout(resolve, config.abortSettleDelayMs))
  return finishSettled(run)
}

function finishSettled(run) {
  if (current === run) current = undefined
  write({ type: 'agent_settled', ...(run.aborted ? { aborted: true } : {}) })
  if (run.aborted && !run.answered) respond(run.aborted)
}
