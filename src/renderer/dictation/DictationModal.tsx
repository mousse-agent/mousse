import { useEffect, useState } from 'react'
import { Modal } from '../components/ui/Modal'
import { useAppStore } from '../stores/appStore'
import type { DictationSelection } from '../../shared/dictation'
import { DictationModelPicker } from './DictationModelPicker'
import { useDictationStore } from './dictationStore'

/** Mounted once at the app root. Opens on the first microphone click and from the store. */
export function DictationHost() {
  const profileId = useAppStore((state) => state.profileId)
  const open = useDictationStore((state) => state.pickerOpen)
  const syncProfile = useDictationStore((state) => state.syncProfile)

  useEffect(() => {
    syncProfile(profileId)
  }, [profileId, syncProfile])

  return open ? <DictationModal /> : null
}

function DictationModal() {
  const current = useDictationStore((state) => state.selection)
  const recording = useDictationStore((state) => state.onConfirmed !== null)
  const confirmPicker = useDictationStore((state) => state.confirmPicker)
  const closePicker = useDictationStore((state) => state.closePicker)
  const [draft, setDraft] = useState<DictationSelection | null>(current)

  return (
    <Modal
      open
      title="Choose a dictation model"
      onClose={closePicker}
      footer={
        <>
          <button type="button" className="btn" onClick={closePicker}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!draft}
            onClick={() => draft && confirmPicker(draft)}
          >
            {recording ? 'Use model and record' : 'Use model'}
          </button>
        </>
      }
    >
      <p>Speech is turned into text with the model you pick. You can change it later under Settings, Models.</p>
      <DictationModelPicker
        value={draft}
        onSelect={setDraft}
        onLocalModelDeleted={(modelId) => setDraft((value) => (value?.source === 'local' && value.modelId === modelId ? null : value))}
      />
    </Modal>
  )
}
