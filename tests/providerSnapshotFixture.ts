import type { InstanceSnapshot } from '../src/shared/harness/status'
import type { InstanceModel } from '../src/shared/harness/types'

export type SnapshotOverrides = {
  [K in keyof InstanceSnapshot]?: InstanceSnapshot[K] extends object ? Partial<InstanceSnapshot[K]> : InstanceSnapshot[K]
}

/** A checked, enabled, signed-in Claude Code instance; each test changes what it needs. */
export function snapshot(overrides: SnapshotOverrides = {}): InstanceSnapshot {
  const base: InstanceSnapshot = {
    instanceId: 'claude',
    driver: 'claude',
    displayName: 'Claude Code',
    builtIn: true,
    scope: { kind: 'device' },
    enabled: { device: true, effective: true, setBy: 'device' },
    install: { state: 'installed', canInstall: false },
    runs: { state: 'yes' },
    auth: { state: 'signed_in', account: { id: 'acct-1', label: 'Max plan' } },
    compatibility: { state: 'tested' },
    binary: { path: '/usr/local/bin/claude', version: '2.1.0', source: 'path', owner: 'npm' },
    caps: {
      steer: 'native', interrupt: true, rollback: 'none', fork: 'native', events: 'rich',
      containment: 'weak', historyInjection: 'native', mcp: true, childPolicy: 'enforced', planMode: true, contextUsage: 'reported'
    },
    models: { entries: [], source: 'live' },
    checkedAt: '2026-10-25T10:00:00.000Z',
    stale: false,
    lastGoodAt: '2026-10-25T10:00:00.000Z'
  }
  const merged = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(overrides)) {
    const current = (base as unknown as Record<string, unknown>)[key]
    merged[key] = value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object'
      ? { ...current, ...value }
      : value
  }
  return merged as unknown as InstanceSnapshot
}

export function model(id: string, patch: Partial<InstanceModel> = {}): InstanceModel {
  return { id, label: id, source: 'catalog', capabilities: { efforts: [], images: false }, hidden: false, favorite: false, ...patch }
}
