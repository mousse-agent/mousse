import { requestDaemonShutdown, sendDaemonStop } from '../../cli/daemonShutdown'
import { canonicalizeHome } from '../../cli/mmsRuntime'
import type { GuiMmsController } from './GuiMmsController'

/**
 * Quit that also stops the background service (the tray's Quit). Holds the window client
 * first, so nothing starts the service again, then sends the stop and disconnects. Waits
 * neither for the service to stop nor for one still starting to become ready: the service
 * stops itself once it reads the request.
 */
export async function stopServiceForQuit(
  controller: Pick<GuiMmsController, 'spawnedServiceToken' | 'stopForQuit'> | null,
  homeDir: string | null,
  opts: { log?: (message: string) => void } = {}
): Promise<void> {
  const log = opts.log ?? ((message: string) => console.error(message))
  // Read before the client lets go of the service it started.
  const spawnedToken = controller?.spawnedServiceToken ?? null
  const disconnected = controller?.stopForQuit().catch((error: unknown) => {
    log(`The window client did not disconnect cleanly: ${error instanceof Error ? error.message : String(error)}`)
  })
  try {
    if (homeDir) {
      const home = canonicalizeHome(homeDir)
      // The service that holds the home now, ready or still starting.
      const target = await sendDaemonStop(home, { reason: 'gui-quit' })
      // The service this run started may not hold the home yet. Its token was chosen here, so its
      // stop is waiting for it when it does; a service started by anything else is left alone.
      if (spawnedToken && !(target.kind === 'running' && target.token === spawnedToken)) {
        requestDaemonShutdown(home, spawnedToken, 'gui-quit')
      } else if (target.kind === 'unreadable') {
        log('Background service could not be asked to stop: its owner cannot be read')
      }
    }
  } catch (error) {
    log(`Background service could not be asked to stop: ${error instanceof Error ? error.message : String(error)}`)
  }
  await disconnected
}
