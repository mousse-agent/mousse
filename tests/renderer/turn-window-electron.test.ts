import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'esbuild'
import electron from 'electron'
import { expect, it } from 'vitest'
import { build as viteBuild } from 'vite'

type Mounted = { mountMs: number; messages: number; mounted: number; domNodes: number; textLength: number; heapMB?: number }
type Opened = {
  mounted: number; range: { first: number; last: number }; windowed: boolean; spacers: number
  first: boolean; last: boolean; far: boolean; endGap: number; scrollHeight: number; clientHeight: number
}
type Position = {
  fraction: number; mounted: number; range: { first: number; last: number }; visible: number; visibleMounted: boolean; middle: boolean
  first: boolean; last: boolean; farBelow: boolean; farAbove: boolean
}
type Sweep = { drift: number[]; tailDrift: number[]; scrollHeightDelta: number }
type ActiveMatch = { top: number; bottom: number; text: string; viewport: number; turn: string | null }
type Geometry = {
  inContainer: boolean
  body: { inside: boolean; scrollTop: number; scrollLeft: number; scrollHeight: number; clientHeight: number } | null
}
type CodeBlocks = { rowHeight: number; bodies: { clientHeight: number; scrollHeight: number; scrollWidth: number; clientWidth: number }[] }
type FindState = { count: string | null; match: ActiveMatch | null; turns: number; last: boolean; endGap: number }
type Streamed = {
  start: { top: number | null; scrollTop: number; gap: number }
  samples: { top: number | null; scrollTop: number; mounted: number }[]
  endGap: number; jumpVisible: boolean
}
type Evidence = {
  small: Mounted; large: Mounted; opened: Opened; positions: Position[]
  hold: { text: string; row: number; top: number }
  held: { start: number; scrollTop: number; afterAbove: number; afterSameRow: number; afterBelow: number; belowScrollTopDelta: number }
  codeHold: { text: string; top: number; codeRow: number }
  codeGrowth: { start: number; scrollTop: number; afterLast: number; afterFirst: number; scrollTopMoved: number }
  up: Sweep; down: Sweep; afterSweeps: { mounted: number; first: boolean; last: boolean }
  toolCards: {
    groups: number; firstGroupTop: number; secondGroupTop: number; start: number; startScrollTop: number; rowHeight: number
    afterOpenFirst: number; openGrowth: number; openScrolled: number; afterOpenSecond: number; secondScrollTopDelta: number; afterCloseFirst: number
  }
  nested: {
    quoteTop: number; quoteBottom: number; start: number; blocks: CodeBlocks
    afterFirst: number; firstScrolled: number; afterLast: number; lastScrollTopDelta: number
  }
  thinking: { mounted: number; rowHeight: number; textLength: number; turns: number }
  table: { mounted: number; rowHeight: number; turns: number; first: number; last: number }
  followGaps: number[]; leftEnd: { scrollTop: number; jumpVisible: boolean; gap: number }
  readingAfterStream: { scrollTop: number; top: number; startTop: number; startScrollTop: number }
  jumpFrames: number; jumped: { gap: number; jumpVisible: boolean; mounted: number; last: boolean }
  farSentinel: { text: string; top: number }; streamFar: Streamed; streamInside: Streamed
  turnFrames: number; afterTurn: { gap: number; mounted: number; range: { first: number; last: number } }
  markerFrames: number; marker: { top: number; mounted: boolean; count: number }
  interrupted: { at: number; later: number; top: number | null }
  longestFrameMs: number; afterScripted: { mounted: number; first: boolean; last: boolean }
  ten: { windowed: boolean; mounted: number; spacers: number; overflow: number; start: number; afterGrowth: number; row: number }
  small40: { windowed: boolean; mounted: number; spacers: number }; grown: { windowed: boolean; mounted: number; gap: number }
  find: {
    opened: boolean; focusFrames: number; farFrames: number; far: FindState; manyFrames: number; many: FindState
    last: FindState; wrapFrames: number; wrapped: FindState; backFrames: number; back: FindState
    closed: { open: boolean; highlights: number }
    fence: { count: string; waited: number; match: ActiveMatch | null; geometry: Geometry | null; turns: number; fence: CodeBlocks }[]
    table: { count: string; waited: number; match: ActiveMatch | null; geometry: Geometry | null; turns: number }[]
    innerClosed: { open: boolean; highlights: number }
  }
  pageErrors: string[]; rendererErrors: string[]
}

/** The match is painted inside the transcript's visible area. */
const inView = (match: ActiveMatch | null) => Boolean(match && match.top >= 0 && match.bottom <= match.viewport)
/** Two positions, in px, are the same place to the eye. */
const within = (a: number | null, b: number, tolerance = 2) => a !== null && Math.abs(a - b) <= tolerance

it('mounts only the turns near the viewport of a long thread and holds the reading line while it scrolls and grows', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-turn-window-'))
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  try {
    // The list's layout is Tailwind utilities (`flex`, `gap-6`, `overflow-y-auto`): compile them as the renderer build does.
    await viteBuild({ configFile: false, logLevel: 'silent', root: resolve('src/renderer'), plugins: [tailwindcss()], build: { outDir: join(directory, 'css'), emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, lib: { entry: resolve('tests/fixtures/turn-window/styles.ts'), formats: ['es'], fileName: 'styles' } } })
    await build({ entryPoints: [resolve('tests/fixtures/turn-window/entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } })
    await build({ entryPoints: [resolve('tests/fixtures/turn-window/main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_TURN_WINDOW_DIRECTORY: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron as unknown as string, [join(directory, 'main.mjs')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    child.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-32768) })
    exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
    expect(await exited, output).toBe(0)
    const result = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) as Evidence
    // Timings and sizes are reported for people to compare; only counts and positions are asserted, since wall-clock
    // time on a shared runner says more about the runner than the list.
    console.info(
      `turn window: mount ${result.small.messages} messages ${result.small.mountMs.toFixed(0)} ms (${result.small.mounted} rows, ${result.small.domNodes} nodes), ` +
      `${result.large.messages} messages ${result.large.mountMs.toFixed(0)} ms (${result.large.mounted} rows, ${result.large.domNodes} nodes, heap ${result.large.heapMB?.toFixed(0)} MB), ` +
      `time ratio ${(result.large.mountMs / result.small.mountMs).toFixed(2)}, longest frame of a scripted scroll ${result.longestFrameMs.toFixed(0)} ms`,
    )
    // The largest jump of the reading line while only the toolbar of the row above it was at the top edge (asserted below).
    const tail = [...result.up.tailDrift, ...result.down.tailDrift].map(Math.abs)
    console.info(`turn window: reading-line jump with only a row tail at the top edge: ${tail.length} samples, largest ${Math.max(0, ...tail).toFixed(0)} px`)

    expect(result.rendererErrors).toEqual([])
    expect(result.pageErrors).toEqual([])

    // A thread of 2,000+ messages mounts a handful of rows like one of 200, never more than 60, the first and last among them,
    // so the DOM (and with it the mount work) is bounded whatever the thread length.
    expect(result.small.messages).toBeGreaterThanOrEqual(200)
    expect(result.large.messages).toBeGreaterThanOrEqual(2000)
    expect(result.small.mounted).toBeLessThanOrEqual(60)
    expect(result.large.mounted).toBeLessThanOrEqual(60)
    // (An absolute bound rather than a ratio: which rows sit at the end decides the node count, not the length of the thread.)
    expect(result.large.domNodes).toBeLessThanOrEqual(8000)
    expect(result.large.textLength).toBeLessThanOrEqual(100000)
    expect(result.opened.windowed).toBe(true)
    expect(result.opened.mounted).toBeLessThanOrEqual(60)
    expect(result.opened.first && result.opened.last).toBe(true)
    expect(result.opened.far).toBe(false)
    expect(result.opened.spacers).toBeGreaterThan(0)
    expect(result.opened.endGap).toBeLessThan(2)
    expect(result.opened.scrollHeight).toBeGreaterThan(result.opened.clientHeight * 50)

    // Scrolling moves the window: the turn in view is mounted, turns 300 away are not.
    expect(result.positions).toHaveLength(5)
    for (const position of result.positions) {
      expect(position.mounted, `fraction ${position.fraction}`).toBeLessThanOrEqual(60)
      expect(position.first && position.last, `fraction ${position.fraction}`).toBe(true)
      expect(position.visibleMounted, `fraction ${position.fraction}`).toBe(true)
      if (position.visible > 300 && position.visible < 700) {
        expect(position.farBelow && position.farAbove, `fraction ${position.fraction}`).toBe(false)
      }
    }
    expect(new Set(result.positions.map(position => position.visible)).size).toBe(5)
    // Turn 500 is not mounted with the top of the thread in view. (Halfway down is not turn 500: the 300-row table
    // and the 5,000-line block make the middle of the scroll range land elsewhere, so only the turn in view is checked.)
    expect(result.positions[0]!.middle).toBe(false)
    expect(result.positions[2]!.visible).toBeGreaterThan(200)
    expect(result.positions[2]!.visible).toBeLessThan(800)

    // The paragraph at the reading line stays within 2 px while rows above it grow, in or out of its own row.
    expect(result.hold.row).toBeGreaterThan(0)
    expect(result.held.start).toBeLessThan(0)
    expect(Math.abs(result.held.afterAbove - result.held.start)).toBeLessThanOrEqual(2)
    expect(Math.abs(result.held.afterSameRow - result.held.start)).toBeLessThanOrEqual(2)
    expect(Math.abs(result.held.afterBelow - result.held.start)).toBeLessThanOrEqual(2)
    expect(Math.abs(result.held.belowScrollTopDelta)).toBeLessThanOrEqual(1)

    // So does a fenced block growing above it (a late syntax pass, a placeholder that expands), from its bottom or its top.
    expect(result.codeHold.codeRow).toBeGreaterThanOrEqual(0)
    expect(within(result.codeGrowth.afterLast, result.codeGrowth.start), JSON.stringify([result.codeHold, result.codeGrowth])).toBe(true)
    expect(within(result.codeGrowth.afterFirst, result.codeGrowth.start), JSON.stringify([result.codeHold, result.codeGrowth])).toBe(true)
    expect(result.codeGrowth.scrollTopMoved).toBeGreaterThanOrEqual(500)

    // The user's own motion is the only thing that moves it, through rows measured far from their estimates.
    for (const sweep of [result.up, result.down]) {
      expect(sweep.drift.length).toBeGreaterThanOrEqual(20)
      expect(Math.max(...sweep.drift.map(Math.abs)), sweep.drift.map(value => value.toFixed(0)).join(' ')).toBeLessThanOrEqual(2)
    }
    // Including the steps where only the toolbar at the end of the row above is at the top edge: a block above the toolbar that
    // expands then moves the toolbar, and the reading line goes with it.
    expect(tail.length).toBeGreaterThan(0)
    expect(Math.max(...tail), tail.map(value => value.toFixed(0)).join(' ')).toBeLessThanOrEqual(2)
    expect(result.up.scrollHeightDelta + result.down.scrollHeightDelta).toBeGreaterThan(300)
    expect(result.afterSweeps.mounted).toBeLessThanOrEqual(60)
    expect(result.afterSweeps.first && result.afterSweeps.last).toBe(true)

    // Opening a group of tool calls that is above the reading line, in the turn being read, moves the content down and the
    // scroll position with it; opening one below it moves nothing; closing the first again puts it back.
    const cards = result.toolCards
    expect(cards.groups).toBe(2)
    expect(cards.firstGroupTop).toBeLessThan(0)
    expect(cards.secondGroupTop).toBeGreaterThan(800)
    expect(within(cards.start, 100)).toBe(true)
    expect(cards.openGrowth).toBeGreaterThan(100)
    expect(within(cards.afterOpenFirst, cards.start)).toBe(true)
    expect(Math.abs(cards.openScrolled - cards.openGrowth)).toBeLessThanOrEqual(3)
    expect(within(cards.afterOpenSecond, cards.start)).toBe(true)
    expect(Math.abs(cards.secondScrollTopDelta)).toBeLessThanOrEqual(1)
    expect(within(cards.afterCloseFirst, cards.start)).toBe(true)

    // Inside a block quote taller than the viewport, whose edge cuts through it: a fenced block above the text being read
    // grows and the text stays; one below it grows and nothing moves. Each fenced block is capped, with its own scroller.
    expect(result.nested.quoteTop).toBeLessThan(0)
    expect(result.nested.quoteBottom).toBeGreaterThan(800)
    expect(within(result.nested.start, 100)).toBe(true)
    expect(result.nested.blocks.bodies.length).toBeGreaterThanOrEqual(2)
    for (const body of result.nested.blocks.bodies) expect(body.clientHeight).toBeLessThanOrEqual(400)
    expect(within(result.nested.afterFirst, result.nested.start)).toBe(true)
    expect(Math.abs(result.nested.firstScrolled - 300)).toBeLessThanOrEqual(3)
    expect(within(result.nested.afterLast, result.nested.start)).toBe(true)
    expect(Math.abs(result.nested.lastScrollTopDelta)).toBeLessThanOrEqual(1)

    // A 300,000-character thought mounts none of its text while collapsed; a 300-row table is one tall row among at most 60.
    expect(result.thinking.mounted).toBe(1)
    expect(result.thinking.rowHeight).toBeLessThan(400)
    expect(result.thinking.textLength).toBeLessThan(250000)
    expect(result.thinking.turns).toBeLessThanOrEqual(60)
    expect(result.table.mounted).toBe(1)
    expect(result.table.rowHeight).toBeGreaterThan(5000)
    expect(result.table.turns).toBeLessThanOrEqual(60)
    expect([result.table.first, result.table.last]).toEqual([1, 1])

    // Following the end holds it while the answer streams; a wheel up leaves it and the reading position stays.
    expect(Math.max(...result.followGaps)).toBeLessThan(2)
    expect(result.leftEnd.jumpVisible).toBe(true)
    expect(result.leftEnd.gap).toBeGreaterThan(100)
    expect(Math.abs(result.readingAfterStream.scrollTop - result.readingAfterStream.startScrollTop)).toBeLessThanOrEqual(2)
    expect(Math.abs(result.readingAfterStream.top - result.readingAfterStream.startTop)).toBeLessThanOrEqual(2)

    // Jump to latest lands on the end, instantly, and the button goes away.
    expect(result.jumpFrames).toBeGreaterThanOrEqual(0)
    expect(result.jumped.gap).toBeLessThan(2)
    expect(result.jumped.jumpVisible).toBe(false)
    expect(result.jumped.last).toBe(true)
    expect(result.jumped.mounted).toBeLessThanOrEqual(60)

    // Streaming for 40 frames (paragraphs and a fenced block that opens, fills and closes) while the reader is far up in the
    // thread, and for 30 more while the reader is inside the answer that is growing: the scroll position and the text at the
    // reading line never move, the button to jump to the latest stays, and the window stays within its cap.
    for (const [label, run, sentinelTop] of [['far', result.streamFar, result.farSentinel.top], ['inside', result.streamInside, null]] as const) {
      expect(run.samples.length, label).toBeGreaterThanOrEqual(30)
      expect(run.start.top, label).not.toBeNull()
      if (sentinelTop !== null) expect(within(run.start.top, sentinelTop), label).toBe(true)
      for (const [index, sample] of run.samples.entries()) {
        expect(within(sample.top, run.start.top!), `${label} frame ${index}: ${JSON.stringify(run.start)} ${JSON.stringify(run.samples.slice(0, 6))}`).toBe(true)
        expect(Math.abs(sample.scrollTop - run.start.scrollTop), `${label} frame ${index}`).toBeLessThanOrEqual(2)
        expect(sample.mounted, `${label} frame ${index}`).toBeLessThanOrEqual(60)
      }
      expect(run.jumpVisible, label).toBe(true)
      expect(run.endGap, label).toBeGreaterThanOrEqual(run.start.gap)
    }

    // A new turn while following brings its row and the end into view.
    expect(result.turnFrames).toBeGreaterThanOrEqual(0)
    expect(result.afterTurn.gap).toBeLessThan(2)
    expect(result.afterTurn.mounted).toBeLessThanOrEqual(60)
    // (Turn 1000 was added while streaming above; this is turn 1001.)
    expect(result.afterTurn.range.last).toBe(1001)

    // A marker jump to a prompt that was not mounted lands on it; a wheel during a jump is not undone.
    expect(result.markerFrames).toBeGreaterThanOrEqual(0)
    expect(result.marker.mounted).toBe(true)
    expect(Math.abs(result.marker.top - 16)).toBeLessThanOrEqual(2)
    expect(result.marker.count).toBeLessThanOrEqual(60)
    expect(Math.abs(result.interrupted.later - result.interrupted.at)).toBeLessThanOrEqual(2)
    expect(result.interrupted.top === null || Math.abs(result.interrupted.top - 16) > 100).toBe(true)

    // Scrolling the whole thread in big steps never mounts more than the cap.
    expect(result.afterScripted.mounted).toBeLessThanOrEqual(60)
    expect(result.afterScripted.first && result.afterScripted.last).toBe(true)

    // Threads up to 40 turns render every row and keep the reading line by the browser's own anchoring; one that grows past
    // that is windowed from then on.
    expect(result.ten.windowed).toBe(false)
    expect(result.ten.mounted).toBe(10)
    expect(result.ten.spacers).toBe(0)
    expect(result.ten.overflow).toBeGreaterThan(0)
    expect(result.ten.row).toBeGreaterThan(0)
    expect(within(result.ten.afterGrowth, result.ten.start)).toBe(true)
    expect(result.small40).toEqual({ windowed: false, mounted: 40, spacers: 0 })
    expect(result.grown.windowed).toBe(true)
    expect(result.grown.mounted).toBeLessThanOrEqual(41)
    expect(result.grown.gap).toBeLessThan(2)

    // Find: the bar opens from the command and takes focus; a word that only exists in a turn that is not mounted is
    // counted from the messages, and landing on it mounts that turn and puts the match inside the visible area.
    const find = result.find
    expect(find.opened).toBe(true)
    expect(find.focusFrames).toBeGreaterThanOrEqual(0)
    expect(find.farFrames).toBeGreaterThanOrEqual(0)
    expect(find.far.count).toBe('1 of 1')
    expect(find.far.turns).toBeLessThanOrEqual(60)
    expect(find.far.match).toMatchObject({ text: 'anchor-123-0', turn: 'u-123' })
    expect(inView(find.far.match)).toBe(true)
    // Eleven matches, the first one shown is the nearest one below the reader (turns 990 and up), in view.
    expect(find.manyFrames).toBeGreaterThanOrEqual(0)
    expect(find.many.count).toMatch(/ of 11$/)
    expect(find.many.match?.text).toBe('sentinel-u99')
    expect(inView(find.many.match)).toBe(true)
    // Next ends on the last match, in the last turn; one more wraps to the first, in turn 99, which was far away.
    expect(find.last.count).toBe('11 of 11')
    expect(find.last.match?.turn).toBe('u-999')
    expect(find.last.last).toBe(true)
    expect(inView(find.last.match)).toBe(true)
    expect(find.wrapFrames).toBeGreaterThanOrEqual(0)
    expect(find.wrapped.count).toBe('1 of 11')
    expect(find.wrapped.match?.turn).toBe('u-99')
    expect(find.wrapped.turns).toBeLessThanOrEqual(60)
    expect(inView(find.wrapped.match)).toBe(true)
    // Shift+Enter wraps back to the last match.
    expect(find.backFrames, JSON.stringify(find.back)).toBeGreaterThanOrEqual(0)
    expect(find.back.count).toBe('11 of 11')
    expect(find.back.match?.turn).toBe('u-999')
    expect(inView(find.back.match)).toBe(true)
    // Escape closes the bar and clears the highlights.
    expect(find.closed).toEqual({ open: false, highlights: 0 })

    // Find inside a 5,000-line fenced block (a row of ordinary height with its own scroller) that is not mounted: the first line,
    // a 400-column line and the last line are each shown inside the block and inside the transcript, going forward, around the
    // end and backward. The block's scroller moves vertically to the line and, for the wide one, horizontally to the match.
    expect(find.fence.map(visit => visit.count)).toEqual(['1 of 3', '2 of 3', '3 of 3', '1 of 3', '3 of 3', '2 of 3', '1 of 3'])
    for (const [index, visit] of find.fence.entries()) {
      const label = `visit ${index} (${visit.count})`
      expect(visit.waited, label).toBeGreaterThanOrEqual(0)
      // The query is the shared prefix; the line the match is on says which occurrence it is.
      expect(visit.match?.text, label).toBe('needle-fence')
      expect(visit.match?.turn, label).toBe('u-600')
      expect(inView(visit.match), label).toBe(true)
      expect(visit.geometry?.inContainer, label).toBe(true)
      expect(visit.geometry?.body?.inside, label).toBe(true)
      expect(visit.turns, label).toBeLessThanOrEqual(60)
      // The block is capped at 400 px and scrolls inside itself, so the row stays an ordinary height.
      expect(visit.fence.bodies[0]!.clientHeight, label).toBeLessThanOrEqual(400)
      expect(visit.fence.bodies[0]!.scrollHeight, label).toBeGreaterThan(20000)
      expect(visit.fence.rowHeight, label).toBeLessThan(700)
      const body = visit.geometry!.body!
      if (visit.count === '1 of 3') expect(body.scrollTop, label).toBeLessThanOrEqual(1)
      if (visit.count === '2 of 3') {
        expect(body.scrollTop, label).toBeGreaterThan(10000)
        expect(body.scrollLeft, label).toBeGreaterThan(0)
      }
      if (visit.count === '3 of 3') expect(body.scrollHeight - body.scrollTop - body.clientHeight, label).toBeLessThanOrEqual(40)
    }
    // A match in the first and in the 300th row of a table that is many viewports tall.
    expect(find.table.map(visit => visit.count)).toEqual(['1 of 2', '2 of 2', '1 of 2'])
    for (const [index, visit] of find.table.entries()) {
      const label = `table visit ${index} (${visit.count})`
      expect(visit.waited, label).toBeGreaterThanOrEqual(0)
      expect(visit.match?.text, label).toBe('needle-table')
      expect(inView(visit.match), label).toBe(true)
      expect(visit.geometry?.inContainer, label).toBe(true)
      expect(visit.turns, label).toBeLessThanOrEqual(60)
    }
    expect(find.innerClosed).toEqual({ open: false, highlights: 0 })
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited?.catch(() => undefined)
    }
    const resolvedDirectory = resolve(directory)
    const resolvedTemp = realpathSync(tmpdir())
    if (!resolvedDirectory.startsWith(resolvedTemp + '\\') && !resolvedDirectory.startsWith(resolvedTemp + '/')) throw new Error('Unexpected turn window fixture cleanup path')
    rmSync(resolvedDirectory, { recursive: true, force: true })
  }
}, 240000)
