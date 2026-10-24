import { useEffect, useState } from 'react'
import { Modal } from '../components/ui/Modal'
import { useAppStore } from '../stores/appStore'
import type { ReadAloudSelection } from '../../shared/readAloud'
import { ReadAloudModelPicker } from './ReadAloudModelPicker'
import { useReadAloudStore } from './readAloudStore'

/** Mounted once at the app root. Opens on the first read aloud click and from the store. */
export function ReadAloudHost() {
  const profileId = useAppStore((state) => state.profileId)
  const open = useReadAloudStore((state) => state.pickerOpen)
  const syncProfile = useReadAloudStore((state) => state.syncProfile)

  useEffect(() => {
    syncProfile(profileId)
  }, [profileId, syncProfile])

  return open ? <ReadAloudModal /> : null
}

function ReadAloudModal() {
  const current = useReadAloudStore((state) => state.selection)
  const reading = useReadAloudStore((state) => state.pending !== null)
  const confirmPicker = useReadAloudStore((state) => state.confirmPicker)
  const closePicker = useReadAloudStore((state) => state.closePicker)
  const [draft, setDraft] = useState<ReadAloudSelection | null>(current)

  return (
    <Modal
      open
      title="Choose a read aloud voice"
      onClose={closePicker}
      footer={
        <button type="button" className="btn btn-primary" disabled={!draft} onClick={() => draft && confirmPicker(draft)}>
          {reading ? 'Use model and read' : 'Use model'}
        </button>
      }
    >
      <p>Messages are read with the model you pick. You can change it later under Settings, Speech.</p>
      <ReadAloudModelPicker
        value={draft}
        onSelect={setDraft}
        onLocalModelDeleted={(modelId) => setDraft((value) => (value?.source === 'local' && value.modelId === modelId ? null : value))}
      />
    </Modal>
  )
}
