import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { MOUSSE_BUILTIN_TOOL_IDS } from '../src/shared/integrations'

describe('Mousse built-in tool settings', () => {
  it('enables the entire built-in catalog by default', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-tool-defaults-'))
    try {
      const settings = new SettingsStore(MousseConfigStore.load(home)).get()
      expect(settings.integrations.tools.enabled).toBe(true)
      expect(settings.integrations.tools.enabledTools).toEqual(MOUSSE_BUILTIN_TOOL_IDS)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('defaults newly discovered tools on without resurrecting later opt-outs', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-tool-migration-'))
    try {
      const store = new SettingsStore(MousseConfigStore.load(home))
      store.set({ integrations: { tools: { enabledTools: ['read'] } } })

      // Simulate settings written before the catalog snapshot marker existed.
      const confPath = join(home, 'mousse.conf')
      const legacy = JSON.parse(readFileSync(confPath, 'utf8'))
      delete legacy.settings.integrations.tools.knownTools
      writeFileSync(confPath, JSON.stringify(legacy, null, 2))

      const migrated = new SettingsStore(MousseConfigStore.load(home))
      expect(migrated.get().integrations.tools.enabledTools).toEqual(MOUSSE_BUILTIN_TOOL_IDS)

      const withoutFetch = MOUSSE_BUILTIN_TOOL_IDS.filter((id) => id !== 'web_fetch')
      migrated.set({ integrations: { tools: { enabledTools: withoutFetch } } })

      const reloaded = new SettingsStore(MousseConfigStore.load(home)).get()
      expect(reloaded.integrations.tools.enabledTools).toEqual(withoutFetch)
      expect(reloaded.integrations.tools.knownTools).toEqual(MOUSSE_BUILTIN_TOOL_IDS)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it("keeps a switch saved under a tool's old name: off stays off, on stays on, under the new name", () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-tool-alias-'))
    try {
      new SettingsStore(MousseConfigStore.load(home)).get()
      // Settings an older build saved: the task tools by their old names, create_task switched off.
      const oldIds = MOUSSE_BUILTIN_TOOL_IDS.map((id) => ({ task_list: 'list_tasks', task_create: 'create_task', task_update: 'update_task' } as Record<string, string>)[id] ?? id)
      const confPath = join(home, 'mousse.conf')
      const saved = JSON.parse(readFileSync(confPath, 'utf8'))
      saved.settings = { ...saved.settings, integrations: { ...saved.settings?.integrations, tools: { enabled: true, enabledTools: oldIds.filter((id) => id !== 'create_task'), knownTools: oldIds } } }
      writeFileSync(confPath, JSON.stringify(saved, null, 2))

      const { enabledTools } = new SettingsStore(MousseConfigStore.load(home)).get().integrations.tools
      expect(enabledTools).toContain('task_list')
      expect(enabledTools).toContain('task_update')
      expect(enabledTools).not.toContain('task_create')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})
