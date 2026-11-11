/**
 * Set once Mousse starts handing over to an update installer, and cleared only when that install could not start.
 * While it is set, main starts no helper from the install folder (the background service, the voice engine): a
 * helper started then runs the old executable and keeps the installer from replacing it.
 */
let installing = false

export function setUpdateInstalling(value: boolean): void {
  installing = value
}

export function isUpdateInstalling(): boolean {
  return installing
}

/** Throws while an update installs; call before starting a helper from the install folder. */
export function assertNotInstallingUpdate(what: string): void {
  if (installing) throw new Error(`${what} cannot start while Mousse installs an update`)
}

/** Once the installer has started, Mousse exits after this long even when a window holds the quit back. */
export const INSTALL_QUIT_DEADLINE_MS = 15_000
