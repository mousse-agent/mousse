// @vitest-environment jsdom
/**
 * Settings → Computer use: says whether Cua Driver is installed (with its version), installs it on a click, lets the
 * person choose a driver file or go back to finding it, and switches agents' computer use, saving the whole setting.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComputerUseSettings } from '../../src/renderer/components/settings/ComputerUseSettings'
import type { ComputerUseStatus } from '../../src/shared/computerUse'
import { getDefaultSettings, type MousseSettings } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

const missing: ComputerUseStatus = { state: 'missing', enabled: true, installable: true, installCommand: 'curl -fsSL https://cua.ai/driver/install.sh | bash' }
const found: ComputerUseStatus = { state: 'found', enabled: true, installable: true, path: '/home/me/.local/bin/cua-driver', source: 'default', version: '0.38.0' }

function bridge(first: ComputerUseStatus, afterInstall: ComputerUseStatus, chosen: string | null = null) {
  const request = vi.fn(async (method: string) => (method === 'computerUse.install' ? afterInstall : first))
  ;(window as unknown as { mousse: unknown }).mousse = { platformRequest: { request }, computerUse: { chooseDriver: vi.fn(async () => chosen) } }
  return request
}

async function show(settings: MousseSettings = getDefaultSettings()) {
  const onUpdate = vi.fn(async () => undefined)
  await act(async () => root.render(createElement(ComputerUseSettings, { settings, onUpdate })))
  return onUpdate
}

const text = () => host.textContent ?? ''
const button = (name: string) => Array.from(host.querySelectorAll('button')).find((entry) => entry.textContent === name || entry.getAttribute('aria-label') === name)
const click = async (target: Element | undefined) => { await act(async () => { (target as HTMLElement).click() }) }

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Settings → Computer use', () => {
  it('says the driver is not installed, installs it on Install, then shows its version', async () => {
    const request = bridge(missing, found)
    await show()
    expect(text()).toContain('Not installed')
    expect(text()).toContain('cua.ai/driver/install.sh')
    await click(button('Install'))
    expect(request).toHaveBeenCalledWith('computerUse.install', {})
    expect(text()).toContain('Installed')
    expect(text()).toContain('v0.38.0')
    expect(button('Install')).toBeUndefined()
  })

  it('looks again on Check again', async () => {
    const request = bridge(found, found)
    await show()
    request.mockClear()
    await click(button('Check again'))
    expect(request).toHaveBeenCalledWith('computerUse.status', { refresh: true })
  })

  it('saves a chosen driver file, and Automatic clears it, keeping the rest of the setting', async () => {
    bridge(found, found, '/opt/cua-driver')
    const base = getDefaultSettings()
    const onUpdate = await show({ ...base, agentAccess: { ...base.agentAccess, answerApprovals: true } })
    await click(button('Choose…'))
    expect(onUpdate).toHaveBeenLastCalledWith({ agentAccess: expect.objectContaining({ computerDriver: '/opt/cua-driver', answerApprovals: true, computerUse: true }) })
    const onClear = await show({ ...base, agentAccess: { ...base.agentAccess, computerDriver: '/opt/cua-driver' } })
    await click(button('Automatic'))
    expect(onClear).toHaveBeenLastCalledWith({ agentAccess: expect.objectContaining({ computerDriver: '' }) })
  })

  it('switches agents off, keeping the rest of the setting', async () => {
    bridge(found, found)
    const base = getDefaultSettings()
    const onUpdate = await show({ ...base, agentAccess: { ...base.agentAccess, remoteSubagents: true } })
    const toggle = host.querySelector<HTMLElement>('[role="switch"]#computer-agents')
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    await click(toggle!)
    expect(onUpdate).toHaveBeenCalledWith({ agentAccess: expect.objectContaining({ computerUse: false, remoteSubagents: true }) })
  })
})
