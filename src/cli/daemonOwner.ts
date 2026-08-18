/**
 * Sole production factory for the exclusive MMS daemon owner process.
 * Normal CLI commands and Electron must never import this module.
 * Tests may use MousseMainService.create directly.
 */

import type { CliGlobals } from './parseArgs'
import { resolveMousseHome } from './paths'
import {
  formatOwnerBusyMessage,
  MmsOwnerBusyError
} from '../mms/ownership/MmsOwnerLease'
import { exitWithError } from './output'
import type { MousseMainService } from './contract'
import type { MmsOptions } from './contract'

/**
 * Create and optionally start the exclusive daemon-owned MousseMainService.
 * `ownerKind` is always `daemon` for production service run.
 */
export async function createDaemonOwner(
  globals: Pick<CliGlobals, 'homeDir' | 'mode' | 'provider' | 'model' | 'apiKey'>,
  opts?: {
    start?: boolean
    requireOwnership?: boolean
  }
): Promise<{ homeDir: string; mms: MousseMainService }> {
  const homeDir = resolveMousseHome(globals.homeDir || undefined)
  try {
    const { MousseMainService } = await import('../mms/MousseMainService')
    const createOpts: MmsOptions = {
      homeDir,
      repoRoot: process.cwd(),
      headless: true,
      ownerKind: 'daemon',
      requireOwnership: opts?.requireOwnership,
      version: process.env.MOUSSE_VERSION ?? process.env.npm_package_version
    }
    const mms = await MousseMainService.create(createOpts)
    await mms.providerAuth.init()

    const patch: Record<string, unknown> = {}
    if (globals.provider) {
      patch.provider = { llmProvider: globals.provider }
    }
    if (globals.model) {
      patch.provider = {
        ...(patch.provider as Record<string, unknown> | undefined),
        model: globals.model
      }
    }
    if (Object.keys(patch).length > 0) {
      mms.settings.set(patch as Parameters<typeof mms.settings.set>[0])
    }
    if (globals.apiKey && globals.provider) {
      void mms.providerAuth.setApiKey(globals.provider, globals.apiKey)
    }

    if (opts?.start !== false) {
      await mms.start()
    }

    return { homeDir, mms }
  } catch (err) {
    if (err instanceof MmsOwnerBusyError) {
      exitWithError(
        formatOwnerBusyMessage(err.owner, err.heldUnreadable),
        globals.mode || 'text'
      )
    }
    throw err
  }
}
