import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import { TaskWriterAuthority } from '../src/mms/agents/TaskWriterAuthority'
import { createAgentToolAccess } from '../src/mms/agents/WorkspaceAccessPolicy'
import { tryAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { createPolicyTempRoot, createOutsideSecretLayout, nativeClient, providerResponse, removeOwnedPolicyTempRoots } from './fixtures/agent-platform/agent-runtime-policy/helpers'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); await removeOwnedPolicyTempRoots() })
const writePolicy = { version: 1, workspace: 'shared', access: 'write' } as const
function root(): string { const dir = mkdtempSync(join(tmpdir(), 'agent-episode-')); roots.push(dir); return dir }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }

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
