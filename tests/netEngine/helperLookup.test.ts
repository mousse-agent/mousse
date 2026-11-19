/**
 * Which helper a checkout runs (design §1): the one `scripts/build-net-helper.mjs` built, found from the source,
 * the app's bundle and the daemon's bundle a development app starts; none outside a Mousse checkout.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findNetHelper } from '../../src/mms/netEngine/helper/process'

const BINARY = process.platform === 'win32' ? 'mousse-helper.exe' : 'mousse-helper'
const root = mkdtempSync(join(tmpdir(), 'helper-lookup-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function checkout(name: string, packageName = 'mousse'): { folder: string; binary: string } {
  const folder = join(root, name)
  const binary = join(folder, 'native', 'net-helper', 'target', 'package', BINARY)
  mkdirSync(join(binary, '..'), { recursive: true })
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: packageName }))
  writeFileSync(binary, '')
  return { folder, binary }
}

describe('the helper a checkout runs', () => {
  const { folder, binary } = checkout('mousse')
  it.each([
    ['source', ['src', 'mms', 'netEngine', 'helper']],
    ['app bundle', ['out', 'main']],
    ['app bundle chunk', ['out', 'main', 'chunks']],
    ['daemon bundle', ['out', 'cli']]
  ])('is found from the %s', (_name, tail) => {
    expect(findNetHelper({ packaged: false, env: {}, moduleFolder: join(folder, ...tail) })).toBe(
      binary
    )
  })

  it('is not found outside a Mousse checkout', () => {
    const other = checkout('other', 'something-else')
    expect(
      findNetHelper({ packaged: false, env: {}, moduleFolder: join(other.folder, 'out', 'cli') })
    ).toBeUndefined()
  })
})
