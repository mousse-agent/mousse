/**
 * `scripts/build-net-helper.mjs` on Windows: a default GNU Rust toolchain is passed over for stable MSVC, and a
 * setup that can't build fails with the fix instead of a quiet "Not in this build".
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error a plain .mjs script module
import { windowsToolchain } from '../../scripts/net-helper-build.mjs'

const installed = (toolchains: Record<string, string>) => (toolchain: string) =>
  toolchains[toolchain] ?? ''

describe('the Windows helper build toolchain', () => {
  it('keeps a default MSVC toolchain', () => {
    expect(
      windowsToolchain({ arch: 'x64', host: 'x86_64-pc-windows-msvc', hostOf: installed({}) })
    ).toEqual({
      toolchain: undefined
    })
  })

  it('uses stable MSVC when the default one is GNU', () => {
    const hostOf = installed({ 'stable-x86_64-pc-windows-msvc': 'x86_64-pc-windows-msvc' })
    expect(windowsToolchain({ arch: 'x64', host: 'x86_64-pc-windows-gnu', hostOf })).toEqual({
      toolchain: 'stable-x86_64-pc-windows-msvc'
    })
  })

  it('fails with the fix when stable MSVC is not installed, or RUSTUP_TOOLCHAIN chose GNU', () => {
    const missing = windowsToolchain({
      arch: 'x64',
      host: 'x86_64-pc-windows-gnu',
      hostOf: installed({})
    })
    expect(missing.fail).toContain('rustup toolchain install stable-x86_64-pc-windows-msvc')
    const chosen = windowsToolchain({
      arch: 'arm64',
      host: 'aarch64-pc-windows-gnullvm',
      chosen: 'stable-gnu',
      hostOf: installed({ 'stable-aarch64-pc-windows-msvc': 'aarch64-pc-windows-msvc' })
    })
    expect(chosen.fail).toContain('RUSTUP_TOOLCHAIN=stable-gnu')
  })
})
