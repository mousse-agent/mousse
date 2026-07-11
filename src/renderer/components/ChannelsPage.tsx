import { useCallback } from 'react'
import { ArrowLeft, Radio } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { useWindowDrag } from '../hooks/useWindowDrag'
import { ChannelsPanel } from './ChannelsPanel'
import '../styles/channels-panel.css'

export function ChannelsPage() {
  const channelsOpen = useAppStore((s) => s.channelsOpen)
  const setChannelsOpen = useAppStore((s) => s.setChannelsOpen)
  const windowDrag = useWindowDrag()

  const closeChannels = useCallback(() => {
    setChannelsOpen(false)
  }, [setChannelsOpen])

  return (
    <div className="channels-page overlay-page" hidden={!channelsOpen}>
      <header className="channels-page-header overlay-page-drag-header" {...windowDrag}>        <button type="button" className="channels-page-back-btn" onClick={closeChannels}>
          <ArrowLeft size={16} strokeWidth={2} />
          Back
        </button>
        <div className="channels-page-title">
          <Radio size={20} strokeWidth={2} className="channels-page-title-icon" aria-hidden="true" />
          <h1>Channels</h1>
        </div>
      </header>
      <div className="channels-page-body">
        <ChannelsPanel />
      </div>
    </div>
  )
}
