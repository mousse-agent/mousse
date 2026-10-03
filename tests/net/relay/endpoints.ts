import WebSocket from 'ws'
import { generateSigningKey, signBytes } from '../../../src/mms/net/identity/crypto'
import { relayProofBytes, type RelayAuth } from '../../../src/mms/net/relay/protocol'
import { newId } from '../../../src/shared/net/ids'

export function identity() {
  const key = generateSigningKey()
  return {
    node: newId('node'),
    signKey: key.publicKey,
    sign: (bytes: Uint8Array) => signBytes(bytes, key.privateKey)
  }
}

export function endpoint(address: string) {
  const ws = new WebSocket(address)
  const queued: Buffer[] = []
  const waiting: Array<(bytes: Buffer) => void> = []
  ws.on('error', () => {})
  ws.on('message', (bytes) => {
    const data = Buffer.from(bytes as Buffer)
    const receive = waiting.shift()
    if (receive) receive(data)
    else queued.push(data)
  })
  const next = (): Promise<Buffer> => {
    const bytes = queued.shift()
    return bytes ? Promise.resolve(bytes) : new Promise((resolve) => waiting.push(resolve))
  }
  const authenticate = async (
    who: ReturnType<typeof identity>,
    role: 'listen' | 'dial',
    target = who.node
  ) => {
    const challenge = JSON.parse((await next()).toString())
    const auth: Omit<RelayAuth, 'sig'> = {
      t: 'auth',
      v: 1,
      nonce: challenge.nonce,
      node: who.node,
      signKey: who.signKey,
      role,
      target
    }
    const encoded = JSON.stringify({
      ...auth,
      sig: Buffer.from(who.sign(relayProofBytes(auth))).toString('base64url')
    })
    ws.send(encoded)
    return { bytes: Buffer.byteLength(encoded), reply: JSON.parse((await next()).toString()) }
  }
  return { ws, next, authenticate }
}
