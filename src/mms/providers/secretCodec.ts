import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

/**
 * Optional at-rest encryption for secret files (credentials).
 *
 * Under Electron (main process, app ready) uses `safeStorage`, which is backed
 * by the OS credential vault (DPAPI on Windows, Keychain on macOS, libsecret on
 * Linux). Outside Electron — e.g. the standalone node daemon — no OS vault is
 * available and fresh stores may use plaintext. Electron always requires
 * encryption; vault failures must never silently downgrade a store.
 *
 * The exception is a macOS build without a stable signature (ad hoc, as local
 * and CI builds are today). The keychain trusts each such build separately, so
 * every update would ask for the login password again. Those builds keep
 * secrets in owner-only files instead (`plainAtRest`).
 *
 * No static electron import: resolved lazily via process detection so src/mms
 * stays loadable in plain node and tests.
 */

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface SecretCodec {
  /** Electron must never save plaintext when its OS vault is unavailable. */
  readonly encryptionRequired?: boolean
  /**
   * Secrets are deliberately saved as owner-only files without the OS vault, and count as
   * protected. Data a vault encrypted before is still read, and saved plain from then on.
   */
  readonly plainAtRest?: boolean
  /** True when payloads written now will be encrypted. */
  canEncrypt(): boolean
  encrypt(plain: string): Buffer | null
  decrypt(stored: Buffer): string | null
}

class PassthroughCodec implements SecretCodec {
  constructor(readonly encryptionRequired = false) {}
  canEncrypt(): boolean {
    return false
  }
  encrypt(): Buffer | null {
    return null
  }
  decrypt(): string | null {
    return null
  }
}

class SafeStorageCodec implements SecretCodec {
  readonly encryptionRequired = true
  constructor(private readonly safeStorage: SafeStorageLike) {}

  canEncrypt(): boolean {
    try {
      return this.safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  encrypt(plain: string): Buffer | null {
    try {
      if (!this.safeStorage.isEncryptionAvailable()) return null
      return this.safeStorage.encryptString(plain)
    } catch {
      return null
    }
  }

  decrypt(stored: Buffer): string | null {
    try {
      return this.safeStorage.decryptString(stored)
    } catch {
      return null
    }
  }
}

/** Reads data a keychain-backed build encrypted; never writes to the keychain. */
class OwnerFileCodec implements SecretCodec {
  readonly plainAtRest = true
  constructor(private readonly safeStorage: SafeStorageLike) {}

  canEncrypt(): boolean {
    return false
  }

  encrypt(): Buffer | null {
    return null
  }

  decrypt(stored: Buffer): string | null {
    try {
      return this.safeStorage.decryptString(stored)
    } catch {
      return null
    }
  }
}

/**
 * Whether `codesign --display --verbose=2` output shows a signature the keychain recognises across
 * updates: a Developer ID or App Store signature names its team, ad hoc and unsigned builds do not.
 * Output that shows neither (codesign missing or failing) keeps the keychain.
 */
export function stableMacSignature(details: string): boolean {
  if (/^TeamIdentifier=(?!not set$).+$/m.test(details)) return true
  return !(/^Signature=adhoc$/m.test(details) || /code object is not signed at all/.test(details))
}

let signedApp: boolean | undefined
function signedMacApp(): boolean {
  if (signedApp !== undefined) return signedApp
  const executable = process.execPath,
    bundle = executable.lastIndexOf('.app/'),
    target = bundle === -1 ? executable : executable.slice(0, bundle + 4)
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', target], { encoding: 'utf8', timeout: 5000 })
  return (signedApp = result.error ? true : stableMacSignature(`${result.stdout ?? ''}${result.stderr ?? ''}`))
}

export function createSecretCodec(): SecretCodec {
  if (!process.versions.electron) return new PassthroughCodec()
  try {
    // The daemon CLI is ESM while the GUI main bundle is CJS. Resolve Electron
    // synchronously in either host without relying on an ambient `require`.
    const requireFromHere = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)
    const electron = requireFromHere('electron') as { safeStorage?: SafeStorageLike }
    if (!electron?.safeStorage) return new PassthroughCodec(true)
    if (process.platform === 'darwin' && !signedMacApp()) return new OwnerFileCodec(electron.safeStorage)
    return new SafeStorageCodec(electron.safeStorage)
  } catch {
    return new PassthroughCodec(true)
  }
}
