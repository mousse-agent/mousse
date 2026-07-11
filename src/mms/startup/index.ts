import os from 'node:os'
import {
  installLinuxSystemdStartup,
  linuxSystemdStartupStatus,
  uninstallLinuxSystemdStartup
} from './linuxSystemd'
import {
  installMacosStartup,
  macosStartupStatus,
  uninstallMacosStartup
} from './macos'
import {
  installWindowsStartup,
  resolveWindowsCliPath,
  uninstallWindowsStartup,
  windowsStartupStatus
} from './windows'

export type StartupPlatform = 'windows' | 'linux-systemd' | 'macos'

export function detectPlatform(): StartupPlatform {
  if (process.platform === 'win32') {
    return 'windows'
  }
  if (process.platform === 'darwin') {
    return 'macos'
  }
  return 'linux-systemd'
}

function resolveHomeDir(homeDir?: string): string {
  return homeDir ?? os.homedir()
}

export async function installStartup(opts: {
  cliPath: string
  homeDir: string
}): Promise<void> {
  const platform = detectPlatform()
  const homeDir = resolveHomeDir(opts.homeDir)
  const cliPath =
    platform === 'windows' ? resolveWindowsCliPath(opts.cliPath) : opts.cliPath

  switch (platform) {
    case 'windows':
      return installWindowsStartup(cliPath)
    case 'linux-systemd':
      return installLinuxSystemdStartup(cliPath, homeDir)
    case 'macos':
      return installMacosStartup(cliPath, homeDir)
  }
}

export async function uninstallStartup(): Promise<void> {
  const platform = detectPlatform()
  const homeDir = resolveHomeDir()

  switch (platform) {
    case 'windows':
      return uninstallWindowsStartup()
    case 'linux-systemd':
      return uninstallLinuxSystemdStartup(homeDir)
    case 'macos':
      return uninstallMacosStartup(homeDir)
  }
}

export async function startupStatus(): Promise<{ installed: boolean; detail: string }> {
  const platform = detectPlatform()
  const homeDir = resolveHomeDir()

  switch (platform) {
    case 'windows':
      return windowsStartupStatus()
    case 'linux-systemd':
      return linuxSystemdStartupStatus(homeDir)
    case 'macos':
      return macosStartupStatus(homeDir)
  }
}
