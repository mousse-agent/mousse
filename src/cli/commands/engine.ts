import { existsSync } from 'fs'
import type { CliGlobals, ParsedArgs } from '../parseArgs'
import { exitWithError, formatTable, writeOutput } from '../output'
import { resolveMousseHome } from '../paths'
import { ENGINE_HELP } from '../help'
import { createInstallationPaths } from '../../mms/profiles/paths'
import { ProfileManager } from '../../mms/profiles/ProfileManager'
import { RunFsck, type FsckFinding } from '../../mms/run/fsck/RunFsck'

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
