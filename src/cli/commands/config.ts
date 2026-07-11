import type { ProviderLoginOption } from '../../shared/providerAuth'
import type { ParsedArgs } from '../parseArgs'
import { flagString } from '../parseArgs'
import { exitWithError, writeOutput } from '../output'
import { openMms } from '../mmsContext'
import { CONFIG_HELP } from '../help'
import { promptLine, promptSelect } from './chat'

export async function runConfig(args: ParsedArgs): Promise<void> {
  const { globals, subcommand, positional, flags } = args

  if (!subcommand || subcommand === 'help' || globals.help) {
    process.stdout.write(CONFIG_HELP)
    return
  }

  if (subcommand === 'providers') {
    await runConfigProviders(args)
    return
  }

  const { mms } = await openMms(globals)

  try {
    switch (subcommand) {
      case 'list': {
        const prefix = positional[0]
        const entries = mms.config.list(prefix)
        writeOutput(globals.mode, entries)
        break
      }
      case 'get': {
        const path = positional[0]
        if (!path) exitWithError('config get requires a dotted path.', globals.mode)
        const value = mms.config.get(path)
        writeOutput(globals.mode, value)
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
        mms.config.set(path, parsed)
        mms.config.save()
        writeOutput(globals.mode, { path, value: parsed })
        break
      }
      default:
        exitWithError(`Unknown config subcommand: ${subcommand}`, globals.mode)
    }
  } finally {
    await mms.stop()
  }
}

async function runConfigProviders(args: ParsedArgs): Promise<void> {
  const { globals, flags } = args
  const { mms } = await openMms(globals)

  try {
    let providerId = flagString(flags, 'provider') ?? globals.provider
    let model = flagString(flags, 'model') ?? globals.model
    const apiKey = flagString(flags, 'api-key') ?? globals.apiKey

    if (!providerId) {
      const options = mms.providerAuth.getLoginOptions('api_key')
      providerId =
        (await promptSelect(
          'Select orchestrator provider:',
          options.map((o: ProviderLoginOption) => ({ id: o.id, label: o.label }))
        )) ?? undefined
    }

    if (!providerId) {
      exitWithError('No provider selected. Use --provider.', globals.mode)
    }

    if (apiKey) {
      await mms.providerAuth.setApiKey(providerId, apiKey)
    } else if (!mms.providerAuth.has(providerId)) {
      const ambient = mms.providerAuth.getAmbientProviderInfo(providerId)
      if (ambient) {
        const result = await mms.providerAuth.runApiKeyLogin(mms.providerAuth.createSession(), providerId)
        if (!result.success) {
          exitWithError(result.error ?? 'Provider setup failed.', globals.mode)
        }
      } else {
        const key = await promptLine(`API key for ${providerId}: `, true)
        if (key.trim()) {
          await mms.providerAuth.setApiKey(providerId, key)
        }
      }
    }

    if (!model) {
      model = await promptLine('Default model id (optional): ')
    }

    if (model?.trim()) {
      mms.settings.set({
        provider: { llmProvider: providerId, model: model.trim() }
      })
      mms.config.set('settings.provider', { llmProvider: providerId, model: model.trim() })
      mms.config.save()
    }

    writeOutput(globals.mode, {
      provider: providerId,
      model: model?.trim() || mms.settings.get().provider.model,
      configured: mms.providerAuth.has(providerId)
    })
  } finally {
    await mms.stop()
  }
}
