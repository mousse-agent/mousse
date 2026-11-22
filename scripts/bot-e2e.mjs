#!/usr/bin/env node
/**
 * Drive a personal bot on a real model in a throwaway Mousse home, then print what each turn cost (`bot_turn_usage`).
 *
 *   node scripts/bot-e2e.mjs --home <test home> [--repo <checkout>] [--build] [--model haiku] [--instance claude]
 *                            [--bot <id>] [--messages N] [--say "text"]... [--wait-work] [--timeout 600] [--stop] [--json]
 *
 * - Starts the checkout's daemon (`out/cli/index.js service run` under Electron) on `--home` unless one already runs
 *   there; `--build` builds the CLI first. `--repo` runs another checkout's build, so two branches can be compared on
 *   the same messages. Never the real `~/.mousse`.
 * - Creates a bot whose four model rows are `--model` on `--instance` (the entry's own sign-in; for the default Claude
 *   entry that is the Claude Code sign-in already on this computer), or reuses `--bot`.
 * - Sends each `--say` text in order (or `--messages N` built-in chat lines), waiting for the chat turn to end each
 *   time; `--wait-work` also waits for work the bot started. Prints each reply in one line.
 * - Prints every turn of the bot: lane, what started it, whether it began a fresh context, the prompt it last sent
 *   (`lastPrompt`), the input it sent in all (fresh input, cache reads and writes), output; and the hello prompt
 *   (smallest prompt a fresh context sent). `--stop` stops the daemon afterwards.
 *
 * Keep the home on a fast disk: the daemon writes synchronously, and on a spinning disk turns that run side by side stall
 * it for seconds, which slows every turn and can fail a turn's start.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, openSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const flag = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback }
const many = (name) => args.flatMap((arg, index) => (arg === name ? [args[index + 1]] : []))
const has = (name) => args.includes(name)
const comparable = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))

const homeArg = flag('--home')
if (!homeArg || has('--help')) {
  console.error('usage: node scripts/bot-e2e.mjs --home <test home> [--repo <checkout>] [--build] [--model haiku] [--instance claude] [--bot <id>] [--messages N] [--say "text"]... [--wait-work] [--timeout 600] [--stop] [--json]')
  process.exit(2)
}
const home = resolve(homeArg)
if (comparable(home) === comparable(join(homedir(), '.mousse'))) {
  console.error('refusing the real ~/.mousse: pick a throwaway home')
  process.exit(2)
}
const repo = resolve(flag('--repo', join(dirname(fileURLToPath(import.meta.url)), '..')))
const model = flag('--model', 'haiku')
const instanceId = flag('--instance', 'claude')
const timeoutMs = Number(flag('--timeout', '600')) * 1000
const json = has('--json')
const log = (...line) => { if (!json) console.log(...line) }

const CHAT_LINES = [
  'Hi! What can you help me with today?',
  'Remember that my favourite colour is green.',
  'What is 17 times 23?',
  'Give me three ideas for a quick dinner.',
  'Which of those is fastest to make?',
  'Summarise what we talked about so far in two lines.',
  'Write a haiku about autumn.',
  'What is my favourite colour?',
  'Name two rivers in Europe.',
  'Thanks, that is all for now.'
]
const said = many('--say')
const messages = said.length ? said : Array.from({ length: Number(flag('--messages', '3')) }, (_, index) => CHAT_LINES[index % CHAT_LINES.length])

// --- daemon -------------------------------------------------------------------------------------------------
const electron = createRequire(join(repo, 'package.json'))('electron')
const cli = join(repo, 'out', 'cli', 'index.js')
/** The protocol the checkout under test speaks, which its own dev probe keeps in step. */
const { DAEMON_PROTOCOL_VERSION: PROTOCOL_VERSION } = await import(pathToFileURL(join(repo, 'scripts', 'mms-dev-probe.mjs')).href)
const daemonEnv = () => {
  const env = { ...process.env, MOUSSE_HOME: home, MOUSSE_ELECTRON_USER_DATA: join(home, 'electron-user-data'), MOUSSE_BROWSER_ROOT: join(home, 'browser'), MOUSSE_ARTIFACT_ROOT: join(home, 'artifacts') }
  delete env.MOUSSE_CLI
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

/** A connection bound to the home's first active profile, speaking the personal bot methods. */
async function connect() {
  const owner = JSON.parse(readFileSync(join(home, 'mms.owner.json'), 'utf-8'))
  const socket = createConnection(owner.endpoint)
  let buffer = Buffer.alloc(0)
  let id = 0
  const pending = new Map()
  const ready = new Promise((resolveReady, rejectReady) => {
    socket.once('error', rejectReady)
    socket.once('connect', () => socket.write(frame({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, ownerToken: owner.token, clientType: 'cli', clientBuild: 'bot-e2e', requestedCapabilities: ['profiles-v1', 'bots.personal.v2'] })))
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0)
        if (buffer.length < size + 4) return
        const envelope = JSON.parse(buffer.subarray(4, size + 4).toString())
        buffer = buffer.subarray(size + 4)
        if (envelope.kind === 'hello_ok') resolveReady()
        else if (envelope.kind === 'hello_err') rejectReady(new Error(envelope.message))
        else if (envelope.kind === 'res') {
          const entry = pending.get(envelope.id)
          pending.delete(envelope.id)
          if (envelope.ok) entry?.resolve(envelope.result)
          else entry?.reject(new Error(`${envelope.error?.code}: ${envelope.error?.message}`))
        }
      }
    })
  })
  await ready
  const request = (method, params) => new Promise((resolveRequest, rejectRequest) => {
    const key = `e2e-${++id}`
    pending.set(key, { resolve: resolveRequest, reject: rejectRequest })
    socket.write(frame({ kind: 'req', id: key, method, params }))
  })
  const { profiles } = await request('profiles.list')
  const profile = profiles.find((entry) => entry.status === 'active')
  if (!profile) throw new Error('the test home has no active profile')
  await request('profiles.bind', { profile: profile.id })
  return { request, profile, close: () => socket.destroy() }
}

/** The pid in the home's owner record while that process lives (the record is rewritten in place, so read it twice). */
function liveOwnerPid() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const pid = JSON.parse(readFileSync(join(home, 'mms.owner.json'), 'utf-8')).pid
      process.kill(pid, 0)
      return pid
    } catch (error) {
      if (error?.code === 'EPERM') return 'alive'
      if (error?.code === 'ESRCH') return undefined
    }
  }
  return undefined
}

async function startDaemon() {
  const until = Date.now() + 120_000
  // A daemon already on this home is used, never a second one started beside it.
  for (;;) {
    try {
      return await connect()
    } catch (error) {
      if (!liveOwnerPid()) break
      if (Date.now() > until) throw new Error(`the daemon on ${home} did not answer within 2 minutes: ${error.message}`)
      await sleep(1000)
    }
  }
  mkdirSync(home, { recursive: true })
  const out = openSync(join(home, 'bot-e2e-daemon.log'), 'a')
  const child = spawn(electron, [cli, 'service', 'run'], { cwd: repo, env: daemonEnv(), detached: true, stdio: ['ignore', out, out], windowsHide: true })
  child.unref()
  log(`started a daemon (pid ${child.pid}) on ${home}; its log is bot-e2e-daemon.log there`)
  const started = Date.now() + 120_000
  for (;;) {
    try {
      return await connect()
    } catch (error) {
      if (Date.now() > started) throw new Error(`the daemon did not answer within 2 minutes: ${error.message}`)
      await sleep(1000)
    }
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// --- the bot ------------------------------------------------------------------------------------------------
/** Until the chat is free (and with `work`, no work or thread of the bot's runs), and, after `afterSeq`, the bot has answered. */
async function waitFor(client, botId, { work, afterSeq }) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const { summary: bot } = await client.request('bots.get', { botId })
    // Work that waits on a wake or an answer is not running; it may wait for good.
    const busy = bot.chat || (work && ((bot.work ?? []).some((item) => item.status === 'running' || item.status === 'queued') ||
      (bot.threads ?? []).some((thread) => ['running', 'queued', 'subagents'].includes(thread.status))))
    // A turn that has not started yet leaves the chat free: wait for the bot's reply too.
    const answered = afterSeq === undefined || (await lastBotLines(client, botId, afterSeq)).length > 0
    if (!busy && answered) return bot
    if (Date.now() > until) throw new Error(`bot still busy after ${timeoutMs / 1000}s`)
    await sleep(2000)
  }
}

async function lastBotLines(client, botId, afterSeq) {
  const { messages: list } = await client.request('bots.chat.list', { botId, limit: 50 })
  return list.filter((message) => message.seq > afterSeq && message.author === 'bot')
}

function usage(profileDir, botId) {
  const file = join(profileDir, 'bots', 'bots.db')
  const db = new DatabaseSync(file, { readOnly: true })
  const rows = db.prepare('SELECT * FROM bot_turn_usage WHERE bot_id = ? AND reports > 0 ORDER BY started_at, dispatch_n').all(botId)
  db.close()
  return rows.map((row) => ({
    lane: row.lane,
    startedBy: row.started_by,
    model: row.model,
    fresh: row.fresh_context === 1,
    lastPrompt: row.last_prompt,
    input: row.input + row.cache_read + row.cache_write,
    cacheRead: row.cache_read,
    output: row.output,
    reports: row.reports,
    systemChars: row.system_chars,
    tools: row.tools,
    toolChars: row.tools_chars,
    compactions: row.compactions
  }))
}

if (has('--build')) {
  const built = spawnSync(process.execPath, ['--input-type=module', '-e', `import { buildCli } from ${JSON.stringify(pathToFileURL(join(repo, 'scripts', 'build-cli.mjs')).href)}; await buildCli({ watch: false })`], { cwd: repo, stdio: json ? 'ignore' : 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
}
if (!existsSync(cli)) {
  console.error(`no CLI build at ${cli}: run with --build`)
  process.exit(2)
}

const client = await startDaemon()
const replies = []
try {
  let botId = flag('--bot')
  if (!botId) {
    const pick = { instanceId, model }
    const created = await client.request('bots.create', {
      look: { colour: 'blue', accessory: 'none' },
      name: `Probe ${model}`,
      description: 'A test helper that does what I ask.',
      clientRequestId: `bot-e2e-${Date.now()}`,
      slots: { talk: pick, light: pick, medium: pick, hard: pick }
    })
    botId = created.bot.id
    log(`created ${botId} on ${instanceId} · ${model}`)
    await waitFor(client, botId, { work: false, afterSeq: 0 })
  }
  let { messages: before } = await client.request('bots.chat.list', { botId, limit: 1 })
  let seq = before.at(-1)?.seq ?? 0
  for (const [index, text] of messages.entries()) {
    const started = Date.now()
    const sent = await client.request('bots.chat.send', { botId, text, clientRequestId: `bot-e2e-${Date.now()}-${index}` })
    seq = Math.max(seq, sent?.message?.seq ?? 0)
    const bot = await waitFor(client, botId, { work: has('--wait-work'), afterSeq: seq })
    const lines = await lastBotLines(client, botId, seq)
    seq = Math.max(seq, ...lines.map((line) => line.seq))
    const reply = lines.map((line) => (line.text ?? `[${line.kind}]`).replace(/\s+/g, ' ')).join(' | ')
    replies.push({ text, reply, seconds: Math.round((Date.now() - started) / 1000), outcome: bot.lastOutcome, error: bot.error })
    log(`#${index + 1} (${Math.round((Date.now() - started) / 1000)}s) > ${text.slice(0, 80)}\n    < ${reply.slice(0, 240)}${bot.error ? `\n    ! ${JSON.stringify(bot.error)}` : ''}`)
  }
  const profileDir = readdirSync(join(home, 'profiles')).map((name) => join(home, 'profiles', name)).find((dir) => dir.endsWith(client.profile.id)) ?? join(home, 'profiles', client.profile.id)
  const turns = usage(profileDir, botId)
  const fresh = turns.filter((turn) => turn.fresh && typeof turn.lastPrompt === 'number')
  const helloPrompt = fresh.length ? Math.min(...fresh.map((turn) => turn.lastPrompt)) : null
  if (json) console.log(JSON.stringify({ home, repo, botId, model, helloPrompt, replies, turns }, null, 2))
  else {
    console.log(`\n${botId}: ${turns.length} turns, helloPrompt ${helloPrompt ?? '-'}`)
    console.log('  n  lane   startedBy  fresh  lastPrompt     input  output  rep  sysChars  tools')
    turns.forEach((turn, index) => console.log(`${String(index + 1).padStart(3)}  ${turn.lane.padEnd(5)}  ${String(turn.startedBy).padEnd(9)}  ${turn.fresh ? 'yes' : 'no '}    ${String(turn.lastPrompt ?? '-').padStart(10)}  ${String(turn.input).padStart(8)}  ${String(turn.output).padStart(6)}  ${String(turn.reports).padStart(3)}  ${String(turn.systemChars ?? '-').padStart(8)}  ${String(turn.tools ?? '-').padStart(5)}`))
  }
} finally {
  client.close()
  if (has('--stop')) spawnSync(electron, [cli, 'service', 'stop'], { cwd: repo, env: daemonEnv(), stdio: 'ignore', windowsHide: true })
}
