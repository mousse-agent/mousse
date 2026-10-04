import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SettingsPage } from './components/SettingsPage'
import { ScheduledPage } from './components/ScheduledPage'
import { ChannelsPage } from './components/ChannelsPage'
import { useTheme } from './hooks/useTheme'
import { useAppStore } from './stores/appStore'
import './styles/global.css'

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
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
