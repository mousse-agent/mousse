import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { cachedBuild } from '../scripts/cached-build.mjs'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-start-cache-'))
  onTestFinished(() => {
    const path = relative(tmpdir(), root)
    if (isAbsolute(path) || path.startsWith('..') || !path.startsWith('mousse-start-cache-')) throw new Error('Unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}')
  writeFileSync(join(root, 'scripts/build-cli.mjs'), '// original build config')
  writeFileSync(join(root, 'src/dep.ts'), 'export const value = 1')
  writeFileSync(join(root, 'src/index.ts'), 'import { value } from "./dep"; console.log(value)')
  // Older timestamps also prove the cache does not rely on modification time alone.
  const old = new Date(Date.now() - 60_000)
  for (const name of ['src/dep.ts', 'src/index.ts']) utimesSync(join(root, name), old, old)
  const options = {
    entryPoints: [join(root, 'src/index.ts')], outfile: join(root, 'out/index.js'),
    bundle: true, platform: 'node', format: 'esm', sourcemap: true
  }
  const run = (reuse = true) => cachedBuild(options, { projectRoot: root, name: 'fixture', reuse })
  await run()
  return { root, options, run }
}

describe('npm start prerequisite builds', () => {
  it('reuses unchanged bundles but rebuilds a transitive edit with preserved size and mtime', async () => {
    const { root, run } = await fixture()
    expect(await run()).toEqual({ reused: true })
    const path = join(root, 'src/dep.ts')
    const before = statSync(path)
    writeFileSync(path, 'export const value = 2')
    utimesSync(path, before.atime, before.mtime)
    expect(await run()).toEqual({ reused: false })
    expect(readFileSync(join(root, 'out/index.js'), 'utf8')).toContain('value = 2')
    expect(await run()).toEqual({ reused: true })
  })

  it.each(['out/index.js', 'out/index.js.map'])('rebuilds when %s is missing', async (path) => {
    const { root, run } = await fixture()
    unlinkSync(join(root, path))
    expect(await run()).toEqual({ reused: false })
    expect(readFileSync(join(root, path), 'utf8')).toBeTruthy()
  })

  it.each(['package-lock.json', 'package.json', 'scripts/build-cli.mjs'])('invalidates changes to %s', async (path) => {
    const { root, run } = await fixture()
    writeFileSync(join(root, path), path.endsWith('.json') ? '{"changed":true}' : '// new build configuration')
    expect(await run()).toEqual({ reused: false })
  })

  it('rebuilds changed outputs, corrupt cache and changed build options', async () => {
    const { root, run, options } = await fixture()
    writeFileSync(join(root, 'out/index.js'), 'console.log("stale")')
    expect(await run()).toEqual({ reused: false })
    writeFileSync(join(root, 'out/.start-build-cache/fixture.json'), '{corrupt')
    expect(await run()).toEqual({ reused: false })
    expect(await cachedBuild({ ...options, minify: true }, { projectRoot: root, name: 'fixture', reuse: true })).toEqual({ reused: false })
  })

  it('does not skip explicit builds or hide compilation failures', async () => {
    const { root, run } = await fixture()
    expect(await run(false)).toEqual({ reused: false })
    writeFileSync(join(root, 'src/dep.ts'), 'this is invalid TypeScript')
    await expect(run()).rejects.toThrow()
  })

  it('detects added resolution candidates without rebuilding unrelated content edits', async () => {
    const { root, run } = await fixture()
    writeFileSync(join(root, 'src/extra.ts'), 'export const unrelated = 1')
    expect(await run()).toEqual({ reused: false })
    writeFileSync(join(root, 'src/extra.ts'), 'export const unrelated = 2')
    expect(await run()).toEqual({ reused: true })
  })
})
