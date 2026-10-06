import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostname, userInfo } from 'node:os'
import type { ControlCredentialsPlaintext } from '../../../shared/profiles/types'

/** Migration compatibility only. This codec never creates device identities,
 * enrolls a node, interprets grants, connects a transport or supplies Net keys.
 * The original directory string is part of the legacy encryption key. */
export class LegacyControlCredentials {
  private readonly directory: string
  private readonly path: string

  constructor(homeDir: string) {
    this.directory = join(homeDir, 'control')
    this.path = join(this.directory, 'credentials.enc')
  }

  private storageKey(salt: Buffer): Buffer {
    let machineInfo = 'mousse-plus-storage'
    try {
      machineInfo = `${userInfo().username}@${hostname()}:${this.directory}`
    } catch { /* Preserve the original machine-information fallback. */ }
    return createHash('sha256').update(machineInfo).update(salt).digest()
  }

  getCredentials(): ControlCredentialsPlaintext | null {
    if (!existsSync(this.path)) return null
    try {
      const bytes = readFileSync(this.path)
      if (bytes.length < 44) return null
      const decipher = createDecipheriv('aes-256-gcm', this.storageKey(bytes.subarray(0, 16)), bytes.subarray(16, 28))
      decipher.setAuthTag(bytes.subarray(28, 44))
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(44)), decipher.final()]).toString('utf8')) as ControlCredentialsPlaintext
    } catch { return null }
  }

  saveCredentials(credentials: ControlCredentialsPlaintext): void {
    const salt = randomBytes(16), iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.storageKey(salt), iv)
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(credentials), 'utf8')), cipher.final()])
    const bytes = Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext])
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
    writeFileSync(temporary, bytes, { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
