import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { SpaceLocalDelivery, SpaceLocalTail } from '../../../src/shared/spaces/local'

import { buildTestCli } from '../helpers/build'

let fixture: Awaited<ReturnType<typeof buildTestCli>> | undefined
let entry: string

beforeAll(async () => {
  fixture = await buildTestCli()
  entry = fixture.entry
}, 60000)
afterAll(() => fixture?.cleanup())
async function until<T>(
  probe: () => T | Promise<T>,
  ready: (value: T) => boolean,
  timeout = 30000
): Promise<T> {
  const deadline = Date.now() + timeout
  do {
    const value = await probe()
    if (ready(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  throw new Error('Space daemon qualification timed out')
}
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await done
}
it('holds a three-daemon public conversation through each SIGKILL restart, preserving sent originals once and pending-author FIFO', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spaces-daemon-'))),
    homes = ['a', 'b', 'c'].map((name) => join(root, name)),
    children: ChildProcess[] = [],
    authored: Array<{ author: number; delivery: SpaceLocalDelivery; text: string }> = [],
    passphrase = 'actual-space-daemon-protection'
  const launch = async (home: string): Promise<ChildProcess> => {
    let output = ''
    const child = spawn(process.execPath, [entry, '--home', home, 'service', 'run'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MOUSSE_HOME: home, MOUSSE_REPO_ROOT: root, NO_COLOR: '1' }
    })
    children.push(child)
    child.stdout!.on('data', (bytes) => {
      output = (output + String(bytes)).slice(-8000)
    })
    child.stderr!.on('data', (bytes) => {
      output = (output + String(bytes)).slice(-8000)
    })
    await until(
      () => {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error('Space daemon exited before readiness: ' + output)
        try {
          return (
            JSON.parse(readFileSync(join(home, 'mms.runtime.json'), 'utf8')).pid === child.pid &&
            JSON.parse(readFileSync(join(home, 'mms.owner.json'), 'utf8')).pid === child.pid
          )
        } catch {
          return false
        }
      },
      Boolean,
      40000
    )
    return child
  }
  const cli = (author: number, args: string[], input?: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, '--home', homes[author], '--json', ...args], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, MOUSSE_HOME: homes[author], MOUSSE_REPO_ROOT: root, NO_COLOR: '1' }
      })
      children.push(child)
      let output = '',
        error = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('Space CLI timed out: ' + args.slice(0, 2).join(' ')))
      }, 30000)
      child.stdout!.on('data', (bytes) => {
        output += String(bytes)
      })
      child.stderr!.on('data', (bytes) => {
        error += String(bytes)
      })
      child.on('error', (cause) => {
        clearTimeout(timer)
        reject(cause)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(
            new Error('Space CLI failed ' + args.slice(0, 2).join(' ') + ': ' + error.slice(-4000))
          )
          return
        }
        try {
          resolve(JSON.parse(output))
        } catch {
          reject(new Error('Space CLI returned invalid JSON: ' + output.slice(-4000)))
        }
      })
      child.stdin!.end(input)
    })
  let daemons: ChildProcess[] = [],
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
    await kill(daemons[0])
    expect(daemons[0].signalCode).toBe('SIGKILL')
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
      await kill(daemons[author])
      expect(daemons[author].signalCode).toBe('SIGKILL')
      for (const sender of [0, 1, 2].filter((sender) => sender !== author))
        expect((await post(sender, `while-${author}-offline-from-${sender}`)).state).toBe('sent')
      await restart(author)
    }
    // Also kill a pending author while the host is absent: its durable FIFO survives two restarts.
    await kill(daemons[0])
    await until(
      () => cli(1, ['spaces', 'list']),
      (value) => value.spaces[0].offline === true
    )
    const pendingA = await post(1, 'pending-author one'),
      pendingB = await post(1, 'pending-author two')
    expect(pendingA.state).toBe('pending')
    expect(pendingB.state).toBe('pending')
    await kill(daemons[1])
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
    await Promise.all(children.map(kill))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 180000)
