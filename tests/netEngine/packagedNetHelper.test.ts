/**
 * The six desktop builds carry the release network helper of the engine commit the app pins
 * (`phase1b.desktop-builds`): each target maps to its Rust triple, and the packaged helper's `--version` must name the
 * build under test. The check's must-fail control, `stale-helper`, sets MOUSSE_BUILD_ID=0000000+release and must
 * fail it. The helper's `--version` is scripted here; the packaging jobs run the real one.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error a script module without types
import * as build from '../../scripts/net-helper-build.mjs'
// @ts-expect-error a script module without types
import * as check from '../../scripts/check-packaged-net-helper.mjs'

const PINNED = readFileSync(resolve(__dirname, '..', '..', 'native', 'net-helper', 'ENGINE_COMMIT'), 'utf8').trim()
const root = mkdtempSync(join(tmpdir(), 'packaged-helper-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('the six targets', () => {
  it.each([
    ['win32', 'x64', 'x86_64-pc-windows-msvc', 'mousse-helper.exe'],
    ['win32', 'arm64', 'aarch64-pc-windows-msvc', 'mousse-helper.exe'],
    ['darwin', 'arm64', 'aarch64-apple-darwin', 'mousse-helper'],
    ['darwin', 'x64', 'x86_64-apple-darwin', 'mousse-helper'],
    ['linux', 'x64', 'x86_64-unknown-linux-gnu', 'mousse-helper'],
    ['linux', 'arm64', 'aarch64-unknown-linux-gnu', 'mousse-helper']
  ])('%s %s builds %s', (platform, arch, triple, file) => {
    expect(build.HELPER_TARGETS[build.targetName(platform, arch)]).toBe(triple)
    expect(build.helperFileName(triple)).toBe(file)
  })

  it('refuses a target outside the six', () => {
    expect(() => build.targetName('linux', 'ia32')).toThrow(/no network helper target/)
  })
})

/** An unpacked Windows app whose helper says `version` (or fails to run). */
function app(name: string, helper = true) {
  const dir = join(root, name, 'win-unpacked')
  mkdirSync(join(dir, 'resources', 'net-helper'), { recursive: true })
  writeFileSync(join(dir, 'Mousse.exe'), '')
  if (helper) writeFileSync(join(dir, 'resources', 'net-helper', 'mousse-helper.exe'), '')
  writeFileSync(join(dir, 'resources', 'net-helper', 'TARGET'), 'x86_64-pc-windows-msvc\n')
  return dir
}
const says = (stdout: string) => () => ({ status: 0, stdout, stderr: '' })

describe('the packaged helper against the build under test', () => {
  const release = `mousse-helper 0.1.0 build ${PINNED}+release control none`
  // Inputs: what the kit expects (nothing, the pinned build, the stale-helper control's id) against what the
  // packaged helper says (the pinned build, abbreviated, dirty, debug, a must-fail control, nothing, no helper).
  const rows: Array<[string, Record<string, string>, string | undefined, () => unknown, string | undefined]> = [
    ['the pinned build, nothing expected', {}, undefined, says(release), undefined],
    ['the pinned build, the kit expects it', { MOUSSE_BUILD_ID: `${PINNED.slice(0, 9)}+release` }, undefined, says(release), undefined],
    ['the stale-helper control', { MOUSSE_BUILD_ID: '0000000+release' }, undefined, says(release), 'stale_helper'],
    ['--expect wins over the environment', { MOUSSE_BUILD_ID: '0000000+release' }, PINNED, says(release), undefined],
    ['an abbreviated build', {}, undefined, says(`mousse-helper 0.1.0 build ${PINNED.slice(0, 7)}+release control none`), undefined],
    ['a build with changes', {}, undefined, says(`mousse-helper 0.1.0 build ${PINNED}-dirty+release control none`), 'stale_helper'],
    ['a debug build', {}, undefined, says(`mousse-helper 0.1.0 build ${PINNED}+debug control none`), 'stale_helper'],
    ['a must-fail control compiled in', {}, undefined, says(`mousse-helper 0.1.0 build ${PINNED}+release control drop-x`), 'stale_helper'],
    ['no build in --version', {}, undefined, says('mousse-helper 0.1.0'), 'stale_helper'],
    ['a helper that does not run', {}, undefined, () => ({ status: null, error: new Error('EBADARCH'), stdout: '' }), 'helper_does_not_run']
  ]
  it.each(rows.map((row, index) => [row[0], index] as const))('%s', (_name, index) => {
    const [, env, expect_, run, reason] = rows[index]!
    const expected = check.expectedBuild({ expect: expect_, env })
    const dir = app(`case-${index}`)
    if (reason) {
      expect(() => check.checkHelper(dir, expected, run)).toThrow(expect.objectContaining({ reason }))
    } else {
      const found = check.checkHelper(dir, expected, run)
      expect(found.helper).toBe(join(dir, 'resources', 'net-helper', 'mousse-helper.exe'))
      expect(found.target).toBe('x86_64-pc-windows-msvc')
    }
  })

  it('fails a package without the helper', () => {
    expect(() => check.checkHelper(app('none', false), `${PINNED}+release`, says(release))).toThrow(
      expect.objectContaining({ reason: 'missing_helper' })
    )
  })

  it('finds the unpacked app of each target under release/', () => {
    for (const [folder, inner] of [
      ['win-arm64-unpacked', ''],
      ['linux-unpacked', ''],
      ['mac-arm64', 'Mousse.app']
    ] as const) {
      const release = join(root, `release-${folder}`)
      mkdirSync(join(release, folder, inner), { recursive: true })
      expect(build.findUnpackedApp(release)).toBe(join(release, folder, inner))
    }
    expect(build.packagedLayout('/x/Mousse.app').helper).toBe(
      join('/x/Mousse.app', 'Contents', 'Resources', 'net-helper', 'mousse-helper')
    )
  })
})
