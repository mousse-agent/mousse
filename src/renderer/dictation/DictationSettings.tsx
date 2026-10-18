import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import { DictationModelPicker } from './DictationModelPicker'
import { useDictationStore } from './dictationStore'

/** Model controls for the Settings page; a click saves the choice for this profile. */
export function DictationSettings() {
  const profileId = useAppStore((state) => state.profileId)
  const selection = useDictationStore((state) => state.selection)
  const syncProfile = useDictationStore((state) => state.syncProfile)
  const setSelection = useDictationStore((state) => state.setSelection)

  useEffect(() => {
    syncProfile(profileId)
  }, [profileId, syncProfile])

  return (
    <div className="read-aloud-settings">
      <p className="read-aloud-current" aria-live="polite">
        Current model: <strong>{selection ? selection.label : 'None selected'}</strong>
        {!selection && ' (you are asked when you first use the microphone button)'}
      </p>
      <DictationModelPicker value={selection} onSelect={setSelection} />
    </div>
  )
}
