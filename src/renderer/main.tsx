import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SettingsPage } from './components/SettingsPage'
import { ScheduledPage } from './components/ScheduledPage'
import { ChannelsPage } from './components/ChannelsPage'
import { applyAppearance, useTheme } from './hooks/useTheme'
import { getDefaultSettings } from '../shared/settings'
import { useAppStore } from './stores/appStore'
import { AppTooltip } from './components/AppTooltip'
import './styles/global.css'
import './styles/compact-shell.css'
import './styles/sentence-case.css'
import './styles/polish.css'
import './styles/geist-fonts.css'

// Apply the saved profile's appearance before React paints or MMS connects.
const startupAppearance = window.mousse?.startupAppearance
applyAppearance(startupAppearance && typeof startupAppearance === 'object'
  ? startupAppearance
  : getDefaultSettings().appearance)

// Warm the local monospace face before canvas-based terminals measure glyphs.
// The normal app shell renders immediately while the asset loads.
void document.fonts.load('400 13px "Geist Mono"').catch(() => { /* system monospace fallback */ })

function ProfilePages() {
  useTheme()
  return (
    <>
      <SettingsPage />
      <ScheduledPage />
      <ChannelsPage />
    </>
  )
}

function Root() {
  const profileReady = useAppStore((state) => state.profileReady)
  return (
    <>
      <App />
      {profileReady && <ProfilePages />}
      <AppTooltip />
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
