import { existsSync } from 'fs'
import type { CliGlobals, ParsedArgs } from '../parseArgs'
import { exitWithError, formatTable, writeOutput } from '../output'
import { resolveMousseHome } from '../paths'
import { ENGINE_HELP } from '../help'
import { createInstallationPaths } from '../../mms/profiles/paths'
import { ProfileManager } from '../../mms/profiles/ProfileManager'
import { RunFsck, type FsckFinding } from '../../mms/run/fsck/RunFsck'
import { MOUSSE_MCP_TOKEN_ENV } from '../../mms/run/mcp/attachment'
import { runStdioBridge } from '../../mms/run/mcp/stdioBridge'

/**
 * Local Run Engine maintenance commands. These read the profile's run state directly from disk
 * and do not need a daemon connection.
 */
export async function runEngine(args: ParsedArgs): Promise<void> {
  const { globals, subcommand } = args

  if (!subcommand || subcommand === 'help' || globals.help) {
    process.stdout.write(ENGINE_HELP)
    return
  }

  switch (subcommand) {
    case 'fsck': {
      const findings = new RunFsck({ profileHome: resolveLocalProfileHome(globals) }).check()
      writeOutput(globals.mode, findings, (data) => {
        const rows = data as FsckFinding[]
        if (rows.length === 0) return 'No findings.'
        return formatTable([
          ['SEVERITY', 'CODE', 'MESSAGE'],
          ...rows.map((finding) => [finding.severity, finding.code, finding.message])
        ])
      })
      if (findings.some((finding) => finding.severity === 'error')) process.exitCode = 1
      break
    }
    case 'mcp-stdio': {
      // Relays a stdio MCP client to the daemon's Mousse MCP server (SPEC §15.1). stdout carries
      // JSON-RPC only; the token comes from the environment (or --token) and is never printed.
      const url = args.flags.get('url')
      const tokenFlag = args.flags.get('token')
      const token = typeof tokenFlag === 'string' ? tokenFlag : process.env[MOUSSE_MCP_TOKEN_ENV]
      if (typeof url !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(url))
        throw new Error('engine mcp-stdio requires --url http://127.0.0.1:<port>/mcp')
      if (!token) throw new Error(`engine mcp-stdio requires --token or ${MOUSSE_MCP_TOKEN_ENV}`)
      await runStdioBridge({ url, token, input: process.stdin, output: process.stdout })
      break
    }
    default:
      exitWithError(`Unknown engine subcommand: ${subcommand}`, globals.mode)
  }
}

/** Resolve the selected (or default) profile root from the installation manifest on disk. */
function resolveLocalProfileHome(globals: CliGlobals): string {
  const installation = createInstallationPaths(resolveMousseHome(globals.homeDir || undefined))
  if (!existsSync(installation.installationManifest)) {
    if (globals.profile) {
      throw new Error(`No profiles are initialized in ${installation.homeDir}; cannot select --profile ${globals.profile}.`)
    }
    // Pre-profile installations keep their state directly in MOUSSE_HOME.
    return installation.homeDir
  }
  const manager = ProfileManager.open(installation)
  return manager.getPaths(globals.profile ?? manager.getDefaultProfileId()).root
}
