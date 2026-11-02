import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { ensureWindowsConsoleTty, parseArgs } from './parseArgs'
import { exitWithError } from './output'
import { ROOT_HELP, commandHelp } from './help'
import { resolveMousseHome } from './paths'
import { runChat } from './commands/chat'
import { runSchedule } from './commands/schedule'
import { runApprovals } from './commands/approvals'
import { runWorkflow } from './commands/workflow'
import { runBrowser } from './commands/browser'
import { runAgents } from './commands/agents'
import { runEngine } from './commands/engine'
import { runConfig } from './commands/config'
import { runService } from './commands/service'
import { runThreadActionCommand } from './commands/threadActions'
import { runRelay } from './commands/relay'
import { runNet, runBridge } from './commands/net'
import { isBridgeHubCommand, runBridgeHubCommand } from './commands/bridge'
import { runSpacesCommand } from './commands/spaces'
import { runBotsCommand } from './commands/bots'
import { runDeprecatedControl } from './commands/deprecatedControl'
import { stripCliModeArgs } from './cliLaunch'
import { isSshProxyArgv } from './fastpath/sshProxy'

/**
 * Shared CLI entry used by standalone `out/cli/index.js` and packaged `Mousse.exe --cli`.
 */
export async function runCliMain(argv: string[] = process.argv.slice(2)): Promise<void> {
  // The editor proxy for the entries that have no early dispatch of their own (the standalone CLI executable).
  // Its stdout is the tunnel: nothing below may print before it.
  const plain = stripCliModeArgs(argv)
  if (isSshProxyArgv(plain)) {
    const { runSshProxy } = await import('./fastpath/sshProxy')
    process.exitCode = await runSshProxy(plain)
    return
  }
  // Electron on Windows often leaves stdin/stdout.isTTY false on a real console.
  ensureWindowsConsoleTty()
  // The packaged entry sets it from the app; a checkout run reads package.json. The daemon and
  // provider clients inherit it.
  process.env.MOUSSE_VERSION ||= readPackageVersion()

  const args = parseArgs(stripCliModeArgs(argv))
  const globals = args.globals

  if (globals.homeDir) {
    resolveMousseHome(globals.homeDir)
  }

  if (globals.version) {
    if (globals.mode === 'json') {
      const { CONTRACT_VERSIONS } = await import('../mms/contractVersions')
      process.stdout.write(`${JSON.stringify({ version: process.env.MOUSSE_VERSION, contracts: CONTRACT_VERSIONS }, null, 2)}\n`)
    } else {
      process.stdout.write(`mousse-cli ${process.env.MOUSSE_VERSION}\n`)
    }
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
      case 'workflow':
      case 'workflows':
        await runWorkflow(args)
        break
      case 'browser':
        await runBrowser(args)
        break
      case 'schedule':
        await runSchedule(args)
        break
      case 'approvals':
        await runApprovals(args)
        break
      case 'agents':
        await runAgents(args)
        break
      case 'engine':
        await runEngine(args)
        break
      case 'config':
        await runConfig(args)
        break
      case 'service':
        await runService(args)
        break
      case 'relay':
        await runRelay(args)
        break
      case 'net':
        await runNet(args)
        break
      case 'bridge':
        if (isBridgeHubCommand(args)) {
          await runBridgeHubCommand(args)
        } else {
          await runBridge(args)
        }
        break
      case 'spaces':
        await runSpacesCommand(args)
        break
      case 'bots':
        await runBotsCommand(args)
        break
      case 'control':
      case 'connections':
      case 'login':
      case 'logout':
        runDeprecatedControl(args)
        break
      case 'workspace':
      case 'publish':
      case 'undo':
      case 'revert-code':
      case 'redo':
      case 'fork':
      case 'operation':
        await runThreadActionCommand(args)
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
      return app.getVersion()
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
          return pkg.version ?? '0.0.0'
        }
      } catch {
        // try next
      }
    }
    return '0.0.0'
  } catch {
    return '0.0.0'
  }
}
