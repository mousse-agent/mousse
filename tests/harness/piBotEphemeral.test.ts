/**
 * Bot Phase 1 §5.9, gaps 2 and 3 on Pi: a bot turn runs on a process of its own (`--no-session`,
 * its history in the prompt), never kept warm and gone when the turn ends; the process is reported
 * to its supervision as it starts (no supervision, no bot turn); and its environment is the locked
 * one (`lockedEnv`'s allowlist, Pi's own launch variables and the bot marker), whatever the
 * instance's environment holds. The launch itself here, then the real pinned Pi child against a
 * local mock with a fake key.
 *
 * Process lane: real Pi children.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { RunCounters } from '../../src/mms/harness/budget'
import { instanceEnv } from '../../src/mms/harness/env'
import { PI_BOT_MARKER } from '../../src/mms/harness/pi/engine'
import { piLaunch, type PiLaunch } from '../../src/mms/harness/pi/launch'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import { harness, script, setup } from './piRpcEngineFixture'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** What a locked Pi process may hold on POSIX: the allowlist, the network settings, Pi's own launch variables and the marker. */
const ALLOWED = [
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_.*|TERM|TMPDIR)$/,
  /^(HTTP_PROXY|HTTPS_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/i,
  /^PI_(CODING_AGENT_DIR|PACKAGE_DIR|OFFLINE|SKIP_VERSION_CHECK|TELEMETRY)$/,
  /^AWS_(MAX_ATTEMPTS|RETRY_MODE)$/,
  /^ELECTRON_RUN_AS_NODE$/,
  /^MOUSSE_PI_[A-Z_]+$/,
  new RegExp(`^${PI_BOT_MARKER}$`)
]
const allowed = (name: string) => ALLOWED.some((pattern) => pattern.test(name))

/** The user's own variables, which a bot process never gets. */
const PLANTED = { GITHUB_TOKEN: 'ghp-planted', SSH_AUTH_SOCK: '/tmp/agent', USER_SECRET: 'planted-secret', AWS_ACCESS_KEY_ID: 'AKIA-planted' }

function bot(root: string, scratch: string): BotAuthority {
  return createBotAuthority({
    activationId: 'act-7',
    role: 'activation',
    permissions: { tools: ['read'], appTools: [], mcp: [], skills: [], workspace: { roots: [root], access: 'read', scratch } },
    waiting: () => false,
    counters: new RunCounters(),
    time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal },
    spend: null
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the locked launch (piLaunch)', () => {
  it('builds the environment from nothing: the allowlist, the instance’s own key and ids, and the marker', () => {
    const home = '/profile/harness/pi-openrouter/home'
    const env = instanceEnv({ instanceId: 'pi:openrouter', driver: 'pi', configRevision: 0, home, searchPath: [], base: { PATH: '/usr/bin', HOME: '/home/me', LANG: 'C.UTF-8', HTTPS_PROXY: 'http://proxy:3128', ...PLANTED } })
    const runtime = { root: '/rt', entry: '/rt/dist/bundle/rpc-entry.js', extension: '/rt/ext.mjs' }
    const launched = piLaunch({
      env, runtime, stateDir: '/profile/harness/pi-openrouter', provider: 'openrouter', model: 'm', thinking: 'off', ephemeral: true,
      ambient: { OPENROUTER_API_KEY: 'or-own-key', ...PLANTED },
      extraEnv: { OPENROUTER_ACCOUNT: 'acct-1' },
      engineEnv: { MOUSSE_PI_BRIDGE: '{}' },
      host: { execPath: '/node', versions: { node: '24.0.0' } },
      locked: { credential: 'api_key', scratch: '/profile/bots/scratch/act-7', marker: { MOUSSE_BOT_ACTIVATION: 'act-7' }, platform: 'linux' }
    }) as Extract<PiLaunch, { runs: 'yes' }>
    expect(launched.runs).toBe('yes')
    const extra = new Set(['OPENROUTER_API_KEY', 'OPENROUTER_ACCOUNT'])
    expect(Object.keys(launched.env).filter((name) => !allowed(name) && !extra.has(name))).toEqual([])
    for (const name of Object.keys(PLANTED)) expect(launched.env).not.toHaveProperty(name)
    expect(launched.env).toMatchObject({
      PATH: '/usr/bin', HOME: '/home/me', HTTPS_PROXY: 'http://proxy:3128', TMPDIR: '/profile/bots/scratch/act-7/tmp',
      PI_CODING_AGENT_DIR: home, OPENROUTER_API_KEY: 'or-own-key', OPENROUTER_ACCOUNT: 'acct-1', MOUSSE_PI_BRIDGE: '{}', MOUSSE_BOT_ACTIVATION: 'act-7',
      PI_OFFLINE: '1', AWS_MAX_ATTEMPTS: '1'
    })
    expect(launched.args).toContain('--no-session')
  })

  it('an ambient instance gets exactly its provider’s cloud credentials', () => {
    const home = '/profile/harness/pi-bedrock/home'
    const env = instanceEnv({ instanceId: 'pi:amazon-bedrock', driver: 'pi', configRevision: 0, home, searchPath: [], base: { PATH: '/usr/bin', ...PLANTED, AWS_REGION: 'eu-west-1' } })
    const runtime = { root: '/rt', entry: '/rt/e.js', extension: '/rt/x.mjs' }
    const launch = (credential: 'ambient' | 'api_key') => piLaunch({
      env, runtime, stateDir: '/s', provider: 'amazon-bedrock', model: 'm', thinking: 'off', ephemeral: true, ambient: {},
      host: { execPath: '/node', versions: { node: '24.0.0' } }, locked: { credential, scratch: '/scratch', platform: 'linux' }
    }) as Extract<PiLaunch, { runs: 'yes' }>
    expect(launch('ambient').env).toMatchObject({ AWS_ACCESS_KEY_ID: 'AKIA-planted', AWS_REGION: 'eu-west-1' })
    expect(launch('api_key').env).not.toHaveProperty('AWS_ACCESS_KEY_ID')
    expect(launch('ambient').env).not.toHaveProperty('GITHUB_TOKEN')
  })
})

describe.skipIf(process.platform === 'win32')('Pi bot turns (Pi RPC engine, real child)', () => {
  async function bed(options: { onBotProcess?: (pid: number, threadId: string) => void } = {}) {
    const reports: Array<{ pid: number; threadId: string }> = []
    const launches: NodeJS.ProcessEnv[] = []
    const s = await setup(cleanups, {
      baseEnv: PLANTED,
      onBotProcess: options.onBotProcess ?? ((pid, threadId) => void reports.push({ pid, threadId })),
      credentialKind: () => 'api_key',
      adjustLaunch: (launch) => {
        launches.push({ ...launch.env })
        return launch
      }
    })
    const root = realpathSync(s.project)
    const scratch = join(root, '..', 'bot-scratch')
    mkdirSync(scratch, { recursive: true })
    return { ...s, root, scratch, reports, launches }
  }

  it('runs each turn on a new process that is gone when the turn ends, reported to its supervision', async () => {
    const b = await bed()
    b.recorder.respond(script([{ text: 'hello' }]))
    const first = harness(b.root, { cwd: b.scratch }, { bot: bot(b.root, b.scratch) })
    expect((await b.engine.startTurn(first.input, first.sink, first.ctl, first.host)).text).toBe('hello')
    expect(b.spawned).toHaveLength(1)
    expect(b.reports).toEqual([{ pid: b.spawned[0], threadId: 't1' }])
    // Never kept warm: the process is gone as the turn returns.
    expect(alive(b.spawned[0])).toBe(false)

    // The next turn of the same thread: a new process, the conversation so far in its prompt.
    const second = harness(b.root, { cwd: b.scratch, runId: 'r2', attemptId: 'a2', prompt: 'And again', nativeHistory: 'user: Say hello\nassistant: hello' }, { bot: bot(b.root, b.scratch) })
    expect((await b.engine.startTurn(second.input, second.sink, second.ctl, second.host)).text).toBe('hello')
    expect(b.spawned).toHaveLength(2)
    expect(b.spawned[1]).not.toBe(b.spawned[0])
    expect(alive(b.spawned[1])).toBe(false)
    expect(b.recorder.requests.at(-1)?.body).toContain('Previous conversation')
    // No session was written for the thread.
    const sessions = join(b.stateDir, 'sessions')
    expect(existsSync(sessions) ? readdirSync(sessions) : []).toEqual([])
  }, 120_000)

  it('its environment holds only the locked allowlist, Pi’s own variables and the marker', async () => {
    const b = await bed()
    b.recorder.respond(script([{ text: 'hello' }]))
    const turn = harness(b.root, { cwd: b.scratch }, { bot: bot(b.root, b.scratch) })
    await b.engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    expect(b.launches).toHaveLength(1)
    const env = b.launches[0]
    expect(Object.keys(env).filter((name) => !allowed(name))).toEqual([])
    for (const name of Object.keys(PLANTED)) expect(env).not.toHaveProperty(name)
    expect(env[PI_BOT_MARKER]).toBe('act-7')
    expect(env.TMPDIR).toBe(join(b.scratch, 'tmp'))
  }, 120_000)

  it('without supervision no bot turn runs; a report that fails ends the process and the turn', async () => {
    const unsupervised = await setup(cleanups)
    const turn = harness(unsupervised.project, {}, { bot: bot(realpathSync(unsupervised.project), join(unsupervised.scratch, 's')) })
    await expect(unsupervised.engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)).rejects.toMatchObject({ code: 'policy_unenforceable' })
    expect(unsupervised.spawned).toEqual([])

    const b = await bed({ onBotProcess: () => { throw new Error('no supervisor') } })
    b.recorder.respond(script([{ text: 'hello' }]))
    const failing = harness(b.root, { cwd: b.scratch }, { bot: bot(b.root, b.scratch) })
    await expect(b.engine.startTurn(failing.input, failing.sink, failing.ctl, failing.host)).rejects.toThrow(/could not supervise/)
    expect(b.recorder.requests).toEqual([])
  }, 120_000)

  it('an ordinary turn of the same instance still keeps its process warm', async () => {
    const b = await bed()
    b.recorder.respond(script([{ text: 'hello' }]))
    const turn = harness(b.root)
    await b.engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    expect(alive(b.spawned[0])).toBe(true)
    expect(b.reports).toEqual([])
    expect(b.launches[0]).toHaveProperty('USER_SECRET', 'planted-secret')
  }, 120_000)
})
