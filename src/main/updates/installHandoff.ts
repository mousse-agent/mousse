import { setUpdateInstalling } from './installGate'

/** What `stopRunningDaemon` reports. */
export interface ServiceStopOutcome {
  kind: string
}

export interface InstallHandoffOptions {
  /** The window client; null before it exists. */
  controller: { stopForInstall(): Promise<void>; resumeAfterInstall(): void; start(): Promise<unknown> } | null
  /** Stops this app's background service and waits for its process to exit. */
  stopService: () => Promise<ServiceStopOutcome>
  /** Stops whatever else runs from the install folder; throws while something still does. */
  freeInstallFolder: () => Promise<unknown>
}

/**
 * Frees the install folder for the installer. From here until Mousse exits, nothing in main may start the service
 * or another helper from it: windows stay open while Mousse quits and keep asking for data, and a service started by
 * one of those requests runs the old executable and keeps the installer from replacing it.
 */
export async function prepareUpdateInstall(options: InstallHandoffOptions): Promise<void> {
  setUpdateInstalling(true)
  await options.controller?.stopForInstall()
  const stopped = await options.stopService()
  if (stopped.kind !== 'stopped' && stopped.kind !== 'not-running') {
    throw new Error('The background service did not stop, so the update was not installed.')
  }
  await options.freeInstallFolder()
}

/** The installer did not start: Mousse carries on, and may start its service again. */
export async function recoverUpdateInstall(options: Pick<InstallHandoffOptions, 'controller'>): Promise<void> {
  setUpdateInstalling(false)
  options.controller?.resumeAfterInstall()
  await options.controller?.start()
}
