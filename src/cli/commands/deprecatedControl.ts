import type { ParsedArgs } from '../parseArgs'
import { exitWithError } from '../output'

/** Retired commands fail before daemon connection, authentication or storage. */
export function runDeprecatedControl(args: ParsedArgs): never {
  return exitWithError(`${args.command} belonged to retired Control Protocol 2.0. Use net init and bridge invite/join for fresh Net enrollment. Legacy credentials and pairings remain preserved migration data; they grant no Net access.`, args.globals.mode)
}
