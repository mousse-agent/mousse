import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UPSTREAM_CHECK_INTERVAL_MS,
  checkUpstream,
  forgetUpstreamCheck,
  useUpstreamCheckStore
} from '../src/renderer/stores/upstreamCheckStore'
import type { GitScope, GitUpstreamCheck } from '../src/shared/types'

const SCOPE: GitScope = { projectId: 'p1', workspaceThreadId: null }
const CHECKED: GitUpstreamCheck = { state: 'checked', branch: 'main', head: 'a'.repeat(40), ahead: 0, behind: 2, checkedAt: 1 }

let ask: ReturnType<typeof vi.fn>

beforeEach(() => {
  ask = vi.fn(async () => CHECKED)
  vi.stubGlobal('window', { mousse: { git: { checkUpstream: ask } } })
  useUpstreamCheckStore.setState({ entries: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('upstream check store', () => {
  it('asks once per interval, and again at once after a pull or push forgets the look', async () => {
    await checkUpstream('/repo/a', SCOPE, { now: 0 })
    await checkUpstream('/repo/a', SCOPE, { now: UPSTREAM_CHECK_INTERVAL_MS - 1 })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(useUpstreamCheckStore.getState().entries['/repo/a']?.check).toEqual(CHECKED)

    await checkUpstream('/repo/a', SCOPE, { now: UPSTREAM_CHECK_INTERVAL_MS })
    expect(ask).toHaveBeenCalledTimes(2)

    forgetUpstreamCheck('/repo/a')
    await checkUpstream('/repo/a', SCOPE, { now: UPSTREAM_CHECK_INTERVAL_MS + 1 })
    expect(ask).toHaveBeenCalledTimes(3)
  })

  it('shares one look between callers asking at the same time', async () => {
    await Promise.all([checkUpstream('/repo/a', SCOPE), checkUpstream('/repo/a', SCOPE)])
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('falls back to nothing to say when the service cannot check, as one from before the check cannot', async () => {
    ask.mockRejectedValueOnce(new Error('Unknown method git.checkUpstream'))
    await expect(checkUpstream('/repo/a', SCOPE)).resolves.toBeUndefined()
    expect(useUpstreamCheckStore.getState().entries['/repo/a']?.check).toEqual({ state: 'none' })
  })
})
