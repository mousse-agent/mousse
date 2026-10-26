#!/usr/bin/env node
/**
 * Records an ACP replay fixture (`tests/run/fixtures/<scenario>/<adapter>.ndjson`) from a real
 * agent, in the transcript format `src/mms/run/testkit/acpReplay.ts` replays.
 *
 *   node scripts/record-acp-fixture.mjs --scenario plain-turn --adapter acp --prompt "Say hello" -- grok agent --no-leader stdio
 *
 * Use only an agent that is already signed in: this script never signs in, and it stops if the
 * agent asks for authentication. It opens one session in a temporary folder (deleted afterwards),
 * sends one prompt, and writes what crossed the connection with tokens, home paths and the temporary
 * folder scrubbed. Review the output before committing it.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

function parseArgs(argv) {
  const split = argv.indexOf('--')
  if (split === -1) throw new Error('Pass the agent command after --')
  const options = {}
  const flags = argv.slice(0, split)
  for (let index = 0; index < flags.length; index += 2) options[flags[index].replace(/^--/, '')] = flags[index + 1]
  const [command, ...args] = argv.slice(split + 1)
  if (!command || !options.scenario || !options.adapter || !options.prompt) throw new Error('Need --scenario, --adapter, --prompt and a command')
  return { ...options, command, args }
}

const SECRET = /\b(sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Fa-f0-9]{40,})\b/g

function scrubber(cwd) {
  const home = homedir()
  const walk = (value) => {
    if (typeof value === 'string') return value.split(cwd).join('<cwd>').split(home).join('<home>').replace(SECRET, '<redacted>')
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|authorization/i.test(key)).map(([key, entry]) => [key, walk(entry)]))
    return value
  }
  return walk
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const cwd = mkdtempSync(join(tmpdir(), 'mousse-acp-record-'))
  const scrub = scrubber(cwd)
  const lines = [{ kind: 'transcript', adapter: options.adapter, scenario: options.scenario, boundary: 'ACP JSON-RPC on the agent connection: calls out; session updates and responses in', recordedAt: new Date().toISOString(), version: 1 }]
  const record = (dir, frame) => lines.push({ dir, frame: scrub(frame) })
  const child = spawn(options.command, options.args, { cwd, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  const app = client({ name: 'Mousse' })
  app.onNotification(methods.client.session.update, ({ params }) => record('in', { kind: 'update', update: params.update }))
  app.onRequest(methods.client.session.requestPermission, async () => ({ outcome: { outcome: 'cancelled' } }))
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
  const call = async (method, params) => {
    const { cwd: _cwd, ...recorded } = params
    record('out', { kind: 'request', method, params: recorded })
    try {
      const result = await connection.agent.request(method, params)
      record('in', { kind: 'response', result })
      return result
    } catch (error) {
      record('in', { kind: 'error', message: error instanceof Error ? error.message : String(error) })
      if (error?.code === -32000) throw new Error('The agent asked for a sign-in; sign it in yourself first. Nothing was written.')
      throw error
    }
  }
  try {
    await call(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'Mousse', version: '0.0.0' } })
    const session = await call(methods.agent.session.new, { cwd, mcpServers: [] })
    await call(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: 'text', text: options.prompt }] })
    const target = resolve('tests', 'run', 'fixtures', options.scenario, `${options.adapter}.ndjson`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
    console.log(`Wrote ${target}; review it before committing.`)
  } finally {
    connection.close()
    child.kill()
    rmSync(cwd, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
