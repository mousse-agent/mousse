import { useCallback, useRef, useState } from 'react'
import type { GitAction } from '../sideCard/gitSectionLogic'

/** One Git action at a time on a surface: `begin` claims it (false when another runs), `end` gives it back. */
export function useGitActionRunner(): { running: GitAction | null; begin: (action: GitAction) => boolean; end: () => void } {
  const [running, setRunning] = useState<GitAction | null>(null)
  // The ref answers a second click before the state has rendered.
  const runningRef = useRef<GitAction | null>(null)
  const begin = useCallback((action: GitAction) => {
    if (runningRef.current) return false
    runningRef.current = action
    setRunning(action)
    return true
  }, [])
  const end = useCallback(() => {
    runningRef.current = null
    setRunning(null)
  }, [])
  return { running, begin, end }
}
