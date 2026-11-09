import { useCallback, useEffect, useState } from 'react'
import { createPersonalBotsClient } from '../../services/personalBotsClient'
import { EMPTY_LIBRARY, libraryFrom, type AutomationLibrary } from './whoDo'

/** The person's bots, which fill an automation's Who. A list that cannot be read is left empty. */
export function useAutomationLibrary(profileId: string): { library: AutomationLibrary; reload: () => void } {
  const [library, setLibrary] = useState<AutomationLibrary>(EMPTY_LIBRARY)
  const load = useCallback(async () => {
    const request = window.mousse?.platformRequest
    if (!request || !profileId) return
    const bots = await createPersonalBotsClient(request).list().catch(() => [])
    setLibrary(libraryFrom({ bots }))
  }, [profileId])
  useEffect(() => { void load() }, [load])
  const reload = useCallback(() => { void load() }, [load])
  return { library, reload }
}
