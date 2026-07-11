import React from 'react'
import ReactDOM from 'react-dom/client'
import { AgentsTasksView } from './components/AgentsTasksView'
import { useTheme } from './hooks/useTheme'
import './styles/global.css'
import './styles/app.css'

function Root() {
  useTheme({ windowMaterial: false })
  return <AgentsTasksView />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
