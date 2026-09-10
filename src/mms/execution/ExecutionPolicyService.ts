import { createHash } from 'node:crypto'
import type { AuthorizationDecision, EffectClass, ExecutionContext, ExecutionEffect, ExecutionPolicyLayer, ExecutionPolicySnapshot } from '../../shared/execution/types'

const EFFECTS: readonly EffectClass[] = ['pure', 'read', 'write', 'external', 'unknown']
const DEFAULT_LIMITS = { maxToolCalls: 100, maxElapsedMs: 30 * 60_000, maxArtifactBytes: 50 * 1024 * 1024 }

function intersect(base: readonly string[], layers: readonly (readonly string[] | undefined)[]): string[] {
  return [...new Set(base)].filter((entry) => layers.every((layer) => layer === undefined || layer.includes(entry))).sort()
}
function limit(layers: readonly ExecutionPolicyLayer[], key: keyof typeof DEFAULT_LIMITS): number {
  return Math.min(...layers.map((layer, index) => {
    const value = layer[key]
    if (value === undefined) return index === 0 ? DEFAULT_LIMITS[key] : Infinity
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid execution policy limit: ' + key)
    return value
  }))
}

/** Lower-trust policy layers may only narrow authority or add approval requirements. */
export class ExecutionPolicyService {
  snapshot(profileId: string, installation: ExecutionPolicyLayer, ...restrictions: ExecutionPolicyLayer[]): ExecutionPolicySnapshot {
    if (!profileId.trim()) throw new Error('Profile identity is required')
    const layers = [installation, ...restrictions]
    const denied = new Set(layers.flatMap((layer) => [...(layer.deniedTools ?? [])]))
    const allowedTools = intersect(installation.allowedTools ?? [], restrictions.map((layer) => layer.allowedTools)).filter((tool) => !denied.has(tool))
    const allowedCapabilities = intersect(installation.allowedCapabilities ?? [], restrictions.map((layer) => layer.allowedCapabilities))
    const allowedEffects = intersect(installation.allowedEffects ?? ['pure', 'read'], restrictions.map((layer) => layer.allowedEffects)) as EffectClass[]
    if (layers.some((layer) => [...(layer.allowedEffects ?? []), ...(layer.approvalEffects ?? [])].some((effect) => !EFFECTS.includes(effect)))) throw new Error('Invalid effect class')
    const approvalEffects = [...new Set<EffectClass>(['unknown', ...layers.flatMap((layer) => [...(layer.approvalEffects ?? [])])])].sort()
    const value = {
      version: 1 as const, profileId, allowedTools: Object.freeze(allowedTools),
      allowedCapabilities: Object.freeze(allowedCapabilities), allowedEffects: Object.freeze(allowedEffects),
      approvalEffects: Object.freeze(approvalEffects),
      maxToolCalls: limit(layers, 'maxToolCalls'), maxElapsedMs: limit(layers, 'maxElapsedMs'), maxArtifactBytes: limit(layers, 'maxArtifactBytes')
    }
    const id = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    return Object.freeze({ id, ...value })
  }

  authorize(context: ExecutionContext, policy: ExecutionPolicySnapshot, effect: ExecutionEffect): AuthorizationDecision {
    if (context.profileId !== policy.profileId) return { status: 'denied', code: 'profile_mismatch' }
    if (context.policySnapshotId !== policy.id) return { status: 'denied', code: 'policy_mismatch' }
    if (!policy.allowedTools.includes(effect.toolId)) return { status: 'denied', code: 'tool_denied' }
    if (!policy.allowedEffects.includes(effect.classification)) return { status: 'denied', code: 'effect_denied' }
    if (effect.capability && !policy.allowedCapabilities.includes(effect.capability)) return { status: 'denied', code: 'capability_denied' }
    if (policy.approvalEffects.includes(effect.classification)) return {
      status: 'approval-required', policySnapshotId: policy.id, requestDigest: effect.requestDigest,
      unattended: context.source === 'schedule' || context.source === 'channel'
    }
    return { status: 'allowed', policySnapshotId: policy.id }
  }
}
