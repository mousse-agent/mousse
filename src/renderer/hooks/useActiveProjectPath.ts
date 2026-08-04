import { useEffect, useState } from 'react'
import { useAppStore } from '../stores/appStore'

export function useActiveProjectPath(): string | null {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const [projectPath, setProjectPath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setProjectPath(null)
    void window.mousse.app.getActiveProjectPath(activeThreadId).then((path) => {
      if (!cancelled) setProjectPath(path)
    })
    return () => {
      cancelled = true
    }
  }, [activeThreadId])

  return projectPath
}

export function useFilesRoot(): { root: string; label: string } {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const [root, setRoot] = useState('')
  const [label, setLabel] = useState('~')

  useEffect(() => {
    let cancelled = false
    // Never expose the previous thread's cwd while the next one is resolving.
    setRoot('')
    setLabel('~')
    void Promise.all([
      window.mousse.app.getFilesRoot(activeThreadId),
      window.mousse.app.getActiveProjectPath(activeThreadId)
    ]).then(([filesRoot, selectedProject]) => {
      if (cancelled) return
      setRoot(filesRoot)
      setLabel(selectedProject ?? '~')
    })
    return () => {
      cancelled = true
    }
  }, [activeThreadId])

  return { root, label }
}
