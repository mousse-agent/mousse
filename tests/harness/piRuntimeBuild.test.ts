import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPiRuntime, reachableImports, runtimeProblems } from '../../scripts/build-pi-runtime.mjs'

// The packaged runtime must hold every package Pi loads: Node would otherwise find a missing one
// in any node_modules above it (the repository's, the user's home) and hide the gap until a user's
// machine has none.

const repoRoot = resolve(__dirname, '..', '..')
let out: string
let pi: string

beforeAll(async () => {
  out = join(mkdtempSync(join(tmpdir(), 'mousse-pi-runtime-')), 'pi-runtime')
  pi = join(out, 'pi-coding-agent')
  await buildPiRuntime(repoRoot, { out })
}, 60_000)

afterAll(() => {
  rmSync(resolve(out, '..'), { recursive: true, force: true })
})

describe('Pi runtime build', () => {
  it('ships the bundle, the packages it loads, the themes and Mousse\'s extension, with nothing missing', () => {
    expect(JSON.parse(readFileSync(join(out, 'runtime.json'), 'utf8')).packages).toEqual({
      '@earendil-works/chord': expect.any(String),
      typebox: expect.any(String),
      jiti: expect.any(String),
      '@silvia-odwyer/photon-node': expect.any(String)
    })
    for (const path of ['dist/bundle/rpc-entry.js', 'dist/modes/interactive/theme/dark.json', 'node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm'])
      expect(existsSync(join(pi, path)), path).toBe(true)
    expect(readFileSync(join(out, 'mousse-extension.mjs'), 'utf8')).toContain('mousse-extension')
    expect(runtimeProblems(pi)).toEqual([])
  })

  it('reports a package the bundle imports that is not shipped', () => {
    const jiti = join(pi, 'node_modules/jiti')
    renameSync(jiti, `${jiti}-away`)
    try {
      expect(runtimeProblems(pi)).toEqual(["Pi's bundle imports jiti"])
    } finally {
      renameSync(`${jiti}-away`, jiti)
    }
  })

  it('allows chord\'s esbuild only while nothing Pi loads reaches it', () => {
    expect(reachableImports(pi, ['@earendil-works/chord/context'])).toEqual([])
    expect(reachableImports(pi, ['@earendil-works/chord/bundler'])).toContain('esbuild')
    const chunk = join(pi, 'dist/bundle/chunks/zz-mousse-test.js')
    writeFileSync(chunk, 'import"@earendil-works/chord/bundler";\n')
    try {
      expect(runtimeProblems(pi)).toEqual(['@earendil-works/chord now loads esbuild'])
    } finally {
      rmSync(chunk)
    }
  })

  it('reports a dependency a shipped package declares that is neither shipped nor listed as unreachable', () => {
    const manifest = join(pi, 'node_modules/typebox/package.json')
    const original = readFileSync(manifest, 'utf8')
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), dependencies: { 'left-pad': '1.3.0' } }))
    try {
      expect(runtimeProblems(pi)).toEqual(['typebox depends on left-pad'])
    } finally {
      writeFileSync(manifest, original)
    }
  })

  it('ignores imports the bundle guards as optional', () => {
    const chunk = join(pi, 'dist/bundle/chunks/zz-mousse-optional.js')
    appendFileSync(chunk, 'try{__require("bufferutil")}catch{}\n')
    try {
      expect(runtimeProblems(pi)).toEqual([])
    } finally {
      rmSync(chunk)
    }
  })
})
