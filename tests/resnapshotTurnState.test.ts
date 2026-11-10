/**
 * After a gap in a window's events the window reads the open thread again. The turn state it gets must be the
 * daemon's own (with its phase): the older shape had no phase, so a turn that runs but has not streamed yet read as
 * idle, the composer showed idle, and its steer key queued the text instead of steering.
 */
import { describe, expect, it } from 'vitest'
import { resnapshotTurnState } from '../src/main/ipc/resnapshotTurnState'
import type { TurnState } from '../src/shared/types'

const phase = (state: TurnState) => (state as { phase?: string }).phase

describe('the turn state a window gets again after a gap in its events', () => {
  it("is the daemon's own, with its phase, for a turn that runs but has not streamed yet", () => {
    const turnState = { threadId: 't1', turnId: 'turn-1', phase: 'thinking', updatedAt: '2026-11-11T00:00:00.000Z' } as TurnState
    const state = resnapshotTurnState('t1', { activeTurn: { active: false, running: true }, turnState })
    expect(phase(state)).toBe('thinking')
    expect(state).toBe(turnState)
  })

  it('falls back to the older shape only when the snapshot has no turn state for the thread', () => {
    expect(resnapshotTurnState('t1', { activeTurn: { active: true, running: true } })).toEqual({ threadId: 't1', state: 'processing' })
    expect(resnapshotTurnState('t1', { activeTurn: { active: false } })).toEqual({ threadId: 't1', state: 'idle' })
    // Another thread's state is never taken for this one.
    const other = { threadId: 't2', phase: 'thinking' } as TurnState
    expect(resnapshotTurnState('t1', { turnState: other })).toEqual({ threadId: 't1', state: 'idle' })
  })
})
