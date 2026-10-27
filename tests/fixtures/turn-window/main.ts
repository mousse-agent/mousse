import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_TURN_WINDOW_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 150000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

async function main() {
  await app.whenReady()
  app.dock?.hide()
  const server = createServer((request, response) => {
    const assets: Record<string, string> = { '/entry.js': 'entry.js', '/entry.css': 'entry.css', '/styles.css': 'css/styles.css' }
    const asset = assets[request.url ?? '']
    response.setHeader('Content-Type', asset?.endsWith('.js') ? 'application/javascript' : asset?.endsWith('.css') ? 'text/css' : 'text/html')
    response.end(asset ? readFileSync(join(directory, asset)) : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/entry.css"><style>body{margin:0}</style><div id="root"></div><script src="/entry.js"></script>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message) })
  const execute = async <T,>(code: string): Promise<T> => {
    try { return await window.webContents.executeJavaScript(code) }
    catch (error) { throw new Error(`Renderer script failed: ${code}; ${rendererErrors.join(';')}`, { cause: error }) }
  }
  window.webContents.debugger.attach('1.3')
  // A trusted wheel over the transcript (DevTools input): the page really scrolls and the intent listeners fire.
  const wheel = async (deltaY: number) => {
    const { x, y } = await execute<{ x: number; y: number }>('qa.center()')
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
    await execute('qa.frames(2)')
  }
  const waitFrames = async (code: string, limit: number): Promise<number> => {
    for (let frame = 0; frame < limit; frame++) {
      if (await execute<boolean>(code)) return frame
      await execute('qa.frames(1)')
    }
    return -1
  }
  try {
    await window.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    for (let index = 0; index < 150 && !(await execute<boolean>('Boolean(window.qa)')); index++) await delay(20)

    // 1. A long thread opens at the bottom and mounts only the rows around it.
    const t200 = await execute<number>('qa.mount(200)')
    const mounted200 = await execute<number>('qa.mountedTurns()')
    const t1000 = await execute<number>('qa.mount(1000)')
    await delay(300)
    await execute('qa.frames(3)')
    const opened = await execute(`({
      mounted: qa.mountedTurns(), range: qa.mountedRange(), windowed: qa.windowed(), spacers: qa.spacers(),
      first: qa.isMounted(0), last: qa.isMounted(999), far: qa.isMounted(500),
      endGap: qa.endGap(), scrollHeight: qa.scrollHeight(), clientHeight: qa.clientHeight(),
    })`)

    // 2. Scrolling moves the window: far turns unmount, the ones in view mount, the ends stay.
    const positions: unknown[] = []
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      await execute(`qa.scrollTo(${fraction} * (qa.scrollHeight() - qa.clientHeight()))`)
      await delay(100)
      await execute('qa.frames(3)')
      positions.push(await execute(`(() => {
        const visible = qa.firstVisibleTurn()
        return {
          fraction: ${fraction}, mounted: qa.mountedTurns(), range: qa.mountedRange(), visible,
          visibleMounted: qa.isMounted(visible), middle: qa.isMounted(500), first: qa.isMounted(0), last: qa.isMounted(999),
          farBelow: qa.isMounted(Math.min(999, visible + 300)), farAbove: qa.isMounted(Math.max(0, visible - 300)),
        }
      })()`))
    }

    // 3. Reading history: the text at the top edge stays put while rows change height around it.
    await execute('qa.scrollTo(0.5 * (qa.scrollHeight() - qa.clientHeight()))')
    await delay(200)
    await execute('qa.frames(4)')
    // The top edge cuts through a paragraph, so the reading point is inside the tall leaf.
    const hold = await execute<{ text: string; row: number; top: number }>(`(() => {
      const sentinel = qa.pickSentinel(120)
      qa.placeEdgeIn(sentinel.text, 0.5)
      return { text: sentinel.text, row: qa.rowIndexOf(sentinel.text), top: sentinel.top }
    })()`)
    await execute('qa.frames(4)')
    const sentinelTop = () => execute<number>(`qa.targetTop(${JSON.stringify(hold.text)})`)
    const scrollTop = () => execute<number>('qa.scrollTop()')
    const held = { start: await sentinelTop(), scrollTop: await scrollTop() } as Record<string, number>
    // Growth in a mounted row above the viewport.
    await execute(`qa.growRow(${hold.row - 1}, 400)`)
    await execute('qa.frames(3)')
    held.afterAbove = await sentinelTop()
    // Growth above the paragraph inside its own row.
    await execute(`qa.growRow(${hold.row}, 300)`)
    await execute('qa.frames(3)')
    held.afterSameRow = await sentinelTop()
    const beforeBelow = await scrollTop()
    // Growth in the row after it changes nothing the reader sees.
    await execute(`qa.growRow(${hold.row + 1}, 500)`)
    await execute('qa.frames(3)')
    held.afterBelow = await sentinelTop()
    held.belowScrollTopDelta = (await scrollTop()) - beforeBelow

    // Scrolling by hand through rows whose estimates are far off: up, then down.
    const up = await execute('qa.sweep(-120, 60, 10)')
    const down = await execute('qa.sweep(120, 40, 300)')
    const afterSweeps = await execute('({ mounted: qa.mountedTurns(), first: qa.isMounted(0), last: qa.isMounted(999) })')

    // 4. Following the end, leaving it by wheel, and Jump to latest.
    // Let the hand-scroll corrections age out: a scroll within 150 ms of one of ours is not read as the user's.
    await delay(300)
    await execute('qa.scrollTo(qa.scrollHeight())')
    await delay(300)
    await execute('qa.frames(4)')
    const followGaps: number[] = []
    for (let index = 0; index < 20; index++) {
      await execute(`qa.streamAppend(${JSON.stringify(` streamed text ${index} that keeps the answer growing line after line while the reader follows it.`)})`)
      await execute('qa.frames(1)')
      followGaps.push(await execute<number>('qa.endGap()'))
    }
    await wheel(-300)
    await execute('qa.frames(3)')
    const leftEnd = await execute<Record<string, unknown>>(`({ scrollTop: qa.scrollTop(), jumpVisible: qa.jumpVisible(), gap: qa.endGap() })`)
    const leftSentinel = await execute<{ text: string; top: number }>('qa.pickSentinel(100)')
    for (let index = 0; index < 10; index++) {
      await execute(`qa.streamAppend(${JSON.stringify(` more streamed text ${index} while the reader is somewhere else in the thread.`)})`)
      await execute('qa.frames(1)')
    }
    const readingAfterStream = {
      scrollTop: await scrollTop(), top: await execute<number>(`qa.targetTop(${JSON.stringify(leftSentinel.text)})`),
      startTop: leftSentinel.top, startScrollTop: leftEnd.scrollTop,
    }
    await execute('qa.clickJump()')
    const jumpFrames = await waitFrames('qa.endGap() < 2', 60)
    await execute('qa.frames(4)')
    const jumped = await execute(`({ gap: qa.endGap(), jumpVisible: qa.jumpVisible(), mounted: qa.mountedTurns(), last: qa.isMounted(999) })`)

    // 5. A new turn while following keeps the end in view.
    await execute('qa.addTurn()')
    const turnFrames = await waitFrames('qa.endGap() < 2 && qa.isMounted(1000)', 60)
    const afterTurn = await execute('({ gap: qa.endGap(), mounted: qa.mountedTurns(), range: qa.mountedRange() })')

    // 6. Marker jumps land on the prompt, even when it was not mounted, and a wheel cancels one.
    await execute('qa.markerClick(100)')
    const markerFrames = await waitFrames('qa.promptTop(100) !== null && Math.abs(qa.promptTop(100) - 16) <= 2', 80)
    await execute('qa.frames(3)')
    const marker = await execute(`({ top: qa.promptTop(100), mounted: qa.isMounted(100), count: qa.mountedTurns(), gap: qa.endGap() })`)
    await execute('qa.clickJump()')
    await waitFrames('qa.endGap() < 2', 60)
    await execute('qa.frames(3)')
    await execute('qa.markerClick(300)')
    await execute('qa.frames(1)')
    await wheel(-200)
    await execute('qa.frames(3)')
    const interruptedAt = await scrollTop()
    await execute('qa.frames(20)')
    const interrupted = { at: interruptedAt, later: await scrollTop(), top: await execute<number | null>('qa.promptTop(300)') }

    // 7. Find: a match in a turn that is not mounted is found in the message data and landed on, and Enter and Shift+Enter wrap.
    const pressKey = async (name: string, options: { shift?: boolean } = {}) => {
      const base = { key: name, code: name, windowsVirtualKeyCode: name === 'Enter' ? 13 : 27, modifiers: options.shift ? 8 : 0 }
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await execute('qa.frames(2)')
    }
    // The count changes at once; the match is landed on a few frames later.
    const landed = (count: string, turn: number) =>
      `qa.findCount() === ${JSON.stringify(count)} && qa.isMounted(${turn}) && qa.activeMatch() !== null && qa.activeMatch().turn === "u-${turn}" && qa.activeInView()`
    const findState = () => execute('({ count: qa.findCount(), match: qa.activeMatch(), turns: qa.mountedTurns(), last: qa.isMounted(999), endGap: qa.endGap() })')
    await execute('qa.mount(1000)')
    await delay(300)
    await execute('qa.frames(4)')
    const findOpened = await execute<boolean>('qa.openFind()')
    const findFocusFrames = await waitFrames('qa.findFocused()', 30)
    await execute('qa.setFindQuery("anchor-123-0")')
    const findFarFrames = await waitFrames(landed('1 of 1', 123), 150)
    const findFar = await findState()
    // "sentinel-u99" is in turn 99 and turns 990-999: eleven matches, the nearest one below the reader first.
    await execute('qa.setFindQuery("sentinel-u99")')
    const findManyFrames = await waitFrames('/ of 11$/.test(qa.findCount() ?? "") && qa.activeInView()', 150)
    const findMany = await findState()
    for (let step = 0; step < 12; step += 1) {
      if ((await execute<string>('qa.findCount()')) === '11 of 11') break
      await pressKey('Enter')
    }
    await waitFrames(landed('11 of 11', 999), 150)
    const findLast = await findState()
    await pressKey('Enter')
    const findWrapFrames = await waitFrames(landed('1 of 11', 99), 150)
    const findWrapped = await findState()
    await pressKey('Enter', { shift: true })
    const findBackFrames = await waitFrames(landed('11 of 11', 999), 150)
    const findBack = await findState()
    await pressKey('Escape')
    await execute('qa.frames(3)')
    const findClosed = await execute('({ open: qa.findOpen(), highlights: qa.highlightCount() })')

    // 8. Short threads render every row; the thread that grows past 40 turns switches over.
    await execute('qa.mount(40)')
    await execute('qa.frames(3)')
    const small = await execute('({ windowed: qa.windowed(), mounted: qa.mountedTurns(), spacers: qa.spacers() })')
    await execute('qa.addTurn()')
    await execute('qa.frames(6)')
    const grown = await execute('({ windowed: qa.windowed(), mounted: qa.mountedTurns(), gap: qa.endGap() })')

    await execute('qa.unmount()')
    await delay(50)
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({
      t200, t1000, mounted200, opened, positions, hold, held, up, down, afterSweeps, followGaps, leftEnd, readingAfterStream,
      jumpFrames, jumped, turnFrames, afterTurn, markerFrames, marker, interrupted, small, grown,
      find: {
        opened: findOpened, focusFrames: findFocusFrames, farFrames: findFarFrames, far: findFar, manyFrames: findManyFrames, many: findMany,
        last: findLast, wrapFrames: findWrapFrames, wrapped: findWrapped, backFrames: findBackFrames, back: findBack, closed: findClosed,
      },
      pageErrors: await execute('qa.errors()').catch(() => []), rendererErrors,
    }))
  } finally {
    window.destroy()
    server.close()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
