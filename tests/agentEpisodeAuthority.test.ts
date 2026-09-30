import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import { AgentEpisodeStore } from '../src/mms/agents/AgentEpisodeStore'
import { TaskWriterAuthority } from '../src/mms/agents/TaskWriterAuthority'
import { createAgentToolAccess, resolveAgentWorkspacePolicy } from '../src/mms/agents/WorkspaceAccessPolicy'
import { tryAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { createPolicyTempRoot, createOutsideSecretLayout, nativeClient, providerResponse, removeOwnedPolicyTempRoots } from './fixtures/agent-platform/agent-runtime-policy/helpers'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); await removeOwnedPolicyTempRoots() })
const writePolicy = { version: 1, workspace: 'shared', access: 'write' } as const
function root(): string { const dir = mkdtempSync(join(tmpdir(), 'agent-episode-')); roots.push(dir); return dir }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }

it('uses safe new defaults, explicit legacy compatibility and rejects adapter or inherited escalation', () => {
  expect(resolveAgentWorkspacePolicy(undefined, { adapter: 'mousse' })).toEqual({ version: 1, workspace: 'shared', access: 'read-only' })
  expect(resolveAgentWorkspacePolicy(undefined, { adapter: 'codex', legacy: true })).toEqual({ version: 1, workspace: 'isolated', access: 'write' })
  expect(() => resolveAgentWorkspacePolicy(undefined, { adapter: 'codex' })).toThrow('cannot enforce')
  expect(() => resolveAgentWorkspacePolicy(writePolicy, { adapter: 'mousse', inherited: { ...writePolicy, access: 'read-only' } })).toThrow('broaden')
})

it('rejects actual native write, shell and escaping read calls even when the model emits unadvertised tools', async () => {
  const dir = createPolicyTempRoot(), outside = createOutsideSecretLayout(dir)
  writeFileSync(join(dir, 'allowed.txt'), 'safe')
  const captured: Context[] = []
  const calls = [
    { name: 'write', arguments: { path: 'forbidden.txt', content: 'bad' } },
    { name: 'bash', arguments: { command: 'echo bad' } },
    { name: 'read', arguments: { path: join(outside.linkPath, 'secret.txt') } },
    { name: 'read', arguments: { path: 'allowed.txt' } }
  ]
  const client = nativeClient([
    providerResponse(calls.map((call, index) => ({ type: 'toolCall' as const, id: `call-${index}`, ...call })), 'toolUse'),
    providerResponse([{ type: 'text', text: 'done' }], 'stop')
  ], captured)
  await client.chat([{ role: 'user', content: 'inspect', timestamp: Date.now() }], undefined, {
    mode: 'build', subagent: true, projectPath: dir,
    toolAccess: createAgentToolAccess({ ...writePolicy, access: 'read-only' }, dir)
  })
  expect(existsSync(join(dir, 'forbidden.txt'))).toBe(false)
  const results = captured[1].messages.filter((message) => message.role === 'toolResult')
  expect(results.slice(0, 3).every((message) => message.isError)).toBe(true)
  expect(JSON.stringify(results)).not.toContain('outside-secret-bytes')
  expect(JSON.stringify(results.at(-1))).toContain('safe')
  expect(captured[0].tools?.some((tool) => ['write', 'bash'].includes(tool.name))).toBe(false)
})

it('serializes shared episode lifetimes, permits nested explicit delegation and drains revocation before reassignment', async () => {
  const lease = tryAcquireExecutionLease(root())!
  try {
    const authority = new TaskWriterAuthority(lease)
    const parent = authority.issue('parent', writePolicy), child = authority.issue('child', writePolicy, parent)
    const grandchild = authority.issue('grandchild', writePolicy, child)
    const order: string[] = []
    await authority.runWriter(parent, async () => {
      order.push('parent-start')
      await authority.delegate(parent, () => authority.runWriter(child, async () => {
        order.push('child-start')
        await authority.delegate(child, () => authority.runWriter(grandchild, async () => { order.push('grandchild') }))
        order.push('child-end')
      }))
      order.push('parent-end')
    })
    expect(order).toEqual(['parent-start', 'child-start', 'grandchild', 'child-end', 'parent-end'])
    const started = deferred(), drain = deferred(), next = authority.issue('next', writePolicy)
    const writing = authority.runWriter(child, async () => { started.resolve(); await drain.promise; order.push('drained') })
    await started.promise
    const cancelled = authority.revokeAndDrain(child)
    const waiting = authority.runWriter(next, async () => { order.push('next') })
    await Promise.resolve(); expect(order).not.toContain('next')
    drain.resolve(); await Promise.all([writing, cancelled, waiting])
    expect(order.slice(-2)).toEqual(['drained', 'next'])
    await expect(authority.runWriter(grandchild, async () => undefined)).rejects.toThrow('revoked')
  } finally { releaseExecutionLeaseHandle(lease) }
})

it('keeps task-scoped names and immutable episodes while rejecting duplicate recalls and stale context publication', () => {
  const store = new AgentEpisodeStore(root()), agent = store.create('Reviewer')
  expect(() => store.create('reviewer')).toThrow('already exists')
  expect(new AgentEpisodeStore(root()).resolve('Reviewer')).toBeUndefined()
  const input = { id: 'episode-1', agentId: agent.id, policy: writePolicy, task: 'inspect', contextGeneration: 0,
    binding: { workspaceId: 'task', generation: 1, worktreePath: '/owned', consistency: 'moving' as const }, parentConversation: { branchId: 'main', boundary: 0 } }
  const episode = store.begin(input)
  expect(store.begin(input)).toEqual(episode)
  expect(() => store.begin({ ...input, task: 'changed' })).toThrow('idempotency')
  expect(() => store.begin({ ...input, id: 'episode-2' })).toThrow('already owns')
  expect(() => store.complete(episode.id, 1, {})).toThrow('Stale')
  const result = store.complete(episode.id, 0, { nativeContextRevision: 4 })
  expect(store.complete(episode.id, 0, { nativeContextRevision: 4 })).toEqual(result)
  expect(() => store.complete(episode.id, 0, {})).toThrow('immutable')
  expect(store.resolve('Reviewer')).toMatchObject({ state: 'dormant', contextGeneration: 1 })
  store.begin({ ...input, id: 'episode-2', contextGeneration: 1 })
  store.interruptOrphans()
  expect(store.read().episodes.at(-1)?.state).toBe('interrupted')
  expect(store.resolve(agent.id)?.contextGeneration).toBe(2)
})
it('retains explicit context reset across interrupted fresh recall without reviving old publication', () => {
  const store = new AgentEpisodeStore(root()), agent = store.create('Context owner')
  const input = { id: 'context-first', agentId: agent.id, policy: writePolicy, task: 'old instructions', contextGeneration: 0,
    binding: { workspaceId: 'task', generation: 1, worktreePath: '/owned', consistency: 'moving' as const }, parentConversation: { branchId: 'main', boundary: 1, prefixHash: 'old-prefix' } }
  store.begin(input)
  store.complete(input.id, 0, {}, 'completed', { version: 2, agentId: agent.id, worktreePath: '/owned', task: 'old', assignment: {}, messages: [], history: [], runState: 'idle', updatedAt: new Date().toISOString() })
  expect(store.contextSource(agent.id)?.episode.id).toBe(input.id)
  store.begin({ ...input, id: 'context-fresh', contextGeneration: 1, request: { name: agent.name, contextMode: 'fresh' }, parentConversation: { branchId: 'other', boundary: 1, prefixHash: 'new-prefix' } })
  store.interruptOrphans()
  expect(store.contextSource(agent.id)).toBeUndefined()
})
