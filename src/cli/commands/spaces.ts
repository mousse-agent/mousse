import type { ParsedArgs } from '../parseArgs'
import {
  SPACE_ARCHIVE_HELP,
  SPACE_ARCHIVE_SUBCOMMANDS,
  runSpaceArchiveCommand
} from './spaceArchive'
import { connectDaemonClient, type DaemonClient } from '../daemonClient'
import { writeOutput } from '../output'
import { NetError, type SpaceId, type StreamId, type UserId } from '../../shared/net'
import type {
  SpaceLocalTail,
  SpacesLocalMethod,
  SpacesLocalParams
} from '../../shared/spaces/local'
import { validateSpacesLocal } from '../../mms/spaces/registerMethods'
import { netCliFailure, parseInviteTtl, readInviteSecret } from './net'

export const SPACES_SUBCOMMANDS = [
  'create',
  'invite',
  'join',
  'list',
  'channels',
  'post',
  'tail',
  'members',
  'leave',
  'outbox'
] as const
export const SPACES_HELP = `Usage:
  mousse-cli spaces create <name> [--channel <name>]
  mousse-cli spaces invite <space-id> [--role member|admin] [--uses <count>] [--ttl 1d] [--joiner <user-id>]
  mousse-cli spaces join [sj1_<payload>] [--name <name>]
  mousse-cli spaces list
  mousse-cli spaces channels <space-id> [--name <new-channel-name>]
  mousse-cli spaces post <stream-id> <text> [--mentions <bot-id,bot-id>]
  mousse-cli spaces tail <stream-id> [--after <epoch:seq>] [--limit <count>] [--follow]
  mousse-cli spaces members <space-id>
  mousse-cli spaces leave <space-id>
  mousse-cli spaces outbox <stream-id> [--id <event-id> | --after <local-cursor>] [--limit <count>]

Use --profile <profile> for the local daemon profile. Initialize and protect each
profile before joining. Invite output is a secret; join without an argument reads
hidden or piped stdin. Posts retain their original event IDs and delivery states.
Offline posts stay queued. Leave fences new writes and retains local history;
its receipt shows whether the signed leave was delivered. Tail --follow polls
bounded verified public history until interrupted.
${SPACE_ARCHIVE_HELP}`
export interface SpacesCliRequest {
  method: SpacesLocalMethod
  params: SpacesLocalParams[SpacesLocalMethod]
  promptInvite?: boolean
  follow?: boolean
}
export interface SpacesCliIO {
  emit(value: unknown, text: string): void
  readInvite?(): Promise<string>
  signal?: AbortSignal
  wait?(signal?: AbortSignal): Promise<void>
}
export type SpacesCliClient = Pick<DaemonClient, 'request'>
function invalid(message: string): never {
  throw new NetError('bad_request', message)
}
function flag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags.get(key)
  if (value === undefined) return
  if (typeof value !== 'string' || !value.length) invalid(`--${key} requires a value.`)
  return value
}
export function prepareSpacesCommand(args: ParsedArgs): SpacesCliRequest {
  if (args.command !== 'spaces' || !SPACES_SUBCOMMANDS.includes(args.subcommand as any))
    invalid('Unknown spaces command.')
  if (
    args.globals.provider ||
    args.globals.model ||
    args.globals.apiKey ||
    args.globals.continueSession ||
    args.globals.sessionId
  )
    invalid('Spaces does not accept provider or execution overrides.')
  const sub = args.subcommand as (typeof SPACES_SUBCOMMANDS)[number],
    allowed: Record<typeof sub, string[]> = {
      create: ['channel'],
      invite: ['role', 'uses', 'ttl', 'joiner'],
      join: ['name'],
      list: [],
      channels: ['name'],
      post: ['mentions'],
      tail: ['after', 'limit', 'follow'],
      members: [],
      leave: [],
      outbox: ['id', 'after', 'limit']
    }
  for (const key of args.flags.keys())
    if (!['profile', 'json', 'mode', 'help'].includes(key) && !allowed[sub].includes(key))
      invalid(`Unexpected flag --${key}.`)
  const n = args.positional.length,
    max = sub === 'post' ? 2 : sub === 'list' ? 0 : 1
  if (n > max || n < (sub === 'join' || sub === 'list' ? 0 : max))
    invalid('Wrong number of command arguments.')
  let params: Record<string, unknown> = {},
    promptInvite = false
  const space = args.positional[0] as SpaceId,
    stream = args.positional[0] as StreamId
  switch (sub) {
    case 'create':
      params = {
        name: args.positional[0],
        ...(flag(args, 'channel') ? { channelName: flag(args, 'channel') } : {})
      }
      break
    case 'invite':
      params = {
        space,
        ...(flag(args, 'role') ? { role: flag(args, 'role') } : {}),
        ...(flag(args, 'uses') ? { uses: Number(flag(args, 'uses')) } : {}),
        ...(flag(args, 'ttl') ? { ttlMs: parseInviteTtl(flag(args, 'ttl')) } : {}),
        ...(flag(args, 'joiner') ? { joiner: flag(args, 'joiner') as UserId } : {})
      }
      break
    case 'join':
      promptInvite = !n
      params = {
        invite: args.positional[0] ?? '',
        ...(flag(args, 'name') ? { name: flag(args, 'name') } : {})
      }
      break
    case 'channels':
      params = { space, ...(flag(args, 'name') ? { name: flag(args, 'name') } : {}) }
      break
    case 'members':
    case 'leave':
      params = { space }
      break
    case 'post':
      params = {
        stream,
        text: args.positional[1],
        ...(flag(args, 'mentions') ? { mentions: flag(args, 'mentions')!.split(',') } : {})
      }
      break
    case 'outbox':
      params = {
        stream,
        ...(flag(args, 'id') ? { id: flag(args, 'id') } : {}),
        ...(flag(args, 'after') ? { after: Number(flag(args, 'after')) } : {}),
        ...(flag(args, 'limit') ? { limit: Number(flag(args, 'limit')) } : {})
      }
      break
    case 'tail': {
      params = { stream, ...(flag(args, 'limit') ? { limit: Number(flag(args, 'limit')) } : {}) }
      const position = flag(args, 'after')
      if (position) {
        const match = /^(\d+):(\d+)$/.exec(position)
        if (!match) invalid('--after requires epoch:seq.')
        params.after = { epoch: Number(match[1]), seq: Number(match[2]) }
      }
      if (args.flags.has('follow') && args.flags.get('follow') !== true)
        invalid('--follow is a switch.')
      break
    }
  }
  const method = `spaces.${sub}` as SpacesLocalMethod
  return {
    method,
    params: promptInvite
      ? (params as unknown as SpacesLocalParams[typeof method])
      : validateSpacesLocal(method, params),
    ...(promptInvite ? { promptInvite: true } : {}),
    ...(sub === 'tail' && args.flags.get('follow') === true ? { follow: true } : {})
  }
}
function wait(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const stop = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', stop)
        resolve()
      },
      timer = setTimeout(stop, 500)
    signal?.addEventListener('abort', stop, { once: true })
  })
}
export async function executeSpacesCommand(
  request: SpacesCliRequest,
  client: SpacesCliClient,
  io: SpacesCliIO
): Promise<number> {
  let params = request.params
  if (request.promptInvite) {
    if (!io.readInvite) invalid('Invitation input is unavailable.')
    params = { ...params, invite: await io.readInvite() } as SpacesLocalParams['spaces.join']
  }
  params = validateSpacesLocal(request.method, params)
  if (request.follow && request.method !== 'spaces.tail') invalid('--follow requires tail.')
  do {
    if (io.signal?.aborted) return 0
    const result = await client.request(request.method, params)
    io.emit(result, JSON.stringify(result, null, 2))
    if (!request.follow) return 0
    const page = result as SpaceLocalTail
    params = { ...(params as SpacesLocalParams['spaces.tail']), after: page.cursor }
    if (page.done) await (io.wait ?? wait)(io.signal)
  } while (!io.signal?.aborted)
  return 0
}
export async function runSpacesCommand(args: ParsedArgs): Promise<void> {
  if (!args.subcommand || args.subcommand === 'help' || args.globals.help) {
    process.stdout.write(SPACES_HELP)
    return
  }
  if (SPACE_ARCHIVE_SUBCOMMANDS.includes(args.subcommand as any)) {
    await runSpaceArchiveCommand(args)
    return
  }
  let client: DaemonClient | undefined
  const abort = new AbortController(),
    stop = () => abort.abort()
  try {
    const request = prepareSpacesCommand(args)
    // Read bearer input before daemon auto-start and keep it out of flags/history by default.
    if (request.promptInvite) {
      request.params = validateSpacesLocal('spaces.join', {
        ...request.params,
        invite: await readInviteSecret()
      })
      request.promptInvite = false
    }
    client = await connectDaemonClient({
      homeDir: args.globals.homeDir || undefined,
      requestTimeoutMs: 20000
    })
    const profile =
      args.globals.profile ??
      (await client.request<{ defaultProfileId: string }>('profiles.status')).defaultProfileId
    await client.request('profiles.bind', { profile })
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    process.exitCode = await executeSpacesCommand(request, client, {
      signal: abort.signal,
      emit: (value, text) => writeOutput(args.globals.mode, value, () => text)
    })
  } catch (error) {
    const failure = netCliFailure(error)
    process.stderr.write(
      args.globals.mode === 'json'
        ? `${JSON.stringify({ code: failure.code, error: failure.error })}\n`
        : `Error [${failure.code}]: ${failure.error}\n`
    )
    process.exitCode = failure.exitCode
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await client?.close()
  }
}
