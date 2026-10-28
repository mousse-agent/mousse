/**
 * The compatibility table (plan PR 5 §5): one row per driver and ACP preset, each tested range
 * resting on evidence inside it, fixtures inside their agent's range, and no driver declaring a
 * range of its own.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDER_DRIVER_KINDS } from '../../src/shared/providerInstances'
import { GENERIC_ACP_PRESET } from '../../src/mms/harness/acp/presets/generic'
import { GROK_PRESET, GROK_TESTED_VERSION } from '../../src/mms/harness/acp/presets/grok'
import { COMPATIBILITY, CONTAINMENT_EVIDENCE, compatibilityFields, knownProblemOf, parseVersionRange, type CompatibilityKey } from '../../src/mms/harness/compatibility'
import { compareVersions } from '../../src/mms/harness/driver'
import { acpDriver } from '../../src/mms/harness/drivers/acp'
import { ANTIGRAVITY_VERSION, antigravityDriver } from '../../src/mms/harness/drivers/antigravity'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { grokDriver } from '../../src/mms/harness/drivers/grok'
import { readTranscript } from '../../src/mms/run/testkit/ReplayTransport'

const ROOT = join(__dirname, '..', '..')
const FIXTURES = join(ROOT, 'tests', 'run', 'fixtures')
const PRESETS = [GENERIC_ACP_PRESET, GROK_PRESET]
/** The table row a replay adapter's fixtures are evidence for. */
const ADAPTER_ROWS: Record<string, CompatibilityKey> = {
  'claude-subscription': 'claude',
  codex: 'codex',
  antigravity: 'antigravity',
  cursor: 'cursor',
  'pi-rpc': 'pi',
  acp: 'acp:generic'
}

const inside = (version: string, range: { min: string; max: string }) => compareVersions(version, range.min) >= 0 && compareVersions(version, range.max) <= 0
const rows = Object.entries(COMPATIBILITY) as Array<[CompatibilityKey, (typeof COMPATIBILITY)[CompatibilityKey]]>

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]))
}

describe('the compatibility table', () => {
  it('has a row for every driver and every ACP preset', () => {
    for (const kind of PROVIDER_DRIVER_KINDS.filter((kind) => kind !== 'acp')) expect(COMPATIBILITY, kind).toHaveProperty(kind)
    for (const preset of PRESETS) expect(COMPATIBILITY, preset.id).toHaveProperty(`acp:${preset.id}`)
  })

  it('rests every tested range on evidence inside it, and every fixture it cites exists', () => {
    for (const [key, row] of rows) {
      for (const entry of row.evidence) {
        if (entry.kind === 'fixture') expect(existsSync(join(ROOT, entry.ref)), `${key}: ${entry.ref}`).toBe(true)
        else expect(entry.ref, key).toMatch(/^#\d+$/)
      }
      if (!row.tested) continue
      expect(compareVersions(row.tested.min, row.tested.max), key).toBeLessThanOrEqual(0)
      expect(row.evidence.some((entry) => inside(entry.version, row.tested!)), `${key} has no evidence inside its tested range`).toBe(true)
    }
  })

  it('every replay fixture records the version it rests on, inside its agent range', () => {
    for (const path of files(FIXTURES).filter((file) => file.endsWith('.ndjson'))) {
      const { header } = readTranscript(path)
      const key = ADAPTER_ROWS[header.adapter]
      const name = relative(ROOT, path)
      expect(key, `${name}: no table row for adapter ${header.adapter}`).toBeDefined()
      const tested = COMPATIBILITY[key!].tested
      const version = header.agentVersion ?? header.basis
      if (!tested) continue
      expect(version, `${name} records no agentVersion or basis`).toBeDefined()
      expect(inside(version!, tested), `${name}: ${version} is outside ${tested.min} – ${tested.max}`).toBe(true)
    }
  })

  it('parses every known-broken range', () => {
    for (const [key, row] of rows) for (const broken of row.knownBroken ?? []) expect(parseVersionRange(broken.range), `${key}: ${broken.range}`).toBeDefined()
    expect(parseVersionRange('2.1.5')).toEqual({ min: '2.1.5', max: '2.1.5' })
    expect(parseVersionRange('2.1.5 - 2.1.9')).toEqual({ min: '2.1.5', max: '2.1.9' })
    expect(parseVersionRange('2.1.9 - 2.1.5')).toBeUndefined()
    expect(parseVersionRange('>=2.1.5')).toBeUndefined()
    expect(parseVersionRange('2.1.5 - 2.1.7 - 2.1.9')).toBeUndefined()
    const broken = [{ range: '2.1.5 - 2.1.9', reason: 'r' }]
    expect(knownProblemOf(broken, '2.1.5')?.reason).toBe('r')
    expect(knownProblemOf(broken, '2.1.9')?.reason).toBe('r')
    expect(knownProblemOf(broken, '2.1.10')).toBeUndefined()
    expect(knownProblemOf(broken, undefined)).toBeUndefined()
  })

  it('a bundled runtime is the version the table records', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    for (const [key, row] of rows) {
      if (!row.bundled) continue
      const version = manifest.dependencies[row.bundled.package]?.replace(/^[\^~]/, '')
      expect(version, `${key}: ${row.bundled.package} is not a dependency`).toBeDefined()
      expect(inside(version!, row.tested!), `${key}: ${row.bundled.package}@${version} is outside its tested range`).toBe(true)
    }
  })

  it('the versions Mousse installs and its containment evidence are inside the tested ranges', () => {
    expect(inside(GROK_TESTED_VERSION, COMPATIBILITY.grok.tested!)).toBe(true)
    expect(inside(ANTIGRAVITY_VERSION, COMPATIBILITY.antigravity.tested!)).toBe(true)
    for (const record of CONTAINMENT_EVIDENCE) {
      const tested = COMPATIBILITY[record.driver as CompatibilityKey].tested
      expect(tested && inside(record.cliVersion, tested), `${record.driver} ${record.cliVersion} (${record.platform})`).toBe(true)
    }
  })

  it('drivers and presets read their range from the table', () => {
    expect(claudeCodeDriver().testedVersions).toEqual(COMPATIBILITY.claude.tested)
    expect(codexDriver({ builtIn: () => ({}) as never }).testedVersions).toEqual(COMPATIBILITY.codex.tested)
    expect(antigravityDriver({ builtIn: () => ({}) as never }).testedVersions).toEqual(COMPATIBILITY.antigravity.tested)
    expect(grokDriver().testedVersions).toEqual(COMPATIBILITY.grok.tested)
    expect(GROK_PRESET.testedVersions).toEqual(COMPATIBILITY['acp:grok'].tested)
    expect(acpDriver().testedVersions).toBeUndefined()
    // A bundled runtime's row is a record: the probe does not judge its version.
    expect(compatibilityFields('pi')).toEqual({})
    expect(compatibilityFields('cursor')).toEqual({})
  })

  it('no driver or preset file declares a range of its own', () => {
    const sources = [...files(join(ROOT, 'src', 'mms', 'harness', 'drivers')), ...files(join(ROOT, 'src', 'mms', 'harness', 'acp', 'presets'))].filter((file) => file.endsWith('.ts'))
    for (const file of sources) {
      const text = readFileSync(file, 'utf8')
      expect(text, relative(ROOT, file)).not.toMatch(/testedVersions\s*:\s*\{/)
      expect(text, relative(ROOT, file)).not.toMatch(/knownBroken\s*:\s*\[/)
      expect(text, relative(ROOT, file)).not.toMatch(/TESTED_VERSIONS\s*=/)
    }
  })
})
