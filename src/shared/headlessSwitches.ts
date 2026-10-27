/**
 * Chromium switches that let the packaged Electron CLI run on a server with no display or desktop.
 * - `--ozone-platform=headless` and `--disable-gpu`: without them every command except `--version`
 *   stops at "Missing X server or $DISPLAY".
 * - `--password-store=gnome-libsecret`: with no desktop environment Chromium picks no keyring, and
 *   the app, which never keeps its network keys in plain text, reports a locked key store. This asks
 *   for the secret service (gnome-keyring over D-Bus) directly; it must still be running and unlocked.
 * They are command-line switches only: Electron reads them before any of Mousse's code runs, and an
 * environment variable does not do the same. The CLI strips them from its own arguments, and a
 * daemon it starts keeps them.
 */
export const HEADLESS_DISPLAY_SWITCHES = [
  '--ozone-platform=headless',
  '--disable-gpu',
  '--password-store=gnome-libsecret'
] as const
