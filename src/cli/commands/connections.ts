import type { ParsedArgs } from '../parseArgs'
import { writeOutput, exitWithError } from '../output'
import { resolveMousseHome } from '../paths'
import {
  approveClientConnection,
  listPendingClientConnections,
  revokeClientConnection
} from '../../mms/http/ClientConnectionServer'
import { CONNECTIONS_HELP } from '../help'
import QRCode from 'qrcode'
import { MousseConfigStore } from '../../mms/config/MousseConfigStore'
import { connectionQrInfo } from '../../mms/http/connectionQr'

/** Headless owner consent for OAuth authorization requests. */
export async function runConnections(args: ParsedArgs): Promise<void> {
  const home = resolveMousseHome(args.globals.homeDir || undefined)
  if (!args.subcommand || args.subcommand === 'help' || args.globals.help) {
    process.stdout.write(CONNECTIONS_HELP)
    return
  }
  const id = args.positional[0]
  switch (args.subcommand) {
    case 'qr': {
      const info = connectionQrInfo(MousseConfigStore.load(home).getMmsSection())
      if (!info.payload || !info.baseUrl) {
        return exitWithError(info.reason ?? 'A mobile connection QR is unavailable.', args.globals.mode)
      }
      if (args.globals.mode === 'json') {
        writeOutput(args.globals.mode, info)
        return
      }
      const qr = await QRCode.toString(info.payload, { type: 'terminal', small: true })
      process.stdout.write(`Scan with Mousse Mobile\n${info.baseUrl}\n\n${qr}\n`)
      return
    }
    case 'list':
      writeOutput(args.globals.mode, { pending: listPendingClientConnections(home) })
      return
    case 'approve':
      if (!id) return exitWithError('connections approve requires a request id', args.globals.mode)
      writeOutput(args.globals.mode, { requestId: id, approvalCode: approveClientConnection(home, id) })
      return
    case 'revoke':
      if (!id) return exitWithError('connections revoke requires a client id', args.globals.mode)
      revokeClientConnection(home, id)
      writeOutput(args.globals.mode, { revoked: true, clientId: id })
      return
    default:
      exitWithError(`Unknown connections subcommand: ${args.subcommand}`, args.globals.mode)
  }
}
