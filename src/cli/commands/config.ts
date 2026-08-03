import type { ProviderLoginOption } from '../../shared/providerAuth'
import type { ParsedArgs } from '../parseArgs'
import { flagString } from '../parseArgs'
import { exitWithError, writeOutput } from '../output'
import { closeMmsContext, openMms } from '../mmsContext'
import { CONFIG_HELP } from '../help'
import { promptLine, promptSelect } from './chat'

export async function runConfig(args: ParsedArgs): Promise<void> {
  const { globals, subcommand, positional } = args

  if (!subcommand || subcommand === 'help' || globals.help) {
    process.stdout.write(CONFIG_HELP)
    return
  }

  if (subcommand === 'providers') {
    await runConfigProviders(args)
    return
  }

  const ctx = await openMms(globals)
  const client = ctx.client

  try {
    switch (subcommand) {
      case 'list':
      case 'get': {
        const res = await client.request<{ settings: unknown }>('settings.get')
        if (subcommand === 'get') {
          const path = positional[0]
          if (!path) exitWithError('config get requires a dotted path.', globals.mode)
          writeOutput(globals.mode, getByPath(res.settings, path))
        } else {
          writeOutput(globals.mode, res.settings)
        }
        break
      }
      case 'set': {
        const path = positional[0]
        const rawValue = positional.slice(1).join(' ')
        if (!path || !rawValue) {
          exitWithError('config set requires <path> <json-value>.', globals.mode)
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(rawValue)
        } catch {
          parsed = rawValue
        }
        const partial = pathToPartial(path, parsed)
        await client.request('settings.set', { partial })
        writeOutput(globals.mode, { path, value: parsed })
        break
      }
      default:
        exitWithError(`Unknown config subcommand: ${subcommand}`, globals.mode)
    }
  } finally {
    await closeMmsContext(ctx)
  }
}

async function runConfigProviders(args: ParsedArgs): Promise<void> {
  const { globals, flags } = args
  const ctx = await openMms(globals)
  const client = ctx.client

  try {
    let providerId = flagString(flags, 'provider') ?? globals.provider
    let model = flagString(flags, 'model') ?? globals.model
    const apiKey = flagString(flags, 'api-key') ?? globals.apiKey

    if (!providerId) {
      const optionsRes = await client.request<{ options: ProviderLoginOption[] }>(
        'providers.getLoginOptions',
        { authType: 'api_key' }
      )
      providerId =
        (await promptSelect(
          'Select orchestrator provider:',
          optionsRes.options.map((o) => ({ id: o.id, label: o.label }))
        )) ?? undefined
    }

    if (!providerId) {
      exitWithError('No provider selected. Use --provider.', globals.mode)
    }

    if (apiKey) {
      await client.request('providers.setApiKey', { providerId, apiKey })
    }

    if (!model) {
      model = await promptLine('Default model id (optional): ')
    }

    if (model?.trim()) {
      await client.request('settings.set', {
        partial: { provider: { llmProvider: providerId, model: model.trim() } }
      })
    }

    const configured = await client.request<{ providers: { id: string }[] }>(
      'providers.listConfigured'
    )
    const settings = await client.request<{ settings: { provider: { model?: string } } }>(
      'settings.get'
    )
    writeOutput(globals.mode, {
      provider: providerId,
      model: model?.trim() || settings.settings.provider.model,
      configured: configured.providers.some((p) => p.id === providerId)
    })
  } finally {
    await closeMmsContext(ctx)
  }
}

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function pathToPartial(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.')
  const root: Record<string, unknown> = {}
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {}
    cur[parts[i]] = next
    cur = next
  }
  cur[parts[parts.length - 1]] = value
  if (parts[0] === 'settings' && parts.length > 1) {
    return root.settings as Record<string, unknown>
  }
  return root
}
