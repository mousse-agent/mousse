import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'
import { build as viteBuild } from 'vite'

type Measured = { ownBlock: boolean; against: string | null; inHeader: boolean; button: { top: number; right: number }; header: { top: number; bottom: number; right: number } }

it('puts every code block\'s copy button in that block\'s own header: only block, first, middle, last, in a list, in a quote, streaming', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-code-block-copy-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    // The copy button's placement is app CSS over Streamdown's Tailwind classes: compile them as the renderer build does.
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/code-block-copy/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/code-block-copy/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/code-block-copy/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_CODE_BLOCK_COPY_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const result = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as {
      cases: Record<string, Measured[]>; pageErrors: string[]; rendererErrors: string[]
    }
    expect(result.pageErrors).toEqual([])
    expect(Object.fromEntries(Object.entries(result.cases).map(([name, blocks]) => [name, blocks.length])))
      .toEqual({ only: 1, sequence: 3, list: 1, quote: 1, streaming: 2 })
    for (const [name, blocks] of Object.entries(result.cases)) {
      blocks.forEach((block, index) => {
        const where = `${name} block ${index + 1}: ${JSON.stringify(block)}`
        // Laid out against its own block, not a turn row or the transcript further up.
        expect(block.ownBlock, where).toBe(true)
        expect(block.inHeader, where).toBe(true)
        // At the header's right end.
        expect(block.header.right - block.button.right, where).toBeLessThan(24)
      })
    }
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected code block fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 60000)
