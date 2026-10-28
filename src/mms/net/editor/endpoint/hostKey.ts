import type { TunnelHostKey } from '../../../../shared/net/tunnel'
import type { KeyStore } from '../../contracts'
import { ssh2 } from './library'

/**
 * The SSH host key of the endpoint: one ed25519 key, made the first time an editor connects and kept in the
 * Mousse key store (encrypted at rest with the rest of the node's secrets), never in a file in `~/.ssh` or
 * anywhere an SSH server of the system looks. The public half is what this computer vouches for over Net in
 * `tunnel.opened`; the other computer pins it in Mousse's own `known_hosts` under the alias, so the editor's
 * `ssh` checks it strictly and never asks.
 */
export const ENDPOINT_HOST_KEY_SECRET = 'editor/endpoint/host-key/ed25519'

export interface EndpointHostKey {
  /** The private key in OpenSSH format, as `ssh2` takes it. */
  privateKey: string
  publicKey: TunnelHostKey
}

type SecretStore = Pick<KeyStore, 'getSecret' | 'putSecret'>

function publicHalf(privateKey: string): TunnelHostKey | undefined {
  const parsed = ssh2().utils.parseKey(privateKey)
  if (parsed instanceof Error || parsed.type !== 'ssh-ed25519') return undefined
  return { type: parsed.type, key: parsed.getPublicSSH().toString('base64') }
}

/**
 * The host key held in `keys`, made and stored if there is none. A stored value that is not an ed25519 key
 * (damaged, or from a build that kept something else) is replaced: the other computer takes a replaced key on
 * this computer's word, over Net, as it does for the key of an SSH server.
 */
export function loadEndpointHostKey(keys: SecretStore): EndpointHostKey {
  const held = keys.getSecret(ENDPOINT_HOST_KEY_SECRET)
  if (held) {
    const privateKey = Buffer.from(held).toString('utf8')
    const publicKey = publicHalf(privateKey)
    if (publicKey) return { privateKey, publicKey }
  }
  // `ssh2` writes a key that it then cannot read back about once in three hundred times; one that does not read back
  // is never kept, so the key that is stored always loads.
  for (let attempt = 0; attempt < 16; attempt++) {
    const pair = ssh2().utils.generateKeyPairSync('ed25519')
    const publicKey = publicHalf(pair.private)
    if (!publicKey) continue
    keys.putSecret(ENDPOINT_HOST_KEY_SECRET, Buffer.from(pair.private, 'utf8'))
    return { privateKey: pair.private, publicKey }
  }
  throw new Error('The SSH host key could not be made.')
}
