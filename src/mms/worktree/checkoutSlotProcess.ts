import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'

interface CheckoutCommand {
  file: string
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  input?: string
  limit: number
}

interface CheckoutResult {
  status: number | null
  stdoutBytes: Buffer
  stderr: string
  failure?: { message: string; code?: string }
}

interface CheckoutSlot {
  directory: string
  pid: number
  startedAt: number
  run(command: CheckoutCommand): Promise<CheckoutResult>
}

const activeSlot = new AsyncLocalStorage<CheckoutSlot>()

export function activeCheckoutSlot(cwd: string, argv: readonly string[]): CheckoutSlot | undefined {
  const slot = activeSlot.getStore()
  if (!slot || resolve(cwd) !== slot.directory) return undefined
  let i = 0
  while (argv[i]?.startsWith('-')) i += argv[i] === '-c' || argv[i] === '-C' ? 2 : 1
  if (argv[i] === 'checkout' || argv[i] === 'sparse-checkout' && argv[i + 1] === 'set') return slot
  return undefined
}

// This runs in plain Node, including when the parent is the packaged executable. The process
// that owns the SQLite locks also starts Git and keeps its output pipes open until Git is done.
// An IPC disconnect (including a hard daemon exit) closes admission and drains the active Git
// command. It cannot release the disk slot while the checkout is still writing.
const SLOT_PROCESS = String.raw`
const { DatabaseSync } = require('node:sqlite')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const [gatePath, ...slotPaths] = JSON.parse(process.argv[1])
const exclusiveGate = slotPaths.length === 0
const db = path => new DatabaseSync(path, { timeout: 0 })
let child

function lock(connection, exclusive) {
  try {
    connection.exec(exclusive ? 'BEGIN EXCLUSIVE' : 'BEGIN')
    if (!exclusive) {
      try { connection.exec('SELECT name FROM sqlite_master LIMIT 1') }
      catch (error) { connection.exec('ROLLBACK'); throw error }
    }
    return true
  } catch (error) {
    if (error.errcode % 256 !== 5) throw error
    return false
  }
}

function report(message) {
  if (process.connected) process.send(message, () => {})
}

function run({ file, argv, cwd, env, input, limit }) {
  if (child) throw new Error('A Git checkout is already running in this slot')
  child = spawn(file, argv, { cwd, env, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
  const stdout = [], stderr = []
  let outSize = 0, errSize = 0, failure
  const tooLarge = () => { failure ??= { code: 'ENOBUFS', message: 'Git checkout exceeded its output limit' } }
  child.stdout.on('data', chunk => { outSize += chunk.length; if (outSize > limit) tooLarge(); else stdout.push(chunk) })
  child.stderr.on('data', chunk => { errSize += chunk.length; if (errSize > limit) tooLarge(); else stderr.push(chunk) })
  child.on('error', error => { failure = { message: error.message, code: error.code } })
  child.on('close', status => {
    child = undefined
    report({ status, stdoutBytes: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8'), failure })
  })
  if (input !== undefined) {
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  }
}

async function acquire() {
  const gate = db(gatePath)
  const slots = []
  while (process.connected) {
    if (lock(gate, exclusiveGate)) {
      if (exclusiveGate) return [gate]
      for (const [i, path] of slotPaths.entries()) {
        const slot = slots[i] ??= db(path)
        if (lock(slot, true)) return [gate, ...slots]
      }
      gate.exec('ROLLBACK')
    }
    await delay(25)
  }
  for (const connection of [gate, ...slots]) connection.close()
  return []
}

acquire().then(connections => {
  if (process.connected) {
    process.on('message', run)
    report({ ready: true })
  }
  // close follows Git and its output users. Keep the connections strongly reachable until then.
  process.on('exit', () => { for (const connection of connections) connection.close() })
}).catch(error => {
  report({ failed: error.message })
  if (process.connected) process.disconnect()
  process.exitCode = 1
})
`

export async function runInCheckoutSlot<T>(directory: string, paths: string[], work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const startedAt = Date.now()
  const owner = spawn(process.execPath, ['-e', SLOT_PROCESS, JSON.stringify(paths)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    // On Windows a normal child belongs to libuv's kill-on-close Job Object. Only the slot
    // owner outlives the daemon. Git itself stays attached to the slot owner.
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced'
  })
  const stopped = new AbortController()
  const exited = new Promise<void>((done) => {
    owner.once('error', (error) => { stopped.abort(error); done() })
    owner.once('exit', () => { stopped.abort(new Error('The checkout slot process exited.')); done() })
  })
  const abort = (): void => { if (owner.connected) owner.disconnect() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const [message] = await once(owner, 'message', { signal: stopped.signal })
    if (!message.ready) throw new Error(message.failed ?? 'The checkout slot process did not acquire a slot.')
    signal?.throwIfAborted()
    // Once Git starts, retain its slot until it has drained, even when Stop was requested.
    signal?.removeEventListener('abort', abort)
    return await activeSlot.run({
      directory: resolve(directory), pid: owner.pid!, startedAt,
      run: async (command) => {
        const result = once(owner, 'message', { signal: stopped.signal })
        owner.send(command, (error) => { if (error) stopped.abort(error) })
        return (await result)[0] as CheckoutResult
      }
    }, work)
  } catch (error) {
    signal?.throwIfAborted()
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    abort()
    await exited
  }
}
