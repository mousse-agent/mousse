/**
 * Narrow, pure helper: should the main process retain itself when windows close?
 * Ready to repoint at MmsClient later — no Electron imports.
 */

export interface BackgroundActivitySnapshot {
  hasActiveOrchestratorTurn: boolean
  hasChannelTurn: boolean
  hasRunningAgents: boolean
  hasLivePtys: boolean
  hasRunningSchedulerJobs: boolean
  hasConnectedChannels: boolean
}

/**
 * True when actual background work exists that should keep the process alive
 * (hide window / skip quit). Merely configured paused/completed jobs do not count.
 */
export function shouldRetainProcessForBackground(
  snapshot: BackgroundActivitySnapshot
): boolean {
  return (
    snapshot.hasActiveOrchestratorTurn ||
    snapshot.hasChannelTurn ||
    snapshot.hasRunningAgents ||
    snapshot.hasLivePtys ||
    snapshot.hasRunningSchedulerJobs ||
    snapshot.hasConnectedChannels
  )
}

/** Collect snapshot from an MMS-like surface (GUI main or future client). */
export function collectBackgroundActivity(sources: {
  isOrchestratorTurnRunning?: () => boolean
  isAnyChannelTurnActive?: () => boolean
  listAgentStatuses?: () => Array<{ status: string }>
  listLivePtys?: () => unknown[]
  listScheduledJobs?: () => Array<{ state?: string }>
  listChannelStatuses?: () => Array<{ state?: string }>
}): BackgroundActivitySnapshot {
  const agents = sources.listAgentStatuses?.() ?? []
  const jobs = sources.listScheduledJobs?.() ?? []
  const channels = sources.listChannelStatuses?.() ?? []
  const ptys = sources.listLivePtys?.() ?? []

  return {
    hasActiveOrchestratorTurn: Boolean(sources.isOrchestratorTurnRunning?.()),
    hasChannelTurn: Boolean(sources.isAnyChannelTurnActive?.()),
    hasRunningAgents: agents.some(
      (a) => a.status === 'running' || a.status === 'starting' || a.status === 'merging'
    ),
    hasLivePtys: ptys.length > 0,
    hasRunningSchedulerJobs: jobs.some((j) => j.state === 'running'),
    hasConnectedChannels: channels.some(
      (c) => c.state === 'connected' || c.state === 'connecting'
    )
  }
}
