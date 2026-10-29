import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** The icon theme name launchers use; the file sits in the user's hicolor theme. */
export const LAUNCHER_ICON_NAME = 'mousse'
/** Matches the Wayland app id Electron derives from the package name, so the window joins its launcher. */
const CREATED_LAUNCHER = 'mousse.desktop'
const ICON_SIZE_DIR = '512x512'
const APPIMAGE_NAME = /^mousse.*\.appimage$/i

export interface LauncherSyncOptions {
  /** The AppImage that should start Mousse from now on. */
  appImage: string
  /** An AppImage path an update just replaced, which launchers may still name. */
  previousAppImage?: string
  /** The icon this build ships. */
  iconSource?: string
  env: NodeJS.ProcessEnv
  home: string
  /** Rebuilds the desktop's menu and icon caches. */
  refresh?: (changes: LauncherChanges) => void
}

export interface LauncherChanges {
  applicationsDir: string
  iconThemeDir: string
  /** Launcher files written, created ones included. */
  launchers: string[]
  created: boolean
  iconChanged: boolean
}

function dataHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.XDG_DATA_HOME && env.XDG_DATA_HOME.startsWith('/') ? env.XDG_DATA_HOME : join(home, '.local', 'share')
}

// Desktop entry values escape `\` and control characters at the file level, then Exec quotes
// arguments and escapes `"`, `` ` ``, `$` and `\` inside the quotes.
function unescapeValue(value: string): string {
  return value.replace(/\\([\\sntr])/g, (_, c: string) => ({ '\\': '\\', s: ' ', n: '\n', t: '\t', r: '\r' })[c]!)
}

function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\')
}

/** Splits an unescaped Exec value into its program and the untouched rest. */
function splitProgram(exec: string): { program: string; rest: string } {
  const text = exec.trimStart()
  if (!text.startsWith('"')) {
    const end = text.search(/\s/)
    return end < 0 ? { program: text, rest: '' } : { program: text.slice(0, end), rest: text.slice(end) }
  }
  let program = ''
  for (let i = 1; i < text.length; i += 1) {
    const c = text[i]!
    if (c === '\\' && i + 1 < text.length) program += text[++i]
    else if (c === '"') return { program, rest: text.slice(i + 1) }
    else program += c
  }
  return { program, rest: '' }
}

function quoteProgram(path: string): string {
  return /[\s"'\\><~|&;$*?#()`]/.test(path) ? `"${path.replace(/["`$\\]/g, '\\$&')}"` : path
}

/** True when a launcher's program is this Mousse, under its current or an earlier file name. */
function isMousseProgram(program: string, options: LauncherSyncOptions): boolean {
  if (program === options.appImage || program === options.previousAppImage) return true
  // An update in another session already removed the file this launcher named.
  return dirname(program) === dirname(options.appImage) && APPIMAGE_NAME.test(basename(program)) && !existsSync(program)
}

/** Points a launcher's Exec lines at the current AppImage and its Icon at the theme icon. */
export function rewriteLauncher(text: string, options: LauncherSyncOptions): string | null {
  let ours = false
  let section = ''
  const lines = text.split('\n').map((line) => {
    const header = /^\s*\[(.+)\]\s*$/.exec(line)
    if (header) {
      section = header[1]!
      return line
    }
    const exec = /^(\s*(?:Try)?Exec\s*=\s*)(.*)$/.exec(line)
    if (!exec) return line
    const { program, rest } = splitProgram(unescapeValue(exec[2]!))
    if (!isMousseProgram(program, options)) return line
    ours = true
    return `${exec[1]}${escapeValue(quoteProgram(options.appImage) + rest)}`
  })
  if (!ours) return null
  section = ''
  let iconSet = false
  let entryEnd = -1
  const withIcon = lines.map((line, index) => {
    const header = /^\s*\[(.+)\]\s*$/.exec(line)
    if (header) section = header[1]!
    if (section === 'Desktop Entry' && line.trim()) entryEnd = index
    if (section === 'Desktop Entry' && /^\s*Icon\s*=/.test(line)) {
      iconSet = true
      return `Icon=${LAUNCHER_ICON_NAME}`
    }
    return line
  })
  if (!iconSet && entryEnd >= 0) withIcon.splice(entryEnd + 1, 0, `Icon=${LAUNCHER_ICON_NAME}`)
  return withIcon.join('\n')
}

function createdLauncher(appImage: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Mousse',
    'Comment=AI coding workspace',
    `Exec=${escapeValue(quoteProgram(appImage))}`,
    `Icon=${LAUNCHER_ICON_NAME}`,
    'Terminal=false',
    'Categories=Development;IDE;',
    'StartupWMClass=Mousse',
    ''
  ].join('\n')
}

function writeAtomic(path: string, content: string | Buffer): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content)
  renameSync(temp, path)
}

/**
 * Keeps the user's Mousse launchers working across AppImage updates: launchers that name this
 * AppImage, the one an update replaced, or a Mousse AppImage that no longer exists beside it now
 * start the current file and show this build's icon. Creates a launcher when there is none.
 */
export function syncLinuxLauncher(options: LauncherSyncOptions): LauncherChanges {
  const share = dataHome(options.env, options.home)
  const applicationsDir = join(share, 'applications')
  const iconThemeDir = join(share, 'icons', 'hicolor')
  const changes: LauncherChanges = { applicationsDir, iconThemeDir, launchers: [], created: false, iconChanged: false }

  if (options.iconSource && existsSync(options.iconSource)) {
    const iconPath = join(iconThemeDir, ICON_SIZE_DIR, 'apps', `${LAUNCHER_ICON_NAME}.png`)
    const icon = readFileSync(options.iconSource)
    if (!existsSync(iconPath) || !readFileSync(iconPath).equals(icon)) {
      mkdirSync(dirname(iconPath), { recursive: true })
      writeAtomic(iconPath, icon)
      changes.iconChanged = true
    }
  }

  mkdirSync(applicationsDir, { recursive: true })
  let found = false
  for (const name of readdirSync(applicationsDir)) {
    if (!name.endsWith('.desktop')) continue
    const path = join(applicationsDir, name)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const next = rewriteLauncher(text, options)
    if (next === null) continue
    found = true
    if (next === text) continue
    writeAtomic(path, next)
    changes.launchers.push(path)
  }
  const createdPath = join(applicationsDir, CREATED_LAUNCHER)
  if (!found && !existsSync(createdPath)) {
    writeAtomic(createdPath, createdLauncher(options.appImage))
    changes.launchers.push(createdPath)
    changes.created = true
  }

  if (changes.launchers.length > 0 || changes.iconChanged) (options.refresh ?? refreshDesktopCaches)(changes)
  return changes
}

function run(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true })
      child.on('error', () => resolve(false))
      child.on('exit', (code) => resolve(code === 0))
      child.unref()
    } catch {
      resolve(false)
    }
  })
}

/** Asks GNOME, KDE and other desktops to read the changed launchers and icon again. */
export function refreshDesktopCaches(changes: LauncherChanges): void {
  // GTK notices icon changes by the theme folder's time stamp.
  try {
    const now = new Date()
    utimesSync(changes.iconThemeDir, now, now)
  } catch {
    // No icon folder yet.
  }
  // A theme with a cache file ignores icons the cache does not list, so only an existing cache is rebuilt.
  if (existsSync(join(changes.iconThemeDir, 'icon-theme.cache'))) {
    void run('gtk-update-icon-cache', ['-f', '-t', '-q', changes.iconThemeDir])
  }
  void run('update-desktop-database', ['-q', changes.applicationsDir])
  // KDE's menu reads launchers from its sycoca cache.
  void run('kbuildsycoca6', []).then((ok) => ok || run('kbuildsycoca5', []))
}

