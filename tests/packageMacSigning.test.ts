import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findBuiltDmgs,
  hasDeveloperIdIdentity,
  materializeApiKeyFile,
  notarytoolSubmitArgs,
  resolveMacSigningPlan,
  resolveNotarizeConfig
} from '../scripts/package-mac.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-pkg-mac-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('hasDeveloperIdIdentity', () => {
  it.each([
    [
      'valid Developer ID Application identity',
      `  1) 5D6FE007349DC2B42CCF26D47557187DCCB6FD4A "Apple Development: Example (2GM835H55N)"
  2) 48BDEBBFA36793A14F484854F84D59F30CA40D1F "Developer ID Application: Example (259ZR3Z8MC)"
     2 valid identities found`,
      true
    ],
    [
      'only Apple Development identity',
      `  1) 5D6FE007349DC2B42CCF26D47557187DCCB6FD4A "Apple Development: Example (2GM835H55N)"
     1 valid identities found`,
      false
    ],
    [
      'Developer ID Installer without Application',
      `  1) 48BDEBBFA36793A14F484854F84D59F30CA40D1F "Developer ID Installer: Example (259ZR3Z8MC)"
     1 valid identities found`,
      false
    ],
    [
      'revoked Developer ID Application identity',
      `  1) 48BDEBBFA36793A14F484854F84D59F30CA40D1F "Developer ID Application: Example (259ZR3Z8MC)" (CSSMERR_TP_CERT_REVOKED)`,
      false
    ],
    ['empty output', '', false]
  ])('%s -> %s', (_label, output, expected) => {
    expect(hasDeveloperIdIdentity(output)).toBe(expected)
  })
})

describe('resolveMacSigningPlan', () => {
  it.each([
    {
      name: 'CI with CSC_LINK and Apple API key notarizes and enables hardened runtime',
      env: {
        CSC_LINK: 'base64-p12',
        CSC_KEY_PASSWORD: 'pw',
        APPLE_API_KEY: 'pem-key',
        APPLE_API_KEY_ID: 'KEY123',
        APPLE_API_ISSUER: 'issuer-uuid'
      },
      hasKeychainDeveloperId: false,
      mode: 'developer-id',
      notarizeMode: 'api-key',
      expectArgs: ['-c.mac.hardenedRuntime=true', '-c.mac.gatekeeperAssess=false', '-c.dmg.sign=true'],
      forbidArgs: ['-c.mac.identity=-', '-c.mac.notarize=false']
    },
    {
      name: 'local Mac with keychain cert and APPLE_KEYCHAIN_PROFILE notarizes via keychain',
      env: {
        APPLE_KEYCHAIN_PROFILE: 'mousse-notary'
      },
      hasKeychainDeveloperId: true,
      mode: 'developer-id',
      notarizeMode: 'keychain-profile',
      expectArgs: ['-c.mac.hardenedRuntime=true', '-c.dmg.sign=true'],
      forbidArgs: ['-c.mac.identity=-', '-c.mac.notarize=false']
    },
    {
      name: 'local Mac with keychain cert and no notary credentials signs without notarizing',
      env: {},
      hasKeychainDeveloperId: true,
      mode: 'developer-id',
      notarizeMode: 'none',
      expectArgs: ['-c.mac.hardenedRuntime=true', '-c.dmg.sign=true', '-c.mac.notarize=false'],
      forbidArgs: ['-c.mac.identity=-']
    },
    {
      name: 'CI without secrets or keychain cert falls back to ad-hoc signing',
      env: {
        CSC_LINK: '',
        APPLE_API_KEY: ''
      },
      hasKeychainDeveloperId: false,
      mode: 'ad-hoc',
      notarizeMode: 'none',
      expectArgs: [
        '-c.mac.identity=-',
        '-c.mac.hardenedRuntime=false',
        '-c.mac.notarize=false',
        '-c.dmg.sign=false'
      ],
      forbidArgs: ['-c.mac.hardenedRuntime=true']
    },
    {
      name: 'CSC_IDENTITY_AUTO_DISCOVERY=false forces ad-hoc even when keychain has Developer ID',
      env: {
        CSC_IDENTITY_AUTO_DISCOVERY: 'false'
      },
      hasKeychainDeveloperId: true,
      mode: 'ad-hoc',
      notarizeMode: 'none',
      expectArgs: ['-c.mac.identity=-', '-c.mac.hardenedRuntime=false', '-c.mac.notarize=false'],
      forbidArgs: ['-c.mac.hardenedRuntime=true']
    },
    {
      name: 'explicit CSC_LINK still enables Developer ID when auto-discovery is false',
      env: {
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        CSC_LINK: 'base64-p12'
      },
      hasKeychainDeveloperId: false,
      mode: 'developer-id',
      notarizeMode: 'none',
      expectArgs: ['-c.mac.hardenedRuntime=true', '-c.mac.notarize=false'],
      forbidArgs: ['-c.mac.identity=-']
    }
  ])('$name', ({ env, hasKeychainDeveloperId, mode, notarizeMode, expectArgs, forbidArgs }) => {
    const plan = resolveMacSigningPlan(env, { hasKeychainDeveloperId })
    expect(plan.mode).toBe(mode)
    expect(plan.notarize.mode).toBe(notarizeMode)
    for (const arg of expectArgs) expect(plan.builderArgs).toContain(arg)
    for (const arg of forbidArgs) expect(plan.builderArgs).not.toContain(arg)
  })

  it('rejects partial Apple API notarization variables', () => {
    expect(() =>
      resolveNotarizeConfig({
        APPLE_API_KEY: 'key',
        APPLE_API_KEY_ID: 'KEY123'
      })
    ).toThrow(/APPLE_API_ISSUER/)
  })

  it('rejects partial Apple ID notarization variables', () => {
    expect(() =>
      resolveNotarizeConfig({
        APPLE_ID: 'dev@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'secret'
      })
    ).toThrow(/APPLE_TEAM_ID/)
  })
})

describe('materializeApiKeyFile', () => {
  const samplePem = '-----BEGIN PRIVATE KEY-----\nTESTKEYDATA\n-----END PRIVATE KEY-----'

  it('reuses an existing .p8 file path directly', () => {
    const dir = makeTempDir()
    const keyPath = join(dir, 'AuthKey_TEST.p8')
    writeFileSync(keyPath, samplePem)

    const result = materializeApiKeyFile(keyPath, dir)
    expect(result).toEqual({ path: keyPath, temporary: false })
  })

  it('writes raw PEM content to a temporary .p8 file', () => {
    const dir = makeTempDir()
    const result = materializeApiKeyFile(samplePem, dir)
    expect(result.temporary).toBe(true)
    expect(existsSync(result.path)).toBe(true)
    expect(readFileSync(result.path, 'utf8')).toBe(`${samplePem}\n`)
  })

  it('decodes base64-encoded PEM content to a temporary .p8 file', () => {
    const dir = makeTempDir()
    const encoded = Buffer.from(samplePem, 'utf8').toString('base64')
    const result = materializeApiKeyFile(encoded, dir)
    expect(result.temporary).toBe(true)
    expect(readFileSync(result.path, 'utf8')).toBe(`${samplePem}\n`)
  })

  it('throws without echoing invalid secret content', () => {
    const dir = makeTempDir()
    const invalidSecret = 'not-a-valid-key-supersecret-12345'
    expect(() => materializeApiKeyFile(invalidSecret, dir)).toThrow(/APPLE_API_KEY/)
    try {
      materializeApiKeyFile(invalidSecret, dir)
    } catch (error) {
      expect(String(error)).not.toContain(invalidSecret)
    }
  })
})

describe('notarytoolSubmitArgs and findBuiltDmgs', () => {
  it('builds notarytool submit args for each auth mode', () => {
    expect(
      notarytoolSubmitArgs(
        '/tmp/Mousse.dmg',
        { mode: 'api-key', apiKey: 'raw', apiKeyId: 'KEY1', apiIssuer: 'ISS1' },
        '/tmp/AuthKey.p8'
      )
    ).toEqual([
      'notarytool',
      'submit',
      '/tmp/Mousse.dmg',
      '--key',
      '/tmp/AuthKey.p8',
      '--key-id',
      'KEY1',
      '--issuer',
      'ISS1',
      '--wait'
    ])

    expect(
      notarytoolSubmitArgs('/tmp/Mousse.dmg', {
        mode: 'keychain-profile',
        keychainProfile: 'mousse-notary'
      })
    ).toEqual([
      'notarytool',
      'submit',
      '/tmp/Mousse.dmg',
      '--keychain-profile',
      'mousse-notary',
      '--wait'
    ])

    expect(
      notarytoolSubmitArgs('/tmp/Mousse.dmg', {
        mode: 'apple-id',
        appleId: 'dev@example.com',
        appleIdPassword: 'app-pw',
        teamId: 'TEAM123'
      })
    ).toEqual([
      'notarytool',
      'submit',
      '/tmp/Mousse.dmg',
      '--apple-id',
      'dev@example.com',
      '--password',
      'app-pw',
      '--team-id',
      'TEAM123',
      '--wait'
    ])
  })

  it('returns only newly created dmg files', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'old.dmg'), '')
    writeFileSync(join(dir, 'Mousse-0.1.4-arm64.dmg'), '')
    writeFileSync(join(dir, 'Mousse-0.1.4-arm64.dmg.blockmap'), '')

    expect(findBuiltDmgs(dir, new Set(['old.dmg']))).toEqual([join(dir, 'Mousse-0.1.4-arm64.dmg')])
  })
})

describe('mac packaging config', () => {
  it('points electron-builder at the macOS hardened-runtime entitlements plist without forcing ad-hoc identity', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const mac = pkg.build.mac
    expect(mac.identity).toBeUndefined()
    expect(mac.hardenedRuntime).toBe(true)
    expect(mac.entitlements).toBe('build/entitlements.mac.plist')
    expect(mac.entitlementsInherit).toBe('build/entitlements.mac.plist')
    expect(mac.extendInfo.NSMicrophoneUsageDescription).toBeTruthy()
    expect(mac.extendInfo.NSCameraUsageDescription).toBeTruthy()

    const plist = readFileSync(join(ROOT, mac.entitlements), 'utf8')
    expect(plist).toContain('<key>com.apple.security.cs.allow-jit</key>')
    expect(plist).toContain('<key>com.apple.security.cs.allow-unsigned-executable-memory</key>')
    expect(plist).toContain('<key>com.apple.security.cs.disable-library-validation</key>')
    expect(plist).toContain('<key>com.apple.security.device.audio-input</key>')
    expect(plist).toContain('<key>com.apple.security.device.camera</key>')
  })
})
