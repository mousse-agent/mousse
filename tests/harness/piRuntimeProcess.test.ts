import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPiExtensionBuildOptions } from '../../scripts/build-pi-runtime.mjs'
import { instanceEnv } from '../../src/mms/harness/env'
import { piLaunch, startPiProcess, type PiProcess, type PiRuntimePaths } from '../../src/mms/harness/pi/launch'
import type { PiRpcExit } from '../../src/mms/harness/pi/rpcClient'
import { killTree, observeHarnessSpawns, type HarnessSpawn } from '../../src/mms/harness/spawn'

// Real child processes, local only: no model request is ever made, and the only key is a fake one
// that Pi, offline and never prompted, has no reason to send anywhere.

const repoRoot = resolve(__dirname, '..', '..')
const piPackage = join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent')
const scratch: string[] = []
const running: PiProcess[] = []
/** Processes a test started through Pi: killed after it whatever happened. */
const fixtures: number[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

afterEach(() => {
  for (const started of running.splice(0)) killTree(started.child)
  for (const pid of fixtures.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/**
 * What a process needs to start, and on Windows where programs are installed: Pi looks for Git
 * Bash under %ProgramFiles% before PATH, where `bash.exe` may be WSL's.
 */
const SYSTEM_VARIABLES = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'ComSpec', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'TEMP', 'TMP', 'TMPDIR']

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-pi-process-'))
  scratch.push(dir)
  const stateDir = join(dir, 'state')
  const userHome = join(dir, 'user')
  mkdirSync(join(stateDir, 'home'), { recursive: true })
  mkdirSync(userHome)
  // A clean environment with an empty user home, so nothing of the developer's reaches the child.
  const base: NodeJS.ProcessEnv = {
    ...Object.fromEntries(SYSTEM_VARIABLES.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
    HOME: userHome,
    USERPROFILE: userHome,
    OPENAI_API_KEY: 'fake-openai-key',
    ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat-fake',
    AWS_MAX_ATTEMPTS: '5',
    AWS_RETRY_MODE: 'adaptive',
    AWS_REGION: 'eu-west-1'
  }
  const env = instanceEnv({ instanceId: 'pi:openrouter', driver: 'pi', configRevision: 0, home: join(stateDir, 'home'), searchPath: [], base })
  return { dir, stateDir, base, env }
}

describe('Pi runtime process', () => {
  it('starts through spawnHarness, and the child sees the launcher\'s environment (AWS pinned to one attempt)', async () => {
    const { dir, stateDir, base, env } = setup()
    // A stand-in entry that answers get_state with the variables it was started with.
    const entry = join(dir, 'rpc-entry.mjs')
    writeFileSync(entry, [
      "import { createInterface } from 'node:readline'",
      "const names = ['AWS_MAX_ATTEMPTS', 'AWS_RETRY_MODE', 'AWS_REGION', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_PACKAGE_DIR']",
      'createInterface({ input: process.stdin }).on(\'line\', (line) => {',
      '  const command = JSON.parse(line)',
      '  const data = { argv: process.argv.slice(2), env: Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])) }',
      "  process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true, data }) + '\\n')",
      '})'
    ].join('\n'))
    const runtime: PiRuntimePaths = { root: dir, entry, extension: join(dir, 'ext.mjs') }
    const launched = piLaunch({ env, runtime, stateDir, provider: 'openrouter', model: 'm', thinking: 'off', ambient: { ...base, OPENROUTER_API_KEY: 'fake-openrouter-key' } })
    if (launched.runs !== 'yes') throw new Error(launched.reason)
    const spawns: HarnessSpawn[] = []
    const stop = observeHarnessSpawns((spawned) => spawns.push(spawned))
    const exits: PiRpcExit[] = []
    const started = startPiProcess(env, launched, { cwd: dir, handlers: { exit: (exit) => exits.push(exit) } })
    running.push(started)
    stop()
    expect(spawns).toEqual([expect.objectContaining({ instanceId: 'pi:openrouter', purpose: 'turn', command: process.execPath })])

    const state = await started.client.send({ type: 'get_state' }) as unknown as { argv: string[]; env: Record<string, string | null> }
    expect(state.env).toEqual({
      AWS_MAX_ATTEMPTS: '1',
      AWS_RETRY_MODE: 'standard',
      AWS_REGION: 'eu-west-1',
      OPENROUTER_API_KEY: 'fake-openrouter-key',
      OPENAI_API_KEY: null,
      ANTHROPIC_OAUTH_TOKEN: null,
      PI_CODING_AGENT_DIR: join(stateDir, 'home'),
      PI_OFFLINE: '1',
      PI_PACKAGE_DIR: dir
    })
    expect(state.argv.slice(0, 2)).toEqual(['--provider', 'openrouter'])
    started.client.end()
    await expect(started.client.exited).resolves.toEqual({ code: 0, signal: null })
    expect(exits).toHaveLength(1)
  })

  /** The pinned Pi with Mousse's extension built from source, started through the launcher. */
  async function startPi() {
    const { dir, stateDir, base, env } = setup()
    const extension = join(dir, 'mousse-extension.mjs')
    await build({ ...getPiExtensionBuildOptions(repoRoot), outfile: extension, logLevel: 'silent' })
    const runtime: PiRuntimePaths = { root: piPackage, entry: join(piPackage, 'dist/bundle/rpc-entry.js'), extension }
    const launched = piLaunch({
      env, runtime, stateDir, provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', thinking: 'off',
      ambient: { ...base, OPENROUTER_API_KEY: 'fake-openrouter-key' }
    })
    if (launched.runs !== 'yes') throw new Error(launched.reason)
    const exits: PiRpcExit[] = []
    const started = startPiProcess(env, launched, { cwd: dir, handlers: { exit: (exit) => exits.push(exit) } })
    running.push(started)
    return { dir, stateDir, extension, started, exits }
  }

  it('runs the pinned Pi in RPC mode with only Mousse\'s extension, and the tree kill ends it once', async () => {
    const { stateDir, extension, started, exits } = await startPi()
    const state = await started.client.send({ type: 'get_state' }).catch((error) => { throw new Error(`${error.message}\n${started.stderr()}`) })
    expect(state.model).toMatchObject({ provider: 'openrouter', id: 'anthropic/claude-sonnet-4.5' })
    expect(state.sessionFile?.startsWith(join(stateDir, 'sessions'))).toBe(true)
    const { models } = await started.client.send({ type: 'get_available_models' })
    expect(models.length).toBeGreaterThan(0)
    expect(new Set(models.map((model) => model.provider))).toEqual(new Set(['openrouter']))
    // A failed extension load is only a startup warning; the marker command proves it loaded.
    const { commands } = await started.client.send({ type: 'get_commands' })
    // Besides it, Pi 0.85.1 always loads its hidden built-in llama.cpp extension (a `llama` provider
    // and command), even with --no-extensions. Pinned so a new built-in fails here; the RPC engine
    // must guard its provider too. No skill or prompt template loads.
    expect(commands.map((command) => ({ name: command.name, source: command.source, path: command.sourceInfo.path })))
      .toEqual([{ name: 'mousse-extension', source: 'extension', path: extension }, { name: 'llama', source: 'extension', path: '<inline:llama.cpp>' }])

    killTree(started.child)
    const exit = await started.client.exited
    expect(exit.code === 0 && exit.signal === null).toBe(false)
    await expect(started.client.send({ type: 'get_state' })).rejects.toMatchObject({ code: 'exited' })
    expect(exits).toEqual([exit])
    // Killing a tree that is already gone is not an error.
    expect(() => killTree(started.child)).not.toThrow()
  })

  // Pi's shell runs detached, in its own process group on POSIX, so killing Pi's group alone would
  // leave it running. Windows runs it too: taskkill /T follows parent links regardless of groups.
  it('kills the shell Pi started and its child along with Pi', async () => {
    const { dir, started } = await startPi()
    await started.client.send({ type: 'get_state' })
    const pidFile = join(dir, 'grandchild.pid').replace(/\\/g, '/')
    const program = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
    const shell = started.client.send({ type: 'bash', command: `${JSON.stringify(process.execPath.replace(/\\/g, '/'))} -e ${JSON.stringify(program)}` })
    let shellEnded: string | undefined
    void shell.then((result) => { shellEnded = JSON.stringify(result) }, () => {})
    await vi.waitFor(() => {
      // A shell that ends before the grandchild starts is a setup failure: show what it said.
      if (shellEnded) throw new Error(`Pi's shell ended without starting the grandchild: ${shellEnded}`)
      expect(existsSync(pidFile)).toBe(true)
    }, { timeout: 15_000, interval: 50 })
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    fixtures.push(grandchild)
    expect(alive(grandchild)).toBe(true)

    killTree(started.child)
    await started.client.exited
    await expect(shell).rejects.toMatchObject({ code: 'exited' })
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 10_000, interval: 50 })
  })
})
