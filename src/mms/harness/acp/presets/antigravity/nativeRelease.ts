import { existsSync } from 'node:fs'
import { compareVersions } from '../../../driver'

/**
 * Google's Antigravity CLI (`agy`), which serves ACP itself as `agy acp`. Mousse installs the
 * version Google's update feed names for this computer (`<feed>/<target>.json`), only from Google's
 * exact release path in its storage bucket, and only when the download matches the feed's SHA-512.
 */

/** The `agentInfo.name` the CLI answers `initialize` with. */
export const NATIVE_AGENT_NAME = 'Antigravity ACP Server'

export const NATIVE_FEED_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests'
const ASSET_ORIGIN = 'https://storage.googleapis.com'
const ASSET_PREFIX = '/antigravity-public/antigravity-cli/'

export type NativeTarget =
  | 'windows_amd64' | 'windows_arm64' | 'darwin_amd64' | 'darwin_arm64'
  | 'linux_amd64' | 'linux_arm64' | 'linux_amd64_musl' | 'linux_arm64_musl'

/** A release as Google's feed names it. The feed gives no size: downloads are capped instead. */
export interface NativeRelease {
  version: string
  url: string
  sha512: string
  /** Windows ships the executable itself; macOS and Linux a gzip tar holding one `antigravity` file. */
  format: 'exe' | 'tar.gz'
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

/** The oldest version Mousse runs as `agy acp`, and installs from the feed. */
export const NATIVE_MIN_VERSION = '1.5.0'
/** The largest download Mousse accepts; Google's are 85 to 240 MB. */
export const NATIVE_MAX_DOWNLOAD_BYTES = 768 * 1024 * 1024
/** The largest executable an archive may hold; Google's are 225 to 270 MB. */
export const NATIVE_MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024

/** Releases Mousse stopped trusting. A withdrawn version is never installed and never run. */
export const WITHDRAWN_NATIVE_VERSIONS: readonly string[] = Object.freeze([])

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

const VERSION = /^\d+\.\d+\.\d+$/

/**
 * The release a feed entry (`<base>/<target>.json`) names: a plain version no older than
 * `NATIVE_MIN_VERSION`, Google's exact release URL for that version and target, and a SHA-512.
 * Undefined for anything else.
 */
export function parseVendorFeed(raw: unknown, target: NativeTarget): NativeRelease | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { version, url, sha512 } = raw as Record<string, unknown>
  if (typeof version !== 'string' || !VERSION.test(version) || compareVersions(version, NATIVE_MIN_VERSION) < 0) return undefined
  if (typeof url !== 'string' || !isNativeAssetUrl(url, version, target)) return undefined
  if (typeof sha512 !== 'string' || !/^[0-9a-fA-F]{128}$/.test(sha512)) return undefined
  return { version, url, sha512: sha512.toLowerCase(), format: target.startsWith('windows_') ? 'exe' : 'tar.gz' }
}

/** Why a release may not be installed now; undefined when it may. */
export function nativeReleaseRefusal(release: NativeRelease, withdrawn: readonly string[] = WITHDRAWN_NATIVE_VERSIONS): string | undefined {
  if (withdrawn.includes(release.version)) return `Antigravity ${release.version} was withdrawn. Mousse keeps the current version.`
  return undefined
}
