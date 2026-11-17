import { sep } from 'path'

/**
 * Search-path variables that AppImage runtimes put their private mount on. Electron-builder's AppRun
 * prepends `$APPDIR` entries to all of these.
 */
const PATH_LISTS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR', 'QT_PLUGIN_PATH', 'PYTHONPATH', 'PERL5LIB'] as const

/** An AppImage mounts itself at `$TMPDIR/.mount_<name><random>` for as long as that process runs. */
function inAppImageMount(entry: string): boolean {
  return entry.split(sep).some((part) => part.startsWith('.mount_'))
}

function inside(entry: string, dir: string): boolean {
  return entry === dir || entry.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/**
 * The service outlives the program that started it. When that was a Mousse window or another app
 * packaged as an AppImage (an editor, T3 Code), its search paths point into that app's private
 * mount, which goes away when the app quits. The dead mount then fails every lookup on PATH with
 * `ENOTCONN` instead of moving on to the next entry, so the service can no longer start `git` or
 * agents, and every send fails. Only the service's own mount (`APPDIR`) lives as long as it does.
 */
export function withoutForeignAppImageMounts(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const own = env.APPDIR
  const changes: Record<string, string | undefined> = {}
  for (const name of PATH_LISTS) {
    const value = env[name]
    if (!value || !value.includes('.mount_')) continue
    const entries = value.split(':')
    const kept = entries.filter((entry) => !inAppImageMount(entry) || (own ? inside(entry, own) : false))
    if (kept.length === entries.length) continue
    changes[name] = kept.length > 0 ? kept.join(':') : undefined
  }
  return changes
}

/** Removes other AppImages' mounts from this process's search paths, so programs it starts later resolve. */
export function dropForeignAppImageMounts(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'linux') return
  for (const [name, value] of Object.entries(withoutForeignAppImageMounts(env))) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
}
