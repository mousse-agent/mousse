import { afterEach, describe, expect, it, vi } from 'vitest'
import { runThreadActionCommand } from '../src/cli/commands/threadActions'
import { commandHelp } from '../src/cli/help'
import { openMms } from '../src/cli/mmsContext'
import { parseArgs } from '../src/cli/parseArgs'

vi.mock('../src/cli/mmsContext', () => ({ openMms: vi.fn(), closeMmsContext: vi.fn(async () => undefined) }))

function daemon() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const client = {
    async request(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'workspace.getStatus') return { journalGeneration: 7 }
      return { ok: true }
    }
  }
  vi.mocked(openMms).mockResolvedValue({ client } as never)
  return calls
}

const run = (...argv: string[]) => runThreadActionCommand(parseArgs(argv))

afterEach(() => vi.restoreAllMocks())

describe('mousse-cli operation recover', () => {
  it('recovers the thread without switching branches by default', async () => {
    const calls = daemon()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await run('operation', 'recover', '--session', 'thread-1')
    expect(calls.at(-1)).toEqual({ method: 'operations.recover', params: { threadId: 'thread-1' } })
  })

  it('asks for the switch back to the thread branch with --switch-back', async () => {
    const calls = daemon()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await run('operation', 'recover', '--switch-back', '--session', 'thread-1')
    expect(calls.at(-1)).toEqual({ method: 'operations.recover', params: { threadId: 'thread-1', switchBack: true } })
  })

  it('is listed in the help next to abort', () => {
    expect(commandHelp('operation')).toContain('mousse-cli operation recover [--switch-back] --session <thread>')
  })
})
