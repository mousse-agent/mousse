// A stand-in for Pi's RPC mode, for engine lifecycle tests: it reports ready over the engine's bridge
// the way Mousse's extension does, answers the commands the engine sends, and behaves as
// `pi-stub.json` in its working directory says (stall, crash with a helper, settle, fail).
// It makes no network request but to the engine's own bridge on 127.0.0.1.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

const config = existsSync(join(process.cwd(), 'pi-stub.json')) ? JSON.parse(readFileSync(join(process.cwd(), 'pi-stub.json'), 'utf8')) : {}
const bridge = JSON.parse(process.env.MOUSSE_PI_BRIDGE ?? '{}')
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const respond = (command, data) => write({ type: 'response', id: command.id, command: command.type, success: true, ...(data === undefined ? {} : { data }) })

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
  switch (command.type) {
    case 'get_available_models': return respond(command, { models: [] })
    case 'get_state': return respond(command, { sessionId: `stub-${process.pid}` })
    case 'get_session_stats': return respond(command, {})
    case 'clear_queue': return respond(command, { steering: [...(config.queued ?? []), ...queuedSteers.splice(0)], followUp: [] })
    case 'abort':
      respond(command)
      write({ type: 'agent_end', messages: [] })
      return write({ type: 'agent_settled' })
    case 'steer':
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
