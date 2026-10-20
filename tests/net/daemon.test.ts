import { join } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import type { NetStatus } from '../../src/shared/net/local'

import { productBuild } from '../support/build'
import { cliJson, startDaemon, until, type Daemon } from '../support/daemon'
import { ownedTemp } from '../support/tmp'

let entry: string
beforeAll(async () => {
  entry = (await productBuild()).entry
}, 120_000)
it('enrolls using pasted CLI stdin between actual daemon processes, restarts each side and propagates revoke', async () => {
  const temp = ownedTemp('net-daemon-'),
    root = temp.path,
    homes = [join(root, 'a'), join(root, 'b')],
    daemons: Daemon[] = []
  const launch = async (home: string): Promise<Daemon> => {
    const daemon = await startDaemon({ entry, home, repoRoot: root, label: 'Network daemon' })
    daemons.push(daemon)
    return daemon
  }
  const cli = (home: string, args: string[], input?: string): Promise<any> =>
    cliJson({ entry, home, args: ['--json', ...args], input, label: 'Network CLI' })
  try {
    let a = await launch(homes[0]),
      b = await launch(homes[1])
    expect(await cli(homes[1], ['net', 'status'])).toMatchObject({
      enabled: false,
      keystore: 'missing'
    })
    const initial = (await cli(homes[0], [
      'net',
      'init',
      '--listen',
      '--port',
      '0',
      '--name',
      'authority'
    ])) as NetStatus
    expect((await cli(homes[0], ['net', 'protect'], 'test-authority-protection')).protected).toBe(
      true
    )
    const invitation = await cli(homes[0], ['bridge', 'invite'])
    const joined = await cli(
      homes[1],
      ['bridge', 'join', '--name', 'follower'],
      invitation.invite + '\n'
    )
    await cli(homes[1], ['net', 'protect'], 'test-follower-protection')
    const open = (node: string) => (s: NetStatus) =>
      s.peers.some((p) => p.node === node && p.state === 'open')
    await until(() => cli(homes[0], ['net', 'status']), open(joined.node))
    await a.kill()
    a = await launch(homes[0])
    expect((await cli(homes[0], ['net', 'status'])).keystore).toBe('locked')
    await cli(homes[0], ['net', 'unlock'], 'test-authority-protection')
    await until(() => cli(homes[1], ['net', 'status']), open(joined.authority))
    expect((await cli(homes[0], ['net', 'status'])).routes).toEqual(initial.routes)
    await b.kill()
    b = await launch(homes[1])
    await cli(homes[1], ['net', 'unlock'], 'test-follower-protection')
    await until(() => cli(homes[1], ['net', 'status']), open(joined.authority))
    await cli(homes[0], ['bridge', 'rename', joined.node, 'renamed follower'])
    await until(
      () => cli(homes[1], ['bridge', 'nodes']),
      (rows) => rows.nodes.some((n: any) => n.node === joined.node && n.name === 'renamed follower')
    )
    const doctor = await cli(homes[0], ['net', 'doctor'])
    expect(doctor.ok, JSON.stringify(doctor)).toBe(true)
    await cli(homes[0], ['bridge', 'revoke', joined.node])
    await until(
      () => cli(homes[1], ['bridge', 'nodes']),
      (rows) => rows.nodes.some((n: any) => n.node === joined.node && n.revoked)
    )
    expect(
      (await cli(homes[1], ['net', 'status'])).peers.every((p: any) => p.state !== 'open')
    ).toBe(true)
    expect(
      (await cli(homes[0], ['net', 'status'])).peers.every((p: any) => p.state !== 'open')
    ).toBe(true)
  } finally {
    await Promise.all(daemons.map((daemon) => daemon.kill()))
    await temp.close()
  }
}, 120000)
