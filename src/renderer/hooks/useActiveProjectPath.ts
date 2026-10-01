import { useEffect, useState } from 'react'
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

export function useActiveProjectPath(): string | null {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const profileId = useAppStore((s) => s.profileId)
  const [projectPath, setProjectPath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setProjectPath(null)
    void resolveWorkspaceProjectPath(activeThreadId).then((path) => {
      if (!cancelled) setProjectPath(path)
    }).catch(() => { if (!cancelled) setProjectPath(null) })
    return () => { cancelled = true }
  }, [activeThreadId, profileId])

  return projectPath
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
