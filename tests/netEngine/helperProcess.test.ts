/**
 * The real helper as the daemon runs it (design §1): `init` for a new endpoint, `serve --app` on its stdio, hello
 * with the profile, `shutdown`, its exit when stdin closes, and its exit when the daemon is killed outright. Runs
 * the helper `MOUSSE_NET_HELPER` names, else the one `scripts/build-net-helper.mjs` built; skipped without one.
 * The key goes to a file and the helper listens on loopback.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AppChannel, helperCode } from '../../src/mms/netEngine/helper/appChannel'
import { EngineHelper } from '../../src/mms/netEngine/helper/connections'
import {
  findNetHelper,
  helperArgs,
  helperProfileId,
  INIT_STDIO,
  initArgs,
  initEndpoint,
  launchHelper,
  readInsecureFileKey
} from '../../src/mms/netEngine/helper/process'

const binary = findNetHelper()
const PROFILE = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'

process.env.MOUSSE_NET_ENGINE_HELPER_LISTEN_IP = '127.0.0.1'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the identity key file', () => {
  it('is for development runs only: an installed app keeps its key in the keystore and says so', () => {
    const env = { MOUSSE_NET_ENGINE_INSECURE_FILE_KEY: '1' }
    expect(readInsecureFileKey(env, false)).toEqual({ on: true, problems: [] })
    const installed = readInsecureFileKey(env, true)
    expect(installed.on).toBe(false)
    expect(installed.problems).toEqual([
      'MOUSSE_NET_ENGINE_INSECURE_FILE_KEY is ignored by an installed app'
    ])
    expect(readInsecureFileKey({ MOUSSE_NET_ENGINE_INSECURE_FILE_KEY: 'yes' }, false).on).toBe(
      false
    )
  })
})

describe.skipIf(!binary)('the helper process', () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'helper-process-')))
  const state = join(folder, 'endpoint')
  afterAll(() => rmSync(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))

  const hello = (launched: ReturnType<typeof launchHelper>, profile: string) => {
    const helper = new EngineHelper(new AppChannel(launched.pipe), {
      peers: { byIdentity: () => undefined },
      attach: async () => undefined,
      name: () => 'Check desk',
      profile: () => profile
    })
    return { helper, said: helper.hello() }
  }

  it('makes an endpoint, says hello for its profile, and exits on shutdown', async () => {
    await initEndpoint(binary!, state, helperProfileId(PROFILE), true)
    const launched = launchHelper(binary!, state, true)
    const { helper, said } = hello(launched, helperProfileId(PROFILE))
    const answer = await said
    expect(answer.proto).toEqual([1, 0])
    expect(answer.identity).toMatch(/^[0-9a-f]{64,}$/)
    expect(answer.paused ?? null).toBeNull()
    const asked = Date.now()
    await helper.request('shutdown')
    const exit = await launched.exited
    expect(exit.code).toBe(0)
    expect(Date.now() - asked).toBeLessThan(1_000)
  }, 60_000)

  it('refuses hello for another profile', async () => {
    const launched = launchHelper(binary!, state, true)
    const refused = await hello(launched, helperProfileId('another')).said.catch((error) => error)
    expect(helperCode(refused)).toBe('wrong_profile')
    launched.pipe.close()
    await launched.exited
  }, 60_000)

  it('exits within a second of its stdin closing', async () => {
    const launched = launchHelper(binary!, state, true)
    await hello(launched, helperProfileId(PROFILE)).said
    const closed = Date.now()
    launched.pipe.close()
    await launched.exited
    expect(Date.now() - closed).toBeLessThan(1_000)
  }, 60_000)

  const killParent = async (args: string[], env: NodeJS.ProcessEnv = process.env) => {
    const parent = spawn(
      process.execPath,
      [join(__dirname, 'fixtures', 'helperParent.mjs'), binary!, ...args],
      { stdio: ['ignore', 'pipe', 'inherit'], env }
    )
    const pid = await new Promise<number>((resolve, reject) => {
      parent.stdout.setEncoding('utf8')
      parent.stdout.on('data', (text: string) => {
        const found = /helper (\d+)/.exec(text)
        if (found) resolve(Number(found[1]))
      })
      parent.on('exit', () => reject(new Error('the parent exited first')))
    })
    expect(alive(pid)).toBe(true)
    parent.kill('SIGKILL')
    const killed = Date.now()
    while (alive(pid) && Date.now() - killed < 5_000)
      await new Promise((resolve) => setTimeout(resolve, 25))
    const outlived = alive(pid)
    if (outlived) process.kill(pid)
    expect(outlived).toBe(false)
    expect(Date.now() - killed).toBeLessThan(1_000)
  }

  it('exits within a second of the process that started it being killed outright', async () => {
    await killParent([
      JSON.stringify(helperArgs(state, ['serve', '--app', '--listen-ip', '127.0.0.1'], true))
    ])
  }, 60_000)

  // The hold keeps `init` busy, as a slow keystore does, so the parent dies during it.
  it('exits within a second of the daemon being killed during a first start (init)', async () => {
    const fresh = join(folder, 'first-start')
    await killParent(
      [JSON.stringify(initArgs(fresh, helperProfileId(PROFILE), true)), JSON.stringify(INIT_STDIO)],
      { ...process.env, MOUSSE_NET_INIT_HOLD_MS: '30000' }
    )
  }, 60_000)
})
