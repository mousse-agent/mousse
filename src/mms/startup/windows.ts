import path from 'node:path'
import { StartupCommandError, formatManualCommand, runCommand } from './run'

export const WINDOWS_TASK_NAME = 'MousseMMS'
export const WINDOWS_REGISTRY_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const WINDOWS_REGISTRY_VALUE = 'MousseMMS'

export function buildWindowsTaskRunValue(cliPath: string): string {
  return `"${cliPath}" service run`
}

export function buildSchtasksCreateArgs(cliPath: string): string[] {
  return [
    '/Create',
    '/F',
    '/SC',
    'ONLOGON',
    '/TN',
    WINDOWS_TASK_NAME,
    '/TR',
    buildWindowsTaskRunValue(cliPath)
  ]
}

export function buildSchtasksDeleteArgs(): string[] {
  return ['/Delete', '/F', '/TN', WINDOWS_TASK_NAME]
}

export function buildSchtasksQueryArgs(): string[] {
  return ['/Query', '/TN', WINDOWS_TASK_NAME, '/FO', 'LIST', '/V']
}

export function buildRegistryAddArgs(cliPath: string): string[] {
  return [
    'add',
    WINDOWS_REGISTRY_KEY,
    '/v',
    WINDOWS_REGISTRY_VALUE,
    '/t',
    'REG_SZ',
    '/d',
    buildWindowsTaskRunValue(cliPath),
    '/f'
  ]
}

export function buildRegistryDeleteArgs(): string[] {
  return ['delete', WINDOWS_REGISTRY_KEY, '/v', WINDOWS_REGISTRY_VALUE, '/f']
}

export function buildRegistryQueryArgs(): string[] {
  return ['query', WINDOWS_REGISTRY_KEY, '/v', WINDOWS_REGISTRY_VALUE]
}

async function schtasksInstalled(): Promise<boolean> {
  const result = await runCommand('schtasks', buildSchtasksQueryArgs())
  return result.code === 0
}

async function registryInstalled(): Promise<boolean> {
  const result = await runCommand('reg', buildRegistryQueryArgs())
  return result.code === 0
}

export async function installWindowsStartup(cliPath: string): Promise<void> {
  const schtasksArgs = buildSchtasksCreateArgs(cliPath)
  const schtasksResult = await runCommand('schtasks', schtasksArgs)
  if (schtasksResult.code === 0) {
    return
  }

  const regArgs = buildRegistryAddArgs(cliPath)
  const regResult = await runCommand('reg', regArgs)
  if (regResult.code === 0) {
    return
  }

  const manualSchtasks = formatManualCommand('schtasks', schtasksArgs)
  const manualReg = formatManualCommand('reg', regArgs)
  throw new StartupCommandError(
    `Failed to install Windows startup via Task Scheduler (${schtasksResult.stderr.trim() || 'unknown error'}) and registry (${regResult.stderr.trim() || 'unknown error'}).`,
    `Try manually:\n  ${manualSchtasks}\nOr registry fallback:\n  ${manualReg}`
  )
}

export async function uninstallWindowsStartup(): Promise<void> {
  const schtasksArgs = buildSchtasksDeleteArgs()
  const regArgs = buildRegistryDeleteArgs()
  const schtasksResult = await runCommand('schtasks', schtasksArgs)
  const regResult = await runCommand('reg', regArgs)

  if (schtasksResult.code === 0 || regResult.code === 0) {
    return
  }

  const manualSchtasks = formatManualCommand('schtasks', schtasksArgs)
  const manualReg = formatManualCommand('reg', regArgs)
  throw new StartupCommandError(
    'Failed to remove Windows startup from Task Scheduler and registry.',
    `Try manually:\n  ${manualSchtasks}\nOr:\n  ${manualReg}`
  )
}

export async function windowsStartupStatus(): Promise<{
  installed: boolean
  detail: string
}> {
  const [taskInstalled, runKeyInstalled] = await Promise.all([
    schtasksInstalled(),
    registryInstalled()
  ])

  if (taskInstalled && runKeyInstalled) {
    return {
      installed: true,
      detail: `Installed via Task Scheduler (${WINDOWS_TASK_NAME}) and registry Run key (${WINDOWS_REGISTRY_VALUE})`
    }
  }

  if (taskInstalled) {
    return {
      installed: true,
      detail: `Installed via Task Scheduler task "${WINDOWS_TASK_NAME}"`
    }
  }

  if (runKeyInstalled) {
    return {
      installed: true,
      detail: `Installed via registry Run key "${WINDOWS_REGISTRY_VALUE}" at ${WINDOWS_REGISTRY_KEY}`
    }
  }

  return {
    installed: false,
    detail: `Not installed (no Task Scheduler task "${WINDOWS_TASK_NAME}" or registry value "${WINDOWS_REGISTRY_VALUE}")`
  }
}

export function resolveWindowsCliPath(cliPath: string): string {
  return path.resolve(cliPath)
}
