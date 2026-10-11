import { expect, it } from 'vitest'
import { parseArgs } from '../../../../src/cli/parseArgs'
import { commandHelp, ROOT_HELP } from '../../../../src/cli/help'
import { prepareBotsCommand, executeBotsCommand } from '../../../../src/cli/commands/bots'
import { prepareSpacesCommand } from '../../../../src/cli/commands/spaces'
import { validateBotsLocal } from '../../../../src/mms/bots/registerMethods'
import { newId } from '../../../../src/shared/net'

const space = newId('space'),
  bot = newId('bot'),
  stream = newId('stream'),
  request = newId('event'),
  digest = Buffer.alloc(32, 1).toString('base64url')
const configure = [
  'bots',
  'configure',
  space,
  bot,
  '--adapter',
  'mousse',
  '--profile-kind',
  'chat',
  '--definition-revision',
  'v1',
  '--profile-digest',
  digest,
  '--daily-budget',
  '1000',
  '--run-ceiling',
  '60',
  '--max-concurrent',
  '2',
  '--runs-per-member-hour',
  '20'
]
it('routes owner bot commands and keeps approval switches from consuming IDs', () => {
  const id = newId('rpc')
  expect(prepareBotsCommand(parseArgs(['bots', 'add', space, 'Registered', '--id', id]))).toEqual({
    method: 'bots.add',
    params: {
      id,
      space,
      name: 'Registered',
      profile: 'chat',
      policy: { visibility: 'public', steer: { kind: 'owner' } }
    }
  })
  for (const suffix of [
    [],
    ['--id', 'display-name'],
    ['--id', id, '--profile-kind', 'operator'],
    ['--id', id, '--steer', 'roles', '--roles', 'owner,owner'],
    ['--id', id, '--roles', 'owner'],
    ['--id', id, '--qualified'],
    ['--id', id, '--path', '/tmp']
  ])
    expect(() =>
      prepareBotsCommand(parseArgs(['bots', 'add', space, 'Registered', ...suffix]))
    ).toThrow()
  expect(prepareBotsCommand(parseArgs(configure))).toMatchObject({
    method: 'bots.configure',
    params: { space, bot, profile: 'chat', dailyBudgetUnits: 1000, profileDigest: digest }
  })
  expect(prepareBotsCommand(parseArgs(['bots', 'grant', '--approve', stream, request]))).toEqual({
    method: 'bots.grant',
    params: { stream, request, approved: true }
  })
  expect(prepareBotsCommand(parseArgs(['bots', 'grant', '--deny', stream, request]))).toEqual({
    method: 'bots.grant',
    params: { stream, request, approved: false }
  })
  expect(
    prepareBotsCommand(
      parseArgs(['bots', 'list', '--after-space', space, '--after-bot', bot, '--limit', '1'])
    )
  ).toEqual({ method: 'bots.list', params: { after: { space, bot }, limit: 1 } })
  expect(ROOT_HELP).toContain('mousse-cli bots')
  expect(commandHelp('bots')).toContain('production native adapter is inactive')
})
it('rejects substituted capabilities, unbounded data and executable or credential inputs before connecting', () => {
  for (const suffix of [
    ['--path', '/tmp'],
    ['--definition', 'code'],
    ['--qualified'],
    ['--api-key', 'secret'],
    ['--provider', 'remote'],
    ['--model', 'model'],
    ['--project-id', '/tmp/project']
  ])
    expect(() => prepareBotsCommand(parseArgs([...configure, ...suffix]))).toThrow()
  for (const args of [
    ['bots', 'grant', stream, request],
    ['bots', 'grant', stream, request, '--approve', '--deny'],
    ['bots', 'list', '--limit', '129'],
    ['bots', 'list', '--after-space', space],
    ['bots', 'stop', space, 'Display name']
  ])
    expect(() => prepareBotsCommand(parseArgs(args))).toThrow()
  const params = prepareBotsCommand(parseArgs(configure)).params
  for (const extra of [
    { qualification: true },
    { credential: 'secret' },
    { native: { definition: 'code' } },
    { projectPath: '/tmp' },
    { profileId: 'different' },
    { dailyBudgetUnits: Number.MAX_SAFE_INTEGER + 1 },
    { profileDigest: digest + '=' }
  ])
    expect(() => validateBotsLocal('bots.configure', { ...params, ...extra })).toThrow()
})
it('emits the actual receipt and forwards only the validated catalogue DTO', async () => {
  const calls: unknown[] = [],
    output: unknown[] = [],
    receipt = { id: request, stream, state: 'unknown', attempts: 1, createdAt: 1 }
  await executeBotsCommand(
    prepareBotsCommand(parseArgs(['bots', 'grant', stream, request, '--approve'])),
    {
      request: async <T>(method: string, params: unknown) => {
        calls.push({ method, params })
        return receipt as T
      }
    },
    (value) => output.push(value)
  )
  expect(calls).toEqual([{ method: 'bots.grant', params: { stream, request, approved: true } }])
  expect(output).toEqual([receipt])
})
it('accepts bounded distinct mentions without widening public post references', () => {
  expect(
    prepareSpacesCommand(parseArgs(['spaces', 'post', stream, 'hello', '--mentions', bot]))
  ).toEqual({ method: 'spaces.post', params: { stream, text: 'hello', mentions: [bot] } })
  for (const value of [
    bot + ',' + bot,
    'name',
    Array.from({ length: 17 }, () => newId('bot')).join(',')
  ])
    expect(() =>
      prepareSpacesCommand(parseArgs(['spaces', 'post', stream, 'hello', '--mentions', value]))
    ).toThrow()
})
