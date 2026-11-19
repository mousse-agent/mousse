/**
 * Owner check `phase1b.link-app`: pairing through a Send link (design 1b §5), through each computer's daemon
 * methods. A link reaches the joiner the way the OS hands one over (the launch argv, a second instance's argv), the
 * consent approves the link's destinations and keeps them on the row, the code shown on the host is typed, and both
 * rows read Connected. Three wrong codes end the link on both sides and it cannot be opened again; an app restart
 * mid-code keeps the count; every change §5.5 lists is refused without a grant on either side; a crash is recovered
 * from the ticket's own outcome (`join.status`) only, never from a pin held before; "already paired" grants nothing
 * back; a computer added over SSH converts its row only on the ticket's `PAIRED`.
 *
 * Controls: the app's (`MOUSSE_NET_ENGINE_CONTROL`) and the helper's (`RUSTFLAGS='--cfg mousse_control="..."'`,
 * which the fake helper's defects mirror) each fail with the reason `checks/phase1b.toml` names.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { attachPairLinks, PAIR_LINK_IPC } from '../../../src/main/pairLink'
import type { NodeId } from '../../../src/shared/net'
import type { EnginePeerStore } from '../../../src/mms/netEngine/store'
import { decodeTicket, encodeTicket } from '../ticketCbor'
import {
  codeOf,
  connectedBothWays,
  eventually,
  Fabric,
  REAL_HELPER,
  rowFor,
  step,
  type Computer
} from './harness'

const TAILNET = 'tcp://100.101.7.2:7443'
const LAN = 'tcp://192.168.1.20:7443'
const JOINER_LAN = 'tcp://192.168.1.30:7443'
const JOINER_TAILNET = 'tcp://100.101.7.3:7443'

interface Link {
  invitation: string
  uri: string
  code: string
  attemptsLeft: number
}

/** The host's window shows a Send link. */
const sendLink = (host: Computer): Promise<Link> =>
  host.dispatch('netEngine.invite', { kind: 'link' }, true)

/** What the host's window shows for its link now: the code, the tries left, how it ended. */
const shown = (host: Computer, invitation: string) =>
  host.mms.netEngine.status().links?.find((link) => link.invitation === invitation)

/** The joiner's running join of `invitation`, as its window reads it. */
const running = (joiner: Computer, invitation: string) =>
  joiner.mms.netEngine.status().joins?.find((join) => join.invitation === invitation)

/** The joiner's window connects to `link`; settles with the row's id or the error, never rejects. */
function connect(
  joiner: Computer,
  link: string,
  fields: { share?: string[] } = {}
): Promise<{ node?: NodeId; error?: unknown }> {
  return joiner.dispatch('netEngine.join', { ticket: link, arrival: 'link', ...fields }, true).then(
    (answer: { node: NodeId }) => ({ node: answer.node }),
    (error: unknown) => ({ error })
  )
}

/** Waits until the joiner's helper asks for the code (with `attemptsLeft`, when given). */
async function codeNeeded(joiner: Computer, invitation: string, attemptsLeft?: number) {
  await eventually(() => {
    const join = running(joiner, invitation)
    if (!join?.needsCode) throw new Error('no code asked yet')
    if (attemptsLeft !== undefined && join.attemptsLeft !== attemptsLeft)
      throw new Error(`tries left ${join.attemptsLeft}`)
  })
  return running(joiner, invitation)!
}

const typeCode = (joiner: Computer, invitation: string, code: string) =>
  joiner.dispatch('netEngine.join.code', { invitation, code }, true)

/** A code that is not `code`. */
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0')

/** Whether `on`'s helper lets `other` in. */
async function grants(on: Computer, other: Computer): Promise<number> {
  const answer = await on.engine.request('grants.list')
  return (answer.grants as Array<{ identity: string }>).filter(
    (grant) => grant.identity === other.endpoint
  ).length
}

/** The reason a refused join gave (`details.reason`, else its code). */
const reasonOf = (error: unknown) => codeOf(error)

/** A computer's pairing rows (a test writes the rows an SSH add would). */
const peers = (computer: Computer): EnginePeerStore =>
  (computer.mms.netEngine as unknown as { started: { peers: EnginePeerStore } }).started.peers

describe('phase1b.link-app', () => {
  const fabric = new Fabric()
  afterAll(() => fabric.close(), 120_000)

  it('pairs through a chat link opened from the launch argv, by typing the code, Connected both ways', async () => {
    // The host listens on a LAN and a tailnet address (a helper says its routes at hello).
    if (!REAL_HELPER) fabric.network.routes.set(fakeIdentity('link-host'), [LAN, TAILNET])
    const host = await fabric.computer('link-host')
    // The joiner listens on a LAN and a tailnet address too; it shares none it was not asked to.
    if (!REAL_HELPER)
      fabric.network.routes.set(fakeIdentity('link-joiner'), [JOINER_LAN, JOINER_TAILNET])
    const joiner = await fabric.computer('link-joiner')
    const link = await sendLink(host)
    await step('no_link', () => {
      expect(link.uri).toMatch(/^mousse:\/\/pair#[A-Za-z0-9_-]+$/)
      // The code is never in the link.
      expect(link.uri).not.toContain(link.code)
    })

    // The packaged handler as a check starts it: the link comes in argv, and the scheme is not registered.
    const registered: string[] = []
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const pairLinks = attachPairLinks({
      app: {
        isPackaged: true,
        setAsDefaultProtocolClient: (scheme) => (registered.push(scheme), true),
        on: () => undefined
      },
      ipc: {
        removeHandler: (channel) => void handlers.delete(channel),
        handle: (channel, listener) => void handlers.set(channel, listener)
      },
      argv: ['Mousse.exe', '--flag', link.uri],
      env: { ...process.env, MOUSSE_CHECK: process.env.MOUSSE_CHECK || '1' },
      notify: () => undefined
    })
    await step('scheme_registered', () => expect(registered).toEqual([]))
    const opened = await step('no_activation', () => {
      const taken = handlers.get(PAIR_LINK_IPC.take)?.()
      expect(taken).toBe(link.uri)
      // A second Mousse started with the link hands it to this one.
      expect(pairLinks.fromArgv(['Mousse.exe', link.uri])).toBe(true)
      return taken as string
    })

    // What Connect shows and approves: the link's destinations; those outside the LAN need the approval.
    const facts = await step('damaged', () =>
      joiner.dispatch('netEngine.join.preview', { ticket: opened }, true)
    )
    const approved = (facts.destinations as Array<{ route: string; automatic: boolean }>)
      .filter((destination) => !destination.automatic)
      .map((destination) => destination.route)
    if (!REAL_HELPER) await step('approval_lost', () => expect(approved).toEqual([TAILNET]))

    const joined = connect(joiner, opened)
    let askedCode = false
    const watch = setInterval(() => {
      if (running(joiner, link.invitation)?.needsCode) askedCode = true
    }, 5)
    try {
      await step('paired_without_code', async () => {
        await Promise.race([
          codeNeeded(joiner, link.invitation, 3),
          joined.then(() => {
            if (!askedCode) throw new Error('joined without the code')
          })
        ])
      })
      // The consent journal keeps what was approved for a repeated join.
      // (Loopback hints of a debug build are approved too, whatever class they show as.)
      await step('approval_lost', () =>
        expect(rowFor(joiner, host)?.link?.approved).toEqual(expect.arrayContaining(approved))
      )
      await typeCode(joiner, link.invitation, shown(host, link.invitation)!.code)
      const result = await joined
      await step('pairing_failed', () => expect(result.error).toBeUndefined())
    } finally {
      clearInterval(watch)
    }
    if (!REAL_HELPER)
      await step('approval_lost', () =>
        expect(
          fabric.network.approvedSent.filter((sent) => sent.joiner === joiner.endpoint).at(-1)
            ?.approved
        ).toEqual([TAILNET])
      )
    await step('one_way_stuck', () => connectedBothWays(host, joiner))
    await step('one_way_stuck', async () => {
      expect(await grants(host, joiner)).toBe(1)
      expect(await grants(joiner, host)).toBe(1)
    })
    // Pairback carried the joiner's LAN address only: its tailnet one was not ticked under "Also share".
    if (!REAL_HELPER)
      await step('route_leak', () => {
        const sent = fabric.crossed
          .filter((message) => message.from === joiner.endpoint && message.header.t === 'pairback')
          .map((message) => message.header.routes)
        expect(sent).toEqual([[JOINER_LAN]])
      })
    // No approval named the joiner: the host's row takes the name its hello says.
    await step('unnamed', () =>
      eventually(() => expect(rowFor(host, joiner)?.name).toContain('link-joiner computer'))
    )
  }, 180_000)

  it.skipIf(REAL_HELPER)(
    'a swapped link gets the swapped-link text and never ends "already paired"',
    async () => {
      const host = await fabric.computer('swap-host'),
        stranger = await fabric.computer('swap-stranger'),
        joiner = await fabric.computer('swap-joiner')
      const real = await sendLink(host)
      // The link in the chat was swapped for one naming another key; the code is read out from the real host.
      const swapped = await sendLink(stranger)
      const joined = connect(joiner, swapped.uri)
      const outcome = await Promise.race([
        joined,
        codeNeeded(joiner, swapped.invitation).then(() => ({ asked: true }))
      ])
      await step('swapped_link_trusted', () => expect('asked' in outcome).toBe(true))
      await typeCode(
        joiner,
        swapped.invitation,
        real.code === swapped.code ? wrong(real.code) : real.code
      )
      await step('swapped_link_trusted', () =>
        eventually(() => expect(running(joiner, swapped.invitation)?.wrong).toBe(true))
      )
      await joiner.dispatch('netEngine.remove', { node: rowFor(joiner, stranger)!.localId }, true)
      await step('swapped_link_trusted', async () => {
        const end = await joined
        expect(reasonOf(end.error)).not.toBe('link_not_used')
        expect(await grants(stranger, joiner)).toBe(0)
      })
    },
    120_000
  )
  it('ends the link on both sides after three wrong codes, and it cannot be opened again', async () => {
    const host = await fabric.computer('wrong-host'),
      joiner = await fabric.computer('wrong-joiner')
    const link = await sendLink(host)
    const joined = connect(joiner, link.uri)
    for (const left of [3, 2, 1]) {
      await step('no_code_asked', () => codeNeeded(joiner, link.invitation, left))
      const code = shown(host, link.invitation)!.code
      await typeCode(joiner, link.invitation, wrong(code))
      if (left > 1)
        await step('attempts_not_counted', () =>
          eventually(() => {
            const join = running(joiner, link.invitation)
            expect(join?.wrong).toBe(true)
            expect(join?.attemptsLeft).toBe(left - 1)
            const now = shown(host, link.invitation)!
            expect(now.attemptsLeft).toBe(left - 1)
            // The host shows a new code after each wrong one.
            expect(now.code).not.toBe(code)
          })
        )
    }
    const result = await joined
    await step('attempts_exhausted_missing', () => {
      expect(reasonOf(result.error)).toBe('attempts_exhausted')
      expect((result.error as Error).message).toBe('No tries left. Ask for a new link.')
    })
    await step('attempts_exhausted_missing', () =>
      eventually(() => expect(shown(host, link.invitation)?.ended).toBe('attempts_exhausted'))
    )
    await step('row_left', () => expect(rowFor(joiner, host)).toBeUndefined())

    // Opening the same link again: this side ends from its flow record, the host because the invitation is gone.
    const again = await connect(joiner, link.uri)
    await step('exhausted_link_reopened', () =>
      expect(reasonOf(again.error)).toBe('attempts_exhausted')
    )
    const other = await fabric.computer('wrong-other')
    const reopened = connect(other, link.uri)
    const outcome = await Promise.race([
      reopened,
      codeNeeded(other, link.invitation).then(() => ({ asked: true }))
    ])
    await step('exhausted_link_reopened', () => {
      expect('asked' in outcome).toBe(false)
      expect(reasonOf((outcome as { error?: unknown }).error)).toBe('invitation_invalid')
    })
    await step('grant_without_code', async () => {
      expect(await grants(host, joiner)).toBe(0)
      expect(await grants(joiner, host)).toBe(0)
    })
  }, 180_000)

  it('keeps the count on both sides when the joining app restarts mid-code', async () => {
    const host = await fabric.computer('restart-host'),
      joiner = await fabric.computer('restart-joiner')
    const link = await sendLink(host)
    const first = connect(joiner, link.uri)
    await codeNeeded(joiner, link.invitation, 3)
    await typeCode(joiner, link.invitation, wrong(shown(host, link.invitation)!.code))
    await step('attempts_not_counted', () =>
      eventually(() => expect(running(joiner, link.invitation)?.attemptsLeft).toBe(2))
    )
    await fabric.restartEngine(joiner)
    await first
    // No outcome to recover: the row says the pairing did not finish, with Retry while the link is valid.
    const node = await step('unfinished_missing', async () => {
      let found: NodeId | undefined
      await eventually(() => {
        const device = joiner.mms.netEngine
          .status()
          .devices.find((item) => item.node === rowFor(joiner, host)?.localId)
        expect(device?.unfinished).toBe(true)
        expect(device?.linkValid).toBe(true)
        found = device!.node
      })
      return found!
    })
    const retried = joiner.dispatch('netEngine.retry', { node }, true).then(
      () => ({}),
      (error: unknown) => ({ error })
    )
    await step('attempts_reset', () => codeNeeded(joiner, link.invitation, 2))
    await step('attempts_reset', () => expect(shown(host, link.invitation)?.attemptsLeft).toBe(2))
    // One more wrong code leaves one try on each side: neither started counting again.
    await typeCode(joiner, link.invitation, wrong(shown(host, link.invitation)!.code))
    await step('attempts_reset', () =>
      eventually(() => {
        expect(running(joiner, link.invitation)?.attemptsLeft).toBe(1)
        expect(shown(host, link.invitation)?.attemptsLeft).toBe(1)
      })
    )
    await codeNeeded(joiner, link.invitation, 1)
    await typeCode(joiner, link.invitation, shown(host, link.invitation)!.code)
    await step('pairing_failed', async () =>
      expect(((await retried) as { error?: unknown }).error).toBeUndefined()
    )
    await step('one_way_stuck', () => connectedBothWays(host, joiner))
  }, 180_000)

  it('refuses every changed link, with no grant on either side', async () => {
    if (!REAL_HELPER) fabric.network.routes.set(fakeIdentity('tamper-host'), [LAN])
    const host = await fabric.computer('tamper-host'),
      joiner = await fabric.computer('tamper-joiner')
    const fragment = (uri: string) => uri.slice(uri.indexOf('#') + 1)
    const changed = (uri: string, change: (fields: ReturnType<typeof decodeTicket>) => void) => {
      const fields = decodeTicket(fragment(uri))
      change(fields)
      return `mousse://pair#${encodeTicket(fields)}`
    }
    const flip = (hex: string) => (hex[0] === 'a' ? 'b' : 'a') + hex.slice(1)
    const now = () => Math.floor(Date.now() / 1000)
    const cases: Array<{
      name: string
      make: (uri: string) => string
      /** What the join answers. */
      reason: string[]
      /** Whether the host spends one of its tries (the ticket hash differs, so CPace fails). */
      spends: boolean
      /** Whether this computer refuses it before the helper sees it. */
      local?: boolean
    }> = [
      {
        name: 'bad base64',
        make: (uri) => `${uri}!`,
        reason: ['bad_ticket'],
        spends: false,
        local: true
      },
      {
        name: 'bad CBOR',
        make: () => `mousse://pair#${Buffer.from([0xa7, 0x01]).toString('base64url')}`,
        reason: ['bad_ticket'],
        spends: false,
        local: true
      },
      {
        name: 'kind 2 to 1',
        make: (uri) => changed(uri, (f) => (f.kind = 1)),
        reason: ['pairing_failed', 'bad_ticket'],
        spends: false
      },
      {
        name: 'secret',
        make: (uri) => changed(uri, (f) => (f.secret = flip(f.secret))),
        reason: ['invitation_invalid'],
        spends: false
      },
      {
        name: 'invitation id',
        make: (uri) => changed(uri, (f) => (f.invitation = flip(f.invitation))),
        reason: ['invitation_invalid'],
        spends: false
      },
      {
        name: 'host key',
        make: (uri) => changed(uri, (f) => (f.host = flip(f.host))),
        reason: ['bad_ticket', 'no_route', 'unreachable', 'pairing_failed', 'invitation_invalid'],
        spends: false
      },
      {
        name: 'route hint',
        make: (uri) => changed(uri, (f) => (f.routes = [...f.routes, 'tcp://192.168.1.99:7000'])),
        reason: ['pairing_failed'],
        spends: true
      },
      {
        name: 'expires_at later',
        make: (uri) => changed(uri, (f) => (f.expiresAt = f.expiresAt + 60)),
        reason: ['pairing_failed'],
        spends: true
      },
      {
        name: 'expires_at past',
        make: (uri) => changed(uri, (f) => (f.expiresAt = now() - 60)),
        reason: ['expired'],
        spends: false,
        local: true
      }
    ]
    for (const tamper of cases) {
      const link = await sendLink(host)
      const helperJoins = fabric.network.approvedSent.length
      const joined = connect(joiner, tamper.make(link.uri))
      if (tamper.spends) {
        // The code is asked; even the right one fails, because the changed ticket breaks key confirmation.
        await step('tamper_accepted', () => codeNeeded(joiner, link.invitation))
        await typeCode(joiner, link.invitation, shown(host, link.invitation)!.code)
        const outcome = await Promise.race([
          joined,
          eventually(() => expect(running(joiner, link.invitation)?.wrong).toBe(true)).then(() => ({
            wrong: true
          }))
        ])
        await step('tamper_accepted', () =>
          expect((outcome as { node?: NodeId }).node, tamper.name).toBeUndefined()
        )
        // Give up on the changed link: Remove ends its join.
        const row = rowFor(joiner, host)
        if (row) await joiner.dispatch('netEngine.remove', { node: row.localId }, true)
      }
      // Refused outright: neither paired nor waiting for a code (or for anything else).
      const result = tamper.spends
        ? await joined
        : await step('tamper_accepted', () =>
            Promise.race([
              joined,
              codeNeeded(joiner, link.invitation).then(() => ({
                node: 'asked for a code' as NodeId
              }))
            ])
          )
      await step('tamper_accepted', () => {
        expect(result.node, tamper.name).toBeUndefined()
        if (!tamper.spends)
          expect(tamper.reason, `${tamper.name}: ${reasonOf(result.error)}`).toContain(
            reasonOf(result.error)
          )
      })
      // Refused before dialling: the helper never saw a join.
      if (tamper.local && !REAL_HELPER)
        await step('tamper_accepted', () =>
          expect(fabric.network.approvedSent.length, tamper.name).toBe(helperJoins)
        )
      await step('tamper_accepted', () =>
        eventually(() =>
          expect(shown(host, link.invitation)?.attemptsLeft, tamper.name).toBe(
            tamper.spends ? 2 : 3
          )
        )
      )
      // The real link is untouched by the changed one (unless a try was spent on it, as the design says).
      await step('tamper_accepted', () => expect(rowFor(joiner, host), tamper.name).toBeUndefined())
      await host.dispatch('netEngine.invite.cancel', { invitation: link.invitation }, true)
    }
    await step('tamper_accepted', async () => {
      expect(await grants(host, joiner)).toBe(0)
      expect(await grants(joiner, host)).toBe(0)
    })
  }, 240_000)

  it.skipIf(REAL_HELPER)(
    'promotes nothing from a pin held before: a crash after Connect ends "Pairing didn\'t finish"',
    async () => {
      const host = await fabric.computer('pin-host'),
        joiner = await fabric.computer('pin-joiner')
      // The joiner pins the host already (as a one-way add leaves it), with no grant either way.
      fabric.network.peer(joiner.endpoint, host.endpoint)
      const link = await sendLink(host)
      let hit = false
      joiner.mms.netEngine.pairingCrash = (at) => at === 'consented' && !hit && (hit = true)
      await connect(joiner, link.uri)
      await step(undefined, () => expect(hit).toBe(true))
      joiner.mms.netEngine.pairingCrash = undefined
      await fabric.restartEngine(joiner)
      await step('promoted_without_completion', async () => {
        await eventually(() => {
          const row = rowFor(joiner, host)
          const device = joiner.mms.netEngine
            .status()
            .devices.find((item) => item.node === row?.localId)
          expect(device?.unfinished).toBe(true)
        })
        // Settled: nothing moves on later either.
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(rowFor(joiner, host)?.state).toBe('consented')
        expect(await grants(joiner, host)).toBe(0)
        expect(await grants(host, joiner)).toBe(0)
      })
    },
    120_000
  )

  it.skipIf(REAL_HELPER)(
    'recovers a crash after PAIRED from the ticket outcome: done, and an outcome lost with the approvals kept',
    async () => {
      // The answer arrived and the app stopped before writing `joined`.
      const host = await fabric.computer('done-host'),
        joiner = await fabric.computer('done-joiner')
      let link = await sendLink(host)
      let hit = false
      joiner.mms.netEngine.pairingCrash = (at) => at === 'join-replied' && !hit && (hit = true)
      let joined = connect(joiner, link.uri)
      await codeNeeded(joiner, link.invitation)
      await typeCode(joiner, link.invitation, shown(host, link.invitation)!.code)
      await joined
      await step(undefined, () => expect(hit).toBe(true))
      joiner.mms.netEngine.pairingCrash = undefined
      await fabric.restartEngine(joiner)
      await step('no_route_after_recovery', () => connectedBothWays(host, joiner))

      // The confirmation was sent and the helper stopped before it answered: the join is repeated with the
      // approved list the consent stored.
      fabric.network.routes.set(fakeIdentity('lost-host'), [LAN, TAILNET])
      const host2 = await fabric.computer('lost-host')
      const joiner2 = await fabric.computer('lost-joiner')
      link = await sendLink(host2)
      joiner2.fake!.losePaired = true
      joined = connect(joiner2, link.uri)
      await codeNeeded(joiner2, link.invitation)
      const sentBefore = fabric.network.approvedSent.length
      await typeCode(joiner2, link.invitation, shown(host2, link.invitation)!.code).catch(
        () => undefined
      )
      await joined
      await step('pending_after_done', () => connectedBothWays(host2, joiner2))
      await step('approval_lost', () => {
        const repeated = fabric.network.approvedSent
          .slice(sentBefore)
          .filter((sent) => sent.joiner === joiner2.endpoint)
        expect(repeated.length).toBeGreaterThan(0)
        for (const sent of repeated) expect(sent.approved).toEqual([TAILNET])
      })
    },
    180_000
  )

  it.skipIf(REAL_HELPER)(
    'a damaged link after a one-way SSH add changes no grant on either side',
    async () => {
      // A uses B (B grants A; A pins B); both rows came from the SSH add.
      const a = await fabric.computer('ssh-a'),
        b = await fabric.computer('ssh-b')
      const { grant } = fabric.network.grant(b.endpoint, a.endpoint)
      sshRow(a, b, '')
      sshRow(b, a, String(grant))
      // B sends a link; A opens a damaged copy of it, and meets B's live grant ("already paired").
      const link = await sendLink(b)
      const fields = decodeTicket(link.uri.slice(link.uri.indexOf('#') + 1))
      fields.secret = (fields.secret[0] === 'a' ? 'b' : 'a') + fields.secret.slice(1)
      const result = await connect(a, `mousse://pair#${encodeTicket(fields)}`)
      await step('grant_without_code', () => {
        expect(reasonOf(result.error)).toBe('link_not_used')
        expect((result.error as Error).message).toBe("This link didn't work. Ask for a new one.")
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      await step('grant_without_code', async () => {
        expect(fabric.network.grantsAt(b.endpoint)).toEqual([{ caller: a.endpoint, grant }])
        expect(fabric.network.grantsAt(a.endpoint)).toEqual([])
        expect(rowFor(a, b)?.source).toBe('ssh')
        expect(rowFor(a, b)?.link).toBeUndefined()
        expect(rowFor(b, a)?.source).toBe('ssh')
      })
    },
    120_000
  )

  it.skipIf(REAL_HELPER)(
    "a Send link between computers added over SSH converts both rows only on the ticket's PAIRED",
    async () => {
      const a = await fabric.computer('convert-a'),
        b = await fabric.computer('convert-b')
      const { grant } = fabric.network.grant(b.endpoint, a.endpoint)
      sshRow(a, b, '')
      sshRow(b, a, String(grant))
      // A sends the link (B has no grant at A): B joins with the code.
      const link = await sendLink(a)
      const joined = connect(b, link.uri)
      await codeNeeded(b, link.invitation)
      await step('converted_early', () => {
        const row = rowFor(b, a)!
        expect(row.source).toBe('ssh')
        expect(row.link?.pending).toBe(true)
        expect(rowFor(a, b)?.source).toBe('ssh')
      })
      await typeCode(b, link.invitation, shown(a, link.invitation)!.code)
      await step('pairing_failed', async () => expect((await joined).error).toBeUndefined())
      await step('one_way_stuck', () => connectedBothWays(a, b))
      await step('one_way_stuck', () => {
        expect(rowFor(a, b)?.source).toBeUndefined()
        expect(rowFor(b, a)?.source).toBeUndefined()
      })
    },
    120_000
  )
})

/** The identity the fake helper of the computer `name` has. */
const fakeIdentity = (name: string): string => Buffer.from(`endpoint-${name}`).toString('hex')

/** The row an SSH add writes (design 1b §3.4): `on`'s row for `other`, `source: "ssh"`. */
function sshRow(on: Computer, other: Computer, grant: string): void {
  peers(on).add({
    endpoint: other.endpoint,
    fingerprint: `sha256:${other.endpoint}`,
    grant,
    name: other.name,
    state: 'connected',
    source: 'ssh',
    pairedAt: Date.now()
  })
}
