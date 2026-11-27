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
 * and CI builds are). The keychain trusts each such build separately, so
 * every update would ask for the login password again. Those builds never use
 * the keychain and keep secrets in owner-only files instead (`plainAtRest`).
 *
 * A signed macOS build uses a keychain item of its own (`MAC_KEYCHAIN_NAME`), which
 * it creates itself and so opens without asking. It never asks for the item earlier
 * unsigned builds made, which trusts only those builds and asks for the login password
 * from every process that opens it.
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
   * protected. The vault is never asked, so data it encrypted before cannot be read: each store
   * sets such a file aside (`setAsideSecretFile`) and starts empty.
   */
  readonly plainAtRest?: boolean
  /**
   * The keychain item behind this codec is one only this build opens. A payload it cannot decrypt while
   * the keychain answers was saved through another item and can never be read here (see `savedElsewhere`).
   */
  readonly ownKeychainItem?: boolean
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
  constructor(
    private readonly safeStorage: SafeStorageLike,
    readonly ownKeychainItem = false
  ) {}

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

/** Never touches the keychain: reading from it would ask for the login password. */
class OwnerFileCodec extends PassthroughCodec {
  readonly plainAtRest = true
}

/**
 * Whether a payload `codec` just failed to decrypt was saved through a keychain item this build never
 * opens, so it can never be read here. Each store then sets it aside and starts empty; nothing is
 * deleted. Otherwise the failure may pass (a locked keychain) and the data is kept as it is.
 */
export function savedElsewhere(codec: SecretCodec): boolean {
  if (codec.plainAtRest) return true
  return !!codec.ownKeychainItem && codec.canEncrypt()
}

/**
 * The app name a signed macOS build runs under until Electron has read it. Electron names its keychain
 * item after the app ("mousse Safe Storage"), and the item earlier unsigned builds made under that name
 * trusts only them. Keychain names are case-sensitive, so "Mousse Safe Storage" is a separate item.
 */
export const MAC_KEYCHAIN_NAME = 'Mousse'

let ownMacKeychainItem = false
/**
 * Records that this process ran under `MAC_KEYCHAIN_NAME` when Electron read the app name, so its
 * keychain item is the signed build's own. Only then may an unreadable payload be set aside.
 */
export function markOwnMacKeychainItem(): void {
  ownMacKeychainItem = true
}

/**
 * Creates the signed build's keychain item in this process, if it is missing, before another process
 * (the background service) starts. Two processes that both find it missing would both try to add it,
 * and the one that loses gets no key until it restarts.
 */
export function prepareOwnMacKeychainItem(): void {
  if (ownMacKeychainItem) createSecretCodec().canEncrypt()
}

/**
 * Whether `codesign --display --verbose=2` output shows a signature the keychain recognises across
 * updates: a Developer ID or App Store signature names its team, ad hoc and unsigned builds do not.
 * Output that shows neither (codesign missing or failing) keeps the keychain.
 */
export function stableMacSignature(details: string): boolean {
  if (teamMacSignature(details)) return true
  return !(/^Signature=adhoc$/m.test(details) || /code object is not signed at all/.test(details))
}

/** Whether `codesign --display --verbose=2` output names the team that signed the app. */
export function teamMacSignature(details: string): boolean {
  return /^TeamIdentifier=(?!not set$).+$/m.test(details)
}

let signature: { details: string } | null | undefined
/** This app's `codesign` details, or null when codesign could not run (cached; runs codesign once). */
function macSignature(): { details: string } | null {
  if (signature !== undefined) return signature
  const executable = process.execPath,
    bundle = executable.lastIndexOf('.app/'),
    target = bundle === -1 ? executable : executable.slice(0, bundle + 4)
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', target], { encoding: 'utf8', timeout: 5000 })
  return (signature = result.error ? null : { details: `${result.stdout ?? ''}${result.stderr ?? ''}` })
}

/** This macOS app has a signature the keychain recognises across updates; a failed codesign keeps the keychain. */
export function signedMacApp(): boolean {
  const found = macSignature()
  return !found || stableMacSignature(found.details)
}

/**
 * codesign positively names the team that signed this macOS app. A failed codesign is not enough here:
 * an unsigned build that made the signed build's own keychain item would trust only itself.
 */
export function teamSignedMacApp(): boolean {
  const found = macSignature()
  return !!found && teamMacSignature(found.details)
}

export function createSecretCodec(): SecretCodec {
  if (!process.versions.electron) return new PassthroughCodec()
  try {
    // The daemon CLI is ESM while the GUI main bundle is CJS. Resolve Electron
    // synchronously in either host without relying on an ambient `require`.
    const requireFromHere = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)
    const electron = requireFromHere('electron') as { safeStorage?: SafeStorageLike }
    if (!electron?.safeStorage) return new PassthroughCodec(true)
    if (process.platform === 'darwin' && !signedMacApp()) return new OwnerFileCodec()
    return new SafeStorageCodec(electron.safeStorage, process.platform === 'darwin' && ownMacKeychainItem)
  } catch {
    return new PassthroughCodec(true)
  }
}
