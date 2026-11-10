// Electron main for the main-browser E2E. Loads the bundled fixture given on the command line, and exits
// when it fails to load instead of leaving Electron's error dialog open.
import { app, BrowserWindow } from 'electron'
import { pathToFileURL } from 'node:url'
import { runWithoutGpu } from '../../electronWithoutGpu.mjs'

runWithoutGpu({ app, BrowserWindow })
try { await import(pathToFileURL(process.argv[2]).href) } catch (error) { console.error(error); app.exit(1) }
