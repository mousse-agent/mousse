import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StartupCommandError, formatManualCommand, runCommand } from './run'

export const MACOS_LABEL = 'com.ryspa.mousse.mms'
export const MACOS_PLIST_FILENAME = `${MACOS_LABEL}.plist`

export function getLaunchAgentPath(homeDir: string): string {
  return path.posix.join(homeDir, 'Library', 'LaunchAgents', MACOS_PLIST_FILENAME)
}

export function buildLaunchAgentPlist(cliPath: string, homeDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(cliPath)}</string>
    <string>service</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MOUSSE_HOME</key>
    <string>${escapeXml(homeDir)}</string>
  </dict>
</dict>
</plist>
`
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function getGuiDomain(uid: number = os.userInfo().uid): string {
  return `gui/${uid}`
}

export function buildLaunchctlBootstrapArgs(
  plistPath: string,
  uid: number = os.userInfo().uid
): string[] {
  return ['bootstrap', getGuiDomain(uid), plistPath]
}

export function buildLaunchctlLoadArgs(plistPath: string): string[] {
  return ['load', '-w', plistPath]
}

export function buildLaunchctlBootoutArgs(
  plistPath: string,
  uid: number = os.userInfo().uid
): string[] {
  return ['bootout', getGuiDomain(uid), plistPath]
}

export function buildLaunchctlPrintArgs(uid: number = os.userInfo().uid): string[] {
  return ['print', `${getGuiDomain(uid)}/${MACOS_LABEL}`]
}

export async function installMacosStartup(cliPath: string, homeDir: string): Promise<void> {
  const plistPath = getLaunchAgentPath(homeDir)
  const launchAgentsDir = path.posix.dirname(plistPath)
  await fs.mkdir(launchAgentsDir, { recursive: true })
  await fs.writeFile(plistPath, buildLaunchAgentPlist(cliPath, homeDir), 'utf8')

  const bootstrapArgs = buildLaunchctlBootstrapArgs(plistPath)
  const bootstrapResult = await runCommand('launchctl', bootstrapArgs)
  if (bootstrapResult.code === 0) {
    return
  }

  const loadArgs = buildLaunchctlLoadArgs(plistPath)
  const loadResult = await runCommand('launchctl', loadArgs)
  if (loadResult.code === 0) {
    return
  }

  const manualBootstrap = formatManualCommand('launchctl', bootstrapArgs)
  const manualLoad = formatManualCommand('launchctl', loadArgs)
  throw new StartupCommandError(
    `Wrote ${plistPath} but launchctl bootstrap and load both failed.`,
    `Try manually:\n  ${manualBootstrap}\nOr on older macOS:\n  ${manualLoad}`
  )
}

export async function uninstallMacosStartup(homeDir: string): Promise<void> {
  const plistPath = getLaunchAgentPath(homeDir)
  const bootoutArgs = buildLaunchctlBootoutArgs(plistPath)
  await runCommand('launchctl', bootoutArgs)

  try {
    await fs.unlink(plistPath)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') {
      throw error
    }
  }
}

export async function macosStartupStatus(homeDir: string): Promise<{
  installed: boolean
  detail: string
}> {
  const plistPath = getLaunchAgentPath(homeDir)
  let plistExists = false
  try {
    await fs.access(plistPath)
    plistExists = true
  } catch {
    plistExists = false
  }

  const printResult = await runCommand('launchctl', buildLaunchctlPrintArgs())
  const loaded = printResult.code === 0

  if (loaded) {
    return {
      installed: true,
      detail: `launchd agent ${MACOS_LABEL} is loaded; plist at ${plistPath}`
    }
  }

  if (plistExists) {
    return {
      installed: false,
      detail: `Plist exists at ${plistPath} but agent is not loaded in launchd`
    }
  }

  return {
    installed: false,
    detail: `Not installed (no plist at ${plistPath})`
  }
}
