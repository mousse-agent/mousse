/**
 * Antigravity's limits on the usage page: `agy -p /usage --output-format json`, run on the same `agy`
 * and folders as Mousse's turns, read into one window per pool and length. The guards: an `agy` too
 * old to run `/usage` as a command is never asked, and a reply that reports a turn stops all reading.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AntigravityProviderService } from '../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { AgyUsageTurnError, agyUsageRefusal, parseAgyUsage, runAgy, type AgyRunner } from '../src/mms/harness/acp/presets/antigravity/usage'
import { antigravityDriver } from '../src/mms/harness/drivers/antigravity'
import { CliVersionCache } from '../src/mms/harness/cliConfig'
import type { DriverContext } from '../src/mms/harness/driver'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'

const homes: string[] = []
const services: AntigravityProviderService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
const newHome = () => { const home = mkdtempSync(join(tmpdir(), 'mousse-agy-usage-')); homes.push(home); return home }

/** The reply of `agy -p /usage --output-format json`, recorded from agy 1.5.13 on Windows on 19 November 2026 (descriptions shortened). */
const RECORDED = JSON.stringify({
  conversation_id: '', status: 'SUCCESS', response: 'Gemini Models\tWeekly Limit Remaining\t96%\t2026-11-26T11:28:57Z\n…', duration_seconds: 0, num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      description: 'Within each group, models share a weekly limit and a 5-hour limit.',
      groups: [
        { name: 'Gemini Models', description: 'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen', buckets: [
          { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9632792472839355, reset_time: '2026-11-26T11:28:57Z' },
          { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.871477484703064, reset_time: '2026-11-19T16:28:57Z' }
        ] },
        { name: 'Claude and GPT models', buckets: [
          { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-26T13:32:07Z' },
          { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '2026-11-19T18:32:07Z' }
        ] },
        { name: 'Gemini 4 Argon', buckets: [
          { id: 'gemini-argon-wtu-weekly', name: 'Gemini 4 Argon Weekly Limit', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-26T13:32:07Z' }
        ] }
      ]
    }
  }
})
/** What an `agy` that takes `/usage` as a prompt prints: a model turn (recorded through a shell that rewrote the prompt). */
const TURN = JSON.stringify({ conversation_id: '8bdea24c', status: 'SUCCESS', response: 'It looks like Git Bash expanded `/usage`…', duration_seconds: 8.27, num_turns: 1, usage: { input_tokens: 12587, output_tokens: 485 } })

describe('reading the reply', () => {
  it('shows each pool\'s five-hour and weekly windows, with what is left and when each resets', () => {
    expect(parseAgyUsage(RECORDED)).toEqual({
      status: 'available',
      windows: [
        { id: 'gemini-models:weekly', label: 'Gemini Models · Weekly limit', remainingPercent: 96.3, resetsAt: '2026-11-26T11:28:57.000Z' },
        { id: 'gemini-models:5h', label: 'Gemini Models · 5-hour limit', remainingPercent: 87.1, resetsAt: '2026-11-19T16:28:57.000Z' },
        { id: 'claude-and-gpt-models:weekly', label: 'Claude and GPT models · Weekly limit', remainingPercent: 100, resetsAt: '2026-11-26T13:32:07.000Z' },
        { id: 'claude-and-gpt-models:5h', label: 'Claude and GPT models · 5-hour limit', remainingPercent: 100, resetsAt: '2026-11-19T18:32:07.000Z' },
        { id: 'gemini-4-argon:weekly', label: 'Gemini 4 Argon · Weekly limit', remainingPercent: 100, resetsAt: '2026-11-26T13:32:07.000Z' }
      ]
    })
  })

  it.each([
    ['a reply that ran a turn', TURN],
    ['a reply that does not say how many turns ran', JSON.stringify({ ...JSON.parse(RECORDED), num_turns: undefined })]
  ])('stops at %s', (_case, reply) => {
    expect(() => parseAgyUsage(reply)).toThrow(AgyUsageTurnError)
  })

  it.each([
    ['not JSON', 'Usage of agy.exe:'],
    ['another command', JSON.stringify({ ...JSON.parse(RECORDED), command: { name: 'models', data: { groups: [] } } })],
    ['no command', JSON.stringify({ ...JSON.parse(RECORDED), command: undefined })]
  ])('refuses %s', (_case, reply) => {
    expect(() => parseAgyUsage(reply)).toThrow('Antigravity did not answer with its limits.')
  })

  it('says so when the account has no limits', () => {
    expect(parseAgyUsage(JSON.stringify({ ...JSON.parse(RECORDED), command: { name: 'usage', data: { groups: [] } } }))).toMatchObject({ status: 'unavailable', windows: [] })
  })

})

describe('which agy versions are asked', () => {
  it.each([
    ['1.1.10', /cannot report its limits/],
    ['1.0.4', /cannot report its limits/],
    [undefined, /could not read the Antigravity version/],
    ['1.1.11', undefined],
    ['1.5.13', undefined]
  ])('%s', (version, refusal) => {
    const reason = agyUsageRefusal(version)
    if (refusal) expect(reason).toMatch(refusal)
    else expect(reason).toBeUndefined()
  })
})

describe('the read Mousse runs', () => {
  function setup(options: { version?: string; legacy?: boolean; reply?: string } = {}) {
    const home = newHome()
    const own = join(home, 'own')
    mkdirSync(own, { recursive: true })
    const agy = join(own, 'agy.exe')
    writeFileSync(agy, 'agy')
    const legacyAgent = join(own, process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par')
    writeFileSync(legacyAgent, 'legacy')
    writeFileSync(join(own, process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external'), 'helper')
    let reply = options.reply ?? RECORDED
    const run = vi.fn<AgyRunner>(async () => reply)
    const service = new AntigravityProviderService(home, home, new UserQuestionService(), new CliVersionCache(async () => options.version ?? '1.5.13'), {
      ...(options.legacy ? { launch: () => ({ binaryPath: legacyAgent }) } : {}),
      findUserAgy: () => agy,
      runAgy: run
    })
    services.push(service)
    const runtime = antigravityDriver({ builtIn: () => service }).create({ findBinary: () => agy } as unknown as DriverContext)
    return { home, agy, service, runtime, run, setReply: (next: string) => { reply = next } }
  }
  const signal = () => new AbortController().signal

  it('runs the same agy, on the same folders as Mousse\'s turns, as `-p /usage` without a shell', async () => {
    const { home, agy, runtime, run } = setup()
    expect(await runtime.usage!(signal())).toMatchObject({ status: 'available', windows: expect.arrayContaining([expect.objectContaining({ id: 'gemini-models:5h' })]) })
    const [binary, args, options] = run.mock.calls[0]!
    const geminiHome = join(home, 'providers', 'antigravity', 'gemini-home')
    expect(binary).toBe(agy)
    expect(args).toEqual(['--gemini_dir', geminiHome, '--app_data_dir', 'antigravity-acp', '-p', '/usage', '--output-format', 'json'])
    expect(options.env.GEMINI_HOME).toBe(geminiHome)
    // The first entry reads this computer's agy sign-in.
    expect(options.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBeUndefined()
  })

  it('reads an added entry\'s limits from its own home, with the sign-in kept there', async () => {
    const home = newHome()
    const agy = join(home, 'agy.exe')
    writeFileSync(agy, 'agy')
    const stateDir = join(home, 'harness', 'antigravity_antigravity-2')
    const run = vi.fn<AgyRunner>(async () => RECORDED)
    const service = new AntigravityProviderService(home, home, new UserQuestionService(), new CliVersionCache(async () => '1.5.17'), {
      entry: { instanceId: 'antigravity:antigravity-2', stateDir, home: join(stateDir, 'home') },
      findUserAgy: () => agy,
      runAgy: run
    })
    services.push(service)
    await service.usage(signal())
    const [, args, options] = run.mock.calls[0]!
    expect(args.slice(0, 2)).toEqual(['--gemini_dir', join(stateDir, 'home', 'gemini-home')])
    expect(options.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe('1')
  })

  it('is read only when asked, never by the background limit reads', () => {
    expect(setup().runtime.usageOnRequest).toBe(true)
  })

  it('never asks an agy older than 1.1.11, where /usage would run a turn', async () => {
    const { runtime, run } = setup({ version: '1.1.10' })
    await expect(runtime.usage!(signal())).rejects.toThrow(/cannot report its limits/)
    expect(run).not.toHaveBeenCalled()
  })

  it('stops reading for good once a reply reports a turn, until another agy version runs', async () => {
    const { home, runtime, run, setReply } = setup({ reply: TURN })
    await expect(runtime.usage!(signal())).rejects.toThrow(AgyUsageTurnError)
    setReply(RECORDED)
    await expect(runtime.usage!(signal())).rejects.toThrow(AgyUsageTurnError)
    expect(run).toHaveBeenCalledTimes(1)
    // Kept across a restart.
    const saved = JSON.parse(readFileSync(join(home, 'providers', 'antigravity', 'settings.json'), 'utf8')) as { usageStopped?: { version: string } }
    expect(saved.usageStopped?.version).toBe('1.5.13')
  })

  it('shares one run between reads that arrive together', async () => {
    const { runtime, run } = setup()
    await Promise.all([runtime.usage!(signal()), runtime.usage!(signal())])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reports no limits for the 1.1.1 server, without running anything', async () => {
    const { runtime, run } = setup({ legacy: true })
    expect(await runtime.usage!(signal())).toMatchObject({ status: 'unavailable' })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the process', () => {
  it('ends the read and its process when the deadline aborts it', async () => {
    const dir = newHome()
    const pidFile = join(dir, 'pid')
    const script = join(dir, 'slow.cjs')
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const abort = new AbortController()
    const reading = runAgy(process.execPath, [script], { env: process.env, cwd: dir, signal: abort.signal })
    const failed = expect(reading).rejects.toThrow()
    await vi.waitFor(() => expect(() => readFileSync(pidFile, 'utf8')).not.toThrow(), { timeout: 10_000 })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    abort.abort(new Error('The usage did not arrive in time.'))
    await failed
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 })
  })

  it('passes /usage to the program as it is', async () => {
    const dir = newHome()
    const script = join(dir, 'echo.cjs')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    expect(JSON.parse(await runAgy(process.execPath, [script, '-p', '/usage'], { env: process.env, cwd: dir, signal: new AbortController().signal }))).toEqual(['-p', '/usage'])
  })
})
