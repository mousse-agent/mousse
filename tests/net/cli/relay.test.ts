import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { buildTestCli } from '../helpers/build'
import { newId } from '../../../src/shared/net/ids'
import { prepareRelayCommand } from '../../../src/cli/commands/relay'
import { parseArgs } from '../../../src/cli/parseArgs'
import { endpoint, identity } from '../relay/endpoints'

let fixture: Awaited<ReturnType<typeof buildTestCli>> | undefined
let entry: string
beforeAll(async () => {
  fixture = await buildTestCli()
  entry = fixture.entry
}, 120000)
afterAll(() => fixture?.cleanup())

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function waitFor<T>(probe: () => T, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = probe()
    if (ready(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Relay CLI timed out')
}

it('recognizes relay serve at the CLI dispatch boundary', () => {
  expect(parseArgs(['relay', 'serve', '--database', 'relay.sqlite'])).toMatchObject({
    command: 'relay',
    subcommand: 'serve',
    positional: []
  })
})

it.skipIf(process.platform === 'win32')(
  'serves authenticated opaque bytes from the real CLI and closes cleanly on both signals',
  async () => {
    // This assertion makes the pre-fix regression safe: an unknown command would enter chat.
    expect(parseArgs(['relay', 'serve']).command).toBe('relay')
    const directory = await mkdtemp(join(tmpdir(), 'mnfix-relay-cli-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const home = join(directory, 'unused-home')
    const a = identity()
    const b = identity()
    const nodesPath = join(directory, 'nodes.json')
    await writeFile(nodesPath, JSON.stringify([a, b]))
    const database = join(directory, 'relay.sqlite')
    const launch = async (host = '127.0.0.1') => {
      const child = spawn(
        process.execPath,
        [
          entry,
          'relay',
          'serve',
          '--host',
          host,
          '--port',
          '0',
          '--database',
          database,
          '--allow-nodes',
          nodesPath
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, MOUSSE_HOME: home }
        }
      )
      let output = ''
      let errors = ''
      child.stdout!.on('data', (bytes) => {
        output += bytes.toString()
      })
      child.stderr!.on('data', (bytes) => {
        errors += bytes.toString()
      })
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }))
      })
      cleanup.push(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
      })
      const address = await waitFor(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Relay exited before readiness: ${output}\n${errors}`)
        }
        return /Relay listening at (ws:\/\/\S+)/.exec(output)?.[1] ?? ''
      }, Boolean)
      expect(output).toContain('net transport configure relay --settings-file')
      return { child, exited, address }
    }
    const first = await launch()
    const left = endpoint(first.address)
    const right = endpoint(first.address)
    cleanup.push(() => {
      left.ws.terminate()
      right.ws.terminate()
    })
    expect((await right.authenticate(b, 'listen')).reply).toEqual({ t: 'ready' })
    expect((await left.authenticate(a, 'dial', b.node)).reply).toEqual({ t: 'ready' })
    expect(JSON.parse((await left.next()).toString()).t).toBe('paired')
    expect(JSON.parse((await right.next()).toString()).t).toBe('paired')
    left.ws.send(Buffer.from('opaque inner TLS bytes'))
    expect((await right.next()).toString()).toBe('opaque inner TLS bytes')
    right.ws.send(Buffer.from('response bytes'))
    expect((await left.next()).toString()).toBe('response bytes')
    const unknown = endpoint(first.address)
    cleanup.push(() => unknown.ws.terminate())
    expect((await unknown.authenticate(identity(), 'listen')).reply).toEqual({
      t: 'error',
      code: 'forbidden'
    })
    const closed = new Promise((resolve) => left.ws.once('close', resolve))
    first.child.kill('SIGTERM')
    expect(await first.exited).toEqual({ code: 0, signal: null })
    await closed
    expect((await readFile(database)).length).toBeGreaterThan(0)
    await expect(readdir(home)).rejects.toMatchObject({ code: 'ENOENT' })
    const second = await launch('::1')
    expect(new URL(second.address).hostname).toBe('[::1]')
    const ipv6 = endpoint(second.address)
    cleanup.push(() => ipv6.ws.terminate())
    expect((await ipv6.authenticate(a, 'listen')).reply).toEqual({ t: 'ready' })
    second.child.kill('SIGINT')
    expect(await second.exited).toEqual({ code: 0, signal: null })
  }
)

it('prepares all relay options and validates public allow lists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mnfix-relay-options-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const who = identity()
  const nodes = join(directory, 'nodes.json')
  const users = join(directory, 'users.json')
  const user = { user: newId('user'), rootKey: who.signKey }
  await writeFile(nodes, JSON.stringify([who]))
  await writeFile(users, JSON.stringify([user]))
  expect(
    prepareRelayCommand(
      parseArgs([
        'relay',
        'serve',
        '--mode',
        'json',
        '--database',
        'relay.sqlite',
        '--host',
        '0.0.0.0',
        '--port',
        '9000',
        '--public-address',
        'wss://relay.example.com/mousse-relay',
        '--allow-nodes',
        nodes,
        '--allow-users',
        users,
        '--bytes-per-hour',
        '10000',
        '--connections-per-hour',
        '10',
        '--max-connections',
        '4',
        '--max-connections-per-principal',
        '2',
        '--maximum-queued-bytes',
        '65536'
      ])
    )
  ).toEqual({
    databasePath: resolve('relay.sqlite'),
    host: '0.0.0.0',
    port: 9000,
    publicAddress: 'wss://relay.example.com/mousse-relay',
    allowNodes: [{ node: who.node, signKey: who.signKey }],
    allowUsers: [user],
    bytesPerHour: 10000,
    connectionsPerHour: 10,
    maxConnections: 4,
    maxConnectionsPerPrincipal: 2,
    maximumQueuedBytes: 65536
  })
  const defaults = prepareRelayCommand(parseArgs(['relay', 'serve', '--database', 'relay.sqlite']))
  expect(defaults.host).toBe('127.0.0.1')
  expect(defaults.allowNodes).toEqual([])
  expect(defaults.allowUsers).toEqual([])
  await writeFile(nodes, JSON.stringify([{ node: who.node, signKey: 'not-a-key' }]))
  expect(() =>
    prepareRelayCommand(
      parseArgs(['relay', 'serve', '--database', 'relay.sqlite', '--allow-nodes', nodes])
    )
  ).toThrow()
})

it.each([
  ['--host', '0.0.0.0'],
  ['--public-address', 'ws://relay.example.com/mousse-relay'],
  ['--public-address', 'wss://relay.example.com/wrong-path'],
  ['--public-address', 'wss://relay.example.com/mousse-relay?node=nod_bad'],
  ['--port', '65536'],
  ['--bytes-per-hour', '0'],
  ['--connections-per-hour', '1.5'],
  ['--maximum-queued-bytes'],
  ['--unknown-option', '1']
])('rejects invalid relay options %j before opening a database', (...flags) => {
  expect(() =>
    prepareRelayCommand(parseArgs(['relay', 'serve', '--database', 'relay.sqlite', ...flags]))
  ).toThrow()
})
