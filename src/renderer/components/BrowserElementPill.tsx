import { Crosshair, X } from 'lucide-react'
import {
  browserElementLabel,
  truncateLabel,
  type ParsedBrowserElement
} from '../utils/messageAttachments'

export interface BrowserElementPillProps {
  element: Pick<
    ParsedBrowserElement,
    'tagName' | 'text' | 'ariaLabel' | 'selector' | 'url' | 'role'
  >
  onRemove?: () => void
}

export function BrowserElementPill({ element, onRemove }: BrowserElementPillProps) {
  const label = browserElementLabel(element)
  const title = [
    element.url,
    element.selector,
    element.role ? `role="${element.role}"` : ''
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div
      className="composer-attachment-pill composer-attachment-pill-element"
      title={title || undefined}
    >
      <Crosshair size={12} strokeWidth={2} aria-hidden="true" />
      <span className="browser-element-pill-tag">&lt;{element.tagName}&gt;</span>
      {label !== `<${element.tagName}>` && (
        <span className="browser-element-pill-label">{truncateLabel(label)}</span>
      )}
      {onRemove && (
        <button
          type="button"
          className="composer-attachment-remove"
          onClick={onRemove}
          aria-label="Remove selected browser element"
        >
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}
