// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddSshDeviceDialog, deviceNameProblem, suggestedDeviceName } from '../../src/renderer/components/devices/AddSshDeviceDialog'
import type { SshCheckResult, SshHostKeyView, SshPlan, SshSetupStatus, SshUndoResult } from '../../src/shared/net/local'

const FP = `SHA256:${'A'.repeat(42)}0`
const OLD = `SHA256:${'B'.repeat(42)}1`
const key = (patch: Partial<SshHostKeyView> = {}): SshHostKeyView => ({ type: 'ED25519', fingerprint: FP, state: 'unknown', ...patch })
const untrusted = (hostKey: SshHostKeyView, patch: Partial<SshCheckResult> = {}): SshCheckResult => ({ ok: false, phase: 'untrusted', host: 'build-box', hostKey, prerequisites: [], ...patch })
const probed: SshCheckResult = {
  ok: true, phase: 'probed', host: 'build-box', hostKey: key({ state: 'trusted' }), os: 'linux', arch: 'x86_64', auth: 'ok',
  installed: { cli: { owner: 'none' }, service: { owner: 'none' } },
  prerequisites: [{ name: 'systemd user service', ok: true }, { name: 'Free disk space', ok: false, indeterminate: true }]
}
const plan: SshPlan = { steps: [{ id: 'install', title: 'Install Mousse', detail: 'Into ~/.local/share/mousse', command: 'install.sh' }, { id: 'service', title: 'Start the background service', detail: '' }] }
const status = (patch: Partial<SshSetupStatus> = {}): SshSetupStatus => ({
  id: 'setup_1', phase: 'running', step: 'install', recoverable: false,
  steps: [{ step: 'install', state: 'pending' }, { step: 'service', state: 'pending' }], ...patch
})

type Answers = Record<string, (params: Record<string, unknown>) => unknown>

describe('Add a remote machine over SSH', () => {
  let host: HTMLDivElement
  let root: Root
  let request: ReturnType<typeof vi.fn>

  const stub = (answers: Answers) => {
    request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      const answer = answers[method]
      if (!answer) throw new Error(`unexpected ${method}`)
      return answer(params)
    })
    ;(window as unknown as { mousse: unknown }).mousse = { platformRequest: { request } }
  }
  const methods = () => request.mock.calls.map(([method]) => method as string)
  const settle = async () => {
    for (let round = 0; round < 8; round += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
  }
  const mount = async (setupId?: string) => {
    act(() => root.render(createElement(AddSshDeviceDialog, { open: true, onClose: () => undefined, onDone: () => undefined, setupId })))
    await settle()
  }
  const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)
  const click = async (element: Element | undefined | null) => {
    if (!element) throw new Error('nothing to click')
    await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await settle()
  }
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const checkHost = async (value = 'me@build-box') => {
    await mount()
    await type(document.body.querySelector('input')!, value)
    await act(async () => { document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await settle()
  }
  const text = () => document.body.textContent ?? ''
  const noPassword = () => expect(document.body.querySelectorAll('input[type="password"]')).toHaveLength(0)

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('suggests a device name from the host and refuses names it cannot use', () => {
    expect(suggestedDeviceName('me@build-box:2222')).toBe('build-box')
    expect(suggestedDeviceName('[::1]:22')).toBe('::1')
    expect(deviceNameProblem('box\\one')).toBeDefined()
    expect(deviceNameProblem('x'.repeat(65))).toBeDefined()
    expect(deviceNameProblem('Build box')).toBeUndefined()
  })

  it('shows an unknown host key and offers no plan or Run before it is trusted', async () => {
    stub({ 'net.ssh.check': () => untrusted(key({ knownByOtherTypes: ['RSA'] })) })
    await checkHost()
    expect(text()).toContain(FP)
    expect(text()).toContain('Your terminal already knows this host by a RSA key; this is its ED25519 key.')
    expect(button('Trust this host key')?.disabled).toBe(false)
    expect(button('Run setup')).toBeUndefined()
    expect(document.body.querySelector('[aria-label="Setup plan"]')).toBeNull()
    expect(methods()).toEqual(['net.ssh.check'])
    noPassword()
  })

  it('trusts exactly the fingerprint shown, then checks again and shows the plan', async () => {
    let checks = 0
    stub({
      'net.ssh.check': () => (checks++ ? probed : untrusted(key())),
      'net.ssh.trust': () => ({ ok: true, state: 'trusted' }),
      'net.ssh.plan': () => plan
    })
    await checkHost()
    await click(button('Trust this host key'))
    expect(request.mock.calls[1]).toEqual(['net.ssh.trust', { host: 'me@build-box', fingerprint: FP }])
    expect(methods()).toEqual(['net.ssh.check', 'net.ssh.trust', 'net.ssh.check', 'net.ssh.plan'])
    expect(request.mock.calls[3][1]).toEqual({ host: 'me@build-box', name: 'build-box' })
    expect(text()).toContain('Host key already trusted.')
    expect(text()).toContain('Couldn’t tell')
    expect(text()).toContain('Install Mousse')
    expect(button('Run setup')?.disabled).toBe(false)
    noPassword()
  })

  it('needs an explicit acknowledgement before trusting a changed host key', async () => {
    stub({
      'net.ssh.check': () => untrusted(key({ state: 'changed', changed: { previousFingerprint: OLD, file: '~/.ssh/known_hosts' } })),
      'net.ssh.trust': () => ({ ok: false, state: 'changed', detail: 'Not written' })
    })
    await checkHost()
    expect(text()).toContain('The host key has changed.')
    expect(text()).toContain(FP)
    expect(text()).toContain(OLD)
    expect(text()).toContain('~/.ssh/known_hosts')
    expect(button('Trust this host key')?.disabled).toBe(true)
    await click(document.body.querySelector('input[type="checkbox"]'))
    expect(button('Trust this host key')?.disabled).toBe(false)
    await click(button('Trust this host key'))
    expect(request.mock.calls[1]).toEqual(['net.ssh.trust', { host: 'me@build-box', fingerprint: FP, acknowledgeChanged: true }])
    expect(text()).toContain('Not written')
  })

  it('stops at a revoked host key', async () => {
    stub({ 'net.ssh.check': () => untrusted(key({ state: 'revoked' }), { problem: 'host_key_revoked', detail: 'Revoked in known_hosts' }) })
    await checkHost()
    expect(text()).toContain('This host key was revoked.')
    expect(button('Trust this host key')).toBeUndefined()
    expect(button('Check again')).toBeUndefined()
    expect(button('Retry')).toBeUndefined()
  })

  it('explains a refused ProxyJump with the daemon’s detail', async () => {
    stub({ 'net.ssh.check': () => ({ ok: false, phase: 'untrusted', host: 'jumped', prerequisites: [], problem: 'proxy_refused', detail: 'build-box uses ProxyJump bastion' }) })
    await checkHost('jumped')
    expect(text()).toContain('build-box uses ProxyJump bastion')
    expect(text()).toContain('Mousse can’t use a ProxyJump or ProxyCommand yet.')
  })

  it('offers Retry inline when the machine is unreachable, and shows a rejected call', async () => {
    let calls = 0
    stub({ 'net.ssh.check': () => { if (calls++) throw new Error('daemon gone'); return { ok: false, phase: 'untrusted', host: 'x', prerequisites: [], problem: 'unreachable', detail: 'Connection timed out' } } })
    await checkHost('x')
    expect(text()).toContain('Connection timed out')
    await click(button('Retry'))
    expect(methods()).toEqual(['net.ssh.check', 'net.ssh.check'])
    expect(text()).toContain('daemon gone')
  })

  it('disables Run when the plan is blocked', async () => {
    stub({ 'net.ssh.check': () => probed, 'net.ssh.plan': () => ({ ...plan, blocked: [{ name: 'glibc', remedy: 'Needs glibc 2.28 or newer' }] }) })
    await checkHost()
    expect(text()).toContain('glibc: Needs glibc 2.28 or newer')
    expect(button('Run setup')?.disabled).toBe(true)
  })

  it('shows the copy-id command when the key is denied, never a password field', async () => {
    stub({ 'net.ssh.check': () => ({ ...probed, ok: false, auth: 'denied', copyId: 'ssh-copy-id me@build-box' }) })
    await checkHost()
    expect(text()).toContain('ssh-copy-id me@build-box')
    expect(methods()).toEqual(['net.ssh.check'])
    noPassword()
  })

  it('shows running steps with Cancel', async () => {
    stub({ 'net.ssh.setup.status': () => status({ steps: [{ step: 'install', state: 'done' }, { step: 'service', state: 'pending' }], step: 'service', progress: 'Starting the service' }), 'net.ssh.setup.cancel': () => ({}) })
    await mount('setup_1')
    expect(text()).toContain('Starting the service')
    const steps = document.body.querySelector('[aria-label="Setup steps"]')!
    expect(steps.textContent).toContain('installDone')
    expect(steps.textContent).toContain('serviceRunning')
    await click(button('Cancel setup'))
    expect(request.mock.calls.find(([method]) => method === 'net.ssh.setup.cancel')?.[1]).toEqual({ id: 'setup_1' })
  })

  it('offers Retry and Undo after a recoverable failure', async () => {
    let polls = 0
    const undo: SshUndoResult = { ok: false, report: [{ step: 'Background service', result: 'undone', detail: '' }, { step: 'Login shell line', result: 'left', detail: 'edited by you' }], commands: ['rm ~/.local/bin/mousse'] }
    stub({
      'net.ssh.setup.status': () => (polls++ ? status({ phase: 'failed', recoverable: true, error: 'Disk full' }) : status({ phase: 'failed', recoverable: true, error: 'Disk full', steps: [{ step: 'install', state: 'failed' }] })),
      'net.ssh.setup.retry': () => ({}),
      'net.ssh.undo': () => undo
    })
    await mount('setup_1')
    expect(text()).toContain('Disk full')
    expect(button('Retry')).toBeDefined()
    await click(button('Retry'))
    expect(methods()).toEqual(['net.ssh.setup.status', 'net.ssh.setup.retry', 'net.ssh.setup.status'])
    await click(button('Undo changes'))
    expect(request.mock.calls.at(-1)).toEqual(['net.ssh.undo', { id: 'setup_1' }])
    expect(text()).toContain('Left in place')
    expect(text()).toContain('rm ~/.local/bin/mousse')
    noPassword()
  })

  it('shows the linger command when setup finished', async () => {
    stub({ 'net.ssh.setup.status': () => status({ phase: 'done', lingerCommand: 'sudo loginctl enable-linger me', steps: [{ step: 'install', state: 'done' }] }) })
    await mount('setup_1')
    expect(text()).toContain('Setup finished.')
    expect(text()).toContain('sudo loginctl enable-linger me')
    expect(button('Done')).toBeDefined()
  })
})
