import { join } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { newId } from '../../../../src/shared/net'

import { productBuild } from '../../../support/build'
import { runCli, startDaemon, type Daemon } from '../../../support/daemon'
import { ownedTemp } from '../../../support/tmp'

let entry: string

beforeAll(async () => {
  entry = (await productBuild()).entry
}, 120000)
it.skipIf(process.platform === 'win32')(
  'uses the emitted CLI and actual daemon owner profile to register and control a signed inactive bot',
  async () => {
    const temp = ownedTemp('bots-daemon-cli-'),
      root = temp.path,
      home = join(root, 'home'),
      daemons: Daemon[] = []
    let seed: MousseMainService | undefined
    const cli = async (
      args: string[],
      input?: string
    ): Promise<{ code: number | null; output: string; error: string; value?: any }> => {
      const result = await runCli({
        entry,
        home,
        args: ['--json', ...args],
        input,
        env: { MOUSSE_REPO_ROOT: root },
        label: 'Actual bot CLI'
      })
      let value
      try {
        value = JSON.parse(result.code === 0 ? result.stdout : result.stderr)
      } catch {}
      return { code: result.code, output: result.stdout, error: result.stderr, value }
    }
    try {
      seed = await MousseMainService.create({
        homeDir: home,
        repoRoot: root,
        headless: true,
        requireOwnership: false
      })
      await seed.net.request('net.init', { listen: true, port: 0 })
      await seed.net.request('net.protect', { passphrase: 'task-owned-cli-protection' })
      const rt = seed.net.runtime(),
        self = rt.identity.self()!,
        space = seed.spaces.host.create({ name: 'Emitted local bot CLI' }),
        channel = seed.spaces.host.createChannel(space.space, 'general'),
        digest = Buffer.alloc(32, 2).toString('base64url'),
        request = newId('rpc')
      await seed.stop()
      seed = undefined
      const daemon = await startDaemon({
        entry,
        home,
        repoRoot: root,
        readiness: 'runtime',
        label: 'Task-owned daemon'
      })
      daemons.push(daemon)
      expect((await cli(['bots', '--help'])).output).toContain(
        'default production native adapter is inactive'
      )
      const locked = await cli(['bots', 'add', space.space, 'Owner fixture', '--id', request])
      expect(locked.value).toMatchObject({ code: 'keystore_locked' })
      expect((await cli(['net', 'unlock'], 'task-owned-cli-protection')).code).toBe(0)
      const added = await cli([
        'bots',
        'add',
        space.space,
        'Owner fixture',
        '--id',
        request,
        '--steer',
        'everyone'
      ])
      expect(added.code, added.error).toBe(0)
      expect(added.value).toMatchObject({
        id: request,
        state: 'registered',
        delivery: { state: 'sent', attempts: 1 }
      })
      const bot = added.value.bot
      expect(
        (
          await cli([
            'bots',
            'add',
            space.space,
            'Owner fixture',
            '--id',
            request,
            '--steer',
            'everyone'
          ])
        ).value
      ).toEqual(added.value)
      expect(
        (await cli(['bots', 'add', space.space, 'Changed', '--id', request, '--steer', 'everyone']))
          .value
      ).toMatchObject({ code: 'conflict' })
      const configured = await cli([
        'bots',
        'configure',
        space.space,
        bot,
        '--adapter',
        'mousse',
        '--profile-kind',
        'chat',
        '--definition-revision',
        'unqualified',
        '--profile-digest',
        digest,
        '--daily-budget',
        '1000',
        '--run-ceiling',
        '60',
        '--max-concurrent',
        '2',
        '--runs-per-member-hour',
        '20'
      ])
      expect(configured.code, configured.error).toBe(0)
      expect(configured.value).toMatchObject({ bot, owner: self.user, qualified: false })
      const qualification = await cli([
        'bots',
        'qualify',
        space.space,
        bot,
        '--definition-revision',
        'unqualified',
        '--profile-digest',
        digest
      ])
      expect(qualification.code).not.toBe(0)
      expect(qualification.value).toMatchObject({ code: 'profile_unsupported' })
      expect((await cli(['bots', 'stop', space.space, bot])).value).toMatchObject({
        stopped: true,
        qualified: false
      })
      expect((await cli(['bots', 'resume', space.space, bot])).value).toMatchObject({
        stopped: false,
        qualified: false
      })
      expect((await cli(['bots', 'presence', space.space, bot, channel])).value).toMatchObject({
        state: 'offline'
      })
      expect([daemon.output, configured.output, qualification.error].join('\n')).not.toContain(
        'task-owned-cli-protection'
      )
    } finally {
      if (seed) await seed.stop()
      await Promise.all(daemons.map((daemon) => daemon.kill()))
      await temp.close()
    }
  },
  90000
)
