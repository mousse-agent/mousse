import type { ParsedArgs } from '../parseArgs'
import { exitWithError, writeOutput } from '../output'
import { resolveMousseHome } from '../paths'
import { ControlStore } from '../../mms/control/storage/controlStore'
import { connectDaemonClient } from '../daemonClient'

export async function runLogout(args: ParsedArgs): Promise<void> {
  const { globals } = args
  const homeDir = resolveMousseHome(globals.homeDir)
  const store = new ControlStore(homeDir)

  try {
    store.clearCredentials()

    // If daemon is running, ask it to disconnect and clear state
    try {
      const daemon = await connectDaemonClient({ homeDir, disableAutoStart: true })
      await daemon.request('control.logout')
      await daemon.close()
    } catch {
      // Daemon may not be running
    }

    if (globals.mode === 'json') {
      writeOutput(globals.mode, { ok: true })
    } else {
      process.stdout.write('Successfully signed out of Mousse Plus.\n')
    }
  } catch (err) {
    exitWithError((err as Error).message, globals.mode)
  }
}
