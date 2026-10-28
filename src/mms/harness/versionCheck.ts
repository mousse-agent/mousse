import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CompatibilityState } from '../../shared/harness/status'
import { RECEIPT_FILE, readReceipt } from './agents/receipt'
import { COMPATIBILITY, compatibilityFields, type CompatibilityKey } from './compatibility'
import type { HarnessDriver } from './driver'
import { instanceEnv } from './env'
import { probeVersion } from './status'

/**
 * The developer's upkeep check (`scripts/check-agent-versions.mjs`): every agent found on PATH, and
 * every agent Mousse installed (read from its install receipts), against `COMPATIBILITY`. It runs
 * only `probeVersion`, so it never starts an agent for a turn, checks a sign-in or lists models.
 */

/** What the check needs of a driver: its static descriptor, never a runtime. */
export type VersionCheckDriver = Pick<HarnessDriver, 'kind' | 'label' | 'binaryNames' | 'canInstall' | 'testedVersions' | 'knownBroken' | 'versionArgs'>

export interface AgentVersionReport {
  label: string
  /** The row of `COMPATIBILITY` it was checked against. */
  key: CompatibilityKey
  source: 'path' | 'managed'
  path?: string
  version?: string
  state: CompatibilityState | 'not_found' | 'did_not_run'
  testedRange?: string
  /** The known problem, or why no version was read. */
  note?: string
}

/** The driver descriptor a registry agent Mousse installed is checked as: its ACP preset's row, else the generic one. */
function registryDriver(agentId: string): VersionCheckDriver {
  const key: CompatibilityKey = Object.prototype.hasOwnProperty.call(COMPATIBILITY, `acp:${agentId}`) ? `acp:${agentId}` : 'acp:generic'
  return { kind: 'acp', label: agentId, binaryNames: [], canInstall: true, ...compatibilityFields(key) }
}

export async function checkAgentVersions(input: {
  /** Drivers whose agents are looked up on PATH. */
  drivers: ReadonlyArray<VersionCheckDriver & { key: CompatibilityKey }>
  /** Extra directories searched before PATH (a login shell's PATH, a test's fake binaries). */
  searchPath?: readonly string[]
  /** The environment the version flags run with (default: this process's). */
  base?: NodeJS.ProcessEnv
  /** Mousse's installation folder: its `agents/` receipts list what Mousse installed. */
  installationHome?: string
}): Promise<AgentVersionReport[]> {
  const reports: AgentVersionReport[] = []
  for (const driver of input.drivers) {
    if (!driver.binaryNames.length) continue
    const env = instanceEnv({ instanceId: `check:${driver.kind}`, driver: driver.kind, configRevision: 0, searchPath: input.searchPath ?? [], ...(input.base ? { base: input.base } : {}) })
    const found = await probeVersion({ driver, env })
    reports.push(report(driver.label, driver.key, 'path', found))
  }
  if (input.installationHome) {
    for (const receipt of installedReceipts(join(input.installationHome, 'agents'))) {
      const driver = registryDriver(receipt.agentId)
      const env = instanceEnv({ instanceId: `check:${receipt.agentId}`, driver: 'acp', configRevision: 0, searchPath: [], ...(input.base ? { base: input.base } : {}) })
      const found = await probeVersion({ driver, env, managed: { path: receipt.path, version: receipt.version, receiptHash: receipt.hash }, pinned: true })
      reports.push(report(receipt.agentId, Object.prototype.hasOwnProperty.call(COMPATIBILITY, `acp:${receipt.agentId}`) ? `acp:${receipt.agentId}` : 'acp:generic', 'managed', found))
    }
  }
  return reports
}

function report(label: string, key: CompatibilityKey, source: AgentVersionReport['source'], found: Awaited<ReturnType<typeof probeVersion>>): AgentVersionReport {
  const missing = found.runs.failure === 'not_on_path' || found.runs.failure === 'override_not_found'
  const state: AgentVersionReport['state'] = missing ? 'not_found' : found.runs.state === 'no' ? 'did_not_run' : found.compatibility.state
  const note = found.compatibility.knownProblem?.reason ?? found.note ?? (found.runs.state !== 'yes' || found.runs.failure ? found.runs.message : undefined)
  return {
    label,
    key,
    source,
    ...(found.binary?.path ? { path: found.binary.path } : {}),
    ...(found.binary?.version ? { version: found.binary.version } : {}),
    state,
    ...(found.compatibility.testedRange ? { testedRange: found.compatibility.testedRange } : {}),
    ...(note ? { note } : {})
  }
}

/** Every published install under `<installationHome>/agents/<agent>/<version>/<platform>/`, from its receipt. */
function installedReceipts(agentsDir: string): Array<{ agentId: string; version: string; path: string; hash: string }> {
  const found: Array<{ agentId: string; version: string; path: string; hash: string }> = []
  const dirs = (path: string): string[] => {
    try {
      return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  }
  for (const agentId of dirs(agentsDir))
    for (const version of dirs(join(agentsDir, agentId)))
      for (const platform of dirs(join(agentsDir, agentId, version))) {
        const root = join(agentsDir, agentId, version, platform)
        const read = readReceipt(join(root, RECEIPT_FILE))
        if (!read || read.receipt.agentId !== agentId) continue
        found.push({ agentId, version: read.receipt.version, path: join(root, 'dist', ...read.receipt.launch.cmd.split('/')), hash: read.hash })
      }
  return found
}

/** The check as lines of text, one per agent. */
export function formatAgentVersions(reports: readonly AgentVersionReport[]): string {
  if (!reports.length) return 'No agents found.'
  return reports
    .map((entry) => {
      const where = entry.source === 'managed' ? 'installed by Mousse' : 'on PATH'
      const version = entry.version ?? 'version unknown'
      const range = entry.testedRange ? ` (tested: ${entry.testedRange})` : ''
      const note = entry.note ? ` - ${entry.note}` : ''
      return entry.state === 'not_found'
        ? `${entry.label} [${entry.key}]: not found`
        : `${entry.label} [${entry.key}] ${version}, ${where}: ${entry.state}${range}${note}${entry.path ? `\n  ${entry.path}` : ''}`
    })
    .join('\n')
}
