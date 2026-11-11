// A stand-in for Pi's RPC mode, for engine lifecycle tests: it reports ready over the engine's bridge
// the way Mousse's extension does, answers the commands the engine sends, and behaves as
// `pi-stub.json` in its working directory says (stall, crash with a helper, settle, fail).
// It makes no network request but to the engine's own bridge on 127.0.0.1.
//
// `onPrompt: 'script'` behaves as Pi 1.4.0 did in spike S3 (docs/design/steer-and-interruptions.md) and as its agent
// loop reads (`pi-agent-core` `agent-loop.js`): replies stream; a native `steer` is queued, and Pi takes one steer
// from its queue per step (`one-at-a-time`) right after `turn_end`, prepares the next step (a moment, or a compaction),
// then starts it (`turn_start`) and shows the steer as a user message. Until it shows it, Pi keeps the steer's text,
// and `clear_queue` returns it. `abort` ends the running prompt with `agent_settled` (`aborted: true`) before its own
// response and leaves the queue as it is; it stops a compaction; during a tool batch Pi starts no further call of it
// (the ones not started get no event at all), and the call at Mousse's gate ends only once the gate answers. Retries
// emit an `agent_end` per failed attempt and one `agent_settled`, and a prompt sent while one runs is refused.
// Everything it reads and settles is appended to `log.jsonl`.
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
  if (['agent_end', 'agent_settled', 'turn_start', 'turn_end', 'auto_retry_start', 'compaction_start', 'compaction_end', 'tool_execution_start', 'tool_execution_end'].includes(value.type)) log({ event: value.type, ...(value.aborted ? { aborted: true } : {}), ...(value.toolCallId ? { call: value.toolCallId } : {}) })
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
      const clear = () => {
        // Pi returns every text it keeps, a steer it took out of its queue for the next step and has not shown included.
        const steering = [...(config.queued ?? []), ...queuedSteers.splice(0), ...steeringTexts.splice(0)]
        agentQueue.splice(0)
        log({ cleared: steering })
        respond(command, { steering, followUp: [] })
      }
      // `clearDelayMs`: Pi reads the command a moment later (it serves its input between the steps of its loop).
      if (config.clearDelayMs) return void setTimeout(clear, config.clearDelayMs)
      return clear()
    }
    case 'abort':
      // `abort: 'never'`: Pi neither answers nor settles (the engine's deadline must end the cut).
      if (config.abort === 'never') return
      // `abort: 'crash'`: Pi dies as the abort arrives.
      if (config.abort === 'crash') return void process.exit(3)
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
// - `tools: [{ name, args, runMs, gate }]`: the reply ends with those calls. Pi starts them one after another, each
//   through Mousse's gate when `gate` is set (the engine's real `/pi/gate`, as the extension's `beforeToolCall`), then
//   runs the allowed ones together. After an abort it starts none of the rest;
// - `fail: true, delayMs`: the request fails and Pi retries after `delayMs` (an `agent_end` per failed attempt);
// - `prepareMs`: Pi prepares this step that long after the previous step's end (by default at once), with the steer
//   it took out of its queue not shown yet; `compactMs`: then it compacts for that long (an abort stops it);
// - `holdMs`: the reply starts and writes nothing for that long; `compactionLost`: a compaction starts while Pi
//   prepares the step and its end event never comes;
// - `waitSteer: 'readFirst' | 'okThenStart' | 'startThenOk'`: the request waits for the next native steer and then
//   reads it before answering it, or answers it in the same stdout chunk as the reply's start, in either order.
// Steers left in the queue after the last step are read as one more step each (`config.steerReply`, default
// 'answered'). `config.compactAfterMs`: Pi compacts after the prompt's `agent_end`, before `agent_settled`;
// `config.settleDelayMs`: its before-settle step then takes that long.
// `config.steerDelayMs` answers a native steer late (it is queued at once); `config.abortSettleDelayMs` delays the
// aborted prompt's `agent_settled` after its `agent_end`.

/** The prompt running now. */
let current
let promptCount = 0
/** The texts of the steers Pi was sent and has not shown (Pi's `_steeringMessages`): `clear_queue` returns them. */
const steeringTexts = []
/** Pi's steering queue: a step's end takes one (`one-at-a-time`); its text stays in `steeringTexts` until shown. */
const agentQueue = []

function scriptSteer(command) {
  // The next step waits for this steer (`waitSteer`).
  if (current?.wantSteer) {
    current.wantSteer = false
    if (!current.steerWaiter) return void (current.steerInbox = command)
    const wake = current.steerWaiter
    current.steerWaiter = undefined
    return wake(command)
  }
  // As Pi's `steer`: a leading `/` names a skill or prompt template, which Pi expands before it queues the text.
  const text = command.message.startsWith('/') ? `Expanded ${command.message.slice(1)}` : command.message
  steeringTexts.push(text)
  agentQueue.push(text)
  if (config.steerDelayMs) return void setTimeout(() => respond(command), config.steerDelayMs)
  respond(command)
}

/** Pi shows a steer it took out of its queue: a user message, and its text is no longer kept. */
function show(text) {
  const index = steeringTexts.indexOf(text)
  if (index >= 0) steeringTexts.splice(index, 1)
  write({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } })
  write({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } })
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
  write({ type: 'turn_start' })
  // The prompt's own user message, as Pi records it.
  write({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: command.message }] } })
  write({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: command.message }] } })
  void execute(run)
}

/** Waits `ms`; false when an abort cut it short (or had already come). `abortable: false`: Pi does not stop for it. */
function wait(run, ms, abortable = true) {
  if (abortable && run.aborted) return Promise.resolve(false)
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

/** Mousse's gate for a call (the extension's `beforeToolCall`): Pi waits for its answer whatever an abort says. */
async function gate(run, tool) {
  run.token ??= (await post('turn', {})).attemptToken
  return post('gate', { attemptToken: run.token, toolCallId: tool.id, toolName: tool.name, input: tool.args ?? {} })
}

/** Pi compacts its context (`compaction_start` .. `compaction_end`); an abort stops it. */
async function compact(run, ms) {
  write({ type: 'compaction_start', reason: 'threshold' })
  const done = await wait(run, ms)
  write({ type: 'compaction_end', reason: 'threshold', ...(done ? { result: { summary: 'compacted' } } : {}), aborted: !done, willRetry: false })
}

async function execute(run) {
  /** The steer Pi took out of its queue for the next step (one at a time), not shown yet. */
  let pending = []
  let attempt = 0
  let index = 0
  let calls = 0
  let afterTools = false
  /** The step starts a prompt or a retry (`turn_start` is out already, or comes with no preparation). */
  let fresh = true
  for (;;) {
    // After tool results Pi always asks the model again; a steer it took is read in a step of its own.
    const step = run.steps[index] ?? (pending.length ? { text: config.steerReply ?? 'answered' } : afterTools ? { text: 'done' } : undefined)
    if (!step) break
    index += 1
    afterTools = false
    if (!fresh) {
      // Pi prepares the next step (`prepareNextTurn`): the steer it took stays unshown meanwhile. Usually that takes a
      // millisecond or two, and a steer sent in reply to `turn_end` misses the next request (spike S3 item 11).
      if (step.prepareMs || step.compactMs || step.compactionLost) {
        if (step.prepareMs) await wait(run, step.prepareMs, false)
        if (step.compactMs && !run.aborted) await compact(run, step.compactMs)
        // `compactionLost`: a compaction whose end event never comes.
        if (step.compactionLost) write({ type: 'compaction_start', reason: 'threshold' })
        // A long preparation: Pi polls its queue again, only if it took nothing at the step's end.
        if (!pending.length && agentQueue.length) pending = [agentQueue.shift()]
      }
      write({ type: 'turn_start' })
    } else if (attempt) write({ type: 'turn_start' })
    fresh = false
    for (const text of pending.splice(0)) show(text)
    // An aborted signal ends the request at once.
    if (run.aborted) return finishAborted(run, undefined)
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
      fresh = true
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
        steeringTexts.push(steer.message)
        agentQueue.push(steer.message)
        opened = true
        const start = { type: 'message_start', message: assistant([], 'stop') }
        writeTogether(step.waitSteer === 'okThenStart' ? [response(steer), start] : [start, response(steer)])
      }
    }
    open()
    // `holdMs`: the reply starts and writes nothing for that long.
    if (step.holdMs && !(await wait(run, step.holdMs))) return finishAborted(run, undefined, true)
    let text = ''
    const words = String(step.text ?? '').split(' ').filter(Boolean)
    for (let word = 0; step.forever || word < words.length; word += 1) {
      const delta = `${text ? ' ' : ''}${step.forever ? `word${word}` : words[word]}`
      text += delta
      write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } })
      if (!(await wait(run, step.deltaMs ?? 20))) return finishAborted(run, text, true)
    }
    const tools = (step.tools ?? []).map((tool) => ({ ...tool, id: `call_${(calls += 1)}` }))
    const content = [...(text ? [{ type: 'text', text }] : []), ...tools.map((tool) => ({ type: 'toolCall', id: tool.id, name: tool.name, arguments: tool.args ?? {} }))]
    write({ type: 'message_end', message: assistant(content, tools.length ? 'toolUse' : 'stop') })
    if (attempt) {
      write({ type: 'auto_retry_end', success: true, attempt })
      attempt = 0
    }
    if (tools.length) {
      const end = (tool, isError, result) => write({ type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.name, isError, result: { content: [{ type: 'text', text: result }] } })
      // Pi starts the calls one after another, each through the gate; after an abort it starts none of the rest.
      const runnable = []
      for (const tool of tools) {
        write({ type: 'tool_execution_start', toolCallId: tool.id, toolName: tool.name, args: tool.args ?? {} })
        const verdict = tool.gate ? await gate(run, tool) : { allow: true }
        if (run.aborted) {
          end(tool, true, 'Operation aborted')
          break
        }
        if (!verdict.allow) end(tool, true, verdict.reason ?? 'Tool execution was blocked')
        else runnable.push(tool)
      }
      const finished = runnable.length ? await wait(run, Math.max(...runnable.map((tool) => tool.runMs ?? 20))) : !run.aborted
      for (const tool of runnable) end(tool, !finished, finished ? 'done' : 'Operation aborted')
      afterTools = true
    }
    write({ type: 'turn_end' })
    // Pi takes one steer from its queue right after `turn_end`: a steer sent in reply to it is too late for this step.
    if (agentQueue.length) pending = [agentQueue.shift()]
    if (!tools.length && !pending.length && index >= run.steps.length) break
    // The next request waits for the native steer the engine sends in reply to this `turn_end`.
    if (run.steps[index]?.waitSteer) run.wantSteer = true
  }
  write({ type: 'agent_end', messages: [] })
  // A compaction after the prompt's end, before it settles (an abort stops it).
  if (config.compactAfterMs && !run.aborted) await compact(run, config.compactAfterMs)
  // `settleDelayMs`: Pi's before-settle step (extensions' `agent_before_settle`) takes that long.
  if (config.settleDelayMs) await new Promise((resolve) => setTimeout(resolve, config.settleDelayMs))
  return finishSettled(run)
}

/** An abort ended the request: its reply as written so far, then `turn_end`, `agent_end`, `agent_settled` and the abort's answer. */
async function finishAborted(run, partial, opened = false) {
  if (!opened) write({ type: 'message_start', message: assistant([], 'aborted') })
  // `abortedText`: the aborted message carries words Pi received but never streamed.
  const words = `${partial ?? ''}${config.abortedText ?? ''}`
  write({ type: 'message_end', message: assistant(words ? [{ type: 'text', text: words }] : [], 'aborted') })
  write({ type: 'turn_end' })
  write({ type: 'agent_end', messages: [] })
  if (config.abortSettleDelayMs) await new Promise((resolve) => setTimeout(resolve, config.abortSettleDelayMs))
  return finishSettled(run)
}

function finishSettled(run) {
  if (current === run) current = undefined
  write({ type: 'agent_settled', ...(run.aborted ? { aborted: true } : {}) })
  if (run.aborted && !run.answered) respond(run.aborted)
}
