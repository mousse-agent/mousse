import { sendDaemonStop } from '../../cli/daemonShutdown'
import { canonicalizeHome, SERVICE_START_TIMEOUT_MS } from '../../cli/mmsRuntime'
import type { GuiMmsController } from './GuiMmsController'

/**
 * Quit that also stops the background service (the tray's Quit). Holds the window client
 * first, so nothing starts the service again, then sends the stop and disconnects. Waits
 * neither for the service to stop nor for one still starting to become ready: the service
 * stops itself once it reads the request.
 */
export async function stopServiceForQuit(
  controller: Pick<GuiMmsController, 'spawnedServiceRunning' | 'stopForQuit'> | null,
  homeDir: string | null,
  opts: { waitForOwnerMs?: number; log?: (message: string) => void } = {}
): Promise<void> {
  const log = opts.log ?? ((message: string) => console.error(message))
  // A service this run just started may not hold the home yet; the stop waits for it to.
  const waitForOwnerMs = controller?.spawnedServiceRunning ? (opts.waitForOwnerMs ?? SERVICE_START_TIMEOUT_MS) : 0
  const disconnected = controller?.stopForQuit().catch((error: unknown) => {
    log(`The window client did not disconnect cleanly: ${error instanceof Error ? error.message : String(error)}`)
  })
  try {
    if (homeDir) {
      const target = await sendDaemonStop(canonicalizeHome(homeDir), { reason: 'gui-quit', waitForOwnerMs })
      if (target.kind === 'unreadable') log('Background service could not be asked to stop: its owner cannot be read')
    }
  } catch (error) {
    log(`Background service could not be asked to stop: ${error instanceof Error ? error.message : String(error)}`)
  }
  await disconnected
}
