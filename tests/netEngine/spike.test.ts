/**
 * S0: Bridge between two computers over an engine session, with v1 networking off on both. Two real profiles in
 * one process, linked by an in-memory engine link (`fakeLink`); everything above the link is production code: the
 * caller's window calls go through `ThreadRouter` → `RoutedClient` → the peer directory's client, and the owner
 * serves them through its real `rt.rpc`, `OwnerRoutes`, `ThreadStreamAdapter` and the Hub.
 *
 * What it covers, as rows (design §8, "S0 covers"):
 * - a profile with no `net.db` turns the engine on: `net.status` stays off and no transport starts;
 * - the pairing is listed by `bridge.nodes`, and `bridge.policy` sets its terminal access;
 * - one routed call;
 * - a thread and a terminal (`net.info`, `routed.stream.open`), each attached through the Hub;
 * - live records, Hub replay from disk and a snapshot install after the link comes back;
 * - a paged read, a durable artifact reply and a staged write, each by its own path;
 * - the clock moved 8 and 40 days, with a terminal held open through each renewal;
 * - a second reader is refused, on the owner and by the caller's binding;
 * - lists and Git progress attached through the Hub;
 * - a v1 profile that joined another computer's network: refused with v1 off, working with v1 on;
 * - the node-id, reader and stream fields that cross the link, pinned, with no private key and no reader id.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { NON_KEEPER_MESSAGE } from '../../src/mms/netEngine/NetEngineService'
import { Channel } from '../../src/mms/netEngine/session/transport'
import type { DomainConnectionContext } from '../../src/mms/protocol/domainRegistry'
import { dispatchMethod } from '../../src/mms/protocol/handlers'
import { routedNetMethod } from '../../src/shared/bridge/routed'
import { newId, type NodeId, type RpcId, type StoredRecord, type StreamDescriptor } from '../../src/shared/net'
import { NetError } from '../../src/shared/net/errors'
import { NET_LOCAL_CAPABILITY } from '../../src/shared/net/local'
import { PROJECT_SHELL_AGENT_ID } from '../../src/shared/types'
import { qualifyId } from '../../src/shared/threadRef'
import { fakeShells, type Spawned } from '../net/bridge/routed/terminalFixture'
import { cleanupAll as cleanupV1, linked } from '../net/bridge/routed/routerFixture'
import { fakeLink, type CrossedMessage } from './fakeLink'
import { mousseVersion } from '../../src/mms/appVersion'
import { remoteUpdatesFor } from '../../src/mms/updates/remoteUpdates'
import { accessPreset } from '../../src/shared/net/accessPresets'
import { NO_DESKTOP_APP_REASON, selfUpdateReportPath } from '../../src/mms/updates/selfUpdateReport'
import { channelForVersion } from '../../src/shared/updates'
import { bridgeProtocolEvent } from '../../src/main/mms/protocolEventBridge'

const DAY = 24 * 60 * 60_000
const eventually = (check: () => unknown, timeout = 15_000) => vi.waitFor(check, { timeout })

const cleanups: Array<() => void | Promise<void>> = []
afterAll(async () => {
  vi.useRealTimers()
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function profile(): Promise<{ mms: MousseMainService; home: string }> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'engine-spike-')))
  const mms = await MousseMainService.create({ homeDir: home, repoRoot: home, headless: true, requireOwnership: false })
  cleanups.push(
    () => {
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
      } catch {
        // A database file the system still holds is left to the temp folder.
      }
    },
    () => mms.stop()
  )
  return { mms, home }
}

interface ProtocolEvent {
  type: string
  data: any
  threadId?: string
}

describe('Bridge over an engine session, v1 off', () => {
  let owner: MousseMainService, caller: MousseMainService
  let ownerOnCaller: NodeId, callerOnOwner: NodeId, secondOnCaller: NodeId
  const grant = 'grant-held-by-caller'
  const crossed: CrossedMessage[] = []
  let link: ReturnType<typeof fakeLink>
  const events: ProtocolEvent[] = []
  const before = { ownerDb: true, callerDb: true }
  let shells: Spawned[]
  let listedId: string
  let ownerHome: string

  async function connect(): Promise<void> {
    link = fakeLink({ ownerOnCaller, callerOnOwner, grant, endpoint: 'caller.test:7000', crossed })
    await owner.netEngine.attach(link.inbound)
    await caller.netEngine.attach(link.outbound)
  }

  const window = (id = 'window-1', local = false): DomainConnectionContext => ({
    id,
    clientType: 'gui',
    capabilities: new Set(local ? [NET_LOCAL_CAPABILITY] : []),
    binding: { profileId: caller.profileId, epoch: 1 }
  })
  const dispatch = (method: string, params: unknown, connection = window()): Promise<any> =>
    dispatchMethod({ mms: caller, connection, globalSequence: () => caller.protocolSequence() }, method, params)
  const ownerLocal = (method: string, params: unknown): Promise<any> =>
    dispatchMethod(
      {
        mms: owner,
        globalSequence: () => 0,
        connection: {
          id: 'owner-window',
          clientType: 'gui',
          capabilities: new Set([NET_LOCAL_CAPABILITY]),
          binding: { profileId: owner.profileId, epoch: 1 }
        }
      },
      method,
      params
    )
  const refused = async (run: Promise<unknown>): Promise<any> => {
    try {
      await run
    } catch (error) {
      return error
    }
    throw new Error('The call was not refused.')
  }
  const q = (threadId: string) => qualifyId(ownerOnCaller, threadId)
  /** What crossed after `from`, as `label t method?` lines. */
  const kinds = (from = 0) =>
    crossed
      .slice(from)
      .map((m) => `${m.from} ${m.label} ${m.header.t}${typeof m.header.method === 'string' ? ` ${m.header.method}` : ''}`)

  function folderThread(name = 'Terminal thread') {
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'engine-spike-folder-')))
    cleanups.push(() => rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' })
    git('init', '-q')
    git('config', 'user.email', 'owner@example.test')
    git('config', 'user.name', 'Owner')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(path, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'first')
    const project = owner.projects.openProject(path)
    return owner.threads.createThread(name, project.id, path, {})
  }
  const message = (id: string, content: string) => ({
    id,
    role: 'assistant',
    content,
    timestamp: new Date().toISOString()
  })
  /** A message the owner stores and announces, as a turn does. */
  const say = (threadId: string, row: ReturnType<typeof message>) => {
    owner.orchestrator.getOrCreateSession(threadId).messages.push(row as never)
    owner.orchestrator.emit('thread-message', { threadId, message: row })
  }
  const snapshotIds = async (threadId: string): Promise<string[]> =>
    (await dispatch('thread.snapshot', { threadId: q(threadId) })).messages.map((row: { id: string }) => row.id)

  beforeAll(async () => {
    const o = await profile(),
      c = await profile()
    owner = o.mms
    caller = c.mms
    ownerHome = o.home
    before.ownerDb = existsSync(join(o.home, 'net', 'net.db'))
    before.callerDb = existsSync(join(c.home, 'net', 'net.db'))
    await owner.netEngine.enable()
    await caller.netEngine.enable()
    callerOnOwner = owner.netEngine.pair({
      endpoint: 'caller.test:7000',
      fingerprint: 'sha256:caller',
      grant,
      name: 'Caller computer',
      state: 'connected'
    }).localId
    ownerOnCaller = caller.netEngine.pair({
      endpoint: 'owner.test:7000',
      fingerprint: 'sha256:owner',
      grant: 'grant-held-by-owner',
      name: 'Owner computer',
      state: 'connected'
    }).localId
    secondOnCaller = caller.netEngine.pair({
      endpoint: 'second.test:7000',
      fingerprint: 'sha256:second',
      grant: 'grant-held-by-second',
      name: 'Second computer',
      state: 'connected'
    }).localId

    let sequence = 0
    caller.protocolSequence = () => sequence
    caller.events.on('protocol:event', ((event: ProtocolEvent) => {
      sequence += 1
      events.push(event)
    }) as (data: unknown) => void)
    shells = fakeShells(owner.ptyManager, cleanups)
    listedId = owner.threads.createThread('Listed').id
    await connect()
  }, 120_000)

  it('turns on in a profile with no network: net.status stays off and no transport starts', () => {
    expect(before).toEqual({ ownerDb: false, callerDb: false })
    for (const mms of [owner, caller]) {
      expect(mms.netEngine.on()).toBe(true)
      const status = mms.net.status()
      expect(status.enabled).toBe(false)
      expect(status.routes).toEqual([])
      expect(status.transports ?? []).toEqual([])
      expect(mms.net.featureEnabled('netBridge')).toBe(false)
    }
  })

  it('lists the pairing in bridge.nodes, with the version and update report the owner gave when it connected', async () => {
    const row = async () =>
      (await dispatch('bridge.nodes', {}, window('settings', true))).nodes.find(
        (node: { node: string }) => node.node === ownerOnCaller
      )
    expect(await row()).toMatchObject({ name: 'Owner computer', source: 'engine', state: 'open' })
    await eventually(async () => expect((await row()).version).toBe(mousseVersion()))
    expect(await row()).toMatchObject({
      platform: process.platform,
      arch: process.arch,
      // No desktop app runs in this home: the owner says it can't update itself, and why.
      update: { channel: channelForVersion(mousseVersion()), self: false, reason: NO_DESKTOP_APP_REASON },
      olderThanThis: false,
      newerThanThis: false
    })
    expect(typeof (await row()).lastSeenAt).toBe('number')
    // A pairing that never connected said nothing, and is never called behind.
    const second = (await dispatch('bridge.nodes', {}, window('settings', true))).nodes.find(
      (node: { node: string }) => node.node === secondOnCaller
    )
    expect(second).toMatchObject({ olderThanThis: false, newerThanThis: false })
    expect(second.version).toBeUndefined()
  })

  it('refuses a terminal until the owner turns terminals on with bridge.policy', async () => {
    const thread = folderThread()
    expect(
      await refused(dispatch('pty.create', { threadId: q(thread.id), agentId: `${PROJECT_SHELL_AGENT_ID}:tab-1` }))
    ).toMatchObject({ code: 'computer_forbidden', details: { reason: 'terminal_off' } })
    expect(shells).toHaveLength(0)
    const set = await ownerLocal('bridge.policy', { node: callerOnOwner, terminal: true })
    expect(set.policy.terminal).toBe(true)
  })

  it('runs a routed call on the owner', async () => {
    const thread = owner.threads.createThread('Before')
    await dispatch('threads.rename', { threadId: q(thread.id), name: 'After' })
    expect(owner.threads.getThread(thread.id)?.name).toBe('After')
  })

  it('refuses a paired computer the methods off the allow-list: local ones and the routed editor rows', async () => {
    const thread = owner.threads.createThread('Editor')
    const call = (method: string, params: unknown) =>
      caller.netEngine
        .client(ownerOnCaller)
        .rpc(method, params, { id: newId('rpc') as RpcId, deadlineMs: 10_000 })
    for (const [method, params] of [
      ['netEngine.status', {}],
      ['bridge.policy', { terminal: true }],
      [routedNetMethod('editor.folder'), { threadId: thread.id }]
    ] as const)
      expect(await refused(call(method, params)), method).toMatchObject({ code: 'forbidden' })
  })

  describe('a thread', () => {
    let threadId: string
    it('opens through net.info and routed.stream.open, and its live records reach the window', async () => {
      const from = crossed.length
      threadId = owner.threads.createThread('Live').id
      await dispatch('threads.focus', { threadId: q(threadId) })
      await dispatch('thread.snapshot', { threadId: q(threadId) })
      expect(kinds(from)).toContain('caller mousse.rpc call routed.stream.open')
      // Asked once per client, by the first routed call.
      expect(kinds()).toContain('caller mousse.rpc call net.info')
      say(threadId, message('m1', 'first line'))
      await eventually(async () => expect(await snapshotIds(threadId)).toContain('m1'))
      expect(kinds(from)).toContain('owner mousse.sub records')
    })

    it('is bound to its pairing: a second pairing cannot read the stream', () => {
      const stream = owner.bridge.threads.privateHead(callerOnOwner, threadId)!.stream
      expect(() => caller.netEngine.bind(stream, secondOnCaller)).toThrow(
        expect.objectContaining({ code: 'conflict', details: { reason: 'stream_bound_elsewhere' } })
      )
    })

    it('replays from disk through the engine branch of the Hub', async () => {
      const seen: unknown[] = []
      const found = await caller.bridge.hub.replay(
        { nodeId: ownerOnCaller, entityId: threadId },
        { open: () => Promise.reject(new Error('not opened')) },
        (update) => seen.push(update)
      )
      expect(found).toBe(true)
      expect(JSON.stringify(seen)).toContain('first line')
    })

    it('installs a snapshot when the link comes back after the owner truncated the stream', async () => {
      link.cut()
      await eventually(() => expect(caller.peers.online(ownerOnCaller)).toBe(false))
      // While the caller is away the owner stores one record, then one larger than a record: for that it stores a
      // fresh snapshot and drops the records before it, the one the caller missed included.
      expect(owner.bridge.threads.privateHead(callerOnOwner, threadId)).toBeDefined()
      say(threadId, message('m2', 'second line'))
      say(threadId, message('m3', 'z'.repeat(60 * 1024)))
      const from = crossed.length
      await connect()
      await eventually(async () => expect(await snapshotIds(threadId)).toEqual(expect.arrayContaining(['m1', 'm2', 'm3'])), 30_000)
      expect(kinds(from)).toEqual(expect.arrayContaining(['owner mousse.sub snapshotRequired', 'owner mousse.sub snapshot']))
    }, 60_000)
  })

  describe('lists and Git progress', () => {
    it('attaches the owner’s lists through the Hub', async () => {
      await eventually(() =>
        expect(caller.bridge.lists.state()).toEqual(
          expect.arrayContaining([expect.objectContaining({ node: ownerOnCaller, live: true })])
        )
      )
      await eventually(() =>
        expect(caller.bridge.lists.threads().map((row) => row.id)).toContain(q(listedId))
      , 20_000)
    }, 30_000)

    it('attaches the Git progress stream through the Hub and hears progress on it', async () => {
      const router = caller.bridge.router
      const heard = vi.spyOn(router as unknown as { gitProgress(data: unknown): void }, 'gitProgress')
      try {
        await router.attached.channel(ownerOnCaller)
        expect(owner.bridge.threads.pushChannel(callerOnOwner, 'git.operation', { operationId: 'op-1', phase: 'running' })).toBe(true)
        await eventually(() => expect(heard).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'op-1' })))
      } finally {
        heard.mockRestore()
      }
    })
  })

  describe('large data, each path on its own', () => {
    it('reads a large reply in pages (routed.page)', async () => {
      const thread = owner.threads.createThread('Paged')
      const session = owner.orchestrator.getOrCreateSession(thread.id)
      session.messages = [
        { id: 'big', role: 'user', content: 'x'.repeat(200 * 1024), timestamp: new Date().toISOString() },
        { id: 'tail', role: 'user', content: 'end', timestamp: new Date().toISOString() }
      ] as never
      const from = crossed.length
      const page = await dispatch('thread.messages', { threadId: q(thread.id), before: 'tail', limit: 10 })
      expect(page.messages[0].content).toHaveLength(200 * 1024)
      expect(kinds(from)).toContain('caller mousse.rpc call routed.page')
    }, 60_000)

    it('stages a large write (bridge.artifacts.open, blob.put and append, then routed.stage)', async () => {
      const thread = owner.threads.createThread('Staged')
      const send = vi.spyOn(owner.orchestrator, 'send').mockResolvedValue({ accepted: true } as never)
      try {
        const from = crossed.length
        const content = 'y'.repeat(100 * 1024)
        await dispatch('orchestrator.send', { threadId: q(thread.id), content, requestId: 'staged-1' })
        expect(JSON.stringify(send.mock.calls)).toContain(content)
        const steps = kinds(from).filter((line) => line.startsWith('caller'))
        const order = [
          'caller mousse.rpc call bridge.artifacts.open',
          'caller mousse.put blob.put',
          'caller mousse.put commit',
          'caller mousse.put append',
          'caller mousse.rpc call routed.stage',
          'caller mousse.rpc call routed.orchestrator.send'
        ].map((line) => steps.indexOf(line))
        expect(order.every((at) => at >= 0)).toBe(true)
        expect([...order].sort((a, b) => a - b)).toEqual(order)
      } finally {
        send.mockRestore()
      }
    }, 60_000)

    it('reads a durable answer over 63 KiB through a window call: the owner sends an artifact, read as the Hub reads', async () => {
      const thread = owner.threads.createThread('Artifact')
      // Its answer holds the task twice (the task and the list), so it is larger than a reply.
      const description = 'd'.repeat(40 * 1024)
      const from = crossed.length
      const created = await dispatch('tasks.create', { threadId: q(thread.id), description })
      expect(JSON.stringify(created)).toContain(description)
      const steps = kinds(from)
      const reply = crossed
        .slice(from)
        .find((row) => row.header.t === 'result' && (row.header.result as { kind?: string })?.kind)
      expect((reply?.header.result as { kind?: string } | undefined)?.kind).toBe('bridge.artifact.result.v1')
      expect(steps).toContain('caller mousse.sub subscribe')
      expect(steps.some((line) => line.startsWith('caller mousse.blob'))).toBe(true)
      // Stored under the pairing and bound to it, as the Hub's streams are.
      const descriptor = (reply!.header.result as { descriptor: StreamDescriptor }).descriptor
      expect(caller.bridge.threads.store.getStream(descriptor.id)?.authority).toBe(ownerOnCaller)
    }, 60_000)
  })

  it('refuses a second paired reader a private stream it is not the reader of', async () => {
    const threadId = owner.threads.createThread('Private').id
    await dispatch('threads.focus', { threadId: q(threadId) })
    await dispatch('thread.snapshot', { threadId: q(threadId) })
    const stream = owner.bridge.threads.privateHead(callerOnOwner, threadId)!.stream
    const other = await secondCaller('other')
    const channel = new Channel(other.outbound.open('mousse.sub'))
    const answer = new Promise<Record<string, unknown>>((resolve) => channel.onMessage((m) => resolve(m.header)))
    channel.send({ t: 'subscribe', stream, after: { epoch: 0, seq: 0 } })
    expect(await answer).toMatchObject({ t: 'end', error: { code: 'forbidden' } })
    other.cut()
  })

  it('answers a second caller’s upload forbidden though its chunks were sent before the refusal', async () => {
    const threadId = owner.threads.createThread('Not yours').id
    await dispatch('thread.snapshot', { threadId: q(threadId) })
    const stream = owner.bridge.threads.privateHead(callerOnOwner, threadId)!.stream
    const other = await secondCaller('uploader')
    // A put sends its chunks and commit without waiting, so they reach the owner after it refused the first message.
    const channel = new Channel(other.outbound.open('mousse.put'))
    const answer = new Promise<unknown>((resolve) => {
      channel.onMessage((m) => resolve(m.header))
      channel.onEnd((reason) => resolve({ endedWith: reason }))
    })
    const bytes = new TextEncoder().encode('written by another caller')
    const blob = `blb_${createHash('sha256').update(bytes).digest('hex')}`
    channel.send({ t: 'blob.put', stream, blob, bytes: bytes.byteLength, sealed: false })
    channel.send({ t: 'bytes' }, [bytes])
    channel.send({ t: 'commit' })
    expect(await answer).toMatchObject({ t: 'error', error: { code: 'forbidden' } })
    other.cut()
  })

  /** Another computer paired with the owner, linked to it by its own connection. */
  async function secondCaller(name: string): Promise<ReturnType<typeof fakeLink>> {
    const endpoint = `${name}.test:7000`
    const grant = `grant-held-by-${name}`
    const localId = owner.netEngine.pair({
      endpoint,
      fingerprint: `sha256:${name}`,
      grant,
      name: `${name} computer`,
      state: 'connected'
    }).localId
    const link = fakeLink({ ownerOnCaller: newId('node'), callerOnOwner: localId, grant, endpoint })
    await owner.netEngine.attach(link.inbound)
    return link
  }

  describe('a terminal', () => {
    const output = (ptyId: string) =>
      events
        .filter((event) => event.type === 'pty.data' && event.data.ptyId === ptyId)
        .map((event) => event.data.data as string)
        .join('')
    const attached = (ptyId: string) =>
      caller.bridge.router.terminals.state().some((term) => term.ptyId === ptyId && term.attached)
    let ptyId: string, threadId: string, shell: Spawned

    it('opens through the Hub, takes input and shows output', async () => {
      const thread = folderThread()
      threadId = thread.id
      const before = shells.length
      const created = await dispatch('pty.create', { threadId: q(threadId), agentId: `${PROJECT_SHELL_AGENT_ID}:tab-1` })
      ptyId = created.ptyId
      shell = shells[before]
      await eventually(() => expect(attached(ptyId)).toBe(true), 20_000)
      await dispatch('pty.write', { threadId: q(threadId), ptyId, data: 'echo hi\r' })
      expect(shell.pty.written.join('')).toContain('echo hi')
      shell.pty.say('hi from the owner\r\n')
      await eventually(() => expect(output(ptyId)).toContain('hi from the owner'))
    }, 60_000)

    for (const days of [8, 40])
      it(`stays open through a renewal with the clock moved ${days} days`, async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        try {
          vi.setSystemTime(Date.now() + days * DAY)
          // No renewal is run by hand: the first call after the jump renews on both sides, before the hourly check.
          await dispatch('pty.write', { threadId: q(threadId), ptyId, data: `after ${days}\r` })
          expect(shell.pty.written.join('')).toContain(`after ${days}`)
          // Each own delegation now runs past the moved clock: nothing is due within a day.
          for (const mms of [owner, caller]) expect(mms.net.runtime().identity.renewSelf(DAY).renewed).toBeUndefined()
          shell.pty.say(`output after ${days} days\r\n`)
          await eventually(() => expect(output(ptyId)).toContain(`output after ${days} days`))
          expect(attached(ptyId)).toBe(true)
          // Calls go on too.
          const thread = owner.threads.createThread(`Day ${days}`)
          await dispatch('threads.rename', { threadId: q(thread.id), name: `Renamed on day ${days}` })
          expect(owner.threads.getThread(thread.id)?.name).toBe(`Renamed on day ${days}`)
          owner.orchestrator.emit('thread-message', { threadId: thread.id, message: message(`d${days}`, 'later') })
        } finally {
          vi.useRealTimers()
        }
      }, 60_000)

    it('opens new streams after the clock goes back past a renewal', async () => {
      // The last test renewed both own delegations 40 days ahead; the clock is back at now.
      const own = (mms: MousseMainService) => mms.net.runtime().identity.renewSelf(DAY, Number.MAX_SAFE_INTEGER)
      for (const mms of [owner, caller]) expect(own(mms).issuedAt).toBeGreaterThan(Date.now() + DAY)
      const thread = folderThread('After the clock went back')
      const before = shells.length
      const created = await dispatch('pty.create', { threadId: q(thread.id), agentId: `${PROJECT_SHELL_AGENT_ID}:tab-back` })
      await eventually(() => expect(attached(created.ptyId)).toBe(true), 20_000)
      shells[before]!.pty.say('after the clock went back\r\n')
      await eventually(() => expect(output(created.ptyId)).toContain('after the clock went back'))
      for (const mms of [owner, caller]) expect(own(mms).issuedAt).toBeLessThanOrEqual(Date.now())
    }, 60_000)
  })

  it('sends no private key and no reader id across the link, and these node and stream fields only', () => {
    const ownerSelf = owner.net.runtime().identity.self()!.node
    const callerSelf = caller.net.runtime().identity.self()!.node
    const names = new Map<string, string>([
      [ownerOnCaller, 'ownerOnCaller'],
      [callerOnOwner, 'callerOnOwner'],
      [ownerSelf, 'ownerSelf'],
      [callerSelf, 'callerSelf']
    ])
    const fields = new Set<string>()
    const walk = (value: unknown, path: string, where: string): void => {
      if (typeof value === 'string') {
        expect(value.includes('private:'), `${where} ${path}`).toBe(false)
        for (const [id, name] of names) if (value.includes(id)) fields.add(`${where} ${path} = ${name}`)
        if (/^str_[0-9a-z]{26}$/.test(value)) fields.add(`${where} ${path} = stream`)
        return
      }
      if (Array.isArray(value)) return value.forEach((item) => walk(item, `${path}[]`, where))
      if (value && typeof value === 'object')
        for (const [key, inner] of Object.entries(value)) walk(inner, path ? `${path}.${key}` : key, where)
    }
    for (const m of crossed) {
      const where = `${m.from} ${m.label} ${m.header.t}${typeof m.header.method === 'string' ? ` ${m.header.method}` : ''}`
      walk(m.header, '', where)
      for (const part of m.parts) {
        const text = Buffer.from(part).toString('latin1')
        expect(text.includes('private:'), where).toBe(false)
        for (const [id, name] of names) if (text.includes(id)) fields.add(`${where} <part> = ${name}`)
      }
    }
    const list = [...fields].sort()
    // Pinned: a new node, reader or stream field on the link is a review decision, made here. The owner's local id
    // for the caller (the reader of its private streams) crosses only as an artifact's caller, and the caller's local
    // id for the owner never crosses.
    expect(list).toEqual([
      'caller mousse.blob get stream = stream',
      // The staged record's envelope names the caller's own author; the owner ignores it (§3.3).
      'caller mousse.put append <part> = callerSelf',
      'caller mousse.put append stream = stream',
      'caller mousse.put blob.put stream = stream',
      'caller mousse.rpc call routed.stage params.input.stream = stream',
      'caller mousse.sub subscribe after.stream = stream',
      'caller mousse.sub subscribe stream = stream',
      'owner mousse.rpc result result.artifact.caller = callerOnOwner',
      'owner mousse.rpc result result.artifact.stream = stream',
      'owner mousse.rpc result result.authority = ownerSelf',
      'owner mousse.rpc result result.descriptor.artifact.caller = callerOnOwner',
      'owner mousse.rpc result result.descriptor.authority = ownerSelf',
      'owner mousse.rpc result result.descriptor.id = stream',
      'owner mousse.rpc result result.id = stream',
      'owner mousse.rpc result result.result.descriptor.authority = ownerSelf',
      'owner mousse.rpc result result.result.descriptor.id = stream',
      'owner mousse.rpc result result.result.streamHead.stream = stream',
      'owner mousse.sub records <part> = ownerSelf',
      'owner mousse.sub snapshot <part> = ownerSelf'
    ])
  })

  it('updates the owner from the caller only with Full control there, checked again before it installs', async () => {
    // The owner's desktop app updates itself (its report) and takes update requests (its registration on its service).
    writeFileSync(selfUpdateReportPath(ownerHome), JSON.stringify({ channel: 'stable', self: true }))
    const hub = remoteUpdatesFor(ownerHome)
    hub.attach('owner-app')
    cleanups.push(() => hub.detach('owner-app'))
    const ask = (params: Record<string, unknown>) =>
      dispatch('net.update.there', { node: ownerOnCaller, ...params }, window('settings', true))
    // The level is saved; with no helper here, the grant's role stays pending, which this check does not read.
    const level = (id: 'full' | 'work') =>
      ownerLocal('bridge.policy', { node: callerOnOwner, ...accessPreset(id).fields }).catch((error) => {
        if (error?.details?.reason !== 'role_pending') throw error
      })
    // The pairing's owner grant alone is not Full control: refused before anything is kept.
    expect(await ask({ step: 'prepare', version: '9.9.9' })).toMatchObject({ phase: 'failed', error: 'forbidden' })
    expect(hub.current()).toBeNull()

    await level('full')
    // Asked again, the owner says it takes requests now (what shows Update in Devices).
    await ask({ step: 'refresh' })
    const row = (await dispatch('bridge.nodes', {}, window('settings', true))).nodes.find(
      (node: { node: string }) => node.node === ownerOnCaller
    )
    expect(row.update).toMatchObject({ requests: true })

    const prepared = await ask({ step: 'prepare', version: '9.9.9' })
    expect(prepared.phase).toBe('preparing')
    expect(hub.current()).toMatchObject({ version: '9.9.9', from: 'Caller computer' })
    hub.progress('owner-app', prepared.job, { phase: 'ready' })
    expect(await ask({ step: 'install', job: prepared.job, runningTurns: 0 })).toMatchObject({ phase: 'countdown' })

    // Lowered to Work on threads during the countdown: the status is refused, and the install never starts.
    await level('work')
    expect(await ask({ step: 'status', job: prepared.job })).toMatchObject({ phase: 'failed', error: 'forbidden' })
    expect(hub.begin('owner-app', prepared.job)).toMatchObject({ go: false, wait: false, job: { error: 'forbidden' } })
  })

  it('updates every computer from one click, keeps the rollout across a restart of the service, and verifies each version there', async () => {
    const version = process.env.MOUSSE_VERSION
    const poll = process.env.MOUSSE_NET_UPDATE_POLL_MS
    const reconnect = process.env.MOUSSE_NET_UPDATE_ROLLOUT_RECONNECT_MS
    const recheck = process.env.MOUSSE_NET_UPDATE_ROLLOUT_RECHECK_MS
    process.env.MOUSSE_VERSION = '0.1.5'
    process.env.MOUSSE_NET_UPDATE_POLL_MS = '50'
    process.env.MOUSSE_NET_UPDATE_ROLLOUT_RECONNECT_MS = '300'
    process.env.MOUSSE_NET_UPDATE_ROLLOUT_RECHECK_MS = '50'
    const target = '0.1.9'
    // The owner's desktop app: updates itself, downloads at once and installs when its countdown ends, then runs the
    // new version.
    writeFileSync(selfUpdateReportPath(ownerHome), JSON.stringify({ channel: 'stable', self: true }))
    const hub = remoteUpdatesFor(ownerHome)
    hub.attach('owner-app')
    const services = await caller.getProfileServices(caller.profileId)
    // The network between the two: the reply to Install is lost (the install still runs there), and while the owner
    // restarts it answers nothing at all.
    const engine = services.netEngine as unknown as { updateThere: (params: any) => Promise<unknown> }
    const reach = engine.updateThere
    let silent = false
    let lostInstalls = 0
    engine.updateThere = async (params) => {
      if (silent) throw new NetError('deadline_exceeded')
      const answer = await reach.call(engine, params)
      if (params.step === 'install') {
        lostInstalls++
        throw new NetError('deadline_exceeded')
      }
      return answer
    }
    let installs = 0
    let savedAtRestart: any
    const app = setInterval(() => {
      const job = hub.current()
      if (job?.phase === 'preparing') hub.progress('owner-app', job.id, { phase: 'ready' })
      if ((job?.phase === 'countdown' || job?.phase === 'waiting') && hub.begin('owner-app', job.id).go === true) {
        installs++
        // This computer's service stops as the owner installs: the rollout is mid-way, kept only in the database.
        services.updateRollouts().stop()
        ;(services as unknown as { updateRolloutsInstance?: unknown }).updateRolloutsInstance = undefined
        savedAtRestart = services.net.updateRolloutStore().read()
        silent = true
        process.env.MOUSSE_VERSION = target
      }
    }, 20)
    cleanups.push(() => {
      clearInterval(app)
      engine.updateThere = reach
      hub.detach('owner-app')
      if (reconnect === undefined) delete process.env.MOUSSE_NET_UPDATE_ROLLOUT_RECONNECT_MS
      else process.env.MOUSSE_NET_UPDATE_ROLLOUT_RECONNECT_MS = reconnect
      if (recheck === undefined) delete process.env.MOUSSE_NET_UPDATE_ROLLOUT_RECHECK_MS
      else process.env.MOUSSE_NET_UPDATE_ROLLOUT_RECHECK_MS = recheck
      if (version === undefined) delete process.env.MOUSSE_VERSION
      else process.env.MOUSSE_VERSION = version
      if (poll === undefined) delete process.env.MOUSSE_NET_UPDATE_POLL_MS
      else process.env.MOUSSE_NET_UPDATE_POLL_MS = poll
    })
    await ownerLocal('bridge.policy', { node: callerOnOwner, ...accessPreset('full').fields }).catch((error) => {
      if (error?.details?.reason !== 'role_pending') throw error
    })
    const settings = window('settings', true)
    // What the owner runs now, asked again (as the list does when it opens).
    await dispatch('net.update.there', { node: ownerOnCaller, step: 'refresh' }, settings)
    const rows = (answer: any) => Object.fromEntries(answer.rollout.rows.map((row: any) => [row.node, row]))

    // Cancelled before confirming: the owner's download stops, over the engine.
    const first = await dispatch('updates.rollout.start', { version: target }, settings)
    const firstJob = rows(first)[ownerOnCaller].job
    expect(hub.current()).toMatchObject({ id: firstJob })
    await dispatch('updates.rollout.cancel', {}, settings)
    expect(hub.current()).toBeNull()
    expect((await dispatch('updates.rollout.get', {}, settings)).rollout).toBeNull()

    // This computer's app is not running here, so it is left to update by hand; the owner is updated from here.
    const plan = await dispatch('updates.rollout.get', { version: target }, settings)
    expect(Object.fromEntries(plan.plan.map((row: any) => [row.node, row.via]))).toEqual({ self: 'manual', [ownerOnCaller]: 'request' })
    const started = await dispatch('updates.rollout.start', { version: target }, settings)
    await eventually(async () => expect(rows(await dispatch('updates.rollout.get', {}, settings))[ownerOnCaller].phase).toBe('ready'))
    await dispatch('updates.rollout.confirm', { turns: { [ownerOnCaller]: 0 } }, settings)
    await eventually(() => expect(installs).toBe(1), 30_000)
    expect(savedAtRestart).toMatchObject({ id: started.rollout.id, rows: [{ node: 'self', phase: 'manual' }, { node: ownerOnCaller, phase: 'installing' }] })
    expect(['installing', 'verifying']).toContain(savedAtRestart.step)
    // Install's reply never came, yet the row went on to installing rather than failed.
    expect(lostInstalls).toBe(1)

    // The next service finds it in the profile's database when a window reads it. The owner says nothing past the
    // reconnect deadline: "Couldn't verify", never failed.
    await eventually(async () => {
      const read = await dispatch('updates.rollout.get', {}, settings)
      expect(read.rollout).toMatchObject({ id: started.rollout.id, step: 'done' })
      expect(rows(read)[ownerOnCaller]).toMatchObject({ phase: 'unverified' })
    }, 30_000)
    // The owner answers again with the new version: reading the results corrects the row.
    silent = false
    await eventually(async () => {
      const read = await dispatch('updates.rollout.get', {}, settings)
      expect(read.rollout).toMatchObject({ id: started.rollout.id, step: 'done' })
      expect(rows(read)[ownerOnCaller]).toMatchObject({ phase: 'updated' })
    }, 30_000)
    await dispatch('updates.rollout.dismiss', {}, settings)
    expect((await dispatch('updates.rollout.get', {}, settings)).rollout).toBeNull()

    // Each change reached the windows of this profile, which read the rollout again.
    const notice = events.find((event) => event.type === 'ui.notify' && event.data?.kind === 'update-rollout')
    const sent: unknown[] = []
    bridgeProtocolEvent(notice as never, (channel, data) => sent.push([channel, data]), { getActiveThreadId: () => null } as never)
    expect(sent).toEqual([['updates:rollout-changed', { profileId: caller.profileId }]])
  }, 90_000)
})

describe('a profile that joined another computer’s v1 network', () => {
  afterAll(cleanupV1)
  it('turns the engine on while v1 is on, and is refused with v1 off', async () => {
    const t = await linked()
    expect(t.caller.net.runtime().identity.isKeeper()).toBe(false)
    await t.caller.netEngine.enable()
    expect(t.caller.netEngine.on()).toBe(true)
    await t.caller.netEngine.stop()
    ;(t.caller.net as unknown as { config: { features: { netBridge: boolean } } }).config.features.netBridge = false
    await expect(t.caller.netEngine.start()).rejects.toMatchObject({
      code: 'forbidden',
      message: NON_KEEPER_MESSAGE,
      details: { reason: 'not_keeper' }
    })
    expect(t.caller.netEngine.on()).toBe(false)
  }, 120_000)
})
