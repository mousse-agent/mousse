import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_GPU_SWITCHES, runWithoutGpu } from './fixtures/electronWithoutGpu.mjs'

/** Every Electron app the tests start. A new one goes here, as a file under tests/fixtures, never as a string in a test. */
const ENTRY_POINTS = [
  'tests/fixtures/agent-platform/editor-cross-feature/electron-main.ts',
  'tests/fixtures/agent-platform/electron-attached-browser/electron-main.ts',
  'tests/fixtures/agent-platform/main-browser-e2e/electron-main.ts',
  'tests/fixtures/agent-platform/scheduled-browser-e2e/electron-gui.ts',
  'tests/fixtures/browser-host-probe/main.ts',
  'tests/fixtures/chat-undo-full-shell-driver.mjs',
  'tests/fixtures/git-foundation-full-shell-driver.mjs',
  'tests/fixtures/menu-shortcuts/main.ts',
  'tests/fixtures/net-gui/mounted-lifecycle/main.ts',
  'tests/fixtures/net-gui/task-picker-electron.ts',
  'tests/fixtures/profile-footer/main.ts',
  'tests/fixtures/profile-isolation/profile-production-main.ts',
  'tests/fixtures/prompt-markers/main.ts',
  'tests/fixtures/provider-credentials/vault-probe.ts',
  'tests/fixtures/renderer-startup/main.ts',
  'tests/fixtures/repository-upgrades/electron-error-bridge.ts',
  'tests/fixtures/repository-upgrades/electron-net-chats-bridge.ts',
  'tests/fixtures/resource-lifecycle-full-shell-driver.mjs',
  'tests/fixtures/storage-settings/main.ts',
  'tests/fixtures/turn-window/main.ts'
]

const READY_TEXT = /\bwhenReady\s*\(|\.(?:on|once|addListener|prependListener)\(\s*['"`]ready['"`]/
const ELECTRON_TEXT = /['"`]electron['"`]/

/** Text that starts an Electron app: it names `electron` and waits for ready. Unit tests that mock `electron` start none. */
function startsElectronApp(text: string): boolean {
  return ELECTRON_TEXT.test(text) && READY_TEXT.test(text) && !/vi\.mock\(\s*['"]electron['"]/.test(text)
}

function isReadyCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false
  const name = node.expression.name.text
  if (name === 'whenReady') return true
  const [event] = node.arguments
  return ['on', 'once', 'addListener', 'prependListener'].includes(name) && !!event && ts.isStringLiteralLike(event) && event.text === 'ready'
}

/** Runs when the module is evaluated: the call is a statement at top level, or in the block of a top-level `if`, never in a function. */
function runsAtLoad(call: ts.CallExpression): boolean {
  if (!ts.isExpressionStatement(call.parent)) return false
  for (let node: ts.Node = call.parent.parent; !ts.isSourceFile(node); node = node.parent) {
    if (ts.isBlock(node)) continue
    if (ts.isIfStatement(node) && ts.isSourceFile(node.parent) || ts.isIfStatement(node) && ts.isIfStatement(node.parent)) continue
    return false
  }
  return true
}

/** Why an Electron entry point may still reach the GPU, or undefined when it turns it off before ready. */
function gpuOffProblem(source: string, fileName: string): string | undefined {
  const kind = /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const imported = file.statements.some((statement) => ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier) && /(?:^|\/)electronWithoutGpu\.mjs$/.test(statement.moduleSpecifier.text)
    && !!statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some((element) => element.name.text === 'runWithoutGpu'))
  if (!imported) return 'does not import runWithoutGpu from electronWithoutGpu.mjs'
  const helperCalls: ts.CallExpression[] = []
  const readyCalls: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'runWithoutGpu') helperCalls.push(node)
    if (isReadyCall(node)) readyCalls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  const call = helperCalls.find((candidate) => {
    const [argument] = candidate.arguments
    return runsAtLoad(candidate) && !!argument && ts.isObjectLiteralExpression(argument)
      && ['app', 'BrowserWindow'].every((name) => argument.properties.some((property) => property.name && ts.isIdentifier(property.name) && property.name.text === name))
  })
  if (!call) return 'does not call runWithoutGpu({ app, BrowserWindow }) at top level'
  const early = readyCalls.find((ready) => ready.getStart(file) < call.getEnd())
  if (early) return `waits for ready (line ${file.getLineAndCharacterOfPosition(early.getStart(file)).line + 1}) before calling runWithoutGpu`
  return undefined
}

function fakeElectron(windows: Array<{ destroyed: boolean; url: string }>) {
  const exits: number[] = []
  const app = {
    disableHardwareAcceleration: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    exit: (code?: number) => { exits.push(code ?? 0) }
  }
  const BrowserWindow = {
    getAllWindows: () => windows.map((window) => ({ isDestroyed: () => window.destroyed, webContents: { getURL: () => window.url } }))
  }
  return { app, BrowserWindow, exits }
}

afterEach(() => { vi.restoreAllMocks() })

describe('runWithoutGpu', () => {
  it('turns the GPU off and reduced motion on', () => {
    const { app, BrowserWindow } = fakeElectron([])
    runWithoutGpu({ app, BrowserWindow })
    expect(app.disableHardwareAcceleration).toHaveBeenCalledOnce()
    expect(app.commandLine.appendSwitch.mock.calls.map(([name]) => name)).toEqual(['disable-gpu', 'disable-gpu-compositing', 'force-prefers-reduced-motion'])
  })

  it('fails a passing exit while a window is still open', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { app, BrowserWindow, exits } = fakeElectron([{ destroyed: false, url: 'http://127.0.0.1:1/' }, { destroyed: true, url: 'about:blank' }])
    runWithoutGpu({ app, BrowserWindow })
    app.exit(0)
    expect(exits).toEqual([1])
    expect(String(stderr.mock.calls[0]?.[0])).toContain('1 window(s) still open when the test app exited: http://127.0.0.1:1/')
  })

  it('keeps the exit code when every window is closed, or when the app already failed', () => {
    const closed = fakeElectron([{ destroyed: true, url: 'about:blank' }])
    runWithoutGpu(closed)
    closed.app.exit()
    expect(closed.exits).toEqual([0])
    const failed = fakeElectron([{ destroyed: false, url: '' }])
    runWithoutGpu(failed)
    failed.app.exit(2)
    expect(failed.exits).toEqual([2])
  })
})

describe('the GPU check of an entry point', () => {
  const header = "import { app, BrowserWindow } from 'electron'\nimport { runWithoutGpu } from '../electronWithoutGpu.mjs'\n"
  const problem = (body: string, withHeader = true) => gpuOffProblem((withHeader ? header : "import { app } from 'electron'\n") + body, 'main.ts')

  it('accepts the helper called at top level before ready, also in a top-level if or else', () => {
    expect(problem("runWithoutGpu({ app, BrowserWindow })\napp.whenReady().then(() => new BrowserWindow({ show: false }))")).toBeUndefined()
    expect(problem("if (!cli) { runWithoutGpu({ app, BrowserWindow }) }\nasync function check() { await app.whenReady() }")).toBeUndefined()
    expect(problem("if (node) { run() } else {\n  runWithoutGpu({ app, BrowserWindow })\n  void app.whenReady()\n}")).toBeUndefined()
  })

  it('rejects an app that waits for the ready event without the helper', () => {
    expect(problem("app.on('ready', () => new BrowserWindow())", false)).toMatch(/does not import/)
    expect(problem("app.once('ready', () => new BrowserWindow())")).toMatch(/does not call/)
  })

  it('rejects a commented-out call, or the call only named in a string', () => {
    expect(problem("// runWithoutGpu({ app, BrowserWindow })\napp.whenReady()")).toMatch(/does not call/)
    expect(problem("const note = 'runWithoutGpu({ app, BrowserWindow })'\napp.whenReady()")).toMatch(/does not call/)
  })

  it('rejects the call made after ready, inside a ready handler, or in a function', () => {
    expect(problem("await app.whenReady()\nrunWithoutGpu({ app, BrowserWindow })")).toMatch(/waits for ready \(line 3\)/)
    expect(problem("app.on('ready', () => {})\nrunWithoutGpu({ app, BrowserWindow })")).toMatch(/waits for ready/)
    expect(problem("app.whenReady().then(() => runWithoutGpu({ app, BrowserWindow }))")).toMatch(/does not call/)
    expect(problem("function setup() { runWithoutGpu({ app, BrowserWindow }) }\nsetup()\napp.whenReady()")).toMatch(/does not call/)
    expect(problem("runWithoutGpu({ app })\napp.whenReady()")).toMatch(/does not call/)
  })

  it('treats an Electron app written into a string in a test as one to move to a fixture', () => {
    expect(startsElectronApp("const source = `import { app } from 'electron'; app.whenReady().then(() => {})`")).toBe(true)
    expect(startsElectronApp("const source = `const { app } = require(\"electron\"); app.on('ready', () => {})`")).toBe(true)
    expect(startsElectronApp("vi.mock('electron', () => ({ app: { whenReady: () => Promise.resolve() } }))\napp.whenReady()")).toBe(false)
  })
})

describe('Electron apps the tests start', () => {
  const tests = join(process.cwd(), 'tests')
  const sources = readdirSync(tests, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.(?:[cm]?[jt]s|tsx)$/.test(path))
    .map((path) => ({ path: relative(process.cwd(), join(tests, path)).replaceAll('\\', '/'), text: readFileSync(join(tests, path), 'utf8') }))
    .filter(({ path }) => path !== 'tests/electronFixturesWithoutGpu.test.ts')

  it('are all listed entry points, found anywhere under tests/', () => {
    const found = sources.filter(({ text }) => startsElectronApp(text)).map(({ path }) => path).sort()
    expect(found).toEqual([...ENTRY_POINTS].sort())
  })

  it('each turn the GPU off before ready', () => {
    const problems = ENTRY_POINTS.map((path) => [path, gpuOffProblem(readFileSync(path, 'utf8'), path)]).filter(([, issue]) => issue)
    expect(problems).toEqual([])
  })

  it('never show a window or ask for GPU features', () => {
    const gpuHeavy = /show:\s*true|enable-gpu|ignore-gpu-blocklist|force_high_performance_gpu|enable-zero-copy/
    expect(sources.filter(({ path, text }) => path.startsWith('tests/fixtures/') && gpuHeavy.test(text)).map(({ path }) => path)).toEqual([])
    expect(NO_GPU_SWITCHES).toContain('disable-gpu')
  })
})
