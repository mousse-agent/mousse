/**
 * Stopping Antigravity ends every process it started. The agent's launcher starts the real agent,
 * which starts a helper of its own (the 1.1.1 server's `localharness_external`); closing the
 * connection must end all of them, not only the launcher. Real processes: death is the claim.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { antigravityConnectionFactory } from '../../src/mms/harness/acp/presets/antigravity'
import { closeAcpConnection } from '../../src/mms/harness/acp/connection'

const dirs: string[] = []
const pids: number[] = []
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

/**
 * A stand-in agent: it starts a helper that outlives it unless its tree is ended, writes both pids,
 * and then waits on stdin like an ACP agent. On POSIX it is the executable itself (its launch
 * arguments are ignored); on Windows Node runs it as the 1.1.1 server's launch would.
 */
function standInAgent(dir: string): { binary: string; kind: 'legacy' | 'native'; args: string[]; pidFile: string } {
  const pidFile = join(dir, 'pids.json')
  const script = join(dir, 'agent.cjs')
  writeFileSync(script, [
    process.platform === 'win32' ? '' : `#!${process.execPath}`,
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    // Node puts its children in a job that dies with it on Windows; a real agent's helper is not in one.
    `const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: ${process.platform === 'win32'} })`,
    `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ agent: process.pid, helper: helper.pid }))`,
    "process.stdin.resume()",
    "setInterval(() => {}, 1000)"
  ].join('\n'))
  if (process.platform === 'win32') return { binary: process.execPath, kind: 'legacy', args: [script], pidFile }
  chmodSync(script, 0o755)
  return { binary: script, kind: 'native', args: [], pidFile }
}

describe('stopping Antigravity', () => {
  it('ends the agent and the helper it started, not only the launched process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-agy-stop-'))
    dirs.push(dir)
    const agent = standInAgent(dir)
    const connect = antigravityConnectionFactory({
      profileDir: join(dir, 'profile'),
      profileHome: dir,
      runtime: () => ({ kind: agent.kind, binary: agent.binary }),
      args: () => agent.args,
      env: (base) => base
    })
    const active = connect({ purpose: 'turn', handlers: { requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) } })
    expect(await until(() => existsSync(agent.pidFile), 15_000)).toBe(true)
    const started = JSON.parse(readFileSync(agent.pidFile, 'utf8')) as { agent: number; helper: number }
    pids.push(started.agent, started.helper)
    expect(alive(started.helper)).toBe(true)

    closeAcpConnection(active)

    expect(await until(() => !alive(started.agent), 10_000)).toBe(true)
    expect(await until(() => !alive(started.helper), 10_000)).toBe(true)
  }, 40_000)
})
