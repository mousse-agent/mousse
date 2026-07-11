import { readFileSync } from 'fs'
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
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
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version?: string }
    return `mousse-cli ${pkg.version ?? '0.0.0'}`
  } catch {
    return 'mousse-cli'
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  exitWithError(message, 'text')
})
