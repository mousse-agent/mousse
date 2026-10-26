/**
 * The Codex release a managed ChatGPT entry runs: one pinned version, downloaded only from
 * OpenAI's GitHub release and checked against the digests below. The token helper, the provider
 * table and the launch flags are tested against exactly this version, so it is never taken from
 * PATH and never newer than the pin.
 *
 * Sizes and digests come from the release's asset list and its `codex-package_SHA256SUMS`
 * (sha256 828b09736925c615d115fc77b328a6cacd7e23d80c278612d98859fbe4f46108).
 */

export const CODEX_MANAGED_VERSION = '0.162.1'
const RELEASE_BASE = `https://github.com/openai/codex/releases/download/rust-v${CODEX_MANAGED_VERSION}`

export interface CodexRelease {
  version: string
  /** The Rust target triple the package is built for. */
  target: string
  url: string
  /** The exact size of the `.tar.gz`: a larger download fails at once. */
  bytes: number
  sha256: string
  /** Whether the package's executables end in `.exe`. */
  windows: boolean
}

function release(target: string, bytes: number, sha256: string): CodexRelease {
  return { version: CODEX_MANAGED_VERSION, target, url: `${RELEASE_BASE}/codex-package-${target}.tar.gz`, bytes, sha256, windows: target.includes('windows') }
}

/** By `<platform>-<arch>` as Node reports them. Linux uses the static (musl) builds. */
export const CODEX_RELEASES: Readonly<Record<string, CodexRelease>> = Object.freeze({
  'win32-x64': release('x86_64-pc-windows-msvc', 159746536, '3e993a82ff393f4530558dcaadb36bb4f0fd1ea7243e621348e40b469f900f6a'),
  'win32-arm64': release('aarch64-pc-windows-msvc', 147962319, '513db87ad85a52acb76e552e97caed87813e8ca3b861a1d69c9d5b1638bdb74b'),
  'darwin-arm64': release('aarch64-apple-darwin', 132224844, '88e37ccddf5a0f4ea9dc1be13c66a2a94f9c2d1a04f3ace9053d71b3939e885d'),
  'darwin-x64': release('x86_64-apple-darwin', 143687717, '894ac20afe819d4fa2a4be8cd27c54fd606338b86036e8ed9b6c9978c2dc7aed'),
  'linux-x64': release('x86_64-unknown-linux-musl', 162905879, 'a676f5722aae0d86cbe3764332f08eab1fdd89dc0a300b3ad4ffbf48611fa3e3'),
  'linux-arm64': release('aarch64-unknown-linux-musl', 153057922, '53a9ce0b94beb27a63fdeb2f7704d95199e17b3898aa33b60461a1a93ac0d88b')
})

/** The package for this machine, when OpenAI publishes one. */
export function codexReleaseFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): CodexRelease | undefined {
  return CODEX_RELEASES[`${platform}-${arch}`]
}

export function unsupportedPlatformMessage(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `OpenAI publishes no Codex package for ${platform}-${arch}. Use your own Codex CLI.`
}

/** The manifest at the root of every package. */
export const CODEX_MANIFEST = 'codex-package.json'
export const CODEX_LAYOUT_VERSION = 1

/** The package's executable, relative to its root. */
export function codexEntrypoint(release: Pick<CodexRelease, 'windows'>): string {
  return release.windows ? 'bin/codex.exe' : 'bin/codex'
}

/**
 * Files every package of the pinned layout has; a missing one fails the install. `executable`
 * files need their exec bit on POSIX.
 */
export function codexFileset(release: Pick<CodexRelease, 'windows'>): ReadonlyArray<{ path: string; executable: boolean }> {
  const exe = release.windows ? '.exe' : ''
  return [
    { path: CODEX_MANIFEST, executable: false },
    { path: `bin/codex${exe}`, executable: true },
    { path: `bin/codex-code-mode-host${exe}`, executable: true },
    { path: `codex-path/rg${exe}`, executable: true }
  ]
}

/** What `codex --version` prints for the pin. */
export function expectedVersionLine(release: Pick<CodexRelease, 'version'>): string {
  return `codex-cli ${release.version}`
}
