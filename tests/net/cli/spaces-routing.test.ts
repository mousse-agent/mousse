import { expect, it } from 'vitest'
import { parseArgs } from '../../../src/cli/parseArgs'
import { commandHelp, ROOT_HELP } from '../../../src/cli/help'
import { prepareSpacesCommand } from '../../../src/cli/commands/spaces'
import { newId } from '../../../src/shared/net'

it('recognizes spaces and preserves a stream following the boolean follow switch', () => {
  const stream = newId('stream'), args = parseArgs(['spaces', 'tail', '--follow', stream, '--limit', '2'])
  expect(args.command).toBe('spaces')
  expect(args.positional).toEqual([stream])
  expect(prepareSpacesCommand(args)).toMatchObject({ method: 'spaces.tail', params: { stream, limit: 2 }, follow: true })
  expect(commandHelp('spaces')).toContain('spaces tail')
  expect(ROOT_HELP).toContain('mousse-cli spaces')
})
