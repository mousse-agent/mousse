import type { ChannelPlatform, ChannelPlatformConfig, ChannelConfig, PairingRequest } from '../../shared/types'
import type { ParsedArgs } from '../parseArgs'
import { flagBool, flagString } from '../parseArgs'
import { exitWithError, formatTable, writeOutput } from '../output'
import { openMms } from '../mmsContext'
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

  const { mms } = await openMms(globals)

  try {
    switch (subcommand) {
      case 'list': {
        const snapshot = mms.channels.getSnapshot()
        writeOutput(globals.mode, snapshot, (data) => {
          const snap = data as ReturnType<typeof mms.channels.getSnapshot>
          const rows: string[][] = [['PLATFORM', 'ENABLED', 'STATE']]
          for (const status of snap.statuses) {
            rows.push([status.platform, String(snap.config.platforms[status.platform]?.enabled), status.state])
          }
          return formatTable(rows)
        })
        break
      }
      case 'add': {
        const platform = positional[0] as ChannelPlatform | undefined
        if (!platform || !PLATFORMS.has(platform)) {
          exitWithError('channels add requires platform: telegram, discord, or webhook', globals.mode)
        }
        const patch = buildPlatformPatch(platform, flags)
        const config = mms.channels.updateConfig({
          platforms: { [platform]: patch } as ChannelConfig['platforms']
        })
        await mms.channels.connect(platform)
        writeOutput(globals.mode, config)
        break
      }
      case 'remove': {
        const platform = positional[0] as ChannelPlatform | undefined
        if (!platform || !PLATFORMS.has(platform)) {
          exitWithError('channels remove requires a platform name.', globals.mode)
        }
        await mms.channels.disconnect(platform)
        const config = mms.channels.updateConfig({
          platforms: { [platform]: { enabled: false } } as ChannelConfig['platforms']
        })
        writeOutput(globals.mode, config)
        break
      }
      case 'enable': {
        const platform = positional[0] as ChannelPlatform | undefined
        if (!platform || !PLATFORMS.has(platform)) {
          exitWithError('channels enable requires a platform name.', globals.mode)
        }
        const config = mms.channels.updateConfig({
          platforms: { [platform]: { enabled: true } } as ChannelConfig['platforms']
        })
        await mms.channels.connect(platform)
        writeOutput(globals.mode, config)
        break
      }
      case 'disable': {
        const platform = positional[0] as ChannelPlatform | undefined
        if (!platform || !PLATFORMS.has(platform)) {
          exitWithError('channels disable requires a platform name.', globals.mode)
        }
        await mms.channels.disconnect(platform)
        const config = mms.channels.updateConfig({
          platforms: { [platform]: { enabled: false } } as ChannelConfig['platforms']
        })
        writeOutput(globals.mode, config)
        break
      }
      default:
        exitWithError(`Unknown channels subcommand: ${subcommand}`, globals.mode)
    }
  } finally {
    await mms.stop()
  }
}

async function runPairSubcommand(args: ParsedArgs): Promise<void> {
  const { globals, positional } = args
  const action = positional[0]

  if (!action || action === 'help') {
    process.stdout.write(`${CHANNELS_HELP}\nPair subcommands: list, approve, reject\n`)
    return
  }

  const { mms } = await openMms(globals)

  try {
    switch (action) {
      case 'list': {
        const requests = mms.channels.listPairingRequests()
        writeOutput(globals.mode, requests, (data) => {
          const rows = data as ReturnType<typeof mms.channels.listPairingRequests>
          if (rows.length === 0) return 'No pending pairing requests.'
          return formatTable([
            ['CODE', 'PLATFORM', 'USER', 'EXPIRES'],
            ...rows.map((req: PairingRequest) => [req.code, req.platform, req.userName ?? req.userId, req.expiresAt])
          ])
        })
        break
      }
      case 'approve': {
        const code = positional[1] ?? positional[0]
        if (!code || code === 'approve') {
          exitWithError('channels pair approve requires a pairing code.', globals.mode)
        }
        const ok = mms.channels.approvePairing(code)
        if (!ok) exitWithError(`Invalid or expired pairing code: ${code}`, globals.mode)
        writeOutput(globals.mode, { approved: code.toUpperCase() })
        break
      }
      case 'reject': {
        const code = positional[1] ?? positional[0]
        if (!code || code === 'reject') {
          exitWithError('channels pair reject requires a pairing code.', globals.mode)
        }
        const ok = mms.channels.rejectPairing(code)
        if (!ok) exitWithError(`Invalid pairing code: ${code}`, globals.mode)
        writeOutput(globals.mode, { rejected: code.toUpperCase() })
        break
      }
      default:
        exitWithError(`Unknown pair subcommand: ${action}`, globals.mode)
    }
  } finally {
    await mms.stop()
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
