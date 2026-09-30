import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

// Chromium's installer grants these capabilities access to its installation files.
// https://github.com/chromium/chromium/blob/main/chrome/installer/setup/configure_app_container_sandbox.cc
const INSTALL_CAPABILITIES = [
  'S-1-15-3-1024-3424233489-972189580-2057154623-747635277-1604371224-316187997-3786583170-1043257646',
  'S-1-15-3-1024-2302894289-466761758-1166120688-1039016420-2430351297-4240214049-4028510897-3317428798'
]
const repaired = new Map()

function strictChild(root, target) {
  const path = relative(root, target)
  return path !== '' && path !== '..' && !path.startsWith(`..\\`) && !path.startsWith('../') && !isAbsolute(path)
}

function inspectTree(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`Managed browser permission target contains a link: ${path}`)
  if (stat.isFile() && stat.nlink > 1) throw new Error(`Managed browser permission target contains a hard link: ${path}`)
  if (stat.isDirectory()) for (const entry of readdirSync(path)) inspectTree(join(path, entry))
}

export function ensureWindowsBrowserSandboxAccess(browserRoot, installDirectory) {
  if (process.platform !== 'win32') return
  const root = resolve(browserRoot)
  const target = resolve(installDirectory)
  if (!strictChild(root, target)) throw new Error('Browser sandbox permissions must target an installation below its managed root.')
  const installation = relative(root, target).replaceAll('\\', '/')
  if (!/^(?:binaries\/(?:certified|staging\/unpack)|versions\/win(?:32|64)-\d+(?:\.\d+){3}|\.mousse-staging\/mousse-[\w-]+\/extracted)\/chrome-win(?:32|64)$/.test(installation)) {
    throw new Error('Browser sandbox permissions require a recognized managed binary installation directory.')
  }
  const identity = lstatSync(target)
  const cacheKey = `${root}\0${target}`
  const fingerprint = `${identity.dev}:${identity.ino}:${identity.birthtimeMs}`
  let current = root
  for (const part of ['', ...relative(root, target).split(/[\\/]/)]) {
    if (part) current = join(current, part)
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Managed browser permission path is not a real directory: ${current}`)
  }
  if (!strictChild(realpathSync.native(root), realpathSync.native(target))) throw new Error('Browser sandbox permission target escapes its canonical managed root.')
  if (repaired.get(cacheKey) === fingerprint) return
  inspectTree(target)
  try {
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
    if (!/^[a-z]:[\\/]/i.test(windowsRoot)) throw new Error('Windows system directory must be an absolute local path.')
    const systemDirectory = realpathSync.native(join(windowsRoot, 'System32'))
    const executable = realpathSync.native(join(systemDirectory, 'icacls.exe'))
    if (!strictChild(systemDirectory, executable) || !lstatSync(executable).isFile()) throw new Error('Windows ACL utility is outside the system directory.')
    execFileSync(executable, [target, '/grant', ...INSTALL_CAPABILITIES.map(sid => `*${sid}:(OI)(CI)(RX)`), '/T', '/Q'], {
      windowsHide: true, stdio: 'pipe', timeout: 60_000
    })
    repaired.set(cacheKey, fingerprint)
  } catch (error) {
    throw new Error(`Cannot provision Chromium sandbox read/execute access to ${target}. Repair this managed installation's permissions or choose an accessible managed browser directory.`, { cause: error })
  }
}
