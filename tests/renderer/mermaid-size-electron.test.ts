import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'
import { build as viteBuild } from 'vite'

type Size = { width: number; height: number }
type Measured = {
  natural: Size; drawn: Size; body: Size
  textSize: number; replySize: number; textFont: string; replyFont: string
  nodeFill: string; nodeFillAlpha: number
  expand: boolean
}

/** A drawing taller than this starts clipped (DIAGRAM_MAX_HEIGHT plus the body's 12px top and bottom padding). */
const CLIPPED_BODY = 480 + 24

it('draws a Mermaid diagram at reply text size, never larger than drawn, clipped when tall, tinted by the theme', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-mermaid-size-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    // Sizing is app CSS over Streamdown's Tailwind classes: compile them as the renderer build does.
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/mermaid-size/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/mermaid-size/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/mermaid-size/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_MERMAID_SIZE_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const result = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as {
      cases: Record<string, Measured & { expanded: Measured | null }>; pageErrors: string[]
    }
    expect(result.pageErrors).toEqual([])
    expect(Object.keys(result.cases)).toHaveLength(9)
    for (const [name, at] of Object.entries(result.cases)) {
      const where = `${name}: ${JSON.stringify(at)}`
      // Node text reads like the reply around it.
      expect(Math.abs(at.textSize - at.replySize), where).toBeLessThanOrEqual(1)
      expect(at.textFont, where).toBe(at.replyFont)
      // Never stretched past the size it was drawn at, and never wider than the message.
      expect(at.drawn.width, where).toBeLessThanOrEqual(at.natural.width + 0.5)
      expect(at.drawn.width, where).toBeLessThanOrEqual(at.body.width + 0.5)
      // Nodes are a light tint of the theme's text colour, not an opaque block.
      expect(at.nodeFillAlpha, where).toBeGreaterThan(0)
      expect(at.nodeFillAlpha, where).toBeLessThan(0.3)

      if (name.startsWith('small-')) {
        expect(at.drawn.width, where).toBeGreaterThan(at.natural.width - 0.5)
        expect(at.expand, where).toBe(false)
      }
      if (name.startsWith('wide-')) {
        expect(at.natural.width, where).toBeGreaterThan(at.body.width)
        expect(at.drawn.width, where).toBeGreaterThan(at.body.width - 0.5)
      }
      if (name.startsWith('tall-')) {
        // The six-step flowchart starts clipped below the viewport's height, and Expand shows all of it.
        expect(at.natural.height, where).toBeGreaterThan(CLIPPED_BODY)
        expect(at.expand, where).toBe(true)
        expect(at.body.height, where).toBeLessThanOrEqual(CLIPPED_BODY + 0.5)
        expect(at.expanded, where).not.toBeNull()
        expect(at.expanded!.body.height, where).toBeGreaterThan(at.natural.height)
      }
    }
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected Mermaid size fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 90000)
