/**
 * Optional at-rest encryption for secret files (credentials).
 *
 * Under Electron (main process, app ready) uses `safeStorage`, which is backed
 * by the OS credential vault (DPAPI on Windows, Keychain on macOS, libsecret on
 * Linux). Outside Electron — e.g. the standalone node daemon — no OS vault is
 * available and the codec degrades to plaintext passthrough.
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
  /** True when payloads written now will be encrypted. */
  canEncrypt(): boolean
  encrypt(plain: string): Buffer | null
  decrypt(stored: Buffer): string | null
}

class PassthroughCodec implements SecretCodec {
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

export function createSecretCodec(): SecretCodec {
  if (!process.versions.electron) return new PassthroughCodec()
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { safeStorage?: SafeStorageLike }
    if (!electron?.safeStorage) return new PassthroughCodec()
    return new SafeStorageCodec(electron.safeStorage)
  } catch {
    return new PassthroughCodec()
  }
}
