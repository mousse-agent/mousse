import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { PROCESS_LIST_TIMEOUT_MS, SPAWN_ANCHOR_SLACK_MS, WINDOWS_TABLE_SCRIPT } from '../git/stoppedGitTree'

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
  /** The slot stopped Git, and Git and every process it started have exited. */
  stopped?: boolean
}

interface CheckoutSlot {
  directory: string
  pid: number
  startedAt: number
  /** `onStopped` runs when the slot stopped Git and Git and every process it started have exited. */
  run(command: CheckoutCommand, signal?: AbortSignal, onStopped?: () => void): Promise<CheckoutResult>
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
// command. An explicit cancellation stops the writer and waits for its process tree to exit.
const SLOT_PROCESS = String.raw`
const { DatabaseSync } = require('node:sqlite')
const { execFile, spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const [gatePath, ...slotPaths] = JSON.parse(process.argv[1])
const exclusiveGate = slotPaths.length === 0
const db = path => new DatabaseSync(path, { timeout: 0 })
const windows = process.platform === 'win32'
let cancel

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

function runTool(file, args) {
  return new Promise(done => {
    execFile(file, args, { windowsHide: true, timeout: ${PROCESS_LIST_TIMEOUT_MS}, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      done(error ? undefined : stdout)
    })
  })
}

function isLive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

async function windowsProcesses() {
  const rows = await runTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ${JSON.stringify(WINDOWS_TABLE_SCRIPT)}])
  return rows?.trim().split(/\r?\n/).map(row => row.trim().split(/\s+/).map(Number))
}

async function stopWindowsTree(child, startedAt) {
  const pid = child.pid
  const table = await windowsProcesses()
  const root = table?.find(([id]) => id === pid)
  // A reused PID must never become a target for taskkill.
  const slack = ${SPAWN_ANCHOR_SLACK_MS} * 10000
  const anchor = (startedAt + 11644473600000) * 10000
  if (root?.[2] && Math.abs(root[2] - anchor) > slack) return false
  const owned = new Map([[pid, root?.[2]]])
  if (table) {
    for (let grew = true; grew;) {
      grew = false
      for (const [id, parent, created] of table) {
        if (owned.has(id) || !owned.has(parent) || created && created < (owned.get(parent) || anchor - slack)) continue
        owned.set(id, created)
        grew = true
      }
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    await runTool('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  // Output can close while a descendant with redirected streams is still exiting.
  while ([...owned.keys()].some(isLive)) {
    const remaining = await windowsProcesses()
    if (remaining) {
      const survivors = remaining.filter(([id, , created]) => owned.has(id) && (!owned.get(id) || owned.get(id) === created))
      if (!survivors.length) break
      // Git can exit before taskkill walks its children. Stop any surviving descendants
      // whose creation time still identifies them, then confirm they actually exited.
      const descendants = survivors.filter(([id, , created]) => id !== pid && created && created === owned.get(id))
      if (descendants.length) await runTool('taskkill.exe', [...descendants.flatMap(([id]) => ['/PID', String(id)]), '/T', '/F'])
    }
    await delay(50)
  }
  // Without a process table, only Git itself is known to have exited.
  return Boolean(table)
}

async function stopProcessGroup(pid) {
  try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code === 'ESRCH') return true }
  while (isLive(-pid)) {
    // A defunct process holds no files and can remain visible until its new parent reaps it.
    const rows = await runTool('ps', ['-A', '-o', 'pgid=,stat='])
    if (rows && !rows.split(/\r?\n/).some(row => {
      const [group, status] = row.trim().split(/\s+/)
      return Number(group) === pid && !status?.startsWith('Z')
    })) return true
    await delay(50)
  }
  return true
}

function run({ file, argv, cwd, env, input, limit }) {
  if (cancel) throw new Error('A Git checkout is already running in this slot')
  const startedAt = Date.now()
  const child = spawn(file, argv, { cwd, env, windowsHide: true, detached: !windows, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
  let stopping
  cancel = () => {
    if (child.pid) stopping ??= windows ? stopWindowsTree(child, startedAt) : stopProcessGroup(child.pid)
  }
  const stdout = [], stderr = []
  let outSize = 0, errSize = 0, failure
  const tooLarge = () => { failure ??= { code: 'ENOBUFS', message: 'Git checkout exceeded its output limit' } }
  child.stdout.on('data', chunk => { outSize += chunk.length; if (outSize > limit) tooLarge(); else stdout.push(chunk) })
  child.stderr.on('data', chunk => { errSize += chunk.length; if (errSize > limit) tooLarge(); else stderr.push(chunk) })
  child.on('error', error => { failure = { message: error.message, code: error.code } })
  child.on('close', async status => {
    const stopped = await stopping === true
    cancel = undefined
    report({ status, stdoutBytes: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8'), failure, stopped })
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
    process.on('message', message => {
      if (message.cancel) cancel?.()
      else run(message)
    })
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
    // eslint-disable-next-line mousse/no-console-window -- The slot owner outlives the daemon. It is Electron as Node, a GUI program with no console that starts plain spawns hidden.
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
    signal?.removeEventListener('abort', abort)
    return await activeSlot.run({
      directory: resolve(directory), pid: owner.pid!, startedAt,
      run: async (command, commandSignal, onStopped) => {
        const cancellation = signal && commandSignal && signal !== commandSignal
          ? AbortSignal.any([signal, commandSignal])
          : commandSignal ?? signal
        cancellation?.throwIfAborted()
        const cancel = (): void => { if (owner.connected) owner.send({ cancel: true }, () => {}) }
        const result = once(owner, 'message', { signal: stopped.signal })
        cancellation?.addEventListener('abort', cancel, { once: true })
        try {
          owner.send(command, (error) => { if (error) stopped.abort(error) })
          // Keep both leases until the slot owner confirms the writer and its descendants have stopped.
          const [message] = await result
          if ((message as CheckoutResult).stopped) onStopped?.()
          cancellation?.throwIfAborted()
          return message as CheckoutResult
        } finally {
          cancellation?.removeEventListener('abort', cancel)
        }
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
