// #595: where an agent may ask for a secret and where it may run a command with one.
import { describe, expect, it } from 'vitest'
import { secretTools, type SecretToolHost } from '../../src/mms/run/mcp/appTools/secrets'
import type { AppToolHost } from '../../src/mms/run/mcp/appTools/host'
import type { AppToolTurn } from '../../src/mms/run/mcp/appTools/types'
import { BOT_APP_TOOLS } from '../../src/shared/bots/personal/manifest'

const [request, run] = secretTools({ secrets: () => ({}) as SecretToolHost } as unknown as AppToolHost)
const [requestOff, runOff] = secretTools({} as AppToolHost)

const turn = (patch: Partial<AppToolTurn> & { readOnly?: boolean }): AppToolTurn => ({
  threadId: 't', runId: 'r', subagent: false, projectPath: '/p',
  ...patch,
  modeFacts: { readOnly: patch.readOnly ?? false, agent: !(patch.readOnly ?? false), build: false }
} as AppToolTurn)

// [turn, secret_request offered, secret_run usable]
const ROWS: Array<[string, AppToolTurn, boolean, boolean]> = [
  ['Agent mode', turn({}), true, true],
  ['a read-only turn: a request card only', turn({ readOnly: true }), true, false],
  ['a subagent', turn({ subagent: true }), false, false],
  ['no project folder', turn({ projectPath: undefined }), true, false]
]

describe('the secret tools', () => {
  it.each(ROWS)('%s', (_name, current, asks, runs) => {
    expect(request.offered!(current)).toBe(asks)
    expect(run.offered!(current)).toBe(runs)
    // A call that was not offered (a runtime that lists every tool) is still refused in a read-only turn and without a folder.
    if (current.modeFacts.readOnly || !current.projectPath) expect(run.available!(current)).not.toBe(true)
  })

  it('are not listed or usable where the owner has no secret store', () => {
    expect(requestOff.listed!({ readOnly: false })).toBe(false)
    expect(runOff.listed!({ readOnly: false })).toBe(false)
    expect(requestOff.available!(turn({}))).not.toBe(true)
  })

  it('run a command only as an edit the permission mode allows or the person approves, and are not a bot tool', () => {
    expect(run.access).toBe('editsWorkspace')
    expect(request.asksUser).toBe('question')
    expect(BOT_APP_TOOLS.has('secret_request')).toBe(false)
    expect(BOT_APP_TOOLS.has('secret_run')).toBe(false)
  })

  // The wording is the behaviour here: agents held back from a token they were given because these said they could use
  // it by name only. What a runtime lists to the model is each tool's definition.
  it('tell the agent it may use the secret directly through its file, and never to print it', () => {
    const asks = request.definition!().description
    expect(asks).toMatch(/private file/)
    expect(asks).toMatch(/--with-token < file/)
    expect(asks).toMatch(/Never print or echo the value/)
    expect(asks).not.toMatch(/only its name/)
    const runs = run.definition!().description
    expect(runs).not.toMatch(/not your own shell/)
    expect(runs).toMatch(/private file .* to commands you run yourself/)
    expect(request.description).toBe(asks)
  })
})
