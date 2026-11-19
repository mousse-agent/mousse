/**
 * Add over SSH on A (1b §3.4 steps 3–6, retry safety): the journal row is written before `prepare` is sent, B's
 * reply pins it with its SSH route, a lost reply is repeated with the same request id, a removed request stops the
 * repeats, and a row that has been connected never repeats. The helper is a stub that records what it was asked.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NetDatabase } from '../../src/mms/net/store/database'
import type { EngineHelper } from '../../src/mms/netEngine/helper/connections'
import { SshAdd, sshErrorText } from '../../src/mms/netEngine/ssh/add'
import { EnginePeerStore } from '../../src/mms/netEngine/store'

const cleanups: Array<() => unknown> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const B = 'bb'.repeat(32)
const SELECTOR = 'abcdefghijklmnopqrstuvwxyz'

function a(answers: { prepare: (request: Record<string, unknown>) => Record<string, unknown> }) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-ssh-'))
  const db = new NetDatabase({ profileDir: dir })
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => db.close()
  )
  const peers = new EnginePeerStore(db)
  const asked: Array<[string, any]> = []
  /** What the journal held when `prepare` went out. */
  const atPrepare: string[] = []
  const helper = {
    speaks: () => true,
    claim: () => undefined,
    dial: async () => 1,
    request: async (op: string, fields: any) => {
      asked.push([op, fields])
      if (op === 'ssh.run') {
        if (fields.request.op === 'prepare') {
          atPrepare.push(peers.all().map((row) => `${row.state}:${row.source}`).join(','))
          return { reply: answers.prepare(fields.request) }
        }
        return { reply: { computer: 'B', os: 'macos', profiles: [{ selector: SELECTOR, label: 'Main', networking: true }] } }
      }
      return {}
    }
  } as unknown as EngineHelper
  let now = 1_800_000_000
  const ssh = new SshAdd({
    peers,
    helper: () => helper,
    identity: () => 'aa'.repeat(32),
    name: () => 'A',
    limits: () => ({ deadlineMs: 5_000, maxAgeSecs: 86_400 }),
    changed: () => undefined,
    now: () => now
  })
  return { ssh, peers, asked, atPrepare, later: (secs: number) => (now += secs) }
}

const reply = { identity: B, name: 'B', selector: SELECTOR, grant_id: '4', existing: false, already: false, starts_at_login: true }
const choice = { routeId: 'r1', target: 'me@b', host: 'b', user: 'me', selector: SELECTOR }

describe('Add over SSH (A)', () => {
  it('journals before sending, then pins B with its SSH route and dials', async () => {
    const s = a({ prepare: () => reply })
    const row = await s.ssh.connect(choice)
    expect(s.atPrepare).toEqual(['ssh_requested:ssh'])
    expect(row).toMatchObject({ endpoint: B, state: 'ssh_granted', source: 'ssh', name: 'B' })
    const prepare = s.asked.find(([op, fields]) => op === 'ssh.run' && fields.request.op === 'prepare')![1]
    expect(prepare.request).toMatchObject({ request_id: row.ssh!.requestId, selector: SELECTOR, joiner: 'aa'.repeat(32), joiner_name: 'A' })
    expect(row.ssh!.requestId).toMatch(/^[0-9a-f]{32}$/)
    expect(s.asked.find(([op]) => op === 'peer.add')![1]).toEqual({ identity: B, name: 'B', routes: [] })
    expect(s.asked.find(([op]) => op === 'peer.addresses.set')![1]).toEqual({
      identity: B,
      routes: [{ route_id: 'r1', selector: SELECTOR, shell: 'sh' }]
    })
    s.ssh.connected(s.peers.get(row.localId)!)
    expect(s.peers.get(row.localId)).toMatchObject({ state: 'connected', ssh: { everConnected: true } })
  })

  it('repeats a lost reply with the same request id', async () => {
    let first = true
    const ids: unknown[] = []
    const s = a({
      prepare: (request) => {
        ids.push(request.request_id)
        if (first) {
          first = false
          return { error: 'remote_failed' }
        }
        return { ...reply, already: true }
      }
    })
    await expect(s.ssh.connect(choice)).rejects.toMatchObject({ details: { reason: 'remote_failed' } })
    const row = s.peers.all()[0]!
    expect(row.state).toBe('ssh_requested')
    await s.ssh.prepare(row)
    expect(ids[0]).toBe(ids[1])
    expect(s.peers.all()).toHaveLength(1)
  })

  it('stops repeating once B removed it, once it has connected, and past the maximum age', async () => {
    const s = a({ prepare: () => ({ error: 'removed' }) })
    await expect(s.ssh.connect(choice)).rejects.toMatchObject({ message: sshErrorText('removed', 'b') })
    expect(s.peers.all()[0]!.ssh?.removed).toBe(true)

    const t = a({ prepare: () => reply })
    const row = await t.ssh.connect(choice)
    t.ssh.connected(t.peers.get(row.localId)!)
    const before = t.asked.length
    await expect(t.ssh.prepare(t.peers.get(row.localId)!)).rejects.toBeTruthy()
    expect(t.asked.length).toBe(before)

    const u = a({ prepare: () => ({ error: 'remote_failed' }) })
    await expect(u.ssh.connect(choice)).rejects.toBeTruthy()
    u.later(90_000)
    await expect(u.ssh.prepare(u.peers.all()[0]!)).rejects.toMatchObject({ details: { reason: 'expired' } })
  })

  it('lists only well-formed profile selectors', async () => {
    const s = a({ prepare: () => reply })
    expect((await s.ssh.profiles('r1', 'b', 'me')).profiles.map((item) => item.selector)).toEqual([SELECTOR])
  })
})
