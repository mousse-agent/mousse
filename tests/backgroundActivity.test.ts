import { describe, expect, it } from 'vitest'
import {
  collectBackgroundActivity,
  shouldRetainProcessForBackground,
  type BackgroundActivitySnapshot
} from '../src/mms/lifecycle/backgroundActivity'

describe('backgroundActivity', () => {
  const idle: BackgroundActivitySnapshot = {
    hasActiveOrchestratorTurn: false,
    hasChannelTurn: false,
    hasRunningAgents: false,
    hasLivePtys: false,
    hasRunningSchedulerJobs: false,
    hasConnectedChannels: false
  }

  it('does not retain for merely configured paused/completed jobs', () => {
    const snapshot = collectBackgroundActivity({
      listScheduledJobs: () => [
        { state: 'paused' },
        { state: 'completed' },
        { state: 'scheduled' },
        { state: 'error' }
      ],
      listAgentStatuses: () => [{ status: 'completed' }, { status: 'failed' }],
      listChannelStatuses: () => [{ state: 'disconnected' }],
      listLivePtys: () => []
    })
    expect(shouldRetainProcessForBackground(snapshot)).toBe(false)
  })

  it('retains for active orchestrator turn', () => {
    expect(
      shouldRetainProcessForBackground({ ...idle, hasActiveOrchestratorTurn: true })
    ).toBe(true)
  })

  it('retains for running agent / live PTY / channel turn / running job / connected channel', () => {
    expect(shouldRetainProcessForBackground({ ...idle, hasRunningAgents: true })).toBe(true)
    expect(shouldRetainProcessForBackground({ ...idle, hasLivePtys: true })).toBe(true)
    expect(shouldRetainProcessForBackground({ ...idle, hasChannelTurn: true })).toBe(true)
    expect(shouldRetainProcessForBackground({ ...idle, hasRunningSchedulerJobs: true })).toBe(true)
    expect(shouldRetainProcessForBackground({ ...idle, hasConnectedChannels: true })).toBe(true)
  })

  it('collect maps agent and channel statuses correctly', () => {
    const snapshot = collectBackgroundActivity({
      isOrchestratorTurnRunning: () => false,
      listAgentStatuses: () => [{ status: 'running' }],
      listLivePtys: () => [{ ptyId: '1' }],
      listScheduledJobs: () => [{ state: 'running' }],
      listChannelStatuses: () => [{ state: 'connected' }]
    })
    expect(snapshot.hasRunningAgents).toBe(true)
    expect(snapshot.hasLivePtys).toBe(true)
    expect(snapshot.hasRunningSchedulerJobs).toBe(true)
    expect(snapshot.hasConnectedChannels).toBe(true)
  })
})
