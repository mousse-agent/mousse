import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { AntigravityProviderService } from '../src/mms/providers/antigravity/AntigravityProviderService'
import { ClaudeSubscriptionProviderService } from '../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import type { CodexLaunch, CodexProcess } from '../src/mms/providers/codex/CodexAppServerClient'
import { CodexProviderService } from '../src/mms/providers/codex/CodexProviderService'
import {
  claudeExtraArgs,
  CliVersionCache,
  parseCliConfigPatch,
  parseCliVersion,
  requireExecutable,
  withUserEnv,
  type StoredCliConfig
} from '../src/mms/providers/cliConfig'
import { directLaunch } from '../src/mms/providers/resolveWindowsShim'

const homes: string[] = []
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'mousse-cli-config-'))
  homes.push(home)
  return home
}
function executable(path: string): string {
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
  return path
}
const versions = (output = 'tool 1.2.3 (CLI)') => {
  const run = vi.fn(async () => output)
  return { cache: new CliVersionCache(run), run }
}

describe('CLI provider config validation', () => {
  it('validates the path, args and env of a patch', () => {
    expect(parseCliConfigPatch(undefined)).toEqual({})
    expect(parseCliConfigPatch({ binaryPath: null })).toEqual({ binaryPath: null })
    expect(parseCliConfigPatch({ binaryPath: '  ' })).toEqual({ binaryPath: null })
    expect(parseCliConfigPatch({ binaryPath: ' /bin/claude ' })).toEqual({ binaryPath: '/bin/claude' })
    expect(parseCliConfigPatch({ args: ['--a', 'b'], env: { _X1: 'v', A: '' } })).toEqual({
      args: ['--a', 'b'],
      env: { _X1: 'v', A: '' }
    })
    expect(() => parseCliConfigPatch({ binaryPath: 3 })).toThrow(/binaryPath must be a string/)
    expect(() => parseCliConfigPatch({ args: '--a' })).toThrow(/args must be an array/)
    expect(() => parseCliConfigPatch({ args: ['--a', 1] })).toThrow(/args\[1\] must be a string/)
    expect(() => parseCliConfigPatch({ args: ['a\0b'] })).toThrow(/NUL/)
    expect(() => parseCliConfigPatch({ env: ['A'] })).toThrow(/env must be an object/)
    expect(() => parseCliConfigPatch({ env: { '1A': 'v' } })).toThrow(/env name "1A"/)
    expect(() => parseCliConfigPatch({ env: { 'A-B': 'v' } })).toThrow(/env name/)
    expect(() => parseCliConfigPatch({ env: { A: 1 } })).toThrow(/env A must be a string/)
    expect(() => parseCliConfigPatch([])).toThrow(/patch must be an object/)
  })

  it('refuses .cmd and .bat scripts on Windows unless they resolve to the program they run', () => {
    const home = tempHome()
    for (const name of ['codex.cmd', 'claude.BAT']) {
      const script = executable(join(home, name))
      expect(() => requireExecutable(script, 'Codex', 'win32')).toThrow(/\.cmd or \.bat script/)
      expect(requireExecutable(script, 'Codex', 'linux')).toBe(script)
    }
    expect(() => requireExecutable('relative/codex.cmd', 'Codex', 'win32')).toThrow(/absolute/)

    // An npm shim whose target exists is kept as chosen; launches resolve it.
    mkdirSync(join(home, 'node_modules', 'tool', 'bin'), { recursive: true })
    writeFileSync(join(home, 'node_modules', 'tool', 'bin', 'tool.exe'), 'MZ')
    const shim = join(home, 'tool.cmd')
    writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*\r\n')
    // The existence check is the host's; on Linux and macOS it also needs the execute bit.
    chmodSync(shim, 0o755)
    expect(requireExecutable(shim, 'Codex', 'win32')).toBe(shim)
  })

  it('maps Claude launch args to SDK extraArgs and rejects what the SDK cannot pass', () => {
    expect(claudeExtraArgs(['--verbose', '--add-dir', '/x', '--model=opus', '--debug'])).toEqual({
      verbose: null,
      'add-dir': '/x',
      model: 'opus',
      debug: null
    })
    expect(() => claudeExtraArgs(['-v'])).toThrow(/not supported/)
    expect(() => claudeExtraArgs(['positional'])).toThrow(/not supported/)
    expect(() => claudeExtraArgs(['--a', '--a'])).toThrow(/repeated/)
  })

  it('applies user env over the base env, case-insensitively on Windows', () => {
    expect(withUserEnv({ A: '1', B: '2' }, { B: 'x', C: 'y' }, 'linux')).toEqual({ A: '1', B: 'x', C: 'y' })
    expect(withUserEnv({ Path: 'C:\\old', B: '2' }, { PATH: 'C:\\new' }, 'win32')).toEqual({ B: '2', PATH: 'C:\\new' })
    expect(withUserEnv({ Path: 'p' }, { PATH: 'q' }, 'linux')).toEqual({ Path: 'p', PATH: 'q' })
  })

  it('parses and caches `--version` per executable, and reports failures as unknown', async () => {
    expect(parseCliVersion('2.1.4 (Claude Code)')).toBe('2.1.4')
    expect(parseCliVersion('codex-cli 0.47.0-alpha.2')).toBe('0.47.0-alpha.2')
    expect(parseCliVersion('no version')).toBeUndefined()
    const binary = directLaunch(executable(join(tempHome(), 'tool')))
    const { cache, run } = versions()
    expect(await cache.version(binary, {})).toBe('1.2.3')
    expect(await cache.version(binary, {})).toBe('1.2.3')
    expect(run).toHaveBeenCalledOnce()
    expect(await cache.version(undefined, {})).toBeUndefined()
    // A node-run entry script is a different launch of the same file.
    expect(await cache.version({ path: binary.path, command: 'node', args: [binary.path] }, {})).toBe('1.2.3')
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenLastCalledWith({ path: binary.path, command: 'node', args: [binary.path] }, {})
    const failing = new CliVersionCache(async () => {
      throw new Error('timed out')
    })
    expect(await failing.version(binary, {})).toBeUndefined()
  })
})

describe('Claude Subscription CLI config', () => {
  // Launch settings live in the instance config (the gateway's); the service reads them from there.
  function fixture() {
    const home = tempHome()
    const binary = executable(join(home, 'claude'))
    const other = executable(join(home, 'claude-next'))
    const directory = join(home, 'providers', 'claude-subscription')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ loginPolicy: 'cli', models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const captured: Options[] = []
    const query = (input: { options: Options }) => {
      captured.push(input.options)
      return Object.assign((async function* () {})(), {
        close: vi.fn(),
        supportedModels: vi.fn(async () => [{ value: 'sonnet', displayName: 'Sonnet', description: '' }])
      }) as unknown as Query
    }
    const questions = new UserQuestionService()
    cleanups.push(() => questions.shutdown())
    const { cache } = versions('2.1.4 (Claude Code)')
    const runAuth = vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    let launch: StoredCliConfig = { binaryPath: binary }
    const service = new ClaudeSubscriptionProviderService(home, questions, { query, runAuth, versions: cache, launchConfig: () => launch })
    cleanups.push(() => service.stop())
    return {
      home,
      binary,
      other,
      service,
      captured,
      setLaunch: (next: StoredCliConfig) => {
        launch = next
      },
      settings: () => JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'))
    }
  }

  it("reports and applies the instance config's executable, args and env to new SDK launches", async () => {
    const { home, binary, other, service, captured, setLaunch, settings } = fixture()
    expect(await service.cliConfig()).toEqual({
      instanceId: 'claude',
      binaryPath: binary,
      resolvedBinaryPath: binary,
      version: '2.1.4',
      args: [],
      env: {}
    })
    setLaunch({ binaryPath: other, args: ['--add-dir', '/extra', '--verbose'], env: { HTTPS_PROXY: 'http://proxy', CLAUDE_CONFIG_DIR: '/user/override' } })
    expect(await service.cliConfig()).toMatchObject({ binaryPath: other, resolvedBinaryPath: other, args: ['--add-dir', '/extra', '--verbose'] })

    await service.refreshModels(home)
    const options = captured.at(-1)!
    expect(options.pathToClaudeCodeExecutable).toBe(other)
    expect(options.extraArgs).toEqual({ 'add-dir': '/extra', verbose: null })
    // User variables apply after Mousse's own environment, so they win.
    expect(options.env?.HTTPS_PROXY).toBe('http://proxy')
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe('/user/override')
    // settings.json holds none of it: only the gateway's mirror writes launch keys there.
    expect(settings().binaryPath).toBeUndefined()
    expect(settings().args).toBeUndefined()
  })

  it('validates an executable and args before the gateway saves them', () => {
    const { home, other, service } = fixture()
    expect(() => service.validateLaunch({ binaryPath: 'relative/claude' })).toThrow(/absolute/)
    expect(() => service.validateLaunch({ binaryPath: join(home, 'missing') })).toThrow(/not found/)
    expect(() => service.validateLaunch({ args: ['-v'], env: { A: '1' } })).toThrow(/not supported/)
    expect(() => service.validateLaunch({ binaryPath: other, args: ['--verbose'] })).not.toThrow()
    expect(() => service.validateLaunch({ binaryPath: null })).not.toThrow()
  })
})

describe('Codex CLI config', () => {
  function server() {
    const launches: CodexLaunch[] = []
    const processes: Array<EventEmitter & { signalCode: NodeJS.Signals | null }> = []
    const launch = (spec: CodexLaunch): CodexProcess => {
      launches.push(spec)
      const stdout = new PassThrough()
      const stdin = new PassThrough()
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr: new PassThrough(),
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill(signal: NodeJS.Signals = 'SIGTERM') {
          if (child.signalCode) return false
          child.signalCode = signal
          setImmediate(() => child.emit('exit', null, signal))
          return true
        }
      })
      let pending = ''
      stdin.on('data', (chunk: Buffer) => {
        pending += chunk.toString()
        let end: number
        while ((end = pending.indexOf('\n')) !== -1) {
          const message = JSON.parse(pending.slice(0, end)) as { id?: number; method?: string }
          pending = pending.slice(end + 1)
          if (message.id === undefined) continue
          const result =
            message.method === 'initialize'
              ? { userAgent: 'test', codexHome: '/h', platformFamily: 'unix', platformOs: 'linux' }
              : { account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' }, requiresOpenaiAuth: true }
          stdout.write(JSON.stringify({ id: message.id, result }) + '\n')
        }
      })
      processes.push(child)
      return child as unknown as CodexProcess
    }
    return { launch, launches, processes }
  }

  it('appends args after app-server, merges env, and replaces the idle process on change', async () => {
    const home = tempHome()
    const binary = executable(join(home, 'codex'))
    mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
    writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ models: [{ id: 'gpt-x', label: 'GPT X' }] }))
    const questions = new UserQuestionService()
    cleanups.push(() => questions.shutdown())
    const fake = server()
    const { cache } = versions('codex-cli 0.47.0')
    let launch: StoredCliConfig = { binaryPath: binary }
    const service = new CodexProviderService(home, questions, { launch: fake.launch, versions: cache }, { launch: () => launch })
    cleanups.push(() => service.stop())

    expect(await service.status()).toMatchObject({ state: 'connected' })
    expect(fake.launches[0].args).toEqual([])

    // The gateway saved new launch settings to the instance config and tells the service.
    launch = { binaryPath: binary, args: ['-c', 'model="o3"'], env: { OPENAI_API_KEY: 'user-chosen', FOO: 'bar' } }
    service.launchChanged()
    const config = await service.cliConfig()
    expect(config).toEqual({
      instanceId: 'codex',
      binaryPath: binary,
      resolvedBinaryPath: binary,
      version: '0.47.0',
      args: ['-c', 'model="o3"'],
      env: { OPENAI_API_KEY: 'user-chosen', FOO: 'bar' }
    })
    // The process started with the old settings was idle, so it closed at once.
    expect(fake.processes[0].signalCode).toBe('SIGTERM')
    expect(await service.status({ force: true })).toMatchObject({ state: 'connected' })
    expect(fake.launches).toHaveLength(2)
    expect(fake.launches[1].args).toEqual(['-c', 'model="o3"'])
    expect(fake.launches[1].env.FOO).toBe('bar')
    expect(fake.launches[1].env.OPENAI_API_KEY).toBe('user-chosen')

    expect(() => service.validateLaunch({ binaryPath: join(home, 'nope') })).toThrow(/not found/)
    expect((await service.cliConfig()).binaryPath).toBe(binary)
  })

  it.runIf(process.platform === 'win32')('keeps a chosen npm codex.cmd and launches the program it runs', async () => {
    const home = tempHome()
    const npm = join(home, 'npm')
    const pkg = join(npm, 'node_modules', '@openai', 'codex')
    mkdirSync(join(pkg, 'bin'), { recursive: true })
    writeFileSync(join(pkg, 'bin', 'codex.js'), '')
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
    const script = join(pkg, 'bin', 'codex.js')
    const node = executable(join(npm, 'node.exe'))
    const shim = join(npm, 'codex.cmd')
    writeFileSync(shim, '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n')
    const questions = new UserQuestionService()
    cleanups.push(() => questions.shutdown())
    const fake = server()
    const { cache, run } = versions('codex-cli 0.47.0')
    let launch: StoredCliConfig = {}
    const service = new CodexProviderService(home, questions, { launch: fake.launch, versions: cache, findBinary: () => undefined }, { launch: () => launch })
    cleanups.push(() => service.stop())

    // No native codex.exe in the package: node runs the entry script.
    service.validateLaunch({ binaryPath: shim })
    launch = { binaryPath: shim, args: ['-c', 'x=1'] }
    expect(await service.status({ force: true })).toMatchObject({ state: 'connected' })
    expect(await service.cliConfig()).toMatchObject({
      binaryPath: shim,
      resolvedBinaryPath: script,
      version: '0.47.0'
    })
    expect(run).toHaveBeenCalledWith({ path: script, command: node, args: [script] }, expect.anything())
    expect(fake.launches.at(-1)).toMatchObject({ binary: node, entryArgs: [script], args: ['-c', 'x=1'] })

    const exe = join(pkg, 'vendor', process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
    mkdirSync(dirname(exe), { recursive: true })
    writeFileSync(exe, 'MZ')
    expect((await service.cliConfig()).resolvedBinaryPath).toBe(exe)
  })
})

describe('Antigravity CLI config', () => {
  it('reads args and env from the instance config, validates the agent binary, and uses the pinned version only for the pinned install', async () => {
    const home = tempHome()
    const agentName = process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par'
    const helperName = process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external'
    const manual = join(home, 'manual')
    mkdirSync(manual)
    const agent = executable(join(manual, agentName))
    executable(join(manual, helperName))
    const lonely = join(home, 'lonely')
    mkdirSync(lonely)
    executable(join(lonely, agentName))
    const questions = new UserQuestionService()
    cleanups.push(() => questions.shutdown())
    const { cache } = versions('agy 1.1.2')
    let launch: StoredCliConfig = {}
    const service = new AntigravityProviderService(home, home, questions, cache, { launch: () => launch })
    cleanups.push(() => service.stop())

    expect(await service.cliConfig()).toEqual({ instanceId: 'antigravity', args: [], env: {}, signedIn: false })
    expect(() => service.validateLaunch({ binaryPath: join(lonely, agentName) })).toThrow(/beside/)
    service.validateLaunch({ binaryPath: agent })
    launch = { binaryPath: agent, args: ['--flag'], env: { GEMINI_HOME: '/mine' } }
    const config = await service.cliConfig()
    expect(config).toEqual({
      instanceId: 'antigravity',
      binaryPath: agent,
      resolvedBinaryPath: agent,
      version: '1.1.2',
      args: ['--flag'],
      env: { GEMINI_HOME: '/mine' },
      signedIn: false
    })
  })
})
