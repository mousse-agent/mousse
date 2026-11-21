// What the packaging scripts share about the network helper: the six desktop targets as Rust target triples, where
// a packaged app keeps its helper, and how `mousse-helper --version` names its build.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** The six desktop targets (`<os>-<arch>`, as the owner checks name them) and their Rust target triples. */
export const HELPER_TARGETS = Object.freeze({
  'windows-x64': 'x86_64-pc-windows-msvc',
  'windows-arm64': 'aarch64-pc-windows-msvc',
  'macos-arm64': 'aarch64-apple-darwin',
  'macos-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu'
})

const OS = { win32: 'windows', darwin: 'macos', linux: 'linux' }

/** The target of a Node platform and architecture (`process.platform`, `process.arch`, or electron-builder's arch). */
export function targetName(platform, arch) {
  const os = OS[platform]
  const name = os && `${os}-${arch}`
  if (!name || !HELPER_TARGETS[name]) throw new Error(`no network helper target for ${platform} ${arch}`)
  return name
}

/** The helper's file name for a Rust target triple. */
export function helperFileName(triple) {
  return triple.includes('-windows-') ? 'mousse-helper.exe' : 'mousse-helper'
}

/** `mousse-helper --version` reads `mousse-helper <version> build <build> control <control>`. */
export function parseHelperVersion(text) {
  const match = /\bbuild (\S+) control (\S+)/.exec(text ?? '')
  return match ? { build: match[1], control: match[2] } : undefined
}

/** A build id, `<commit>[-dirty]+<profile>`, as its parts; undefined when it is not one. */
export function parseBuildId(text) {
  const match = /^([0-9a-f]{7,64})(-dirty)?\+([A-Za-z0-9-]+)$/i.exec((text ?? '').trim())
  return match ? { commit: match[1].toLowerCase(), dirty: !!match[2], profile: match[3] } : undefined
}

/**
 * Whether a helper's build is the expected one: the same commit (either may be abbreviated, to at least 7 digits),
 * the same profile, and neither has uncommitted changes.
 */
export function sameBuild(reported, expected) {
  const a = parseBuildId(reported),
    b = parseBuildId(expected)
  if (!a || !b || a.dirty || b.dirty || a.profile !== b.profile) return false
  return a.commit.startsWith(b.commit) || b.commit.startsWith(a.commit)
}

/**
 * The unpacked app electron-builder made under `release` (`win-unpacked`, `win-arm64-unpacked`, `linux-unpacked`,
 * `linux-arm64-unpacked`, `mac-arm64/Mousse.app`, `mac/Mousse.app`), or undefined.
 */
export function findUnpackedApp(release) {
  if (!existsSync(release)) return undefined
  for (const entry of readdirSync(release).sort()) {
    if (entry.endsWith('-unpacked')) return join(release, entry)
    if (entry === 'mac' || entry.startsWith('mac-')) {
      const app = readdirSync(join(release, entry)).find((name) => name.endsWith('.app'))
      if (app) return join(release, entry, app)
    }
  }
  return undefined
}

/** Where an unpacked app keeps its resources, its helper, and the executable its CLI runs. */
export function packagedLayout(app) {
  if (app.endsWith('.app')) {
    const resources = join(app, 'Contents', 'Resources')
    return {
      resources,
      helper: join(resources, 'net-helper', 'mousse-helper'),
      executable: join(app, 'Contents', 'MacOS', 'Mousse')
    }
  }
  const resources = join(app, 'resources')
  const windows = existsSync(join(app, 'Mousse.exe'))
  return {
    resources,
    helper: join(resources, 'net-helper', windows ? 'mousse-helper.exe' : 'mousse-helper'),
    executable: join(app, windows ? 'Mousse.exe' : 'mousse')
  }
}

/**
 * The Rust toolchain a Windows helper build uses: the default one when it targets MSVC; else stable MSVC for this
 * computer's architecture, unless RUSTUP_TOOLCHAIN chose another (`chosen`). `hostOf(toolchain)` says what a
 * toolchain targets (`rustc -vV`'s host, empty when it is not installed). Answers `{ toolchain }` (undefined: the
 * default) or `{ fail }`, the message a build stops with, never quietly.
 */
export function windowsToolchain({ arch, host, chosen, hostOf }) {
  if (host.endsWith('-msvc')) return { toolchain: undefined }
  const msvc = `stable-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`
  const fix = `install it with "rustup toolchain install ${msvc}", or set RUSTUP_TOOLCHAIN to an MSVC toolchain`
  if (chosen) return { fail: `RUSTUP_TOOLCHAIN=${chosen} targets ${host || 'an unknown host'}, not MSVC; ${fix}` }
  if (!hostOf(msvc).endsWith('-msvc'))
    return { fail: `the default Rust toolchain targets ${host || 'an unknown host'}, not MSVC, and ${msvc} is not installed; ${fix}` }
  return { toolchain: msvc }
}
