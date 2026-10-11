import type { ParsedArgs } from '../parseArgs'
import { connectDaemonClient, type DaemonClient } from '../daemonClient'
import { writeOutput } from '../output'
import { NetError } from '../../shared/net'
import type { BotsLocalMethod, BotsLocalParams } from '../../shared/bots/local'
import { validateBotsLocal } from '../../mms/bots/registerMethods'
import { netCliFailure } from './net'

export const BOTS_SUBCOMMANDS = [
  'add',
  'list',
  'configure',
  'qualify',
  'stop',
  'resume',
  'grant',
  'presence'
] as const
export const BOTS_HELP = `Usage:
  mousse-cli bots add <space-id> <name> --id <rpc-id> [--profile-kind chat|reader]
      [--visibility public|private] [--steer owner|everyone|roles] [--roles owner,admin,member]
  mousse-cli bots list [--limit <count>] [--after-space <space-id> --after-bot <bot-id>]
  mousse-cli bots configure <space-id> <bot-id> --adapter <id> --profile-kind chat|reader|operator
      --definition-revision <revision> --profile-digest <digest> --daily-budget <units>
      --run-ceiling <units> --max-concurrent <count> --runs-per-member-hour <count> [--project-id <id>]
  mousse-cli bots qualify <space-id> <bot-id> --definition-revision <revision> --profile-digest <digest>
  mousse-cli bots stop <space-id> <bot-id>
  mousse-cli bots resume <space-id> <bot-id>
  mousse-cli bots grant <stream-id> <request-id> --approve|--deny
  mousse-cli bots presence <space-id> <bot-id> <channel-stream-id>

Use --profile <profile> to bind the local daemon profile. Configure requires an
existing owner-signed bot placement and local keys. Reader project IDs identify
projects already registered in this profile. Qualification requires independently
installed adapter evidence; the default production native adapter is inactive.
Grant signs the exact private owner decision and returns its actual delivery state.
Resume does not qualify a runtime. Add requires an unlocked protected root-authority
profile; retain --id to recover the original registration after an unknown response.
`
export interface BotsCliRequest {
  method: BotsLocalMethod
  params: BotsLocalParams[BotsLocalMethod]
}
function invalid(message: string): never {
  throw new NetError('bad_request', message)
}
function flag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags.get(key)
  if (value === undefined) return
  if (typeof value !== 'string' || !value.length) invalid(`--${key} requires a value.`)
  return value
}
export function prepareBotsCommand(args: ParsedArgs): BotsCliRequest {
  if (args.command !== 'bots' || !BOTS_SUBCOMMANDS.includes(args.subcommand as any))
    invalid('Unknown bots command.')
  if (
    args.globals.provider ||
    args.globals.model ||
    args.globals.apiKey ||
    args.globals.continueSession ||
    args.globals.sessionId
  )
    invalid('Bots does not accept provider or execution overrides.')
  const sub = args.subcommand as (typeof BOTS_SUBCOMMANDS)[number],
    allowed: Record<typeof sub, string[]> = {
      add: ['id', 'profile-kind', 'visibility', 'steer', 'roles'],
      list: ['limit', 'after-space', 'after-bot'],
      configure: [
        'adapter',
        'profile-kind',
        'definition-revision',
        'profile-digest',
        'daily-budget',
        'run-ceiling',
        'max-concurrent',
        'runs-per-member-hour',
        'project-id'
      ],
      qualify: ['definition-revision', 'profile-digest'],
      stop: [],
      resume: [],
      grant: ['approve', 'deny'],
      presence: []
    }
  for (const key of args.flags.keys())
    if (!['profile', 'json', 'mode', 'help'].includes(key) && !allowed[sub].includes(key))
      invalid(`Unexpected flag --${key}.`)
  const count = sub === 'list' ? 0 : sub === 'presence' ? 3 : 2
  if (args.positional.length !== count) invalid('Wrong number of command arguments.')
  let params: Record<string, unknown> =
    sub === 'list' ? {} : { space: args.positional[0], bot: args.positional[1] }
  switch (sub) {
    case 'add': {
      const kind = flag(args, 'steer') ?? 'owner',
        roles = flag(args, 'roles')
      params = {
        id: flag(args, 'id'),
        space: args.positional[0],
        name: args.positional[1],
        profile: flag(args, 'profile-kind') ?? 'chat',
        policy: {
          visibility: flag(args, 'visibility') ?? 'public',
          steer: { kind, ...(roles ? { roles: roles.split(',') } : {}) }
        }
      }
      break
    }
    case 'list': {
      const space = flag(args, 'after-space'),
        bot = flag(args, 'after-bot')
      if (!!space !== !!bot) invalid('List cursor requires both --after-space and --after-bot.')
      params = {
        ...(space ? { after: { space, bot } } : {}),
        ...(flag(args, 'limit') ? { limit: Number(flag(args, 'limit')) } : {})
      }
      break
    }
    case 'configure': {
      params = {
        ...params,
        adapter: flag(args, 'adapter'),
        profile: flag(args, 'profile-kind'),
        definitionRevision: flag(args, 'definition-revision'),
        profileDigest: flag(args, 'profile-digest'),
        dailyBudgetUnits: Number(flag(args, 'daily-budget')),
        runCeilingUnits: Number(flag(args, 'run-ceiling')),
        maxConcurrent: Number(flag(args, 'max-concurrent')),
        runsPerMemberHour: Number(flag(args, 'runs-per-member-hour')),
        ...(flag(args, 'project-id') ? { projectId: flag(args, 'project-id') } : {})
      }
      break
    }
    case 'qualify':
      params = {
        ...params,
        definitionRevision: flag(args, 'definition-revision'),
        profileDigest: flag(args, 'profile-digest')
      }
      break
    case 'presence':
      params = { ...params, stream: args.positional[2] }
      break
    case 'grant': {
      if (
        (args.flags.has('approve') && args.flags.get('approve') !== true) ||
        (args.flags.has('deny') && args.flags.get('deny') !== true) ||
        args.flags.has('approve') === args.flags.has('deny')
      )
        invalid('Grant requires exactly one of --approve or --deny.')
      params = {
        stream: args.positional[0],
        request: args.positional[1],
        approved: args.flags.get('approve') === true
      }
      break
    }
  }
  const method = `bots.${sub}` as BotsLocalMethod
  return { method, params: validateBotsLocal(method, params) }
}
export async function executeBotsCommand(
  request: BotsCliRequest,
  client: Pick<DaemonClient, 'request'>,
  emit: (value: unknown, text: string) => void
): Promise<number> {
  const result = await client.request(
    request.method,
    validateBotsLocal(request.method, request.params)
  )
  emit(result, JSON.stringify(result, null, 2))
  return 0
}
export async function runBotsCommand(args: ParsedArgs): Promise<void> {
  if (!args.subcommand || args.subcommand === 'help' || args.globals.help) {
    process.stdout.write(BOTS_HELP)
    return
  }
  let client: DaemonClient | undefined
  try {
    const request = prepareBotsCommand(args)
    client = await connectDaemonClient({
      homeDir: args.globals.homeDir || undefined,
      requestTimeoutMs: 20000
    })
    const profile =
      args.globals.profile ??
      (await client.request<{ defaultProfileId: string }>('profiles.status')).defaultProfileId
    await client.request('profiles.bind', { profile })
    process.exitCode = await executeBotsCommand(request, client, (value, text) =>
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
