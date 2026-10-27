import { useEffect, useState } from 'react'
import { resolveActiveProject, type ActiveProject } from '../lib/activeProject'
import { isNewEmptyThread, localWorkspaceFor } from '../lib/newThread'
import { useAppStore } from '../stores/appStore'

async function resolveWorkspaceProjectPath(threadId: string | null): Promise<string | null> {
  if (!threadId) return window.mousse.app.getActiveProjectPath(threadId)
  try {
    const status = await window.mousse.workspace.getStatus(threadId) as {
      execution?: { projectPath?: string; lifecycle?: string }
    }
    if (status.execution?.projectPath && status.execution.lifecycle === 'ready') {
      return status.execution.projectPath
    }
  } catch {
    // Legacy/standalone threads keep the existing project-path behavior.
  }
  return window.mousse.app.getActiveProjectPath(threadId)
}

/**
 * The project and folder the selected thread works on. A new, empty thread
 * follows the composer's project pick, so every surface agrees with the card.
 * Keeps unresolved lookups distinct from a confirmed standalone thread.
 */
export function useActiveProjectLocation(): ActiveProject {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const profileId = useAppStore((s) => s.profileId)
  const projects = useAppStore((s) => s.projects)
  const threadProjectId = useAppStore((s) => s.threads.find((thread) => thread.id === s.activeThreadId)?.projectId ?? null)
  const isNewChat = useAppStore((s) => isNewEmptyThread(
    s.activeThreadId,
    s.threads.find((thread) => thread.id === s.activeThreadId),
    s.messages.length
  ))
  const draftProjectId = useAppStore((s) => localWorkspaceFor(
    s.composerWorkspaceDrafts[s.activeThreadId ?? '__blank__'],
    s.threads.find((thread) => thread.id === s.activeThreadId)
  ).projectId)
  const scope = `${profileId}:${activeThreadId ?? '__blank__'}`
  const [resolved, setResolved] = useState<{ scope: string; path: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    void resolveWorkspaceProjectPath(activeThreadId).then((path) => {
      if (!cancelled) setResolved({ scope, path })
    }).catch(() => { if (!cancelled) setResolved({ scope, path: null }) })
    return () => { cancelled = true }
  }, [activeThreadId, profileId, scope])

  return resolveActiveProject({
    isNewChat,
    draftProjectId,
    threadProjectId,
    projects,
    resolved: resolved?.scope === scope ? { path: resolved.path, loading: false } : { path: null, loading: true }
  })
}

export function useActiveProjectPath(): string | null {
  return useActiveProjectLocation().path
}

export function useFilesRoot(): { root: string; label: string } {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const profileId = useAppStore((s) => s.profileId)
  const [root, setRoot] = useState('')
  const [label, setLabel] = useState('~')

  useEffect(() => {
    let cancelled = false
    setRoot('')
    setLabel('~')
    void window.mousse.app.getFilesRoot(activeThreadId).then((filesRoot) => {
      if (cancelled) return
      setRoot(filesRoot)
      setLabel(filesRoot || '~')
    }).catch(() => { if (!cancelled) setRoot('') })
    return () => { cancelled = true }
  }, [activeThreadId, profileId])

  return { root, label }
}
