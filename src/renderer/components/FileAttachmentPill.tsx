import { FileText, X } from 'lucide-react'
import { truncateFileName } from '../utils/messageAttachments'

interface FileAttachmentPillProps {
  name: string
  previewUrl?: string
  onRemove?: () => void
}

export function FileAttachmentPill({ name, previewUrl, onRemove }: FileAttachmentPillProps) {
  return (
    <div className={`composer-attachment-pill${previewUrl ? ' composer-attachment-pill-image' : ''}`}>
      {previewUrl ? (
        <img src={previewUrl} alt={name} className="composer-attachment-thumb" />
      ) : (
        <FileText size={12} strokeWidth={2} />
      )}
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
