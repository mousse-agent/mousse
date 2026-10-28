import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, posix, win32 } from 'node:path'
import { app, nativeImage, shell } from 'electron'
import type { RemoteOpenResult } from '../shared/remoteEditor'
import { EDITOR_PROXY_READY } from '../shared/remoteEditor'
import type { EditorInfo } from '../shared/types'
import { isBatchLauncher, RemoteOpenError, remoteExtensionHint, remoteLaunchArguments, supportsRemoteFolders } from './remoteEditor'
import { resolveRemoteOpen, type Ask } from './remoteEditorFlow'

interface EditorDefinition {
  id: string
  label: string
  /** macOS app bundle names without `.app`; the first installed one wins. */
  apps: readonly string[]
  /** Command-line launchers looked up on PATH (Linux and Windows). */
  cli: readonly string[]
  /** Windows install locations relative to `%LOCALAPPDATA%\Programs` and the Program Files folders. */
  windows?: readonly string[]
  macOnly?: boolean
}

/** Detection and display order. */
export const EDITOR_CATALOG: readonly EditorDefinition[] = [
  { id: 'vscode', label: 'VS Code', apps: ['Visual Studio Code'], cli: ['code'], windows: ['Microsoft VS Code\\Code.exe'] },
  { id: 'cursor', label: 'Cursor', apps: ['Cursor'], cli: ['cursor'], windows: ['cursor\\Cursor.exe'] },
  { id: 'windsurf', label: 'Windsurf', apps: ['Windsurf'], cli: ['windsurf'], windows: ['Windsurf\\Windsurf.exe'] },
  { id: 'zed', label: 'Zed', apps: ['Zed'], cli: ['zed', 'zeditor'], windows: ['Zed\\Zed.exe'] },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    apps: ['Visual Studio Code - Insiders'],
    cli: ['code-insiders'],
    windows: ['Microsoft VS Code Insiders\\Code - Insiders.exe']
  },
  { id: 'vscodium', label: 'VSCodium', apps: ['VSCodium'], cli: ['codium'], windows: ['VSCodium\\VSCodium.exe'] },
  { id: 'antigravity', label: 'Antigravity', apps: ['Antigravity', 'Antigravity IDE'], cli: ['antigravity'], windows: ['Antigravity\\Antigravity.exe'] },
  { id: 'kiro', label: 'Kiro', apps: ['Kiro'], cli: ['kiro'], windows: ['Kiro\\Kiro.exe'] },
  { id: 'trae', label: 'Trae', apps: ['Trae'], cli: ['trae'], windows: ['Trae\\Trae.exe'] },
  { id: 'sublime', label: 'Sublime Text', apps: ['Sublime Text'], cli: ['subl'] },
  { id: 'nova', label: 'Nova', apps: ['Nova'], cli: [], macOnly: true },
  { id: 'idea', label: 'IntelliJ IDEA', apps: ['IntelliJ IDEA', 'IntelliJ IDEA Ultimate', 'IntelliJ IDEA CE'], cli: ['idea'] },
  { id: 'webstorm', label: 'WebStorm', apps: ['WebStorm'], cli: ['webstorm'] },
  { id: 'pycharm', label: 'PyCharm', apps: ['PyCharm', 'PyCharm CE', 'PyCharm Professional Edition'], cli: ['pycharm'] },
  { id: 'goland', label: 'GoLand', apps: ['GoLand'], cli: ['goland'] },
  { id: 'rustrover', label: 'RustRover', apps: ['RustRover'], cli: ['rustrover'] },
  { id: 'clion', label: 'CLion', apps: ['CLion'], cli: ['clion'] },
  { id: 'rider', label: 'Rider', apps: ['Rider'], cli: ['rider'] },
  { id: 'phpstorm', label: 'PhpStorm', apps: ['PhpStorm'], cli: ['phpstorm'] },
  { id: 'android-studio', label: 'Android Studio', apps: ['Android Studio'], cli: ['studio'] },
  { id: 'xcode', label: 'Xcode', apps: ['Xcode'], cli: [], macOnly: true }
]

export const FILES_EDITOR_ID = 'files'

export interface DetectedEditor {
  id: string
  label: string
  /** macOS: the `.app` bundle. */
  appPath?: string
  /** Linux and Windows: the launcher executable. */
  launcherPath?: string
}

export interface EditorDetectionEnv {
  platform: NodeJS.Platform
  home: string
  localAppData?: string
  /** `%ProgramFiles%` and `%ProgramFiles(x86)%`, for system-wide installs. */
  programFiles?: readonly string[]
  exists: (path: string) => boolean
  /** Resolves a command name to an executable on PATH, or null. */
  findOnPath: (name: string) => string | null
}

export function filesLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Finder'
  if (platform === 'win32') return 'File Explorer'
  return 'Files'
}

/** Detected editors in catalog order. The file-manager entry is added by the caller. */
export function detectEditors(env: EditorDetectionEnv): DetectedEditor[] {
  const found: DetectedEditor[] = []
  for (const definition of EDITOR_CATALOG) {
    const { id, label } = definition
    if (env.platform === 'darwin') {
      const roots = ['/Applications', join(env.home, 'Applications')]
      const appPath = definition.apps
        .flatMap((name) => roots.map((root) => `${root}/${name}.app`))
        .find((candidate) => env.exists(candidate))
      if (appPath) found.push({ id, label, appPath })
      continue
    }
    if (definition.macOnly) continue
    let launcherPath: string | null = null
    if (env.platform === 'win32') {
      const roots = [...(env.localAppData ? [win32.join(env.localAppData, 'Programs')] : []), ...(env.programFiles ?? [])]
      launcherPath = (definition.windows ?? [])
        .flatMap((relative) => roots.map((root) => win32.join(root, relative)))
        .find((candidate) => env.exists(candidate)) ?? null
    }
    for (const name of definition.cli) {
      if (launcherPath) break
      launcherPath = env.findOnPath(name)
    }
    if (launcherPath) found.push({ id, label, launcherPath })
  }
  return found
}

/** Looks up a command in a PATH string. On Windows only `.exe` launchers are used, since `.cmd` needs a shell. */
export function scanPath(
  name: string,
  pathEnv: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean
): string | null {
  const fileName = platform === 'win32' ? `${name}.exe` : name
  for (const dir of pathEnv.split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue
    const candidate = join(dir, fileName)
    if (exists(candidate)) return candidate
  }
  return null
}

function realEnv(): EditorDetectionEnv {
  const platform = process.platform
  const pathEnv = process.env.PATH ?? ''
  return {
    platform,
    home: homedir(),
    localAppData: process.env.LOCALAPPDATA,
    programFiles: [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((value): value is string => Boolean(value)),
    exists: existsSync,
    findOnPath: (name) => scanPath(name, pathEnv, platform, existsSync)
  }
}

let cache: { detected: DetectedEditor[]; infos: EditorInfo[] } | null = null
let pending: Promise<{ detected: DetectedEditor[]; infos: EditorInfo[] }> | null = null

/** 32px so the 16px icon stays sharp on Retina displays. */
const ICON_SIZE = { width: 32, height: 32 }

/** The file whose icon stands for an editor: the macOS bundle or the Windows launcher. Linux launchers carry no icon of their own. */
export function editorIconSource(editor: DetectedEditor, platform: NodeJS.Platform): string | undefined {
  if (platform === 'darwin') return editor.appPath
  if (platform === 'win32') return editor.launcherPath
  return undefined
}

/** The file manager's own executable, whose icon labels the folder entry. */
export function filesIconSource(platform: NodeJS.Platform, systemRoot?: string): string | undefined {
  if (platform === 'darwin') return '/System/Library/CoreServices/Finder.app'
  if (platform === 'win32') return win32.join(systemRoot ?? 'C:\\Windows', 'explorer.exe')
  return undefined
}

async function iconFor(path: string, platform: NodeJS.Platform): Promise<string | undefined> {
  if (!existsSync(path)) return undefined
  // macOS: getFileIcon returns the generic bundle icon for apps; the Quick Look thumbnail is the app's own.
  if (platform === 'darwin') {
    try {
      const image = await nativeImage.createThumbnailFromPath(path, ICON_SIZE)
      if (!image.isEmpty()) return image.toDataURL()
    } catch {
      // Fall through to the file icon.
    }
  }
  // Windows: an .exe's file icon is the app's own, 32px at `normal`.
  try {
    const image = await app.getFileIcon(path, { size: 'normal' })
    return image.isEmpty() ? undefined : image.toDataURL()
  } catch {
    return undefined
  }
}

async function detect(): Promise<{ detected: DetectedEditor[]; infos: EditorInfo[] }> {
  const env = realEnv()
  const detected = detectEditors(env)
  const infos: EditorInfo[] = await Promise.all(
    detected.map(async (editor): Promise<EditorInfo> => {
      const source = editorIconSource(editor, env.platform)
      const iconDataUrl = source ? await iconFor(source, env.platform) : undefined
      return {
        id: editor.id,
        label: editor.label,
        kind: 'editor',
        ...(supportsRemoteFolders(editor.id) ? { remote: true as const } : {}),
        ...(iconDataUrl ? { iconDataUrl } : {})
      }
    })
  )
  const filesSource = filesIconSource(env.platform, process.env.SystemRoot)
  const filesIcon = filesSource ? await iconFor(filesSource, env.platform) : undefined
  infos.push({ id: FILES_EDITOR_ID, label: filesLabel(env.platform), kind: 'files', ...(filesIcon ? { iconDataUrl: filesIcon } : {}) })
  return { detected, infos }
}

async function ensureDetected(refresh = false): Promise<{ detected: DetectedEditor[]; infos: EditorInfo[] }> {
  if (!refresh && cache) return cache
  if (!pending) {
    pending = detect()
      .then((result) => {
        cache = result
        return result
      })
      .finally(() => {
        pending = null
      })
  }
  return pending
}

export async function listEditors(options?: { refresh?: boolean }): Promise<EditorInfo[]> {
  return (await ensureDetected(options?.refresh === true)).infos
}

async function assertFolder(path: string): Promise<void> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Choose an absolute folder path to open.')
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) throw new Error('That folder does not exist.')
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()))
  })
}

function launch(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    // Never through a shell, and never a batch file: its arguments would be read by cmd.exe.
    if (process.platform === 'win32' && isBatchLauncher(command)) return reject(new Error('A batch file cannot start an editor.'))
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, ...(env ? { env } : {}) })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export async function openInEditor(editorId: string, path: string): Promise<void> {
  await assertFolder(path)
  if (editorId === FILES_EDITOR_ID) {
    const failure = await shell.openPath(path)
    if (failure) throw new Error(failure)
    return
  }
  const { detected } = await ensureDetected()
  const editor = detected.find((entry) => entry.id === editorId)
  if (!editor) throw new Error('That editor is not installed.')
  const target = editor.appPath ?? editor.launcherPath
  if (!target || !existsSync(target)) {
    cache = null
    throw new Error(`${editor.label} is no longer installed.`)
  }
  if (process.platform === 'darwin') await run('open', ['-a', target, path])
  else await launch(target, [path])
}

/**
 * The program that opens a remote folder. On macOS the editor's own command inside the app bundle, since
 * `open -a` drops its arguments when the editor is already running; elsewhere the launcher found at detection.
 */
export function remoteLauncher(editor: DetectedEditor, env: EditorDetectionEnv): string | null {
  if (editor.appPath) {
    const names = EDITOR_CATALOG.find((definition) => definition.id === editor.id)?.cli ?? []
    // An app bundle only exists on macOS, so its paths are POSIX whatever runs this. VS Code's own bundle keeps
    // its script as `bin/code` (the name `code-insiders` is the command a person installs on PATH), so the
    // VS Code family tries that name too.
    const inBundle = [...names, ...(editor.id.startsWith('vscode') || editor.id === 'cursor' ? ['code'] : [])]
    const bundled = inBundle.map((name) => posix.join(editor.appPath!, 'Contents', 'Resources', 'app', 'bin', name))
    const found = bundled.find((candidate) => env.exists(candidate))
    if (found) return found
    for (const name of names) {
      const onPath = env.findOnPath(name)
      if (onPath) return onPath
    }
    return null
  }
  return editor.launcherPath ?? null
}

/**
 * The command that starts `editor`, or a `RemoteOpenError` when there is none, or it is a batch file (the
 * editors' own programs are executables, and a batch file would pass an address through cmd.exe). Starts nothing.
 */
export function remoteEditorCommand(editor: DetectedEditor, env: EditorDetectionEnv): string {
  const command = remoteLauncher(editor, env)
  if (!command || (env.platform === 'win32' && isBatchLauncher(command))) {
    throw new RemoteOpenError('editor_missing', `Could not find the command that starts ${editor.label}.`)
  }
  return command
}

/** The folders inside the editor's own app where it keeps the extensions that ship with it. */
export function builtInExtensionDirectories(
  editor: DetectedEditor,
  resolve: (path: string) => string = (path) => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
): string[] {
  if (editor.appPath) return [posix.join(editor.appPath, 'Contents', 'Resources', 'app', 'extensions')]
  if (!editor.launcherPath) return []
  // Windows: `Code.exe` sits in the install folder. Linux: `bin/code`, often a link, in the install folder.
  const windows = /^[A-Za-z]:[\\/]/u.test(editor.launcherPath)
  if (windows) return [win32.join(win32.dirname(editor.launcherPath), 'resources', 'app', 'extensions')]
  const real = resolve(editor.launcherPath)
  return [posix.join(posix.dirname(posix.dirname(real)), 'resources', 'app', 'extensions'), posix.join(posix.dirname(real), 'resources', 'app', 'extensions')]
}

/**
 * Environment variables of this process that would send the editor's command to another editor, or make it
 * run as a plain Node program. An editor that launched Mousse (a development terminal) leaves them behind.
 */
export function editorLaunchEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (/^(?:VSCODE_|ELECTRON_)/iu.test(key) || /^NODE_OPTIONS$/iu.test(key)) continue
    clean[key] = value
  }
  return clean
}

export interface RemoteOpenPlan {
  command: string
  args: string[]
}

/** The command that would open `folder` in `editor` over `host`, or a `RemoteOpenError`. Starts nothing. */
export function planRemoteOpen(
  editor: DetectedEditor,
  input: { host: Parameters<typeof remoteLaunchArguments>[0]['host']; folder: unknown },
  env: EditorDetectionEnv
): RemoteOpenPlan {
  const command = remoteEditorCommand(editor, env)
  const { args } = remoteLaunchArguments({ editorId: editor.id, host: input.host, folder: input.folder })
  return { command, args }
}

/** What opening a remote folder touches on this computer. Tests give fakes, so no editor or SSH starts. */
export interface RemoteOpenIo {
  detected: () => Promise<DetectedEditor[]>
  env: () => EditorDetectionEnv
  launch: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>
  /** The editor's extension folders, or undefined when one cannot be read. */
  list: (path: string) => string[] | undefined
  /** The environment of this process, given to the editor's command without the variables that redirect it. */
  processEnv: () => NodeJS.ProcessEnv
  forgetDetected: () => void
  /** Whether Mousse's own SSH names reach a computer. */
  proxyReady: boolean
}

const defaultRemoteOpenIo: RemoteOpenIo = {
  detected: async () => (await ensureDetected()).detected,
  env: realEnv,
  launch,
  list: (path) => {
    try {
      return readdirSync(path)
    } catch {
      return undefined
    }
  },
  processEnv: () => process.env,
  forgetDetected: () => {
    cache = null
  },
  proxyReady: EDITOR_PROXY_READY
}

/**
 * Opens the folder a thread of another computer works in, in an editor installed on this one, over SSH.
 * `ask` reaches the daemon of this computer, which routes the thread's calls to the computer that runs it.
 * Refusals the person can act on come back as a result; anything else is thrown.
 */
export async function openRemoteInEditor(
  editorId: string,
  threadId: string,
  ask: Ask,
  io: RemoteOpenIo = defaultRemoteOpenIo
): Promise<RemoteOpenResult> {
  if (typeof editorId !== 'string' || !supportsRemoteFolders(editorId)) {
    return { ok: false, reason: 'editor_missing', message: 'That editor cannot open a folder on another computer. Choose VS Code, Cursor, Windsurf or VSCodium.' }
  }
  const editor = (await io.detected()).find((entry) => entry.id === editorId)
  if (!editor) return { ok: false, reason: 'editor_missing', message: 'That editor is not installed.' }
  const env = io.env()
  try {
    // The editor must be able to start before anything is asked or written for it.
    remoteEditorCommand(editor, env)
    const resolved = await resolveRemoteOpen(ask, threadId, { proxyReady: io.proxyReady })
    if (!resolved.ok) return resolved
    const { command, args } = planRemoteOpen(editor, resolved, env)
    if (!env.exists(command)) {
      io.forgetDetected()
      return { ok: false, reason: 'editor_missing', message: `${editor.label} is no longer installed.` }
    }
    await io.launch(command, args, editorLaunchEnvironment(io.processEnv()))
    // Only a hint: the editor asks for the extension itself when it is really missing.
    const hint = remoteExtensionHint(editor.id, env.home, builtInExtensionDirectories(editor), io.list)
    return { ok: true, ...(hint ? { hint } : {}) }
  } catch (error) {
    if (error instanceof RemoteOpenError) return { ok: false, reason: error.reason, message: error.message }
    throw error
  }
}
