/**
 * Add over SSH on A (1b §3.4 steps 3–6, retry safety): the journal row is written before `prepare` is sent, B's
 * reply pins it with its SSH route, a lost reply is repeated with the same request id, a removed request stops the
 * repeats, and a row that has been connected never repeats. The helper is a stub that records what it was asked.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetError } from '../../src/shared/net/errors'
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

function a(answers: {
  prepare: (request: Record<string, unknown>) => Record<string, unknown>
  dial?: () => Promise<number>
  /** A helper refusal to throw for `op`, as the helper channel builds it. */
  refuse?: (op: string) => Error | undefined
  /** The shell `ssh.run` answers with; none, as a helper from before Windows remotes answers. */
  shell?: string
}) {
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
  let dials = 0
  const parked: string[] = []
  const helper = {
    speaks: () => true,
    claim: () => undefined,
    dial: async () => {
      dials += 1
      return answers.dial ? answers.dial() : 1
    },
    request: async (op: string, fields: any) => {
      asked.push([op, fields])
      const refusal = answers.refuse?.(op)
      if (refusal) throw refusal
      if (op === 'ssh.run') {
        if (fields.request.op === 'prepare') {
          atPrepare.push(peers.all().map((row) => `${row.state}:${row.source}`).join(','))
          return { reply: answers.prepare(fields.request), ...(answers.shell ? { shell: answers.shell } : {}) }
        }
        return {
          reply: { computer: 'B', os: 'macos', profiles: [{ selector: SELECTOR, label: 'Main', networking: true }] },
          ...(answers.shell ? { shell: answers.shell } : {})
        }
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
    now: () => now,
    park: (_node, why) => void parked.push(why)
  })
  return {
    ssh,
    peers,
    asked,
    atPrepare,
    parked,
    dials: () => dials,
    later: (secs: number) => (now += secs)
  }
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

  it('records nothing over a removal made here while B answered', async () => {
    let s!: ReturnType<typeof a>
    s = a({
      prepare: () => {
        const row = s.peers.all()[0]!
        s.peers.advance(row.localId, ['ssh_requested'], { state: 'removing' })
        return reply
      }
    })
    await expect(s.ssh.connect(choice)).rejects.toMatchObject({ details: { reason: 'removed_here' } })
    expect(s.peers.all()[0]!.state).toBe('removing')
    expect(s.dials()).toBe(0)
  })

  it('parks a first dial on an SSH login only the owner can fix, and tries other failures again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cleanups.push(() => vi.useRealTimers())
    // Past `pairingRetryMs` (5 s by default) a few times over.
    const wait = () => vi.advanceTimersByTimeAsync(20_000)
    const refused = (why: string) => async () => {
      throw new NetError('peer_offline', undefined, { details: { helper: 'unreachable', why } })
    }
    for (const why of ['auth_denied', 'host_key_changed', 'host_key_unknown']) {
      const s = a({ prepare: () => reply, dial: refused(why) })
      await s.ssh.connect(choice)
      await wait()
      expect(s.dials()).toBe(1)
      expect(s.parked).toEqual([why])
    }
    const t = a({ prepare: () => reply, dial: refused('timeout') })
    await t.ssh.connect(choice)
    await wait()
    expect(t.dials()).toBeGreaterThan(1)
    expect(t.parked).toEqual([])
    t.ssh.dispose()
    const after = t.dials()
    await wait()
    expect(t.dials()).toBe(after)
  })

  it('shows a helper refusal by its reason, never the remote output or an internal error', async () => {
    const output = "'exec' is not recognized as an internal or external command, operable program or batch file."
    // What the helper channel builds for `{code: 'windows_remote_unsupported', reason: <the remote's output>}`: the
    // code is no Net error code, so it arrives as `internal` with the output as its text.
    const s = a({
      prepare: () => reply,
      refuse: (op) =>
        op === 'ssh.run'
          ? new NetError('internal', output, {
              details: { reason: 'windows_remote_unsupported', helper: 'windows_remote_unsupported' }
            })
          : undefined
    })
    const refused = await s.ssh.profiles('r1', 'animatrix', 'me').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(NetError)
    expect(refused).toMatchObject({
      code: 'bad_request',
      message: sshErrorText('windows_remote_unsupported', 'animatrix', 'me'),
      details: { reason: 'windows_remote_unsupported' }
    })
  })

  it('keeps the shell the helper learned for B (Windows cmd or PowerShell) and binds the route with it', async () => {
    for (const shell of ['cmd', 'powershell'] as const) {
      const s = a({ prepare: () => reply, shell })
      expect((await s.ssh.profiles('r1', 'b', 'me')).shell).toBe(shell)
      const row = await s.ssh.connect(choice)
      expect(row.ssh!.shell).toBe(shell)
      expect(s.asked.find(([op]) => op === 'peer.addresses.set')![1].routes).toEqual([
        { route_id: 'r1', selector: SELECTOR, shell }
      ])
    }
    // No shell in the answer (an older helper) is sh.
    const t = a({ prepare: () => reply })
    expect((await t.ssh.profiles('r1', 'b', 'me')).shell).toBe('sh')
  })

  it('says Mousse is missing or too old on B when its launchers are not there', () => {
    expect(sshErrorText('remote_not_installed', 'pc', 'ana')).toBe(
      "Mousse isn't installed for ana on pc, or needs an update. Install or update it there, then open it once."
    )
  })

  it('lists only well-formed profile selectors', async () => {
    const s = a({ prepare: () => reply })
    expect((await s.ssh.profiles('r1', 'b', 'me')).profiles.map((item) => item.selector)).toEqual([SELECTOR])
  })
})
