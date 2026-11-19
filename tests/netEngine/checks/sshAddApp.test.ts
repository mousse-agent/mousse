/**
 * Owner check `phase1b.ssh-add-app` (1b §3.4–§3.6): A adds B over SSH through its window, B answering at an SSH
 * test server in process (`Fabric.sshServer`: B's `mousse-cli net-engine ssh` is its daemon's `netEngine.ssh.serve`).
 *
 * - an existing profile, one way only: A's row reads "Uses B", B's row connects on A's first inbound, and B holds
 *   no way back; a profile paired elsewhere is listed; a new one is made;
 * - a crash at each prepare step resumes with one profile and one grant;
 * - a removal on B survives A's retries, and a connected row never repeats prepare;
 * - an existing 1a row is kept, and a lost existing reply is answered again;
 * - a crash after the grant was saved, then a removal, then a restart with no retry leaves no grant and no row;
 * - a done request is answered again only while its grant still serves;
 * - `net-engine ssh` never starts a daemon.
 *
 * Its controls (`MOUSSE_NET_ENGINE_CONTROL`) fail it with: `refuse-if-paired` refused_paired_profile,
 * `ssh-row-pairback` ssh_row_pairback, `profile-before-journal` duplicate_after_crash, `grant-id-not-checked`
 * removed_grant_reported_live, `retry-after-connected` removal_undone, `overwrite-1a-row` 1a_row_lost,
 * `own-row-not-resumed` stuck_granting, `existing-reply-not-kept` existing_reply_lost,
 * `removal-skips-unsaved-grant` grant_survived_removal, `remote-autostart` daemon_started. The Send link that
 * converts SSH rows (`ssh-row-not-converted`) is the link slice's case.
 */
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNetEngineCommand } from '../../../src/cli/commands/netEngineSsh'
import type { PrepareStep } from '../../../src/mms/netEngine/ssh/prepare'
import { deviceState, eventually, Fabric, REAL_HELPER, rowFor, step, type Computer } from './harness'

const HOST = 'b.test'

describe.skipIf(REAL_HELPER)('phase1b.ssh-add-app', () => {
  const fabric = new Fabric()
  fabric.network.minor = 1
  let b: Computer
  let served: Array<Record<string, unknown>>
  let made = 0
  beforeAll(async () => {
    b = await fabric.computer('b')
    served = fabric.sshServer(HOST, b)
  }, 120_000)
  afterAll(() => fabric.close(), 180_000)

  /** A's window: resolve, trust the key, list B's profiles. */
  async function begin(a: Computer) {
    const resolved = await step(undefined, () => a.dispatch('netEngine.ssh.resolve', { target: `me@${HOST}` }, true))
    const probe = await step(undefined, () =>
      a.dispatch('netEngine.ssh.probe', { routeId: resolved.routeId, host: HOST }, true)
    )
    await step(undefined, () =>
      a.dispatch('netEngine.ssh.trust', { routeId: resolved.routeId, sha256: probe.sha256, host: HOST }, true)
    )
    const list = await step(undefined, () =>
      a.dispatch('netEngine.ssh.profiles', { routeId: resolved.routeId, host: HOST, user: 'me' }, true)
    )
    return { resolved, list: list as { profiles: Array<{ selector: string; label: string }> } }
  }

  /** Connect with `choice`; answers whether it went through (a crash or a lost reply does not). */
  async function connect(a: Computer, routeId: string, choice: { selector?: string; newLabel?: string }) {
    return a
      .dispatch('netEngine.ssh.connect', { routeId, target: `me@${HOST}`, host: HOST, user: 'me', ...choice }, true)
      .then(
        () => true,
        () => false
      )
  }

  const bSelector = () => b.mms.sshRemote()!.selectorOf(b.mms.netEngine.profileDir)
  const sshRow = (a: Computer) =>
    a.mms.netEngine.peerRows().find((row) => row.source === 'ssh' && row.state !== 'removed')
  /** A repeats prepare, as its recovery does after a restart. */
  const repeat = (a: Computer) => a.mms.netEngine.sshAdd().prepare(sshRow(a)!)
  const grantsAt = (identity: string, of: string) =>
    fabric.network.grantsAt(identity).filter((grant) => grant.caller === of)
  const crashOnce = (at: PrepareStep) => {
    b.mms.sshRemote()!.crashAt = (step) => {
      if (step !== at) return false
      b.mms.sshRemote()!.crashAt = undefined
      return true
    }
  }
  const loseOnce = () => {
    fabric.network.sshLose = (request) => {
      if (request.op !== 'prepare') return false
      fabric.network.sshLose = undefined
      return true
    }
  }

  it('adds an existing profile one way; B connects on A’s first inbound; B gets no way back', async () => {
    const a = await fabric.computer(`a${++made}`)
    const { resolved, list } = await begin(a)
    expect(list.profiles.map((profile) => profile.selector)).toContain(bSelector())
    const from = fabric.crossed.length
    expect(await connect(a, resolved.routeId, { selector: bSelector() })).toBe(true)
    await step('unreachable', () =>
      eventually(() => {
        const row = sshRow(a)!
        expect(deviceState(a, row.localId)).toBe('connected')
        const onB = rowFor(b, a)!
        expect(onB.state).toBe('connected')
        expect(b.mms.netEngine.status().devices.find((device) => device.node === onB.localId)?.direction).toBe('in')
      }, 30_000)
    )
    await step('two_way', () => expect(grantsAt(a.endpoint, b.endpoint)).toEqual([]))
    await step('ssh_row_pairback', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(fabric.crossed.slice(from).filter((row) => row.header.t === 'pairback')).toEqual([])
    })
  }, 120_000)

  it('lists a profile paired elsewhere, and makes a new one', async () => {
    const c = await fabric.computer('c')
    await fabric.pair(b, c)
    const a = await fabric.computer(`a${++made}`)
    const { resolved, list } = await begin(a)
    await step('refused_paired_profile', () =>
      expect(list.profiles.map((profile) => profile.selector)).toContain(bSelector())
    )
    expect(await connect(a, resolved.routeId, { newLabel: 'Fresh' })).toBe(true)
    await step('unreachable', () => eventually(() => expect(sshRow(a)!.state).toBe('connected'), 30_000))
    const labels = (await begin(a)).list.profiles.map((profile) => profile.label)
    await step('duplicate_after_crash', () => expect(labels.filter((label) => label === 'Fresh')).toHaveLength(1))
  }, 180_000)

  it.each(['journaled', 'profile', 'networking', 'row', 'grant-saved', 'grant-stored'] as PrepareStep[])(
    'resumes after a crash at %s with one profile and one grant',
    async (at) => {
      const a = await fabric.computer(`a${++made}`)
      const { resolved } = await begin(a)
      const label = `New ${at}`
      crashOnce(at)
      expect(await connect(a, resolved.routeId, { newLabel: label })).toBe(false)
      expect(sshRow(a)!.state).toBe('ssh_requested')
      await step('remote_failed', () => repeat(a))
      const labels = (await begin(a)).list.profiles.filter((profile) => profile.label === label)
      await step('duplicate_after_crash', () => expect(labels).toHaveLength(1))
      await step('stuck_granting', () =>
        eventually(() => {
          expect(sshRow(a)!.state).toBe('connected')
        }, 30_000)
      )
      const identity = sshRow(a)!.endpoint
      await step('duplicate_grant', () => expect(grantsAt(identity, a.endpoint)).toHaveLength(1))
    },
    120_000
  )

  it('keeps a removal on B through A’s retries, and a connected row never repeats prepare', async () => {
    const a = await fabric.computer(`a${++made}`)
    const { resolved } = await begin(a)
    loseOnce()
    expect(await connect(a, resolved.routeId, { selector: bSelector() })).toBe(false)
    await eventually(() => expect(rowFor(b, a)?.state).toBe('ssh_granted'))
    await b.dispatch('netEngine.remove', { node: rowFor(b, a)!.localId }, true)
    await step('removal_undone', async () => {
      await expect(repeat(a)).rejects.toMatchObject({ details: { reason: 'removed' } })
      expect(sshRow(a)!.ssh?.removed).toBe(true)
      expect(rowFor(b, a)).toBeUndefined()
      expect(grantsAt(b.endpoint, a.endpoint)).toEqual([])
    })

    // Connected, then removed on B: A's restart must not send prepare again.
    const a2 = await fabric.computer(`a${++made}`)
    const second = await begin(a2)
    expect(await connect(a2, second.resolved.routeId, { selector: bSelector() })).toBe(true)
    await eventually(() => expect(sshRow(a2)!.state).toBe('connected'), 30_000)
    const id = sshRow(a2)!.ssh!.requestId
    await b.dispatch('netEngine.remove', { node: rowFor(b, a2)!.localId }, true)
    const before = served.filter((request) => request.request_id === id).length
    await fabric.restartHelper(a2)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    await step('removal_undone', () =>
      expect(served.filter((request) => request.request_id === id).length).toBe(before)
    )
  }, 180_000)

  it('keeps an existing 1a row and answers a lost existing reply again', async () => {
    const a = await fabric.computer(`a${++made}`)
    const { ownerOnCaller } = await fabric.pair(b, a)
    // A drops its side; B's row for A stays, with A's grant.
    await a.dispatch('netEngine.remove', { node: ownerOnCaller }, true)
    const kept = rowFor(b, a)!
    const { resolved } = await begin(a)
    loseOnce()
    expect(await connect(a, resolved.routeId, { selector: bSelector() })).toBe(false)
    await step('existing_reply_lost', async () => {
      const row = await repeat(a)
      expect(row.state).toBe('ssh_granted')
    })
    await step('1a_row_lost', () => {
      const now = rowFor(b, a)!
      expect(now.localId).toBe(kept.localId)
      expect(now.source).toBeUndefined()
      expect(now.grant).toBe(kept.grant)
    })
  }, 180_000)

  it('leaves no grant and no row after a crash past the grant, a removal and a restart with no retry', async () => {
    const a = await fabric.computer(`a${++made}`)
    const { resolved } = await begin(a)
    crashOnce('grant-saved')
    expect(await connect(a, resolved.routeId, { selector: bSelector() })).toBe(false)
    const onB = rowFor(b, a)!
    expect(onB.state).toBe('ssh_granting')
    await b.dispatch('netEngine.remove', { node: onB.localId }, true)
    await fabric.restartEngine(b)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await step('grant_survived_removal', () => {
      expect(grantsAt(b.endpoint, a.endpoint)).toEqual([])
      expect(rowFor(b, a)).toBeUndefined()
    })
  }, 180_000)

  it('answers a done request again only while its grant still serves', async () => {
    const a = await fabric.computer(`a${++made}`)
    const { resolved } = await begin(a)
    loseOnce()
    expect(await connect(a, resolved.routeId, { selector: bSelector() })).toBe(false)
    await eventually(() => expect(rowFor(b, a)?.state).toBe('ssh_granted'))
    const [grant] = grantsAt(b.endpoint, a.endpoint)
    // The grant goes without the request hearing of it.
    await b.engine.request('grant.remove', { grant: grant!.grant })
    await step('removed_grant_reported_live', () =>
      expect(repeat(a)).rejects.toMatchObject({ details: { reason: 'removed' } })
    )
  }, 120_000)

  it('never starts a daemon from net-engine ssh', async () => {
    const asked: Array<{ disableAutoStart?: boolean }> = []
    const stdin = new PassThrough()
    let out = ''
    const done = runNetEngineCommand(
      { subcommand: 'ssh', globals: { homeDir: '' } } as never,
      (async (options: { disableAutoStart?: boolean }) => {
        asked.push(options)
        throw new Error('no daemon')
      }) as never,
      { stdin, stdout: { write: (text: string) => (out += text) } }
    )
    stdin.end('{"op":"profiles"}\n')
    await done
    await step('daemon_started', () => expect(asked.map((options) => options.disableAutoStart)).toEqual([true]))
    expect(out).toContain('"remote_not_running"')
  })
})
