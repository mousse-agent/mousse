import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'

it('paints the real shell and retryable skeleton before trusted binding, then progressively hydrates the actual StrictMode root', async () => {
  const temporaryRoot = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(temporaryRoot, 'mousse-startup-mounted-')))
  let child: ChildProcess | undefined, exited: Promise<number | null> | undefined
  // I retain the real root, App, profile switcher, browser permission poll and
  // hidden ChannelsPanel; unrelated editors/transcripts are outside this check.
  const displays = ['OrchestratorChat', 'ChatWorkspace', 'ThreadsSidebar', 'QuickActionsButton', 'ProjectTerminalPanel', 'FilesPanel', 'GitPanel', 'DocumentPanel', 'AgentsPanel', 'SettingsPage', 'ScheduledPage']
  try {
    await build({
      entryPoints: [resolve('tests/fixtures/renderer-startup/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.svg': 'dataurl', '.webp': 'dataurl', '.woff2': 'dataurl' },
      plugins: [{ name: 'unrelated-displays', setup(builder) {
        // The layout assertions use real app CSS; Tailwind's build directives
        // are unrelated to these authored shell rules and need its Vite plugin.
        builder.onLoad({ filter: /[/\\]styles[/\\]global\.css$/ }, args => ({ contents: readFileSync(args.path, 'utf8').replace('@import "tailwindcss";', '').replace(/^@source .*;\r?\n/gm, ''), loader: 'css' }))
        builder.onResolve({ filter: new RegExp(`/(?:${displays.join('|')})$`) }, args => ({ path: args.path.split('/').at(-1)!, namespace: 'empty-display' }))
        builder.onLoad({ filter: /.*/, namespace: 'empty-display' }, args => ({ contents: args.path === 'OrchestratorChat'
          ? `import {createElement} from 'react'; export function OrchestratorChat(){return createElement('div',{className:'startup-transcript'})}`
          : args.path === 'SettingsPage' || args.path === 'ScheduledPage'
            ? `import {createElement} from 'react'; import {useAppStore} from './src/renderer/stores/appStore'; export function ${args.path}(){const open=useAppStore(s=>s.${args.path === 'SettingsPage' ? 'settingsOpen' : 'scheduledOpen'});return createElement('div',{className:'${args.path === 'SettingsPage' ? 'settings-page' : 'scheduled-page'} overlay-page',hidden:!open},createElement('header',{className:'overlay-titlebar'},'Page'))}`
            : `export function ${args.path}(){return null}`, loader: 'js', resolveDir: process.cwd() }))
      } }]
    })
    await build({ entryPoints: [resolve('tests/fixtures/renderer-startup/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'] })
    writeFileSync(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="entry.css"><div id="root"></div><script src="entry.js"></script>')
    const env = { ...process.env, MOUSSE_RENDERER_STARTUP_DIRECTORY: directory }; delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-10000) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-10000) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const report = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8'))
    expect(report.rendererErrors).toEqual([])
    expect(report.before).toMatchObject({ ready: false, profile: 'default', channels: false, main: false, skeleton: true, titlebar: true, theme: 'dark-modern', surface: '#1f1f1f', acrylic: 'false' })
    expect(report.failed).toMatchObject({ ready: false, main: false, skeleton: true })
    expect(report.failed.error).toContain('Controlled workspace service unavailable')
    expect(report.before.calls.some((row: any) => row.method.startsWith('channels.') || row.method.startsWith('settings.') || row.method === 'platformRequest.request')).toBe(false)
    expect(report.after).toMatchObject({ ready: true, profile: 'prf_startup-bound', channels: true, main: true, errors: [], workspaceReady: false, skeleton: true, transcript: false })
    expect(report.hydrated).toMatchObject({ workspaceReady: true, transcript: true, errors: [] })
    expect(report.after.calls.some((row: any) => row.method === 'settings.get')).toBe(true)
    expect(report.after.calls.some((row: any) => row.method === 'platformRequest.request' && row.params === 'chats.snapshot')).toBe(true)
    const browserCalls = report.after.calls.filter((row: any) => row.method === 'platformRequest.request' && row.params === 'browser.access.status')
    expect(browserCalls.length).toBeGreaterThan(0)
    for (const call of browserCalls) expect(call.input).toEqual({ profileId: 'prf_startup-bound' })
    for (const sample of report.acrylic) {
      expect(sample.root.background).not.toBe('rgba(0, 0, 0, 0)')
      for (const pane of sample.panes) {
        expect(pane.background).toBe('rgba(0, 0, 0, 0)')
        expect(pane.image).toBe('none')
      }
      expect(sample.dividerAlpha).toBeCloseTo(0.06)
      expect(sample.visiblePanes).toBe(1)
    }
    expect(report.acrylic[0].root.background).not.toBe(report.acrylic[1].root.background)
    for (const page of report.overlays) {
      expect(page.workspaceVisibility).toBe('hidden')
      expect(page.workspaceInert).toBe(true)
      expect(page.workspaceSize).toEqual(report.workspaceSize)
      expect(page.visiblePages).toBe(1)
      expect(page.headerBackground).toBe('rgba(0, 0, 0, 0)')
      expect(page.workspaceRetained).toBe(true)
    }
    expect(report.restored).toEqual({ visibility: 'visible', inert: false, retained: true })
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited?.catch(() => undefined) }
    if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('mousse-startup-mounted-')) throw new Error('Refusing cleanup outside the owned startup fixture directory')
    rmSync(directory, { recursive: true, force: true })
  }
}, 25000)
