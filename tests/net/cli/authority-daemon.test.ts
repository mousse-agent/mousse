import { fork, type ChildProcess } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { NetStatus } from '../../../src/shared/net/local'

import { stop } from '../helpers/process'
import { productBuild } from '../../support/build'
import { cliJson, startDaemon, until, type Daemon } from '../../support/daemon'
import { ownedTemp } from '../../support/tmp'

let entry: string, responseEntry: string
beforeAll(async () => {
  const product = await productBuild()
  entry = product.entry
  responseEntry = await product.buildEntry(
    'tests/net/cli/authority-response-child.ts',
    'cli/authority-response.js'
  )
}, 120_000)
it.skipIf(process.platform === 'win32')(
  'recovers a lost CLI authority-transfer response through original daemon receipts after both restarts and imports the encrypted recovery file',
  async () => {
    const temp = ownedTemp('net-daemon-'),
      root = temp.path,
      homes = [join(root, 'a'), join(root, 'b')],
      daemons: Daemon[] = [],
      children: ChildProcess[] = []
    const launch = async (home: string): Promise<Daemon> => {
      const daemon = await startDaemon({ entry, home, repoRoot: root, label: 'Network daemon' })
      daemons.push(daemon)
      return daemon
    }
    const cli = (home: string, args: string[], input?: string): Promise<any> =>
      cliJson({ entry, home, args: ['--json', ...args], input, label: 'Network CLI' })
    const profile = (home: string) =>
      join(
        home,
        'profiles',
        JSON.parse(readFileSync(join(home, 'installation.json'), 'utf8')).defaultProfileId
      )
    const read = <T>(home: string, work: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(join(profile(home), 'net', 'net.db'), { readOnly: true })
      try {
        return work(db)
      } finally {
        db.close()
      }
    }
    const state = (home: string) =>
      read(home, (db) =>
        JSON.parse(
          String(db.prepare('SELECT value FROM net_identity_state WHERE singleton=1').get()!.value)
        )
      )
    const delivery = () =>
      read(homes[0], (db) =>
        db
          .prepare(
            'SELECT transfer,recipient,import_rpc,activation_rpc FROM net_authority_delivery'
          )
          .all()
      )
    const mutations = () =>
      read(homes[1], (db) =>
        db
          .prepare(
            "SELECT a.id,a.method,a.execution,e.state FROM net_rpc_aliases a JOIN net_executions e ON e.id=a.execution WHERE a.method IN ('authority.transfer.import','authority.transfer.activate') ORDER BY a.method"
          )
          .all()
      )
    try {
      let a = await launch(homes[0]),
        b = await launch(homes[1])
      await cli(homes[0], ['net', 'init', '--listen', '--port', '0', '--name', 'authority'])
      await cli(homes[0], ['net', 'protect'], 'test-authority-protection')
      const invitation = await cli(homes[0], ['bridge', 'invite']),
        joined = await cli(
          homes[1],
          ['bridge', 'join', '--name', 'follower'],
          invitation.invite + '\n'
        )
      await cli(homes[1], ['net', 'protect'], 'test-follower-protection')
      const open = (node: string) => (s: NetStatus) =>
        s.peers.some((p) => p.node === node && p.state === 'open')
      await until(() => cli(homes[0], ['net', 'status']), open(joined.node))
      const backup = join(root, 'private-recovery.json'),
        original = state(homes[0]),
        ownUser = original.self.user
      const roster = (value: any) =>
        JSON.parse(Buffer.from(value.users[ownUser].current.payload, 'base64url').toString())
      const before = roster(original)
      expect(
        await cli(
          homes[0],
          ['net', 'recovery', 'export', '--output', backup],
          'offline-recovery-passphrase'
        )
      ).toEqual({ file: backup })
      expect(statSync(backup).mode & 0o777).toBe(0o600)
      const file = readFileSync(backup, 'utf8')
      expect(Object.keys(JSON.parse(file)).sort()).toEqual(['ct', 'nonce', 'salt', 'v'])
      expect(file).not.toContain('PRIVATE KEY')
      expect(file).not.toContain('offline-recovery-passphrase')
      // Stop the requesting CLI after its actual socket write, before it can handle the daemon response.
      const caller = fork(
        responseEntry,
        ['--home', homes[0], '--json', 'net', 'authority', 'transfer', joined.node],
        {
          execPath: process.execPath,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env, MOUSSE_HOME: homes[0], NO_COLOR: '1' }
        }
      )
      children.push(caller)
      let visible = ''
      caller.stdout!.on('data', (bytes) => {
        visible += bytes.toString()
      })
      caller.stderr!.on('data', () => {})
      const requestHeld = new Promise<void>((resolve, reject) => {
        caller.once('message', (message) => {
          if ((message as { requestHeld?: boolean }).requestHeld) resolve()
          else reject(new Error('Unexpected authority requester checkpoint'))
        })
        caller.once('exit', () =>
          reject(new Error('Authority requester exited before holding its pending request'))
        )
      })
      await Promise.all([until(() => delivery().length, Boolean, 20_000), requestHeld])
      expect(caller.exitCode).toBeNull()
      expect(caller.kill('SIGSTOP')).toBe(true)
      await until(
        () => state(homes[1]).transfer?.phase,
        (value) => value === 'activated'
      )
      await stop(caller)
      expect(visible).toBe('')
      const ids = delivery(),
        records = mutations()
      expect(ids).toHaveLength(1)
      expect(ids[0].import_rpc).toMatch(/^rpc_/)
      expect(ids[0].activation_rpc).toMatch(/^rpc_/)
      expect(records).toHaveLength(2)
      expect(records.every((row) => row.state === 'completed')).toBe(true)
      expect(records.map((row) => row.id).sort()).toEqual(
        [ids[0].import_rpc, ids[0].activation_rpc].sort()
      )
      expect((await cli(homes[0], ['net', 'status'])).self.isAuthority).toBe(false)
      expect((await cli(homes[1], ['net', 'status'])).self.isAuthority).toBe(true)
      await a.kill()
      await b.kill()
      a = await launch(homes[0])
      b = await launch(homes[1])
      expect((await cli(homes[0], ['net', 'status'])).keystore).toBe('locked')
      expect((await cli(homes[1], ['net', 'status'])).keystore).toBe('locked')
      await cli(homes[0], ['net', 'unlock'], 'test-authority-protection')
      await cli(homes[1], ['net', 'unlock'], 'test-follower-protection')
      await until(() => cli(homes[0], ['net', 'status']), open(joined.node))
      expect(await cli(homes[0], ['net', 'authority', 'transfer', joined.node])).toMatchObject({
        phase: 'activated',
        authority: joined.node
      })
      expect(delivery()).toEqual(ids)
      expect(mutations()).toEqual(records)
      expect(await cli(homes[0], ['net', 'authority', 'status'])).toMatchObject({
        phase: 'finalized',
        transfer: ids[0].transfer
      })
      await b.kill()
      expect(
        await cli(
          homes[0],
          ['net', 'recovery', 'import', '--file', backup, '--become-authority'],
          'offline-recovery-passphrase'
        )
      ).toMatchObject({ self: { isAuthority: true, user: ownUser } })
      const recovered = roster(state(homes[0]))
      expect(recovered.rootKey).toBe(before.rootKey)
      expect(recovered.recoveryEpoch).toBeGreaterThan(before.recoveryEpoch)
      expect(delivery()).toEqual(ids)
    } finally {
      await Promise.all([...daemons.map((daemon) => daemon.kill()), ...children.map(stop)])
      await temp.close()
    }
  },
  120000
)
