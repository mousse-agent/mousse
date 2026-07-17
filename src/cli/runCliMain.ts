import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { parseArgs } from './parseArgs'
import { exitWithError } from './output'
import { ROOT_HELP, commandHelp } from './help'
import { resolveMousseHome } from './paths'
import { runChat } from './commands/chat'
import { runSchedule } from './commands/schedule'
import { runAgents } from './commands/agents'
import { runChannels } from './commands/channels'
import { runConfig } from './commands/config'
import { runService } from './commands/service'
import { stripCliModeArgs } from './cliLaunch'

/**
 * Shared CLI entry used by standalone `out/cli/index.js` and packaged `Mousse.exe --cli`.
 */
export async function runCliMain(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(stripCliModeArgs(argv))
  const globals = args.globals

  if (globals.homeDir) {
    resolveMousseHome(globals.homeDir)
  }

  if (globals.version) {
    process.stdout.write(`${readPackageVersion()}\n`)
    return
  }

  if (globals.help && !args.command) {
    process.stdout.write(ROOT_HELP)
    return
  }

  if (globals.help && args.command) {
    const help = commandHelp(args.command)
    if (help) {
      process.stdout.write(help)
      return
    }
  }

  try {
    switch (args.command) {
      case 'schedule':
        await runSchedule(args)
        break
      case 'agents':
        await runAgents(args)
        break
      case 'channels':
        await runChannels(args)
        break
      case 'config':
        await runConfig(args)
        break
      case 'service':
        await runService(args)
        break
      default:
        await runChat(args)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    exitWithError(message, globals.mode)
  }
}

function readPackageVersion(): string {
  if (process.versions.electron) {
    try {
      const require = createRequire(import.meta.url)
      const { app } = require('electron') as { app: { getVersion: () => string } }
      return `mousse-cli ${app.getVersion()}`
    } catch {
      // fall through to package.json probe
    }
  }

  try {
    // out/cli/index.js → package root is ../..
    // electron out/main chunks → walk up for package.json
    const here = dirname(fileURLToPath(import.meta.url))
    const candidates = [
      join(here, '..', '..', 'package.json'),
      join(here, '..', 'package.json'),
      join(here, 'package.json'),
      ...(typeof process.resourcesPath === 'string'
        ? [
            join(process.resourcesPath, 'app.asar', 'package.json'),
            join(process.resourcesPath, 'app', 'package.json')
          ]
        : [])
    ]
    for (const pkgPath of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string; name?: string }
        if (pkg.version || pkg.name === 'mousse') {
          return `mousse-cli ${pkg.version ?? '0.0.0'}`
        }
      } catch {
        // try next
      }
    }
    return 'mousse-cli'
  } catch {
    return 'mousse-cli'
  }
}

