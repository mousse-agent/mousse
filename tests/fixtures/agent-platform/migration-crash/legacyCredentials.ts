import { createCipheriv, createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import type { ControlCredentialsPlaintext } from '../../../../src/shared/profiles/types'

/** Independent fixture for the original ControlStore AES layout at 74abef64.
 * Fixed salt/IV are fixture bytes only; this does not call the replacement codec. */
export function writeOriginalControlCredentials(home: string, value: ControlCredentialsPlaintext): Buffer {
  const directory = join(home, 'control')
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const iv = Buffer.from('102132435465768798a9bacb', 'hex')
  const key = createHash('sha256').update(`${userInfo().username}@${hostname()}:${directory}`).update(salt).digest()
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  const original = Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext])
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, 'credentials.enc'), original, { mode: 0o600 })
  return original
}
