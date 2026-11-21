import { HEADLESS_DISPLAY_SWITCHES } from '../shared/headlessSwitches'
import { resolveCliPathForInstall } from './cliLaunch'
import { installMmsStartup } from './serviceLocator'

/**
 * Writes the startup entry that runs `mousse-cli service run` at login for `homeDir` (`MOUSSE_HOME`). The one way it
 * is written: `mousse-cli service install`, and the networking's "Start at login" in a window, which the daemon runs.
 * `scriptPath` is the CLI script this process runs, when it is not a packaged app.
 */
export async function installServiceEntry(opts: {
  homeDir: string
  headless?: boolean
  scriptPath?: string
}): Promise<void> {
  await installMmsStartup({
    cliPath: resolveCliPathForInstall(opts.scriptPath ?? process.argv[1]),
    homeDir: opts.homeDir,
    // The service shows no windows, so Chromium's sandbox protects nothing it uses; an unpacked
    // headless build has no setuid helper and would not start without the opt-out.
    ...(opts.headless
      ? {
          environment: { ELECTRON_DISABLE_SANDBOX: '1' },
          // No display either: the daemon would stop at "Missing X server or $DISPLAY".
          execArguments: HEADLESS_DISPLAY_SWITCHES
        }
      : {})
  })
}
