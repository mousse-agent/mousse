// Checks that the Pi runtime Mousse ships starts and answers, with no credentials and no model call.
//
//   node scripts/check-pi-runtime-install.mjs                       dev: out/pi-runtime (built when missing), run by this Node
//   node scripts/check-pi-runtime-install.mjs --app <resources/app.asar> --exec <Mousse executable>
//                                                                   packaged (electron-builder --dir): the unpacked copy, run by Electron as Node
//
// It first checks that every package Pi would load is inside the runtime. Then it starts Pi in RPC
// mode the way the launcher does (argv flags, private agent dir, offline), with a clean environment
// and an empty user home; round-trips get_state and get_available_models; loads photon-node; checks
// that Mousse's extension loaded; has Pi's `bash` start a long-lived grandchild; kills the tree with
// the app's own tree kill (`processTree.mjs`); and checks that the grandchild is gone. Anything it
// started is killed at the end whatever happened. A receipt goes to .mousse-dev/logs/pi-runtime-check.json.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { killProcessTree } from '../src/mms/harness/processTree.mjs'
import { buildPiRuntime, runtimeProblems } from './build-pi-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STEP_MS = 30_000

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const app = option('--app')
const exec = resolve(option('--exec') ?? process.execPath)
const base = app ? (app.endsWith('.asar') ? `${resolve(app)}.unpacked` : resolve(app)) : root
const runtime = join(base, 'out', 'pi-runtime')
const asNode = Boolean(app) || Boolean(process.versions.electron)
if (!app && !existsSync(join(runtime, 'pi-coding-agent/dist/bundle/rpc-entry.js'))) await buildPiRuntime(root)

const packageRoot = join(runtime, 'pi-coding-agent')
const entry = join(packageRoot, 'dist', 'bundle', 'rpc-entry.js')
const extension = join(runtime, 'mousse-extension.mjs')
for (const path of [entry, extension, join(packageRoot, 'package.json'), join(packageRoot, 'node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm')])
  if (!existsSync(path)) throw new Error(`Pi runtime file missing: ${path}`)
// Node resolves a missing package from any node_modules above the runtime (the repository's, the
// user's home), so a start alone cannot prove the runtime is complete.
const problems = runtimeProblems(packageRoot)
if (problems.length) throw new Error(`The Pi runtime would load packages it does not ship: ${problems.join('; ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'mousse-pi-check-'))
const home = join(scratch, 'home')
const userHome = join(scratch, 'user')
mkdirSync(home)
mkdirSync(userHome)

// Only what a process needs to start; no credentials, and a user home with nothing in it.
const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG']
const env = Object.fromEntries(keep.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]))
Object.assign(env, {
  HOME: userHome,
  USERPROFILE: userHome,
  PI_CODING_AGENT_DIR: home,
  PI_PACKAGE_DIR: packageRoot,
  PI_OFFLINE: '1',
  PI_SKIP_VERSION_CHECK: '1',
  PI_TELEMETRY: '0',
  AWS_MAX_ATTEMPTS: '1',
  AWS_RETRY_MODE: 'standard',
  ...(asNode ? { ELECTRON_RUN_AS_NODE: '1' } : {})
})

const args = [entry, '--session-dir', join(scratch, 'sessions'), '--no-extensions', '-e', extension,
  '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve']
const started = Date.now()
const child = spawn(exec, args, { cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16_384) })
const exited = new Promise((resolveExit) => child.once('close', (code, signal) => resolveExit({ code, signal })))

const pending = new Map()
const decoder = new StringDecoder('utf8')
let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += decoder.write(chunk)
  for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
    const line = buffer.slice(0, newline).replace(/\r$/, '')
    buffer = buffer.slice(newline + 1)
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record?.type === 'response' && pending.has(record.id)) {
      pending.get(record.id)(record)
      pending.delete(record.id)
    }
  }
})

let sequence = 0
function send(command) {
  const id = `check-${++sequence}`
  return within(new Promise((resolveResponse, reject) => {
    pending.set(id, resolveResponse)
    exited.then(({ code }) => reject(new Error(`Pi exited (${code}) before answering ${command.type}:\n${stderr}`)))
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
  }), command.type)
}

function within(promise, what, ms = STEP_MS) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms:\n${stderr}`)), ms) })])
    .finally(() => clearTimeout(timer))
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function until(test, what) {
  const deadline = Date.now() + STEP_MS
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
}

const receipt = { exec, runtime, platform: process.platform, asNode }
/** Processes the check started through Pi, killed in `finally` whatever happened. */
const fixtures = new Set()
try {
  // Image resizing loads photon-node (and its wasm) lazily, resolved from the bundle's chunks.
  const photon = spawnSync(exec, ['-e', `const m = require('node:module').createRequire(${JSON.stringify(join(packageRoot, 'dist/bundle/chunks/x.js'))})('@silvia-odwyer/photon-node'); if (typeof m.PhotonImage !== 'function') process.exit(2)`],
    { env, cwd: scratch, windowsHide: true, timeout: STEP_MS, encoding: 'utf8' })
  if (photon.status !== 0) throw new Error(`photon-node did not load (${photon.status}): ${photon.stderr}`)
  receipt.photon = true

  const state = await send({ type: 'get_state' })
  if (!state.success) throw new Error(`get_state failed: ${state.error}`)
  receipt.readyMs = Date.now() - started
  receipt.sessionId = state.data.sessionId
  const models = await send({ type: 'get_available_models' })
  if (!models.success || !Array.isArray(models.data?.models)) throw new Error(`get_available_models failed: ${models.error}`)
  receipt.models = models.data.models.length
  if (receipt.models !== 0) throw new Error(`Pi listed ${receipt.models} models with no credentials`)
  // A failed extension load is only a startup warning, so ask Pi for the command the extension registers.
  const commands = await send({ type: 'get_commands' })
  const marker = commands.data?.commands?.find((command) => command.name === 'mousse-extension' && command.source === 'extension')
  if (!marker) throw new Error(`Mousse's extension did not load:
${stderr}`)
  receipt.extension = marker.sourceInfo?.path ?? true

  // A grandchild through Pi's own shell, so the kill has a real tree to take down.
  const pidFile = join(scratch, 'grandchild.pid').replace(/\\/g, '/')
  const program = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
  const command = `${JSON.stringify(exec.replace(/\\/g, '/'))} -e ${JSON.stringify(program).replace(/\$/g, '\\$')}`
  const shell = send({ type: 'bash', command }).catch((error) => error)
  await until(() => existsSync(pidFile) || child.exitCode !== null, 'the grandchild to start')
  const grandchild = Number(readFileSync(pidFile, 'utf8'))
  fixtures.add(grandchild)
  if (!alive(grandchild)) throw new Error('The grandchild was not running')
  // The app's own tree kill: on POSIX Pi's shell runs in its own process group.
  killProcessTree(child.pid)
  const exit = await within(exited, 'Pi to exit after the tree kill')
  await until(() => !alive(grandchild), 'the grandchild to die')
  await shell
  receipt.treeKill = { grandchild, piExit: exit, grandchildGone: true }
  receipt.ok = true
} catch (error) {
  receipt.ok = false
  receipt.error = error instanceof Error ? error.message : String(error)
  if (child.exitCode === null && child.signalCode === null) killProcessTree(child.pid)
} finally {
  for (const pid of fixtures) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

const logDir = resolve(root, '.mousse-dev/logs')
mkdirSync(logDir, { recursive: true })
writeFileSync(join(logDir, 'pi-runtime-check.json'), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify(receipt, null, 2))
process.exit(receipt.ok ? 0 : 1)
