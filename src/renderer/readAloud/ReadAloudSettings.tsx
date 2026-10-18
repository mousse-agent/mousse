import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import { ReadAloudModelPicker } from './ReadAloudModelPicker'
import { useReadAloudStore } from './readAloudStore'

/** Model controls for the Settings page; a click saves the choice for this profile. */
export function ReadAloudSettings() {
  const profileId = useAppStore((state) => state.profileId)
  const selection = useReadAloudStore((state) => state.selection)
  const syncProfile = useReadAloudStore((state) => state.syncProfile)
  const setSelection = useReadAloudStore((state) => state.setSelection)

  useEffect(() => {
    syncProfile(profileId)
  }, [profileId, syncProfile])

  return (
    <div className="read-aloud-settings">
      <p className="read-aloud-current" aria-live="polite">
        Current model: <strong>{selection ? selection.label : 'None selected'}</strong>
        {!selection && ' (you are asked when you first read a message aloud)'}
      </p>
      <ReadAloudModelPicker value={selection} onSelect={setSelection} />
    </div>
  )
}
