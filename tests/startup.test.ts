import { describe, expect, it } from 'vitest'
import {
  SYSTEMD_SERVICE_NAME,
  SYSTEMD_UNIT_FILENAME,
  buildSystemctlDaemonReloadArgs,
  buildSystemctlEnableNowArgs,
  buildSystemctlIsActiveArgs,
  buildSystemctlIsEnabledArgs,
  buildSystemdUnitContent,
  getSystemdUnitPath
} from '../src/mms/startup/linuxSystemd'
import {
  MACOS_LABEL,
  MACOS_PLIST_FILENAME,
  buildLaunchAgentPlist,
  buildLaunchctlBootstrapArgs,
  buildLaunchctlBootoutArgs,
  buildLaunchctlLoadArgs,
  buildLaunchctlPrintArgs,
  getGuiDomain,
  getLaunchAgentPath
} from '../src/mms/startup/macos'
import { detectPlatform } from '../src/mms/startup/index'
import {
  WINDOWS_REGISTRY_KEY,
  WINDOWS_REGISTRY_VALUE,
  WINDOWS_TASK_NAME,
  buildRegistryAddArgs,
  buildRegistryDeleteArgs,
  buildRegistryQueryArgs,
  buildSchtasksCreateArgs,
  buildSchtasksDeleteArgs,
  buildSchtasksQueryArgs,
  buildWindowsTaskRunValue
} from '../src/mms/startup/windows'

describe('startup platform detection', () => {
  it('maps process.platform to a startup platform', () => {
    const platform = detectPlatform()
    if (process.platform === 'win32') {
      expect(platform).toBe('windows')
    } else if (process.platform === 'darwin') {
      expect(platform).toBe('macos')
    } else {
      expect(platform).toBe('linux-systemd')
    }
  })
})

describe('windows startup generation', () => {
  it('builds schtasks create args with quoted cli path', () => {
    expect(buildWindowsTaskRunValue('C:\\Mousse\\mousse-cli.exe')).toBe(
      '"C:\\Mousse\\mousse-cli.exe" service run'
    )
    expect(buildSchtasksCreateArgs('C:\\Mousse\\mousse-cli.exe')).toEqual([
      '/Create',
      '/F',
      '/SC',
      'ONLOGON',
      '/TN',
      WINDOWS_TASK_NAME,
      '/TR',
      '"C:\\Mousse\\mousse-cli.exe" service run'
    ])
  })

  it('builds schtasks delete and query args', () => {
    expect(buildSchtasksDeleteArgs()).toEqual(['/Delete', '/F', '/TN', WINDOWS_TASK_NAME])
    expect(buildSchtasksQueryArgs()).toEqual([
      '/Query',
      '/TN',
      WINDOWS_TASK_NAME,
      '/FO',
      'LIST',
      '/V'
    ])
  })

  it('builds registry fallback args', () => {
    expect(buildRegistryAddArgs('C:\\bin\\mousse-cli.exe')).toEqual([
      'add',
      WINDOWS_REGISTRY_KEY,
      '/v',
      WINDOWS_REGISTRY_VALUE,
      '/t',
      'REG_SZ',
      '/d',
      '"C:\\bin\\mousse-cli.exe" service run',
      '/f'
    ])
    expect(buildRegistryDeleteArgs()).toEqual([
      'delete',
      WINDOWS_REGISTRY_KEY,
      '/v',
      WINDOWS_REGISTRY_VALUE,
      '/f'
    ])
    expect(buildRegistryQueryArgs()).toEqual([
      'query',
      WINDOWS_REGISTRY_KEY,
      '/v',
      WINDOWS_REGISTRY_VALUE
    ])
  })
})

describe('linux systemd startup generation', () => {
  const cliPath = '/usr/local/bin/mousse-cli'
  const homeDir = '/home/alice'

  it('resolves the user unit path', () => {
    expect(getSystemdUnitPath(homeDir)).toBe(
      '/home/alice/.config/systemd/user/mousse-mms.service'
    )
    expect(SYSTEMD_UNIT_FILENAME).toBe(`${SYSTEMD_SERVICE_NAME}.service`)
  })

  it('builds a valid user unit file', () => {
    const content = buildSystemdUnitContent(cliPath, homeDir)
    expect(content).toContain('Description=Mousse Main Service')
    expect(content).toContain(`ExecStart=${cliPath} service run`)
    expect(content).toContain('Restart=on-failure')
    expect(content).toContain(`Environment=MOUSSE_HOME=${homeDir}`)
    expect(content).toContain('WantedBy=default.target')
  })

  it('builds systemctl arg arrays', () => {
    expect(buildSystemctlDaemonReloadArgs()).toEqual(['--user', 'daemon-reload'])
    expect(buildSystemctlEnableNowArgs()).toEqual([
      '--user',
      'enable',
      '--now',
      SYSTEMD_SERVICE_NAME
    ])
    expect(buildSystemctlIsEnabledArgs()).toEqual(['--user', 'is-enabled', SYSTEMD_SERVICE_NAME])
    expect(buildSystemctlIsActiveArgs()).toEqual(['--user', 'is-active', SYSTEMD_SERVICE_NAME])
  })
})

describe('macos startup generation', () => {
  const cliPath = '/opt/mousse/mousse-cli'
  const homeDir = '/Users/alice'

  it('resolves the LaunchAgents plist path', () => {
    expect(getLaunchAgentPath(homeDir)).toBe(
      '/Users/alice/Library/LaunchAgents/com.ryspa.mousse.mms.plist'
    )
    expect(MACOS_PLIST_FILENAME).toBe(`${MACOS_LABEL}.plist`)
  })

  it('builds a launchd plist with ProgramArguments and MOUSSE_HOME', () => {
    const plist = buildLaunchAgentPlist(cliPath, homeDir)
    expect(plist).toContain(`<string>${MACOS_LABEL}</string>`)
    expect(plist).toContain(`<string>${cliPath}</string>`)
    expect(plist).toContain('<string>service</string>')
    expect(plist).toContain('<string>run</string>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('<key>SuccessfulExit</key>')
    expect(plist).toContain('<false/>')
    expect(plist).toContain('<key>MOUSSE_HOME</key>')
    expect(plist).toContain(`<string>${homeDir}</string>`)
  })

  it('escapes special XML characters in paths', () => {
    const plist = buildLaunchAgentPlist('/opt/mousse & co/cli', '/Users/alice<test>')
    expect(plist).toContain('<string>/opt/mousse &amp; co/cli</string>')
    expect(plist).toContain('<string>/Users/alice&lt;test&gt;</string>')
  })

  it('builds launchctl arg arrays', () => {
    const plistPath = getLaunchAgentPath(homeDir)
    expect(getGuiDomain(501)).toBe('gui/501')
    expect(buildLaunchctlBootstrapArgs(plistPath, 501)).toEqual([
      'bootstrap',
      'gui/501',
      plistPath
    ])
    expect(buildLaunchctlLoadArgs(plistPath)).toEqual(['load', '-w', plistPath])
    expect(buildLaunchctlBootoutArgs(plistPath, 501)).toEqual([
      'bootout',
      'gui/501',
      plistPath
    ])
    expect(buildLaunchctlPrintArgs(501)).toEqual(['print', 'gui/501/com.ryspa.mousse.mms'])
  })
})
