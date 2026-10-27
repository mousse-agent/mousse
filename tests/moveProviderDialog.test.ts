import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MoveNotice, MoveProviderDialog, isMoveReady, moveTargets, oldSignInNote } from '../src/renderer/components/providers/MoveProviderDialog'
import { ApiEditor } from '../src/renderer/components/providers/ProviderEditor'
import { moveBannerOf } from '../src/shared/harness/move'
import { describeStatus, type InstanceSnapshot } from '../src/shared/harness/status'
import { snapshot } from './providerSnapshotFixture'

const noop = async () => undefined
const movePrompt = { action: 'move' as const, label: 'Move', title: 'Move to ChatGPT subscription', detail: 'This connection uses an older sign-in that a coming Mousse update turns off. Your chats stay.' }
const chatgpt = (overrides: Parameters<typeof snapshot>[0] = {}) =>
  snapshot({ instanceId: 'pi:openai-codex', driver: 'pi', builtIn: false, displayName: 'ChatGPT', auth: { state: 'signed_in', account: undefined, methodLabel: 'Sign-in' }, nextStep: movePrompt, ...overrides })
const managed = (overrides: Parameters<typeof snapshot>[0] = {}) =>
  snapshot({
    instanceId: 'codex:managed', driver: 'codex', builtIn: false, displayName: 'ChatGPT subscription',
    config: { home: 'private', args: [], env: {}, setup: 'managed' }, auth: { state: 'signed_in', account: undefined, canSignIn: true }, ...overrides
  })
const existing = (overrides: Parameters<typeof snapshot>[0] = {}) =>
  snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex', config: { home: 'default', args: [], env: {}, setup: 'existing' }, ...overrides })

const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map((match) => ({ attrs: match[1]!, label: match[2]!.replace(/<[^>]+>/g, '').trim() }))
const disabled = (html: string, label: string) => buttons(html).find((entry) => entry.label === label)?.attrs.includes('disabled')

function dialog(source: InstanceSnapshot, targets: InstanceSnapshot[]) {
  return renderToStaticMarkup(createElement(MoveProviderDialog, { snapshot: source, targets, agentLabel: 'ChatGPT subscription', onMove: async () => ({ from: source.instanceId, to: targets[0]!.instanceId, rewritten: [] }), onSignIn: noop, onRecheck: noop, onClose: () => {} }))
}

describe('the Move banner of an entry whose old route is going away', () => {
  it('reads only the snapshot: any entry with the Move step has one, until it moved', () => {
    expect(moveBannerOf(chatgpt())).toEqual({ instanceId: 'pi:openai-codex', title: movePrompt.title, detail: movePrompt.detail, label: 'Move' })
    expect(moveBannerOf(chatgpt({ config: { home: 'default', args: [], env: {}, movedTo: 'codex:managed' } }))).toBeNull()
    expect(moveBannerOf(snapshot())).toBeNull()
    expect(moveBannerOf(undefined)).toBeNull()
  })

  it('shows on the card with its Move button, in place of the plain row', () => {
    const html = renderToStaticMarkup(createElement(MoveNotice, { variant: 'banner', snapshot: chatgpt(), snapshots: [chatgpt(), managed()] }))
    expect(html).toContain('Move to ChatGPT subscription.')
    expect(html).toContain('Your chats stay.')
    expect(buttons(html).map((entry) => entry.label)).toEqual(['Move'])
    // The row variant leaves it to the banner.
    expect(renderToStaticMarkup(createElement(MoveNotice, { snapshot: chatgpt(), snapshots: [chatgpt(), managed()] }))).toBe('')
  })

  it('sits between the card header and its Setup, once', () => {
    const entry = chatgpt()
    const html = renderToStaticMarkup(
      createElement(ApiEditor, {
        snapshot: entry,
        setup: createElement('span', null, 'setup-row'),
        banner: createElement(MoveNotice, { variant: 'banner', snapshot: entry, snapshots: [entry, managed()] }),
        move: createElement(MoveNotice, { snapshot: entry, snapshots: [entry, managed()] }),
        onRemove: noop,
        onSaveModelPrefs: noop,
        onRefreshModels: noop
      })
    )
    expect(html.match(/move-banner"/g)).toHaveLength(1)
    expect(html.indexOf('move-banner')).toBeLessThan(html.indexOf('setup-row'))
    expect(html.indexOf('Setup')).toBeGreaterThan(html.indexOf('move-banner'))
    expect(html).not.toContain('Runs as')
  })

  it('an offer that only runs as an agent now keeps its quiet row', () => {
    const cursor = snapshot({ instanceId: 'pi:cursor', driver: 'pi', displayName: 'Cursor' })
    const html = renderToStaticMarkup(createElement(MoveNotice, { snapshot: cursor, snapshots: [cursor] }))
    expect(html).toContain('Runs as Cursor now')
    expect(html).not.toContain('move-banner')
    // No banner variant for it either.
    expect(renderToStaticMarkup(createElement(MoveNotice, { variant: 'banner', snapshot: cursor, snapshots: [cursor] }))).toBe('')
  })

  it('a moved entry says where it went and has no banner', () => {
    const moved = chatgpt({ nextStep: undefined, config: { home: 'default', args: [], env: {}, movedTo: 'codex:managed' } })
    const html = renderToStaticMarkup(createElement(MoveNotice, { snapshot: moved, snapshots: [moved, managed()] }))
    expect(html).toContain('This entry moved to ChatGPT subscription and is off.')
    expect(html).not.toContain('move-banner')
    expect(renderToStaticMarkup(createElement(MoveNotice, { variant: 'banner', snapshot: moved, snapshots: [moved, managed()] }))).toBe('')
  })

  it('signed out, the status keeps Move as its step', () => {
    const out = chatgpt({ auth: { state: 'signed_out', account: undefined } })
    expect(describeStatus(out).nextStep).toMatchObject({ action: 'move', label: 'Move' })
    expect(describeStatus(chatgpt({ auth: { state: 'expired', account: undefined } })).nextStep).toMatchObject({ action: 'move' })
  })
})

describe('the Move dialog for such an entry', () => {
  it('offers the Codex entries, managed and the user’s own', () => {
    expect(moveTargets(chatgpt(), [chatgpt(), managed(), existing(), snapshot()]).map((entry) => entry.instanceId)).toEqual(['codex:managed', 'codex'])
    expect(moveTargets(chatgpt({ config: { home: 'default', args: [], env: {}, movedTo: 'codex' } }), [managed()])).toEqual([])
  })

  it('asks for a fresh ChatGPT sign-in on a managed target, and holds Move until it is signed in', () => {
    const target = managed({ auth: { state: 'signed_out', account: undefined, canSignIn: true } })
    const html = dialog(chatgpt(), [target])
    expect(html).toContain('Managed by Mousse, signs in with ChatGPT')
    expect(buttons(html).map((entry) => entry.label)).toContain('Continue with ChatGPT')
    expect(html).toContain('no sign-in is copied from the old connection')
    expect(disabled(html, 'Move')).toBe(true)
    // No API key to copy: the old entry has a sign-in, and it goes with the move.
    expect(html).not.toContain('same API key')
  })

  it('shows the terminal command for the user’s own Codex, with Check again', () => {
    const target = existing({ auth: { state: 'signed_out', account: undefined }, nextStep: { action: 'sign_in', label: 'Sign in', command: 'codex login' } })
    const html = dialog(chatgpt(), [target])
    expect(html).toContain('Your installed CLI, with its own sign-in')
    expect(html).toContain('codex login')
    expect(buttons(html).map((entry) => entry.label)).toContain('Check again')
    expect(disabled(html, 'Move')).toBe(true)
  })

  it('sends a target that is not installed to its install first', () => {
    const html = dialog(chatgpt(), [managed({ install: { state: 'not_installed', canInstall: true } })])
    expect(html).toContain('Install ChatGPT subscription first')
    expect(disabled(html, 'Move')).toBe(true)
  })

  it('moves once the target is installed and signed in', () => {
    const target = managed()
    expect(isMoveReady(target)).toBe(true)
    const html = dialog(chatgpt(), [target])
    expect(html).toContain('Moving turns the old connection off and removes its sign-in.')
    expect(disabled(html, 'Move')).toBe(false)
  })

  it('says what became of the old sign-in', () => {
    const move = { from: 'pi:openai-codex', to: 'codex:managed', rewritten: [] }
    expect(oldSignInNote({ ...move, oldSignIn: 'removed' })).toBe(' and its old sign-in is removed')
    expect(oldSignInNote({ ...move, oldSignIn: 'kept_shared' })).toContain('another profile still uses it')
    expect(oldSignInNote({ ...move, oldSignIn: 'remains' })).toContain('could not be removed')
  })

  it('with no Codex entry, says to add one first', () => {
    expect(dialog(chatgpt(), [])).toContain('Add ChatGPT subscription first')
  })
})
