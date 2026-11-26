#!/usr/bin/env node
// Packages macOS builds with electron-builder. Uses Developer ID signing, Hardened Runtime and
// Apple notarization whenever a Developer ID certificate (CSC_LINK, CSC_NAME, or a valid
// "Developer ID Application" identity in the login keychain) is available; otherwise falls back
// to ad-hoc signing so Apple Silicon builds and fork/contributor builds keep working.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PEM_HEADER = /-----BEGIN (?:EC )?PRIVATE KEY-----/

/** True when `security find-identity -v -p codesigning` lists a valid Developer ID Application cert. */
export function hasDeveloperIdIdentity(securityOutput) {
  if (typeof securityOutput !== 'string' || !securityOutput) return false
  return securityOutput.split(/\r?\n/).some((line) => {
    if (!/"Developer ID Application:[^"]+"/.test(line)) return false
    return !/\((?:CSSMERR_|REVOKED|EXPIRED)/i.test(line)
  })
}

const trimEnv = (env, key) => {
  const value = env[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** Resolves Apple notarization credentials from the environment, throwing on partial sets. */
export function resolveNotarizeConfig(env = process.env) {
  const apiKey = trimEnv(env, 'APPLE_API_KEY')
  const apiKeyId = trimEnv(env, 'APPLE_API_KEY_ID')
  const apiIssuer = trimEnv(env, 'APPLE_API_ISSUER')
  if (apiKey || apiKeyId || apiIssuer) {
    const missing = [
      !apiKey && 'APPLE_API_KEY',
      !apiKeyId && 'APPLE_API_KEY_ID',
      !apiIssuer && 'APPLE_API_ISSUER'
    ].filter(Boolean)
    if (missing.length > 0) {
      throw new Error(`Incomplete Apple API notarization config; missing: ${missing.join(', ')}`)
    }
    return { mode: 'api-key', apiKey, apiKeyId, apiIssuer }
  }

  const keychainProfile = trimEnv(env, 'APPLE_KEYCHAIN_PROFILE')
  if (keychainProfile) {
    const keychain = trimEnv(env, 'APPLE_KEYCHAIN')
    return { mode: 'keychain-profile', keychainProfile, ...(keychain ? { keychain } : {}) }
  }

  const appleId = trimEnv(env, 'APPLE_ID')
  const appleIdPassword = trimEnv(env, 'APPLE_APP_SPECIFIC_PASSWORD')
  const teamId = trimEnv(env, 'APPLE_TEAM_ID')
  if (appleId || appleIdPassword || teamId) {
    const missing = [
      !appleId && 'APPLE_ID',
      !appleIdPassword && 'APPLE_APP_SPECIFIC_PASSWORD',
      !teamId && 'APPLE_TEAM_ID'
    ].filter(Boolean)
    if (missing.length > 0) {
      throw new Error(`Incomplete Apple ID notarization config; missing: ${missing.join(', ')}`)
    }
    return { mode: 'apple-id', appleId, appleIdPassword, teamId }
  }

  return { mode: 'none' }
}

/** Chooses Developer ID signing + optional notarization or ad-hoc fallback and electron-builder flags. */
export function resolveMacSigningPlan(env = process.env, { hasKeychainDeveloperId = false } = {}) {
  const autoDiscoveryDisabled = trimEnv(env, 'CSC_IDENTITY_AUTO_DISCOVERY').toLowerCase() === 'false'
  const hasExplicitCert = Boolean(trimEnv(env, 'CSC_LINK') || trimEnv(env, 'CSC_NAME'))
  const useDeveloperId = hasExplicitCert || (!autoDiscoveryDisabled && hasKeychainDeveloperId)

  if (!useDeveloperId) {
    return {
      mode: 'ad-hoc',
      notarize: { mode: 'none' },
      builderArgs: [
        '-c.mac.identity=-',
        '-c.mac.hardenedRuntime=false',
        '-c.mac.notarize=false',
        '-c.dmg.sign=false'
      ],
      reason: autoDiscoveryDisabled
        ? 'CSC_IDENTITY_AUTO_DISCOVERY=false; using ad-hoc signing'
        : 'No Developer ID Application certificate found; falling back to ad-hoc signing'
    }
  }

  const notarize = resolveNotarizeConfig(env)
  const builderArgs = [
    '-c.mac.hardenedRuntime=true',
    '-c.mac.gatekeeperAssess=false',
    '-c.dmg.sign=true'
  ]
  if (notarize.mode === 'none') {
    builderArgs.push('-c.mac.notarize=false')
  }

  const source = trimEnv(env, 'CSC_LINK')
    ? 'CSC_LINK'
    : trimEnv(env, 'CSC_NAME')
      ? 'CSC_NAME'
      : 'login keychain'
  const notaryNote =
    notarize.mode === 'none'
      ? 'notarization skipped (no Apple notarization credentials set)'
      : `notarizing via ${notarize.mode}`

  return {
    mode: 'developer-id',
    notarize,
    builderArgs,
    reason: `Developer ID signing enabled (${source}); ${notaryNote}`
  }
}

/**
 * Turns APPLE_API_KEY into a readable `.p8` file path for `@electron/notarize` and `notarytool`.
 * Accepts an existing file path, raw PEM content, or base64-encoded PEM content.
 */
export function materializeApiKeyFile(value, tempDir) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) throw new Error('APPLE_API_KEY is empty')

  if (!trimmed.includes('\n') && !trimmed.includes('\r') && existsSync(trimmed)) {
    return { path: trimmed, temporary: false }
  }

  let pem = null
  if (PEM_HEADER.test(trimmed)) {
    pem = trimmed
  } else {
    const decoded = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64').toString('utf8').trim()
    if (PEM_HEADER.test(decoded)) {
      pem = decoded
    }
  }

  if (!pem) {
    throw new Error('APPLE_API_KEY must be an existing .p8 file path, PEM content, or base64-encoded PEM.')
  }

  const outPath = join(tempDir, 'AuthKey.p8')
  writeFileSync(outPath, `${pem.replace(/\r\n/g, '\n')}\n`, { mode: 0o600 })
  return { path: outPath, temporary: true }
}

/** Builds `xcrun` arguments to submit a signed DMG to Apple's notarization service and wait. */
export function notarytoolSubmitArgs(dmgPath, notarize, apiKeyPath) {
  const args = ['notarytool', 'submit', dmgPath]
  if (notarize.mode === 'api-key') {
    args.push('--key', apiKeyPath, '--key-id', notarize.apiKeyId, '--issuer', notarize.apiIssuer)
  } else if (notarize.mode === 'keychain-profile') {
    args.push('--keychain-profile', notarize.keychainProfile)
    if (notarize.keychain) args.push('--keychain', notarize.keychain)
  } else if (notarize.mode === 'apple-id') {
    args.push(
      '--apple-id',
      notarize.appleId,
      '--password',
      notarize.appleIdPassword,
      '--team-id',
      notarize.teamId
    )
  } else {
    throw new Error(`Unsupported notarization mode: ${notarize.mode}`)
  }
  args.push('--wait')
  return args
}

/** Lists `.dmg` files in `releaseDir` that were not present in `beforeNames`. */
export function findBuiltDmgs(releaseDir, beforeNames = new Set()) {
  if (!existsSync(releaseDir)) return []
  return readdirSync(releaseDir)
    .filter((name) => name.endsWith('.dmg') && !beforeNames.has(name))
    .sort()
    .map((name) => join(releaseDir, name))
}

function detectKeychainDeveloperId(env) {
  if (process.platform !== 'darwin') return false
  if (trimEnv(env, 'CSC_IDENTITY_AUTO_DISCOVERY').toLowerCase() === 'false') return false
  if (trimEnv(env, 'CSC_LINK')) return false
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) return false
  return hasDeveloperIdIdentity(result.stdout)
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

async function main(argv) {
  const env = { ...process.env }
  const hasKeychainDeveloperId = detectKeychainDeveloperId(env)
  const plan = resolveMacSigningPlan(env, { hasKeychainDeveloperId })
  console.log(`[package-mac] ${plan.reason}`)

  const releaseDir = join(project, 'release')
  const existingDmgs = new Set(
    existsSync(releaseDir) ? readdirSync(releaseDir).filter((name) => name.endsWith('.dmg')) : []
  )

  let tempKeyDir = null
  let apiKeyPath = null
  try {
    if (plan.notarize.mode === 'api-key') {
      tempKeyDir = mkdtempSync(join(tmpdir(), 'mousse-apple-key-'))
      const materialized = materializeApiKeyFile(plan.notarize.apiKey, tempKeyDir)
      apiKeyPath = materialized.path
      env.APPLE_API_KEY = apiKeyPath
    }

    const builderBin = join(
      project,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
    )
    const builderArgs = ['--mac', 'dmg', '--publish', 'never', ...plan.builderArgs, ...argv]
    runChecked(builderBin, builderArgs, { cwd: project, env })

    if (plan.mode === 'developer-id' && plan.notarize.mode !== 'none') {
      const builtDmgs = findBuiltDmgs(releaseDir, existingDmgs)
      for (const dmgPath of builtDmgs) {
        console.log(`[package-mac] notarizing ${dmgPath}`)
        runChecked('xcrun', notarytoolSubmitArgs(dmgPath, plan.notarize, apiKeyPath), {
          cwd: project,
          env
        })
        console.log(`[package-mac] stapling ${dmgPath}`)
        runChecked('xcrun', ['stapler', 'staple', dmgPath], { cwd: project, env })
      }
    }
  } finally {
    if (tempKeyDir) {
      rmSync(tempKeyDir, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2))
}
