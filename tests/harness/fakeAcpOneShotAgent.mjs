// A scripted ACP agent, run as a real process over stdio (hand-authored: it proves Mousse's side only). What it does
// with a prompt comes from its entry's variables, which reach it through the sealed launch:
// FAKE_ACP_MODE: answer (default) | tool (reports a tool call) | write (writes a file in its folder) |
//   grandchild (starts a detached process that outlives it, then answers) | permission (asks to run a command) |
//   auth (answers the prompt that it needs a sign-in)
// FAKE_ACP_ANSWER: the answer's text. FAKE_ACP_LOG: a file it appends what it saw to, one JSON line per event.
import { appendFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'

const mode = process.env.FAKE_ACP_MODE ?? 'answer'
const log = (event) => { if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(event) + '\n') }
const say = (c, text) => c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })

log({ event: 'start', pid: process.pid, cwd: process.cwd(), env: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TMP: process.env.TMP, APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, secret: process.env.MOUSSE_ONE_SHOT_TEST_SECRET ?? null } })

agent({ name: 'fake-one-shot' })
  .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'fake-one-shot', version: '0.0.1' }, authMethods: [], agentCapabilities: {} }))
  .onRequest(methods.agent.session.new, (c) => {
    log({ event: 'session', cwd: c.params.cwd, mcpServers: c.params.mcpServers })
    return { sessionId: `s-${process.pid}` }
  })
  .onRequest(methods.agent.session.prompt, async (c) => {
    const text = c.params.prompt.map((block) => block.text ?? '').join('')
    log({ event: 'prompt', text })
    if (mode === 'auth') throw RequestError.authRequired()
    if (mode === 'tool') {
      await c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run command', kind: 'execute', status: 'pending' } })
    } else if (mode === 'permission') {
      await c.client.request(methods.client.session.requestPermission, { sessionId: c.params.sessionId, toolCall: { toolCallId: 't1', title: 'Run command' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] }).catch(() => undefined)
    } else if (mode === 'write') {
      writeFileSync(join(process.cwd(), 'notes.txt'), 'written by the agent')
    } else if (mode === 'grandchild') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      log({ event: 'grandchild', pid: child.pid })
    }
    await say(c, process.env.FAKE_ACP_ANSWER ?? 'A scripted title')
    return { stopReason: 'end_turn' }
  })
  .onNotification(methods.agent.session.cancel, () => {})
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
