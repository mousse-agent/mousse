/**
 * The Devices screen asks this computer what another one did here: the audit in plain words, the "Always"
 * rules a person on it made (with Clear), and which turns of a thread it sent.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearDeviceRules,
  deviceActivityOf,
  messageSendersOf,
  validateActivityParams
} from '../../../../src/mms/bridge/deviceActivity'
import { OwnerRoutes } from '../../../../src/mms/bridge/routed/OwnerRoutes'
import { SqliteBridgeAudit } from '../../../../src/mms/net/store/audit'
import { SqliteNodePolicy } from '../../../../src/mms/net/store/nodePolicy'
import { systemClock } from '../../../../src/mms/net/clock'
import {
  AUDITED_CHANGE_METHODS,
  describeActivityEntry,
  describeDeviceActivity
} from '../../../../src/shared/bridge/deviceActivity'
import { ROUTED_METHODS, isRoutedReply, routedNetMethod, type RoutedReply } from '../../../../src/shared/bridge/routed'
import { newId, type NodeCapability, type NodeId } from '../../../../src/shared/net'
import { cleanup, fixture, resources } from '../hub/fixture'

afterEach(cleanup)

const COMPUTER: NodeCapability[] = ['read', 'chat', 'write', 'settings']

function repo(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'activity-repo-')))
  resources.push(() => rmSync(path, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'owner@example.test')
  git('config', 'user.name', 'Owner')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(path, 'a.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  return path
}

async function owner(options: { onFirstProject?: (info: { node: NodeId; name: string; projectName?: string }) => void } = {}) {
  const f = await fixture(COMPUTER)
  const policy = new SqliteNodePolicy(f.targetDb, systemClock)
  const audit = new SqliteBridgeAudit(f.targetDb, systemClock)
  new OwnerRoutes({
    services: f.mms,
    rpc: f.targetRpc,
    policy,
    audit,
    track: (work) => work,
    deviceName: () => 'Hub caller',
    ...(options.onFirstProject ? { onFirstProject: options.onFirstProject } : {})
  }).register()
  await f.connect()
  const call = async (method: string, params: Record<string, unknown>): Promise<RoutedReply> => {
    const row = ROUTED_METHODS[method]
    const reply = await f.caller().rpc(routedNetMethod(method), params, {
      id: newId('rpc'),
      ...(row.durable ? { idem: `idem-${newId('rpc')}` } : {}),
      deadlineMs: 20_000
    })
    expect(isRoutedReply(reply)).toBe(true)
    return reply as RoutedReply
  }
  const ok = async (method: string, params: Record<string, unknown>) => {
    const reply = await call(method, params)
    if (!reply.ok) throw new Error(`${method} refused: ${reply.error.code}`)
    return reply.result as Record<string, any>
  }
  const sources = () => ({
    services: f.mms,
    runtime: { audit, identity: f.targetIdentity },
    now: Date.now()
  })
  return { f, audit, call, ok, sources }
}

/** An answered approval and the "Always" rule it made, as the run engine keeps them. */
function rule(
  f: Awaited<ReturnType<typeof owner>>['f'],
  threadId: string,
  requestId: string,
  answeredBy: unknown
): void {
  const db = f.mms.runEngine.store.db
  db.statement(
    `INSERT INTO approval_requests(request_id, thread_id, instance_id, provider, action, permission_key, fingerprint, questions, answer_path, status, answered_by, created_at)
     VALUES(?, ?, 'i', 'p', 'command', 'bash', ?, '[]', 'live', 'answered', ?, '2026-01-01T00:00:00Z')`
  ).run(requestId, threadId, `fp-${requestId}`, JSON.stringify(answeredBy))
  db.statement(
    `INSERT INTO approval_rules(thread_id, fingerprint, permission_key, action, summary, granted_under, source_request_id, created_at)
     VALUES(?, ?, 'bash', 'command', ?, 'accept_edits', ?, '2026-01-01T00:00:00Z')`
  ).run(threadId, `fp-${requestId}`, `run ${requestId}`, requestId)
}

describe('what a device did on this computer', () => {
  it('counts its changes, names the thread and project, and never shows a folder it was refused', async () => {
    const { f, ok, call, sources } = await owner()
    const thread = f.mms.threads.createThread('Shared thread')
    await ok('threads.rename', { threadId: thread.id, name: 'Renamed thread' })
    await ok('threads.rename', { threadId: thread.id, name: 'Renamed again' })
    await call('threads.rename', { threadId: 'missing', name: 'x' })
    const opened = await ok('projects.open', { path: repo() })
    const refused = await call('projects.open', { path: f.targetPath })
    expect(refused).toMatchObject({ ok: false, error: { code: 'project_refused' } })
    await ok('threads.get', { threadId: thread.id })

    const activity = deviceActivityOf(sources(), f.callerNode)
    expect(Object.fromEntries(activity.counts.map((row) => [row.method, row.count]))).toMatchObject({
      'threads.rename': 2,
      'projects.open': 1
    })
    expect(activity.refused).toBe(2)
    expect(activity.uncertain).toBe(0)
    expect(describeDeviceActivity(activity.counts)).toBe('Renamed 2 threads, opened a folder as a project')
    // The thread is linked by id and named; the project by name.
    const rename = activity.entries.find((row) => row.method === 'threads.rename' && row.kind === 'change')!
    expect(rename.thread).toEqual({ id: thread.id, name: 'Renamed again' })
    const open = activity.entries.find((row) => row.method === 'projects.open' && row.kind === 'change')!
    expect(open.project).toEqual({ name: f.mms.projects.getProject(opened.project.id)!.name })
    // A folder that was refused is not named, and no path or hash of it leaves this computer.
    const refusal = activity.entries.find((row) => row.method === 'projects.open' && row.kind === 'refused')!
    expect(refusal.project).toBeUndefined()
    const text = JSON.stringify(activity)
    expect(text).not.toContain(f.targetPath)
    expect(text).not.toMatch(/path:[0-9a-f]{12}/)
    // The first change and the first folder are rows of their own.
    expect(activity.entries.map((row) => row.method)).toEqual(
      expect.arrayContaining(['thread.first_use', 'project.first_open'])
    )
    // A read is counted, not listed.
    expect(activity.entries.some((row) => row.method === 'threads.get')).toBe(false)
    expect(activity.reads.calls).toBeGreaterThanOrEqual(1)
    expect(activity.reads.hours.length).toBeGreaterThanOrEqual(1)
    // Another device has nothing of it.
    expect(deviceActivityOf(sources(), newId('node') as never)).toMatchObject({ counts: [], refused: 0, entries: [] })
  }, 120_000)

  it('names a thread or project that is gone since by null, and still links the thread by id', async () => {
    const { f, audit, sources } = await owner()
    audit.record({ node: f.callerNode, method: 'files.write', thread: 'gone-thread', project: 'gone-project', outcome: 'ok', kind: 'change' })
    const [entry] = deviceActivityOf(sources(), f.callerNode).entries
    expect(entry).toMatchObject({ thread: { id: 'gone-thread', name: null }, project: { name: null } })
  }, 60_000)

  it('tells the owner once when a device registers its first folder, and keeps a row for it', async () => {
    const told: Array<{ name: string; projectName?: string }> = []
    const { f, ok, audit } = await owner({ onFirstProject: (info) => told.push(info) })
    const opened = await ok('projects.open', { path: repo() })
    await ok('projects.open', { path: repo() })
    expect(told).toEqual([
      { node: f.callerNode, name: 'Hub caller', projectName: f.mms.projects.getProject(opened.project.id)!.name }
    ])
    const rows = audit.recent(20, f.callerNode)
    expect(rows.filter((row) => row.method === 'project.first_open')).toHaveLength(1)
    expect(rows.filter((row) => row.method === 'projects.open')).toHaveLength(2)
    // The folder notice stands in for the general one, which is still a row.
    expect(rows.filter((row) => row.method === 'thread.first_use')).toHaveLength(1)
  }, 120_000)

  it('does not tell the owner of a folder that was refused', async () => {
    const told: unknown[] = []
    const { f, call, audit } = await owner({ onFirstProject: (info) => told.push(info) })
    expect(await call('projects.open', { path: f.targetPath })).toMatchObject({ ok: false })
    expect(told).toEqual([])
    expect(audit.recent(20, f.callerNode).some((row) => row.method === 'project.first_open')).toBe(false)
  }, 60_000)
})

describe('the "Always" rules a device made', () => {
  it('lists only the rules a person on that device made, and Clear removes them from the rules of the thread', async () => {
    const { f, sources } = await owner()
    const thread = f.mms.threads.createThread('Rules')
    const other = f.mms.threads.createThread('More rules')
    rule(f, thread.id, 'device-a', { kind: 'user', via: 'bridge', node: f.callerNode })
    rule(f, thread.id, 'device-b', { kind: 'user', via: 'bridge', node: f.callerNode })
    rule(f, other.id, 'device-c', { kind: 'user', via: 'bridge', node: f.callerNode })
    rule(f, thread.id, 'mine', { kind: 'user', via: 'gui' })
    rule(f, thread.id, 'theirs', { kind: 'user', via: 'bridge', node: newId('node') })

    const listed = deviceActivityOf(sources(), f.callerNode).rules
    expect(listed.map((row) => [row.threadName, row.rule.id, row.rule.summary]).sort()).toEqual([
      ['More rules', 'fp-device-c', 'run device-c'],
      ['Rules', 'fp-device-a', 'run device-a'],
      ['Rules', 'fp-device-b', 'run device-b']
    ])

    // One rule: the others stay.
    const one = clearDeviceRules(sources(), { node: f.callerNode, threadId: thread.id, ruleId: 'fp-device-a' })
    expect(one.removed).toBe(1)
    expect(one.rules.map((row) => row.rule.id).sort()).toEqual(['fp-device-b', 'fp-device-c'])
    expect(f.mms.orchestrator.listApprovalRules(thread.id).map((row) => row.id).sort()).toEqual([
      'fp-device-b',
      'fp-mine',
      'fp-theirs'
    ])
    // A rule of the owner's, or of another device, is out of reach even when named.
    expect(clearDeviceRules(sources(), { node: f.callerNode, threadId: thread.id, ruleId: 'fp-mine' }).removed).toBe(0)
    expect(clearDeviceRules(sources(), { node: f.callerNode, threadId: thread.id, ruleId: 'fp-theirs' }).removed).toBe(0)
    // The rule of another thread is not reached by naming this one.
    expect(clearDeviceRules(sources(), { node: f.callerNode, threadId: thread.id, ruleId: 'fp-device-c' }).removed).toBe(0)

    // Every rule of the device, in every thread.
    const all = clearDeviceRules(sources(), { node: f.callerNode })
    expect(all.removed).toBe(2)
    expect(all.rules).toEqual([])
    expect(f.mms.orchestrator.listApprovalRules(thread.id).map((row) => row.id).sort()).toEqual(['fp-mine', 'fp-theirs'])
    expect(f.mms.orchestrator.listApprovalRules(other.id)).toEqual([])
    // The revocation is in the thread's history, as for a rule the owner clears.
    const revoked = f.mms.runEngine.store.db
      .statement("SELECT COUNT(*) AS n FROM thread_events WHERE type = 'approval.rule_revoked'")
      .get() as { n: number }
    expect(revoked.n).toBe(3)
  }, 60_000)
})

describe('who sent the turns of a thread', () => {
  it('maps the runs a device started to its name, and a thread of another computer to nothing', async () => {
    const { f, sources } = await owner()
    const thread = f.mms.threads.createThread('Sent from elsewhere')
    const store = f.mms.runEngine.store
    store.appendEvent({ threadId: thread.id, runId: 'run-1', type: 'run.sent_from', payload: { node: f.callerNode } })
    store.appendEvent({ threadId: thread.id, runId: 'run-1', type: 'run.sent_from', payload: { node: f.callerNode } })
    store.appendEvent({ threadId: thread.id, runId: 'run-2', type: 'run.sent_from', payload: { node: 'not a node' } })
    store.appendEvent({ threadId: thread.id, runId: 'run-3', type: 'run.status', payload: {} })

    expect(messageSendersOf(sources(), thread.id)).toEqual({ runs: { 'run-1': { node: f.callerNode, name: 'Hub caller' } } })
    expect(messageSendersOf(sources(), `${f.callerNode}:${thread.id}`)).toEqual({ runs: {} })
  }, 60_000)
})

describe('the Devices screen requests', () => {
  it('take exactly their keys', () => {
    const node = newId('node')
    expect(validateActivityParams('bridge.activity', { node })).toEqual({ node })
    expect(() => validateActivityParams('bridge.activity', {})).toThrow()
    expect(() => validateActivityParams('bridge.activity', { node, extra: 1 })).toThrow()
    expect(() => validateActivityParams('bridge.activity', { node: 'nod_x' })).toThrow()
    expect(validateActivityParams('bridge.clearDeviceRules', { node })).toEqual({ node })
    expect(validateActivityParams('bridge.clearDeviceRules', { node, threadId: 't', ruleId: 'r' })).toEqual({
      node,
      threadId: 't',
      ruleId: 'r'
    })
    // A rule is named by its thread and its id together.
    expect(() => validateActivityParams('bridge.clearDeviceRules', { node, ruleId: 'r' })).toThrow()
    expect(() => validateActivityParams('bridge.clearDeviceRules', { node, threadId: 't' })).toThrow()
    expect(validateActivityParams('bridge.messageSenders', { threadId: 't' })).toEqual({ threadId: 't' })
    expect(() => validateActivityParams('bridge.messageSenders', { threadId: '' })).toThrow()
    expect(() => validateActivityParams('bridge.hub.get' as never, {})).toThrow()
  })
})

describe('the words for what a device did', () => {
  it('sums methods with the same words and puts the most common first', () => {
    expect(
      describeDeviceActivity([
        { method: 'orchestrator.send', count: 3 },
        { method: 'orchestrator.answerQuestions', count: 2 },
        { method: 'git.stage', count: 1 },
        { method: 'git.unstage', count: 1 },
        { method: 'pty.create', count: 1 },
        { method: 'git.push', count: 1 },
        { method: 'thread.first_use', count: 1 },
        { method: 'pty.close', count: 1 }
      ])
    ).toBe('Started 3 turns, answered 2 approvals or questions, changed staged files 2 times, opened a terminal, pushed to a remote')
    expect(describeDeviceActivity([])).toBe('')
    expect(describeDeviceActivity([{ method: 'thread.first_use', count: 1 }])).toBe('')
  })

  it('has words for every change a routed row can make', () => {
    for (const [method, row] of Object.entries(ROUTED_METHODS))
      if (row.durable) expect(AUDITED_CHANGE_METHODS, method).toContain(method)
  })

  it('says why a call was refused or lost, and how a terminal ended', () => {
    expect(describeActivityEntry({ method: 'files.write', kind: 'refused', outcome: 'thread_not_found' })).toBe(
      'Saved a file (refused: the thread was gone)'
    )
    expect(describeActivityEntry({ method: 'git.push', kind: 'change', outcome: 'uncertain' })).toBe(
      'Pushed to a remote (may have happened)'
    )
    expect(describeActivityEntry({ method: 'pty.close', kind: 'change', outcome: 'device_away; in 12 B; out 2048 B' })).toBe(
      'A terminal ended: the device was away (typed 12 B, shown 2.0 KiB)'
    )
    expect(describeActivityEntry({ method: 'pty.first_open', kind: 'change', outcome: 'first_terminal' })).toBe(
      'Opened its first terminal here'
    )
    expect(describeActivityEntry({ method: 'project.first_open', kind: 'change', outcome: 'first_folder' })).toBe(
      'Opened its first folder as a project here'
    )
    expect(describeActivityEntry({ method: 'something.new', kind: 'change', outcome: 'ok' })).toBe('Made a change')
  })
})
