import { readFileSync } from 'node:fs'
import {
  createControlStoreCredentialAdapter,
  createInstallationPaths,
  createRetainingGitWorktreeAdapter,
  ProfileManager,
  ProfileMigrationService
} from '../../../../src/mms/profiles'
import type { MigrationStepId } from '../../../../src/mms/profiles/migration/types'

const config = JSON.parse(readFileSync(process.env.MOUSSE_MIGRATION_CRASH_CONFIG!, 'utf8')) as {
  home: string
  crashAfter: MigrationStepId
}

const installation = createInstallationPaths(config.home)
const service = new ProfileMigrationService(installation, ProfileManager.open(installation))
service.run({
  adapters: {
    credentials: createControlStoreCredentialAdapter(),
    gitWorktrees: createRetainingGitWorktreeAdapter()
  },
  hooks: {
    afterStepAction(step) {
      if (step !== config.crashAfter) return
      // On Windows Node maps SIGKILL to TerminateProcess. No finally block or
      // migration lock cleanup runs, matching abrupt process loss.
      process.kill(process.pid, 'SIGKILL')
    }
  }
})

throw new Error(`Migration completed without reaching crash step ${config.crashAfter}`)
