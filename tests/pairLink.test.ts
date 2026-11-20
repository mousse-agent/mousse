/**
 * `mousse://pair` links in main (design 1b §5.2): which argument is a link, when the scheme is registered (packaged
 * builds only, never one a check started), and how a link reaches the window: the launch argv, a second instance's
 * argv, macOS `open-url`.
 */
import { describe, expect, it } from 'vitest'
import { readEngineLimits } from '../src/mms/netEngine/limits'
import {
  attachPairLinks,
  PAIR_LINK_IPC,
  pairLinkFrom,
  shouldRegisterMousseScheme
} from '../src/main/pairLink'

const LINK = 'mousse://pair#AAAAAAAAAAAAAAAAAAAAAAAA'

describe('pairLinkFrom', () => {
  it.each([
    ['the link after the program and its flags', ['Mousse.exe', '--hidden', LINK], LINK],
    ['an upper-case scheme', ['Mousse', 'MOUSSE://pair#AAAA'], 'MOUSSE://pair#AAAA'],
    [
      'a link with a name query',
      ['Mousse', 'mousse://pair?n=Studio#AAAA'],
      'mousse://pair?n=Studio#AAAA'
    ],
    ['no link', ['Mousse.exe', '--hidden'], undefined],
    ['another mousse:// path', ['Mousse', 'mousse://settings#x'], undefined],
    ['a link without a ticket', ['Mousse', 'mousse://pair'], undefined],
    ['a link far too long', ['Mousse', `mousse://pair#${'A'.repeat(5000)}`], undefined],
    ['not text', [42, null], undefined]
  ])('%s', (_name, argv, link) => {
    expect(pairLinkFrom(argv)).toBe(link)
  })
})

describe('the longest link taken from the OS', () => {
  it('is MOUSSE_NET_ENGINE_PAIR_LINK_MAX_CHARS, which can only be lowered', () => {
    const lowered = readEngineLimits({ MOUSSE_NET_ENGINE_PAIR_LINK_MAX_CHARS: '100' })
    expect(lowered.problems).toEqual([])
    const link = `mousse://pair#${'A'.repeat(200)}`
    expect(pairLinkFrom(['Mousse', link], lowered.limits.pairLinkMaxChars)).toBeUndefined()
    expect(pairLinkFrom(['Mousse', link])).toBe(link)
    const raised = readEngineLimits({ MOUSSE_NET_ENGINE_PAIR_LINK_MAX_CHARS: '100000' })
    expect(raised.limits.pairLinkMaxChars).toBe(4096)
    expect(raised.problems.join()).toMatch(/MOUSSE_NET_ENGINE_PAIR_LINK_MAX_CHARS.*lowered/)
  })
})

describe('shouldRegisterMousseScheme', () => {
  it.each([
    ['a packaged build', true, {}, true],
    ['a packaged build a check started', true, { MOUSSE_CHECK: '1' }, false],
    ['a dev build', false, {}, false],
    [
      'a dev build under the control',
      false,
      { MOUSSE_NET_ENGINE_CONTROL: 'link-scheme-registered' },
      true
    ]
  ] as const)('%s', (_name, packaged, env, registers) => {
    expect(shouldRegisterMousseScheme({ packaged, env: { ...env } })).toBe(registers)
  })
})

describe('attachPairLinks', () => {
  function attach(argv: string[], packaged = true) {
    const registered: string[] = []
    const openUrl: Array<(event: { preventDefault(): void }, url: string) => void> = []
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    let notified = 0
    const links = attachPairLinks({
      app: {
        isPackaged: packaged,
        setAsDefaultProtocolClient: (scheme) => (registered.push(scheme), true),
        on: (_event, listener) => void openUrl.push(listener)
      },
      ipc: {
        removeHandler: (channel) => void handlers.delete(channel),
        handle: (channel, listener) => void handlers.set(channel, listener)
      },
      argv,
      env: {},
      notify: () => (notified += 1)
    })
    const take = () => handlers.get(PAIR_LINK_IPC.take)!()
    return { links, registered, openUrl, take, notified: () => notified }
  }

  it('registers the scheme in a packaged build and gives the window the launch link once', () => {
    const main = attach(['Mousse.exe', LINK])
    expect(main.registered).toEqual(['mousse'])
    expect(main.take()).toBe(LINK)
    expect(main.take()).toBeNull()
  })

  it('takes a second instance link and a macOS open-url link, telling the windows', () => {
    const main = attach(['Mousse.exe'], false)
    expect(main.registered).toEqual([])
    expect(main.links.fromArgv(['Mousse.exe', '--flag'])).toBe(false)
    expect(main.links.fromArgv(['Mousse.exe', LINK])).toBe(true)
    expect(main.notified()).toBe(1)
    expect(main.take()).toBe(LINK)
    let prevented = false
    main.openUrl[0]!({ preventDefault: () => (prevented = true) }, `${LINK}B`)
    expect(prevented).toBe(true)
    expect(main.notified()).toBe(2)
    expect(main.take()).toBe(`${LINK}B`)
  })
})
