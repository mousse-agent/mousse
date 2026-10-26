import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

afterEach(() => {
  for (const started of running.splice(0)) if (started.child.exitCode === null) killTree(started.child)
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-pi-process-'))
  scratch.push(dir)
  const stateDir = join(dir, 'state')
  const userHome = join(dir, 'user')
  mkdirSync(join(stateDir, 'home'), { recursive: true })
  mkdirSync(userHome)
  // A clean environment with an empty user home, so nothing of the developer's reaches the child.
  const base: NodeJS.ProcessEnv = {
    ...Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR'].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
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

  it('runs the pinned Pi in RPC mode: get_state and get_available_models round-trip, and the tree kill ends it once', async () => {
    const { dir, stateDir, base, env } = setup()
    const extension = join(dir, 'mousse-extension.mjs')
    writeFileSync(extension, 'export default function () {}\n')
    const runtime: PiRuntimePaths = { root: piPackage, entry: join(piPackage, 'dist/bundle/rpc-entry.js'), extension }
    const launched = piLaunch({
      env, runtime, stateDir, provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', thinking: 'off',
      ambient: { ...base, OPENROUTER_API_KEY: 'fake-openrouter-key' }
    })
    if (launched.runs !== 'yes') throw new Error(launched.reason)
    const exits: PiRpcExit[] = []
    const started = startPiProcess(env, launched, { cwd: dir, handlers: { exit: (exit) => exits.push(exit) } })
    running.push(started)

    const state = await started.client.send({ type: 'get_state' }).catch((error) => { throw new Error(`${error.message}\n${started.stderr()}`) })
    expect(state.model).toMatchObject({ provider: 'openrouter', id: 'anthropic/claude-sonnet-4.5' })
    expect(state.sessionFile?.startsWith(join(stateDir, 'sessions'))).toBe(true)
    const { models } = await started.client.send({ type: 'get_available_models' })
    expect(models.length).toBeGreaterThan(0)
    expect(new Set(models.map((model) => model.provider))).toEqual(new Set(['openrouter']))

    killTree(started.child)
    const exit = await started.client.exited
    expect(exit.code === 0 && exit.signal === null).toBe(false)
    await expect(started.client.send({ type: 'get_state' })).rejects.toMatchObject({ code: 'exited' })
    expect(exits).toEqual([exit])
  })
})
