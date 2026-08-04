import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { getDefaultSettings } from '../src/shared/settings'

const homes: string[] = []

afterEach(async () => {
  delete process.env.MOUSSE_HOME
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe('Mousse subagent model settings', () => {
  it('inherits the main model by default', () => {
    const settings = getDefaultSettings()
    expect(settings.agents.llmProvider.mousse).toBe('')
    expect(settings.agents.model.mousse).toBe('')
  })

  it('persists the selected provider and model in mousse.conf', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mousse-subagent-settings-'))
    homes.push(home)
    const store = MousseConfigStore.load(home)

    store.applySettingsPatch({
      agents: {
        llmProvider: { ...store.assembleSettings().agents.llmProvider, mousse: 'provider-a' },
        model: { ...store.assembleSettings().agents.model, mousse: 'model-a' }
      } as never
    })

    const reloaded = MousseConfigStore.load(home).assembleSettings()
    expect(reloaded.agents.llmProvider.mousse).toBe('provider-a')
    expect(reloaded.agents.model.mousse).toBe('model-a')

    const persisted = JSON.parse(await readFile(join(home, 'mousse.conf'), 'utf-8'))
    expect(persisted.agents.llmProvider.mousse).toBe('provider-a')
    expect(persisted.agents.model.mousse).toBe('model-a')
  })
})
