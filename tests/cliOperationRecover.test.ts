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
  it('asks the daemon to recover the thread, with nothing else', async () => {
    const calls = daemon()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await run('operation', 'recover', '--session', 'thread-1')
    expect(calls.at(-1)).toEqual({ method: 'operations.recover', params: { threadId: 'thread-1' } })
  })

  it('is listed in the help next to abort, with no option that moves a branch', () => {
    const help = commandHelp('operation')
    expect(help).toContain('mousse-cli operation abort <operation> --session <thread>')
    expect(help).toContain('mousse-cli operation recover --session <thread>')
    expect(help).not.toContain('switch-back')
  })
})
