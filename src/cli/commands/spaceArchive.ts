import { resolve } from 'node:path'
import type { ParsedArgs } from '../parseArgs'
import { connectDaemonClient, type DaemonClient } from '../daemonClient'
import { writeOutput } from '../output'
import { NetError } from '../../shared/net'
import type { SpaceArchiveMethod, SpaceArchiveParams } from '../../shared/spaces/archive'
import { validateSpaceArchive } from '../../mms/spaces/archive/registerMethods'
import { netCliFailure } from './net'
export const SPACE_ARCHIVE_SUBCOMMANDS = [
  'freeze',
  'export',
  'retire',
  'import',
  'activate',
  'archive-status'
] as const
export const SPACE_ARCHIVE_HELP = `
  mousse-cli spaces freeze <space-id> <reason>
  mousse-cli spaces export <space-id> <archive-directory>
  mousse-cli spaces retire <space-id>
  mousse-cli spaces import <archive-directory> [--archive-mode restore|move]
  mousse-cli spaces activate <space-id>
  mousse-cli spaces archive-status [space-id] [--after <space-id>] [--limit <count>]

Archive operations are owner-local and require the protected root-authority
profile. Freeze stops new work; export requires actual jobs and streams drained.
Import keeps history hidden until explicit higher-epoch activation. Move requires
retirement.json beside the archive. Retire removes the selected local authority.
Private activation creates fresh keys and controls; a foreign controller or
missing current recipient evidence is unsupported. Provider receipt histories
remain unsupported by this archive front door.
`
export interface SpaceArchiveCliRequest {
  method: SpaceArchiveMethod
  params: SpaceArchiveParams[SpaceArchiveMethod]
}
function invalid(message: string): never {
  throw new NetError('bad_request', message)
}
export function prepareSpaceArchiveCommand(args: ParsedArgs): SpaceArchiveCliRequest {
  const sub = args.subcommand as (typeof SPACE_ARCHIVE_SUBCOMMANDS)[number]
  if (args.command !== 'spaces' || !SPACE_ARCHIVE_SUBCOMMANDS.includes(sub))
    invalid('Unknown archive command.')
  if (
    args.globals.provider ||
    args.globals.model ||
    args.globals.apiKey ||
    args.globals.continueSession ||
    args.globals.sessionId
  )
    invalid('Archive commands do not accept provider overrides.')
  const allowed =
    sub === 'import' ? ['archive-mode'] : sub === 'archive-status' ? ['after', 'limit'] : []
  for (const flag of args.flags.keys())
    if (!['profile', 'json', 'mode', 'help'].includes(flag) && !allowed.includes(flag))
      invalid(`Unexpected flag --${flag}.`)
  const flags = (name: string): string | undefined => {
    const value = args.flags.get(name)
    if (value !== undefined && (typeof value !== 'string' || !value.length))
      invalid(`--${name} requires a value.`)
    return value as string | undefined
  }
  const n = args.positional.length,
    expected = sub === 'freeze' || sub === 'export' ? 2 : 1
  if (sub === 'archive-status' ? n > 1 : n !== expected)
    invalid('Wrong number of archive arguments.')
  const method = `spaces.archive.${sub === 'archive-status' ? 'status' : sub}` as SpaceArchiveMethod
  const params =
    sub === 'freeze'
      ? { space: args.positional[0], reason: args.positional[1] }
      : sub === 'export'
        ? { space: args.positional[0], path: resolve(args.positional[1]) }
        : sub === 'import'
          ? { path: resolve(args.positional[0]), mode: flags('archive-mode') ?? 'restore' }
          : sub === 'archive-status'
            ? {
                ...(n ? { space: args.positional[0] } : {}),
                ...(flags('after') ? { after: flags('after') } : {}),
                ...(flags('limit') ? { limit: Number(flags('limit')) } : {})
              }
            : { space: args.positional[0] }
  return { method, params: validateSpaceArchive(method, params) }
}
export async function executeSpaceArchiveCommand(
  request: SpaceArchiveCliRequest,
  client: Pick<DaemonClient, 'request'>,
  emit: (value: unknown, text: string) => void
): Promise<number> {
  const result = await client.request(
    request.method,
    validateSpaceArchive(request.method, request.params)
  )
  emit(result, JSON.stringify(result, null, 2))
  return 0
}
export async function runSpaceArchiveCommand(args: ParsedArgs): Promise<void> {
  let client: DaemonClient | undefined
  try {
    const request = prepareSpaceArchiveCommand(args)
    client = await connectDaemonClient({
      homeDir: args.globals.homeDir || undefined,
      requestTimeoutMs: 120000
    })
    const profile =
      args.globals.profile ??
      (await client.request<{ defaultProfileId: string }>('profiles.status')).defaultProfileId
    await client.request('profiles.bind', { profile })
    process.exitCode = await executeSpaceArchiveCommand(request, client, (value, text) =>
      writeOutput(args.globals.mode, value, () => text)
    )
  } catch (error) {
    const failure = netCliFailure(error)
    process.stderr.write(
      args.globals.mode === 'json'
        ? `${JSON.stringify({ code: failure.code, error: failure.error })}\n`
        : `Error [${failure.code}]: ${failure.error}\n`
    )
    process.exitCode = failure.exitCode
  } finally {
    await client?.close()
  }
}
