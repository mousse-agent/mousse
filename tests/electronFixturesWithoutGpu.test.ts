import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
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

/** Preload scripts run in a page, not as an Electron main. They may `require` the renderer's parts of Electron. */
const PRELOAD_SCRIPTS = ['tests/fixtures/agent-platform/editor-cross-feature/preload.cjs']

/**
 * Launches of the Electron binary whose target is computed (usually a bundle of an entry point in a temporary folder),
 * audited by hand: `file:line` of the launch call, and the listed entry point it starts. A launch with a target made
 * of string literals is checked against ENTRY_POINTS instead and needs no entry here.
 */
const COMPUTED_LAUNCHES: Record<string, { starts: string; how: string }> = {
  'tests/chatUndoFullShell.test.ts:30': { starts: 'tests/fixtures/chat-undo-full-shell-driver.mjs', how: 'fullShellElectronArgs(resolve(the driver)) adds only display flags' },
  'tests/errorElectronBridge.test.ts:44': { starts: 'tests/fixtures/repository-upgrades/electron-error-bridge.ts', how: 'esbuild bundle of tests/fixtures/repository-upgrades/electron-error-bridge.ts (line 36) in a temporary folder' },
  'tests/gitFoundationFullShell.test.ts:29': { starts: 'tests/fixtures/git-foundation-full-shell-driver.mjs', how: 'fullShellElectronArgs(resolve(the driver)) adds only display flags' },
  'tests/platformBrowserPackaging.test.ts:42': { starts: 'tests/fixtures/browser-host-probe/main.ts', how: 'esbuild bundle of tests/fixtures/browser-host-probe/main.ts (line 37) in a temporary folder' },
  'tests/platformEditorCrossFeature.test.ts:36': { starts: 'tests/fixtures/agent-platform/editor-cross-feature/electron-main.ts', how: 'esbuild bundle of tests/fixtures/agent-platform/editor-cross-feature/electron-main.ts (line 29) in a temporary folder' },
  'tests/platformElectronAttachedBrowser.test.ts:561': { starts: 'tests/fixtures/agent-platform/electron-attached-browser/electron-main.ts', how: 'esbuild bundle of fixtureDir/electron-main.ts in a temporary folder' },
  'tests/platformMainBrowserE2E.test.ts:276': { starts: 'tests/fixtures/agent-platform/main-browser-e2e/launch.mjs', how: 'script = resolve(the launcher); it loads the bundle of main-browser-e2e/electron-main.ts' },
  'tests/platformScheduledBrowserE2E.test.ts:135': { starts: 'tests/fixtures/agent-platform/scheduled-browser-e2e/electron-gui.ts', how: 'esbuild bundle of tests/fixtures/agent-platform/scheduled-browser-e2e/electron-gui.ts (line 126) in a temporary folder' },
  'tests/promptMarkers.test.ts:19': { starts: 'tests/fixtures/prompt-markers/main.ts', how: 'esbuild bundle of tests/fixtures/prompt-markers/main.ts (line 16) in a temporary folder' },
  'tests/providerCredentialVaultRuntime.test.ts:48': { starts: 'tests/fixtures/provider-credentials/vault-probe-electron.ts', how: 'esbuild bundle of tests/fixtures/provider-credentials/vault-probe-electron.ts (line 46) in a temporary folder' },
  'tests/providerCredentialVaultRuntime.test.ts:56': { starts: 'tests/fixtures/provider-credentials/vault-probe-electron.ts', how: 'esbuild bundle of tests/fixtures/provider-credentials/vault-probe-electron.ts (line 46) in a temporary folder' },
  'tests/resourceLifecycleFullShell.test.ts:38': { starts: 'tests/fixtures/resource-lifecycle-full-shell-driver.mjs', how: 'fullShellElectronArgs(resolve(the driver)) adds only display flags' },
  'tests/renderer/menu-shortcut-gate-electron.test.ts:26': { starts: 'tests/fixtures/menu-shortcuts/main.ts', how: 'esbuild bundle of tests/fixtures/menu-shortcuts/main.ts (line 16) in a temporary folder' },
  'tests/renderer/networkTaskPicker-electron.test.ts:21': { starts: 'tests/fixtures/net-gui/task-picker-electron.ts', how: 'esbuild bundle of tests/fixtures/net-gui/task-picker-electron.ts (line 14) in a temporary folder' },
  'tests/renderer/profile-footer-electron.test.ts:18': { starts: 'tests/fixtures/profile-footer/main.ts', how: 'esbuild bundle of tests/fixtures/profile-footer/main.ts (line 15) in a temporary folder' },
  'tests/renderer/profileReady-startup-electron.test.ts:40': { starts: 'tests/fixtures/renderer-startup/main.ts', how: 'esbuild bundle of tests/fixtures/renderer-startup/main.ts (line 37) in a temporary folder' },
  'tests/renderer/storage-settings-electron.test.ts:25': { starts: 'tests/fixtures/storage-settings/main.ts', how: 'esbuild bundle of tests/fixtures/storage-settings/main.ts (line 20) in a temporary folder' },
  'tests/renderer/turn-window-electron.test.ts:87': { starts: 'tests/fixtures/turn-window/main.ts', how: 'esbuild bundle of tests/fixtures/turn-window/main.ts (line 84) in a temporary folder' },
  'tests/net/chats/gui-electron.test.ts:37': { starts: 'tests/fixtures/repository-upgrades/electron-net-chats-bridge.ts', how: 'esbuild bundle of tests/fixtures/repository-upgrades/electron-net-chats-bridge.ts (line 32) in a temporary folder' },
  'tests/net/chats/gui-renderer-lifecycle.test.ts:19': { starts: 'tests/fixtures/net-gui/mounted-lifecycle/main.ts', how: 'esbuild bundle of tests/fixtures/net-gui/mounted-lifecycle/main.ts (line 16) in a temporary folder' },
  'tests/fixtures/agent-platform/electron-attached-browser/run-electron-fixture.mjs:49': { starts: 'tests/fixtures/agent-platform/electron-attached-browser/electron-main.ts', how: 'esbuild bundle of fixtureDir/electron-main.ts (line 33) in a temporary folder; a manual runner' }
}

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
    if (text && /\belectron\b/.test(text) && /\b(?:app|import|require|export)\b/.test(text)) found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text })
  })
  return found
}

const lineOf = (file: ts.SourceFile, node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1

/** `import(x)`, `require(x)`, `someRequire(x)` and `createRequire(...)(x)`: a call that loads a module. `createRequire(...)` itself loads nothing. */
function isModuleLoad(call: ts.CallExpression): boolean {
  const callee = call.expression
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true
  if (ts.isIdentifier(callee)) return callee.text !== 'createRequire' && /(?:^r|R)equire$/.test(callee.text)
  return ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'createRequire'
}

/** A file path or URL: `pathToFileURL(...)`, `new URL(...)`, or `x.href` of one. It can name a file, never the bare `electron` module. */
function isFileReference(node: ts.Expression): boolean {
  const inner = unwrapDown(node)
  if (ts.isPropertyAccessExpression(inner) && inner.name.text === 'href') return true
  if (ts.isNewExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'URL') return true
  return ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'pathToFileURL'
}

/** `vi.mock('electron', ...)` as a statement of the module: every `electron` it loads is the mock, never Electron. */
function mocksElectron(file: ts.SourceFile): boolean {
  return file.statements.some((statement) => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    && memberName(statement.expression.expression)?.name === 'mock' && isElectronSpecifier(statement.expression.arguments[0]))
}

/**
 * How a file reaches the `electron` module, against rules that fail closed. Static `import ... from 'electron'` is the
 * only way in. Its default export (the binary path, in a test) may only be handed to a call: that call is a launch.
 * Loading `electron` with `import()` or `require()`, re-exporting it, a namespace or bare import, and loading a module
 * whose name is computed (other than a file path or URL) are refused. A preload script listed in PRELOAD_SCRIPTS may
 * `require` the renderer's parts of Electron, never `app`; a file that mocks `electron` may `import()` the mock.
 */
function electronAccessProblems(source: string, fileName: string, options: { preload?: boolean } = {}): string[] {
  const file = parse(source, fileName)
  const mocked = mocksElectron(file)
  const problems: string[] = []
  const defaults = new Set<string>()
  const at = (node: ts.Node, problem: string) => problems.push(`line ${lineOf(file, node)}: ${problem}`)
  walk(file, (node) => {
    if (ts.isExportDeclaration(node) && isElectronSpecifier(node.moduleSpecifier)) at(node, 're-exports electron')
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && isElectronSpecifier(node.moduleReference.expression)) at(node, 'loads electron with import = require()')
    if (ts.isImportDeclaration(node) && isElectronSpecifier(node.moduleSpecifier)) {
      const clause = node.importClause
      if (!clause) at(node, 'imports electron for its side effects')
      else if (!clause.isTypeOnly) {
        if (clause.name) defaults.add(clause.name.text)
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) at(node, 'imports electron as a namespace')
      }
    }
    if (!ts.isCallExpression(node) || !isModuleLoad(node)) return
    const [specifier] = node.arguments
    if (!specifier) return
    if (isElectronSpecifier(specifier)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      if (isImport && mocked) return
      if (options.preload && !isImport && preloadRequire(node)) return
      at(node, `loads electron with ${isImport ? 'import()' : 'require()'}; use a static import`)
    } else if (!ts.isStringLiteralLike(specifier) && !isFileReference(specifier)) {
      at(node, 'loads a module whose name is computed; only a file path or URL may be computed')
    }
  })
  walk(file, (node) => {
    if (!ts.isIdentifier(node) || !defaults.has(node.text) || ts.isImportClause(node.parent)) return
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return
    const outer = unwrapUp(node)
    if (!(outer.parent && ts.isCallExpression(outer.parent) && outer.parent.arguments.includes(outer as ts.Expression))) at(node, `uses the electron binary path \`${node.text}\` other than to launch it`)
  })
  return problems
}

/** `const { contextBridge, ipcRenderer } = require('electron')` at the top of a preload script, without `app`. */
function preloadRequire(call: ts.CallExpression): boolean {
  const declaration = unwrapUp(call).parent
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isObjectBindingPattern(declaration.name)) return false
  const statement = declaration.parent?.parent
  if (!statement || !ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent)) return false
  return declaration.name.elements.every((element) => {
    const key = element.propertyName ?? element.name
    return ts.isIdentifier(key) && key.text !== 'app' && key.text !== 'BrowserWindow'
  })
}

const REPO_ROOT = process.cwd()

/** A path made only of string literals: `'a'`, or `resolve(...)`/`join(...)` (bare or `path.`) of literals, from the repository root. */
function literalPath(node: ts.Expression): string | undefined {
  const inner = unwrapDown(node)
  if (ts.isStringLiteralLike(inner)) return relative(REPO_ROOT, resolve(REPO_ROOT, inner.text)).replaceAll('\\', '/')
  if (!ts.isCallExpression(inner)) return undefined
  const callee = inner.expression
  const name = ts.isIdentifier(callee) ? callee.text
    : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'path' ? callee.name.text : undefined
  if (name !== 'resolve' && name !== 'join') return undefined
  const parts = inner.arguments.map((argument) => ts.isStringLiteralLike(argument) ? argument.text : undefined)
  if (parts.some((part) => part === undefined)) return undefined
  return relative(REPO_ROOT, resolve(REPO_ROOT, ...(parts as string[]))).replaceAll('\\', '/')
}

/**
 * Every call a file hands the Electron binary to, with what it starts: the argument after the binary, or the first
 * element when that is an array of arguments. `target` is set when that is made of string literals only.
 */
function launchSites(source: string, fileName: string): Array<{ line: number; target?: string; text: string }> {
  const file = parse(source, fileName)
  const binaries = new Set<string>()
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && isElectronSpecifier(statement.moduleSpecifier) && statement.importClause?.name && !statement.importClause.isTypeOnly) binaries.add(statement.importClause.name.text)
  }
  const sites: Array<{ line: number; target?: string; text: string }> = []
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return
    const index = node.arguments.findIndex((argument) => { const inner = unwrapDown(argument); return ts.isIdentifier(inner) && binaries.has(inner.text) })
    if (index < 0) return
    const next = node.arguments[index + 1]
    const started = next && ts.isArrayLiteralExpression(unwrapDown(next)) ? (unwrapDown(next) as ts.ArrayLiteralExpression).elements[0] : next
    const target = started && !ts.isSpreadElement(started) ? literalPath(started) : undefined
    sites.push({ line: lineOf(file, node), ...(target ? { target } : {}), text: started ? started.getText(file) : '(nothing)' })
  })
  return sites
}

/** Why the Electron launches in a file are not known to start a listed entry point; `audited` maps `file:line` of a computed launch to what it starts. */
function launchProblems(source: string, fileName: string, audited: Record<string, { starts: string }>): string[] {
  return launchSites(source, fileName).flatMap(({ line, target, text }) => {
    if (target !== undefined) return ENTRY_POINTS.includes(target) ? [] : [`${fileName}:${line} starts ${target}, which is not a listed entry point`]
    return audited[`${fileName}:${line}`] ? [] : [`${fileName}:${line} starts \`${text}\`, which is computed and not in COMPUTED_LAUNCHES`]
  })
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

})

describe('how a file may reach electron', () => {
  const problems = (source: string, options: { preload?: boolean } = {}) => electronAccessProblems(source, 'a.ts', options)

  it('allows static imports, and the binary path handed to a call', () => {
    expect(problems("import { app, BrowserWindow, session } from 'electron'\napp.whenReady()")).toEqual([])
    expect(problems("import electron from 'electron'\nspawn(electron as unknown as string, [entry])")).toEqual([])
    expect(problems("import type { WebContents } from 'electron'\nimport type electron from 'electron'")).toEqual([])
    expect(problems("const root = await import(pathToFileURL(entry).href)\nawait import(new URL('./x.mjs', import.meta.url).href)\nawait import(helper.href)")).toEqual([])
  })

  it('refuses electron loaded with import() or require(), however its parts are taken', () => {
    expect(problems("const { app } = await import('electron')")).toEqual([expect.stringMatching(/line 1: loads electron with import\(\)/)])
    expect(problems("import('electron').then(({ app }) => app.whenReady())")).toEqual([expect.stringMatching(/import\(\)/)])
    expect(problems("const { app } = require('electron')")).toEqual([expect.stringMatching(/require\(\)/)])
    expect(problems("const electron = createRequire(import.meta.url)('electron') as string")).toEqual([expect.stringMatching(/require\(\)/)])
    expect(problems("const { app } = runtimeRequire('electron')")).toEqual([expect.stringMatching(/require\(\)/)])
    expect(problems("import app = require('electron')")).toEqual([expect.stringMatching(/import = require/)])
  })

  it('refuses re-exports, namespace and bare imports, and aliases of the module', () => {
    expect(problems("export * from 'electron'")).toEqual([expect.stringMatching(/re-exports electron/)])
    expect(problems("export { app } from 'electron'")).toEqual([expect.stringMatching(/re-exports electron/)])
    expect(problems("export { default as electron } from 'electron'")).toEqual([expect.stringMatching(/re-exports electron/)])
    expect(problems("import * as E from 'electron'\nE.app.whenReady()")).toEqual([expect.stringMatching(/namespace/)])
    expect(problems("import 'electron'")).toEqual([expect.stringMatching(/side effects/)])
    expect(problems("import electron from 'electron'\nconst e = electron\ne.app.whenReady()")).toEqual([expect.stringMatching(/binary path .electron. other than to launch/)])
    expect(problems("import electron from 'electron'\nelectron.app.whenReady()")).toEqual([expect.stringMatching(/other than to launch/)])
    expect(problems("const name = 'electron'\nconst { app } = await import(name)")).toEqual([expect.stringMatching(/computed/)])
    expect(problems("const { app } = require('elec' + 'tron')")).toEqual([expect.stringMatching(/computed/)])
  })

  it('lets a file that mocks electron import() the mock, and a listed preload require renderer parts only', () => {
    expect(problems("vi.mock('electron', () => ({ app: {} }))\nconst { app } = await import('electron')")).toEqual([])
    expect(problems("const { contextBridge, ipcRenderer } = require('electron')", { preload: true })).toEqual([])
    expect(problems("const { app } = require('electron')", { preload: true })).toEqual([expect.stringMatching(/require\(\)/)])
    expect(problems("function load() { const { ipcRenderer } = require('electron') }", { preload: true })).toEqual([expect.stringMatching(/require\(\)/)])
  })
})

describe('what a launch of the Electron binary starts', () => {
  const header = "import electron from 'electron'\nimport { join, resolve } from 'node:path'\n"
  const check = (body: string, audited: Record<string, { starts: string }> = {}) => launchProblems(header + body, 't.test.ts', audited)

  it('accepts a target made of literals that is a listed entry point', () => {
    expect(check("spawn(electron as unknown as string, [resolve('tests/fixtures/turn-window/main.ts')])")).toEqual([])
    expect(check("spawn(electron as unknown as string, ['tests/fixtures/prompt-markers/main.ts', '--flag'])")).toEqual([])
    expect(check("run(electron as unknown as string, join('tests', 'fixtures', 'menu-shortcuts', 'main.ts'))")).toEqual([])
  })

  it('refuses a literal target that is not a listed entry point', () => {
    expect(check("spawn(electron as unknown as string, [resolve('tests/fixtures/other/main.ts')])")).toEqual(['t.test.ts:3 starts tests/fixtures/other/main.ts, which is not a listed entry point'])
  })

  it('refuses a computed target that is not audited, whatever a comment or a string near it says', () => {
    const body = "// Starts tests/fixtures/turn-window/main.ts, bundled.\nconst note = 'tests/fixtures/turn-window/main.ts'\nspawn(electron as unknown as string, [join(directory, 'main.mjs')])"
    expect(check(body)).toEqual([expect.stringMatching(/^t\.test\.ts:5 starts .join\(directory, 'main\.mjs'\)., which is computed and not in COMPUTED_LAUNCHES$/)])
    expect(check(body, { 't.test.ts:5': { starts: 'tests/fixtures/turn-window/main.ts' } })).toEqual([])
    expect(check(body, { 't.test.ts:4': { starts: 'tests/fixtures/turn-window/main.ts' } })).toHaveLength(1)
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

  it('reach electron only in the ways the rules allow, in files and in code written into strings', () => {
    const problems: string[] = []
    for (const { path, text } of sources) {
      for (const problem of electronAccessProblems(text, path, { preload: PRELOAD_SCRIPTS.includes(path) })) problems.push(`${path} ${problem}`)
      for (const { line, text: embedded } of embeddedSources(parse(text, path))) {
        for (const problem of electronAccessProblems(embedded, 'embedded.ts')) problems.push(`${path} (string at line ${line}) ${problem}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('are started only through launches of listed entry points, under tests/fixtures as anywhere', () => {
    const sites = sources.flatMap(({ path, text }) => launchSites(text, path).map((site) => ({ path, ...site })))
    expect(sites.length).toBeGreaterThanOrEqual(15)
    const problems = sources.flatMap(({ path, text }) => launchProblems(text, path, COMPUTED_LAUNCHES))
    expect(problems).toEqual([])
    // Every audited launch still exists, computed, and starts a listed entry point.
    const computed = new Set(sites.filter((site) => site.target === undefined).map((site) => `${site.path}:${site.line}`))
    expect(Object.keys(COMPUTED_LAUNCHES).filter((key) => !computed.has(key))).toEqual([])
    expect(Object.values(COMPUTED_LAUNCHES).map(({ starts }) => starts).filter((starts) => !ENTRY_POINTS.includes(starts))).toEqual([])
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
