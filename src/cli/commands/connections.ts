import type { ParsedArgs } from '../parseArgs'
import { flagString } from '../parseArgs'
import { exitWithError, writeOutput } from '../output'
import { connectDaemonClient } from '../daemonClient'
import type { CreatePairingResult, PairingGrant, RemoteScope } from '../../shared/controlTypes'
import { CONNECTIONS_HELP } from '../help'
import { generateQrMatrix } from '../../shared/qrCode'

export async function runConnections(args: ParsedArgs): Promise<void> {
  const { globals, subcommand } = args

  if (!subcommand || subcommand === 'help' || globals.help) {
    process.stdout.write(CONNECTIONS_HELP)
    return
  }

  const daemon = await connectDaemonClient({ homeDir: globals.homeDir })
  try {
    switch (subcommand) {
      case 'list': {
        const result = await daemon.request<{ pairings: PairingGrant[] }>('pairing.list')
        if (globals.mode === 'json') {
          writeOutput(globals.mode, result)
        } else {
          process.stdout.write(`\nPaired Mobile Devices (${result.pairings.length})\n`)
          process.stdout.write(`--------------------------------------------------\n`)
          if (result.pairings.length === 0) {
            process.stdout.write('No mobile devices paired.\n\n')
          } else {
            for (const p of result.pairings) {
              const fp = (p.fingerprint || p.mobileDeviceId).slice(0, 16)
              process.stdout.write(`Device:      ${p.mobileDeviceName || 'Mobile Client'} (${p.mobileDeviceId})\n`)
              process.stdout.write(`Pairing ID:  ${p.pairingId}\n`)
              process.stdout.write(`Fingerprint: ${fp}…\n`)
              process.stdout.write(`Scopes:      ${p.grantedScopes.join(', ')}\n`)
              process.stdout.write(`Status:      ${p.status}\n`)
              process.stdout.write(`Paired:      ${p.createdAt}\n`)
              process.stdout.write(`--------------------------------------------------\n`)
            }
            process.stdout.write('\n')
          }
        }
        break
      }

      case 'qr': {
        const scopesRaw = flagString(args.flags, 'scopes')
        const ttlSec = Number(flagString(args.flags, 'ttl')) || 120
        const scopes = scopesRaw ? (scopesRaw.split(',').map((s) => s.trim()) as RemoteScope[]) : undefined

        const result = await daemon.request<CreatePairingResult>('pairing.create', {
          scopes,
          ttlMs: ttlSec * 1000
        })

        if (globals.mode === 'json') {
          writeOutput(globals.mode, result)
        } else {
          process.stdout.write(`\n--- Mousse Mobile Pairing QR v2 ---\n`)
          process.stdout.write(`Pairing ID: ${result.pairingId}\n`)
          process.stdout.write(`Expires At: ${new Date(result.expiresAt).toLocaleTimeString()}\n\n`)

          // Print ASCII QR matrix in terminal
          try {
            const matrix = generateQrMatrix(result.qrUri)
            renderAsciiQr(matrix)
          } catch {
            // If terminal cannot render ASCII QR, URI is printed below
          }

          process.stdout.write(`\nPairing URI:\n${result.qrUri}\n\n`)
          process.stdout.write(`Scan this QR code with Mousse Mobile, then approve the request with:\n`)
          process.stdout.write(`  mousse-cli connections approve ${result.pairingId}\n\n`)
        }
        break
      }

      case 'approve': {
        const pairingId = args.positional[0] || flagString(args.flags, 'id')
        if (!pairingId) {
          exitWithError('Missing required pairingId argument: mousse-cli connections approve <pairingId>', globals.mode)
          return
        }

        const scopesRaw = flagString(args.flags, 'scopes')
        const scopes = scopesRaw ? (scopesRaw.split(',').map((s) => s.trim()) as RemoteScope[]) : undefined

        const result = await daemon.request<{
          grant: PairingGrant
          receipt: string
          receiptSignature: string
        }>('pairing.approve', {
          pairingId,
          scopes
        })

        if (globals.mode === 'json') {
          writeOutput(globals.mode, result)
        } else {
          process.stdout.write(`\nSuccessfully approved pairing: ${result.grant.pairingId}\n`)
          process.stdout.write(`Device: ${result.grant.mobileDeviceName || result.grant.mobileDeviceId}\n`)
          process.stdout.write(`Scopes: ${result.grant.grantedScopes.join(', ')}\n\n`)
        }
        break
      }

      case 'reject': {
        const pairingId = args.positional[0] || flagString(args.flags, 'id')
        if (!pairingId) {
          exitWithError('Missing required pairingId argument: mousse-cli connections reject <pairingId>', globals.mode)
          return
        }

        const result = await daemon.request<{ ok: boolean }>('pairing.reject', { pairingId })
        if (globals.mode === 'json') {
          writeOutput(globals.mode, result)
        } else {
          process.stdout.write(`Rejected pairing: ${pairingId}\n`)
        }
        break
      }

      case 'revoke': {
        const target = args.positional[0] || flagString(args.flags, 'id')
        if (!target) {
          exitWithError('Missing required pairingId or deviceId argument: mousse-cli connections revoke <id>', globals.mode)
          return
        }

        const result = await daemon.request<{ ok: boolean; revoked?: PairingGrant }>('pairing.revoke', {
          pairingIdOrDeviceId: target
        })

        if (globals.mode === 'json') {
          writeOutput(globals.mode, result)
        } else {
          process.stdout.write(`Successfully revoked device/pairing: ${target}\n`)
        }
        break
      }

      default:
        exitWithError(`Unknown connections subcommand: ${subcommand}`, globals.mode)
    }
  } finally {
    await daemon.close()
  }
}

function renderAsciiQr(matrix: boolean[][]): void {
  const border = 2
  const size = matrix.length

  // Two rows per ASCII block line using half-block characters
  for (let r = -border; r < size + border; r += 2) {
    let line = '  '
    for (let c = -border; c < size + border; c++) {
      const topDark = r >= 0 && r < size && c >= 0 && c < size ? matrix[r][c] : false
      const bRow = r + 1
      const botDark = bRow >= 0 && bRow < size && c >= 0 && c < size ? matrix[bRow][c] : false

      if (topDark && botDark) {
        line += ' ' // Both dark (on black terminal, inverted)
      } else if (topDark && !botDark) {
        line += '▄'
      } else if (!topDark && botDark) {
        line += '▀'
      } else {
        line += '█'
      }
    }
    process.stdout.write(line + '\n')
  }
}
