import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, realpathSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { nativeSdkVersion } from '../../../../src/mms/bots/runtime/GuardedProvider'
import { loadNativeReader, NativeReader, nativeReaderQualified } from '../../../../src/mms/bots/runtime/NativeReader'
import { createSecretCodec } from '../../../../src/mms/providers/secretCodec'
import { FileKeyStore } from '../../../../src/mms/net/identity/FileKeyStore'

async function main() {
  const output: Record<string, unknown> = { platform: process.platform, arch: process.arch, node: process.versions.node, electron: process.versions.electron, billingQualified: false, productionReaderQualified: false }
  const directory = process.env.MOUSSE_PACKAGING_QA_DIRECTORY!, artifact = process.env.MOUSSE_PACKAGING_QA_READER!
  if (!directory || !artifact) throw new Error('Explicit isolated QA paths are required')
  const here = typeof __filename === 'string' ? __filename : import.meta.url
  let app: { whenReady(): Promise<void>; setPath(name: string, path: string): void; exit(code: number): void; dock?: { hide(): void } } | undefined
  if (process.versions.electron) {
    const electron = createRequire(here)('electron')
    output.vaultBackend = 'before_ready'; app = electron.app; app!.setPath('userData', directory); electron.app.disableHardwareAcceleration()
    await app!.whenReady(); output.vaultBackend = electron.safeStorage.getSelectedStorageBackend(); output.asarEntry = import.meta.url; output.napi = process.versions.napi; output.moduleAbi = process.versions.modules; app!.dock?.hide()
  }
  try { output.sdkVersion = nativeSdkVersion() } catch { output.sdkError = 'SDK resolution failed' }
  const root = join(directory, 'project'), denied = join(directory, 'denied'); mkdirSync(root, { recursive: true }); mkdirSync(denied, { recursive: true })
  writeFileSync(join(root, 'fixture.txt'), 'bounded native packaging fixture'); writeFileSync(join(denied, 'private.txt'), 'denied fixture'); symlinkSync(denied, join(root, 'escape'))
  try {
    const qualification = { platform: process.platform as 'darwin' | 'linux', napi: 8, packaged: false, artifactSha256: createHash('sha256').update(readFileSync(artifact)).digest('hex') }
    const module = loadNativeReader(realpathSync(artifact), qualification), reader = new NativeReader(module, root, [denied])
    let symlinkDenied = false, deniedRoot = false
    try { output.read = reader.read('fixture.txt') === 'bounded native packaging fixture'; try { reader.read('escape/private.txt') } catch (error) { symlinkDenied = (error as { code?: string }).code === 'forbidden' } }
    finally { reader.close() }
    try { new NativeReader(module, denied, [denied]) } catch (error) { deniedRoot = (error as { code?: string }).code === 'forbidden' }
    output.symlinkDenied = symlinkDenied; output.deniedRoot = deniedRoot; output.productionReaderQualified = nativeReaderQualified(module, qualification)
  } catch { output.readerError = 'Native reader fixture failed' }
  try {
    const profile = join(directory, 'vault-profile'); mkdirSync(profile)
    const codec = createSecretCodec(), keys = new FileKeyStore(profile, { codec })
    output.vaultRequired = codec.encryptionRequired ?? false; output.vaultAvailable = codec.canEncrypt()
    if (process.versions.electron && codec.canEncrypt()) {
      await keys.initialize({ asAuthority: false }); const stored = readFileSync(join(profile, 'net', 'keys.json'), 'utf8'), reopened = new FileKeyStore(profile, { codec })
      output.vaultRoundtrip = output.vaultBackend === 'gnome_libsecret' && keys.encryptedAtRest() && JSON.parse(stored).mode === 'vault' && reopened.state() === 'unlocked' && !stored.includes('PRIVATE KEY') && reopened.nodeKeys().sign === keys.nodeKeys().sign
    }
  } catch { output.vaultError = 'Vault fixture failed' }
  process.stdout.write(JSON.stringify(output) + '\n'); app?.exit(0)
}
void main().catch(() => { process.stderr.write('Packaging probe failed before reporting public evidence.\n'); process.exitCode = 1 })
