import { useCallback } from 'react'
import { ArrowLeft } from '../lib/icons'
import { useAppStore } from '../stores/appStore'
import { ChannelsPanel } from './ChannelsPanel'
import '../styles/channels-panel.css'

export function ChannelsPage() {
  const channelsOpen = useAppStore((s) => s.channelsOpen)
  const profileId = useAppStore((s) => s.profileId)
  const setChannelsOpen = useAppStore((s) => s.setChannelsOpen)

  const closeChannels = useCallback(() => {
    setChannelsOpen(false)
  }, [setChannelsOpen])

  return (
    <div className="channels-page overlay-page" hidden={!channelsOpen}>
      <header className="overlay-titlebar overlay-page-drag-header">
        <button type="button" className="overlay-titlebar-back" onClick={closeChannels} aria-label="Back">
          <ArrowLeft size={14} strokeWidth={2} />
        </button>
        <h1>Channels</h1>
      </header>
      <div className="channels-page-body">
        <ChannelsPanel key={profileId} />
      </div>
    </div>
  )
}
