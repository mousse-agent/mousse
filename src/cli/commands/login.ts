import type { ParsedArgs } from '../parseArgs'
import { exitWithError, writeOutput } from '../output'
import { resolveMousseHome } from '../paths'
import { ControlStore } from '../../mms/control/storage/controlStore'
import { CliHeadlessAuth } from '../../mms/control/auth/cliHeadless'
import { connectDaemonClient } from '../daemonClient'

export async function runLogin(args: ParsedArgs): Promise<void> {
  const { globals } = args
  const homeDir = resolveMousseHome(globals.homeDir)
  const store = new ControlStore(homeDir)

  process.stdout.write('\nInitiating Mousse Plus authentication...\n')

  const auth = new CliHeadlessAuth(store)
  try {
    const result = await auth.startLogin({
      onPrompt: (info) => {
        if (globals.mode === 'json') {
          writeOutput(globals.mode, {
            status: 'prompt',
            verificationUrl: info.verificationUrl,
            code: info.humanCode,
            expiresAt: info.expiresAt
          })
        } else {
          process.stdout.write(`\n1. Open your browser and navigate to:\n   ${info.verificationUrl}\n\n`)
          process.stdout.write(`2. Confirm this authorization code:\n   ${info.humanCode}\n\n`)
          process.stdout.write(`Waiting for browser authorization (press Ctrl+C to cancel)...\n`)
        }
      }
    })

    if (!result.ok) {
      exitWithError(result.error || 'Login failed', globals.mode)
      return
    }

    // If daemon is running, tell it to refresh its control state
    try {
      const daemon = await connectDaemonClient({ homeDir, disableAutoStart: true })
      await daemon.request('control.status')
      await daemon.close()
    } catch {
      // Daemon may not be running yet; credentials are saved to store
    }

    if (globals.mode === 'json') {
      writeOutput(globals.mode, { ok: true, accountId: result.accountId })
    } else {
      process.stdout.write(`\nSuccessfully signed in to Mousse Plus! (Account: ${result.accountId})\n\n`)
    }
  } catch (err) {
    exitWithError((err as Error).message, globals.mode)
  }
}
