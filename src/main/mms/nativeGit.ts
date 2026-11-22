import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { dropForeignAppImageMounts } from '../../cli/appImageMounts'

const run = promisify(execFile)

async function executable(file: string): Promise<boolean> {
  return access(file, constants.X_OK).then(() => true, () => false)
}

/** Find usable Git without triggering macOS's developer-tools prompt from its /usr/bin/git stub. */
export async function findNativeGit(
  platform: 'darwin' | 'linux', env: NodeJS.ProcessEnv, signal: AbortSignal
): Promise<string | undefined> {
  const path = (env.PATH ?? '').split(':').filter((dir) => isAbsolute(dir))
  const fallbacks = platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin']
    : ['/usr/local/bin', '/usr/bin', '/bin']
  for (const dir of new Set([...path, ...fallbacks])) {
    signal.throwIfAborted()
    const file = join(dir, 'git')
    if (!await executable(file)) continue
    try {
      const options = { cwd: '/', env, signal, timeout: 10_000 }
      if (platform === 'darwin' && await realpath(file) === '/usr/bin/git') {
        await run('/usr/bin/xcode-select', ['--print-path'], options)
      }
      const { stdout } = await run(file, ['--version'], options)
      if (stdout.startsWith('git version ')) return dir
    } catch {
      signal.throwIfAborted()
    }
  }
  return undefined
}

export interface NativeGitInstaller {
  command: string
  args: string[]
  platform: 'darwin' | 'linux'
  readyMessage: string
  failureMessage: string
}

const linuxPackages = [
  { name: 'APT', file: '/usr/bin/apt-get', args: ['-y', 'install', 'git'] },
  { name: 'DNF', file: '/usr/bin/dnf', args: ['-y', 'install', 'git'] },
  { name: 'Zypper', file: '/usr/bin/zypper', args: ['--non-interactive', 'install', 'git'] },
  { name: 'Pacman', file: '/usr/bin/pacman', args: ['-S', '--needed', '--noconfirm', 'git'] },
  { name: 'APK', file: '/sbin/apk', args: ['add', 'git'] }
]

export async function nativeGitInstaller(platform: 'darwin' | 'linux'): Promise<NativeGitInstaller | undefined> {
  if (platform === 'darwin') {
    return {
      platform,
      command: '/usr/bin/xcode-select',
      args: ['--install'],
      readyMessage: 'Install Git with Apple’s Command Line Tools to start the workspace.',
      failureMessage: 'Open Terminal and run xcode-select --install, then click Retry after it finishes.'
    }
  }

  // Only elevate fixed system commands. Renderer input and the user's PATH never select what runs as root.
  const authorization = '/usr/bin/pkexec'
  if (!await executable(authorization)) return undefined
  for (const manager of linuxPackages) {
    if (await executable(manager.file)) {
      return {
        platform,
        command: authorization,
        args: ['--disable-internal-agent', manager.file, ...manager.args],
        readyMessage: `Mousse can install Git with ${manager.name}. Your system may ask for approval.`,
        failureMessage: `Git setup via ${manager.name} did not finish. Try again, or install Git with your package manager and click Retry.`
      }
    }
  }
  return undefined
}

/** macOS returns as soon as it opens the system dialog. Linux waits for the package manager to exit. */
export async function installNativeGit(installer: NativeGitInstaller, signal: AbortSignal): Promise<boolean> {
  const env = { ...process.env }
  if (installer.platform === 'linux') {
    // Use host libraries when launched from an AppImage.
    delete env.APPDIR
    dropForeignAppImageMounts(env, 'linux')
  }
  const execution = run(installer.command, installer.args, { cwd: '/', env, signal, maxBuffer: 8 * 1024 * 1024 })
  execution.child.stdin?.end()
  await execution
  return installer.platform === 'linux'
}
