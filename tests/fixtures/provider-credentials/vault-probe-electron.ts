// Electron: writes the encrypted vault, or reads it back after a restart. Opens no window.
import { app, BrowserWindow } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { join } from 'node:path'
import { probe, vaultArguments } from './vault-probe-checks'

runWithoutGpu({ app, BrowserWindow })
const { phase, root } = vaultArguments(['write', 'read'])
app.setPath('userData', join(root, 'electron-user-data'))
void app.whenReady().then(() => probe(phase, root)).then(() => app.quit(), (error) => {
  console.error(error)
  app.exit(1)
})
