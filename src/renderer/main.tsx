import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SettingsPage } from './components/SettingsPage'
import { ScheduledPage } from './components/ScheduledPage'
import { ChannelsPage } from './components/ChannelsPage'
import { useTheme } from './hooks/useTheme'
import './styles/global.css'

function Root() {
  useTheme()
  return (
    <>
      <App />
      <SettingsPage />
      <ScheduledPage />
      <ChannelsPage />
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
