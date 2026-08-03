import type {
  ChannelPlatform,
  ChannelPlatformConfig,
  ChannelConfig,
  PairingRequest
} from '../../shared/types'
import type { ParsedArgs } from '../parseArgs'
import { flagBool, flagString } from '../parseArgs'
import { exitWithError, formatTable, writeOutput } from '../output'
import { closeMmsContext, openMms } from '../mmsContext'
import { CHANNELS_HELP } from '../help'

const PLATFORMS = new Set<ChannelPlatform>(['telegram', 'discord', 'webhook'])

export async function runChannels(args: ParsedArgs): Promise<void> {
  const { globals, subcommand, positional, flags } = args

  if (!subcommand || subcommand === 'help' || globals.help) {
    process.stdout.write(CHANNELS_HELP)
    return
  }

  if (subcommand === 'pair') {
    await runPairSubcommand(args)
    return
  }

  const ctx = await openMms(globals)
  const client = ctx.client

  try {
    switch (subcommand) {
      case 'list': {
        const res = await client.request<{
          snapshot: {
            statuses: { platform: string; state: string }[]
            config: ChannelConfig
          }
        }>('channels.getSnapshot')
        writeOutput(globals.mode, res.snapshot, (data) => {
          const snap = data as {
            statuses: { platform: string; state: string }[]
            config: ChannelConfig
          }
          const rows: string[][] = [['PLATFORM', 'ENABLED', 'STATE']]
          for (const status of snap.statuses) {
            rows.push([
              status.platform,
              String(snap.config.platforms[status.platform as ChannelPlatform]?.enabled),
              status.state
            ])
          }
          return formatTable(rows)
        })
        break
      }
      case 'add': {
        const platform = positional[0] as ChannelPlatform | undefined
        if (!platform || !PLATFORMS.has(platform)) {
          exitWithError(
            'channels add requires platform: telegram, discord, or webhook',
            globals.mode
          )
        }
        const patch = buildPlatformPatch(platform, flags)
        const res = await client.request<{ config: ChannelConfig }>('channels.updateConfig', {
          patch: { platforms: { [platform]: patch } }
        })
        await client.request('channels.connect', { platform })
        writeOutput(globals.mode, res.config)
        break
      }
      case 'remove': {
        const platform = positional[0] as ChannelPlatform | undefined
        if (!platform || !PLATFORMS.has(platform)) {
          exitWithError('channels remove requires a platform name.', globals.mode)
        }
        await client.request('channels.disconnect', { platform })
        const res = await client.request<{ config: ChannelConfig }>('channels.updateConfig', {
          patch: { platforms: { [platform]: { enabled: false } } }
        })
        writeOutput(globals.mode, res.config)
        break
      }
      case 'enable': {
        const platform = positional[0] as ChannelPlatform | undefined
        if (!platform || !PLATFORMS.has(platform)) {
          exitWithError('channels enable requires a platform name.', globals.mode)
        }
        const res = await client.request<{ config: ChannelConfig }>('channels.updateConfig', {
          patch: { platforms: { [platform]: { enabled: true } } }
        })
        await client.request('channels.connect', { platform })
        writeOutput(globals.mode, res.config)
        break
      }
      case 'disable': {
        const platform = positional[0] as ChannelPlatform | undefined
        if (!platform || !PLATFORMS.has(platform)) {
          exitWithError('channels disable requires a platform name.', globals.mode)
        }
        await client.request('channels.disconnect', { platform })
        const res = await client.request<{ config: ChannelConfig }>('channels.updateConfig', {
          patch: { platforms: { [platform]: { enabled: false } } }
        })
        writeOutput(globals.mode, res.config)
        break
      }
      default:
        exitWithError(`Unknown channels subcommand: ${subcommand}`, globals.mode)
    }
  } finally {
    await closeMmsContext(ctx)
  }
}

async function runPairSubcommand(args: ParsedArgs): Promise<void> {
  const { globals, positional } = args
  const action = positional[0]

  if (!action || action === 'help') {
    process.stdout.write(`${CHANNELS_HELP}\nPair subcommands: list, approve, reject\n`)
    return
  }

  const ctx = await openMms(globals)
  const client = ctx.client

  try {
    switch (action) {
      case 'list': {
        const res = await client.request<{ requests: PairingRequest[] }>(
          'channels.listPairingRequests'
        )
        writeOutput(globals.mode, res.requests, (data) => {
          const rows = data as PairingRequest[]
          if (rows.length === 0) return 'No pending pairing requests.'
          return formatTable([
            ['CODE', 'PLATFORM', 'USER', 'EXPIRES'],
            ...rows.map((req) => [
              req.code,
              req.platform,
              req.userName ?? req.userId,
              req.expiresAt
            ])
          ])
        })
        break
      }
      case 'approve': {
        const code = positional[1] ?? positional[0]
        if (!code || code === 'approve') {
          exitWithError('channels pair approve requires a pairing code.', globals.mode)
        }
        const res = await client.request<{ ok: boolean }>('channels.approvePairing', {
          code
        })
        if (!res.ok) exitWithError(`Invalid or expired pairing code: ${code}`, globals.mode)
        writeOutput(globals.mode, { approved: code.toUpperCase() })
        break
      }
      case 'reject': {
        const code = positional[1] ?? positional[0]
        if (!code || code === 'reject') {
          exitWithError('channels pair reject requires a pairing code.', globals.mode)
        }
        const res = await client.request<{ ok: boolean }>('channels.rejectPairing', {
          code
        })
        if (!res.ok) exitWithError(`Invalid pairing code: ${code}`, globals.mode)
        writeOutput(globals.mode, { rejected: code.toUpperCase() })
        break
      }
      default:
        exitWithError(`Unknown pair subcommand: ${action}`, globals.mode)
    }
  } finally {
    await closeMmsContext(ctx)
  }
}

function buildPlatformPatch(
  platform: ChannelPlatform,
  flags: Map<string, string | boolean>
): Partial<ChannelPlatformConfig> {
  const patch: Partial<ChannelPlatformConfig> = { enabled: true }
  const token = flagString(flags, 'token')
  const webhookPort = flagString(flags, 'webhook-port')
  const webhookSecret = flagString(flags, 'webhook-secret')

  if (token) patch.token = token
  if (webhookPort) patch.webhookPort = Number(webhookPort)
  if (webhookSecret) patch.webhookSecret = webhookSecret
  if (flagBool(flags, 'allow-all')) patch.allowAllUsers = true

  const userIds: string[] = []
  for (const [key, value] of flags.entries()) {
    if (key === 'user-id' && typeof value === 'string') {
      userIds.push(value)
    }
  }
  if (userIds.length > 0) {
    patch.allowedUserIds = userIds
  }

  if (platform === 'webhook' && !patch.webhookPort) {
    patch.webhookPort = 8787
  }

  return patch
}
