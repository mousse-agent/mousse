/**
 * The setup matrix (plan PR 5 §6): `docs/providers/setup-matrix.json` is the data, the Markdown is
 * generated from it, every driver and ACP preset has rows, each setup lists every OS once, a
 * source the driver cannot have is refused, and every cell says why it is or is not tested.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OS_LABELS, renderSetupMatrix, SETUP_MATRIX_MD, SIGN_IN_LABELS, SOURCE_LABELS, readSetupMatrix } from '../../scripts/gen-setup-matrix.mjs'
import { GENERIC_ACP_PRESET } from '../../src/mms/harness/acp/presets/generic'
import { GROK_PRESET } from '../../src/mms/harness/acp/presets/grok'
import { COMPATIBILITY, type CompatibilityKey } from '../../src/mms/harness/compatibility'
import type { HarnessDriver } from '../../src/mms/harness/driver'
import { acpDriver } from '../../src/mms/harness/drivers/acp'
import { antigravityDriver } from '../../src/mms/harness/drivers/antigravity'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { cursorDriver } from '../../src/mms/harness/drivers/cursor'
import { grokDriver } from '../../src/mms/harness/drivers/grok'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { PROVIDER_DRIVER_KINDS } from '../../src/shared/providerInstances'

interface Row { source: string; signIn: string; os: string[]; status: 'tested' | 'untested' | 'unsupported'; reason?: string; evidence?: string[] }
interface Agent { id: string; label: string; driver: string; presets?: string[]; rows: Row[] }

const ROOT = join(__dirname, '..', '..')
const matrix = readSetupMatrix() as { agents: Agent[] }
const unused = () => { throw new Error('unused') }
const DRIVERS: Record<string, HarnessDriver> = Object.fromEntries([
  claudeCodeDriver({ builtIn: unused }),
  codexDriver({ builtIn: unused }),
  antigravityDriver({ builtIn: unused }),
  grokDriver(),
  cursorDriver(),
  piDriver(),
  acpDriver()
].map((driver) => [driver.kind, driver]))

/** The sources a driver can have, from what it declares. */
function sourcesOf(driver: HarnessDriver): Set<string> {
  const sources = new Set<string>(['custom'])
  if (driver.binaryNames.length) sources.add('path')
  if (driver.canInstall) sources.add('managed')
  if (COMPATIBILITY[driver.kind as CompatibilityKey]?.bundled) {
    sources.add('bundled')
    sources.delete('custom')
  }
  return sources
}

describe('the setup matrix', () => {
  it('setup-matrix.md is generated from the JSON (node scripts/gen-setup-matrix.mjs)', () => {
    expect(readFileSync(SETUP_MATRIX_MD, 'utf8').replace(/\r\n/g, '\n')).toBe(renderSetupMatrix(matrix))
  })

  it('has rows for every driver and every ACP preset', () => {
    for (const kind of PROVIDER_DRIVER_KINDS) expect(matrix.agents.some((agent) => agent.driver === kind && agent.rows.length > 0), kind).toBe(true)
    for (const preset of [GENERIC_ACP_PRESET, GROK_PRESET]) expect(matrix.agents.some((agent) => agent.presets?.includes(preset.id)), preset.id).toBe(true)
    expect(Object.keys(DRIVERS).sort()).toEqual([...PROVIDER_DRIVER_KINDS].sort())
  })

  it('uses only known axes, and only the sources each driver can have', () => {
    for (const agent of matrix.agents) {
      const allowed = sourcesOf(DRIVERS[agent.driver]!)
      for (const row of agent.rows) {
        expect(SOURCE_LABELS, `${agent.id}: ${row.source}`).toHaveProperty(row.source)
        expect(SIGN_IN_LABELS, `${agent.id}: ${row.signIn}`).toHaveProperty(row.signIn)
        for (const os of row.os) expect(OS_LABELS, `${agent.id}: ${os}`).toHaveProperty(os)
        expect(allowed.has(row.source), `${agent.id} cannot run from ${row.source}`).toBe(true)
      }
    }
  })

  it('lists every OS exactly once for each setup it names', () => {
    for (const agent of matrix.agents) {
      const setups = new Map<string, string[]>()
      for (const row of agent.rows) {
        const key = `${row.source}/${row.signIn}`
        setups.set(key, [...(setups.get(key) ?? []), ...row.os])
      }
      for (const [key, oses] of setups) expect(oses.slice().sort(), `${agent.id} ${key}`).toEqual(Object.keys(OS_LABELS).sort())
    }
  })

  it('names evidence for every tested cell and a reason for every other one', () => {
    for (const agent of matrix.agents) {
      for (const row of agent.rows) {
        const where = `${agent.id} ${row.source}/${row.signIn} ${row.os.join(',')}`
        if (row.status === 'tested') {
          expect(row.evidence?.length, where).toBeGreaterThan(0)
          // A pull request whose description records the run, or a smoke record in the repository.
          for (const ref of row.evidence!) expect(/^#\d+$/.test(ref) || existsSync(join(ROOT, ref)), `${where}: ${ref}`).toBe(true)
        } else {
          expect(['untested', 'unsupported'], where).toContain(row.status)
          expect(row.reason?.trim(), where).toBeTruthy()
        }
      }
    }
  })
})
