import { Modal } from './ui/Modal'

/** How much of a long paste the preview draws; the file the agent gets always has all of it. */
const PREVIEW_CHARS = 512 * 1024

/** A long paste kept as a file, opened from its chip: the text, and a way to put it into the box instead. */
export function PastedTextPreview({ name, text, onClose, onInsert }: { name: string; text: string; onClose: () => void; onInsert: () => void }) {
  const cut = text.length > PREVIEW_CHARS
  return (
    <Modal
      open
      className="pasted-text-preview"
      title={name}
      onClose={onClose}
      footer={
        <button type="button" className="settings-btn" title="Put the text into the message box instead of sending it as a file" onClick={onInsert}>
          Insert as text
        </button>
      }
    >
      <pre className="pasted-text-preview-body" tabIndex={0}>{cut ? text.slice(0, PREVIEW_CHARS) : text}</pre>
      {cut && <p className="pasted-text-preview-cut">The rest is in the file.</p>}
    </Modal>
  )
}
