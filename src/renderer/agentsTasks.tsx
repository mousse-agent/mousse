import React from 'react'
import ReactDOM from 'react-dom/client'
import { LinuxWindowResizeHandles } from './components/LinuxWindowResizeHandles'
import { AgentsTasksView } from './components/AgentsTasksView'
import { useTheme } from './hooks/useTheme'
import './styles/global.css'
import './styles/app.css'

function Root() {
  useTheme({ windowMaterial: false })
  React.useEffect(() => {
    const platform = window.mousse?.platform
    document.documentElement.classList.toggle('platform-darwin', platform === 'darwin')
    document.documentElement.classList.toggle('platform-win32', platform === 'win32')
  }, [])
  return <><AgentsTasksView /><LinuxWindowResizeHandles /></>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
