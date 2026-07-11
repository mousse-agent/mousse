import { useEffect, useState } from 'react'
import { useAppStore } from '../stores/appStore'

export function useActiveProjectPath(): string | null {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const [projectPath, setProjectPath] = useState<string | null>(null)

  useEffect(() => {
    void window.mousse.app.getActiveProjectPath(activeThreadId).then(setProjectPath)
  }, [activeThreadId])

  return projectPath
}

export function useFilesRoot(): { root: string; label: string } {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const [root, setRoot] = useState('')
  const [label, setLabel] = useState('~')

  useEffect(() => {
    void Promise.all([
      window.mousse.app.getFilesRoot(activeThreadId),
      window.mousse.app.getActiveProjectPath(activeThreadId)
    ]).then(([filesRoot, selectedProject]) => {
      setRoot(filesRoot)
      setLabel(selectedProject ?? '~')
    })
  }, [activeThreadId])

  return { root, label }
}
