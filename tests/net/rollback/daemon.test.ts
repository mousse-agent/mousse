import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, it } from 'vitest'
import { productBuild } from '../../support/build'
import { runCli, startDaemon, type Daemon } from '../../support/daemon'
import { ownedTemp } from '../../support/tmp'

let entry: string
beforeAll(async () => {
  entry = (await productBuild()).entry
}, 120000)
it.skipIf(process.platform === 'win32')(
  'routes emitted production CLI rollback and preserves original public history across actual daemon restart',
  async () => {
    const temp = ownedTemp('net-rollback-daemon-'),
      root = temp.path,
      home = join(root, 'home'),
      daemons: Daemon[] = []
    const cli = async (
      args: string[],
      input?: string
    ): Promise<{ code: number | null; data: any }> => {
      const result = await runCli({
        entry,
        home,
        args: ['--json', ...args],
        input,
        env: { MOUSSE_REPO_ROOT: root },
        label: 'Owned rollback CLI'
      })
      try {
        return {
          code: result.code,
          data: JSON.parse(result.code === 0 ? result.stdout : result.stderr)
        }
      } catch {
        throw new Error('Rollback CLI did not return JSON: ' + result.stderr.slice(-1000))
      }
    }
    const ok = async (args: string[], input?: string) => {
      const result = await cli(args, input)
      expect(result.code).toBe(0)
      return result.data
    }
    const launch = async (): Promise<Daemon> => {
      const daemon = await startDaemon({
        entry,
        home,
        repoRoot: root,
        readiness: 'runtime',
        timeout: 20000,
        label: 'Owned rollback daemon'
      })
      daemons.push(daemon)
      return daemon
    }
    const profile = () =>
      join(
        home,
        'profiles',
        JSON.parse(readFileSync(join(home, 'installation.json'), 'utf8')).defaultProfileId
      )
    const originals = () => {
      const db = new DatabaseSync(join(profile(), 'net', 'net.db'), { readOnly: true })
      try {
        return db
          .prepare(
            'SELECT id,stream,envelope,sig,state,attempts,epoch,seq FROM net_outbox ORDER BY rowid'
          )
          .all()
      } finally {
        db.close()
      }
    }
    try {
      let daemon = await launch()
      expect(await ok(['net', 'status'])).toMatchObject({
        enabled: false,
        features: { netBridge: false, netSpaces: false, netBridgeThreads: true }
      })
      expect(existsSync(join(profile(), 'net'))).toBe(false)
      await ok(['net', 'init', '--listen', '--port', '0'])
      await ok(['net', 'protect'], 'owned-rollback-daemon-passphrase')
      const created = await ok(['spaces', 'create', 'Original rollback Space']),
        sent = await ok(['spaces', 'post', created.channel, 'original CLI message'])
      expect(sent).toMatchObject({ state: 'sent', position: { epoch: 1, seq: 1 } })
      const before = originals()
      expect(await ok(['net', 'disable'])).toMatchObject({
        enabled: false,
        restartRequired: true,
        features: { netBridge: false, netSpaces: false, netBridgeThreads: true },
        routes: []
      })
      expect(await cli(['spaces', 'create', 'denied'])).toMatchObject({
        code: 1,
        data: { code: 'disabled' }
      })
      expect(await cli(['net', 'init'])).toMatchObject({ code: 1, data: { code: 'disabled' } })
      expect(await ok(['net', 'status'])).toMatchObject({ enabled: false, restartRequired: true })
      expect(await cli(['net', 'doctor'])).toMatchObject({ code: 1, data: { code: 'disabled' } })
      expect(originals()).toEqual(before)
      await daemon.stop()
      daemon = await launch()
      expect(await ok(['net', 'status'])).toMatchObject({
        enabled: false,
        features: { netBridge: false, netSpaces: false, netBridgeThreads: true },
        routes: []
      })
      expect(await cli(['net', 'unlock'], 'owned-rollback-daemon-passphrase')).toMatchObject({
        code: 1,
        data: { code: 'disabled' }
      })
      expect(await ok(['net', 'status'])).toMatchObject({ enabled: false, routes: [] })
      expect(await cli(['spaces', 'list'])).toMatchObject({ code: 1, data: { code: 'disabled' } })
      expect(originals()).toEqual(before)
      await ok(['net', 'init', '--unlock'], 'owned-rollback-daemon-passphrase')
      expect(await ok(['net', 'status'])).toMatchObject({
        enabled: true,
        features: { netBridge: true, netSpaces: true, netBridgeThreads: true }
      })
      const tail = await ok(['spaces', 'tail', created.channel])
      expect(tail.records).toHaveLength(1)
      expect(tail.records[0].envelope.id).toBe(sent.id)
      expect(tail.records[0].envelope.body).toEqual({ text: 'original CLI message' })
      expect(originals()).toEqual(before)
    } finally {
      for (const daemon of daemons.reverse()) await daemon.stop()
      await temp.close()
    }
  },
  60000
)
