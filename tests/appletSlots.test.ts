import { describe, expect, it } from 'vitest'
import { appletToRelease, type AppletSlotHolder } from '../src/main/applets/slots'

const holder = (revisionId: string, epoch: number, extra: Partial<AppletSlotHolder> & { host?: 'transcript' | 'panel' } = {}) =>
  ({ mount: { threadId: 't', revisionId, host: extra.host ?? 'transcript' }, epoch, parkedAt: extra.parkedAt })

describe('which applet gives up its slot', () => {
  it('releases the card out of sight longest, for any new applet', () => {
    const running = [holder('a', 1), holder('b', 2, { parkedAt: 20 }), holder('c', 3, { parkedAt: 10 })]
    expect(appletToRelease(running, { threadId: 't', revisionId: 'd' })?.mount.revisionId).toBe('c')
    expect(appletToRelease(running, { threadId: 't', revisionId: 'd', host: 'panel' })?.mount.revisionId).toBe('c')
  })

  it('makes a new transcript card wait while all three are on screen', () => {
    const running = [holder('a', 1), holder('b', 2), holder('c', 3)]
    expect(appletToRelease(running, { threadId: 't', revisionId: 'd', host: 'transcript' })).toBeNull()
  })

  it('lets the side panel take the slot of the same applet on screen, else of the card that started first', () => {
    const running = [holder('a', 1), holder('b', 2), holder('c', 3)]
    expect(appletToRelease(running, { threadId: 't', revisionId: 'b', host: 'panel' })?.mount.revisionId).toBe('b')
    expect(appletToRelease(running, { threadId: 't', revisionId: 'd', host: 'panel' })?.mount.revisionId).toBe('a')
    expect(appletToRelease(running, { threadId: 'other', revisionId: 'b', host: 'panel' })?.mount.revisionId).toBe('a')
  })

  it('never takes a slot from another side panel applet', () => {
    const running = [holder('a', 1, { host: 'panel' }), holder('b', 2), holder('c', 3)]
    expect(appletToRelease(running, { threadId: 't', revisionId: 'a', host: 'panel' })?.mount.revisionId).toBe('b')
  })
})
