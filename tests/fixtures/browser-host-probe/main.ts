// Starts the real browser worker from an Electron host, with no window, and reports what the broker saw.
import { app, BrowserWindow } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { join } from 'node:path'
import { BrowserBroker } from '../../../src/mms/browser/BrowserBroker'

const fixtureRoot = process.argv[2]!
const workerPath = process.argv[3]!
app.setPath('userData', join(fixtureRoot, 'electron-data'))
runWithoutGpu({ app, BrowserWindow })
const deadline = setTimeout(() => app.exit(2), 15000)
let broker: BrowserBroker | undefined
app.whenReady().then(async () => {
  broker = new BrowserBroker({ profileRoot: join(fixtureRoot, 'profiles'), browserRoot: join(fixtureRoot, 'browser'), artifactRoot: join(fixtureRoot, 'artifacts'), workerModulePath: workerPath, policy: { authorize: async () => ({ allowed: false, code: 'policy_denied' }) } })
  const capability = await broker.start()
  if (!capability.setupRequired || capability.ready) throw new Error('Unexpected empty-fixture capability')
  await broker.close()
  process.stdout.write('MOUSSE_BROWSER_BUILD_PROBE:' + JSON.stringify({ success: true, hostElectron: Boolean(process.versions.electron), setupRequired: capability.setupRequired }) + '\n')
  clearTimeout(deadline); app.exit(0)
}).catch(async (error: Error) => { process.stderr.write(error.message + '\n'); await broker?.close(); clearTimeout(deadline); app.exit(1) })
