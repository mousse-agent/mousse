import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Bot, GitBranch, Sparkles } from 'lucide-react'
import type { Thread } from '../../shared/types'
import { isActiveAgentStatus } from '../../shared/types'
import {
  formatEffortLabel,
  parseThinkingSuffixFromModelId
} from '../../shared/modelVariants'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { ProviderIcon } from '../lib/providerIcons'
import { useAppStore } from '../stores/appStore'

const HOVER_OPEN_DELAY_MS = 420
const HOVER_CLOSE_DELAY_MS = 120

interface DefaultModel {
  llmProvider: string
  model: string
}

interface WorkspaceHoverInfo {
  branchLabel: string | null
  worktreePath: string | null
  lifecycle: string | null
  primaryBranch: string | null
}

function shortBranchLabel(branch?: string | null, fallback?: string | null): string | null {
  const raw = (branch && branch.trim()) || (fallback && fallback.trim()) || ''
  if (!raw) return null
  const parts = raw.split('/').filter(Boolean)
  return parts[parts.length - 1] || raw
}

function formatModelLabel(modelId: string): string {
  if (!modelId) return 'Default model'
  const { baseId, effort } = parseThinkingSuffixFromModelId(modelId)
  if (effort && effort !== 'off') {
    return `${baseId} · ${formatEffortLabel(effort)}`
  }
  return baseId
}

function basenamePath(path: string | null | undefined): string | null {
  if (!path) return null
  const normalized = path.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

export interface ThreadHoverCardProps {
  thread: Thread
  /** When false, force-close (e.g. context menu open / dragging). */
  enabled?: boolean
  children: (handlers: {
    onMouseEnter: () => void
    onMouseLeave: () => void
    anchorRef: RefObject<HTMLDivElement | null>
  }) => ReactNode
}

export function ThreadHoverCard({ thread, enabled = true, children }: ThreadHoverCardProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const requestIdRef = useRef(0)

  const [open, setOpen] = useState(false)
  const [defaultModel, setDefaultModel] = useState<DefaultModel | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceHoverInfo | null>(null)
  const [agentCount, setAgentCount] = useState<number | null>(null)

  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const activeAgents = useAppStore((s) => s.agents)

  const providerId = thread.modelOverride?.llmProvider || defaultModel?.llmProvider || ''
  const modelId = thread.modelOverride?.model || defaultModel?.model || ''
  const modelLabel = formatModelLabel(modelId)
  const modelIsOverride = Boolean(thread.modelOverride?.model)

  const floatingStyle = useFloatingPosition({
    open,
    anchorRef,
    contentRef: cardRef,
    placement: 'right-start',
    gap: 10,
    deps: [thread.id, thread.name, modelLabel, workspace?.branchLabel, agentCount]
  })

  const clearTimers = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const loadHoverData = async (threadId: string) => {
    const requestId = ++requestIdRef.current

    // Default model (cached after first successful load).
    if (!defaultModel) {
      try {
        const settings = await window.mousse.settings.get()
        if (requestId !== requestIdRef.current) return
        const llmProvider = settings?.provider?.llmProvider ?? ''
        const model = settings?.provider?.model ?? ''
        if (llmProvider || model) {
          setDefaultModel({ llmProvider, model })
        }
      } catch {
        // Keep card usable without settings.
      }
    }

    // Workspace / branch details.
    try {
      const status = (await window.mousse.workspace.getStatus(threadId)) as {
        metadata?: {
          branch?: string
          conversationBranchId?: string
          worktreePath?: string
          lifecycle?: string
        } | null
        execution?: {
          branch?: string
          workspacePath?: string
          lifecycle?: string
        }
      }
      if (requestId !== requestIdRef.current) return
      const branchLabel =
        shortBranchLabel(status.metadata?.branch, status.execution?.branch) ??
        shortBranchLabel(status.metadata?.conversationBranchId) ??
        null
      setWorkspace({
        branchLabel,
        worktreePath: status.metadata?.worktreePath ?? status.execution?.workspacePath ?? null,
        lifecycle: status.metadata?.lifecycle ?? status.execution?.lifecycle ?? null,
        primaryBranch: shortBranchLabel(status.execution?.branch)
      })
    } catch {
      if (requestId !== requestIdRef.current) return
      setWorkspace(null)
    }

    // Subagent count — use live store for the active thread.
    if (threadId === activeThreadId) {
      const count = activeAgents.filter((agent) => isActiveAgentStatus(agent.status)).length
      if (requestId !== requestIdRef.current) return
      setAgentCount(count)
      return
    }

    try {
      const agents = await window.mousse.agents.list(threadId)
      if (requestId !== requestIdRef.current) return
      setAgentCount(agents.filter((agent) => isActiveAgentStatus(agent.status)).length)
    } catch {
      if (requestId !== requestIdRef.current) return
      setAgentCount(null)
    }
  }

  const scheduleOpen = () => {
    if (!enabled) return
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (open) return
    if (openTimerRef.current !== null) return
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      setOpen(true)
      void loadHoverData(thread.id)
    }, HOVER_OPEN_DELAY_MS)
  }

  const scheduleClose = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) return
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setOpen(false)
    }, HOVER_CLOSE_DELAY_MS)
  }

  // Keep active-thread agent count live while open.
  useEffect(() => {
    if (!open || thread.id !== activeThreadId) return
    setAgentCount(activeAgents.filter((agent) => isActiveAgentStatus(agent.status)).length)
  }, [open, thread.id, activeThreadId, activeAgents])

  // Force-close when disabled (drag / context menu).
  useEffect(() => {
    if (enabled) return
    clearTimers()
    setOpen(false)
  }, [enabled])

  // Refresh when the hovered thread identity changes while open.
  useEffect(() => {
    if (!open) return
    void loadHoverData(thread.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only on thread switch
  }, [thread.id])

  useEffect(() => {
    return () => {
      clearTimers()
      requestIdRef.current += 1
    }
  }, [])

  const worktreeRow = (() => {
    if (!thread.worktreeEnabled) {
      if (workspace?.primaryBranch) {
        return {
          icon: 'branch' as const,
          label: workspace.primaryBranch,
          detail: 'Primary checkout'
        }
      }
      return null
    }
    const branch = workspace?.branchLabel
    const folder = basenamePath(workspace?.worktreePath)
    if (branch) {
      return {
        icon: 'branch' as const,
        label: branch,
        detail: folder ? `Worktree · ${folder}` : 'Isolated worktree'
      }
    }
    if (workspace?.lifecycle && workspace.lifecycle !== 'ready') {
      return {
        icon: 'branch' as const,
        label: 'Worktree',
        detail: workspace.lifecycle.replace(/_/g, ' ')
      }
    }
    return {
      icon: 'branch' as const,
      label: 'Isolated worktree',
      detail: null
    }
  })()

  return (
    <>
      {children({
        anchorRef,
        onMouseEnter: scheduleOpen,
        onMouseLeave: scheduleClose
      })}
      {open && (
        <FloatingPortal>
          <div
            ref={cardRef}
            className="thread-hover-card"
            role="tooltip"
            style={floatingStyle}
            onMouseEnter={() => {
              if (closeTimerRef.current !== null) {
                window.clearTimeout(closeTimerRef.current)
                closeTimerRef.current = null
              }
            }}
            onMouseLeave={scheduleClose}
          >
            <div className="thread-hover-card-title">{thread.name}</div>

            <div className="thread-hover-card-rows">
              {worktreeRow && (
                <div className="thread-hover-card-row">
                  <span className="thread-hover-card-icon" aria-hidden="true">
                    <GitBranch size={13} strokeWidth={2} />
                  </span>
                  <div className="thread-hover-card-row-text">
                    <span className="thread-hover-card-row-label">{worktreeRow.label}</span>
                    {worktreeRow.detail && (
                      <span className="thread-hover-card-row-detail">{worktreeRow.detail}</span>
                    )}
                  </div>
                </div>
              )}

              <div className="thread-hover-card-row">
                <span className="thread-hover-card-icon" aria-hidden="true">
                  {providerId ? (
                    <ProviderIcon providerId={providerId} size={13} />
                  ) : (
                    <Sparkles size={13} strokeWidth={2} />
                  )}
                </span>
                <div className="thread-hover-card-row-text">
                  <span className="thread-hover-card-row-label">{modelLabel}</span>
                  <span className="thread-hover-card-row-detail">
                    {modelIsOverride ? 'Thread model' : 'Default model'}
                  </span>
                </div>
              </div>

              {agentCount !== null && agentCount > 0 && (
                <div className="thread-hover-card-row">
                  <span className="thread-hover-card-icon" aria-hidden="true">
                    <Bot size={13} strokeWidth={2} />
                  </span>
                  <div className="thread-hover-card-row-text">
                    <span className="thread-hover-card-row-label">
                      {agentCount} {agentCount === 1 ? 'subagent' : 'subagents'}
                    </span>
                    <span className="thread-hover-card-row-detail">Active</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
