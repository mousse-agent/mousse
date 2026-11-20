import { existsSync } from 'node:fs'
import { compareVersions } from '../../../driver'

/**
 * Google's Antigravity CLI (`agy`), which serves ACP itself as `agy acp`. Mousse installs only the
 * release reviewed here: each asset's URL, size and SHA-512 were checked against an independent
 * download, not taken from Google's update feed. The feed is read only to learn that a release was
 * withdrawn or that a newer one exists; it never names what Mousse installs.
 */

/** The `agentInfo.name` the CLI answers `initialize` with. */
export const NATIVE_AGENT_NAME = 'Antigravity ACP Server'

export const NATIVE_FEED_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests'
const ASSET_ORIGIN = 'https://storage.googleapis.com'
const ASSET_PREFIX = '/antigravity-public/antigravity-cli/'

export type NativeTarget =
  | 'windows_amd64' | 'windows_arm64' | 'darwin_amd64' | 'darwin_arm64'
  | 'linux_amd64' | 'linux_arm64' | 'linux_amd64_musl' | 'linux_arm64_musl'

export interface NativeRelease {
  version: string
  url: string
  sha512: string
  /** Bytes of the download. */
  size: number
  /** Windows ships the executable itself; macOS and Linux a gzip tar holding one `antigravity` file. */
  format: 'exe' | 'tar.gz'
  /** Bytes of the executable (the download itself for `exe`). */
  executableSize: number
}

/** Folder and file name of each target in Google's bucket. */
const ASSET_FILES: Record<NativeTarget, { folder: string; file: string }> = {
  windows_amd64: { folder: 'windows-x64', file: 'cli_windows_x64.exe' },
  windows_arm64: { folder: 'windows-arm', file: 'cli_windows_arm64.exe' },
  darwin_amd64: { folder: 'darwin-x64', file: 'cli_mac_x64.tar.gz' },
  darwin_arm64: { folder: 'darwin-arm', file: 'cli_mac_arm64.tar.gz' },
  linux_amd64: { folder: 'linux-x64', file: 'cli_linux_x64.tar.gz' },
  linux_arm64: { folder: 'linux-arm', file: 'cli_linux_arm64.tar.gz' },
  linux_amd64_musl: { folder: 'linux-x64-musl', file: 'cli_linux_x64_musl.tar.gz' },
  linux_arm64_musl: { folder: 'linux-arm-musl', file: 'cli_linux_arm64_musl.tar.gz' }
}

const BUILD = '1.5.12-5281398513336320'
const asset = (target: NativeTarget) => `${ASSET_ORIGIN}${ASSET_PREFIX}${BUILD}/${ASSET_FILES[target].folder}/${ASSET_FILES[target].file}`

/** The reviewed release: 1.5.12, published 18 November 2026, hashed from a separate download on 19 November 2026. */
export const NATIVE_VERSION = '1.5.12'
export const NATIVE_RELEASES: Readonly<Record<NativeTarget, NativeRelease>> = Object.freeze({
  windows_amd64: { version: NATIVE_VERSION, url: asset('windows_amd64'), format: 'exe', size: 235400344, executableSize: 235400344,
    sha512: '64603ba45b2783587edc62fd9effa9228091593b440ed54368e098bb5fb3ee034bada58c4125e3c0e509ed460b327e454dc99971d04d47c7aee417f00f56d801' },
  windows_arm64: { version: NATIVE_VERSION, url: asset('windows_arm64'), format: 'exe', size: 223512216, executableSize: 223512216,
    sha512: '46303612328c3a367a571c6b8d4503d88681929461986d91da3ca6742b5b66249dd89808a57b5f4b770fe5bee085d4c64b4a381bbaa494e75f8462053a517e26' },
  darwin_amd64: { version: NATIVE_VERSION, url: asset('darwin_amd64'), format: 'tar.gz', size: 90841040, executableSize: 235589664,
    sha512: 'b392e94e593a3c93e90b14e277c80e9712c1442dba0f68a7b48918bbeb990250a544eedf791426d3afd95162128b4de320f549f2639640d20e1d25b567784c7f' },
  darwin_arm64: { version: NATIVE_VERSION, url: asset('darwin_arm64'), format: 'tar.gz', size: 85295784, executableSize: 226575952,
    sha512: 'f0d951b41bddb62cbee0199a60cc9a9aba16cecb95c5cf7d5c71349c745c578f2d2bbce1194b058e867e85456030ac1b1ec72772ee17b31de1d606f34cce3154' },
  linux_amd64: { version: NATIVE_VERSION, url: asset('linux_amd64'), format: 'tar.gz', size: 100322406, executableSize: 269443784,
    sha512: '26de25fccb3fbf0b093e090ce14a14ac1df1ec3e90ef4ea6106887d3a81b0cc9edb0dadea7b9101d07f9606eba159062a6fb7b78e91b73f7520684a24db73428' },
  linux_arm64: { version: NATIVE_VERSION, url: asset('linux_arm64'), format: 'tar.gz', size: 91394923, executableSize: 253055664,
    sha512: '1030d89ce9e5cb39509e272cb89b71fde0e0d5d6527b7392525d5ef2683da54fb49230449107486d91c02ded39a678faaa649b2041304a6cf82a3a332d5819d9' },
  linux_amd64_musl: { version: NATIVE_VERSION, url: asset('linux_amd64_musl'), format: 'tar.gz', size: 92722733, executableSize: 241162056,
    sha512: '4499b2a2127df1b89601ce81c9aaa1aaa7aad6d282bac8c7ed8a2b20e1f5c2bec43bd5ffcd3be7ea258d7205cf4911cd995114c311df7bf2d07fbf7d3518e4fa' },
  linux_arm64_musl: { version: NATIVE_VERSION, url: asset('linux_arm64_musl'), format: 'tar.gz', size: 87208468, executableSize: 229057792,
    sha512: '5379e2a0610b400e2f7152d1ba3f0500c775959ac1c52b338c6bcf15e7e6c0324bf277bbf4e4633cb1377efd42faa7689294ff08377bb61644d3ba9ecc49f9a6' }
})

/** Releases Mousse stopped trusting after review. A withdrawn version is never installed and never run. */
export const WITHDRAWN_NATIVE_VERSIONS: readonly string[] = Object.freeze([])

/**
 * Where Mousse runs the native CLI instead of the 1.1.1 ACP server. A platform qualifies only once
 * the profile's sign-in, settings and app data are shown to stay in the profile's own folder
 * (docs/providers/antigravity-runtime.md). None does yet: on Windows the CLI signed in from the
 * user's own Credential Manager entry despite a private `--gemini-dir`.
 */
export const NATIVE_QUALIFIED_PLATFORMS: Readonly<Record<'win32' | 'darwin' | 'linux', boolean>> = Object.freeze({
  win32: false,
  darwin: false,
  linux: false
})

export function nativeQualified(platform: NodeJS.Platform, table: Readonly<Partial<Record<NodeJS.Platform, boolean>>> = NATIVE_QUALIFIED_PLATFORMS): boolean {
  return table[platform] === true
}

/** Google's target name for this machine; undefined where Google publishes no CLI. */
export function nativeTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch, musl = isMusl(platform, arch)): NativeTarget | undefined {
  if (arch !== 'x64' && arch !== 'arm64') return undefined
  const cpu = arch === 'x64' ? 'amd64' : 'arm64'
  if (platform === 'win32') return `windows_${cpu}`
  if (platform === 'darwin') return `darwin_${cpu}`
  if (platform === 'linux') return musl ? `linux_${cpu}_musl` : `linux_${cpu}`
  return undefined
}

function isMusl(platform: NodeJS.Platform, arch: string): boolean {
  return platform === 'linux' && existsSync(arch === 'arm64' ? '/lib/libc.musl-aarch64.so.1' : '/lib/libc.musl-x86_64.so.1')
}

/** Name the executable is kept under in the install: Google's own names. */
export function nativeExecutableName(target: NativeTarget): string {
  return target.startsWith('windows_') ? 'agy.exe' : 'antigravity'
}

/**
 * The URL is exactly Google's bucket path for `version` and `target`: https, the
 * `storage.googleapis.com` host, `antigravity-cli/<version>-<build>/<folder>/<file>`, and nothing else.
 */
export function isNativeAssetUrl(url: string, version: string, target: NativeTarget): boolean {
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  if (parsed.origin !== ASSET_ORIGIN || parsed.username || parsed.password || parsed.search || parsed.hash) return false
  if (!parsed.pathname.startsWith(ASSET_PREFIX)) return false
  const [build, folder, file, ...rest] = parsed.pathname.slice(ASSET_PREFIX.length).split('/')
  const expected = ASSET_FILES[target]
  return rest.length === 0 && new RegExp(`^${version.replaceAll('.', '\\.')}-\\d+$`).test(build ?? '') &&
    folder === expected.folder && file === expected.file
}

export type VendorFeed =
  /** The feed offers exactly the reviewed release. */
  | { kind: 'reviewed'; version: string }
  /** A newer release Mousse has not reviewed: reported, never installed. */
  | { kind: 'newer'; version: string }
  /** The feed went back to an older version: Google withdrew the reviewed one. */
  | { kind: 'withdrawn'; version: string }
  /** The same version with another URL or digest: nothing from the feed is trusted. */
  | { kind: 'mismatch'; version: string }
  | { kind: 'invalid' }

const VERSION = /^\d+\.\d+\.\d+$/

/** Reads one target's feed entry (`<base>/<target>.json`) against the reviewed release. */
export function classifyVendorFeed(raw: unknown, target: NativeTarget, reviewed: NativeRelease = NATIVE_RELEASES[target]): VendorFeed {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid' }
  const { version, url, sha512 } = raw as Record<string, unknown>
  if (typeof version !== 'string' || !VERSION.test(version) || typeof url !== 'string' || typeof sha512 !== 'string' || !/^[0-9a-fA-F]{128}$/.test(sha512)) return { kind: 'invalid' }
  if (!isNativeAssetUrl(url, version, target)) return { kind: 'invalid' }
  const order = compareVersions(version, reviewed.version)
  if (order > 0) return { kind: 'newer', version }
  if (order < 0) return { kind: 'withdrawn', version }
  return url === reviewed.url && sha512.toLowerCase() === reviewed.sha512 ? { kind: 'reviewed', version } : { kind: 'mismatch', version }
}

/** Whether a release may be installed now: not withdrawn by Mousse, and not by the feed when it answered. */
export function nativeReleaseRefusal(release: NativeRelease, feed: VendorFeed | undefined, withdrawn: readonly string[] = WITHDRAWN_NATIVE_VERSIONS): string | undefined {
  if (withdrawn.includes(release.version)) return `Antigravity ${release.version} was withdrawn. Mousse keeps the current version.`
  if (feed?.kind === 'withdrawn') return `Google withdrew Antigravity ${release.version}. Mousse keeps the current version.`
  if (feed?.kind === 'mismatch') return `Google's update feed lists a different Antigravity ${release.version} download. Mousse keeps the current version.`
  return undefined
}
