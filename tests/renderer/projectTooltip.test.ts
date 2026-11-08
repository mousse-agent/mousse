/**
 * A project row's tooltip is one line: the home folder reads `~`, a long path loses its middle folders to "…"
 * (the start and the last folder stay), and another computer's project keeps its own path and names the computer.
 */
import { describe, expect, it } from 'vitest'
import { PROJECT_TOOLTIP_MAX_CHARS, projectTooltip, shortenPathMiddle, tildePath } from '../../src/renderer/lib/projectTooltip'
import { readHomeFolderArgument, homeFolderArgument } from '../../src/shared/homeFolderArgument'

describe('tildePath', () => {
  it('writes the home folder as ~', () => {
    expect(tildePath('/Users/ada/code/payments-api', '/Users/ada')).toBe('~/code/payments-api')
    expect(tildePath('/Users/ada', '/Users/ada/')).toBe('~')
    expect(tildePath('C:\\Users\\ada\\code\\api', 'C:\\Users\\ada')).toBe('~\\code\\api')
  })

  it('leaves other folders, and folders that only start with the same letters, as they are', () => {
    expect(tildePath('/Users/adam/code', '/Users/ada')).toBe('/Users/adam/code')
    expect(tildePath('/srv/app', '/Users/ada')).toBe('/srv/app')
    expect(tildePath('/Users/ada/code', undefined)).toBe('/Users/ada/code')
  })
})

describe('shortenPathMiddle', () => {
  it('keeps a path that fits', () => {
    expect(shortenPathMiddle('~/code/payments-api', 40)).toBe('~/code/payments-api')
  })

  it('drops whole middle folders, keeping the start and the last folders', () => {
    expect(shortenPathMiddle('~/ux-audit/tour/fixtures/workspaces/payments-api', 30)).toBe('~/ux-audit/…/payments-api')
    expect(shortenPathMiddle('~/ux-audit/tour/fixtures/workspaces/payments-api', 40)).toBe('~/ux-audit/…/workspaces/payments-api')
    expect(shortenPathMiddle('/Volumes/xt1/code/RYSPA/mousse', 22)).toBe('/Volumes/…/mousse')
  })

  it('cuts characters in the middle when the first and last folders alone are too long', () => {
    const short = shortenPathMiddle('~/a-really-long-folder-name-that-goes-on', 20)
    expect(short).toHaveLength(20)
    expect(short.startsWith('~/a-')).toBe(true)
    expect(short.endsWith('goes-on')).toBe(true)
    expect(short).toContain('…')
  })
})

describe('projectTooltip', () => {
  it('reads "name · ~/path" for this computer', () => {
    expect(projectTooltip({ name: 'payments-api', path: '/Users/ada/code/payments-api', home: '/Users/ada' }))
      .toEqual({ text: 'payments-api · ~/code/payments-api', full: 'payments-api · ~/code/payments-api' })
  })

  it('names this computer when projects of several computers are listed', () => {
    expect(projectTooltip({ name: 'api', path: '/Users/ada/api', home: '/Users/ada', selfName: 'Mac mini' }).text)
      .toBe('api · ~/api · Mac mini')
  })

  it('keeps another computer\'s own path and ends in its name', () => {
    expect(projectTooltip({ name: 'api', path: '/Users/ada/api', home: '/Users/ada', computerName: 'Studio' }).text)
      .toBe('api · /Users/ada/api · Studio')
  })

  it('fits one line by shortening the middle of the path, and keeps the whole path for screen readers', () => {
    const path = '/Users/ada/ux-audit/tour/fixtures/workspaces/a-very-long-folder-name/another-long-folder/payments-api'
    const { text, full } = projectTooltip({ name: 'payments-api', path, home: '/Users/ada', computerName: undefined })
    expect(text.length).toBeLessThanOrEqual(PROJECT_TOOLTIP_MAX_CHARS)
    expect(text.startsWith('payments-api · ~/ux-audit/…/')).toBe(true)
    expect(text.endsWith('/payments-api')).toBe(true)
    expect(full).toBe(`payments-api · ~${path.slice('/Users/ada'.length)}`)

    const remote = projectTooltip({ name: 'payments-api', path, computerName: 'Studio' })
    expect(remote.text.length).toBeLessThanOrEqual(PROJECT_TOOLTIP_MAX_CHARS)
    expect(remote.text.endsWith('/payments-api · Studio')).toBe(true)
  })

  it('is just the name without a path', () => {
    expect(projectTooltip({ name: 'api' }).text).toBe('api')
  })
})

describe('home folder argument', () => {
  it('reaches the window as it was', () => {
    const home = '/Users/ada lovelace/ü'
    expect(readHomeFolderArgument(['electron', homeFolderArgument(home)])).toBe(home)
    expect(readHomeFolderArgument(['electron'])).toBeUndefined()
  })
})
