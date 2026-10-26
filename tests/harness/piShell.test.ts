import { spawn, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { containedBashOperations, resolveTimeoutMs } from '../../src/mms/harness/pi/extension/shell'

// The contained shell (POSIX in the app) against pinned Pi's own bash operations, both on the same
// bash: here Git Bash on Windows, else /bin/bash. Nothing may run before the group is recorded,
// and a recorded command runs exactly as Pi runs it.

const gitBash = 'C:/Program Files/Git/bin/bash.exe'
const gitSh = 'C:/Program Files/Git/usr/bin/sh.exe'
const gitEnv = 'C:/Program Files/Git/usr/bin/env.exe'
const windows = process.platform === 'win32'
const bash = windows ? gitBash : '/bin/bash'
const sh = windows ? gitSh : '/bin/sh'
const runs = existsSync(bash) && existsSync(sh)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A test's background job may still hold it briefly (Windows).
    }
  }
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-shell-'))
  dirs.push(dir)
  return dir
}

function contained(report: (pgid: number, signal?: AbortSignal) => Promise<void>) {
  const killed: number[] = []
  const ops = containedBashOperations({
    report, shell: bash, gate: sh, detached: !windows, ...(windows ? { envPath: gitEnv } : {}),
    // Windows has no process groups: the test kills the gate process itself.
    killGroup: (pid) => {
      killed.push(pid)
      try { process.kill(windows ? pid : -pid, 'SIGKILL') } catch { /* gone */ }
    },
    spawn: (command: string, args: string[], options: SpawnOptions) => spawn(command, args, options)
  })
  return { ops, killed }
}

async function output(ops: { exec: (command: string, cwd: string, options: { onData: (data: Buffer) => void; env?: NodeJS.ProcessEnv }) => Promise<{ exitCode: number | null }> }, command: string, cwd: string, env?: NodeJS.ProcessEnv) {
  const chunks: Buffer[] = []
  const result = await ops.exec(command, cwd, { onData: (data) => chunks.push(data), ...(env ? { env } : {}) })
  return { text: Buffer.concat(chunks).toString('utf8'), exitCode: result.exitCode }
}

describe.runIf(runs)('contained bash operations, against pinned Pi’s bash', () => {
  const pi = createLocalBashOperations({ shellPath: bash })

  it('runs a multi-line command whose first line reads stdin the way Pi does (stdin at end of file)', async () => {
    const dir = scratch()
    const command = 'cat\nprintf AFTER'
    const ours = await output(contained(async () => {}).ops, command, dir)
    const theirs = await output(pi, command, dir)
    expect(ours).toEqual(theirs)
    expect(ours.text).toBe('AFTER')
  })

  it('a command reading stdin sees end of file as with Pi: `rg -c needle` with no path, `read -r` then a later line', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'a.txt'), 'needle\n')
    for (const command of ['rg -c needle; echo "exit $?"', 'read -r ans; echo "got[$ans]"; echo second']) {
      const ours = await output(contained(async () => {}).ops, command, dir)
      const theirs = await output(pi, command, dir)
      expect(ours, command).toEqual(theirs)
    }
    expect((await output(contained(async () => {}).ops, 'read -r ans; echo "got[$ans]"; echo second', dir)).text).toBe('got[]\nsecond\n')
  })

  it('checks timeouts and the working directory as Pi does', async () => {
    const dir = scratch()
    const { ops } = contained(async () => {})
    for (const timeout of [0, -1, Number.NaN, 3_600_000]) {
      const ourError = await ops.exec('echo x', dir, { onData: () => {}, timeout }).catch((error: Error) => error.message)
      const piError = await pi.exec('echo x', dir, { onData: () => {}, timeout }).catch((error: Error) => error.message)
      expect(ourError, String(timeout)).toBe(piError)
    }
    expect(resolveTimeoutMs(2_147_483.647)).toBe(2_147_483_647)
    // A long timeout is a long timeout: the command runs to its end.
    expect((await output(contained(async () => {}).ops, 'echo fine', dir)).text).toBe('fine\n')
    const okLong = await ops.exec('echo ok', dir, { onData: () => {}, timeout: 2_000_000 })
    expect(okLong.exitCode).toBe(0)
    const missing = join(dir, 'missing')
    const ourError = await ops.exec('echo x', missing, { onData: () => {} }).catch((error: Error) => error.message)
    const piError = await pi.exec('echo x', missing, { onData: () => {} }).catch((error: Error) => error.message)
    expect(ourError).toBe(piError)
  })

  it('an abort during the group request ends it at once (the request gets the signal)', async () => {
    const dir = scratch()
    const controller = new AbortController()
    let sawSignal: AbortSignal | undefined
    const { ops } = contained((_pgid, signal) => new Promise((_resolve, reject) => {
      sawSignal = signal
      signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true })
    }))
    const running = ops.exec('echo x', dir, { onData: () => {}, signal: controller.signal })
    await new Promise((done) => setTimeout(done, 200))
    const startedAt = Date.now()
    controller.abort()
    await expect(running).rejects.toThrow('aborted')
    expect(Date.now() - startedAt).toBeLessThan(2000)
    expect(sawSignal).toBe(controller.signal)
  })

  it('keeps output a background job writes after the shell exited, as Pi does', async () => {
    const dir = scratch()
    const command = '(sleep 0.05; for i in {1..20}; do echo line$i; done) &'
    const ours = await output(contained(async () => {}).ops, command, dir)
    const theirs = await output(pi, command, dir)
    // Under load Pi's own capture can stop early too (its idle grace); ours keeps at least what Pi keeps, and here all of it.
    expect(ours.text.trim().split('\n')).toEqual(expect.arrayContaining(theirs.text.trim().split('\n')))
    expect(ours.text).toContain('line20')
  })

  it('runs no startup file before the group is recorded, and the command still gets BASH_ENV', async () => {
    const dir = scratch()
    const marker = join(dir, 'startup-ran')
    const hook = join(dir, 'hook.sh')
    writeFileSync(hook, `echo ran >> "${marker.split(String.fromCharCode(92)).join('/')}"\n`)
    const env = { ...process.env, BASH_ENV: hook.split(String.fromCharCode(92)).join('/') }
    let ranBeforeReport = true
    const { ops } = contained(async () => {
      await new Promise((done) => setTimeout(done, 300))
      ranBeforeReport = existsSync(marker)
    })
    await output(ops, 'echo "$BASH_ENV" > /dev/null', dir, env)
    expect(ranBeforeReport).toBe(false)
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['ran'])
    // Pi's own bash sources it once too.
    rmSync(marker)
    await output(pi, 'true', dir, env)
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['ran'])
  })

  it('no exported shell function (command, read, [, builtin, exec, unset, export) runs in the gate; the command still gets them', async () => {
    const dir = scratch()
    const marker = join(dir, 'hijacked').split(String.fromCharCode(92)).join('/')
    const env: NodeJS.ProcessEnv = { ...process.env, 'BASH_FUNC_greet%%': '() { echo hello-from-function; }' }
    for (const name of ['command', 'read', '[', 'builtin', 'exec', 'unset', 'export'])
      env[`BASH_FUNC_${name}%%`] = `() { echo ${name} >> "${marker}"; }`
    let before = true
    let rejected = false
    const { ops } = contained(async () => {
      await new Promise((done) => setTimeout(done, 300))
      before = existsSync(marker)
    })
    const result = await output(ops, 'greet', dir, env)
    expect(before).toBe(false)
    expect(existsSync(marker)).toBe(false)
    // The command sees the exported functions, as under Pi.
    const piResult = await output(pi, 'greet', dir, { ...process.env, 'BASH_FUNC_greet%%': '() { echo hello-from-function; }' })
    expect(result.text).toBe(piResult.text)
    expect(result.text).toBe('hello-from-function\n')
    // And when registration fails, nothing runs at all.
    const refused = contained(async () => { throw new Error('engine unreachable') })
    await refused.ops.exec('greet', dir, { onData: () => {}, env }).catch(() => { rejected = true })
    expect(rejected).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  it('runs nothing, startup files included, when the group could not be recorded', async () => {
    const dir = scratch()
    const marker = join(dir, 'ran')
    const hook = join(dir, 'hook.sh')
    writeFileSync(hook, `echo hook >> "${marker.split(String.fromCharCode(92)).join('/')}"\n`)
    const { ops } = contained(async () => { throw new Error('engine unreachable') })
    await expect(output(ops, `echo cmd >> "${marker.split(String.fromCharCode(92)).join('/')}"`, dir, { ...process.env, BASH_ENV: hook.split(String.fromCharCode(92)).join('/') })).rejects.toThrow('engine unreachable')
    await new Promise((done) => setTimeout(done, 300))
    expect(existsSync(marker)).toBe(false)
  })

  it('a Stop before the group is recorded runs nothing and kills the gate', async () => {
    const dir = scratch()
    const marker = join(dir, 'ran')
    const controller = new AbortController()
    const { ops, killed } = contained(async () => { controller.abort() })
    await expect(ops.exec(`echo cmd > "${marker.split(String.fromCharCode(92)).join('/')}"`, dir, { onData: () => {}, signal: controller.signal })).rejects.toThrow('aborted')
    expect(existsSync(marker)).toBe(false)
    expect(killed.length).toBeGreaterThan(0)
  })
})
