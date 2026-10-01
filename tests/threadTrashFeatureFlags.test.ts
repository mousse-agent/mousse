import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadTrashService } from '../src/mms/data/ThreadTrashService'
import { DEFAULT_FEATURE_FLAGS, validateFeatureFlags } from '../src/shared/featureFlags'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('thread trash and rollout dependencies', () => {
  it('requires the lifecycle coordinator and blocks permanent purge in Phase 1', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-trash-')); roots.push(home)
    const original = join(home, 'repositories', 'repo', 'threads', 'thread'); mkdirSync(original, { recursive: true }); writeFileSync(join(original, 'meta.json'), '{}')
    const service = new ThreadTrashService(home)
    expect(() => service.trash('thread', original)).toThrow('lifecycle coordinator')
    expect(() => service.restore('thread')).toThrow('lifecycle coordinator')
    expect(() => service.purge('thread')).toThrow('unavailable')
    expect(existsSync(original)).toBe(true)
  })

  it('refuses feature flags whose required foundation is disabled', () => {
    expect(() => validateFeatureFlags({ ...DEFAULT_FEATURE_FLAGS, latestTurnUndo: true })).toThrow('requires publish')
    expect(() => validateFeatureFlags({
      ...DEFAULT_FEATURE_FLAGS,
      subagentLifecycleV2: true,
      repositoryCoordination: true,
      externalThreadStorage: true,
      transactionalThreadStore: true,
      threadWorkspaces: true,
      turnCheckpoints: true,
      publish: true,
      latestTurnUndo: true
    })).not.toThrow()
  })
})
