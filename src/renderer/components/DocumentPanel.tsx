import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Check, Copy, FileText } from '../lib/icons'
import { useAppStore } from '../stores/appStore'
import { TabBar } from './ui/TabBar'
import '../styles/chat-markdown.css'

const COPIED_MS = 1600

export function DocumentPanel() {
  const documentTabs = useAppStore((s) => s.documentTabs)
  const activeDocumentTabId = useAppStore((s) => s.activeDocumentTabId)
  const setActiveDocumentTab = useAppStore((s) => s.setActiveDocumentTab)
  const closeDocumentTab = useAppStore((s) => s.closeDocumentTab)
  const [copy, setCopy] = useState<{ tabId: string; result: 'copied' | 'failed' } | null>(null)
  const copiedTimer = useRef<number | null>(null)

  const activeTab = documentTabs.find((tab) => tab.id === activeDocumentTabId) ?? documentTabs[0]
  const copyResult = copy && copy.tabId === activeTab?.id ? copy.result : null

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
  }, [])

  const copyMarkdown = () => {
    if (!activeTab) return
    const tabId = activeTab.id
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
    void navigator.clipboard.writeText(activeTab.markdown).then(() => {
      setCopy({ tabId, result: 'copied' })
      copiedTimer.current = window.setTimeout(() => setCopy(null), COPIED_MS)
    }, () => setCopy({ tabId, result: 'failed' }))
  }

  if (documentTabs.length === 0) {
    return (
      <div className="document-panel document-panel-empty">
        <p>No documents open</p>
      </div>
    )
  }

  return (
    <div className="document-panel">
      <div className="document-toolbar">
        <TabBar
          label="Documents"
          activeId={activeTab?.id ?? null}
          tabs={documentTabs.map((tab) => ({
            id: tab.id,
            name: tab.title,
            icon: <FileText size={13} strokeWidth={2} className="document-tab-icon" aria-hidden="true" />
          }))}
          onSelect={setActiveDocumentTab}
          onClose={closeDocumentTab}
        />
        <button
          type="button"
          className="document-copy"
          aria-label="Copy Markdown"
          title="Copy Markdown"
          disabled={!activeTab}
          onClick={copyMarkdown}
        >
          {copyResult === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </button>
      </div>
      <div className="sr-only" role="status">{copyResult === 'copied' ? 'Copied' : ''}</div>
      {copyResult === 'failed' && <div className="panel-error" role="alert">Couldn’t copy the Markdown</div>}
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
