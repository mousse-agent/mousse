import ReactMarkdown from 'react-markdown'
import { FileText, X } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import '../styles/chat-markdown.css'

export function DocumentPanel() {
  const documentTabs = useAppStore((s) => s.documentTabs)
  const activeDocumentTabId = useAppStore((s) => s.activeDocumentTabId)
  const setActiveDocumentTab = useAppStore((s) => s.setActiveDocumentTab)
  const closeDocumentTab = useAppStore((s) => s.closeDocumentTab)

  const activeTab = documentTabs.find((tab) => tab.id === activeDocumentTabId) ?? documentTabs[0]

  if (documentTabs.length === 0) {
    return (
      <div className="document-panel document-panel-empty">
        <FileText size={28} strokeWidth={1.5} />
        <p>No documents open</p>
      </div>
    )
  }

  return (
    <div className="document-panel">
      <div className="document-tabs">
        {documentTabs.map((tab) => (
          <div
            key={tab.id}
            className={`document-tab${activeTab?.id === tab.id ? ' active' : ''}`}
          >
            <button
              type="button"
              className="document-tab-label"
              onClick={() => setActiveDocumentTab(tab.id)}
              title={tab.title}
            >
              <FileText size={13} strokeWidth={2} className="document-tab-icon" />
              <span>{tab.title}</span>
            </button>
            <button
              type="button"
              className="document-tab-close"
              aria-label={`Close ${tab.title}`}
              onClick={() => closeDocumentTab(tab.id)}
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>
      <div className="document-preview scrollbar-ultra-thin">
        {activeTab && (
          <div className="document-preview-body chat-markdown">
            <ReactMarkdown>{activeTab.markdown}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}
