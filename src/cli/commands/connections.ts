import type { ParsedArgs } from '../parseArgs'
import { writeOutput, exitWithError } from '../output'
import { resolveMousseHome } from '../paths'
import {
  approveClientConnection,
  listPendingClientConnections,
  revokeClientConnection
} from '../../mms/http/ClientConnectionServer'
import { CONNECTIONS_HELP } from '../help'

/** Headless owner consent for OAuth authorization requests. */
export async function runConnections(args: ParsedArgs): Promise<void> {
  const home = resolveMousseHome(args.globals.homeDir || undefined)
  if (!args.subcommand || args.subcommand === 'help' || args.globals.help) {
    process.stdout.write(CONNECTIONS_HELP)
    return
  }
  const id = args.positional[0]
  switch (args.subcommand) {
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
