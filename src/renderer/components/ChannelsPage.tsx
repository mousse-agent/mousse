import { useAppStore } from '../stores/appStore'
import { ChannelsPanel } from './ChannelsPanel'
import '../styles/channels-panel.css'

export function ChannelsPage() {
  const channelsOpen = useAppStore((s) => s.channelsOpen)
  const profileId = useAppStore((s) => s.profileId)
  return (
    <div className="channels-page" hidden={!channelsOpen}>
      <header className="rail-page-header">
        <h1>Channels</h1>
      </header>
      <div className="channels-page-body">
        <ChannelsPanel key={profileId} />
      </div>
    </div>
  )
}
