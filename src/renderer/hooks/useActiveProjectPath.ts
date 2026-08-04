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
  const [projectPath, setProjectPath] = useState<string | null>(null)

  useEffect(() => {
    void resolveWorkspaceProjectPath(activeThreadId).then(setProjectPath)
  }, [activeThreadId])

  return projectPath
}

export function useFilesRoot(): { root: string; label: string } {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const [root, setRoot] = useState('')
  const [label, setLabel] = useState('~')

  useEffect(() => {
    void Promise.all([
      resolveWorkspaceProjectPath(activeThreadId),
      window.mousse.app.getFilesRoot(activeThreadId)
    ]).then(([workspaceProject, legacyFilesRoot]) => {
      setRoot(workspaceProject ?? legacyFilesRoot)
      setLabel(workspaceProject ?? '~')
    })
  }, [activeThreadId])

  return { root, label }
}
