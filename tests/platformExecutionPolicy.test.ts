import { describe, expect, it } from 'vitest'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { CancellationRegistry } from '../src/mms/execution/CancellationRegistry'
import type { ExecutionContext, ExecutionEffect } from '../src/shared/execution/types'

const service = new ExecutionPolicyService()
const policy = service.snapshot('a', { allowedTools: ['read', 'write'], allowedCapabilities: ['browser'], allowedEffects: ['read', 'write', 'unknown'], approvalEffects: ['write'] })
const context: ExecutionContext = { profileId: 'a', threadId: 't', turnId: 'turn', actor: { kind: 'main' }, policySnapshotId: policy.id, source: 'gui', cancellationId: 'c' }
const read: ExecutionEffect = { toolId: 'read', classification: 'read', requestDigest: 'digest', description: 'Read fixture' }

describe('execution authority and cancellation', () => {
  it('intersects authority without lower layers expanding it', () => {
    const narrowed = service.snapshot('a', { allowedTools: ['read', 'write'], allowedCapabilities: ['browser'], allowedEffects: ['read', 'write'], maxToolCalls: 20 },
      { allowedTools: ['read', 'invented'], allowedCapabilities: ['browser', 'shell'], allowedEffects: ['read', 'external'], maxToolCalls: 40 })
    expect(narrowed.allowedTools).toEqual(['read'])
    expect(narrowed.allowedCapabilities).toEqual(['browser'])
    expect(narrowed.allowedEffects).toEqual(['read'])
    expect(narrowed.maxToolCalls).toBe(20)
    expect(Object.isFrozen(narrowed.allowedTools)).toBe(true)
    expect(service.snapshot('a', {}).allowedTools).toEqual([])
  })
  it('pins policy/profile and requires approval for effects even in unattended runs', () => {
    expect(service.authorize(context, policy, read).status).toBe('allowed')
    expect(service.authorize({ ...context, profileId: 'b' }, policy, read)).toEqual({ status: 'denied', code: 'profile_mismatch' })
    expect(service.authorize({ ...context, policySnapshotId: 'forged' }, policy, read)).toEqual({ status: 'denied', code: 'policy_mismatch' })
    expect(service.authorize({ ...context, source: 'schedule' }, policy, { ...read, toolId: 'write', classification: 'write' })).toMatchObject({ status: 'approval-required', unattended: true, requestDigest: 'digest' })
    expect(service.authorize(context, policy, { ...read, classification: 'unknown' }).status).toBe('approval-required')
  })
  it('rejects unavailable tool/capability and honors explicit deny', () => {
    expect(service.authorize(context, policy, { ...read, toolId: 'forged' })).toEqual({ status: 'denied', code: 'tool_denied' })
    expect(service.authorize(context, policy, { ...read, capability: 'shell' })).toEqual({ status: 'denied', code: 'capability_denied' })
    expect(service.snapshot('a', { allowedTools: ['read'] }, { deniedTools: ['read'] }).allowedTools).toEqual([])
    expect(() => service.snapshot('a', { maxElapsedMs: Infinity })).toThrow('Invalid execution policy limit')
  })
  it('has stable snapshots for equivalent set ordering', () => {
    expect(service.snapshot('a', { allowedTools: ['a', 'b'] }).id).toBe(service.snapshot('a', { allowedTools: ['b', 'a', 'a'] }).id)
    expect(service.snapshot('b', { allowedTools: ['a', 'b'] }).id).not.toBe(service.snapshot('a', { allowedTools: ['a', 'b'] }).id)
  })
  it('propagates cancellation to children, refuses cross-profile use and detaches released contexts', () => {
    const registry = new CancellationRegistry()
    const parent = registry.create('a')
    const child = registry.create('a', parent.id)
    expect(() => registry.resolve('b', parent.id)).toThrow('Unknown cancellation context')
    expect(() => registry.create('b', parent.id)).toThrow('Unknown cancellation context')
    registry.abort('a', parent.id, 'stop')
    expect(child.signal.aborted).toBe(true)
    expect(child.signal.reason).toBe('stop')
    const late = registry.create('a', parent.id)
    expect(late.signal.aborted).toBe(true)
    registry.release('a', child.id)
    expect(() => registry.resolve('a', child.id)).toThrow('Unknown cancellation context')
    registry.release('a', late.id)
    registry.release('a', parent.id)
  })

  it('rebuilds a durable parent link before restoring a child after restart', () => {
    const registry = new CancellationRegistry()
    const parentId = 'parent-cancellation'
    const childId = 'child-cancellation'
    registry.restore('a', parentId)
    const child = registry.restore('a', childId, parentId)
    registry.abort('a', parentId, 'restart cancellation')
    expect(child.aborted).toBe(true)
    expect(child.reason).toBe('restart cancellation')
    expect(() => registry.restore('a', childId, 'different-parent')).toThrow('Cancellation parent mismatch')
  })
})
