import { FileText, X } from 'lucide-react'
import { truncateFileName } from '../utils/messageAttachments'

interface FileAttachmentPillProps {
  name: string
  onRemove?: () => void
}

export function FileAttachmentPill({ name, onRemove }: FileAttachmentPillProps) {
  return (
    <div className="composer-attachment-pill">
      <FileText size={12} strokeWidth={2} />
      <span title={name}>{truncateFileName(name)}</span>
      {onRemove && (
        <button
          type="button"
          className="composer-attachment-remove"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
        >
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}
