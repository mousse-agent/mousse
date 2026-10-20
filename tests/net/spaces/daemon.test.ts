import { join } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import type { SpaceLocalDelivery, SpaceLocalTail } from '../../../src/shared/spaces/local'

import { productBuild } from '../../support/build'
import { cliJson, startDaemon, until as waitUntil, type Daemon } from '../../support/daemon'
import { ownedTemp } from '../../support/tmp'

let entry: string

beforeAll(async () => {
  entry = (await productBuild()).entry
}, 120000)
const until = <T>(probe: () => T | Promise<T>, ready: (value: T) => boolean, timeout = 30000) =>
  waitUntil(probe, ready, timeout, 'Space daemon qualification timed out')
it('holds a three-daemon public conversation through each SIGKILL restart, preserving sent originals once and pending-author FIFO', async () => {
  const temp = ownedTemp('spaces-daemon-'),
    root = temp.path,
    homes = ['a', 'b', 'c'].map((name) => join(root, name)),
    started: Daemon[] = [],
    authored: Array<{ author: number; delivery: SpaceLocalDelivery; text: string }> = [],
    passphrase = 'actual-space-daemon-protection'
  const launch = async (home: string): Promise<Daemon> => {
    const daemon = await startDaemon({ entry, home, repoRoot: root, label: 'Space daemon' })
    started.push(daemon)
    return daemon
  }
  const cli = (author: number, args: string[], input?: string): Promise<any> =>
    cliJson({
      entry,
      home: homes[author],
      args: ['--json', ...args],
      input,
      env: { MOUSSE_REPO_ROOT: root },
      timeout: 30000,
      label: 'Space CLI'
    })
  let daemons: Daemon[] = [],
    space = '',
    stream = ''
  const post = async (author: number, text: string): Promise<SpaceLocalDelivery> => {
    const delivery = (await cli(author, ['spaces', 'post', stream, text])) as SpaceLocalDelivery
    authored.push({ author, delivery, text })
    return delivery
  }
  const delivered = async (record: (typeof authored)[number]): Promise<SpaceLocalDelivery> =>
    until(
      async () => {
        const value = (
          await cli(record.author, ['spaces', 'outbox', stream, '--id', record.delivery.id])
        ).entries[0] as SpaceLocalDelivery
        if (value.state === 'failed') throw new Error(`Original ${value.id} failed: ${value.error}`)
        return value
      },
      (value) => value.state === 'sent'
    )
  const restart = async (author: number) => {
    daemons[author] = await launch(homes[author])
    expect((await cli(author, ['net', 'status'])).keystore).toBe('locked')
    await cli(author, ['net', 'unlock'], passphrase)
  }
  try {
    for (let author = 0; author < 3; author++) {
      daemons.push(await launch(homes[author]))
      await cli(author, ['net', 'init', '--listen', '--port', '0', '--name', `member-${author}`])
      await cli(author, ['net', 'protect'], passphrase)
    }
    const created = await cli(0, ['spaces', 'create', 'Three process public conversation'])
    space = created.space
    stream = created.channel
    for (const author of [1, 2]) {
      const invitation = await cli(0, ['spaces', 'invite', space])
      expect(await cli(author, ['spaces', 'join'], invitation.invite + '\n')).toMatchObject({
        space,
        member: true,
        readonly: false
      })
      await cli(author, ['spaces', 'tail', stream])
    }
    for (let author = 0; author < 3; author++)
      expect((await post(author, `initial-${author}`)).state).toBe('sent')
    // Kill/restart the authority first. Both independent members retain pending originals.
    await daemons[0].kill()
    expect(daemons[0].child.signalCode).toBe('SIGKILL')
    for (const author of [1, 2])
      await until(
        () => cli(author, ['spaces', 'list']),
        (value) => value.spaces.find((item: any) => item.space === space)?.offline === true
      )
    expect((await post(1, 'host outage b-one')).state).toBe('pending')
    expect((await post(1, 'host outage b-two')).state).toBe('pending')
    expect((await post(2, 'host outage c-one')).state).toBe('pending')
    await restart(0)
    for (const record of authored) await delivered(record)
    // Kill/restart each member in turn; sent events continue while its replica is absent.
    for (const author of [1, 2]) {
      await daemons[author].kill()
      expect(daemons[author].child.signalCode).toBe('SIGKILL')
      for (const sender of [0, 1, 2].filter((sender) => sender !== author))
        expect((await post(sender, `while-${author}-offline-from-${sender}`)).state).toBe('sent')
      await restart(author)
    }
    // Also kill a pending author while the host is absent: its durable FIFO survives two restarts.
    await daemons[0].kill()
    await until(
      () => cli(1, ['spaces', 'list']),
      (value) => value.spaces[0].offline === true
    )
    const pendingA = await post(1, 'pending-author one'),
      pendingB = await post(1, 'pending-author two')
    expect(pendingA.state).toBe('pending')
    expect(pendingB.state).toBe('pending')
    await daemons[1].kill()
    await restart(1)
    const pendingC = await post(1, 'pending-author three')
    expect(pendingC.state).toBe('pending')
    await restart(0)
    const sent = new Map<string, SpaceLocalDelivery>()
    for (const record of authored) sent.set(record.delivery.id, await delivered(record))
    expect(sent.get(pendingA.id)!.position!.seq).toBeLessThan(sent.get(pendingB.id)!.position!.seq)
    expect(sent.get(pendingB.id)!.position!.seq).toBeLessThan(sent.get(pendingC.id)!.position!.seq)
    const expected = [...authored].sort(
      (a, b) => sent.get(a.delivery.id)!.position!.seq - sent.get(b.delivery.id)!.position!.seq
    )
    const ids = expected.map((record) => record.delivery.id)
    for (let author = 0; author < 3; author++) {
      const page = await until(
        () => cli(author, ['spaces', 'tail', stream]) as Promise<SpaceLocalTail>,
        (page) => page.records.length === ids.length
      )
      expect(page.records.map((record) => record.envelope.id)).toEqual(ids)
      expect(new Set(page.records.map((record) => record.envelope.id)).size).toBe(ids.length)
      expect(page.records.map((record) => record.envelope.body)).toEqual(
        expected.map((record) => ({ text: record.text }))
      )
      expect(page.records.map((record) => record.seq)).toEqual(ids.map((_, index) => index + 1))
      expect(page.done).toBe(true)
    }
    for (const record of authored) {
      const original = sent.get(record.delivery.id)!
      if (record.delivery.state === 'sent')
        expect(original.position).toEqual(record.delivery.position)
      expect(original.state).toBe('sent')
    }
    // Every actual process was killed and reopened; these are separate installations and user roots.
    const self = await Promise.all([0, 1, 2].map((author) => cli(author, ['net', 'status'])))
    expect(new Set(self.map((value) => value.self.user)).size).toBe(3)
    expect(new Set(self.map((value) => value.self.node)).size).toBe(3)
  } finally {
    await Promise.all(started.map((daemon) => daemon.kill()))
    await temp.close()
  }
}, 180000)
