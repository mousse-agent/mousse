import { useRef, useState, type ReactNode } from 'react'
import type { AppletBundle } from '../../../shared/applets'
import type { DocumentTab } from '../../../shared/types'
import { Code2, Download, Eye, FileCode, Image as ImageIcon, RotateCcw, ShieldCheck } from '../../lib/icons'
import { useAppStore } from '../../stores/appStore'
import './applets.css'
import { useAppletRuntime } from './useAppletRuntime'
import { addAppletInputToDraft, exportApplet, requestAppletRepair, type AppletConversation } from './appletActions'
import { AppletConversationInput, AppletError } from './AppletCard'

type AppletTab = DocumentTab & { applet: NonNullable<DocumentTab['applet']> }

function ToolbarButton({ label, pressed, disabled, onClick, children }: {
  label: string
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="document-copy"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/**
 * An applet in the side panel's Documents tab: it fills the panel, with Restart, Source and the exports beside the
 * tabs. `tabs` is the panel's tab strip, drawn in the same toolbar row. Keyed by tab, so each tab starts fresh.
 * `conversation`: it is opened from outside the thread (a bot's chat), whose composer takes its text.
 */
export function AppletPanelView({ tab, tabs, conversation }: { tab: AppletTab; tabs: ReactNode; conversation?: AppletConversation }) {
  const { threadId, reference } = tab.applet
  const currentProfile = useAppStore((s) => s.profileId)
  // A tab from another profile cannot load: its thread belongs to that profile.
  const profileId = tab.applet.profileId
  const available = profileId === currentProfile
  const preview = useRef<HTMLDivElement>(null)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [bundle, setBundle] = useState<AppletBundle | null>(null)
  const [restart, setRestart] = useState(0)
  const applet = useAppletRuntime(preview, {
    host: 'panel',
    threadId: available ? threadId : null,
    profileId,
    reference,
    enabled: !sourceOpen,
    restart
  })
  const { error, setError, ready, conversationInput, setConversationInput } = applet

  const toggleSource = async () => {
    setSourceOpen((value) => !value)
    if (bundle || !available) return
    try {
      const result = await window.mousse.applets.get({ threadId, appletId: reference.appletId, revisionId: reference.revisionId })
      if (useAppStore.getState().profileId === profileId) setBundle(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Source unavailable.')
    }
  }
  const runExport = (format: 'html' | 'source' | 'png') => {
    void exportApplet(threadId, reference, format, applet.runtime.current).catch((cause) =>
      setError(cause instanceof Error ? cause.message : 'Export failed.'))
  }

  return (
    <div className="document-panel">
      <div className="document-toolbar">
        {tabs}
        <ToolbarButton label="Restart" disabled={!available} onClick={() => { setError(null); setRestart((value) => value + 1) }}>
          <RotateCcw size={14} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label={sourceOpen ? 'Preview' : 'Source'} pressed={sourceOpen} disabled={!available} onClick={() => void toggleSource()}>
          {sourceOpen ? <Eye size={14} aria-hidden="true" /> : <Code2 size={14} aria-hidden="true" />}
        </ToolbarButton>
        <ToolbarButton label="Export HTML" disabled={!available} onClick={() => runExport('html')}>
          <FileCode size={14} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Export source" disabled={!available} onClick={() => runExport('source')}>
          <Download size={14} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Export PNG" disabled={!ready || sourceOpen} onClick={() => runExport('png')}>
          <ImageIcon size={14} aria-hidden="true" />
        </ToolbarButton>
        <span
          className="mousse-applet-offline"
          tabIndex={0}
          role="img"
          aria-label="Offline applet · interactions stay on this device"
          title="Offline applet · interactions stay on this device"
        >
          <ShieldCheck size={14} aria-hidden="true" />
        </span>
      </div>
      {!available && <p className="mousse-applet-error" role="status">Open this applet from its thread.</p>}
      {available && error && (
        <AppletError error={error} onRepair={() => requestAppletRepair(profileId, threadId, reference, error, conversation)} />
      )}
      {sourceOpen ? (
        <div className="mousse-applet-source scrollbar-ultra-thin">
          {bundle ? (
            <>
              <h4>HTML</h4>
              <pre>{bundle.source.html}</pre>
              <h4>CSS</h4>
              <pre>{bundle.source.css}</pre>
              <h4>JavaScript</h4>
              <pre>{bundle.source.js}</pre>
              <h4>Data</h4>
              <pre>{JSON.stringify(bundle.source.data ?? {}, null, 2)}</pre>
            </>
          ) : (
            'Loading source…'
          )}
        </div>
      ) : (
        <div className="mousse-applet-stage">
          <div ref={preview} className="mousse-applet-preview mousse-applet-preview-fill" aria-label="Applet preview" />
        </div>
      )}
      {conversationInput && (
        <AppletConversationInput
          text={conversationInput}
          onAdd={() => { if (addAppletInputToDraft(profileId, threadId, reference, conversationInput, conversation)) setConversationInput(null) }}
          onDismiss={() => setConversationInput(null)}
        />
      )}
    </div>
  )
}
