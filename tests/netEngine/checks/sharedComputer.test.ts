/**
 * Owner check `phase1a.shared-computer`, a cross-machine cell (`pc-to-mac-lan`, topology `four-endpoints`): two
 * profiles on each computer, each its own endpoint. PC profile A pairs with Mac profile C, PC profile B with Mac
 * profile D, and B opens a terminal on D. A removes C: A's connections to C close, while B's terminal on D answers
 * every line throughout and never detaches. Nobody crosses over: A cannot dial D, B cannot dial C, and neither Mac
 * profile grants the other's partner. D's helper then restarts and B's terminal comes back on its own.
 *
 * Its control, a helper built with `shared-endpoint-state` (one key and one grant table for every endpoint on the
 * computer), fails it with `other_profile_affected`.
 *
 * `scripts/net-engine-check.mjs phase1a.shared-computer --role host --topology four-endpoints` on the Mac,
 * `--role caller --topology four-endpoints` on the PC (with `MOUSSE_NET_ENGINE_CHECK_HOST` the Mac's address) run it
 * with the real helper. Without a role, both sides run here on one fabric.
 */
import { afterAll, describe, expect, it } from 'vitest'
import type { NodeId } from '../../../src/shared/net'
import { PROJECT_SHELL_AGENT_ID } from '../../../src/shared/types'
import {
  deviceState,
  eventually,
  Fabric,
  REAL_HELPER,
  recordedReason,
  refused,
  step,
  terminalOutput,
  type Computer
} from './harness'
import {
  dialLink,
  hostSide,
  keepHostBuilds,
  linkRole,
  localLink,
  serveLink,
  topology,
  type Link
} from './link'

const ROLE = linkRole()
const RUN_MS = 40 * 60_000
const TOPOLOGY = 'four-endpoints'

const fail = (reason: string, message: string) =>
  step(reason, () => {
    throw new Error(message)
  })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('phase1a.shared-computer', () => {
  const fabric = new Fabric()
  afterAll(() => fabric.close(), 120_000)

  /** The Mac's two profiles; a second that cannot start, or shares the first one's endpoint, is the failure. */
  async function hostComputers(): Promise<{ computers: Map<string, Computer>; failed?: string }> {
    const computers = new Map<string, Computer>()
    computers.set('mac-c', await step(undefined, () => fabric.computer('mac-c')))
    try {
      const d = await step('other_profile_affected', () => fabric.computer('mac-d'))
      computers.set('mac-d', d)
      if (d.endpoint === computers.get('mac-c')!.endpoint)
        await fail('other_profile_affected', 'both profiles on the host have one endpoint')
    } catch {
      return { computers, failed: recordedReason() }
    }
    return { computers }
  }

  it.runIf(ROLE === 'host')(
    'hosts profiles C and D',
    async () => {
      if (!REAL_HELPER) await fail('no_helper', 'a cross-machine cell runs with MOUSSE_NET_HELPER')
      const { computers, failed } = await hostComputers()
      const reason = await serveLink(hostSide(fabric, computers, true, failed))
      if (reason) await fail(reason, `the caller failed: ${reason}`)
    },
    RUN_MS
  )

  it.runIf(ROLE !== 'host')(
    "keeps each profile's pairings to itself",
    async () => {
      if (ROLE && !REAL_HELPER)
        await fail('no_helper', 'a cross-machine cell runs with MOUSSE_NET_HELPER')
      let link: Link
      if (ROLE === 'caller') link = await step(undefined, () => dialLink())
      else {
        const { computers, failed } = await hostComputers()
        link = localLink(hostSide(fabric, computers, false, failed))
      }
      try {
        await sharedComputer(link)
      } finally {
        await link.done(recordedReason())
      }
    },
    RUN_MS
  )

  /** `computer` joins the host's profile `name`; both rows read Connected. Answers the host profile's id here. */
  async function pairWith(link: Link, computer: Computer, name: string): Promise<NodeId> {
    const ticket = await step(undefined, () => link.ask('invite', { name }))
    const joined = await step('not_paired', () =>
      computer.dispatch('netEngine.join', { ticket }, true)
    )
    await step('one_way_stuck', () =>
      eventually(async () => {
        expect(deviceState(computer, joined.node)).toBe('connected')
        expect(await link.ask('state', { name, endpoint: computer.endpoint })).toBe('connected')
      }, 60_000)
    )
    return joined.node
  }

  async function sharedComputer(link: Link): Promise<void> {
    const hello = await step(undefined, () => link.ask('hello'))
    if (ROLE) keepHostBuilds(hello)
    if (hello.failed) await fail(hello.failed, `the host's profiles did not start: ${hello.failed}`)
    if (topology(TOPOLOGY) !== TOPOLOGY)
      await fail('bad_topology', `${topology(TOPOLOGY)} is not ${TOPOLOGY}`)
    const c = hello.endpoints['mac-c'] as string,
      d = hello.endpoints['mac-d'] as string
    const a = await step(undefined, () => fabric.computer('pc-a'))
    const b = await step('other_profile_affected', () => fabric.computer('pc-b'))
    await step('other_profile_affected', () =>
      expect(new Set([a.endpoint, b.endpoint, c, d]).size).toBe(4)
    )
    const cOnA = await pairWith(link, a, 'mac-c')
    const dOnB = await pairWith(link, b, 'mac-d')

    // B opens a terminal on D.
    await step(undefined, () => link.ask('allowTerminal', { name: 'mac-d', endpoint: b.endpoint }))
    await step(undefined, () => fabric.connect(b, dOnB))
    const path = await step(undefined, () => link.ask('folder'))
    const project = await step(undefined, () => b.dispatch('projects.open', { node: dOnB, path }))
    const created = await step(undefined, () =>
      b.dispatch('threads.create', {
        node: dOnB,
        name: 'Shared',
        projectId: (project.project ?? project).id
      })
    )
    const threadId = (created.thread ?? created).id as string
    await step(undefined, () => b.dispatch('thread.snapshot', { threadId }))
    const { ptyId } = await step(undefined, () =>
      b.dispatch('pty.create', { threadId, agentId: `${PROJECT_SHELL_AGENT_ID}:tab-1` })
    )
    const attached = () =>
      b.mms.bridge.router.terminals.state().some((term) => term.ptyId === ptyId && term.attached)
    await step(undefined, () => eventually(() => expect(attached()).toBe(true), 20_000))
    let tick = 0
    /** B writes a line to its terminal on D and D's shell answers it. */
    const answers = (reason: string | undefined) => {
      const line = `tick ${++tick}`
      return step(reason, async () => {
        await b.dispatch('pty.write', { threadId, ptyId, data: `${line}\r` })
        await eventually(
          () => expect(terminalOutput(b.events, ptyId)).toContain(`echo:${line}\r\n`),
          10_000
        )
      })
    }
    await answers(undefined)

    // A removes C while B's terminal on D answers a line every 200 ms and is watched for a detach.
    let detached = 0
    const watch = setInterval(() => {
      if (!attached()) detached += 1
    }, 20)
    let ticking = true
    const ticker = (async () => {
      while (ticking) {
        await answers('other_profile_affected')
        await sleep(200)
      }
    })().then(
      () => undefined,
      (error: unknown) => error
    )
    try {
      await step(undefined, () => a.dispatch('netEngine.remove', { node: cOnA }, true))
      await step('still_connected', () =>
        eventually(async () => {
          expect(a.mms.netEngine.online(cOnA)).toBe(false)
          expect(await link.ask('online', { name: 'mac-c', endpoint: a.endpoint })).toBe(false)
        }, 30_000)
      )
      await sleep(2_000)
    } finally {
      ticking = false
      clearInterval(watch)
    }
    const tickFailed = await ticker
    if (tickFailed) throw tickFailed
    await step('other_profile_affected', async () => {
      expect(detached).toBe(0)
      expect(deviceState(b, dOnB)).toBe('connected')
      expect(await link.ask('state', { name: 'mac-d', endpoint: b.endpoint })).toBe('connected')
    })

    // Nobody crosses over.
    await refused('other_profile_affected', () => a.engine.request('dial', { identity: d }, 15_000))
    await refused('other_profile_affected', () => b.engine.request('dial', { identity: c }, 15_000))
    await step('other_profile_affected', async () => {
      expect(await link.ask('grants', { name: 'mac-d' })).not.toContain(a.endpoint)
      expect(await link.ask('grants', { name: 'mac-c' })).not.toContain(b.endpoint)
      expect(await link.ask('grants', { name: 'mac-d' })).toContain(b.endpoint)
    })

    // D's helper restarts; B's terminal comes back on its own.
    await step(undefined, () => link.ask('restartHelper', { name: 'mac-d' }))
    await eventually(() => expect(b.mms.netEngine.online(dOnB)).toBe(false), 10_000).catch(
      () => undefined
    )
    // A real helper dials again by itself; the fake one only when asked.
    if (!REAL_HELPER) await step('not_reconnected', () => fabric.connect(b, dOnB))
    await step('not_reconnected', () =>
      eventually(() => {
        expect(b.mms.netEngine.online(dOnB)).toBe(true)
        expect(attached()).toBe(true)
      }, 60_000)
    )
    await answers('not_reconnected')
  }
})
