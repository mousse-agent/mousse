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
    catch (error) { throw new Error(`Renderer script failed: ${code}; ${String(error)}; ${rendererErrors.join(';')}`, { cause: error }) }
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

    // Leaves following the end the way a person does (a trusted wheel), after any correction of ours has aged out.
    const leaveEnd = async () => {
      await delay(300)
      await wheel(-120)
      await delay(200)
    }

    // 1. A long thread opens at the bottom and mounts only the rows around it, however long it is.
    // Mount time is reported, not asserted: wall-clock is noise on shared CI. What it follows from, how much
    // is mounted, is asserted instead.
    const small = { mountMs: await execute<number>('qa.mount(100)') } as Record<string, number>
    small.messages = await execute<number>('qa.messageCount()')
    small.mounted = await execute<number>('qa.mountedTurns()')
    small.domNodes = await execute<number>('qa.domNodes()')
    small.textLength = await execute<number>('qa.textLength()')
    const large = { mountMs: await execute<number>('qa.mount(1000)') } as Record<string, number>
    await delay(300)
    await execute('qa.frames(3)')
    large.messages = await execute<number>('qa.messageCount()')
    large.mounted = await execute<number>('qa.mountedTurns()')
    large.domNodes = await execute<number>('qa.domNodes()')
    large.textLength = await execute<number>('qa.textLength()')
    large.heapMB = await execute<number>('qa.heapMB()')
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
    // Take the filler back out (shrinking above the reader is held just the same): later steps read plain rows.
    for (const row of [hold.row - 1, hold.row, hold.row + 1]) await execute(`qa.growRow(${row}, 0)`)
    await execute('qa.frames(4)')

    // Scrolling by hand through rows whose estimates are far off: up, then down.
    const up = await execute('qa.sweep(-120, 60, 10)')
    const down = await execute('qa.sweep(120, 40, 300)')
    const afterSweeps = await execute('({ mounted: qa.mountedTurns(), first: qa.isMounted(0), last: qa.isMounted(999) })')

    // A fenced block above the reading line gets taller (a late syntax pass, a placeholder that expands): the line holds.
    // Turn 503 starts above the top edge, so the turn before it (with the fenced block) is wholly out of view.
    await execute('qa.goToRow(503, -60)')
    await execute('qa.frames(4)')
    const codeHold = await execute<{ text: string; top: number; codeRow: number }>(`(() => {
      const sentinel = qa.pickSentinel(40)
      return { text: sentinel.text, top: sentinel.top, codeRow: qa.codeRowAbove(503) }
    })()`)
    const codeSentinelTop = () => execute<number>(`qa.targetTop(${JSON.stringify(codeHold.text)})`)
    const codeGrowth = { start: await codeSentinelTop(), scrollTop: await scrollTop() } as Record<string, number>
    await execute(`qa.growCodeBlock(${codeHold.codeRow}, 'last', 350)`)
    await execute('qa.frames(3)')
    codeGrowth.afterLast = await codeSentinelTop()
    await execute(`qa.growCodeBlock(${codeHold.codeRow}, 'first', 600)`)
    await execute('qa.frames(3)')
    codeGrowth.afterFirst = await codeSentinelTop()
    codeGrowth.scrollTopMoved = (await scrollTop()) - codeGrowth.scrollTop!

    // 3b. A group of tool calls opens above the reading line, in the very turn being read: what is read holds still.
    const sentinelOf = (text: string) => execute<number | null>(`qa.targetTop(${JSON.stringify(text)})`)
    await execute('qa.goToRow(400, 0)')
    await execute('qa.frames(4)')
    await execute("qa.placeSentinel('anchor-paragraph-3', 100)")
    await execute('qa.frames(5)')
    const toolCards = { groups: await execute<number>('qa.groupCount(400)') } as Record<string, number | null>
    toolCards.firstGroupTop = await execute<number | null>("qa.groupTop(400, 'first')")
    toolCards.secondGroupTop = await execute<number | null>("qa.groupTop(400, 'second')")
    toolCards.start = await sentinelOf('anchor-paragraph-3')
    toolCards.startScrollTop = await scrollTop()
    toolCards.rowHeight = await execute<number>('qa.rowHeight(400)')
    await execute("qa.toggleGroup(400, 'first')")
    await execute('qa.frames(5)')
    toolCards.afterOpenFirst = await sentinelOf('anchor-paragraph-3')
    toolCards.openGrowth = (await execute<number>('qa.rowHeight(400)')) - (toolCards.rowHeight as number)
    toolCards.openScrolled = (await scrollTop()) - (toolCards.startScrollTop as number)
    // The second group is below the reading line: nothing moves.
    const beforeSecond = await scrollTop()
    await execute("qa.toggleGroup(400, 'second')")
    await execute('qa.frames(5)')
    toolCards.afterOpenSecond = await sentinelOf('anchor-paragraph-3')
    toolCards.secondScrollTopDelta = (await scrollTop()) - beforeSecond
    await execute("qa.toggleGroup(400, 'first')")
    await execute('qa.frames(5)')
    toolCards.afterCloseFirst = await sentinelOf('anchor-paragraph-3')

    // 3c. Inside a block quote taller than the viewport: a fenced block above the reading line grows, the quote straddles the edge.
    await execute('qa.goToRow(450, 0)')
    await execute('qa.frames(4)')
    await execute("qa.placeSentinel('quote-paragraph-3', 100)")
    await execute('qa.frames(5)')
    const nested = await execute<Record<string, unknown>>(`(() => {
      const edge = document.querySelector('.an-message-list').getBoundingClientRect().top
      const quote = document.querySelector('[data-turn-key="u-450"] blockquote').getBoundingClientRect()
      return { quoteTop: quote.top - edge, quoteBottom: quote.bottom - edge, start: qa.targetTop('quote-paragraph-3'), blocks: qa.codeBlocks(450) }
    })()`)
    const nestedScrollTop = await scrollTop()
    await execute("qa.growCodeBlock(450, 'first', 300)")
    await execute('qa.frames(4)')
    nested.afterFirst = await sentinelOf('quote-paragraph-3')
    nested.firstScrolled = (await scrollTop()) - nestedScrollTop
    const nestedBefore = await scrollTop()
    await execute("qa.growCodeBlock(450, 'last', 300)")
    await execute('qa.frames(4)')
    nested.afterLast = await sentinelOf('quote-paragraph-3')
    nested.lastScrollTopDelta = (await scrollTop()) - nestedBefore

    // 3d. The 300,000-character thought stays collapsed (none of it is mounted) and the 300-row table is one very tall row.
    await execute('qa.goToRow(700, 0)')
    await execute('qa.frames(4)')
    const thinking = await execute<Record<string, number>>('({ mounted: qa.isMounted(700) ? 1 : 0, rowHeight: qa.rowHeight(700), textLength: qa.textLength(), turns: qa.mountedTurns() })')
    await execute('qa.goToRow(650, 0)')
    await execute('qa.frames(4)')
    const table = await execute<Record<string, number>>('({ mounted: qa.isMounted(650) ? 1 : 0, rowHeight: qa.rowHeight(650), turns: qa.mountedTurns(), first: qa.isMounted(0) ? 1 : 0, last: qa.isMounted(999) ? 1 : 0 })')

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

    // 4b. Streaming while the reader is elsewhere: far up in the thread, then inside the very answer that is growing.
    await leaveEnd()
    await execute('qa.goToRow(250, 0)')
    await execute('qa.frames(4)')
    const farSentinel = await execute<{ text: string; top: number }>('qa.pickSentinel(100)')
    const streamFar = await execute(`qa.streamRun(40, ${JSON.stringify(farSentinel.text)})`)
    // A new turn with a tall answer arrives; the reader walks into it and stops in the middle of that answer.
    await execute('qa.addTurn(true)')
    await waitFrames('qa.endGap() < 2', 60)
    await leaveEnd()
    await execute('qa.goToRow(qa.lastTurn(), 0)')
    await execute('qa.frames(3)')
    const lastSentinel = `anchor-${await execute<number>('qa.lastTurn()')}-2`
    await execute(`qa.placeSentinel(${JSON.stringify(lastSentinel)}, 120)`)
    await execute('qa.frames(4)')
    const streamInside = await execute(`qa.streamRun(30, ${JSON.stringify(lastSentinel)})`)
    await execute('qa.jumpVisible() ? qa.clickJump() : qa.scrollTo(qa.scrollHeight())')
    await waitFrames('qa.endGap() < 2', 60)
    await delay(300)
    await execute('qa.frames(3)')

    // 5. A new turn while following keeps the end in view.
    await execute('qa.addTurn()')
    const turnFrames = await waitFrames('qa.endGap() < 2 && qa.isMounted(1001)', 60)
    const afterTurn = await execute<{ gap: number; mounted: number; range: { first: number; last: number } }>('({ gap: qa.endGap(), mounted: qa.mountedTurns(), range: qa.mountedRange() })')

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

    // A scripted scroll across the thread, giant rows included: the longest gap between frames is reported, never asserted.
    const longestFrameMs = await execute<number>('qa.scriptedScroll(40, 14000)')
    const afterScripted = await execute('({ mounted: qa.mountedTurns(), first: qa.isMounted(0), last: qa.isMounted(qa.lastTurn()) })')

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

    // 7b. Find inside a 5,000-line fenced block (first line, a 400-column line, last line) in a turn that is not mounted:
    // the block's own scroller is moved so the match shows inside it and inside the transcript, in both directions and around the ends.
    await execute('qa.openFind()')
    await waitFrames('qa.findFocused()', 30)
    await execute('qa.setFindQuery("needle-fence")')
    await waitFrames('/ of 3$/.test(qa.findCount() ?? "")', 150)
    for (let step = 0; step < 4 && (await execute<string>('qa.findCount()')) !== '1 of 3'; step += 1) await pressKey('Enter')
    const fenceLanded = (count: string) =>
      `qa.findCount() === ${JSON.stringify(count)} && qa.activeInView() && (() => { const g = qa.activeGeometry(); return g !== null && g.inContainer && g.body !== null && g.body.inside })()`
    const fenceVisits: Record<string, unknown>[] = []
    const visitFence = async (count: string) => {
      const waited = await waitFrames(fenceLanded(count), 200)
      await execute('qa.frames(3)')
      fenceVisits.push({
        count, waited, match: await execute('qa.activeMatch()'), geometry: await execute('qa.activeGeometry()'),
        turns: await execute('qa.mountedTurns()'), fence: await execute('qa.codeBlocks(600)'),
      })
    }
    await visitFence('1 of 3')
    for (const count of ['2 of 3', '3 of 3', '1 of 3']) {
      await pressKey('Enter')
      await visitFence(count)
    }
    for (const count of ['3 of 3', '2 of 3', '1 of 3']) {
      await pressKey('Enter', { shift: true })
      await visitFence(count)
    }
    // The table has no scroller of its own that matters here: the match is in its first and its 300th row.
    await execute('qa.setFindQuery("needle-table")')
    await waitFrames('/ of 2$/.test(qa.findCount() ?? "")', 150)
    for (let step = 0; step < 3 && (await execute<string>('qa.findCount()')) !== '1 of 2'; step += 1) await pressKey('Enter')
    const tableLanded = (count: string) => `qa.findCount() === ${JSON.stringify(count)} && qa.activeInView() && qa.activeMatch().turn === "u-650"`
    const tableVisits: Record<string, unknown>[] = []
    const visitTable = async (count: string) => {
      const waited = await waitFrames(tableLanded(count), 200)
      await execute('qa.frames(3)')
      tableVisits.push({ count, waited, match: await execute('qa.activeMatch()'), geometry: await execute('qa.activeGeometry()'), turns: await execute('qa.mountedTurns()') })
    }
    await visitTable('1 of 2')
    await pressKey('Enter')
    await visitTable('2 of 2')
    await pressKey('Enter', { shift: true })
    await visitTable('1 of 2')
    await pressKey('Escape')
    await execute('qa.frames(3)')
    const innerClosed = await execute('({ open: qa.findOpen(), highlights: qa.highlightCount() })')

    // 8. Short threads render every row and Chromium's own anchoring holds the reading line; the thread that grows past 40 turns switches over.
    await execute('qa.mount(10)')
    await delay(300)
    await execute('qa.frames(3)')
    const ten = await execute<Record<string, unknown>>('({ windowed: qa.windowed(), mounted: qa.mountedTurns(), spacers: qa.spacers(), overflow: qa.scrollHeight() - qa.clientHeight() })')
    await wheel(-120)
    await execute('qa.scrollTo(0.6 * (qa.scrollHeight() - qa.clientHeight()))')
    await delay(200)
    await execute('qa.frames(4)')
    const tenHold = await execute<{ text: string; row: number; top: number }>(`(() => {
      const sentinel = qa.pickSentinel(120)
      return { text: sentinel.text, row: qa.rowIndexOf(sentinel.text), top: sentinel.top }
    })()`)
    await execute(`qa.growRow(${tenHold.row - 1}, 400)`)
    await execute('qa.frames(4)')
    ten.start = tenHold.top
    ten.afterGrowth = await execute<number>(`qa.targetTop(${JSON.stringify(tenHold.text)})`)
    ten.row = tenHold.row
    await execute('qa.mount(40)')
    await execute('qa.frames(3)')
    const small40 = await execute('({ windowed: qa.windowed(), mounted: qa.mountedTurns(), spacers: qa.spacers() })')
    await execute('qa.addTurn()')
    await execute('qa.frames(6)')
    const grown = await execute('({ windowed: qa.windowed(), mounted: qa.mountedTurns(), gap: qa.endGap() })')

    await execute('qa.unmount()')
    await delay(50)
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({
      small, large, opened, positions, hold, held, codeHold, codeGrowth, up, down, afterSweeps, toolCards, nested, thinking, table,
      followGaps, leftEnd, readingAfterStream, jumpFrames, jumped, streamFar, farSentinel, streamInside, turnFrames, afterTurn,
      markerFrames, marker, interrupted, longestFrameMs, afterScripted, ten, small40, grown,
      find: {
        opened: findOpened, focusFrames: findFocusFrames, farFrames: findFarFrames, far: findFar, manyFrames: findManyFrames, many: findMany,
        last: findLast, wrapFrames: findWrapFrames, wrapped: findWrapped, backFrames: findBackFrames, back: findBack, closed: findClosed,
        fence: fenceVisits, table: tableVisits, innerClosed,
      },
      pageErrors: await execute('qa.errors()').catch(() => []), rendererErrors,
    }))
  } finally {
    window.destroy()
    server.close()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
