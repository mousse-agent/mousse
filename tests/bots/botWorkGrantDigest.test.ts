/**
 * A bot's work and subagent tools under the thread family's names (#1454 S7d4a): `work_start` and `subagent_start` are
 * `thread_create` kind "subagent", and so on. The bot's own tools still run them, under their old names, so a grant
 * stored before the rename keeps the digest it was approved under, compiles to the same tools, and never asks again.
 */
import { describe, expect, it } from 'vitest'
import { botManifestDigest, compileBotThread } from '../../src/mms/bots/grants/compile'
import type { BotManifest } from '../../src/shared/bots/personal/definition'
import { BOT_SUBAGENT_TOOLS, BOT_THREADS_PERMISSION, BOT_WORK_TOOLS, botGrantTool, canonicalManifest, manifestProblem } from '../../src/shared/bots/personal/manifest'

/** A grant as a bot stored it before the rename: the starter grant with "use your threads". */
const STORED: BotManifest = {
  tools: ['read', 'list', 'search', 'edit', 'write'],
  appTools: ['web_search', 'web_fetch', 'bot_schedule_add', 'bot_schedule_remove', 'bot_schedule_list', 'set_profile', 'set_depth', 'use_model', 'permission_ask', 'memory_search', 'memory_read', 'memory_list', 'memory_save', 'memory_forget', 'item_save', 'item_list', 'run_report', 'threads'],
  mcp: [],
  skills: [],
  workspace: null,
  budget: {},
  audience: 'owner'
} as BotManifest

const compile = (botTools: Parameters<typeof compileBotThread>[0]['botTools']) => {
  const compiled = compileBotThread({
    grant: STORED, digest: botManifestDigest(STORED), thread: {}, scratch: '/tmp/mousse-grant-digest-scratch', profileHome: '/tmp/mousse-grant-digest-home',
    nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 60_000 }, botTools
  })
  if (!compiled.ok) throw new Error(compiled.error.message)
  return compiled.permissions.appTools
}

describe("a bot's stored grant, after its work and subagent tools took the thread family's names", () => {
  it('keeps the digest it was approved under', () => {
    expect(manifestProblem(STORED)).toBeUndefined()
    expect(botManifestDigest(STORED)).toBe('4f939a1716ef7637ffdc3345e255e72bf37a7d3abe53e40fb715669f76b755a0')
    expect(canonicalManifest(STORED).appTools).toContain(BOT_THREADS_PERMISSION)
  })

  it('compiles to the same tools, under their old names: the chat its work tools, the work its subagent tools', () => {
    const chat = compile({ escalate: true, consult: true, memory: true, threads: 'all', frontDesk: true })
    expect(chat).toEqual(expect.arrayContaining(BOT_WORK_TOOLS.filter((tool) => tool !== 'watch_start')))
    const work = compile({ escalate: true, consult: true, memory: true, threads: 'all', subagents: true })
    expect(work).toEqual(expect.arrayContaining([...BOT_SUBAGENT_TOOLS]))
  })

  it('never asks for them again: each is its own, never "use your threads" and never a thread tool', () => {
    for (const tool of [...BOT_WORK_TOOLS, ...BOT_SUBAGENT_TOOLS]) expect(botGrantTool(tool), tool).toBe(tool)
    // The thread tools a call of the new names falls to when it is not the bot's own work: "use your threads".
    for (const tool of ['thread_create', 'thread_send', 'thread_wait', 'thread_stop', 'thread_list']) expect(botGrantTool(tool), tool).toBe(BOT_THREADS_PERMISSION)
  })
})
