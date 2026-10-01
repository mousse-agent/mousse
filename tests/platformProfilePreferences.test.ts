import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadModelFavorites, saveModelFavorites, toggleModelFavorite } from '../src/renderer/lib/modelFavorites'
import { createQuickAction, loadQuickActions, saveQuickActions } from '../src/renderer/lib/quickActions'
import { migrateLegacyProfilePreferences } from '../src/renderer/lib/profilePreferences'

const values = new Map<string, string>()
beforeEach(() => {
  values.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('profile-owned personal renderer preferences', () => {
  it('keeps favorites and quick action payloads isolated when switching and reopening profiles', () => {
    saveModelFavorites(new Set(['provider:alice-model']), 'alice')
    const aliceAction = createQuickAction({ label: 'Alice only', kind: 'send-current', payload: 'Private project prompt', isBuiltIn: false })
    saveQuickActions([aliceAction], 'alice')
    expect([...loadModelFavorites('bob')]).toEqual([])
    expect(loadQuickActions('bob').some((action) => action.payload === aliceAction.payload)).toBe(false)
    toggleModelFavorite(loadModelFavorites('bob'), 'provider:bob-model', 'bob')
    saveQuickActions([], 'bob')
    expect([...loadModelFavorites('alice')]).toEqual(['provider:alice-model'])
    expect(loadQuickActions('alice')).toEqual([aliceAction])
    expect([...loadModelFavorites('bob')]).toEqual(['provider:bob-model'])
    expect(loadQuickActions('bob')).toEqual([])
  })

  it('migrates legacy preferences only to the default profile without overwriting its later edits', () => {
    const legacy = createQuickAction({ label: 'Legacy', kind: 'bash', payload: 'echo legacy', isBuiltIn: false })
    values.set('mousse.modelFavorites', JSON.stringify(['legacy-model']))
    values.set('mousse.quickActions.v1', JSON.stringify([legacy]))
    migrateLegacyProfilePreferences({ id: 'bob', isDefault: false })
    expect([...loadModelFavorites('bob')]).toEqual([])
    expect(loadQuickActions('bob').some((action) => action.id === legacy.id)).toBe(false)
    migrateLegacyProfilePreferences({ id: 'alice', isDefault: true })
    expect([...loadModelFavorites('alice')]).toEqual(['legacy-model'])
    expect(loadQuickActions('alice')).toEqual([legacy])
    saveModelFavorites(new Set(), 'alice')
    saveQuickActions([], 'alice')
    migrateLegacyProfilePreferences({ id: 'alice', isDefault: true })
    expect([...loadModelFavorites('alice')]).toEqual([])
    expect(loadQuickActions('alice')).toEqual([])
    expect(values.get('mousse.quickActions.v1')).toBe(JSON.stringify([legacy]))
  })
})
