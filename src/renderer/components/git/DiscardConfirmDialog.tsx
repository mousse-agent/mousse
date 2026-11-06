import { Modal } from '../ui/Modal'

export interface DiscardQuestion {
  /** The confirmation text from `discardPrompt`: the question, the files, and how long a copy is kept. */
  message: string
  /** What the confirming button says. */
  action: 'Delete' | 'Discard'
}

/**
 * Asks before changes are thrown away, in the app's own dialog. Focus starts on the dialog, never on the confirming
 * button, so a stray Enter does nothing; Escape, Cancel and a click outside all answer no.
 */
export function DiscardConfirmDialog({ question, onAnswer }: { question: DiscardQuestion | null; onAnswer: (confirmed: boolean) => void }) {
  if (!question) return null
  const [lead, ...rest] = question.message.split('\n')
  const detail = rest.join('\n').trim()
  return (
    <Modal
      open
      title={lead}
      hideTitle
      className="git-discard-dialog"
      onClose={() => onAnswer(false)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => onAnswer(false)}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={() => onAnswer(true)}>
            {question.action}
          </button>
        </>
      }
    >
      <p className="git-discard-lead">{lead}</p>
      {detail && <p className="git-discard-detail">{detail}</p>}
    </Modal>
  )
}
