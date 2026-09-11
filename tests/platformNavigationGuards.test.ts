import { describe, expect, it, vi } from 'vitest'
import { NavigationGuards } from '../src/renderer/services/navigationGuards'

describe('dirty editor navigation coordination', () => {
  it('coalesces repeated requests while an editor decision is pending and keeps editing on cancellation', async () => {
    const guards = new NavigationGuards()
    let answer!: (allow: boolean) => void
    const question = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const unregister = guards.register(question)
    const profileSwitch = guards.confirm('profile')
    const tabSwitch = guards.confirm('navigate')
    expect(question).toHaveBeenCalledOnce()
    answer(false)
    expect(await profileSwitch).toBe(false)
    expect(await tabSwitch).toBe(false)
    unregister()
    expect(await guards.confirm()).toBe(true)
  })

  it('does not reuse a decision to discard edits mounted while another editor was being confirmed', async () => {
    const guards = new NavigationGuards()
    let answer!: (allow: boolean) => void
    guards.register(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const first = guards.confirm('profile')
    guards.register(() => false)
    answer(true)
    expect(await first).toBe(false)
  })

  it('stops at a declined or failed guard and keeps different renderer registries independent', async () => {
    const first = new NavigationGuards(), second = new NavigationGuards()
    first.register(() => { throw new Error('Editor was disposed during confirmation') })
    const later = vi.fn(() => true)
    first.register(later)
    expect(await first.confirm()).toBe(false)
    expect(later).not.toHaveBeenCalled()
    expect(await second.confirm()).toBe(true)
  })
})
