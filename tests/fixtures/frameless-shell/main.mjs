import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'

const dir = process.env.MOUSSE_FRAMELESS_DIR
const { userTokensCss, frameTokensCss } = JSON.parse(fs.readFileSync(path.join(dir, 'themes.json'), 'utf8'))

app.setPath('userData', path.join(dir, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    show: false,
    backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false }
  })
  await win.loadFile(path.join(dir, 'index.html'))

  const measure = async (setupCode) => {
    await win.webContents.executeJavaScript(`(() => { ${setupCode} })()`)
    await win.webContents.executeJavaScript('new Promise(r => setTimeout(r, 80))')
    const info = await win.webContents.executeJavaScript(`(() => {
      const sb = document.querySelector('.threads-sidebar')
      const scroll = document.querySelector('.threads-sidebar-scroll')
      const prof = document.querySelector('.profile-switcher')
      const chat = document.querySelector('.sidebar')
      const header = document.querySelector('.main-area > .header')
      const card = document.querySelector('.main-area > :not(.header)')
      const toolbar = document.querySelector('.panel-toolbar')
      const filesSb = document.querySelector('.files-sidebar')
      const sbCs = getComputedStyle(sb)
      const sbBefore = getComputedStyle(sb, '::before')
      const sbAfter = getComputedStyle(sb, '::after')
      const scrollCs = getComputedStyle(scroll)
      const headerCs = getComputedStyle(header)
      const cardCs = getComputedStyle(card)
      const cardAfter = getComputedStyle(card, '::after')
      return {
        vw: window.innerWidth,
        vh: window.innerHeight,
        sbRect: sb.getBoundingClientRect().toJSON(),
        scrollRect: scroll.getBoundingClientRect().toJSON(),
        profRect: prof.getBoundingClientRect().toJSON(),
        chatRect: chat.getBoundingClientRect().toJSON(),
        cardRect: card.getBoundingClientRect().toJSON(),
        titlebarRect: document.querySelector('.titlebar').getBoundingClientRect().toJSON(),
        railRect: document.querySelector('.navigation-rail').getBoundingClientRect().toJSON(),
        sidebarBg: sbCs.backgroundColor,
        sidebarIsolation: sbCs.isolation,
        sidebarBeforeContent: sbBefore.content,
        sidebarBeforeZ: sbBefore.zIndex,
        sidebarScrollMask: scrollCs.maskImage || scrollCs.webkitMaskImage,
        sidebarAfterContent: sbAfter.content,
        mainHeaderBg: headerCs.backgroundColor,
        mainHeaderBorderBottom: headerCs.borderBottomWidth,
        mainCardRadius: cardCs.borderRadius,
        mainCardOverflow: cardCs.overflow,
        mainCardAfterContent: cardAfter.content,
        toolbarBg: getComputedStyle(toolbar).backgroundColor,
        filesSidebarBg: getComputedStyle(filesSb).backgroundColor
      }
    })()`)

    const img = await win.webContents.capturePage()
    const bmp = img.toBitmap()
    const { width, height } = img.getSize()
    const sx = width / info.vw
    const sy = height / info.vh
    const px = (x, y) => {
      const ix = Math.min(width - 1, Math.max(0, Math.round(x * sx)))
      const iy = Math.min(height - 1, Math.max(0, Math.round(y * sy)))
      const i = (iy * width + ix) * 4
      return [bmp[i + 2], bmp[i + 1], bmp[i]]
    }
    const r = info.sbRect
    return {
      sidebarBg: info.sidebarBg,
      sidebarIsolation: info.sidebarIsolation,
      sidebarBeforeContent: info.sidebarBeforeContent,
      sidebarBeforeZ: info.sidebarBeforeZ,
      sidebarScrollMask: info.sidebarScrollMask,
      sidebarAfterContent: info.sidebarAfterContent,
      mainHeaderBg: info.mainHeaderBg,
      mainHeaderBorderBottom: info.mainHeaderBorderBottom,
      mainCardRadius: info.mainCardRadius,
      mainCardOverflow: info.mainCardOverflow,
      mainCardAfterContent: info.mainCardAfterContent,
      toolbarBg: info.toolbarBg,
      filesSidebarBg: info.filesSidebarBg,
      profileBottomGap: Math.round(info.vh - info.profRect.bottom),
      chatBottomGap: Math.round(info.vh - info.chatRect.bottom),
      cardBottomGap: Math.round(info.vh - info.cardRect.bottom),
      cardRightGap: Math.round(info.vw - info.cardRect.right),
      pixels: {
        sidebarCenter: px(r.x + r.width / 2, r.y + r.height / 2),
        sidebarRightEdge: px(r.right - 1, r.y + r.height / 2),
        sidebarTopEdge: px(r.x + r.width / 2, r.y),
        belowChatCorner: px(r.right - 2, info.chatRect.bottom + 4),
        scrollFadeCenter: px(r.x + r.width / 2, info.scrollRect.bottom - 4),
        titlebarCenter: px(info.vw / 2, info.titlebarRect.y + info.titlebarRect.height / 2),
        railCenter: px(info.railRect.x + info.railRect.width / 2, info.railRect.y + info.railRect.height / 2),
        rightOfCard: px(info.cardRect.right + 4, info.cardRect.y + info.cardRect.height / 2)
      }
    }
  }

  const evidence = {
    userTheme: await measure(`
      document.documentElement.setAttribute('data-theme', 'blacksphere-plus')
      document.documentElement.setAttribute('data-user-theme', 'emerald')
      document.documentElement.style.setProperty('--vscode-sideBar-background', '#000000')
      document.documentElement.style.setProperty('--surface-base', '#000000')
      document.getElementById('pane').className = 'sliding-threads-pane'
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(${JSON.stringify(userTokensCss)})
      document.adoptedStyleSheets = [sheet]
    `),
    builtInDark: await measure(`
      document.documentElement.setAttribute('data-theme', 'blacksphere-plus')
      document.documentElement.removeAttribute('data-user-theme')
      document.documentElement.style.setProperty('--vscode-sideBar-background', '#000000')
      document.documentElement.style.setProperty('--surface-base', '#000000')
      document.getElementById('pane').className = 'sliding-threads-pane'
      document.adoptedStyleSheets = []
    `),
    highContrast: await measure(`
      document.documentElement.setAttribute('data-theme', 'high-contrast')
      document.documentElement.removeAttribute('data-user-theme')
      document.documentElement.style.removeProperty('--vscode-sideBar-background')
      document.documentElement.style.removeProperty('--surface-base')
      document.getElementById('pane').className = 'sliding-threads-pane'
      document.adoptedStyleSheets = []
    `),
    overlayDrawer: await measure(`
      document.documentElement.setAttribute('data-theme', 'blacksphere-plus')
      document.documentElement.setAttribute('data-user-theme', 'emerald')
      document.documentElement.style.setProperty('--vscode-sideBar-background', '#000000')
      document.documentElement.style.setProperty('--surface-base', '#000000')
      document.getElementById('pane').className = 'sliding-threads-pane sliding-threads-pane--overlay'
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(${JSON.stringify(userTokensCss)})
      document.adoptedStyleSheets = [sheet]
    `),
    frameColor: await measure(`
      document.documentElement.setAttribute('data-theme', 'blacksphere-plus')
      document.documentElement.setAttribute('data-user-theme', 'ember')
      for (const name of ['--vscode-sideBar-background', '--vscode-titleBar-activeBackground', '--vscode-activityBar-background', '--surface-base']) document.documentElement.style.setProperty(name, '#000000')
      document.getElementById('pane').className = 'sliding-threads-pane'
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(${JSON.stringify(frameTokensCss)})
      document.adoptedStyleSheets = [sheet]
    `)
  }

  fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2))
  win.destroy()
  app.exit(0)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
