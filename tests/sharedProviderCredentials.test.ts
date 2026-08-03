import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileCredentialStore } from '../src/mms/providers/FileCredentialStore'

describe('provider credentials', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps provider credentials scoped to the connected provider', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mousse-provider-'))
    tempDirs.push(directory)
    const store = new FileCredentialStore(join(directory, 'auth.json'))

    await store.modify('opencode-go', async () => ({ type: 'api_key', key: 'test-key' }))

    expect(store.listProviderIds()).toEqual(['opencode-go'])
    expect(store.has('opencode')).toBe(false)
    expect(await store.read('opencode')).toBeUndefined()

    await store.delete('opencode-go')
    expect(store.has('opencode-go')).toBe(false)
  })
})
