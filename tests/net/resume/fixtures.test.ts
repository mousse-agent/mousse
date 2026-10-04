import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isNetErrorCode } from '../../../src/shared/net/errors'

const bytes = readFileSync(new URL('../../../test-vectors/net/resume/cases.json', import.meta.url))
const fixture = JSON.parse(bytes.toString('utf8'))

describe('P0 resume vector integrity (not module conformance)', () => {
  it('loads bounded unique ordered cases and well-formed position ranges', () => {
    expect(bytes.length).toBeLessThan(64 * 1024)
    expect(fixture.version).toBe(1)
    expect(fixture.cases.length).toBe(6)
    expect(new Set(fixture.cases.map((item: { id: string }) => item.id)).size).toBe(6)
    for (const item of fixture.cases) {
      for (const cursor of [
        item.initial,
        item.expected.cursor,
        ...item.checkpoints.map((point: { cursor: unknown }) => point.cursor)
      ]) {
        expect(Number.isSafeInteger(cursor.epoch) && cursor.epoch > 0).toBe(true)
        expect(Number.isSafeInteger(cursor.seq) && cursor.seq >= 0).toBe(true)
      }
      for (const action of item.actions) {
        if (action.kind === 'subscribed') expect(action.head).toBe(action.through)
        if (action.first !== undefined)
          expect(action.first > 0 && action.last >= action.first).toBe(true)
      }
      for (const checkpoint of item.checkpoints)
        expect(checkpoint.afterAction >= 0 && checkpoint.afterAction < item.actions.length).toBe(
          true
        )
      if (item.expected.error) expect(isNetErrorCode(item.expected.error)).toBe(true)
    }
  })
  it('retains explicit gap, multi-epoch, crash and overlap oracles for P1', () => {
    const cases = new Map<string, any>(fixture.cases.map((item: { id: string }) => [item.id, item]))
    expect(cases.get('live-before-replay-cut-and-resume').checkpoints[1].cursor).toEqual({
      epoch: 1,
      seq: 89
    })
    expect(cases.get('caught-up-cannot-skip-gap').expected.subscribeAfter).toBe(89)
    expect(
      cases.get('epoch-reuses-sequence-only-through-complete-meta-snapshot').expected
        .preserveOriginalEpochs
    ).toBe(true)
    expect(
      cases.get('epoch-reuses-sequence-only-through-complete-meta-snapshot').actions[2]
    ).toMatchObject({ epoch: 1, first: 1, last: 2, role: 'fullPriorFrozenMetaPrefix' })
    expect(
      cases.get('epoch-reuses-sequence-only-through-complete-meta-snapshot').actions[3]
        .previousSafeHead
    ).toEqual({ epoch: 1, seq: 2 })
    expect(
      cases.get('large-incomplete-staging-crash-keeps-active-generation').expected.stagingDiscarded
    ).toBe(true)
    expect(cases.get('overlap-row-overflow-resumes-durable-cursor').expected.subscribeAfter).toBe(0)
  })
})
