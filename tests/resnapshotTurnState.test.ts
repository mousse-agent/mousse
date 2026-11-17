/**
 * A window that missed events reads its open thread again (`resnapshotWindow` in registerGuiIpc). The turn state it
 * gets must be a whole TurnState with a phase: `{ threadId, state: 'processing' }` had none and read as no turn. The
 * transcript dropped Working (and the line under it) while the turn still ran, and at a turn's silent start the
 * composer read idle, so its steer key queued the text instead of steering (#873).
 */
import { describe, expect, it } from 'vitest'
import { resnapshotTurnState } from '../src/main/mms/resnapshotTurnState'
import { isTurnActivePhase, isTurnStoppable, type TurnState } from '../src/shared/types'

const NOW = new Date('2026-11-11T10:00:00Z')
const running = { active: true, running: true }
const thinking: TurnState = { threadId: 't1', turnId: 'run:1', phase: 'thinking', step: { kind: 'reasoning' }, updatedAt: NOW.toISOString() }

describe('the turn state of a window that read its thread again', () => {
  it("is the service's own state when the snapshot carries it", () => {
    const own: TurnState = { threadId: 't1', turnId: 'run:1', phase: 'tool_running', updatedAt: NOW.toISOString() }
    expect(resnapshotTurnState('t1', { turnState: own, activeTurn: running }, thinking)).toBe(own)
  })

  it("keeps the service's held steer, so the Steer block still shows what it waits for and Send now", () => {
    const own: TurnState = {
      threadId: 't1', turnId: 'run:1', phase: 'tool_running', updatedAt: NOW.toISOString(),
      heldSteer: { waitsFor: 'Bash', detail: 'sleep 30', tools: 1, since: NOW.toISOString(), holdGeneration: 2, itemIds: ['item-1'], runId: 'run:1' }
    }
    expect(resnapshotTurnState('t1', { turnState: own, activeTurn: running }, thinking).heldSteer).toEqual(own.heldSteer)
  })

  it("is the service's own, with its phase, for a turn that runs but has not streamed yet (#873)", () => {
    // At a turn's silent start the service reports it running before it is active.
    const turnState: TurnState = { threadId: 't1', turnId: 'turn-1', phase: 'thinking', updatedAt: '2026-11-11T00:00:00.000Z' }
    const state = resnapshotTurnState('t1', { activeTurn: { active: false, running: true }, turnState }, undefined)
    expect(state).toBe(turnState)
    expect(state.phase).toBe('thinking')
    // So the composer reads a turn it can steer, not idle.
    expect(isTurnStoppable(state)).toBe(true)
  })

  it('keeps the state the window has while it agrees that a turn runs, step and all', () => {
    expect(resnapshotTurnState('t1', { activeTurn: running }, thinking)).toBe(thinking)
  })

  it('has a phase that keeps a running turn running, never a bare activity', () => {
    const state = resnapshotTurnState('t1', { activeTurn: running }, undefined, NOW)
    expect(state).toEqual({ threadId: 't1', turnId: null, phase: 'thinking', updatedAt: NOW.toISOString() })
    expect(isTurnActivePhase(state.phase)).toBe(true)
    expect(state).not.toHaveProperty('state')
  })

  it('without a state from the service, a turn that runs but is not active yet still reads as running (#873)', () => {
    const state = resnapshotTurnState('t1', { activeTurn: { active: false, running: true } }, undefined, NOW)
    expect(state.phase).toBe('thinking')
    expect(state).not.toHaveProperty('state')
    // The window's own state for that turn stays.
    expect(resnapshotTurnState('t1', { activeTurn: { active: false, running: true } }, thinking, NOW)).toBe(thinking)
  })

  it('is idle once no turn is active, whatever the window had', () => {
    const state = resnapshotTurnState('t1', { activeTurn: { active: false, running: false } }, thinking, NOW)
    expect(state.phase).toBe('idle')
    expect(state.turnId).toBeNull()
    expect(resnapshotTurnState('t1', { activeTurn: { active: false } }, undefined, NOW).phase).toBe('idle')
  })

  it("never takes another thread's state for this one", () => {
    const other: TurnState = { ...thinking, threadId: 't2' }
    const state = resnapshotTurnState('t1', { turnState: other }, other, NOW)
    expect(state.threadId).toBe('t1')
    expect(state.phase).toBe('idle')
    expect(resnapshotTurnState('t1', { turnState: other, activeTurn: running }, other, NOW)).toMatchObject({ threadId: 't1', phase: 'thinking' })
  })
})
