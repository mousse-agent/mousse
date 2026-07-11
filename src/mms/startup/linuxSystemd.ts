import fs from 'node:fs/promises'
import path from 'node:path'
import { StartupCommandError, formatManualCommand, runCommand } from './run'

export const SYSTEMD_SERVICE_NAME = 'mousse-mms'
export const SYSTEMD_UNIT_FILENAME = `${SYSTEMD_SERVICE_NAME}.service`

export function getSystemdUnitPath(homeDir: string): string {
  return path.posix.join(homeDir, '.config', 'systemd', 'user', SYSTEMD_UNIT_FILENAME)
}

export function buildSystemdUnitContent(cliPath: string, homeDir: string): string {
  return `[Unit]
Description=Mousse Main Service
After=network.target

[Service]
ExecStart=${cliPath} service run
Restart=on-failure
Environment=MOUSSE_HOME=${homeDir}

[Install]
WantedBy=default.target
`
}

export function buildSystemctlDaemonReloadArgs(): string[] {
  return ['--user', 'daemon-reload']
}

export function buildSystemctlEnableNowArgs(): string[] {
  return ['--user', 'enable', '--now', SYSTEMD_SERVICE_NAME]
}

export function buildSystemctlDisableArgs(): string[] {
  return ['--user', 'disable', '--now', SYSTEMD_SERVICE_NAME]
}

export function buildSystemctlIsEnabledArgs(): string[] {
  return ['--user', 'is-enabled', SYSTEMD_SERVICE_NAME]
}

export function buildSystemctlIsActiveArgs(): string[] {
  return ['--user', 'is-active', SYSTEMD_SERVICE_NAME]
}

export function buildSystemctlVersionArgs(): string[] {
  return ['--version']
}

async function assertSystemdAvailable(): Promise<void> {
  const versionResult = await runCommand('systemctl', buildSystemctlVersionArgs())
  if (versionResult.code !== 0) {
    const manual = formatManualCommand('systemctl', buildSystemctlVersionArgs())
    throw new StartupCommandError(
      'systemd is not available on this system (systemctl --version failed). Linux startup requires systemd user units.',
      `Verify systemd is installed:\n  ${manual}`
    )
  }
}

export async function installLinuxSystemdStartup(
  cliPath: string,
  homeDir: string
): Promise<void> {
  await assertSystemdAvailable()

  const unitPath = getSystemdUnitPath(homeDir)
  const unitDir = path.posix.dirname(unitPath)
  await fs.mkdir(unitDir, { recursive: true })
  await fs.writeFile(unitPath, buildSystemdUnitContent(cliPath, homeDir), 'utf8')

  const reloadArgs = buildSystemctlDaemonReloadArgs()
  const reloadResult = await runCommand('systemctl', reloadArgs)
  if (reloadResult.code !== 0) {
    throw new StartupCommandError(
      `Wrote ${unitPath} but systemctl daemon-reload failed: ${reloadResult.stderr.trim() || 'unknown error'}`,
      formatManualCommand('systemctl', reloadArgs)
    )
  }

  const enableArgs = buildSystemctlEnableNowArgs()
  const enableResult = await runCommand('systemctl', enableArgs)
  if (enableResult.code !== 0) {
    throw new StartupCommandError(
      `Wrote ${unitPath} but systemctl enable --now failed: ${enableResult.stderr.trim() || 'unknown error'}`,
      formatManualCommand('systemctl', enableArgs)
    )
  }
}

export async function uninstallLinuxSystemdStartup(homeDir: string): Promise<void> {
  await assertSystemdAvailable()

  const disableArgs = buildSystemctlDisableArgs()
  await runCommand('systemctl', disableArgs)

  const unitPath = getSystemdUnitPath(homeDir)
  try {
    await fs.unlink(unitPath)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') {
      throw error
    }
  }

  const reloadArgs = buildSystemctlDaemonReloadArgs()
  const reloadResult = await runCommand('systemctl', reloadArgs)
  if (reloadResult.code !== 0) {
    throw new StartupCommandError(
      `Removed unit file but systemctl daemon-reload failed: ${reloadResult.stderr.trim() || 'unknown error'}`,
      formatManualCommand('systemctl', reloadArgs)
    )
  }
}

export async function linuxSystemdStartupStatus(homeDir: string): Promise<{
  installed: boolean
  detail: string
}> {
  const unitPath = getSystemdUnitPath(homeDir)
  let unitExists = false
  try {
    await fs.access(unitPath)
    unitExists = true
  } catch {
    unitExists = false
  }

  const versionResult = await runCommand('systemctl', buildSystemctlVersionArgs())
  if (versionResult.code !== 0) {
    return {
      installed: unitExists,
      detail: unitExists
        ? `Unit file exists at ${unitPath}, but systemd is unavailable`
        : 'systemd is not available on this system'
    }
  }

  const [enabledResult, activeResult] = await Promise.all([
    runCommand('systemctl', buildSystemctlIsEnabledArgs()),
    runCommand('systemctl', buildSystemctlIsActiveArgs())
  ])

  const enabled = enabledResult.code === 0
  const active = activeResult.code === 0
  const installed = unitExists && enabled

  if (installed) {
    const activeDetail = active ? 'active' : 'inactive'
    return {
      installed: true,
      detail: `systemd user unit ${SYSTEMD_SERVICE_NAME} is enabled (${activeDetail}); unit file at ${unitPath}`
    }
  }

  if (unitExists) {
    return {
      installed: false,
      detail: `Unit file exists at ${unitPath} but service is not enabled`
    }
  }

  return {
    installed: false,
    detail: `Not installed (no unit file at ${unitPath})`
  }
}
