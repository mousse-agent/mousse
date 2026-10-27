import { describe, expect, it } from 'vitest'
import { compareVersions, isOlderVersion, parseVersion } from '../../src/shared/net/version'

describe('compareVersions', () => {
  it('orders older, same and newer releases by number, not by text', () => {
    expect(compareVersions('0.1.1', '0.1.3')).toBe(-1)
    expect(compareVersions('0.1.3', '0.1.3')).toBe(0)
    expect(compareVersions('0.1.3', '0.1.1')).toBe(1)
    expect(compareVersions('0.1.9', '0.1.10')).toBe(-1)
    expect(compareVersions('0.2.0', '0.1.99')).toBe(1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
  })

  it('sorts a nightly before the release it leads to and after the previous release', () => {
    expect(compareVersions('0.1.2-nightly.20261022.17', '0.1.2')).toBe(-1)
    expect(compareVersions('0.1.2', '0.1.2-nightly.20261022.17')).toBe(1)
    expect(compareVersions('0.1.1', '0.1.2-nightly.20261022.17')).toBe(-1)
    expect(compareVersions('0.1.2-nightly.20261022.17', '0.1.3')).toBe(-1)
  })

  it('compares two nightlies by their date, then their run number, as numbers', () => {
    expect(compareVersions('0.1.2-nightly.20261021.30', '0.1.2-nightly.20261022.17')).toBe(-1)
    expect(compareVersions('0.1.2-nightly.20261022.9', '0.1.2-nightly.20261022.17')).toBe(-1)
    expect(compareVersions('0.1.2-nightly.20261022.17', '0.1.2-nightly.20261022.17')).toBe(0)
    expect(compareVersions('0.1.2-nightly.20261022.17.1', '0.1.2-nightly.20261022.17')).toBe(1)
  })

  it('compares long numeric prerelease identifiers exactly, in both directions', () => {
    expect(compareVersions('1.0.0-9007199254740992', '1.0.0-9007199254740993')).toBe(-1)
    expect(compareVersions('1.0.0-9007199254740993', '1.0.0-9007199254740992')).toBe(1)
    expect(compareVersions('1.0.0-9007199254740993', '1.0.0-9007199254740993')).toBe(0)
    expect(compareVersions('1.0.0-99999999999999999999', '1.0.0-100000000000000000000')).toBe(-1)
    expect(compareVersions('1.0.0-007', '1.0.0-7')).toBe(0)
  })

  it('follows SemVer for other prereleases and ignores build metadata', () => {
    expect(compareVersions('0.1.2-1', '0.1.2-alpha')).toBe(-1)
    expect(compareVersions('0.1.2-alpha', '0.1.2-beta')).toBe(-1)
    expect(compareVersions('0.1.2+abc', '0.1.2+def')).toBe(0)
    expect(compareVersions('v0.1.2', '0.1.2')).toBe(0)
  })

  it('says nothing when either side is not a version', () => {
    expect(compareVersions(undefined, '0.1.2')).toBeUndefined()
    expect(compareVersions('0.1', '0.1.2')).toBeUndefined()
    expect(compareVersions('next', '0.1.2')).toBeUndefined()
    expect(compareVersions('0.1.2', 3)).toBeUndefined()
    expect(isOlderVersion('next', '0.1.2')).toBe(false)
    expect(isOlderVersion('0.1.1', '0.1.2')).toBe(true)
    expect(isOlderVersion('0.1.2', '0.1.2')).toBe(false)
  })

  it('rejects oversized input', () => {
    expect(parseVersion(`0.1.2-${'a'.repeat(80)}`)).toBeUndefined()
  })
})
