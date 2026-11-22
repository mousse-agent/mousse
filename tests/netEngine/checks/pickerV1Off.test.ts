/**
 * Owner check `phase1a.picker-v1-off`: fresh profiles with no `net.db` and v1 networking off. The owner sets
 * terminal access through `bridge.policy`; the caller lists the owner through the picker's daemon methods
 * (`bridge.nodes`), opens a folder there, starts a thread on it and opens a terminal, then does the same again with
 * the clock moved 8 and 40 days.
 *
 * The computers connect through helpers (the fake helper until the real one is wired in).
 *
 * Its controls (`MOUSSE_NET_ENGINE_CONTROL`): `roster-only-directory` fails it with `not_listed`, `no-renewal`
 * with `bad_delegation`. `scripts/net-engine-check.mjs phase1a.picker-v1-off` runs it and prints the marker.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PROJECT_SHELL_AGENT_ID } from '../../../src/shared/types'
import { DAY, eventually, pairProfiles, step, terminalOutput, type Pair } from './harness'

describe('phase1a.picker-v1-off', () => {
  let pair: Pair
  beforeAll(async () => {
    pair = await pairProfiles()
  }, 120_000)
  afterAll(() => pair?.close(), 60_000)

  /** The owner as the picker lists it, from `bridge.nodes`. */
  const listed = async () => {
    const view = await pair.dispatch('bridge.nodes', {}, true)
    return (view.nodes as Array<{ node: string; source?: string; state?: string; name?: string }>).find(
      (row) => row.node === pair.ownerOnCaller
    )
  }

  /** Opens a folder on the owner, starts a thread there and opens it, all through the picker's calls. */
  async function threadOnOwner(label: string): Promise<string> {
    const node = pair.ownerOnCaller
    const opened = await step(undefined, () => pair.dispatch('projects.open', { node, path: pair.folder() }))
    const projectId = (opened.project ?? opened).id as string
    expect(projectId).toBeTruthy()
    const created = await step(undefined, () =>
      pair.dispatch('threads.create', { node, name: `Thread ${label}`, projectId })
    )
    const thread = (created.thread ?? created) as { id: string }
    expect(thread.id).toBeTruthy()
    const snapshot = await step(undefined, () => pair.dispatch('thread.snapshot', { threadId: thread.id }))
    expect(snapshot).toBeTruthy()
    return thread.id
  }

  async function terminalOn(threadId: string, label: string): Promise<void> {
    const before = pair.shells.length
    const created = await step(undefined, () =>
      pair.dispatch('pty.create', { threadId, agentId: `${PROJECT_SHELL_AGENT_ID}:tab-${label}` })
    )
    const shell = pair.shells[before]!
    await step(undefined, () => pair.dispatch('pty.write', { threadId, ptyId: created.ptyId, data: `echo ${label}\r` }))
    expect(shell.pty.written.join('')).toContain(`echo ${label}`)
    shell.pty.say(`output ${label}\r\n`)
    await step('no_output', () =>
      eventually(() => expect(terminalOutput(pair.events, created.ptyId)).toContain(`output ${label}`), 20_000)
    )
  }

  it('starts with no network database and v1 off', () => {
    expect(pair.hadNetDb).toEqual({ owner: false, caller: false })
    for (const mms of [pair.owner, pair.caller]) {
      expect(mms.net.status().enabled).toBe(false)
      expect(mms.net.featureEnabled('netBridge')).toBe(false)
    }
  })

  it('lists the owner in the picker', async () => {
    const row = await step('not_listed', async () => {
      const found = await listed()
      expect(found).toMatchObject({ source: 'engine', state: 'open', name: 'owner computer' })
      return found
    })
    expect(row).toBeTruthy()
  })

  it('sets terminal access through bridge.policy', async () => {
    const set = await step(undefined, () => pair.ownerLocal('bridge.policy', { node: pair.callerOnOwner, terminal: true }))
    expect(set.policy.terminal).toBe(true)
  })

  it('starts a thread and a terminal on the owner', async () => {
    const threadId = await threadOnOwner('now')
    await terminalOn(threadId, 'now')
  }, 60_000)

  for (const days of [8, 40])
    it(`does the same with the clock moved ${days} days`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(Date.now() + days * DAY)
        await step('not_listed', async () => expect(await listed()).toBeTruthy())
        const threadId = await threadOnOwner(`day${days}`)
        await terminalOn(threadId, `day${days}`)
      } finally {
        vi.useRealTimers()
      }
    }, 60_000)
})
