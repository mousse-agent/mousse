import type { ParsedArgs } from '../parseArgs'
import { flagString } from '../parseArgs'
import { exitWithError, writeOutput } from '../output'
import { connectDaemonClient } from '../daemonClient'
import type { ControlStatus } from '../../shared/controlTypes'
import { CONTROL_HELP } from '../help'

export async function runControl(args: ParsedArgs): Promise<void> {
  const { globals, subcommand } = args

  if (!subcommand || subcommand === 'help' || globals.help) {
    process.stdout.write(CONTROL_HELP)
    return
  }

  const daemon = await connectDaemonClient({ homeDir: globals.homeDir })
  try {
    switch (subcommand) {
      case 'status': {
        const status = await daemon.request<ControlStatus>('control.status')
        if (globals.mode === 'json') {
          writeOutput(globals.mode, status)
        } else {
          process.stdout.write(`\nMousse Control Protocol 2.0 Status\n`)
          process.stdout.write(`----------------------------------\n`)
          process.stdout.write(`Mode:             ${status.mode}\n`)
          process.stdout.write(`Enrolled:         ${status.enrolled ? 'Yes' : 'No'}\n`)
          process.stdout.write(`Relay Status:     ${status.relayConnected ? 'Connected (WSS:443)' : status.relayConnecting ? 'Connecting...' : 'Disconnected'}\n`)
          process.stdout.write(`Server URL:       ${status.serverUrl}\n`)
          process.stdout.write(`MMS Device ID:    ${status.mmsDeviceId}\n`)
          if (status.account) {
            process.stdout.write(`Account:          ${status.account.email || status.account.id}\n`)
          }
          process.stdout.write(`Active Pairings:  ${status.activePairingsCount}\n`)
          if (status.pendingPairing) {
            const expSec = Math.max(0, Math.floor((status.pendingPairing.expiresAt - Date.now()) / 1000))
            process.stdout.write(`Pending Pairing:  ${status.pendingPairing.pairingId} (${status.pendingPairing.state}, expires in ${expSec}s)\n`)
          }
          if (status.lastRelayError) {
            process.stdout.write(`Last Relay Error: ${status.lastRelayError}\n`)
          }
          process.stdout.write(`\n`)
        }
        break
      }

      case 'enroll': {
        const serverUrl = flagString(args.flags, 'server') || args.positional[0]
        let pairingCode = flagString(args.flags, 'code') || args.positional[1]

        if (!serverUrl) {
          exitWithError('Missing required --server <url> parameter.', globals.mode)
          return
        }

        if (!pairingCode) {
          // Read pairing code from stdin if not passed
          process.stdout.write('Enter one-time operator pairing code: ')
          const codeInput = await readMaskedInput()
          pairingCode = codeInput.trim()
        }

        if (!pairingCode) {
          exitWithError('Pairing code cannot be empty.', globals.mode)
          return
        }

        const result = await daemon.request<{ ok: boolean; error?: string }>('control.enroll', {
          serverUrl,
          pairingCode
        })

        if (!result.ok) {
          exitWithError(result.error || 'Enrollment failed', globals.mode)
          return
        }

        if (globals.mode === 'json') {
          writeOutput(globals.mode, { ok: true, serverUrl })
        } else {
          process.stdout.write(`Successfully enrolled with control server: ${serverUrl}\n`)
        }
        break
      }

      case 'disconnect': {
        const result = await daemon.request<{ ok: boolean }>('control.disconnect')
        if (globals.mode === 'json') {
          writeOutput(globals.mode, result)
        } else {
          process.stdout.write('Disconnected from control server.\n')
        }
        break
      }

      case 'set-mode': {
        const mode = args.positional[0] || flagString(args.flags, 'mode')
        if (mode !== 'hosted' && mode !== 'self-hosted') {
          exitWithError("Mode must be either 'hosted' or 'self-hosted'.", globals.mode)
          return
        }
        const result = await daemon.request<{ ok: boolean }>('control.setMode', { mode })
        if (globals.mode === 'json') {
          writeOutput(globals.mode, result)
        } else {
          process.stdout.write(`Control mode set to: ${mode}\n`)
        }
        break
      }

      default:
        exitWithError(`Unknown control subcommand: ${subcommand}`, globals.mode)
    }
  } finally {
    await daemon.close()
  }
}

function readMaskedInput(): Promise<string> {
  return new Promise((resolve) => {
    const readline = require('node:readline').createInterface({
      input: process.stdin,
      output: process.stdout
    })
    readline.question('', (answer: string) => {
      readline.close()
      resolve(answer)
    })
  })
}
