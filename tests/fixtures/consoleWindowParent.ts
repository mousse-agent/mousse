// Run by Electron as Node with no console, like Mousse's background processes. Starts the console probe through each
// way Mousse starts a program and prints what each probe reports. argv: node.exe, probe script, koffi path.
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { spawnGit, stopGitSpawnWorkers } from '../../src/mms/git/gitSpawn'
import { windowsGitRuntime } from '../../src/mms/git/windowsGitProcess'
import { spawnWindowsJobProcess } from '../../src/mms/harness/windowsJobProcess'

const [, , node, probe, koffi] = process.argv as [string, string, string, string, string]
const args = [probe]
const load = createRequire(__filename)
const ffi = load(koffi) as typeof import('koffi')
const consoleWindow = ffi.load('kernel32.dll').func('void * __stdcall GetConsoleWindow()')

function report(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    child.stdout!.on('data', (data) => { out += data })
    child.stderr?.on('data', (data) => { err += data })
    child.on('error', (error) => resolve({ error: String(error) }))
    child.on('close', (code) => {
      try { resolve(JSON.parse(out)) } catch { resolve({ error: 'exit ' + code + ': ' + out + err }) }
    })
  })
}

const native = windowsGitRuntime(load, koffi)
async function launcher(options: { detached?: boolean }): Promise<unknown> {
  const job = native.job()
  try {
    return await report(native.spawn(node, args, options, job.name))
  } finally {
    native.close(job.owned)
  }
}

const results: Record<string, unknown> = {}
results.parent = { window: consoleWindow() !== null }
// Electron hides the console of a plain spawn (no windowsHide); this pins that against an Electron upgrade.
results['child_process'] = await report(spawn(node, args))
results['spawnGit helper'] = await report(spawnGit(node, args))
results['Git launcher'] = await launcher({})
results['Git launcher, detached'] = await launcher({ detached: true })
const signal = new AbortController().signal
const job = spawnWindowsJobProcess({ command: node, args, cwd: process.cwd(), env: process.env, signal })
results['provider job'] = await report(job.child)
await job.stop()
await stopGitSpawnWorkers()
process.stdout.write(JSON.stringify(results))
process.exit(0)
