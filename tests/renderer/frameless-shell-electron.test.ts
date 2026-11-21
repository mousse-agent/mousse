/**
 * Real-Chromium verification of the frameless shell's docked sidebar feathering and right-panel BotSidePanel layout,
 * compiled through Tailwind/Vite in the same CSS import order as main.tsx.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'
import { expect, it } from 'vitest'
import { build as viteBuild } from 'vite'
import { themeTokensCss } from '../../src/renderer/lib/themeCss'

type Rgb = [number, number, number]

type Scenario = {
  sidebarBg: string
  sidebarIsolation: string
  sidebarBeforeContent: string
  sidebarBeforeZ: string
  sidebarScrollMask: string
  sidebarAfterContent: string
  mainHeaderBg: string
  mainHeaderBorderBottom: string
  mainCardRadius: string
  mainCardOverflow: string
  mainCardAfterContent: string
  toolbarBg: string
  filesSidebarBg: string
  profileBottomGap: number
  chatBottomGap: number
  cardBottomGap: number
  cardRightGap: number
  pixels: {
    sidebarCenter: Rgb
    sidebarRightEdge: Rgb
    sidebarTopEdge: Rgb
    belowChatCorner: Rgb
    scrollFadeCenter: Rgb
    titlebarCenter: Rgb
    railCenter: Rgb
    rightOfCard: Rgb
  }
}

type Evidence = {
  userTheme: Scenario
  builtInDark: Scenario
  highContrast: Scenario
  overlayDrawer: Scenario
  frameColor: Scenario
}

it('feathers the colored docked sidebar cleanly and frames the right panel as floating tabs over a specular card', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-frameless-shell-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    const stylesEntry = join(directory, 'styles-entry.ts')
    const root = resolve('src/renderer')
    // Same stylesheet order as src/renderer/main.tsx for shell, sidebar, panels and frameless overrides.
    writeFileSync(stylesEntry, [
      `import ${JSON.stringify(resolve(root, 'styles/global.css'))}`,
      `import ${JSON.stringify(resolve(root, 'styles/vscode-compat.css'))}`,
      `import ${JSON.stringify(resolve(root, 'styles/themes/dark.css'))}`,
      `import ${JSON.stringify(resolve(root, 'styles/themes/blacksphere-plus.css'))}`,
      `import ${JSON.stringify(resolve(root, 'styles/themes/high-contrast.css'))}`,
      `import ${JSON.stringify(resolve(root, 'styles/app.css'))}`,
      `import ${JSON.stringify(resolve(root, 'styles/navigation-rail.css'))}`,
      `import ${JSON.stringify(resolve(root, 'styles/threads-sidebar.css'))}`,
      `import ${JSON.stringify(resolve(root, 'components/profiles/profile-switcher.css'))}`,
      `import ${JSON.stringify(resolve(root, 'styles/polish.css'))}`,
      `import ${JSON.stringify(resolve(root, 'styles/compact-shell.css'))}`,
      `import ${JSON.stringify(resolve(root, 'styles/frameless-shell.css'))}`,
      `import ${JSON.stringify(resolve(root, 'components/filesPanel.css'))}`,
    ].join('\n'))

    await viteBuild({
      configFile: false,
      logLevel: 'silent',
      root,
      plugins: [tailwindcss()],
      build: {
        outDir: join(directory, 'css'),
        emptyOutDir: true,
        cssCodeSplit: false,
        assetsInlineLimit: Number.MAX_SAFE_INTEGER,
        lib: { entry: stylesEntry, formats: ['es'], fileName: 'styles' }
      }
    })

    const cssText = readFileSync(join(directory, 'css', 'styles.css'), 'utf8')
    const userTokensCss = themeTokensCss({ '--surface-strong': '#102619' })
    // A theme asked for "a red background": the frame color, with a panel color beside it.
    const frameTokensCss = themeTokensCss({ '--surface-base': '#200a07', '--surface-strong': '#1c0b09' })

    writeFileSync(join(directory, 'index.html'), `<!doctype html>
<html data-theme="blacksphere-plus">
<head>
<meta charset="utf-8" />
<style>${cssText}</style>
<style>
  * { transition: none !important; animation: none !important; }
  html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
  .app { display: flex; flex-direction: column; width: 100%; height: 100%; }
  .app-content { display: flex; flex: 1; min-height: 0; }
  .navigation-rail { width: 52px; flex: 0 0 52px; }
  .sliding-threads-pane { width: 250px; flex: 0 0 250px; display: flex; }
  .sliding-threads-pane-content { flex: 1; display: flex; min-height: 0; }
  .threads-sidebar { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .threads-sidebar-scroll { flex: 1; min-height: 0; overflow: auto; }
  .app-workspace { flex: 1; display: flex; min-width: 0; min-height: 0; }
  .sidebar { flex: 1; min-width: 0; min-height: 0; }
  .resizer { width: 1px; flex: 0 0 1px; }
  .main-area { width: 430px; flex: 0 0 430px; display: flex; flex-direction: column; min-height: 0; }
  .main-area > :not(.header) { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .panel-toolbar { height: 34px; flex: 0 0 34px; }
  .files-body { flex: 1; display: flex; min-height: 0; }
  .files-sidebar { width: 150px; flex: 0 0 150px; }
</style>
</head>
<body>
<div id="root"><div class="app">
  <div class="titlebar" style="height:40px;flex:0 0 40px;"></div>
  <div class="app-content">
    <nav class="navigation-rail"></nav>
    <div id="pane" class="sliding-threads-pane">
      <div class="sliding-threads-pane-content">
        <aside class="threads-sidebar" data-mousse="sidebar">
          <div class="threads-sidebar-scroll" data-more-below="true">
            <div style="height:900px"></div>
          </div>
          <div class="profile-switcher" style="height:44px;flex:0 0 44px;"></div>
        </aside>
      </div>
    </div>
    <div class="app-workspace">
      <section class="sidebar"></section>
      <div class="resizer"></div>
      <main class="main-area" data-mousse="panel">
        <div class="header">
          <div class="main-view-tabs">
            <button class="main-view-tab active">Files</button>
          </div>
        </div>
        <div class="files-panel">
          <div class="panel-toolbar"></div>
          <div class="files-body"><div class="files-sidebar"></div></div>
        </div>
      </main>
    </div>
  </div>
</div></div>
</body>
</html>`)

    writeFileSync(join(directory, 'themes.json'), JSON.stringify({ userTokensCss, frameTokensCss }))

    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_FRAMELESS_DIR: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, ['tests/fixtures/frameless-shell/main.mjs'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', (bytes) => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', (bytes) => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)

    const evidence = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as Evidence

    // 1. User theme with --surface-strong tints the docked sidebar, feathers its edges to the window canvas, keeps the
    //    profile switcher flush at the bottom, and uses a mask instead of a solid painted fade over the sidebar.
    expect(evidence.userTheme.sidebarBg).toBe('rgb(16, 38, 25)')
    expect(evidence.userTheme.sidebarIsolation).toBe('isolate')
    expect(evidence.userTheme.sidebarBeforeZ).toBe('-1')
    expect(evidence.userTheme.sidebarScrollMask).toContain('linear-gradient')
    expect(evidence.userTheme.sidebarAfterContent).toBe('none')
    expect(evidence.userTheme.profileBottomGap).toBe(0)
    expect(evidence.userTheme.pixels.sidebarCenter).toEqual([16, 38, 25])
    // Green tint dissolves before meeting the chat pane, titlebar, and bottom corner below the chat card.
    expect(evidence.userTheme.pixels.sidebarRightEdge[1] - evidence.userTheme.pixels.sidebarRightEdge[0]).toBeLessThanOrEqual(4)
    expect(evidence.userTheme.pixels.sidebarTopEdge[1]).toBeLessThanOrEqual(4)
    expect(evidence.userTheme.pixels.belowChatCorner[1]).toBeLessThanOrEqual(4)
    // Scroll-fade zone keeps the tinted backdrop rather than painting a black stripe.
    expect(evidence.userTheme.pixels.scrollFadeCenter).toEqual([16, 38, 25])

    // 2. Right panel follows BotSidePanel: transparent floating tabs above a 12px rounded overflow:clip specular card
    //    aligned with the chat card's 8px right/bottom frame, with transparent interior toolbars/sidebars.
    expect(evidence.userTheme.mainHeaderBg).toBe('rgba(0, 0, 0, 0)')
    expect(evidence.userTheme.mainHeaderBorderBottom).toBe('0px')
    expect(evidence.userTheme.mainCardRadius).toBe('12px')
    expect(evidence.userTheme.mainCardOverflow).toBe('clip')
    expect(evidence.userTheme.mainCardAfterContent).toBe('""')
    expect(evidence.userTheme.toolbarBg).toBe('rgba(0, 0, 0, 0)')
    expect(evidence.userTheme.filesSidebarBg).toBe('rgba(0, 0, 0, 0)')
    expect(evidence.userTheme.cardBottomGap).toBe(evidence.userTheme.chatBottomGap)
    expect(evidence.userTheme.cardRightGap).toBe(8)

    // 3. Built-in solid themes avoid whole-scroller GPU masks and keep the painted ::after fade.
    expect(evidence.builtInDark.sidebarScrollMask).toBe('none')
    expect(evidence.builtInDark.sidebarAfterContent).toBe('""')

    // 4. High-contrast and the hover-peek overlay drawer stay crisp and unfeathered.
    expect(evidence.highContrast.sidebarIsolation).toBe('auto')
    expect(evidence.highContrast.sidebarBeforeContent).toBe('none')
    expect(evidence.overlayDrawer.sidebarIsolation).toBe('auto')
    expect(evidence.overlayDrawer.sidebarBeforeContent).toBe('none')
    expect(evidence.overlayDrawer.pixels.sidebarRightEdge[1] - evidence.overlayDrawer.pixels.sidebarRightEdge[0]).toBeGreaterThanOrEqual(15)

    // 5. A theme's background (--surface-base) is the whole frame in one color, over Mousse Dark's own inline frame
    //    colors: the title bar, the rail, the sidebar and the edges around the chat and panel cards.
    const frame: Rgb = [32, 10, 7]
    const near = (pixel: Rgb) => pixel.every((value, index) => Math.abs(value - frame[index]!) <= 2)
    const pixels = evidence.frameColor.pixels
    expect({ titlebar: near(pixels.titlebarCenter), rail: near(pixels.railCenter), sidebar: near(pixels.sidebarCenter), belowChat: near(pixels.belowChatCorner), rightOfCard: near(pixels.rightOfCard) }, JSON.stringify(pixels))
      .toEqual({ titlebar: true, rail: true, sidebar: true, belowChat: true, rightOfCard: true })
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) {
      throw new Error('Unexpected frameless shell test cleanup path')
    }
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 60000)
