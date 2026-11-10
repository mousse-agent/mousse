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
  'tests/fixtures/agent-platform/main-browser-e2e/launch.mjs',
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
  'tests/fixtures/provider-credentials/vault-probe-electron.ts',
  'tests/fixtures/renderer-startup/main.ts',
  'tests/fixtures/repository-upgrades/electron-error-bridge.ts',
  'tests/fixtures/repository-upgrades/electron-net-chats-bridge.ts',
  'tests/fixtures/resource-lifecycle-full-shell-driver.mjs',
  'tests/fixtures/storage-settings/main.ts',
  'tests/fixtures/turn-window/main.ts'
]

/** Modules that use Electron's `app` but only run inside an entry point that imports them, after its own call. */
const SHARED_MODULES = ['tests/fixtures/fullShellWindow.mjs']

const READY_EVENT_METHODS = new Set(['on', 'once', 'addListener', 'prependListener'])

function parse(source: string, fileName: string): ts.SourceFile {
  const kind = /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

/** `obj.name`, or `obj['name']` with a string key. */
function memberName(node: ts.Node): { object: ts.Expression; name: string } | undefined {
  if (ts.isPropertyAccessExpression(node)) return { object: node.expression, name: node.name.text }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return { object: node.expression, name: node.argumentExpression.text }
  return undefined
}

/** The outermost expression around `node` that only casts or wraps it. */
function unwrapUp(node: ts.Node): ts.Node {
  let current = node
  while (current.parent && (ts.isAsExpression(current.parent) || ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent) || ts.isSatisfiesExpression(current.parent))) current = current.parent
  return current
}

function unwrapDown(node: ts.Expression): ts.Expression {
  let inner = node
  while (ts.isAsExpression(inner) || ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner) || ts.isSatisfiesExpression(inner)) inner = inner.expression
  return inner
}

const isElectronSpecifier = (node: ts.Node | undefined): boolean => !!node && ts.isStringLiteralLike(node) && node.text === 'electron'

/** How a module reaches Electron: names bound to `app`, and names bound to the whole module (its default export is the binary path). */
function electronBindings(file: ts.SourceFile) {
  const appNames = new Set<string>()
  const moduleNames = new Set<string>()
  let viaApp = false
  let mocked = false
  walk(file, (node) => {
    if (ts.isImportDeclaration(node) && isElectronSpecifier(node.moduleSpecifier) && node.importClause && !node.importClause.isTypeOnly) {
      const clause = node.importClause
      if (clause.name) moduleNames.add(clause.name.text)
      const bindings = clause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) moduleNames.add(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) if (!element.isTypeOnly && (element.propertyName ?? element.name).text === 'app') appNames.add(element.name.text)
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length >= 1 && isElectronSpecifier(node.arguments[0])) {
      if (memberName(node.expression)?.name === 'mock') { mocked = true; return }
      if (node.arguments.length !== 1) return
      const outer = unwrapUp(node)
      const parent = outer.parent
      if (parent && ts.isVariableDeclaration(parent) && parent.initializer === outer) {
        if (ts.isIdentifier(parent.name)) moduleNames.add(parent.name.text)
        else if (ts.isObjectBindingPattern(parent.name)) {
          for (const element of parent.name.elements) {
            const key = element.propertyName ?? element.name
            if (ts.isIdentifier(key) && key.text === 'app' && ts.isIdentifier(element.name)) appNames.add(element.name.text)
          }
        }
      }
      if (parent && memberName(parent)?.name === 'app') viaApp = true
    }
  })
  return { appNames, moduleNames, viaApp, mocked }
}

/** True when the module uses Electron's `app`, so running it under Electron starts an app. Mocked `electron` starts none. */
function usesElectronApp(source: string, fileName: string): boolean {
  const file = parse(source, fileName)
  const { appNames, moduleNames, viaApp, mocked } = electronBindings(file)
  if (mocked) return false
  if (viaApp) return true
  let uses = false
  walk(file, (node) => {
    if (uses) return
    const member = memberName(node)
    if (member && member.name === 'app' && ts.isIdentifier(member.object) && moduleNames.has(member.object.text)) uses = true
    if (ts.isIdentifier(node) && appNames.has(node.text)) {
      const parent = node.parent
      const declaring = ts.isImportSpecifier(parent) || ts.isBindingElement(parent) || (ts.isPropertyAccessExpression(parent) && parent.name === node)
      if (!declaring) uses = true
    }
  })
  return uses
}

/** Calls that run code once Electron is ready: `x.whenReady()` and `x.on('ready', ...)`, in any spelling the parser accepts. */
function readyCalls(file: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return
    const member = memberName(node.expression)
    if (!member) return
    const [event] = node.arguments
    if (member.name === 'whenReady' || (READY_EVENT_METHODS.has(member.name) && !!event && ts.isStringLiteralLike(event) && event.text === 'ready')) calls.push(node)
  })
  return calls
}

/** Why an Electron entry point may still reach the GPU, or undefined when it turns it off before ready. */
function gpuOffProblem(source: string, fileName: string): string | undefined {
  const file = parse(source, fileName)
  const imported = file.statements.some((statement) => ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier) && /(?:^|\/)electronWithoutGpu\.mjs$/.test(statement.moduleSpecifier.text)
    && !!statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some((element) => element.name.text === 'runWithoutGpu'))
  if (!imported) return 'does not import runWithoutGpu from electronWithoutGpu.mjs'
  // Only a statement of the module itself runs, unconditionally, when the module is evaluated: not one inside an
  // if, a loop, a try, a block, a function or an expression that may skip it.
  const call = file.statements.find((statement): statement is ts.ExpressionStatement => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
    const { expression: callee, arguments: [argument] } = statement.expression
    return ts.isIdentifier(callee) && callee.text === 'runWithoutGpu' && !!argument && ts.isObjectLiteralExpression(argument)
      && ['app', 'BrowserWindow'].every((name) => argument.properties.some((property) => property.name && ts.isIdentifier(property.name) && property.name.text === name))
  })
  if (!call) return 'does not call runWithoutGpu({ app, BrowserWindow }) as an unconditional top-level statement'
  const early = readyCalls(file).find((ready) => ready.getStart(file) < call.getEnd())
  if (early) return `waits for ready (line ${file.getLineAndCharacterOfPosition(early.getStart(file)).line + 1}) before calling runWithoutGpu`
  return undefined
}

/** Code held in a string or template in a file, which a test may write out and run. Template holes become a name. */
function embeddedSources(file: ts.SourceFile): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = []
  walk(file, (node) => {
    let text: string | undefined
    if (ts.isStringLiteralLike(node)) text = node.text
    else if (ts.isTemplateExpression(node)) text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('__hole__')
    if (text && /\belectron\b/.test(text) && /\bapp\b/.test(text)) found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text })
  })
  return found
}

/** A test that hands the Electron binary (the `electron` module's default export) to a call starts an Electron main. */
function launchesElectron(source: string, fileName: string): boolean {
  const file = parse(source, fileName)
  const { moduleNames } = electronBindings(file)
  let launches = false
  walk(file, (node) => {
    if (launches || !ts.isCallExpression(node)) return
    const [first] = node.arguments
    if (!first) return
    const inner = unwrapDown(first)
    if (ts.isIdentifier(inner) && moduleNames.has(inner.text)) launches = true
  })
  return launches
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

  it('does nothing the second time for the same app, so a launcher and the fixture it loads may both call it', () => {
    const { app, BrowserWindow, exits } = fakeElectron([])
    runWithoutGpu({ app, BrowserWindow })
    const wrapped = app.exit
    runWithoutGpu({ app, BrowserWindow })
    expect(app.disableHardwareAcceleration).toHaveBeenCalledOnce()
    expect(app.commandLine.appendSwitch).toHaveBeenCalledTimes(NO_GPU_SWITCHES.length)
    expect(app.exit).toBe(wrapped)
    app.exit(0)
    expect(exits).toEqual([0])
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
  const call = 'runWithoutGpu({ app, BrowserWindow })'
  const problem = (body: string, withHeader = true) => gpuOffProblem((withHeader ? header : "import { app } from 'electron'\n") + body, 'main.ts')

  it('accepts the helper as an unconditional top-level statement before ready', () => {
    expect(problem(`${call}\napp.whenReady().then(() => new BrowserWindow({ show: false }))`)).toBeUndefined()
    expect(problem(`app.setPath('userData', '/tmp/x'); ${call}\nvoid app.whenReady()`)).toBeUndefined()
  })

  it('rejects an app that waits for the ready event without the helper', () => {
    expect(problem("app.on('ready', () => new BrowserWindow())", false)).toMatch(/does not import/)
    expect(problem("app.once('ready', () => new BrowserWindow())")).toMatch(/does not call/)
  })

  it('rejects the helper anywhere it may not run: an if, a loop, a try, a block, a function or a short circuit', () => {
    expect(problem(`if (false) { ${call} }\napp.whenReady()`)).toMatch(/does not call/)
    expect(problem(`if (process.env.GPU) ${call}\napp.whenReady()`)).toMatch(/does not call/)
    expect(problem(`for (const _ of []) { ${call} }\napp.whenReady()`)).toMatch(/does not call/)
    expect(problem(`try { ${call} } catch {}\napp.whenReady()`)).toMatch(/does not call/)
    expect(problem(`{ ${call} }\napp.whenReady()`)).toMatch(/does not call/)
    expect(problem(`function setup() { ${call} }\nsetup()\napp.whenReady()`)).toMatch(/does not call/)
    expect(problem(`process.env.GPU && ${call}\napp.whenReady()`)).toMatch(/does not call/)
  })

  it('rejects a commented-out call, the call only named in a string, or a call missing an argument', () => {
    expect(problem(`// ${call}\napp.whenReady()`)).toMatch(/does not call/)
    expect(problem(`const note = '${call}'\napp.whenReady()`)).toMatch(/does not call/)
    expect(problem('runWithoutGpu({ app })\napp.whenReady()')).toMatch(/does not call/)
  })

  it('rejects the call after ready, in any spelling of a ready handler', () => {
    expect(problem(`await app.whenReady()\n${call}`)).toMatch(/waits for ready \(line 3\)/)
    expect(problem(`app.on('ready', () => {})\n${call}`)).toMatch(/waits for ready/)
    expect(problem(`app.on ('ready', () => {})\n${call}`)).toMatch(/waits for ready/)
    expect(problem(`app['whenReady']().then(() => {})\n${call}`)).toMatch(/waits for ready/)
    expect(problem(`app['once']("ready", () => {})\n${call}`)).toMatch(/waits for ready/)
    expect(problem(`app.whenReady().then(() => ${call})`)).toMatch(/does not call/)
  })
})

describe('finding Electron apps', () => {
  it('finds a module that imports or requires Electron and uses its app, however it waits for ready', () => {
    expect(usesElectronApp("import { app } from 'electron'\napp.on ('ready', () => {})", 'a.ts')).toBe(true)
    expect(usesElectronApp("import { app as electronApp } from 'electron'\nelectronApp['whenReady']()", 'a.ts')).toBe(true)
    expect(usesElectronApp("import * as electron from 'electron'\nelectron.app.setName('x')", 'a.ts')).toBe(true)
    expect(usesElectronApp("const electron = require('electron')\nelectron['app'].quit()", 'a.js')).toBe(true)
    expect(usesElectronApp("const { app } = require('electron')\napp.quit()", 'a.js')).toBe(true)
    expect(usesElectronApp("const { app } = createRequire(import.meta.url)('electron') as typeof import('electron')\napp.quit()", 'a.ts')).toBe(true)
    expect(usesElectronApp("require('electron').app.exit(0)", 'a.js')).toBe(true)
  })

  it('leaves out mocks, type-only imports and the binary path', () => {
    expect(usesElectronApp("import type { BrowserWindow } from 'electron'\nconst app = 1", 'a.ts')).toBe(false)
    expect(usesElectronApp("import electron from 'electron'\nspawn(electron as unknown as string, ['main.mjs'])", 'a.ts')).toBe(false)
    expect(usesElectronApp("vi.mock('electron', () => ({ app: {} }))\nimport { app } from 'electron'\napp.whenReady()", 'a.ts')).toBe(false)
  })

  it('finds an Electron app written into a string or template in a test', () => {
    const test = parse("const a = `import { app } from 'electron'; app.on ('ready', () => {})`\nconst b = \"const { app } = require('electron'); app['whenReady']()\"\nconst c = `import {app} from 'electron'; await import(${'x'}); app.exit(1)`", 't.test.ts')
    const apps = embeddedSources(test).filter(({ text }) => usesElectronApp(text, 'embedded.ts'))
    expect(apps.map(({ line }) => line)).toEqual([1, 2, 3])
  })

  it('finds a test that starts the Electron binary', () => {
    expect(launchesElectron("import electron from 'electron'\nspawn(electron as unknown as string, [main])", 't.ts')).toBe(true)
    expect(launchesElectron("const electron = createRequire(import.meta.url)('electron') as string\nrun(electron, entry)", 't.ts')).toBe(true)
    expect(launchesElectron("import electron from 'electron'\nconsole.log('electron')", 't.ts')).toBe(false)
  })
})

describe('Electron apps the tests start', () => {
  const tests = join(process.cwd(), 'tests')
  const sources = readdirSync(tests, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.(?:[cm]?[jt]s|tsx)$/.test(path))
    .map((path) => ({ path: relative(process.cwd(), join(tests, path)).replaceAll('\\', '/'), text: readFileSync(join(tests, path), 'utf8') }))
    .filter(({ path }) => path !== 'tests/electronFixturesWithoutGpu.test.ts')

  it('are all listed entry points or shared modules, and none is written into a string', () => {
    const found: string[] = []
    for (const { path, text } of sources) {
      if (usesElectronApp(text, path)) found.push(path)
      for (const { line, text: embedded } of embeddedSources(parse(text, path))) {
        if (usesElectronApp(embedded, 'embedded.ts')) found.push(`${path} (string at line ${line})`)
      }
    }
    expect(found.sort()).toEqual([...ENTRY_POINTS, ...SHARED_MODULES].sort())
  })

  it('are started only from listed entry points', () => {
    const launchers = sources.filter(({ path, text }) => !path.startsWith('tests/fixtures/') && launchesElectron(text, path))
    expect(launchers.length).toBeGreaterThanOrEqual(15)
    // A launcher names the entry point, or its fixture folder, from the repository root or from tests/.
    const names = (entry: string) => {
      const inTests = entry.slice('tests/'.length)
      return [entry, inTests, inTests.slice(0, inTests.lastIndexOf('/') + 1)].filter((name) => name.startsWith('fixtures/') ? name.length > 'fixtures/'.length : true)
    }
    const unlisted = launchers.filter(({ text }) => !ENTRY_POINTS.some((entry) => names(entry).some((name) => text.includes(name))))
    expect(unlisted.map(({ path }) => path)).toEqual([])
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
