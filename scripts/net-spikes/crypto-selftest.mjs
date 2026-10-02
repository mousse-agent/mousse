import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, verify, diffieHellman, createCipheriv, createDecipheriv, randomBytes, hkdfSync, scryptSync, createHash, X509Certificate } from 'node:crypto'
import { Duplex } from 'node:stream'
import tls from 'node:tls'
import { build } from 'esbuild'

// Bundle the actual TypeScript modules in memory, so Electron and Node exercise
// the same implementation as the daemon rather than another copy of the spike.
const bundle = await build({
  stdin: { contents: "export * from './src/mms/net/link/selfSignedCert'; export * from './src/mms/net/link/secureChannel'", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false
})
const { generateSelfSignedCert, fingerprint, openSecureChannel } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
let failures = 0
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}
console.log(`Node ${process.versions.node}; Electron ${process.versions.electron ?? 'none'}; ${process.platform}`)
await check('Ed25519', () => {
  const keys = generateKeyPairSync('ed25519'), bytes = Buffer.from('signed')
  const sig = sign(null, bytes, keys.privateKey)
  assert(verify(null, bytes, keys.publicKey, sig))
  assert(!verify(null, Buffer.from('altered'), keys.publicKey, sig))
})
await check('X25519', () => {
  const a = generateKeyPairSync('x25519'), b = generateKeyPairSync('x25519')
  assert.deepEqual(diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey }), diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey }))
})
await check('ECDSA P-256', () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), bytes = Buffer.from('signed')
  assert(verify('sha256', bytes, keys.publicKey, sign('sha256', bytes, keys.privateKey)))
})
await check('AES-256-GCM AAD and tamper detection', () => {
  const key = randomBytes(32), nonce = randomBytes(12), aad = Buffer.from('stream/epoch'), bytes = Buffer.from('private')
  const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad)
  const ct = Buffer.concat([cipher.update(bytes), cipher.final()]), tag = cipher.getAuthTag()
  const open = associated => {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(associated); decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
  }
  assert.deepEqual(open(aad), bytes)
  assert.throws(() => open(Buffer.from('wrong epoch')))
  ct[0] ^= 1; assert.throws(() => open(aad))
})
await check('HKDF-SHA256 RFC5869 test case 1', () => {
  const okm = hkdfSync('sha256', Buffer.alloc(22, 0x0b), Buffer.from('000102030405060708090a0b0c', 'hex'), Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'), 42)
  assert.equal(Buffer.from(okm).toString('hex'), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')
})
await check('scrypt', () => {
  assert.deepEqual(scryptSync('passphrase', 'salt', 32), scryptSync('passphrase', 'salt', 32))
  assert.notDeepEqual(scryptSync('other', 'salt', 32), scryptSync('passphrase', 'salt', 32))
})
await check('SHA-256', () => { assert.equal(createHash('sha256').update('abc').digest('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') })
const a = generateSelfSignedCert('node-a'), b = generateSelfSignedCert('node-b')
await check('in-tree DER certificate', () => {
  const cert = new X509Certificate(a.cert)
  assert(cert.verify(cert.publicKey)); assert.equal(cert.subject, 'CN=node-a')
})
function pair() {
  let x, y
  x = new Duplex({ read() {}, write(chunk, _encoding, done) { queueMicrotask(() => { y.push(chunk); done() }) } })
  y = new Duplex({ read() {}, write(chunk, _encoding, done) { queueMicrotask(() => { x.push(chunk); done() }) } })
  x.on('error', () => {}); y.on('error', () => {})
  x.once('close', () => y.destroy()); y.once('close', () => x.destroy())
  return [x, y]
}
async function open(pinMismatch = false) {
  const [x, y] = pair()
  const results = await Promise.allSettled([
    openSecureChannel(x, { role: 'client', credentials: a, expectedPeerFingerprint: pinMismatch ? 'wrong' : fingerprint(b.publicKeySpki), deadlineMs: 2_000 }),
    openSecureChannel(y, { role: 'server', credentials: b, expectedPeerFingerprint: fingerprint(a.publicKeySpki), deadlineMs: 2_000 })
  ])
  return { x, y, results }
}
await check('pinned mutual TLS 1.3 and exporter equality', async () => {
  const { x, y, results } = await open()
  try {
    for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.message)
    const [left, right] = results.map(result => result.value)
    assert.equal(left.stream.getProtocol(), 'TLSv1.3')
    assert.deepEqual(left.exporter('EXPORTER-mousse-net-enroll', 32), right.exporter('EXPORTER-mousse-net-enroll', 32))
    const echo = new Promise((resolve, reject) => { right.stream.once('data', resolve); right.stream.once('error', reject) })
    left.stream.write('echo'); assert.equal((await echo).toString(), 'echo')
  } finally { x.destroy(); y.destroy() }
})
await check('pinning gate rejects queued attacker application bytes', async () => {
  const [x, y] = pair()
  const attacker = tls.connect({ socket: x, cert: a.cert, key: a.key, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
  attacker.on('error', () => {})
  attacker.write('must never be accepted')
  let released = false
  try {
    await assert.rejects(
      openSecureChannel(y, { role: 'server', credentials: b, expectedPeerFingerprint: 'wrong', deadlineMs: 2_000 }).then(() => { released = true }),
      error => error.code === 'peer_key_mismatch'
    )
    assert.equal(released, false); assert(y.destroyed)
  } finally { attacker.destroy(); x.destroy(); y.destroy() }
})
console.log('ChaCha20-Poly1305 availability is not required.')
process.exitCode = failures ? 1 : 0
